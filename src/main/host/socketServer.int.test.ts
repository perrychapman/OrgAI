/**
 * The socket server end to end on a real booted mock host (no tokens, no Electron): real ownership (daemon.secret,
 * the unix socket), bootOrgAIHost with the scripted mock adapter, and a raw net client speaking protocol.ts.
 * POSIX only (Windows named pipes are UNVERIFIED).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostScope, Project, RunEvent, RunSummary } from '../../shared/types'

vi.mock('electron', () => {
  throw new Error('electron must not be imported by the socket server or the host')
})

const { bootOrgAIHost } = await import('./bootstrap')
const { acquireHostOwnership } = await import('./ownership')
const { newHostInstanceId } = await import('./identity')
const { HostSocketServer } = await import('./socketServer')
const { LineReader, clientProof, ownerProof, encodeFrame, hostProof, newNonce, proofMatches, readDaemonSecret, rpcRequest } = await import('./protocol')
const OWNER_KEY = 'ab'.repeat(32)
type OrgAIHost = import('./bootstrap').OrgAIHost
type HostOwnership = import('./ownership').HostOwnership

const posix = process.platform !== 'win32'
type Msg = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

class RawClient {
  readonly frames: Msg[] = []
  private reader = new LineReader()
  private waiters: Array<() => void> = []
  private nextId = 2
  closed = false

  constructor(readonly socket: Socket) {
    this.reader.maxLineBytes = 100 * 1024 * 1024
    socket.on('data', (c: Buffer) => {
      for (const l of this.reader.push(c).lines) this.frames.push(JSON.parse(l))
      this.wake()
    })
    socket.on('close', () => {
      this.closed = true
      this.wake()
    })
    socket.on('error', () => {})
  }

  static open(endpoint: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const s = connect(endpoint)
      s.once('connect', () => resolve(new RawClient(s)))
      s.once('error', reject)
    })
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w()
  }

  async next(pred: (m: Msg) => boolean, timeoutMs = 10_000): Promise<Msg> {
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

  async call(method: string, params?: unknown[] | Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    this.socket.write(encodeFrame(rpcRequest(id, method, params)))
    const res = await this.next((m) => m.id === id && !('method' in m))
    if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.data?.code })
    return res.result
  }

  /** Every runs:event push received so far (consumed). */
  takeRunEvents(): { seq?: number; atSeq?: number; event: RunEvent }[] {
    const out: { seq?: number; atSeq?: number; event: RunEvent }[] = []
    for (let i = 0; i < this.frames.length; ) {
      if (this.frames[i].method === 'runs:event') out.push(this.frames.splice(i, 1)[0].params)
      else i++
    }
    return out
  }

  destroy(): void {
    this.socket.destroy()
  }
}

let base: string
let dataDir: string
let ownership: HostOwnership
let host: OrgAIHost
let server: InstanceType<typeof HostSocketServer>
let clients: RawClient[]
let hostInstanceId: string

const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }

async function connectClient(kind: 'cli' | 'tui' = 'cli', scopes: HostScope[] = ['read', 'operate', 'configure']): Promise<{ c: RawClient; hello: Msg }> {
  const c = await RawClient.open(ownership.endpoint)
  clients.push(c)
  const challenge = await c.next((m) => m.method === 'host.challenge')
  const secret = readDaemonSecret(dataDir)
  if (!secret) throw new Error('no secret')
  const params = { protocolVersion: 1 as const, clientKind: kind, clientVersion: '9.9.9-int', pid: process.pid, cwd: base, clientNonce: newNonce(), requestedScopes: scopes }
  const proof = clientProof(secret, { ...params, hostInstanceId: challenge.params.hostInstanceId, hostNonce: challenge.params.hostNonce })
  const owner = ownerProof(OWNER_KEY, { hostInstanceId: challenge.params.hostInstanceId, hostNonce: challenge.params.hostNonce, clientNonce: params.clientNonce, clientProof: proof })
  c.socket.write(encodeFrame(rpcRequest(1, 'host.hello', { ...params, clientProof: proof, ownerProof: owner })))
  const res = await c.next((m) => m.id === 1)
  if (res.error) throw new Error(`hello refused: ${res.error.data.code}`)
  const expected = hostProof(secret, {
    protocolVersion: 1,
    hostInstanceId: challenge.params.hostInstanceId,
    clientNonce: params.clientNonce,
    hostNonce: challenge.params.hostNonce,
    hostKind: res.result.hostKind,
    appVersion: res.result.appVersion,
    dataDir: res.result.dataDir,
    mock: res.result.mock,
    grantedScopes: res.result.grantedScopes
  })
  expect(proofMatches(expected, res.result.hostProof)).toBe(true)
  return { c, hello: res.result }
}

function mockProject(name: string): Project {
  const folder = join(base, name)
  mkdirSync(folder)
  return host.services.projects.create({ name, path: folder, brief: '', setupKind: 'existing', mock: true }, host.settings.get(), { mockAvailable: true })
}

/** Wait for a run.status push (consumed). */
async function waitStatus(c: RawClient, runId: string, statuses: string[]): Promise<void> {
  await c.next((m) => m.method === 'runs:event' && m.params.event.type === 'run.status' && m.params.event.runId === runId && statuses.includes(m.params.event.status), 20_000)
}

beforeEach(async () => {
  if (!posix) return
  base = realpathSync(mkdtempSync('/tmp/orgai-si-'))
  dataDir = join(base, 'data')
  mkdirSync(join(base, 'rt'), { mode: 0o700 })
  clients = []
  hostInstanceId = newHostInstanceId()
  server = new HostSocketServer({ dataDir, hostKind: 'inproc', hostInstanceId, appVersion: '9.9.9-int', mock: true, ownerKey: OWNER_KEY, peerCheck: async () => 'ok', log: () => {} })
  ownership = await acquireHostOwnership({
    dataDir,
    hostKind: 'inproc',
    appVersion: '9.9.9-int',
    hostInstanceId,
    runtimeBase: join(base, 'rt'),
    onConnection: (s) => server.accept(s)
  })
  host = bootOrgAIHost({
    env: { userDataDir: base, logsDir: join(base, 'logs'), appVersion: '9.9.9-int', isPackaged: false },
    dataDir,
    hostKind: 'inproc',
    ownership,
    safeStorage,
    openExternal: () => {},
    mock: true,
    startBackground: false,
    housekeeping: { sweepStaleSkillDirs: () => {} },
    processEnv: {},
    homeDir: join(base, 'home')
  })
  server.attach(host)
  ownership.markReady()
})

afterEach(async () => {
  if (!posix) return
  for (const c of clients) c.destroy()
  await host.runs.stopAll({ reason: 'quit' }).catch(() => {})
  host.dispose()
  server.close()
  ownership.release()
  rmSync(base, { recursive: true, force: true })
})

describe.runIf(posix)('socket server on a booted mock host', () => {
  it('handshake, host.status and runs:list', async () => {
    const { c, hello } = await connectClient()
    expect(hello).toMatchObject({ hostKind: 'inproc', hostInstanceId, mock: true, dataDir, grantedScopes: ['read', 'operate', 'configure'] })
    expect(hello.versionSkewWarning).toBeUndefined()
    const status = (await c.call('host.status', {})) as Msg
    expect(status).toMatchObject({ protocolVersion: 1, hostInstanceId, hostKind: 'inproc', mock: true, dataDir })
    const project = mockProject('repo-list')
    expect(await c.call('runs:list', [project.id])).toEqual([])
  })

  it('runs:subscribe: snapshot, live pushes, then a replay after reconnecting with sinceSeq', async () => {
    const project = mockProject('repo-sub')
    const first = await connectClient()
    const sub = (await first.c.call('runs:subscribe', [{ projectIds: [project.id] }])) as Msg
    expect(sub.mode).toBe('snapshot')
    expect(sub.hostInstanceId).toBe(hostInstanceId)
    expect(sub.snapshot.liveRuns).toEqual([])
    const run = (await first.c.call('runs:start', [{ projectId: project.id, prompt: 'hello over the socket' }])) as RunSummary
    expect(run.projectId).toBe(project.id)
    // The mock script keeps going (reports, cards); a handful of durable events is enough.
    await vi.waitFor(() => expect(first.c.frames.filter((f) => f.method === 'runs:event' && f.params.seq !== undefined).length).toBeGreaterThan(6), { timeout: 10_000 })
    const pushed = first.c.takeRunEvents()
    const durable = pushed.filter((p) => p.seq !== undefined)
    expect(durable.length).toBeGreaterThan(5)
    const seqs = durable.map((p) => p.seq as number)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    for (const p of pushed) expect(p.event.runId === run.id || p.event.runId === '').toBe(true)
    first.c.destroy()

    // A second client resumes from a seq in the middle.
    const mid = seqs[Math.floor(seqs.length / 2)]
    const second = await connectClient()
    const replay = (await second.c.call('runs:subscribe', [{ projectIds: [project.id], sinceSeq: mid, filterKey: sub.filterKey, hostInstanceId }])) as Msg
    expect(replay.mode).toBe('replay')
    expect(replay.fromSeq).toBe(mid)
    expect(replay.toSeq).toBeGreaterThanOrEqual(seqs[seqs.length - 1])
    const replayed = (replay.events as { seq: number }[]).map((e) => e.seq)
    expect(replayed.filter((s) => s <= seqs[seqs.length - 1])).toEqual(seqs.filter((s) => s > mid))
    // A different filter gets a snapshot that lists the live run.
    const snap = (await second.c.call('runs:subscribe', [{ runIds: [run.id], sinceSeq: mid, filterKey: sub.filterKey, hostInstanceId }])) as Msg
    expect(snap.mode).toBe('snapshot')
    expect(snap.snapshot.liveRuns.map((s: RunSummary) => s.id)).toEqual([run.id])
    expect(snap.snapshot.pendingCards).toHaveProperty(run.id)
  })

  it('followChains follows a continued run', async () => {
    const project = mockProject('repo-chain')
    const { c } = await connectClient()
    const run = (await c.call('runs:start', [{ projectId: project.id, prompt: 'first' }])) as RunSummary
    await c.call('runs:subscribe', [{ runIds: [run.id], followChains: true }])
    // The mock run may already be idle; End session finishes it.
    await c.call('runs:stop', [run.id])
    await vi.waitFor(() => expect(host.runs.liveRuns().length).toBe(0), { timeout: 20_000 })
    c.takeRunEvents()
    const next = (await c.call('runs:continue', [{ runId: run.id, text: 'again' }])) as RunSummary
    expect(next.id).not.toBe(run.id)
    expect(next.resumedFrom).toBe(run.id)
    // The successor's first run.status is delivered (it joined the followed set first), and so is what follows it.
    await waitStatus(c, next.id, ['starting'])
    await c.next((m) => m.method === 'runs:event' && m.params.event.runId === next.id && m.params.event.type !== 'run.status')
    const later = c.takeRunEvents()
    expect(later.every((p) => p.event.runId === next.id || p.event.runId === run.id || p.event.runId === '')).toBe(true)
  })

  it('host.subscribe settings receives settings:changed', async () => {
    const { c } = await connectClient()
    expect(await c.call('host.subscribe', { topics: ['settings'] })).toEqual({ topics: ['settings'] })
    const current = (await c.call('settings:get', [])) as Msg
    await c.call('settings:set', [{ ...current, communityPrices: !current.communityPrices }])
    const n = await c.next((m) => m.method === 'settings:changed')
    expect(n.params.communityPrices).toBe(!current.communityPrices)
  })

  it('attachedClientCount feeds interactiveClients', async () => {
    expect(host.activity.snapshot().counts.interactiveClients).toBe(0)
    const { c } = await connectClient('tui')
    expect(host.activity.snapshot().counts.interactiveClients).toBe(1)
    const other = await connectClient('cli')
    await other.c.call('runs:subscribe', [{ includeActiveRunRecord: 'nope' }])
    expect(host.activity.snapshot().counts.interactiveClients).toBe(2)
    c.destroy()
    await vi.waitFor(() => expect(host.activity.snapshot().counts.interactiveClients).toBe(1))
  })
})
