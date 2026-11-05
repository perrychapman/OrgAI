import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonInfo } from '../../shared/types'
import { resetSkewWarning } from '../runRef'
import { FakeHostClient, fakeContext, flush, hostStatus, noHost } from '../testing/fakeContext'
import { EXIT, type InprocHostHandle } from '../types'
import { daemonTimers, guessLogPath, INPROC_BANNER, runDaemon } from './daemon'

const ready: DaemonInfo = { hostInstanceId: 'bbbbbbbbbbbb', pid: 77, endpoint: '/x', state: 'ready', startedAt: 1, hostKind: 'headless-host' }
const statusHost = (extra = {}) => new FakeHostClient({ 'host.status': () => hostStatus({ hostKind: 'headless-host', ...extra }) })

const realTimers = { ...daemonTimers }
beforeEach(() => resetSkewWarning())
afterEach(() => Object.assign(daemonTimers, realTimers))

describe('orgai daemon status', () => {
  it('exit 0 for a ready host, 1 otherwise', async () => {
    const f = fakeContext({ connect: [statusHost()] })
    expect(await runDaemon(f.ctx, ['status'])).toBe(EXIT.ok)
    expect(f.out()).toContain('OrgAI host: ready (headless-host)')
    const g = fakeContext({ connect: [statusHost({ state: 'draining' })] })
    expect(await runDaemon(g.ctx, ['status'])).toBe(EXIT.failure)
    const n = fakeContext()
    expect(await runDaemon(n.ctx, ['status'])).toBe(EXIT.failure)
    expect(n.out()).toContain('No OrgAI host is running.')
    await expect(runDaemon(n.ctx, ['bogus'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
})

describe('orgai daemon start', () => {
  it('a live host is reported, nothing is spawned', async () => {
    const f = fakeContext({ connect: [statusHost()] })
    expect(await runDaemon(f.ctx, ['start'])).toBe(EXIT.ok)
    expect(f.launcherCalls.map((c) => c.method)).toEqual([])
    expect(f.out()).toContain('OrgAI host: ready')
  })

  it('spawns headless and waits for ready', async () => {
    const f = fakeContext({ connect: [noHost(), statusHost()], launcher: { waitForReady: async () => ready } })
    expect(await runDaemon(f.ctx, ['start', '--timeout', '5'])).toBe(EXIT.ok)
    expect(f.launcherCalls).toEqual([
      { method: 'resolve', args: undefined },
      { method: 'spawn', args: { headless: true } },
      { method: 'waitForReady', args: { timeoutMs: 5000, hostKinds: ['headless-host', 'desktop'] } }
    ])
    expect(f.out()).toContain('headless-host')
  })

  it('a live host that refuses or does not answer is reported; nothing is spawned (review M)', async () => {
    const owner: DaemonInfo = { hostInstanceId: 'aaaaaaaaaaaa', pid: 55, endpoint: '/x', state: 'ready', startedAt: 1, hostKind: 'inproc' }
    for (const reason of ['refused', 'unreachable', 'protocol_mismatch'] as const) {
      const f = fakeContext({ connect: [{ ok: false, reason, message: 'too_many_connections', daemon: owner }], launcher: { waitForReady: async () => owner } })
      await expect(runDaemon(f.ctx, ['start'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining('already running (inproc, pid 55)') })
      expect(f.launcherCalls).toEqual([])
    }
    const g = fakeContext({ connect: [{ ok: false, reason: 'auth_failed', message: 'proof failed', daemon: owner }] })
    await expect(runDaemon(g.ctx, ['start'])).rejects.toMatchObject({ exitCode: EXIT.auth })
    expect(g.launcherCalls).toEqual([])
  })

  it('a spawned host that fails to start is exit 1 with its reason (review M)', async () => {
    const f = fakeContext({ launcher: { waitForReady: async () => Promise.reject(new Error('spawn /nope ENOENT')) } })
    await expect(runDaemon(f.ctx, ['start'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: 'Could not start the OrgAI host: spawn /nope ENOENT' })
  })

  it('a timeout is exit 6 with a pointer to the logs; a launcher error is exit 1', async () => {
    const f = fakeContext({ launcher: { waitForReady: async () => null } })
    await expect(runDaemon(f.ctx, ['start'])).rejects.toMatchObject({ exitCode: EXIT.hostBusy, message: expect.stringContaining('orgai daemon logs') })
    const g = fakeContext({ launcher: { resolve: () => ({ error: 'OrgAI app not found. Set ORGAI_APP_BINARY.' }) } })
    await expect(runDaemon(g.ctx, ['start'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: 'OrgAI app not found. Set ORGAI_APP_BINARY.' })
  })

  it('--host inproc runs in the foreground until SIGINT, then stops the host', async () => {
    let stopped: boolean | undefined
    let closeHost!: () => void
    const handle: InprocHostHandle = {
      status: () => hostStatus({ hostKind: 'inproc' }),
      stop: async (force) => {
        stopped = force
        closeHost()
      },
      closed: new Promise<void>((r) => (closeHost = r))
    }
    const f = fakeContext({ globals: { host: 'inproc' }, inproc: async () => handle })
    const done = runDaemon(f.ctx, ['start'])
    await flush()
    expect(f.out()).toContain(INPROC_BANNER)
    f.signal('SIGINT')
    expect(await done).toBe(EXIT.ok)
    expect(stopped).toBe(true)
    expect(f.launcherCalls).toEqual([])
  })

  it('inproc: a failing stop is 130 for SIGINT and 143 for SIGTERM', async () => {
    const mk = () => ({ status: () => hostStatus(), stop: async () => Promise.reject(new Error('stuck')), closed: new Promise<void>(() => undefined) })
    const f = fakeContext({ globals: { host: 'inproc' }, inproc: async () => mk() })
    const a = runDaemon(f.ctx, ['start', '--foreground'])
    await flush()
    f.signal('SIGTERM')
    expect(await a).toBe(EXIT.sigterm)
    const g = fakeContext({ inproc: async () => mk() })
    const b = runDaemon(g.ctx, ['start', '--foreground'])
    await flush()
    g.signal('SIGINT')
    expect(await b).toBe(EXIT.sigint)
  })
})

describe('orgai daemon stop / restart', () => {
  it('a refusal prints the blocking leases and exits 1', async () => {
    const h = new FakeHostClient({ 'host.stop': () => ({ stopping: false, refusedBecause: { liveRuns: 2, interactiveClients: 1 } }) })
    const f = fakeContext({ connect: [h] })
    expect(await runDaemon(f.ctx, ['stop'])).toBe(EXIT.failure)
    expect(f.out()).toContain('live runs: 2, attached terminals: 1')
    expect(f.out()).toContain('--force')
    expect(h.callsOf('host.stop')).toEqual([[{ force: false }]])
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
  })

  it('stops and waits until it is gone', async () => {
    const h = new FakeHostClient({ 'host.stop': () => ({ stopping: true }) })
    const f = fakeContext({ connect: [h] })
    expect(await runDaemon(f.ctx, ['stop', '--force'])).toBe(EXIT.ok)
    expect(h.callsOf('host.stop')).toEqual([[{ force: true }]])
    expect(f.launcherCalls).toEqual([{ method: 'waitForGone', args: { timeoutMs: 20000, hostInstanceId: 'aaaaaaaaaaaa' } }])
    expect(f.out()).toContain('OrgAI host stopped.')
    const g = fakeContext({ connect: [new FakeHostClient({ 'host.stop': () => ({ stopping: true }) })], launcher: { waitForGone: async () => false } })
    expect(await runDaemon(g.ctx, ['stop'])).toBe(EXIT.failure)
    const n = fakeContext()
    expect(await runDaemon(n.ctx, ['stop'])).toBe(EXIT.ok)
    expect(n.out()).toContain('No OrgAI host is running.')
  })

  it('restart stops, then starts a new host', async () => {
    const h = new FakeHostClient({ 'host.stop': () => ({ stopping: true }) })
    const f = fakeContext({ connect: [h, statusHost()], launcher: { waitForReady: async () => ready } })
    expect(await runDaemon(f.ctx, ['restart'])).toBe(EXIT.ok)
    expect(f.launcherCalls.map((c) => c.method)).toEqual(['waitForGone', 'resolve', 'spawn', 'waitForReady'])
    expect(f.launcherCalls[3].args).toEqual({ timeoutMs: 30000, hostKinds: ['headless-host', 'desktop'], notInstanceId: 'aaaaaaaaaaaa' })
  })
})

describe('orgai daemon logs', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-logs-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('prints the tail of the path the host reports, sanitized', async () => {
    const file = join(dir, 'main.log')
    writeFileSync(file, `${Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')}\n`)
    const f = fakeContext({ connect: [new FakeHostClient({ 'app:logPath': () => file })] })
    expect(await runDaemon(f.ctx, ['logs', '--lines', '3'])).toBe(EXIT.ok)
    expect(f.out()).toBe('line 297\nline 298\nline 299\n')
  })

  it('guesses the path without a host and follows growth until SIGINT', async () => {
    mkdirSync(join(dir, 'logs'))
    const file = join(dir, 'logs', 'main.log')
    writeFileSync(file, 'a\nb\n')
    let polls = 0
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: join(dir, 'data') }, globals: { dataDir: dir } })
    daemonTimers.sleep = async () => {
      polls++
      if (polls === 1) appendFileSync(file, 'c\n')
      if (polls === 2) f.signal('SIGINT')
      await flush()
    }
    expect(guessLogPath(f.ctx)).toBe(file)
    expect(await runDaemon(f.ctx, ['logs', '--follow'])).toBe(EXIT.ok)
    expect(f.out()).toBe('a\nb\nc\n')
    const g = fakeContext({ paths: { userDataDir: join(dir, 'none'), dataDir: join(dir, 'none', 'data') }, globals: { dataDir: 'x' } })
    await expect(runDaemon(g.ctx, ['logs'])).rejects.toMatchObject({ exitCode: EXIT.failure })
  })

  it('platform guess on macOS with the default data folder', () => {
    const f = fakeContext({ platform: 'darwin', env: { HOME: '/Users/me' } })
    expect(guessLogPath(f.ctx)).toBe('/Users/me/Library/Logs/OrgAI/main.log')
    const l = fakeContext({ platform: 'linux', paths: { userDataDir: '/home/me/.config/OrgAI', dataDir: '/home/me/.config/OrgAI/data' } })
    expect(guessLogPath(l.ctx)).toBe('/home/me/.config/OrgAI/logs/main.log')
  })
})
