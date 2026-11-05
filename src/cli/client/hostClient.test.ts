import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostRpcError, RpcHelloParams } from '../../shared/types'
import {
  LineReader,
  challengeFrame,
  clientProof,
  encodeFrame,
  hostProof,
  isRequest,
  newNonce,
  parseFrame,
  rpcError,
  rpcNotification,
  rpcResult,
  type JsonRpcRequest
} from '../../main/host/protocol'
import { HostCallError, connectHost } from './hostClient'

const ID = 'abcdef012345'
const SECRET = 'a'.repeat(64)

interface FakeOpts {
  /** Answer host.hello with this error (count: only the first N hellos). */
  helloError?: HostRpcError
  helloErrorTimes?: number
  badProof?: boolean
  challengeId?: string
  /** Answer requests only once this many are outstanding (or on 'flush'). */
  batch?: number
}

let dir: string
let dataDir: string
let server: Server | undefined
let sockets: Socket[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-'))
  dataDir = join(dir, 'data')
  mkdirSync(join(dataDir, 'run'), { recursive: true, mode: 0o700 })
})

afterEach(async () => {
  for (const s of sockets) s.destroy()
  sockets = []
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = undefined
  rmSync(dir, { recursive: true, force: true })
})

function writeDaemon(extra: Record<string, unknown> = {}): string {
  const endpoint = join(dataDir, 'run', `d-${ID}.sock`)
  writeFileSync(
    join(dataDir, 'run', 'daemon.json'),
    JSON.stringify({ hostInstanceId: ID, pid: process.pid, endpoint, state: 'ready', startedAt: Date.now(), hostKind: 'inproc', ...extra })
  )
  return endpoint
}

function writeSecret(): void {
  const p = join(dataDir, 'run', 'daemon.secret')
  writeFileSync(p, SECRET, { mode: 0o600 })
  chmodSync(p, 0o600)
}

interface FakeState {
  hellos: number
  maxOutstanding: number
  requests: JsonRpcRequest[]
  last?: Socket
}

async function fakeHost(endpoint: string, o: FakeOpts = {}): Promise<FakeState> {
  const state: FakeState = { hellos: 0, maxOutstanding: 0, requests: [] }
  server = createServer((socket) => {
    sockets.push(socket)
    state.last = socket
    const nonce = newNonce()
    const reader = new LineReader()
    reader.maxLineBytes = 1024 * 1024
    let authed = false
    let outstanding: JsonRpcRequest[] = []
    const flush = (): void => {
      for (const r of outstanding) socket.write(encodeFrame(rpcResult(r.id, { echo: r.params ?? null, method: r.method })))
      outstanding = []
    }
    socket.write(encodeFrame(challengeFrame(o.challengeId ?? ID, nonce)))
    socket.on('data', (chunk) => {
      for (const line of reader.push(chunk).lines) {
        const f = parseFrame(line)
        if (!f.ok || !isRequest(f.message)) continue
        const req = f.message
        if (!authed) {
          state.hellos++
          const p = req.params as unknown as RpcHelloParams
          if (o.helloError && state.hellos <= (o.helloErrorTimes ?? Infinity)) {
            socket.write(encodeFrame(rpcError(req.id, o.helloError)))
            continue
          }
          const expected = clientProof(SECRET, { ...p, hostInstanceId: ID, hostNonce: nonce })
          if (expected !== p.clientProof) {
            socket.write(encodeFrame(rpcError(req.id, { code: 'auth_failed', message: 'bad proof' })))
            continue
          }
          const result = { protocolVersion: 1 as const, hostInstanceId: ID, hostKind: 'inproc' as const, appVersion: '1.0.0', dataDir, mock: true, grantedScopes: p.requestedScopes }
          const proof = hostProof(o.badProof ? 'b'.repeat(64) : SECRET, { ...result, clientNonce: p.clientNonce, hostNonce: nonce })
          socket.write(encodeFrame(rpcResult(req.id, { ...result, hostProof: proof })))
          authed = true
          continue
        }
        state.requests.push(req)
        if (req.method === 'slow') continue
        if (req.method === 'fail') {
          socket.write(encodeFrame(rpcError(req.id, { code: 'scope_denied', message: 'nope' })))
          continue
        }
        if (req.method === 'notify') {
          socket.write(encodeFrame(rpcNotification('runs:event', { hello: 1 })))
          socket.write(encodeFrame(rpcResult(req.id, null)))
          continue
        }
        if (req.method === 'bye') {
          socket.destroy()
          continue
        }
        outstanding.push(req)
        state.maxOutstanding = Math.max(state.maxOutstanding, outstanding.length)
        if (outstanding.length >= (o.batch ?? 1)) flush()
        else setTimeout(flush, 30)
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((r) => server!.listen(endpoint, () => r()))
  return state
}

const base = () => ({ dataDir, scopes: ['read' as const], clientVersion: '1.0.0', cwd: '/x', pid: 123, isLive: () => true })

describe('connectHost', () => {
  it('connects, verifies the hostProof and calls', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    await fakeHost(endpoint)
    const r = await connectHost(base())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.client.hello.hostInstanceId).toBe(ID)
    expect(r.client.daemon.endpoint).toBe(endpoint)
    await expect(r.client.call('echo', [1, 2])).resolves.toEqual({ echo: [1, 2], method: 'echo' })
    r.client.close()
    r.client.close()
  })

  it('a wrong hostProof is auth_failed', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    await fakeHost(endpoint, { badProof: true })
    const r = await connectHost(base())
    expect(r).toMatchObject({ ok: false, reason: 'auth_failed' })
  })

  it('a missing secret is auth_failed naming the run folder', async () => {
    const endpoint = writeDaemon()
    await fakeHost(endpoint)
    const r = await connectHost(base())
    expect(r).toMatchObject({ ok: false, reason: 'auth_failed' })
    if (!r.ok) expect(r.message).toContain(join(dataDir, 'run'))
  })

  it('a hostInstanceId mismatch is unreachable', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    await fakeHost(endpoint, { challengeId: '111111111111' })
    expect(await connectHost(base())).toMatchObject({ ok: false, reason: 'unreachable' })
  })

  it('retries host_starting, then succeeds', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    const state = await fakeHost(endpoint, { helloError: { code: 'host_starting', message: 'starting', retryAfterMs: 50 }, helloErrorTimes: 2 })
    const r = await connectHost({ ...base(), waitStartingMs: 3000 })
    expect(r.ok).toBe(true)
    expect(state.hellos).toBe(3)
    if (r.ok) r.client.close()
  })

  it('host_starting past waitStartingMs is starting', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    await fakeHost(endpoint, { helloError: { code: 'host_starting', message: 'still starting', retryAfterMs: 50 } })
    expect(await connectHost({ ...base(), waitStartingMs: 300 })).toMatchObject({ ok: false, reason: 'starting' })
  })

  it("daemon.json state 'starting' polls, then reports starting", async () => {
    writeDaemon({ state: 'starting' })
    let t = 0
    const r = await connectHost({ ...base(), waitStartingMs: 500, now: () => t, sleep: async (ms) => void (t += ms) })
    expect(r).toMatchObject({ ok: false, reason: 'starting' })
    expect(t).toBeGreaterThanOrEqual(500)
  })

  it('terminal_server_disabled is disabled with the host message', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    await fakeHost(endpoint, { helloError: { code: 'terminal_server_disabled', message: 'Turn on terminal access.' } })
    expect(await connectHost(base())).toMatchObject({ ok: false, reason: 'disabled', message: 'Turn on terminal access.' })
  })

  it('host_draining answers and a draining daemon.json are draining', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    await fakeHost(endpoint, { helloError: { code: 'host_draining', message: 'draining' } })
    expect(await connectHost(base())).toMatchObject({ ok: false, reason: 'draining' })
    writeDaemon({ state: 'draining' })
    expect(await connectHost(base())).toMatchObject({ ok: false, reason: 'draining' })
  })

  it('refusals map to refused', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    await fakeHost(endpoint, { helloError: { code: 'too_many_connections', message: 'full' } })
    expect(await connectHost(base())).toMatchObject({ ok: false, reason: 'refused' })
  })

  it('a dead pid or no daemon.json is no_host', async () => {
    expect(await connectHost(base())).toMatchObject({ ok: false, reason: 'no_host' })
    writeDaemon()
    expect(await connectHost({ ...base(), isLive: () => false })).toMatchObject({ ok: false, reason: 'no_host' })
  })

  it('a live pid without a listener is unreachable', async () => {
    writeDaemon()
    expect(await connectHost(base())).toMatchObject({ ok: false, reason: 'unreachable' })
  })

  it('more than 4 calls queue locally', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    const state = await fakeHost(endpoint, { batch: 4 })
    const r = await connectHost(base())
    if (!r.ok) throw new Error(r.message)
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => r.client.call('echo', [i])))
    expect(results.map((x) => (x as { echo: number[] }).echo[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(state.maxOutstanding).toBeLessThanOrEqual(4)
    expect(state.requests.map((q) => q.id)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    r.client.close()
  })

  it('times out a call, rejects RPC errors with HostCallError.data, delivers notifications', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    await fakeHost(endpoint)
    const r = await connectHost(base())
    if (!r.ok) throw new Error(r.message)
    await expect(r.client.call('slow', [], { timeoutMs: 50 })).rejects.toThrow(/did not answer slow/)
    const err = await r.client.call('fail').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostCallError)
    expect((err as HostCallError).data).toEqual({ code: 'scope_denied', message: 'nope' })
    const seen: [string, unknown][] = []
    const off = r.client.onNotification((m, p) => seen.push([m, p]))
    await r.client.call('notify')
    expect(seen).toEqual([['runs:event', { hello: 1 }]])
    off()
    r.client.close()
  })

  it('onClose fires once and outstanding calls reject', async () => {
    const endpoint = writeDaemon()
    writeSecret()
    await fakeHost(endpoint)
    const r = await connectHost(base())
    if (!r.ok) throw new Error(r.message)
    let closes = 0
    const closed = new Promise<void>((res) =>
      r.client.onClose(() => {
        closes++
        res()
      })
    )
    const pending = r.client.call('slow')
    void r.client.call('bye').catch(() => {})
    await expect(pending).rejects.toThrow(/closed|failed/)
    await closed
    r.client.close()
    expect(closes).toBe(1)
    await expect(r.client.call('echo')).rejects.toThrow(/closed/)
  })
})
