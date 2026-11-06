import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostScope, HostState, RunEvent, RunSummary } from '../../shared/types'
import { RPC_CONTROL_REQUEST_MAX_BYTES, RPC_MAX_CLIENT_SOCKETS, RPC_MAX_UNAUTH_SOCKETS } from '../../shared/types'
import type { OrgAIHost } from './bootstrap'
import { HostEventBus } from './events'
import { LineReader, clientProof, encodeFrame, hostProof, newNonce, ownerProof, proofMatches, rpcRequest } from './protocol'
import { gateRequest } from './registry'
import {
  DESKTOP_HANDOFF_REFUSED_MESSAGE,
  DESKTOP_HANDOFF_UNAVAILABLE_MESSAGE,
  HostSocketServer,
  SECRET_ACL_MESSAGE,
  TERMINAL_ACCESS_LEVEL_MESSAGE,
  NODE_TERMINAL_ACCESS_LEVEL_MESSAGE,
  NODE_TERMINAL_ACCESS_OFF_MESSAGE,
  NODE_TERMINAL_ACCESS_OFF_REFUSED,
  turnsNodeTerminalAccessOff,
  TERMINAL_ACCESS_OFF_MESSAGE,
  authorizeKey,
  grantScopes,
  scopesForAccessLevel,
  type HostSocketServerOptions
} from './socketServer'

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
  kind?: 'cli' | 'tui' | 'desktop'
  pid?: number
  secret?: string
  /** After the proof is computed (the proof no longer covers the change). */
  mutate?: (p: Msg) => void
  /** Before the proof is computed (a well-proven but malformed hello). */
  shape?: (p: Msg) => void
  /** Add an ownerProof made with this key (an in-process host's own CLI). */
  ownerKey?: string
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
  o.shape?.(params)
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
  if (o.ownerKey) {
    params.ownerProof = ownerProof(o.ownerKey, {
      hostInstanceId: challenge.params.hostInstanceId,
      hostNonce: challenge.params.hostNonce,
      clientNonce: params.clientNonce,
      clientProof: params.clientProof
    })
  }
  o.mutate?.(params)
  c.send(rpcRequest(1, 'host.hello', params))
  return { res: await c.response(1), challenge, params }
}

// ---------- Fake host ----------

interface FakeHostState {
  state: HostState
  terminalServer: boolean
  accessLevel?: 'operate' | 'full'
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
    settings: { get: () => ({ terminalServer: st.terminalServer, ...(st.accessLevel ? { terminalAccessLevel: st.accessLevel } : {}) }) },
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
  return { state: 'ready', terminalServer: true, accessLevel: 'full', sources: [], calls: [], hold: false, release: [], result: () => ({ ok: true }) }
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

  it('protocol_mismatch comes first; field details only after the proof verified (review Low)', async () => {
    await start()
    const a = await client()
    expect((await hello(a, { mutate: (p) => (p.protocolVersion = 2) })).res.error.data.code).toBe('protocol_mismatch')
    await a.waitClosed()
    const shapes = [(p: Msg) => (p.clientKind = 'gui'), (p: Msg) => (p.pid = 0), (p: Msg) => (p.cwd = 'a\u0000b'), (p: Msg) => (p.requestedScopes = []), (p: Msg) => (p.requestedScopes = ['root'])]
    for (const shape of shapes) {
      // Proven by the secret: the detail is given.
      const c = await client()
      expect((await hello(c, { shape })).res.error.data.code).toBe('bad_request')
      // Not proven: one generic answer, nothing about the expected format.
      const d = await client()
      const res = (await hello(d, { mutate: shape })).res
      expect(res.error.data).toEqual({ code: 'auth_failed', message: 'The handshake proof did not verify.' })
    }
    for (const mutate of [(p: Msg) => (p.clientNonce = 'xyz'), (p: Msg) => (p.requestedScopes = 'read'), (p: Msg) => delete p.clientProof]) {
      const c = await client()
      expect((await hello(c, { mutate })).res.error.data).toEqual({ code: 'auth_failed', message: 'The handshake proof did not verify.' })
    }
  })

  it("an unproven 'desktop' hello is the generic auth_failed answer, as for every other field", async () => {
    await start()
    const d = await client()
    expect((await hello(d, { mutate: (p) => (p.clientKind = 'desktop') })).res.error.data.code).toBe('auth_failed')
  })

  it("grants at most read and operate unless Terminal access is 'full' (review H2)", async () => {
    st.accessLevel = undefined
    st.result = (method) => ({ method })
    await start()
    const c = await client()
    const { res, challenge, params } = await hello(c, { scopes: ['read', 'operate', 'decide', 'configure'] })
    expect(res.result.grantedScopes).toEqual(['read', 'operate'])
    // The host proof binds what was really granted.
    const expected = hostProof(SECRET, {
      protocolVersion: 1,
      hostInstanceId: HOST_ID,
      clientNonce: params.clientNonce,
      hostNonce: challenge.params.hostNonce,
      hostKind: 'headless-host',
      appVersion: '1.0.0',
      dataDir,
      mock: true,
      grantedScopes: ['read', 'operate']
    })
    expect(proofMatches(expected, res.result.hostProof)).toBe(true)
    c.send(rpcRequest(2, 'runs:decide', [{}]))
    const denied = await c.response(2)
    expect(denied.error.data.code).toBe('scope_denied')
    expect(denied.error.data.message).toContain(TERMINAL_ACCESS_LEVEL_MESSAGE)
    c.send(rpcRequest(3, 'settings:set', [{}]))
    expect((await c.response(3)).error.data.message).toContain("'configure'")
    c.send(rpcRequest(4, 'runs:stop', ['r1']))
    expect((await c.response(4)).result).toEqual({ method: 'runs:stop' })
    // host.stop still works for a client that asked for configure (daemon stop): a same-user kill could do as much.
    c.send(rpcRequest(5, 'host.stop', [{ force: false }]))
    expect((await c.response(5)).result).toEqual({ method: 'host.stop' })
    expect(st.calls.map((x) => x.method)).toEqual(['runs:stop', 'host.stop'])
    expect(st.calls[1].ctx.grantedScopes).toEqual(['read', 'operate', 'configure'])
    expect(logs.join('\n')).toContain('withheld by Terminal access: decide, configure')
    // A client that never asked for configure does not get host.stop.
    const d = await client()
    await hello(d, { scopes: ['read'] })
    d.send(rpcRequest(6, 'host.stop', [{ force: false }]))
    expect((await d.response(6)).error.data.code).toBe('scope_denied')
  })

  it('an in-process host grants every scope only to the hello proven with its in-memory owner key (review H2)', async () => {
    st.accessLevel = undefined
    st.result = (method) => ({ method })
    const KEY = 'cd'.repeat(32)
    await start({ hostKind: 'inproc', ownerKey: KEY })
    // A client that holds daemon.secret but not the owner key (an agent that read the run folder) is capped.
    const other = await client()
    expect((await hello(other, { scopes: ['read', 'operate', 'decide', 'configure'] })).res.result.grantedScopes).toEqual(['read', 'operate'])
    other.send(rpcRequest(2, 'runs:decide', [{}]))
    expect((await other.response(2)).error.data.code).toBe('scope_denied')
    other.send(rpcRequest(3, 'permissions:add', [{}]))
    expect((await other.response(3)).error.data.code).toBe('scope_denied')
    // A wrong key, a garbled proof, or a proof replayed from another hello: capped too.
    for (const o of [
      { ownerKey: 'ef'.repeat(32) },
      { ownerKey: KEY, mutate: (p: Msg) => (p.ownerProof = 'zz') },
      { ownerKey: KEY, mutate: (p: Msg) => (p.ownerProof = ownerProof(KEY, { hostInstanceId: HOST_ID, hostNonce: newNonce(), clientNonce: p.clientNonce, clientProof: p.clientProof })) }
    ]) {
      expect((await hello(await client(), { scopes: ['read', 'decide'], ...o })).res.result.grantedScopes).toEqual(['read'])
    }
    // The owner (the CLI process that started the host) gets everything it asks for.
    const owner = await client()
    expect((await hello(owner, { scopes: ['read', 'operate', 'decide', 'configure'], ownerKey: KEY })).res.result.grantedScopes).toEqual([
      'read',
      'operate',
      'decide',
      'configure'
    ])
    owner.send(rpcRequest(4, 'runs:decide', [{}]))
    expect((await owner.response(4)).result).toEqual({ method: 'runs:decide' })
    expect(logs.join('\n')).toContain('in-process owner')
  })

  it("an in-process host accepts its owner whatever Terminal access says; other clients are refused (cli-standalone.md 13.12)", async () => {
    st.terminalServer = false
    const KEY = 'cd'.repeat(32)
    const { events } = await start({ hostKind: 'inproc', ownerKey: KEY })
    const other = await client()
    expect((await hello(other, { scopes: ['read'] })).res.error.data).toMatchObject({ code: 'terminal_server_disabled' })
    const owner = await client()
    expect((await hello(owner, { scopes: ['read', 'decide', 'configure'], ownerKey: KEY })).res.result.grantedScopes).toEqual(['read', 'decide', 'configure'])
    // Turning access off (again) never closes the owner.
    events.emit('settings:changed', { terminalServer: false } as never)
    await new Promise((r) => setTimeout(r, 50))
    expect(owner.closed).toBe(false)
  })

  it('a server without an owner key ignores an ownerProof', async () => {
    st.accessLevel = undefined
    await start({ hostKind: 'inproc' })
    const { res } = await hello(await client(), { scopes: ['read', 'decide', 'configure'], ownerKey: 'cd'.repeat(32) })
    expect(res.result.grantedScopes).toEqual(['read'])
  })

  it("an in-process host follows a 'full' level for other clients, and narrowing never closes the owner", async () => {
    const KEY = 'cd'.repeat(32)
    const { events } = await start({ hostKind: 'inproc', ownerKey: KEY })
    const owner = await client()
    expect((await hello(owner, { scopes: ['read', 'decide'], ownerKey: KEY })).res.result.grantedScopes).toEqual(['read', 'decide'])
    const other = await client()
    expect((await hello(other, { scopes: ['read', 'decide'] })).res.result.grantedScopes).toEqual(['read', 'decide'])
    st.accessLevel = undefined
    events.emit('settings:changed', { terminalServer: true } as never)
    await other.waitClosed()
    expect(owner.closed).toBe(false)
  })

  it('reads OrgAIHost.terminalAccess when the host has it (session-only Terminal access)', async () => {
    st.terminalServer = false
    st.accessLevel = undefined
    const fake = await start({}, false)
    let access = { enabled: true, level: 'operate' as 'operate' | 'full' }
    ;(fake.host as unknown as { terminalAccess: () => typeof access }).terminalAccess = () => access
    server.attach(fake.host)
    const { res } = await hello(await client(), { scopes: ['read', 'decide'] })
    expect(res.result.grantedScopes).toEqual(['read'])
    access = { enabled: false, level: 'full' }
    expect((await hello(await client())).res.error.data.code).toBe('terminal_server_disabled')
  })

  it('lowering the level closes sockets holding scopes it no longer allows', async () => {
    const { events } = await start()
    const full = await client()
    expect((await hello(full, { scopes: ['read', 'decide'] })).res.result.grantedScopes).toEqual(['read', 'decide'])
    const plain = await client()
    await hello(plain, { scopes: ['read', 'operate'] })
    st.accessLevel = undefined
    events.emit('settings:changed', { terminalServer: true } as never)
    await full.waitClosed()
    expect(logs.join('\n')).toContain('Terminal access was narrowed; closed 1 terminal connection.')
    plain.send(rpcRequest(2, 'runs:list', ['p1']))
    expect((await plain.response(2)).result).toBeDefined()
  })

  it('refuses every hello while the owner reports an unprotected daemon.secret, and runs no ACL step of its own (review follow-up)', async () => {
    let problem: string | undefined = 'icacls failed: access denied'
    await start({ secretAclProblem: () => problem })
    const { res } = await hello(await client())
    expect(res.error.data).toEqual({ code: 'auth_failed', message: SECRET_ACL_MESSAGE })
    expect((await hello(await client())).res.error.data.code).toBe('auth_failed')
    expect(logs.filter((l) => l.includes('icacls failed')).length).toBe(1)
    // Read at every hello, never cached: once the owner reports nothing, hellos succeed (no restart needed).
    problem = undefined
    expect((await hello(await client())).res.result).toBeDefined()
    server.close()
    await new Promise<void>((r) => netServer.close(() => r()))
    // A throwing getter refuses too.
    await start({
      secretAclProblem: () => {
        throw new Error('boom')
      }
    })
    expect((await hello(await client())).res.error.data).toEqual({ code: 'auth_failed', message: SECRET_ACL_MESSAGE })
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

  it('a background host names the orgai commands in its level and off refusals, never App settings (review round 1)', async () => {
    st.accessLevel = undefined
    await start({ hostKind: 'node' })
    const c = await client()
    const { res } = await hello(c, { scopes: ['read', 'operate', 'decide'] })
    expect(res.result.grantedScopes).toEqual(['read', 'operate'])
    c.send(rpcRequest(2, 'runs:decide', [{}]))
    const denied = await c.response(2)
    expect(denied.error.data.code).toBe('scope_denied')
    expect(denied.error.data.message).toContain(NODE_TERMINAL_ACCESS_LEVEL_MESSAGE)
    expect(denied.error.data.message).toContain('orgai terminal-access --level full')
    expect(denied.error.data.message).not.toContain('App settings')
    st.terminalServer = false
    const { res: off } = await hello(await client())
    expect(off.error.data).toMatchObject({ code: 'terminal_server_disabled', message: NODE_TERMINAL_ACCESS_OFF_MESSAGE })
  })

  it('a background host refuses a settings:set that turns Terminal access off, so it never runs unreachable (review round 2)', async () => {
    st.accessLevel = 'full'
    st.terminalServer = true
    st.result = (method) => ({ method })
    await start({ hostKind: 'node' })
    const c = await client()
    await hello(c, { scopes: ['read', 'configure'] })
    c.send(rpcRequest(2, 'settings:set', [{ terminalServer: false, notifications: false }]))
    const refused = await c.response(2)
    expect(refused.error.data).toEqual({ code: 'bad_request', message: NODE_TERMINAL_ACCESS_OFF_REFUSED })
    expect(st.calls.map((x) => x.method)).toEqual([])
    // Other saves (an echo of the stored on included) still go through.
    c.send(rpcRequest(3, 'settings:set', [{ terminalServer: true, notifications: false }]))
    expect((await c.response(3)).result).toEqual({ method: 'settings:set' })
    c.send(rpcRequest(4, 'settings:set', [{ notifications: false }]))
    expect((await c.response(4)).result).toEqual({ method: 'settings:set' })
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

  it('an announced mcp.authorize URL reaches only the socket whose mcp:authorize asked for it (review Low)', async () => {
    st.hold = true
    const { events } = await start()
    const starter = await client()
    await hello(starter, { scopes: ['read', 'configure'] })
    const watcher = await client()
    await hello(watcher, { scopes: ['read'] })
    for (const c of [starter, watcher]) {
      c.send(rpcRequest(2, 'host.subscribe', { topics: ['connections'] }))
      await c.response(2)
    }
    starter.send(rpcRequest(3, 'mcp:authorize', [{ libraryId: 'lib1', announceUrl: true }]))
    await vi.waitFor(() => expect(st.release.length).toBe(1))
    const url = (libraryId: string): Msg => ({ type: 'mcp.authorize', authorize: { target: { libraryId }, url: `https://auth.example/${libraryId}`, openedBrowser: false, at: 1 } })
    events.emit('connections:event', url('other') as never)
    events.emit('connections:event', url('lib1') as never)
    events.emit('connections:event', { type: 'mcp.authorize', authorize: { target: 7 } } as never)
    events.emit('connections:event', { type: 'connection.status', connection: 'openai', status: { state: 'connected' } } as never)
    const got = await starter.next((m) => m.method === 'connections:event')
    expect(got.params.authorize.url).toBe('https://auth.example/lib1')
    const next = await starter.next((m) => m.method === 'connections:event')
    expect(next.params.type).toBe('connection.status')
    const w = await watcher.next((m) => m.method === 'connections:event')
    expect(w.params.type).toBe('connection.status')
    expect(watcher.frames).toEqual([])
    // Once the call answered, the same target's URL goes to nobody.
    for (const r of st.release.splice(0)) r()
    await starter.response(3)
    events.emit('connections:event', url('lib1') as never)
    events.emit('connections:event', { type: 'projects.remapped', results: [] } as never)
    expect((await starter.next((m) => m.method === 'connections:event')).params.type).toBe('projects.remapped')
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

describe('scope helpers', () => {
  it('grantScopes caps by level, keeps order and dedupes', () => {
    expect(scopesForAccessLevel('operate')).toEqual(['read', 'operate'])
    expect(scopesForAccessLevel('full')).toEqual(['read', 'operate', 'decide', 'configure'])
    expect(grantScopes(['configure', 'read', 'read', 'decide'], 'operate')).toEqual({ granted: ['read'], withheld: ['configure', 'decide'] })
    expect(grantScopes(['configure', 'read'], 'full')).toEqual({ granted: ['configure', 'read'], withheld: [] })
  })

  it('authorizeKey names a library entry or a project server, nothing else', () => {
    expect(authorizeKey({ libraryId: 'a', announceUrl: true })).toBe(authorizeKey({ libraryId: 'a' }))
    expect(authorizeKey({ projectId: 'p', serverId: 's' })).not.toBe(authorizeKey({ libraryId: 'p' }))
    expect(authorizeKey({ projectId: 'p' })).toBeUndefined()
    expect(authorizeKey('x')).toBeUndefined()
  })
})

describe('turnsNodeTerminalAccessOff (review round 2; platform-neutral)', () => {
  const on = () => ({ terminalServer: true })
  const off = () => ({ terminalServer: false })
  it('is true only for a background host, settings:set, terminalServer false and Terminal access stored on', () => {
    expect(turnsNodeTerminalAccessOff('node', 'settings:set', [{ terminalServer: false }], on)).toBe(true)
    expect(turnsNodeTerminalAccessOff('headless-host', 'settings:set', [{ terminalServer: false }], on)).toBe(false)
    expect(turnsNodeTerminalAccessOff('desktop', 'settings:set', [{ terminalServer: false }], on)).toBe(false)
    expect(turnsNodeTerminalAccessOff('node', 'runs:list', [{ terminalServer: false }], on)).toBe(false)
    expect(turnsNodeTerminalAccessOff('node', 'settings:set', [{ terminalServer: true }], on)).toBe(false)
    expect(turnsNodeTerminalAccessOff('node', 'settings:set', [{}], on)).toBe(false)
    expect(turnsNodeTerminalAccessOff('node', 'settings:set', 'junk', on)).toBe(false)
    // Stored off but open for this session (no choice): an echo of false changes nothing (settingsSetArgs marks no choice).
    expect(turnsNodeTerminalAccessOff('node', 'settings:set', [{ terminalServer: false }], off)).toBe(false)
    // Unreadable settings: refused.
    expect(
      turnsNodeTerminalAccessOff('node', 'settings:set', [{ terminalServer: false }], () => {
        throw new Error('x')
      })
    ).toBe(true)
  })
})

describe.runIf(posix)('HostSocketServer handoff connections (cli-standalone.md 4.4 step 5, D8)', () => {
  /** The hostProof a handoff hello result must carry (handoff bound into it). */
  function handoffProof(res: Msg, challenge: Msg, params: Msg, hostKind = 'node'): string {
    return hostProof(SECRET, {
      protocolVersion: 1,
      hostInstanceId: HOST_ID,
      clientNonce: params.clientNonce,
      hostNonce: challenge.params.hostNonce,
      hostKind: hostKind as 'node',
      appVersion: '1.0.0',
      dataDir,
      mock: true,
      grantedScopes: res.result.grantedScopes,
      handoff: true
    })
  }

  for (const hostKind of ['inproc', 'headless-host', 'desktop'] as const) {
    for (const on of [true, false]) {
      it(`a proven desktop hello on a ${hostKind} host is refused after the proof (only a background host hands over; Terminal access ${on ? 'on' : 'off'})`, async () => {
        st.terminalServer = on
        st.accessLevel = 'full'
        await start({ hostKind })
        const c = await client()
        const { res } = await hello(c, { kind: 'desktop', scopes: ['read', 'configure'] })
        expect(res.error.data.code).toBe('bad_request')
        expect(res.error.data.message).toBe(DESKTOP_HANDOFF_REFUSED_MESSAGE)
        c.send(rpcRequest(2, 'host.stop', [{ force: true }]))
        await c.waitClosed()
        expect(st.calls).toEqual([])
      })
    }
  }

  for (const [label, terminalServer, accessLevel] of [
    ['Terminal access off', false, 'operate'],
    ["Terminal access 'operate'", true, 'operate'],
    ["Terminal access 'full'", true, 'full']
  ] as const) {
    it(`a proven desktop hello gets exactly read + configure and handoff: true, whatever it asked (${label})`, async () => {
      st.terminalServer = terminalServer
      st.accessLevel = accessLevel
      await start({ hostKind: 'node' })
      const c = await client()
      const { res, challenge, params } = await hello(c, { kind: 'desktop', scopes: ['read', 'operate', 'decide'] })
      expect(res.result).toMatchObject({ grantedScopes: ['read', 'configure'], handoff: true })
      expect(proofMatches(handoffProof(res, challenge, params), res.result.hostProof)).toBe(true)
      // The proof binds the grant: without `handoff` it does not verify.
      const withoutHandoff = hostProof(SECRET, {
        protocolVersion: 1,
        hostInstanceId: HOST_ID,
        clientNonce: params.clientNonce,
        hostNonce: challenge.params.hostNonce,
        hostKind: 'node',
        appVersion: '1.0.0',
        dataDir,
        mock: true,
        grantedScopes: res.result.grantedScopes
      })
      expect(proofMatches(withoutHandoff, res.result.hostProof)).toBe(false)
    })
  }

  it('a cli hello never gets the handoff grant, and is refused while Terminal access is off', async () => {
    st.terminalServer = false
    await start({ hostKind: 'node' })
    const c = await client()
    expect((await hello(c, { kind: 'cli', scopes: ['read', 'configure'] })).res.error.data.code).toBe('terminal_server_disabled')
    st.terminalServer = true
    const d = await client()
    const ok = (await hello(d, { kind: 'cli', scopes: ['read'] })).res
    expect(ok.result.handoff).toBeUndefined()
  })

  it('only host.status and host.stop (forced included) reach the dispatcher; everything else is scope_denied before dispatch', async () => {
    st.terminalServer = false
    st.result = (method, args) => ({ method, args })
    await start({ hostKind: 'node' })
    const c = await client()
    await hello(c, { kind: 'desktop', scopes: ['read', 'configure'] })
    c.send(rpcRequest(2, 'host.status', []))
    expect((await c.response(2)).result).toEqual({ method: 'host.status', args: [] })
    c.send(rpcRequest(3, 'host.stop', [{ force: true }]))
    expect((await c.response(3)).result).toEqual({ method: 'host.stop', args: [{ force: true }] })
    // read and configure channels alike, and the transport subscriptions.
    let id = 10
    for (const method of ['projects:list', 'settings:set', 'runs:subscribe', 'host.subscribe', 'secrets:status']) {
      c.send(rpcRequest(id, method, []))
      const res = await c.response(id++)
      expect(res.error.data.code, method).toBe('scope_denied')
      expect(res.error.data.message).toContain(DESKTOP_HANDOFF_UNAVAILABLE_MESSAGE)
    }
    expect(st.calls.map((x) => x.method)).toEqual(['host.status', 'host.stop'])
  })

  it('across app versions the handoff still works (host.stop stays callable)', async () => {
    await start({ hostKind: 'node' })
    const c = await client()
    const { res } = await hello(c, { kind: 'desktop', version: '0.9.0', scopes: ['read', 'configure'] })
    expect(res.result.versionSkewWarning).toContain('0.9.0')
    c.send(rpcRequest(2, 'host.stop', [{ handoff: true }]))
    expect((await c.response(2)).result).toEqual({ ok: true })
  })

  it('the peer check gets DESKTOP_HELLO_PEER_CHECK_MS for a desktop hello and still refuses the host\'s descendants', async () => {
    const budgets: (number | undefined)[] = []
    let answer: 'ok' | 'descendant' = 'descendant'
    await start({ hostKind: 'node', peerCheck: async (_pid, _fd, timeoutMs) => (budgets.push(timeoutMs), answer) })
    const c = await client()
    expect((await hello(c, { kind: 'desktop', scopes: ['read', 'configure'] })).res.error.data.code).toBe('agent_descendant_refused')
    answer = 'ok'
    const d = await client()
    expect((await hello(d, { kind: 'cli' })).res.result.grantedScopes).toEqual(['read'])
    expect(budgets).toEqual([2_000, undefined])
  })

  it('a desktop peer check that runs past the handshake deadline (to its own budget) does not close the connection', async () => {
    // RPC_HANDSHAKE_TIMEOUT_MS is 2 s from accept; the desktop check may take DESKTOP_HELLO_PEER_CHECK_MS (2 s) itself.
    await start({ hostKind: 'node', peerCheck: (_pid, _fd, timeoutMs) => new Promise((r) => setTimeout(() => r('ok'), timeoutMs === 2_000 ? 2_400 : 0)) })
    const c = await client()
    const { res } = await (async () => {
      const challenge = await c.next((m) => m.method === 'host.challenge')
      // Wait most of the deadline before the hello, as a slow client would.
      await new Promise((r) => setTimeout(r, 500))
      c.frames.unshift(challenge)
      return hello(c, { kind: 'desktop', scopes: ['read', 'configure'] })
    })()
    expect(res.result?.handoff).toBe(true)
    expect(c.closed).toBe(false)
  }, 15_000)

  it('handoff connections are not terminal sessions and survive Terminal access being turned off or narrowed', async () => {
    const fake = await start({ hostKind: 'node' })
    const h = await client()
    await hello(h, { kind: 'desktop', scopes: ['read', 'configure'] })
    const t = await client()
    await hello(t, { kind: 'tui', scopes: ['read', 'operate', 'decide'] })
    expect(server.terminalSessionCount()).toBe(1)
    expect(server.attachedClientCount()).toBe(1)
    st.accessLevel = 'operate'
    fake.events.emit('settings:changed', {} as never)
    await t.waitClosed()
    st.terminalServer = false
    fake.events.emit('settings:changed', {} as never)
    await new Promise((r) => setTimeout(r, 100))
    expect(h.closed).toBe(false)
    expect(server.terminalSessionCount()).toBe(0)
  })

  it('a draining host refuses the desktop hello with host_draining (the app then waits for the exit)', async () => {
    st.state = 'draining'
    await start({ hostKind: 'node' })
    const c = await client()
    expect((await hello(c, { kind: 'desktop', scopes: ['read', 'configure'] })).res.error.data.code).toBe('host_draining')
  })
})

describe.runIf(posix)('HostSocketServer.closeGracefully (cli-standalone.md 4.3)', () => {
  it('flushes an in-flight host.stop reply, closes every socket, and resolves', async () => {
    st.hold = true
    await start()
    const c = await client()
    await hello(c, { scopes: ['read', 'configure'] })
    c.send(rpcRequest(2, 'host.stop', [{}]))
    await vi.waitFor(() => expect(st.calls.length).toBe(1))
    const closing = server.closeGracefully(2_000)
    // The reply is produced after the close started and still reaches the client.
    st.release.splice(0).forEach((r) => r())
    await closing
    expect((await c.response(2)).result).toEqual({ ok: true })
    await c.waitClosed()
  })

  it('a client that never reads cannot hold it past the grace', async () => {
    await start()
    const c = await client()
    await hello(c, { scopes: ['read'] })
    c.socket.pause()
    st.hold = true
    c.send(rpcRequest(2, 'projects:list', []))
    await vi.waitFor(() => expect(st.calls.length).toBe(1))
    const t0 = Date.now()
    await server.closeGracefully(300)
    expect(Date.now() - t0).toBeLessThan(2_000)
    st.release.splice(0).forEach((r) => r())
  })

  it('resolves at once with no connections', async () => {
    await start()
    await expect(server.closeGracefully(5_000)).resolves.toBeUndefined()
  })
})
