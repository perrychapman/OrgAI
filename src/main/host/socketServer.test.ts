import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostScope, HostState, RunEvent, RunSummary } from '../../shared/types'
import { RPC_CONTROL_REQUEST_MAX_BYTES, RPC_MAX_CLIENT_SOCKETS, RPC_MAX_UNAUTH_SOCKETS } from '../../shared/types'
import type { OrgAIHost } from './bootstrap'
import { HostEventBus } from './events'
import { LineReader, clientProof, encodeFrame, hostProof, newNonce, proofMatches, rpcRequest } from './protocol'
import { gateRequest } from './registry'
import { HostSocketServer, TERMINAL_ACCESS_OFF_MESSAGE, type HostSocketServerOptions } from './socketServer'

// Real unix sockets under /tmp (macOS's os.tmpdir() is too long for sun_path). POSIX only; the win32 pipe is UNVERIFIED.
const posix = process.platform !== 'win32'
const SECRET = 'ab'.repeat(32)
const HOST_ID = 'abcdef012345'

type Msg = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

class TestClient {
  readonly frames: Msg[] = []
  private waiters: Array<() => void> = []
  private reader = new LineReader()
  closed = false
  readonly closedP: Promise<void>

  constructor(readonly socket: Socket) {
    this.reader.maxLineBytes = 200 * 1024 * 1024
    socket.on('data', (c: Buffer) => {
      for (const l of this.reader.push(c).lines) this.frames.push(JSON.parse(l))
      this.wake()
    })
    this.closedP = new Promise((r) =>
      socket.on('close', () => {
        this.closed = true
        this.wake()
        r()
      })
    )
    socket.on('error', () => {})
  }

  static open(path: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const s = connect(path)
      s.once('connect', () => resolve(new TestClient(s)))
      s.once('error', reject)
    })
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  async next(pred: (m: Msg) => boolean = () => true, timeoutMs = 3000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const i = this.frames.findIndex(pred)
      if (i >= 0) return this.frames.splice(i, 1)[0]
      if (this.closed) throw new Error('closed before the frame arrived')
      if (Date.now() > deadline) throw new Error('timed out waiting for a frame')
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, 50)
      })
    }
  }

  response(id: number | string): Promise<Msg> {
    return this.next((m) => m.id === id && !('method' in m))
  }

  send(msg: unknown): void {
    this.socket.write(encodeFrame(msg))
  }

  async waitClosed(timeoutMs = 3000): Promise<void> {
    await Promise.race([this.closedP, new Promise((_, rej) => setTimeout(() => rej(new Error('not closed')), timeoutMs))])
  }

  destroy(): void {
    this.socket.destroy()
  }
}

interface HelloOpts {
  scopes?: HostScope[]
  version?: string
  kind?: 'cli' | 'tui'
  pid?: number
  secret?: string
  mutate?: (p: Msg) => void
}

async function hello(c: TestClient, o: HelloOpts = {}): Promise<{ res: Msg; challenge: Msg; params: Msg }> {
  const challenge = await c.next((m) => m.method === 'host.challenge')
  const params: Msg = {
    protocolVersion: 1,
    clientKind: o.kind ?? 'cli',
    clientVersion: o.version ?? '1.0.0',
    pid: o.pid ?? 4242,
    cwd: '/work',
    clientNonce: newNonce(),
    requestedScopes: o.scopes ?? ['read']
  }
  params.clientProof = clientProof(o.secret ?? SECRET, {
    protocolVersion: 1,
    hostInstanceId: challenge.params.hostInstanceId,
    hostNonce: challenge.params.hostNonce,
    clientNonce: params.clientNonce,
    clientKind: params.clientKind,
    clientVersion: params.clientVersion,
    pid: params.pid,
    cwd: params.cwd,
    requestedScopes: params.requestedScopes
  })
  o.mutate?.(params)
  c.send(rpcRequest(1, 'host.hello', params))
  return { res: await c.response(1), challenge, params }
}

// ---------- Fake host ----------

interface FakeHostState {
  state: HostState
  terminalServer: boolean
  sources: Array<() => number>
  calls: { method: string; ctx: Msg }[]
  /** Pending dispatcher calls resolve when released. */
  hold: boolean
  release: Array<() => void>
  result: (method: string, args: unknown[]) => unknown
}

function fakeHost(st: FakeHostState): { host: OrgAIHost; events: HostEventBus; runs: Msg } {
  const events = new HostEventBus()
  const runs = {
    live: [] as RunSummary[],
    liveRuns: () => runs.live,
    pendingCards: () => ({}),
    get: () => null,
    list: () => [],
    summaryOf: (id: string) => runs.live.find((s) => s.id === id),
    summary: (id: string) => runs.live.find((s) => s.id === id) ?? null
  }
  const host = {
    events,
    runs,
    services: { projects: { list: () => [] } },
    settings: { get: () => ({ terminalServer: st.terminalServer }) },
    activity: {
      state: () => st.state,
      addSource: (_k: string, f: () => number) => {
        st.sources.push(f)
        return () => {
          st.sources = st.sources.filter((x) => x !== f)
        }
      }
    },
    dispatcher: {
      invokeRpc: async (method: string, params: unknown, ctx: Msg) => {
        const g = gateRequest(method, params, { grantedScopes: ctx.grantedScopes, hostKind: 'headless-host' })
        st.calls.push({ method, ctx })
        if (st.hold) await new Promise<void>((r) => st.release.push(r))
        return st.result(method, g.args)
      }
    }
  }
  return { host: host as unknown as OrgAIHost, events, runs }
}

// ---------- Fixture ----------

let base: string
let dataDir: string
let sockPath: string
let netServer: Server
let server: HostSocketServer
let st: FakeHostState
let clients: TestClient[]
let logs: string[]

function newState(): FakeHostState {
  return { state: 'ready', terminalServer: true, sources: [], calls: [], hold: false, release: [], result: () => ({ ok: true }) }
}

async function start(over: Partial<HostSocketServerOptions> = {}, attach = true): Promise<ReturnType<typeof fakeHost>> {
  server = new HostSocketServer({
    dataDir,
    hostKind: 'headless-host',
    hostInstanceId: HOST_ID,
    appVersion: '1.0.0',
    mock: true,
    peerCheck: async () => 'ok',
    log: (m) => logs.push(m),
    ...over
  })
  netServer = createServer((s) => server.accept(s))
  await new Promise<void>((r) => netServer.listen(sockPath, r))
  const fake = fakeHost(st)
  if (attach) server.attach(fake.host)
  return fake
}

async function client(): Promise<TestClient> {
  const c = await TestClient.open(sockPath)
  clients.push(c)
  return c
}

beforeEach(() => {
  if (!posix) return
  base = realpathSync(mkdtempSync('/tmp/orgai-ss-'))
  dataDir = join(base, 'data')
  mkdirSync(join(dataDir, 'run'), { recursive: true, mode: 0o700 })
  writeFileSync(join(dataDir, 'run', 'daemon.secret'), SECRET, { mode: 0o600 })
  sockPath = join(base, 's.sock')
  st = newState()
  clients = []
  logs = []
})

afterEach(async () => {
  if (!posix) return
  for (const c of clients) c.destroy()
  server?.close()
  await new Promise<void>((r) => (netServer ? netServer.close(() => r()) : r()))
  rmSync(base, { recursive: true, force: true })
  vi.useRealTimers()
})

describe.runIf(posix)('HostSocketServer handshake', () => {
  it('sends host.challenge at once and completes a hello with a verifiable hostProof', async () => {
    await start()
    const c = await client()
    const { res, challenge, params } = await hello(c, { scopes: ['read', 'operate', 'read'] })
    expect(challenge.params).toMatchObject({ protocolVersion: 1, hostInstanceId: HOST_ID })
    expect(challenge.params.hostNonce).toMatch(/^[0-9a-f]{64}$/)
    expect(res.result).toMatchObject({ protocolVersion: 1, hostInstanceId: HOST_ID, hostKind: 'headless-host', appVersion: '1.0.0', dataDir, mock: true, grantedScopes: ['read', 'operate'] })
    expect(res.result.versionSkewWarning).toBeUndefined()
    const expected = hostProof(SECRET, {
      protocolVersion: 1,
      hostInstanceId: HOST_ID,
      clientNonce: params.clientNonce,
      hostNonce: challenge.params.hostNonce,
      hostKind: 'headless-host',
      appVersion: '1.0.0',
      dataDir,
      mock: true,
      grantedScopes: res.result.grantedScopes
    })
    expect(proofMatches(expected, res.result.hostProof)).toBe(true)
    // Nothing secret reaches the log.
    expect(logs.join('\n')).not.toContain(SECRET)
    expect(logs.join('\n')).not.toContain(challenge.params.hostNonce)
  })

  it('warns about version skew', async () => {
    await start()
    const { res } = await hello(await client(), { version: '0.9.0' })
    expect(res.result.versionSkewWarning).toContain('0.9.0')
  })

  it('a wrong proof is auth_failed and closes', async () => {
    await start()
    const c = await client()
    const { res } = await hello(c, { secret: 'cd'.repeat(32) })
    expect(res.error.data.code).toBe('auth_failed')
    await c.waitClosed()
  })

  it('a missing secret is auth_failed', async () => {
    rmSync(join(dataDir, 'run', 'daemon.secret'))
    await start()
    const c = await client()
    expect((await hello(c)).res.error.data.code).toBe('auth_failed')
  })

  it('protocol_mismatch and bad params come before the proof', async () => {
    await start()
    const a = await client()
    expect((await hello(a, { mutate: (p) => (p.protocolVersion = 2) })).res.error.data.code).toBe('protocol_mismatch')
    await a.waitClosed()
    for (const mutate of [(p: Msg) => (p.clientKind = 'gui'), (p: Msg) => (p.pid = 0), (p: Msg) => (p.cwd = 'a\u0000b'), (p: Msg) => (p.requestedScopes = []), (p: Msg) => (p.requestedScopes = ['root'])]) {
      const c = await client()
      expect((await hello(c, { mutate })).res.error.data.code).toBe('bad_request')
    }
  })

  it('anything but host.hello id 1 before auth is bad_request and closes', async () => {
    await start()
    const c = await client()
    await c.next((m) => m.method === 'host.challenge')
    c.send(rpcRequest(2, 'runs:list', ['p']))
    const res = await c.response(2)
    expect(res.error.data.code).toBe('bad_request')
    await c.waitClosed()
  })

  it('host_starting before attach', async () => {
    await start({}, false)
    const { res } = await hello(await client())
    expect(res.error.data).toMatchObject({ code: 'host_starting', retryAfterMs: 250 })
  })

  it('terminal_server_disabled with the settings path', async () => {
    st.terminalServer = false
    await start()
    const { res } = await hello(await client())
    expect(res.error.data).toMatchObject({ code: 'terminal_server_disabled', message: TERMINAL_ACCESS_OFF_MESSAGE })
  })

  it('turning Terminal access off closes authenticated clients; turning it on again does not (review L)', async () => {
    const { events } = await start()
    const c = await client()
    await hello(c, { scopes: ['read', 'configure'] })
    events.emit('settings:changed', { terminalServer: true } as never)
    c.send(rpcRequest(2, 'runs:list', ['p1']))
    expect((await c.response(2)).result).toBeDefined()
    st.terminalServer = false
    events.emit('settings:changed', { terminalServer: false } as never)
    await c.waitClosed()
    expect(logs.join('\n')).toContain('Terminal access was turned off; closed 1 terminal connection.')
    const { res } = await hello(await client())
    expect(res.error.data.code).toBe('terminal_server_disabled')
  })

  it('journals run events only while Terminal access is on or a client is connected (review L)', async () => {
    st.terminalServer = false
    const { events } = await start()
    const journal = (server as unknown as { journal: { size: number } }).journal
    events.emit('runs:event', { type: 'log', runId: 'r1', level: 'info', message: 'off' })
    expect(journal.size).toBe(0)
    st.terminalServer = true
    events.emit('settings:changed', { terminalServer: true } as never)
    events.emit('runs:event', { type: 'log', runId: 'r1', level: 'info', message: 'on' })
    expect(journal.size).toBe(1)
  })

  it('host_draining while the host drains', async () => {
    st.state = 'draining'
    await start()
    const { res } = await hello(await client())
    expect(res.error.data.code).toBe('host_draining')
  })

  it('agent_descendant_refused from the peer check; unavailable is allowed and logged', async () => {
    const seen: number[] = []
    await start({ peerCheck: async (pid) => (seen.push(pid), pid === 777 ? 'descendant' : 'unavailable') })
    const a = await client()
    expect((await hello(a, { pid: 777 })).res.error.data.code).toBe('agent_descendant_refused')
    await a.waitClosed()
    const b = await client()
    expect((await hello(b, { pid: 778 })).res.result).toBeDefined()
    expect(seen).toEqual([777, 778])
    expect(logs.some((l) => l.includes('unavailable'))).toBe(true)
  })

  it('caps a pre-auth line at 16 KB with frame_too_large', async () => {
    await start()
    const c = await client()
    await c.next((m) => m.method === 'host.challenge')
    c.socket.write('x'.repeat(17 * 1024))
    const res = await c.next((m) => m.error)
    expect(res.error.data.code).toBe('frame_too_large')
    await c.waitClosed()
  })

  it('destroys a socket that does not finish the handshake in time', async () => {
    await start()
    const c = await client()
    await c.next((m) => m.method === 'host.challenge')
    // RPC_HANDSHAKE_TIMEOUT_MS is 2000.
    await c.waitClosed(4000)
  })

  it('at most 16 unauthenticated sockets', async () => {
    await start()
    const waiting: TestClient[] = []
    for (let i = 0; i < RPC_MAX_UNAUTH_SOCKETS; i++) {
      const c = await client()
      await c.next((m) => m.method === 'host.challenge')
      waiting.push(c)
    }
    const extra = await client()
    await extra.waitClosed()
    expect(extra.frames).toEqual([])
    // Closing one frees a slot.
    waiting[0].destroy()
    await new Promise((r) => setTimeout(r, 50))
    const ok = await client()
    expect((await hello(ok)).res.result).toBeDefined()
  })

  it('at most 32 authenticated sockets', async () => {
    await start()
    for (let i = 0; i < RPC_MAX_CLIENT_SOCKETS; i++) expect((await hello(await client())).res.result).toBeDefined()
    const { res } = await hello(await client())
    expect(res.error.data.code).toBe('too_many_connections')
  })
})

describe.runIf(posix)('HostSocketServer requests', () => {
  it('forwards to invokeRpc with the socket context and answers the result', async () => {
    st.result = (method, args) => ({ method, args })
    await start()
    const c = await client()
    await hello(c, { kind: 'tui', pid: 999, scopes: ['read'] })
    c.send(rpcRequest(7, 'runs:list', ['p1']))
    const res = await c.response(7)
    expect(res.result).toEqual({ method: 'runs:list', args: ['p1'] })
    expect(st.calls[0].ctx).toMatchObject({ surface: 'socket', clientKind: 'tui', pid: 999, grantedScopes: ['read'] })
  })

  it("under version skew 'configure' covers host.stop only; read and operate still work (review L)", async () => {
    st.result = (method) => ({ method })
    await start()
    const c = await client()
    const { res } = await hello(c, { version: '0.9.0', scopes: ['read', 'operate', 'configure'] })
    expect(res.result.grantedScopes).toEqual(['read', 'operate', 'configure'])
    c.send(rpcRequest(2, 'settings:set', [{}]))
    const refused = await c.response(2)
    expect(refused.error.data.code).toBe('scope_denied')
    expect(refused.error.data.message).toContain('same orgai and OrgAI version')
    c.send(rpcRequest(3, 'host.stop', [{ force: false }]))
    expect((await c.response(3)).result).toEqual({ method: 'host.stop' })
    c.send(rpcRequest(4, 'runs:list', ['p1']))
    expect((await c.response(4)).result).toEqual({ method: 'runs:list' })
    expect(st.calls.map((x) => x.method)).toEqual(['host.stop', 'runs:list'])
    // The same version gets every configure channel.
    const d = await client()
    await hello(d, { scopes: ['read', 'configure'] })
    d.send(rpcRequest(5, 'settings:set', [{}]))
    expect((await d.response(5)).result).toEqual({ method: 'settings:set' })
  })

  it('scope_denied through the gate (dispatcher and transport methods)', async () => {
    await start()
    const c = await client()
    await hello(c, { scopes: ['read'] })
    c.send(rpcRequest(2, 'runs:stop', ['r1']))
    expect((await c.response(2)).error.data.code).toBe('scope_denied')
    const d = await client()
    await hello(d, { scopes: ['operate'] })
    d.send(rpcRequest(3, 'runs:subscribe', [{}]))
    expect((await d.response(3)).error.data.code).toBe('scope_denied')
    d.send(rpcRequest(4, 'host.subscribe', { topics: ['settings'] }))
    expect((await d.response(4)).error.data.code).toBe('scope_denied')
  })

  it('maps a plain Error to bad_request without a stack', async () => {
    st.result = () => {
      throw new Error('boom')
    }
    await start()
    const c = await client()
    await hello(c)
    c.send(rpcRequest(2, 'runs:list', ['p1']))
    const res = await c.response(2)
    expect(res.error.data).toEqual({ code: 'bad_request', message: 'boom' })
    expect(JSON.stringify(res)).not.toContain('at ')
  })

  it('the 5th in-flight request gets too_many_requests', async () => {
    st.hold = true
    await start()
    const c = await client()
    await hello(c)
    for (let i = 1; i <= 5; i++) c.send(rpcRequest(10 + i, 'runs:list', ['p1']))
    expect((await c.response(15)).error.data.code).toBe('too_many_requests')
    await vi.waitFor(() => expect(st.release.length).toBe(4))
    for (const r of st.release.splice(0)) r()
    for (let i = 1; i <= 4; i++) expect((await c.response(10 + i)).result).toEqual({ ok: true })
  })

  it('a control request over 2 MB is frame_too_large and the socket stays open', async () => {
    await start()
    const c = await client()
    await hello(c)
    c.send(rpcRequest(2, 'runs:list', ['x'.repeat(RPC_CONTROL_REQUEST_MAX_BYTES + 10)]))
    expect((await c.response(2)).error.data.code).toBe('frame_too_large')
    c.send(rpcRequest(3, 'runs:list', ['p1']))
    expect((await c.response(3)).result).toEqual({ ok: true })
  })

  it('answers -32700 to unparsable JSON and ignores notifications', async () => {
    await start()
    const c = await client()
    await hello(c)
    c.socket.write('{nope\n')
    const res = await c.next((m) => m.error)
    expect(res.id).toBeNull()
    expect(res.error.code).toBe(-32700)
    expect(res.error.data.code).toBe('bad_request')
    c.send({ jsonrpc: '2.0', method: 'whatever' })
    c.send(rpcRequest(3, 'runs:list', ['p1']))
    expect((await c.response(3)).result).toEqual({ ok: true })
    expect(c.frames).toEqual([])
  })

  it('refuses a result too large for the bulk budget with frame_too_large', async () => {
    st.result = () => 'y'.repeat(3 * 1024 * 1024)
    await start()
    ;(server as unknown as { budget: { reserve: () => null } }).budget = { reserve: () => null }
    const c = await client()
    await hello(c)
    c.send(rpcRequest(2, 'runs:get', ['r1']))
    const res = await c.response(2)
    expect(res.error.data).toMatchObject({ code: 'frame_too_large', message: 'OrgAI is handling too much data at once; try again' })
  })

  it('an incoming bulk line the budget cannot hold is refused and the socket destroyed', async () => {
    await start()
    ;(server as unknown as { budget: { reserve: () => null } }).budget = { reserve: () => null }
    const c = await client()
    await hello(c)
    c.socket.write('x'.repeat(RPC_CONTROL_REQUEST_MAX_BYTES + 1024))
    const res = await c.next((m) => m.error)
    expect(res.error.data.code).toBe('frame_too_large')
    await c.waitClosed()
  })
})

describe.runIf(posix)('HostSocketServer subscriptions', () => {
  it('host.subscribe forwards the topic channels only', async () => {
    const { events } = await start()
    const c = await client()
    await hello(c)
    c.send(rpcRequest(2, 'host.subscribe', { topics: ['settings', 'settings', 'nope'] }))
    expect((await c.response(2)).result).toEqual({ topics: ['settings'] })
    events.emit('connections:event', { type: 'x' } as never)
    events.emit('settings:changed', { theme: 'dark' } as never)
    const n = await c.next((m) => m.method)
    expect(n).toEqual({ jsonrpc: '2.0', method: 'settings:changed', params: { theme: 'dark' } })
    expect(c.frames).toEqual([])
  })

  it('runs:subscribe answers a snapshot first, then pushes with seq / atSeq', async () => {
    const { events, runs } = await start()
    runs.live = [{ id: 'r1', projectId: 'p1', status: 'running', startedAt: 1 } as RunSummary]
    events.emit('runs:event', { type: 'log', runId: 'r1', level: 'info', message: 'before' })
    const c = await client()
    await hello(c)
    c.send(rpcRequest(2, 'runs:subscribe', [{ runIds: ['r1'] }]))
    const res = await c.response(2)
    expect(res.result).toMatchObject({ mode: 'snapshot', hostInstanceId: HOST_ID, seq: 1 })
    expect(res.result.snapshot.liveRuns.map((s: RunSummary) => s.id)).toEqual(['r1'])
    const ev = (message: string, runId = 'r1'): RunEvent => ({ type: 'log', runId, level: 'info', message })
    events.emit('runs:event', ev('other', 'r9'))
    events.emit('runs:event', ev('mine'))
    events.emit('runs:event', { type: 'agent.partial', runId: 'r1', agentId: 'root', text: 'he' })
    const a = await c.next((m) => m.method === 'runs:event')
    expect(a.params).toEqual({ seq: 3, event: ev('mine') })
    const b = await c.next((m) => m.method === 'runs:event')
    expect(b.params).toEqual({ atSeq: 3, event: { type: 'agent.partial', runId: 'r1', agentId: 'root', text: 'he' } })
  })

  it('attachedClientCount counts tui clients and active-run subscriptions', async () => {
    await start()
    expect(st.sources).toHaveLength(1)
    const tui = await client()
    await hello(tui, { kind: 'tui' })
    expect(st.sources[0]()).toBe(1)
    const cli = await client()
    await hello(cli)
    cli.send(rpcRequest(2, 'runs:subscribe', [{}]))
    await cli.response(2)
    expect(server.attachedClientCount()).toBe(1)
    cli.send(rpcRequest(3, 'runs:subscribe', [{ includeActiveRunRecord: 'r1' }]))
    await cli.response(3)
    expect(server.attachedClientCount()).toBe(2)
    tui.destroy()
    await vi.waitFor(() => expect(server.attachedClientCount()).toBe(1))
    server.close()
    expect(st.sources).toHaveLength(0)
    await cli.waitClosed()
  })
})
