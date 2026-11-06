import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonInfo } from '../../shared/types'
import { resetSkewWarning } from '../runRef'
import { FakeHostClient, fakeContext, flush, hostStatus, noHost } from '../testing/fakeContext'
import { CliError, EXIT, type InprocHostHandle } from '../types'
import { HostTakenError, NODE_HOST_BUNDLE_MISSING, NODE_HOST_NEEDS_NODE } from '../client/launcher'
import { NODE_HOST_TERMINAL_OFF, nodeHostDeps } from '../nodeHost'
import type { StoredTerminalAccess } from '../terminalAccessSettings'
import { daemonDeps, daemonTimers, guessLogPath, INPROC_BANNER, logCandidates, runDaemon } from './daemon'

const ready: DaemonInfo = { hostInstanceId: 'bbbbbbbbbbbb', pid: 77, endpoint: '/x', state: 'ready', startedAt: 1, hostKind: 'headless-host' }
const statusHost = (extra = {}) => new FakeHostClient({ 'host.status': () => hostStatus({ hostKind: 'headless-host', ...extra }) })

const realTimers = { ...daemonTimers }
const realDeps = { ...daemonDeps }
const realNodeDeps = { ...nodeHostDeps }
beforeEach(() => resetSkewWarning())
afterEach(() => {
  Object.assign(daemonTimers, realTimers)
  Object.assign(daemonDeps, realDeps)
  Object.assign(nodeHostDeps, realNodeDeps)
})

const access = (extra: Partial<StoredTerminalAccess> = {}): StoredTerminalAccess => ({
  terminalServer: false,
  terminalServerChosen: false,
  level: 'operate',
  levelChosen: true,
  enabledForBackground: true,
  ...extra
})

/** A machine with the npm CLI (no install.json channel 'app') and the given stored Terminal access. */
function nodeMachine(stored: StoredTerminalAccess = access()): { asked: string[]; written: string[]; exits: number[] } {
  const rec = { asked: [] as string[], written: [] as string[], exits: [] as number[] }
  nodeHostDeps.installInfo = () => ({ channel: 'npm', source: 'file' })
  nodeHostDeps.onElectron = () => false
  nodeHostDeps.terminalAccess = () => stored
  daemonDeps.ask = async (q) => {
    rec.asked.push(q)
    return 'full'
  }
  daemonDeps.writeLevel = async (_dir, level) => void rec.written.push(level)
  daemonDeps.exitSoon = (code) => void rec.exits.push(code)
  return rec
}

const nodeReady: DaemonInfo = { hostInstanceId: 'cccccccccccc', pid: 88, endpoint: '/y', state: 'ready', startedAt: 1, hostKind: 'node' }
const nodeStatus = (extra = {}) => new FakeHostClient({ 'host.status': () => hostStatus({ hostKind: 'node', ...extra }) })
const absent = { locate: () => ({ status: 'absent' as const, message: 'none' }) }

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
      { method: 'waitForReady', args: { timeoutMs: 5000, hostKinds: ['headless-host', 'desktop', 'node'] } }
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
    // It serves other terminals: started shared, so their ensureHost attaches to it (WP-B review round 2).
    expect(f.inprocCalls).toEqual([{ shared: true }])
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

describe('orgai daemon start --runtime (Wave 7, cli-standalone.md 4.2)', () => {
  it('no app found: starts the Node host and waits for kind node', async () => {
    nodeMachine()
    const f = fakeContext({
      connect: [noHost(), nodeStatus()],
      launcher: { ...absent, startBackground: () => ({ pid: 9, hostKinds: ['node'] }), waitForReady: async () => nodeReady }
    })
    expect(await runDaemon(f.ctx, ['start', '--timeout', '7'])).toBe(EXIT.ok)
    expect(f.launcherCalls).toEqual([
      { method: 'startBackground', args: 'node' },
      { method: 'waitForReady', args: { timeoutMs: 7000, hostKinds: ['node'] } }
    ])
    expect(f.out()).toContain('OrgAI host: ready (node)')
  })

  it('an app found: the app is the default; --runtime node starts Node anyway', async () => {
    nodeMachine()
    const f = fakeContext({ connect: [noHost(), statusHost()], launcher: { waitForReady: async () => ready, startBackground: () => ({ hostKinds: ['node'] }) } })
    expect(await runDaemon(f.ctx, ['start'])).toBe(EXIT.ok)
    expect(f.launcherCalls.map((c) => c.method)).toEqual(['resolve', 'spawn', 'waitForReady'])
    const g = fakeContext({ connect: [noHost(), nodeStatus()], launcher: { waitForReady: async () => nodeReady, startBackground: () => ({ hostKinds: ['node'] }) } })
    expect(await runDaemon(g.ctx, ['start', '--runtime', 'node'])).toBe(EXIT.ok)
    expect(g.launcherCalls.map((c) => c.method)).toEqual(['startBackground', 'waitForReady'])
  })

  it('a running host of the other kind with an explicit --runtime is exit 1; without --runtime it is reported', async () => {
    nodeMachine()
    const f = fakeContext({ connect: [statusHost()] })
    await expect(runDaemon(f.ctx, ['start', '--runtime', 'node'])).rejects.toMatchObject({
      exitCode: EXIT.failure,
      message: 'An app (headless) host is already running; use `orgai daemon restart --runtime node`'
    })
    const g = fakeContext({ connect: [nodeStatus()] })
    await expect(runDaemon(g.ctx, ['start', '--runtime', 'app'])).rejects.toMatchObject({ message: 'A Node host is already running; use `orgai daemon restart --runtime app`' })
    const h = fakeContext({ connect: [nodeStatus()] })
    expect(await runDaemon(h.ctx, ['start'])).toBe(EXIT.ok)
    expect(await runDaemon(fakeContext({ connect: [nodeStatus()] }).ctx, ['start', '--runtime', 'node'])).toBe(EXIT.ok)
    // A host refusing this terminal (Terminal access off) is checked by its daemon.json kind.
    const d = fakeContext({ connect: [{ ok: false, reason: 'disabled', message: 'off', daemon: nodeReady }] })
    await expect(runDaemon(d.ctx, ['start', '--runtime', 'app'])).rejects.toMatchObject({ exitCode: EXIT.failure })
    for (const bad of [['--runtime', 'electron'], ['--runtime', 'node', '--foreground']]) {
      await expect(runDaemon(fakeContext().ctx, ['start', ...bad])).rejects.toMatchObject({ exitCode: EXIT.usage })
    }
  })

  it('--runtime node is refused when install.json says app, or while Terminal access is stored off; nothing is spawned', async () => {
    nodeMachine()
    nodeHostDeps.installInfo = () => ({ channel: 'app', source: 'file' })
    const f = fakeContext({ launcher: { startBackground: () => ({ hostKinds: ['node'] }) } })
    await expect(runDaemon(f.ctx, ['start', '--runtime', 'node'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: NODE_HOST_NEEDS_NODE })
    nodeMachine(access({ terminalServerChosen: true, enabledForBackground: false }))
    const g = fakeContext({ launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }) } })
    await expect(runDaemon(g.ctx, ['start'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: NODE_HOST_TERMINAL_OFF })
    expect([...f.launcherCalls, ...g.launcherCalls].filter((c) => c.method === 'startBackground')).toEqual([])
  })

  it('asks once on a terminal for the level when none was chosen and stores it; without a terminal it notes how to change it', async () => {
    const rec = nodeMachine(access({ levelChosen: false }))
    const opts = () => ({ connect: [noHost(), nodeStatus()], launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] as const }), waitForReady: async () => nodeReady } })
    const tty = fakeContext({ ...opts(), stdinIsTTY: true })
    expect(await runDaemon(tty.ctx, ['start'])).toBe(EXIT.ok)
    expect(rec.asked).toEqual(['Let terminal sessions approve decisions and change configuration? [full/operate] (Enter keeps operate) '])
    expect(rec.written).toEqual(['full'])
    expect(tty.err()).toContain('Terminal access: full')
    // An unclear answer is asked again; Enter keeps operate.
    const answers = ['maybe', '']
    daemonDeps.ask = async () => answers.shift() ?? ''
    const again = fakeContext({ ...opts(), stdinIsTTY: true })
    expect(await runDaemon(again.ctx, ['start'])).toBe(EXIT.ok)
    expect(rec.written).toEqual(['full', 'operate'])
    expect(again.err()).toContain('Answer full or operate.')
    // No terminal: no question, no write, a note.
    const pipe = fakeContext(opts())
    expect(await runDaemon(pipe.ctx, ['start'])).toBe(EXIT.ok)
    expect(rec.written).toEqual(['full', 'operate'])
    expect(pipe.err()).toContain('orgai terminal-access --level full')
    // A stored choice: never asked.
    const chosen = nodeMachine(access({ levelChosen: true }))
    expect(await runDaemon(fakeContext({ ...opts(), stdinIsTTY: true }).ctx, ['start'])).toBe(EXIT.ok)
    expect(chosen.asked).toEqual([])
  })

  it('Enter keeps the level stored now, and the question names it (review round 2)', async () => {
    const rec = nodeMachine(access({ levelChosen: false, level: 'full' }))
    daemonDeps.ask = async (q) => (rec.asked.push(q), '')
    const f = fakeContext({ stdinIsTTY: true, connect: [noHost(), nodeStatus()], launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }), waitForReady: async () => nodeReady } })
    expect(await runDaemon(f.ctx, ['start'])).toBe(EXIT.ok)
    expect(rec.asked).toEqual(['Let terminal sessions approve decisions and change configuration? [full/operate] (Enter keeps full) '])
    expect(rec.written).toEqual(['full'])
  })

  it('a host of another kind that wins the start race is reported as running; with an explicit --runtime it is exit 1 (review round 2)', async () => {
    nodeMachine()
    const inprocInfo: DaemonInfo = { ...nodeReady, hostInstanceId: 'dddddddddddd', hostKind: 'inproc' }
    const taken = (d: DaemonInfo) => async (): Promise<never> => {
      throw new HostTakenError(d)
    }
    const inprocStatus = () => new FakeHostClient({ 'host.status': () => hostStatus({ hostKind: 'inproc' }) })
    const f = fakeContext({ connect: [noHost(), inprocStatus()], launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }), waitForReady: taken(inprocInfo) } })
    expect(await runDaemon(f.ctx, ['start'])).toBe(EXIT.ok)
    expect(f.out()).toContain('OrgAI host: ready (inproc)')
    const j = fakeContext({ globals: { outputFormat: 'json' }, connect: [noHost(), inprocStatus()], launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }), waitForReady: taken(inprocInfo) } })
    expect(await runDaemon(j.ctx, ['start'])).toBe(EXIT.ok)
    expect(JSON.parse(j.out())).toMatchObject({ running: true, alreadyRunning: true })
    const e = fakeContext({ connect: [noHost(), inprocStatus()], launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }), waitForReady: taken(inprocInfo) } })
    await expect(runDaemon(e.ctx, ['start', '--runtime', 'node'])).rejects.toMatchObject({
      exitCode: EXIT.failure,
      message: 'An in-process host is already running; use `orgai daemon restart --runtime node`'
    })
    // The app path: the spawned app handed off to a Node host.
    const a = fakeContext({ connect: [noHost(), nodeStatus()], launcher: { waitForReady: taken(nodeReady) } })
    expect(await runDaemon(a.ctx, ['start'])).toBe(EXIT.ok)
    expect(a.out()).toContain('OrgAI host: ready (node)')
  })

  it('a host that takes the folder during the level question is reported, nothing stored or spawned (review round 2)', async () => {
    const rec = nodeMachine(access({ levelChosen: false }))
    const owner: DaemonInfo = { ...ready }
    daemonDeps.writeLevel = async () => {
      throw new CliError('An OrgAI host owns this data folder (headless-host host, pid 77). Stop the background host first: orgai daemon stop', EXIT.failure)
    }
    const opts = () => ({ stdinIsTTY: true, connect: [noHost(), statusHost()], launcher: { ...absent, current: () => owner, startBackground: () => ({ hostKinds: ['node'] as const }) } })
    const f = fakeContext(opts())
    expect(await runDaemon(f.ctx, ['start'])).toBe(EXIT.ok)
    expect(f.out()).toContain('OrgAI host: ready (headless-host)')
    expect(f.err()).not.toContain('Stop the background host first')
    const g = fakeContext(opts())
    await expect(runDaemon(g.ctx, ['start', '--runtime', 'node'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining('already running; use `orgai daemon restart --runtime node`') })
    expect([...f.launcherCalls, ...g.launcherCalls].filter((c) => c.method === 'startBackground')).toEqual([])
    expect(rec.written).toEqual([])
    // With no host there, the write's own error stands.
    const h = fakeContext({ ...opts(), launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] as const }) } })
    await expect(runDaemon(h.ctx, ['start'])).rejects.toMatchObject({ message: expect.stringContaining('Stop the background host first') })
  })

  it('a missing orgai.mjs is refused before the level question (review round 2)', async () => {
    const rec = nodeMachine(access({ levelChosen: false }))
    const f = fakeContext({ stdinIsTTY: true, launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }), checkBackground: () => NODE_HOST_BUNDLE_MISSING } })
    await expect(runDaemon(f.ctx, ['start'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: `Could not start the OrgAI Node host: ${NODE_HOST_BUNDLE_MISSING}` })
    expect(rec.asked).toEqual([])
    expect(rec.written).toEqual([])
  })

  it('no terminal answer (none could be opened, or Ctrl+D) and three unclear answers store nothing (review round 1)', async () => {
    const rec = nodeMachine(access({ levelChosen: false }))
    const opts = () => ({ connect: [noHost(), nodeStatus()], launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] as const }), waitForReady: async () => nodeReady } })
    daemonDeps.ask = async (q) => {
      rec.asked.push(q)
      return undefined
    }
    const eof = fakeContext({ ...opts(), stdinIsTTY: true })
    expect(await runDaemon(eof.ctx, ['start'])).toBe(EXIT.ok)
    expect(rec.asked).toHaveLength(1)
    expect(rec.written).toEqual([])
    expect(eof.err()).toContain('Allow more with: orgai terminal-access --level full')
    daemonDeps.ask = async () => 'maybe'
    const unclear = fakeContext({ ...opts(), stdinIsTTY: true })
    expect(await runDaemon(unclear.ctx, ['start'])).toBe(EXIT.ok)
    expect(rec.written).toEqual([])
    expect(unclear.err().match(/Answer full or operate\./g)).toHaveLength(3)
  })

  it('a CLI running on Electron is refused before the level question or any write (review round 1)', async () => {
    const rec = nodeMachine(access({ levelChosen: false }))
    nodeHostDeps.installInfo = () => ({ channel: 'dev', source: 'absent' })
    nodeHostDeps.onElectron = () => true
    const f = fakeContext({ stdinIsTTY: true, launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }) } })
    await expect(runDaemon(f.ctx, ['start', '--runtime', 'node'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: NODE_HOST_NEEDS_NODE })
    expect(rec.asked).toEqual([])
    expect(rec.written).toEqual([])
    expect(f.launcherCalls.filter((c) => c.method === 'startBackground')).toEqual([])
  })

  it('a Node host that fails or times out: exit 1 with the reason, exit 6 on timeout', async () => {
    nodeMachine()
    const f = fakeContext({ launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }), waitForReady: async () => Promise.reject(new Error('OrgAI exited (code 1)')) } })
    await expect(runDaemon(f.ctx, ['start'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: 'Could not start the OrgAI Node host: OrgAI exited (code 1)' })
    const g = fakeContext({ launcher: { ...absent, startBackground: () => ({ hostKinds: ['node'] }), waitForReady: async () => null } })
    await expect(runDaemon(g.ctx, ['start'])).rejects.toMatchObject({ exitCode: EXIT.hostBusy })
  })
})

describe('orgai daemon run-node (hidden)', () => {
  it('starts the host as kind node, stops it on SIGTERM and exits after the drain', async () => {
    const rec = nodeMachine()
    let kind: string | undefined
    let closeHost!: () => void
    const handle: InprocHostHandle = {
      status: () => hostStatus({ hostKind: 'node' }),
      stop: async () => closeHost(),
      closed: new Promise<void>((r) => (closeHost = r))
    }
    const f = fakeContext({
      inproc: async (o) => {
        kind = o?.hostKind
        return handle
      }
    })
    const done = runDaemon(f.ctx, ['run-node'])
    await flush()
    expect(kind).toBe('node')
    expect(f.err()).toContain('OrgAI Node host aaaaaaaaaaaa (pid 4242) ready')
    f.signal('SIGTERM')
    expect(await done).toBe(EXIT.ok)
    expect(rec.exits).toEqual([0])
    expect(f.signalListeners()).toBe(0)
  })

  it('losing the data folder to another live host is a quiet hand-off, exit 0, never the delete-run advice (review round 1)', async () => {
    const rec = nodeMachine()
    const busy = new CliError('OrgAI is already running for this data folder (pid 88, node cccccccccccc). If you are sure ... delete the folder /d/run', EXIT.hostBusy)
    const f = fakeContext({ inproc: async () => Promise.reject(busy), launcher: { current: () => nodeReady } })
    expect(await runDaemon(f.ctx, ['run-node'])).toBe(EXIT.ok)
    expect(rec.exits).toEqual([0])
    expect(f.err()).toContain('Another OrgAI host owns this data folder (node, pid 88)')
    expect(f.err()).not.toContain('delete')
    // No live owner (a real ownership failure): the error stands.
    const g = fakeContext({ inproc: async () => Promise.reject(busy) })
    await expect(runDaemon(g.ctx, ['run-node'])).rejects.toBe(busy)
    // Any other failure stands too.
    const other = new CliError('boom', EXIT.failure)
    const h = fakeContext({ inproc: async () => Promise.reject(other), launcher: { current: () => nodeReady } })
    await expect(runDaemon(h.ctx, ['run-node'])).rejects.toBe(other)
  })

  it('refuses while Terminal access is stored off', async () => {
    nodeMachine(access({ terminalServerChosen: true, enabledForBackground: false }))
    await expect(runDaemon(fakeContext({ inproc: async () => Promise.reject(new Error('not reached')) }).ctx, ['run-node'])).rejects.toMatchObject({ exitCode: EXIT.failure })
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
    expect(f.launcherCalls[3].args).toEqual({ timeoutMs: 30000, hostKinds: ['headless-host', 'desktop', 'node'], notInstanceId: 'aaaaaaaaaaaa' })
  })
})

describe('orgai daemon restart (Wave 7)', () => {
  it('a Node host comes back as a Node host', async () => {
    nodeMachine()
    const h = new FakeHostClient({ 'host.stop': () => ({ stopping: true }) }, { hello: { hostKind: 'node' } })
    const f = fakeContext({ connect: [h, nodeStatus()], launcher: { current: () => nodeReady, startBackground: () => ({ hostKinds: ['node'] }), waitForReady: async () => nodeReady } })
    expect(await runDaemon(f.ctx, ['restart'])).toBe(EXIT.ok)
    expect(f.launcherCalls.map((c) => c.method)).toEqual(['waitForGone', 'startBackground', 'waitForReady'])
    expect(f.launcherCalls[2].args).toEqual({ timeoutMs: 30000, hostKinds: ['node'], notInstanceId: 'aaaaaaaaaaaa' })
  })

  it('--runtime switches kinds; a refused Node host is refused before the running host is stopped', async () => {
    nodeMachine()
    const h = new FakeHostClient({ 'host.stop': () => ({ stopping: true }) })
    const f = fakeContext({ connect: [h, nodeStatus()], launcher: { current: () => ready, startBackground: () => ({ hostKinds: ['node'] }), waitForReady: async () => nodeReady } })
    expect(await runDaemon(f.ctx, ['restart', '--runtime', 'node'])).toBe(EXIT.ok)
    expect(f.launcherCalls.map((c) => c.method)).toEqual(['waitForGone', 'startBackground', 'waitForReady'])
    nodeHostDeps.installInfo = () => ({ channel: 'app', source: 'file' })
    const k = new FakeHostClient({ 'host.stop': () => ({ stopping: true }) })
    const g = fakeContext({ connect: [k], launcher: { current: () => ready } })
    await expect(runDaemon(g.ctx, ['restart', '--runtime', 'node'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: NODE_HOST_NEEDS_NODE })
    expect(k.callsOf('host.stop')).toEqual([])
  })
})

describe('orgai daemon restart to a Node host: everything that can fail happens before the stop (review round 2)', () => {
  const running = () => new FakeHostClient({ 'host.stop': () => ({ stopping: true }) }, { hello: { hostKind: 'node' } })

  it('asks before the stop and stores after it', async () => {
    const order: string[] = []
    nodeMachine(access({ levelChosen: false }))
    daemonDeps.ask = async () => (order.push('ask'), 'full')
    daemonDeps.writeLevel = async () => void order.push('write')
    const h = new FakeHostClient({ 'host.stop': () => (order.push('stop'), { stopping: true }) }, { hello: { hostKind: 'node' } })
    const f = fakeContext({ stdinIsTTY: true, connect: [h, nodeStatus()], launcher: { current: () => nodeReady, startBackground: () => (order.push('spawn'), { hostKinds: ['node'] }), waitForReady: async () => nodeReady } })
    expect(await runDaemon(f.ctx, ['restart'])).toBe(EXIT.ok)
    expect(order).toEqual(['ask', 'stop', 'write', 'spawn'])
  })

  it('an interrupted question, a junk settings.json or a missing orgai.mjs leaves the running host alone', async () => {
    const rec = nodeMachine(access({ levelChosen: false }))
    const launcher = { current: () => nodeReady, startBackground: () => ({ hostKinds: ['node'] as const }), waitForReady: async () => nodeReady }
    daemonDeps.ask = async () => {
      throw new Error('interrupted')
    }
    const a = running()
    await expect(runDaemon(fakeContext({ stdinIsTTY: true, connect: [a], launcher }).ctx, ['restart'])).rejects.toThrow('interrupted')
    expect(a.callsOf('host.stop')).toEqual([])
    daemonDeps.ask = async () => 'full'
    daemonDeps.checkLevelWritable = () => {
      throw new CliError('settings.json could not be read', EXIT.failure)
    }
    const b = running()
    await expect(runDaemon(fakeContext({ stdinIsTTY: true, connect: [b], launcher }).ctx, ['restart'])).rejects.toThrow('settings.json could not be read')
    expect(b.callsOf('host.stop')).toEqual([])
    const c = running()
    await expect(runDaemon(fakeContext({ stdinIsTTY: true, connect: [c], launcher: { ...launcher, checkBackground: () => NODE_HOST_BUNDLE_MISSING } }).ctx, ['restart'])).rejects.toMatchObject({
      message: expect.stringContaining(NODE_HOST_BUNDLE_MISSING)
    })
    expect(c.callsOf('host.stop')).toEqual([])
    expect(rec.written).toEqual([])
  })

  it('a level write that fails after the stop warns and the host still starts', async () => {
    nodeMachine(access({ levelChosen: false }))
    daemonDeps.writeLevel = async () => {
      throw new Error('disk full')
    }
    let up = true
    const h = new FakeHostClient({ 'host.stop': () => ((up = false), { stopping: true }) }, { hello: { hostKind: 'node' } })
    const f = fakeContext({ stdinIsTTY: true, connect: [h, nodeStatus()], launcher: { current: () => (up ? nodeReady : null), startBackground: () => ({ hostKinds: ['node'] }), waitForReady: async () => nodeReady } })
    expect(await runDaemon(f.ctx, ['restart'])).toBe(EXIT.ok)
    expect(f.err()).toContain('Could not store the Terminal access level (disk full)')
    expect(f.launcherCalls.map((c) => c.method)).toEqual(['waitForGone', 'startBackground', 'waitForReady'])
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

  it('picks the newest of main.log and node-host.log (and the macOS app log with the default data folder)', async () => {
    mkdirSync(join(dir, 'logs'))
    const main = join(dir, 'logs', 'main.log')
    const node = join(dir, 'logs', 'node-host.log')
    writeFileSync(main, 'main\n')
    writeFileSync(node, 'node\n')
    utimesSync(main, new Date(1000), new Date(1000))
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: join(dir, 'data') }, globals: { dataDir: dir }, platform: 'linux' })
    expect(logCandidates(f.ctx)).toEqual([main, node])
    expect(await runDaemon(f.ctx, ['logs'])).toBe(EXIT.ok)
    expect(f.out()).toBe('node\n')
    const mac = fakeContext({ paths: { userDataDir: dir, dataDir: join(dir, 'data') }, platform: 'darwin', env: { HOME: join(dir, 'home') } })
    const appLog = join(dir, 'home', 'Library', 'Logs', 'OrgAI', 'main.log')
    expect(logCandidates(mac.ctx)).toEqual([main, node, appLog])
    mkdirSync(join(dir, 'home', 'Library', 'Logs', 'OrgAI'), { recursive: true })
    writeFileSync(appLog, 'app\n')
    utimesSync(node, new Date(2000), new Date(2000))
    expect(guessLogPath(mac.ctx)).toBe(appLog)
    // A host path that does not exist falls back to the candidates.
    const h = fakeContext({ connect: [new FakeHostClient({ 'app:logPath': () => join(dir, 'gone.log') })], paths: { userDataDir: dir, dataDir: join(dir, 'data') }, globals: { dataDir: dir }, platform: 'linux' })
    expect(await runDaemon(h.ctx, ['logs'])).toBe(EXIT.ok)
    expect(h.out()).toBe('node\n')
  })

  it('platform guess on macOS with the default data folder', () => {
    const f = fakeContext({ platform: 'darwin', env: { HOME: '/Users/me' } })
    expect(guessLogPath(f.ctx)).toBe('/Users/me/Library/Logs/OrgAI/main.log')
    const l = fakeContext({ platform: 'linux', paths: { userDataDir: '/home/me/.config/OrgAI', dataDir: '/home/me/.config/OrgAI/data' } })
    expect(guessLogPath(l.ctx)).toBe('/home/me/.config/OrgAI/logs/main.log')
  })
})
