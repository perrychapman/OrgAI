import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DaemonInfo } from '@shared/types'
import { newHostInstanceId } from './identity'
import {
  HostAlreadyRunningError,
  HostOwnershipError,
  HostStartingOrBusyError,
  OWNERSHIP_BOUNDARIES,
  OwnershipFaultError,
  RELEASE_BOUNDARIES,
  acquireHostOwnership,
  parseDaemonInfo,
  pipeNameFor,
  readDaemonInfo,
  readDaemonFileState,
  protectSecretOnWindows,
  socketPathFor,
  withStartupMutex,
  type HostOwnership,
  type OwnershipOptions
} from './ownership'
import { processStartTime } from './processInfo'

// Real temp dirs and real unix sockets; POSIX only (Windows named pipes are UNVERIFIED, see ownership.ts).
const posix = process.platform !== 'win32'

// Under /tmp, not os.tmpdir(): macOS's /private/var/folders/... temp dir alone would push d-<id>.sock past the
// 100-byte socket limit and every test would take the long-path branch.
const SHORT_BASE = posix ? '/tmp' : tmpdir()

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      c()
    } catch {
      /* best effort */
    }
  }
})

interface Env {
  base: string
  dataDir: string
  runDir: string
  runtimeBase: string
}

function tempEnv(dataSuffix?: string): Env {
  const base = realpathSync(mkdtempSync(join(SHORT_BASE, 'orgai-own-')))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const dataDir = dataSuffix ? join(base, dataSuffix, 'data') : join(base, 'data')
  const runtimeBase = join(base, 'rt')
  mkdirSync(runtimeBase, { recursive: true, mode: 0o700 })
  return { base, dataDir, runDir: join(dataDir, 'run'), runtimeBase }
}

function opts(env: Env, extra: Partial<OwnershipOptions> = {}): OwnershipOptions {
  return {
    dataDir: env.dataDir,
    hostKind: 'desktop',
    appVersion: '0.0.0-test',
    hostInstanceId: newHostInstanceId(),
    runtimeBase: env.runtimeBase,
    ...extra
  }
}

async function acquire(env: Env, extra: Partial<OwnershipOptions> = {}): Promise<HostOwnership> {
  const own = await acquireHostOwnership(opts(env, extra))
  cleanups.push(() => own.release())
  return own
}

const mode = (path: string): number => lstatSync(path).mode & 0o777

function canConnect(path: string): Promise<boolean> {
  return new Promise((done) => {
    const s = connect(path)
    s.once('connect', () => {
      s.destroy()
      done(true)
    })
    s.once('error', () => done(false))
  })
}

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' })
  cleanups.push(() => child.kill('SIGKILL'))
  return child
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((r) => {
    if (child.exitCode !== null || child.signalCode !== null) r()
    else child.once('exit', () => r())
  })
}

/** A unix socket file left by a SIGKILLed listener: it exists and refuses connections. */
async function staleSocket(path: string): Promise<number> {
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  await new Promise<void>((r) => child.stdout!.once('data', () => r()))
  child.kill('SIGKILL')
  await exited(child)
  return child.pid!
}

function daemonJson(env: Env, info: Partial<DaemonInfo> & Pick<DaemonInfo, 'hostInstanceId' | 'pid' | 'endpoint'>): void {
  mkdirSync(env.runDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(env.runDir, 'daemon.json'), JSON.stringify({ state: 'ready', startedAt: Date.now(), ...info }))
}

function leftovers(runDir: string): string[] {
  return readdirSync(runDir).filter((n) => n.includes('.stale-') || n.includes('.tmp') || n.endsWith('.crash'))
}

describe.skipIf(!posix)('acquireHostOwnership', () => {
  it('creates run/ (0700), the secret (0600), the socket (0600) and daemon.json "starting"; markReady sets "ready"', async () => {
    const env = tempEnv()
    const own = await acquire(env, { hostKind: 'desktop', appVersion: '1.2.3' })
    expect(mode(env.runDir)).toBe(0o700)
    const secretPath = join(env.runDir, 'daemon.secret')
    expect(own.secretPath).toBe(secretPath)
    expect(mode(secretPath)).toBe(0o600)
    expect(readFileSync(secretPath, 'utf8')).toMatch(/^[0-9a-f]{64}$/)
    expect(own.endpoint).toBe(socketPathFor(env.dataDir, own.info.hostInstanceId))
    expect(lstatSync(own.endpoint).isSocket()).toBe(true)
    expect(mode(own.endpoint)).toBe(0o600)
    expect(own.runtimeDir).toBeUndefined()
    const info = readDaemonInfo(env.dataDir)
    expect(info).toMatchObject({ hostInstanceId: own.info.hostInstanceId, pid: process.pid, endpoint: own.endpoint, state: 'starting', hostKind: 'desktop', appVersion: '1.2.3' })
    expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
    expect(await canConnect(own.endpoint)).toBe(true)
    expect(own.markReady()).toBe(true)
    expect(readDaemonInfo(env.dataDir)?.state).toBe('ready')
    expect(own.info.state).toBe('ready')
    expect(own.markDraining()).toBe(true)
    expect(readDaemonInfo(env.dataDir)?.state).toBe('draining')
    expect(leftovers(env.runDir)).toEqual([])
  })

  it('hands connections to onConnection', async () => {
    const env = tempEnv()
    let got = 0
    const own = await acquire(env, {
      onConnection: (s) => {
        got++
        s.end()
      }
    })
    expect(await canConnect(own.endpoint)).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(got).toBe(1)
  })

  it('refuses a second host while the first is held (live pid, socket connects)', async () => {
    const env = tempEnv()
    const first = await acquire(env)
    const err = await acquireHostOwnership(opts(env)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostAlreadyRunningError)
    expect((err as HostAlreadyRunningError).exitCode).toBe(6)
    expect((err as HostAlreadyRunningError).info.hostInstanceId).toBe(first.info.hostInstanceId)
    expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
    expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(first.info.hostInstanceId)
  })

  it('release() removes daemon.json, the secret, the socket and leaves run/ empty; it is idempotent', async () => {
    const env = tempEnv()
    const own = await acquire(env)
    own.markReady()
    own.release()
    own.release()
    expect(readdirSync(env.runDir)).toEqual([])
    expect(own.markReady()).toBe(false)
    // A new host can take over at once.
    const next = await acquire(env)
    expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(next.info.hostInstanceId)
  })

  it('release() leaves a daemon.json that is not ours (and its secret) in place', async () => {
    const env = tempEnv()
    const own = await acquire(env)
    daemonJson(env, { hostInstanceId: 'bbbbbbbbbbbb', pid: process.pid, endpoint: join(env.runDir, 'd-bbbbbbbbbbbb.sock') })
    expect(own.markReady()).toBe(false)
    own.release()
    expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe('bbbbbbbbbbbb')
    expect(existsSync(own.secretPath)).toBe(true)
    expect(existsSync(own.endpoint)).toBe(false)
    expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
    own.release()
    expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe('bbbbbbbbbbbb')
  })

  describe('crash injection', () => {
    it.each(OWNERSHIP_BOUNDARIES)('recovers after a crash at %s', async (boundary) => {
      const env = tempEnv()
      const crashedId = newHostInstanceId()
      const fast = { startupYoungMs: 50, retryMs: 10 }
      let fault: unknown
      try {
        const crashed = await acquireHostOwnership(opts(env, { ...fast, hostInstanceId: crashedId, faultAt: boundary }))
        crashed.markReady()
      } catch (e) {
        fault = e
      }
      expect(fault).toBeInstanceOf(OwnershipFaultError)
      expect((fault as OwnershipFaultError).boundary).toBe(boundary)
      await (fault as OwnershipFaultError).crash()

      // The crashed instance shares our pid, so liveness is injected: it is dead.
      const own = await acquire(env, { ...fast, isLiveProcess: () => false })
      const info = readDaemonInfo(env.dataDir)
      expect(info?.hostInstanceId).toBe(own.info.hostInstanceId)
      expect(info?.state).toBe('starting')
      expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
      expect(existsSync(socketPathFor(env.dataDir, crashedId))).toBe(false)
      expect(leftovers(env.runDir)).toEqual([])
      expect(await canConnect(own.endpoint)).toBe(true)
      own.release()
      expect(readdirSync(env.runDir)).toEqual([])
    })
  })

  describe('crash injection while releasing', () => {
    it.each(RELEASE_BOUNDARIES)('recovers after a crash at %s', async (boundary) => {
      const env = tempEnv()
      const fast = { startupYoungMs: 50, retryMs: 10 }
      const crashed = await acquireHostOwnership(opts(env, { ...fast, faultAt: boundary }))
      crashed.markReady()
      let fault: unknown
      try {
        crashed.release()
      } catch (e) {
        fault = e
      }
      expect(fault).toBeInstanceOf(OwnershipFaultError)
      expect((fault as OwnershipFaultError).boundary).toBe(boundary)
      if (boundary === 'release-after-secret-removed') {
        // The secret is gone before daemon.json, so a newer host's secret is never removed by us.
        expect(existsSync(crashed.secretPath)).toBe(false)
        expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(crashed.info.hostInstanceId)
      }
      await (fault as OwnershipFaultError).crash()
      // Released already: a second call is a no-op.
      expect(() => crashed.release()).not.toThrow()

      const own = await acquire(env, { ...fast, isLiveProcess: () => false })
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
      expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
      expect(existsSync(crashed.endpoint)).toBe(false)
      expect(leftovers(env.runDir)).toEqual([])
      expect(await canConnect(own.endpoint)).toBe(true)
      own.release()
      expect(readdirSync(env.runDir)).toEqual([])
    })
  })

  it('puts startup.mkdir back when another contender took it between the dead-owner check and the rename', async () => {
    const env = tempEnv()
    const startup = join(env.runDir, 'startup.mkdir')
    mkdirSync(startup, { recursive: true, mode: 0o700 })
    writeFileSync(join(startup, 'owner.json'), JSON.stringify({ pid: 999_991, hostInstanceId: 'dddddddddddd', createdAt: 1 }))
    const fresh = { pid: 999_992, hostInstanceId: 'eeeeeeeeeeee', createdAt: 2 }
    const err = await acquireHostOwnership(
      opts(env, {
        liveWaitMs: 200,
        retryMs: 10,
        isLiveProcess: (pid) => {
          if (pid !== 999_991) return true
          // A second contender reclaims the dead mutex and takes it while we are still checking.
          rmSync(startup, { recursive: true, force: true })
          mkdirSync(startup, { mode: 0o700 })
          writeFileSync(join(startup, 'owner.json'), JSON.stringify(fresh))
          return false
        }
      })
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostStartingOrBusyError)
    expect(JSON.parse(readFileSync(join(startup, 'owner.json'), 'utf8'))).toEqual(fresh)
    expect(leftovers(env.runDir)).toEqual([])
    expect(existsSync(join(env.runDir, 'daemon.json'))).toBe(false)
  })

  it('never steals startup.mkdir from a live owner, and takes it once the owner is dead', async () => {
    const env = tempEnv()
    const child = spawnSleeper()
    const startup = join(env.runDir, 'startup.mkdir')
    mkdirSync(startup, { recursive: true, mode: 0o700 })
    writeFileSync(join(startup, 'owner.json'), JSON.stringify({ pid: child.pid, processStartTime: processStartTime(child.pid!), hostInstanceId: 'cccccccccccc', createdAt: Date.now() - 60_000 }))
    utimesSync(startup, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    const err = await acquireHostOwnership(opts(env, { liveWaitMs: 300, retryMs: 20 })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostStartingOrBusyError)
    expect((err as HostStartingOrBusyError).exitCode).toBe(6)
    expect(JSON.parse(readFileSync(join(startup, 'owner.json'), 'utf8')).pid).toBe(child.pid)
    expect(existsSync(join(env.runDir, 'daemon.json'))).toBe(false)

    child.kill('SIGKILL')
    await exited(child)
    const own = await acquire(env, { liveWaitMs: 300, retryMs: 20 })
    expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
    expect(leftovers(env.runDir)).toEqual([])
  })

  describe("wait: 'none' (the orgai CLI, cli-standalone-default.md 4.2)", () => {
    const never = (): Promise<void> => {
      throw new Error('slept: wait none must not wait')
    }

    it('refuses a live startup.mkdir owner at once, without sleeping, and leaves its mutex alone', async () => {
      const env = tempEnv()
      const child = spawnSleeper()
      const startup = join(env.runDir, 'startup.mkdir')
      mkdirSync(startup, { recursive: true, mode: 0o700 })
      writeFileSync(join(startup, 'owner.json'), JSON.stringify({ pid: child.pid, processStartTime: processStartTime(child.pid!), hostInstanceId: 'cccccccccccc', createdAt: Date.now() }))
      const began = Date.now()
      const err = await acquireHostOwnership(opts(env, { wait: 'none', sleep: never })).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostStartingOrBusyError)
      expect((err as HostStartingOrBusyError).ownerPid).toBe(child.pid)
      expect(Date.now() - began).toBeLessThan(1500)
      expect(JSON.parse(readFileSync(join(startup, 'owner.json'), 'utf8')).pid).toBe(child.pid)
      child.kill('SIGKILL')
      await exited(child)
      // A dead owner's mutex is provably stale: reclaimed as always.
      const own = await acquire(env, { wait: 'none', sleep: never })
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
    })

    it('refuses a young startup.mkdir with no owner.json at once, and reclaims an old one', async () => {
      const env = tempEnv()
      const startup = join(env.runDir, 'startup.mkdir')
      mkdirSync(startup, { recursive: true, mode: 0o700 })
      const err = await acquireHostOwnership(opts(env, { wait: 'none', sleep: never })).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostStartingOrBusyError)
      utimesSync(startup, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
      const own = await acquire(env, { wait: 'none', sleep: never })
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
    })

    it('refuses a live incumbent with its record, and ownerCwd is written to daemon.json and parsed back', async () => {
      const env = tempEnv()
      const own = await acquire(env, { wait: 'none', ownerCwd: '/work/first' })
      expect(readDaemonInfo(env.dataDir)?.ownerCwd).toBe('/work/first')
      expect(own.markReady()).toBe(true)
      expect(readDaemonInfo(env.dataDir)?.ownerCwd).toBe('/work/first')
      const err = await acquireHostOwnership(opts(env, { wait: 'none', sleep: never, ownerCwd: '/work/second' })).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostAlreadyRunningError)
      expect((err as HostAlreadyRunningError).info).toMatchObject({ pid: process.pid, ownerCwd: '/work/first' })
      own.release()
    })

    it('two starts at once: exactly one wins, the other is refused without waiting', async () => {
      const env = tempEnv()
      const results = await Promise.all([0, 1, 2].map(() => acquireHostOwnership(opts(env, { wait: 'none', sleep: never })).then((o) => o, (e: unknown) => e)))
      const won = results.filter((r) => !(r instanceof Error))
      expect(won).toHaveLength(1)
      cleanups.push(() => (won[0] as HostOwnership).release())
      for (const r of results) if (r instanceof Error) expect([HostAlreadyRunningError, HostStartingOrBusyError].some((c) => r instanceof c)).toBe(true)
    })

    it('a record whose pid is live but whose start time differs (pid reuse) is stale and reclaimed', async () => {
      const env = tempEnv()
      const child = spawnSleeper()
      daemonJson(env, { hostInstanceId: 'dddddddddddd', pid: child.pid!, endpoint: join(env.runDir, 'gone.sock'), processStartTime: 'not-the-real-start-time' })
      const own = await acquire(env, { wait: 'none', sleep: never })
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
    })

    it.each(OWNERSHIP_BOUNDARIES)('a crash at %s: a young leftover mutex is refused at once, an old one and a dead owner are reclaimed', async (boundary) => {
      const env = tempEnv()
      let fault: unknown
      try {
        const crashed = await acquireHostOwnership(opts(env, { wait: 'none', faultAt: boundary }))
        crashed.markReady()
      } catch (e) {
        fault = e
      }
      expect(fault).toBeInstanceOf(OwnershipFaultError)
      await (fault as OwnershipFaultError).crash()
      const startup = join(env.runDir, 'startup.mkdir')
      if (existsSync(startup) && !existsSync(join(startup, 'owner.json'))) {
        const err = await acquireHostOwnership(opts(env, { wait: 'none', sleep: never, isLiveProcess: () => false })).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(HostStartingOrBusyError)
        utimesSync(startup, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
      }
      const own = await acquire(env, { wait: 'none', sleep: never, isLiveProcess: () => false })
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
    })

    it('release racing a new start: refused or a clean win, never two owners, and a later start wins', async () => {
      for (let i = 0; i < 5; i++) {
        const env = tempEnv()
        const first = await acquire(env, { wait: 'none', sleep: never })
        first.markReady()
        const [, second] = await Promise.all([
          Promise.resolve().then(() => first.release()),
          acquireHostOwnership(opts(env, { wait: 'none', sleep: never })).then((o) => o, (e: unknown) => e)
        ])
        if (second instanceof Error) {
          expect([HostAlreadyRunningError, HostStartingOrBusyError].some((c) => second instanceof c)).toBe(true)
          const third = await acquire(env, { wait: 'none', sleep: never })
          expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(third.info.hostInstanceId)
        } else {
          const won = second as HostOwnership
          cleanups.push(() => won.release())
          expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(won.info.hostInstanceId)
          const err = await acquireHostOwnership(opts(env, { wait: 'none', sleep: never })).catch((e: unknown) => e)
          expect(err).toBeInstanceOf(Error)
        }
      }
    })

    it('a corrupt record is refused, and a record without ownerCwd still parses', async () => {
      const env = tempEnv()
      const first = await acquire(env, { wait: 'none' })
      expect(readDaemonInfo(env.dataDir)?.ownerCwd).toBeUndefined()
      first.release()
      mkdirSync(env.runDir, { recursive: true })
      writeFileSync(join(env.runDir, 'daemon.json'), '{ not json')
      const err = await acquireHostOwnership(opts(env, { wait: 'none', sleep: never })).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostOwnershipError)
      expect((err as HostOwnershipError).code).toBe('daemon_json_unreadable')
    })
  })

  it('waits on a young startup.mkdir with no owner.json and reclaims it only after startupYoungMs', async () => {
    const env = tempEnv()
    const startup = join(env.runDir, 'startup.mkdir')
    mkdirSync(startup, { recursive: true, mode: 0o700 })
    const createdAt = statSync(startup).mtimeMs
    let clock = Date.now()
    const sleptAt: number[] = []
    const own = await acquire(env, {
      startupYoungMs: 2000,
      retryMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        // Still in place while it is young: never stolen.
        expect(existsSync(startup)).toBe(true)
        sleptAt.push(clock)
        clock += ms
      }
    })
    expect(sleptAt.length).toBeGreaterThanOrEqual(15)
    expect(Math.max(...sleptAt) - createdAt).toBeLessThan(2000)
    expect(clock - createdAt).toBeGreaterThanOrEqual(2000)
    expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
    expect(leftovers(env.runDir)).toEqual([])
  })

  it.each(['missing', 'corrupt'])('reclaims an old startup.mkdir with %s owner.json at once', async (kind) => {
    const env = tempEnv()
    const startup = join(env.runDir, 'startup.mkdir')
    mkdirSync(startup, { recursive: true, mode: 0o700 })
    if (kind === 'corrupt') writeFileSync(join(startup, 'owner.json'), '{not json')
    const old = new Date(Date.now() - 10_000)
    utimesSync(startup, old, old)
    let slept = 0
    await acquire(env, {
      sleep: async () => {
        slept++
      }
    })
    expect(slept).toBe(0)
    expect(leftovers(env.runDir)).toEqual([])
  })

  it('replaces a daemon.json whose pid is dead and whose socket refuses', async () => {
    const env = tempEnv()
    mkdirSync(env.runDir, { recursive: true, mode: 0o700 })
    const staleId = 'dddddddddddd'
    const stalePath = socketPathFor(env.dataDir, staleId)
    const deadPid = await staleSocket(stalePath)
    expect(lstatSync(stalePath).isSocket()).toBe(true)
    daemonJson(env, { hostInstanceId: staleId, pid: deadPid, endpoint: stalePath })
    const own = await acquire(env)
    expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
    expect(existsSync(stalePath)).toBe(false)
  })

  it('replaces a daemon.json whose pid is dead and whose socket is gone (ENOENT)', async () => {
    const env = tempEnv()
    daemonJson(env, { hostInstanceId: 'eeeeeeeeeeee', pid: 999_999, endpoint: socketPathFor(env.dataDir, 'eeeeeeeeeeee') })
    const own = await acquire(env, { isLiveProcess: (pid) => pid !== 999_999 })
    expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
  })

  it.each([
    ['live', 'timeout'],
    ['live', 'eacces'],
    ['live', 'connected'],
    // Decided in ownership.ts: a live pid is never robbed, even when its endpoint does not answer.
    ['live', 'refused'],
    ['live', 'enoent'],
    // Something answers at the endpoint: not dead, whatever the pid says.
    ['dead', 'connected'],
    ['dead', 'timeout'],
    ['dead', 'eacces']
  ] as const)('refuses when the incumbent pid is %s and the probe says %s', async (pidState, answer) => {
    const env = tempEnv()
    daemonJson(env, { hostInstanceId: 'ffffffffffff', pid: process.pid, endpoint: socketPathFor(env.dataDir, 'ffffffffffff') })
    const err = await acquireHostOwnership(
      opts(env, { isLiveProcess: () => pidState === 'live', connectProbe: async () => answer })
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostAlreadyRunningError)
    expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe('ffffffffffff')
    expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
    expect(existsSync(join(env.runDir, 'daemon.secret'))).toBe(false)
  })

  it('never unlinks a dead endpoint outside run/ or an orgai-* runtime dir', async () => {
    const env = tempEnv()
    const outside = join(env.base, 'elsewhere.sock')
    const deadPid = await staleSocket(outside)
    daemonJson(env, { hostInstanceId: 'abababababab', pid: deadPid, endpoint: outside })
    await acquire(env)
    expect(lstatSync(outside).isSocket()).toBe(true)
  })

  it('sweeps orgai-* runtime dirs whose owner is dead and keeps live ones', async () => {
    const env = tempEnv()
    const child = spawnSleeper()
    const dead = join(env.runtimeBase, 'orgai-121212121212')
    const live = join(env.runtimeBase, 'orgai-343434343434')
    mkdirSync(dead, { mode: 0o700 })
    mkdirSync(live, { mode: 0o700 })
    writeFileSync(join(dead, 'owner.json'), JSON.stringify({ pid: 999_998 }))
    writeFileSync(join(live, 'owner.json'), JSON.stringify({ pid: child.pid }))
    await acquire(env, { isLiveProcess: (pid) => pid !== 999_998 })
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(live)).toBe(true)
  })

  it('binds under <runtimeBase>/orgai-<id> when the socket path would be 100 bytes or longer; release removes it', async () => {
    const env = tempEnv('x'.repeat(90))
    const id = newHostInstanceId()
    expect(Buffer.byteLength(socketPathFor(env.dataDir, id))).toBeGreaterThanOrEqual(100)
    const own = await acquire(env, { hostInstanceId: id })
    const rt = join(env.runtimeBase, `orgai-${id}`)
    expect(own.runtimeDir).toBe(rt)
    expect(own.endpoint).toBe(join(rt, 'd.sock'))
    expect(mode(rt)).toBe(0o700)
    expect(JSON.parse(readFileSync(join(rt, 'owner.json'), 'utf8'))).toMatchObject({ pid: process.pid, hostInstanceId: id })
    expect(readDaemonInfo(env.dataDir)?.endpoint).toBe(own.endpoint)
    expect(await canConnect(own.endpoint)).toBe(true)
    own.release()
    expect(existsSync(rt)).toBe(false)
    expect(readdirSync(env.runDir)).toEqual([])
  })

  // Review M11: a host with listen: false writes no secret and binds nothing.
  it('listen: false writes no secret and binds nothing, and daemon.json says so', async () => {
    const env = tempEnv()
    let got = 0
    const own = await acquire(env, {
      listen: false,
      onConnection: (s) => {
        got++
        s.end()
      }
    })
    const secretPath = join(env.runDir, 'daemon.secret')
    expect(own.listening).toBe(false)
    expect(existsSync(secretPath)).toBe(false)
    expect(own.endpoint).toBe(socketPathFor(env.dataDir, own.info.hostInstanceId))
    expect(existsSync(own.endpoint)).toBe(false)
    expect(readDaemonInfo(env.dataDir)).toMatchObject({ endpoint: own.endpoint, listening: false, state: 'starting' })
    // A second host still sees a running one (live pid) and is refused.
    expect(await acquireHostOwnership(opts(env)).catch((e: unknown) => e)).toBeInstanceOf(HostAlreadyRunningError)

    own.release()
    expect(readdirSync(env.runDir)).toEqual([])
  })

  it("a live host of the removed 'node' kind is reported as already running, with its pid", async () => {
    const env = tempEnv()
    const child = spawnSleeper()
    try {
      const id = newHostInstanceId()
      daemonJson(env, { hostInstanceId: id, pid: child.pid!, endpoint: socketPathFor(env.dataDir, id), processStartTime: processStartTime(child.pid!), hostKind: 'node' as never })
      const err = await acquireHostOwnership(opts(env)).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostAlreadyRunningError)
      expect((err as HostAlreadyRunningError).info.legacyKind).toBe('node')
      expect((err as Error).message).toContain('older OrgAI background process')
      expect((err as Error).message).toContain(`pid ${child.pid}`)
      expect((err as Error).message).toContain('Task Manager')
    } finally {
      child.kill('SIGKILL')
      await exited(child)
    }
  })

  it('a host whose listener is off and whose pid is dead is replaced', async () => {
    const env = tempEnv()
    const child = spawnSleeper()
    const pid = child.pid!
    child.kill('SIGKILL')
    await exited(child)
    const id = newHostInstanceId()
    daemonJson(env, { hostInstanceId: id, pid, endpoint: socketPathFor(env.dataDir, id), listening: false })
    const own = await acquire(env)
    expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
  })

  it('listen: false with a long socket path names the runtime dir and creates nothing', async () => {
    const env = tempEnv('y'.repeat(90))
    const id = newHostInstanceId()
    const own = await acquire(env, { hostInstanceId: id, listen: false })
    const rt = join(env.runtimeBase, `orgai-${id}`)
    expect(own.runtimeDir).toBe(rt)
    expect(own.endpoint).toBe(join(rt, 'd.sock'))
    expect(existsSync(rt)).toBe(false)
    own.release()
    expect(existsSync(rt)).toBe(false)
  })

  it('refuses a run dir that is a symlink', async () => {
    const env = tempEnv()
    const target = join(env.base, 'target')
    mkdirSync(target, { recursive: true })
    mkdirSync(env.dataDir, { recursive: true })
    symlinkSync(target, env.runDir)
    const err = await acquireHostOwnership(opts(env)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostOwnershipError)
    expect((err as HostOwnershipError).code).toBe('unsafe_run_dir')
    expect(readdirSync(target)).toEqual([])
  })

  it('refuses a run dir that is a file', async () => {
    const env = tempEnv()
    mkdirSync(env.dataDir, { recursive: true })
    writeFileSync(env.runDir, 'x')
    const err = await acquireHostOwnership(opts(env)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
  })

  describe('unconfirmed liveness and unusable daemon.json (review M9)', () => {
    const warnings: string[] = []
    const warn = (m: string): void => void warnings.push(m)

    it.each(['refused', 'enoent'] as const)('takes over from an unconfirmed pid whose endpoint is dead (%s)', async (answer) => {
      const env = tempEnv()
      daemonJson(env, { hostInstanceId: '0a0a0a0a0a0a', pid: process.pid, endpoint: socketPathFor(env.dataDir, '0a0a0a0a0a0a') })
      warnings.length = 0
      let probed = 0
      const own = await acquire(env, {
        warn,
        liveness: () => 'unconfirmed',
        connectProbe: async () => (probed++ === 0 ? answer : 'refused')
      })
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
      expect(warnings.join('\n')).toMatch(/could not be confirmed/)
    })

    it.each(['refused', 'enoent'] as const)(
      'never takes over from an unconfirmed pid whose daemon.json says listening: false, endpoint %s (the app never listens, review M9 + M11)',
      async (answer) => {
        const env = tempEnv()
        daemonJson(env, { hostInstanceId: '0d0d0d0d0d0d', pid: process.pid, endpoint: socketPathFor(env.dataDir, '0d0d0d0d0d0d'), hostKind: 'desktop', listening: false })
        const err = await acquireHostOwnership(opts(env, { liveness: () => 'unconfirmed', connectProbe: async () => answer })).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(HostAlreadyRunningError)
        expect((err as HostAlreadyRunningError).message).toContain(env.runDir)
        expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe('0d0d0d0d0d0d')
        // The startup mutex is not left behind.
        expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
      }
    )

    it.each(['desktop'] as const)(
      'an Electron launch holding the single-instance lock takes over from an unconfirmed %s pid whose daemon.json says listening: false (review M9 follow-up)',
      async (hostKind) => {
        // A crashed desktop host (it never listens); Windows reused its pid for an elevated process.
        const env = tempEnv()
        daemonJson(env, { hostInstanceId: '0f0f0f0f0f0f', pid: process.pid, endpoint: socketPathFor(env.dataDir, '0f0f0f0f0f0f'), hostKind, listening: false })
        warnings.length = 0
        const own = await acquire(env, { warn, singleInstanceLockHeld: true, liveness: () => 'unconfirmed', connectProbe: async () => 'enoent' })
        expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
        expect(warnings.join('\n')).toMatch(/single-instance lock; taking over/)
      }
    )

    it('the single-instance lock never reclaims an inproc incumbent, a confirmed pid or an endpoint that answers', async () => {
      const cases: { hostKind: 'desktop' | 'inproc'; live: 'same' | 'unconfirmed'; answer: 'enoent' | 'connected' }[] = [
        { hostKind: 'inproc', live: 'unconfirmed', answer: 'enoent' },
        { hostKind: 'desktop', live: 'same', answer: 'enoent' },
        { hostKind: 'desktop', live: 'unconfirmed', answer: 'connected' }
      ]
      for (const c of cases) {
        const env = tempEnv()
        daemonJson(env, { hostInstanceId: '0c0c0c0c0c0c', pid: process.pid, endpoint: socketPathFor(env.dataDir, '0c0c0c0c0c0c'), hostKind: c.hostKind, listening: false })
        const err = await acquireHostOwnership(
          opts(env, { singleInstanceLockHeld: true, liveness: () => c.live, connectProbe: async () => c.answer })
        ).catch((e: unknown) => e)
        expect(err, JSON.stringify(c)).toBeInstanceOf(HostAlreadyRunningError)
        expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe('0c0c0c0c0c0c')
      }
    })

    it('takes over from a dead pid whose daemon.json says listening: false', async () => {
      const env = tempEnv()
      daemonJson(env, { hostInstanceId: '0e0e0e0e0e0e', pid: process.pid, endpoint: socketPathFor(env.dataDir, '0e0e0e0e0e0e'), hostKind: 'desktop', listening: false })
      const own = await acquire(env, { liveness: () => 'dead', connectProbe: async () => 'enoent' })
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
    })

    it.each(['connected', 'timeout', 'eacces'] as const)('never takes over from an unconfirmed pid whose endpoint answers (%s)', async (answer) => {
      const env = tempEnv()
      daemonJson(env, { hostInstanceId: '0b0b0b0b0b0b', pid: process.pid, endpoint: socketPathFor(env.dataDir, '0b0b0b0b0b0b') })
      const err = await acquireHostOwnership(opts(env, { liveness: () => 'unconfirmed', connectProbe: async () => answer })).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostAlreadyRunningError)
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe('0b0b0b0b0b0b')
    })

    it('names the run folder in the refusal', async () => {
      const env = tempEnv()
      daemonJson(env, { hostInstanceId: '0c0c0c0c0c0c', pid: process.pid, endpoint: socketPathFor(env.dataDir, '0c0c0c0c0c0c') })
      const err = await acquireHostOwnership(opts(env, { liveness: () => 'same', connectProbe: async () => 'refused' })).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostAlreadyRunningError)
      expect((err as HostAlreadyRunningError).message).toContain(`delete the folder ${env.runDir}`)
      expect((err as HostAlreadyRunningError).runDir).toBe(env.runDir)
    })

    it('refuses (never "no incumbent") a daemon.json that is not JSON, and leaves it in place', async () => {
      const env = tempEnv()
      mkdirSync(env.runDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(env.runDir, 'daemon.json'), '{"pid": 12, "endp')
      const err = await acquireHostOwnership(opts(env)).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostOwnershipError)
      expect((err as HostOwnershipError).code).toBe('daemon_json_unreadable')
      expect((err as HostOwnershipError).exitCode).toBe(6)
      expect((err as Error).message).toContain('not valid JSON')
      expect((err as Error).message).toContain(env.runDir)
      expect(readFileSync(join(env.runDir, 'daemon.json'), 'utf8')).toBe('{"pid": 12, "endp')
      expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
      expect(existsSync(join(env.runDir, 'daemon.secret'))).toBe(false)
    })

    it('refuses an oversized daemon.json', async () => {
      const env = tempEnv()
      mkdirSync(env.runDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(env.runDir, 'daemon.json'), ' '.repeat(65 * 1024))
      const err = await acquireHostOwnership(opts(env)).catch((e: unknown) => e)
      expect((err as HostOwnershipError).code).toBe('daemon_json_unreadable')
    })

    it('replaces a record it cannot fully read only when it still names a dead pid with a dead endpoint', async () => {
      const env = tempEnv()
      mkdirSync(env.runDir, { recursive: true, mode: 0o700 })
      // A newer OrgAI's record (an unknown state): its pid and endpoint are still read.
      const newer = { hostInstanceId: '0d0d0d0d0d0d', pid: 999_990, endpoint: join(env.runDir, 'd-0d0d0d0d0d0d.sock'), state: 'paused', startedAt: 1 }
      writeFileSync(join(env.runDir, 'daemon.json'), JSON.stringify(newer))
      const live = await acquireHostOwnership(opts(env, { liveness: () => 'unconfirmed', connectProbe: async () => 'refused' })).catch((e: unknown) => e)
      expect((live as HostOwnershipError).code).toBe('daemon_json_unreadable')
      const answering = await acquireHostOwnership(opts(env, { liveness: () => 'dead', connectProbe: async () => 'connected' })).catch((e: unknown) => e)
      expect((answering as HostOwnershipError).code).toBe('daemon_json_unreadable')
      warnings.length = 0
      const own = await acquire(env, { warn, liveness: () => 'dead', connectProbe: async () => 'refused' })
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
      expect(warnings.join('\n')).toMatch(/unusable daemon\.json/)
    })

    it('treats an empty daemon.json as no host', async () => {
      const env = tempEnv()
      mkdirSync(env.runDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(env.runDir, 'daemon.json'), '')
      const own = await acquire(env)
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
    })

    it('reclaims startup.mkdir from an unconfirmed owner once it is older than unconfirmedStaleMs, and waits while it is younger', async () => {
      const env = tempEnv()
      const startup = join(env.runDir, 'startup.mkdir')
      mkdirSync(startup, { recursive: true, mode: 0o700 })
      writeFileSync(join(startup, 'owner.json'), JSON.stringify({ pid: 4242, hostInstanceId: '0e0e0e0e0e0e', createdAt: Date.now() }))
      const young = await acquireHostOwnership(opts(env, { liveness: () => 'unconfirmed', liveWaitMs: 100, retryMs: 10, unconfirmedStaleMs: 60_000 })).catch((e: unknown) => e)
      expect(young).toBeInstanceOf(HostStartingOrBusyError)
      expect((young as Error).message).toContain(env.runDir)
      expect(existsSync(startup)).toBe(true)
      writeFileSync(join(startup, 'owner.json'), JSON.stringify({ pid: 4242, hostInstanceId: '0e0e0e0e0e0e', createdAt: Date.now() - 61_000 }))
      warnings.length = 0
      const own = await acquire(env, { warn, liveness: () => 'unconfirmed', unconfirmedStaleMs: 60_000 })
      expect(readDaemonInfo(env.dataDir)?.hostInstanceId).toBe(own.info.hostInstanceId)
      expect(warnings.join('\n')).toMatch(/not confirmed as an OrgAI host/)
      expect(leftovers(env.runDir)).toEqual([])
    })

    it('never reclaims startup.mkdir from a confirmed owner, however old', async () => {
      const env = tempEnv()
      const startup = join(env.runDir, 'startup.mkdir')
      mkdirSync(startup, { recursive: true, mode: 0o700 })
      writeFileSync(join(startup, 'owner.json'), JSON.stringify({ pid: 4242, hostInstanceId: '0f0f0f0f0f0f', createdAt: Date.now() - 3_600_000 }))
      const err = await acquireHostOwnership(opts(env, { liveness: () => 'same', liveWaitMs: 60, retryMs: 10, unconfirmedStaleMs: 1 })).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostStartingOrBusyError)
      expect(existsSync(startup)).toBe(true)
    })
  })
})

describe.skipIf(!posix)('withStartupMutex (Wave 7, round 6 item 11)', () => {
  it('runs fn under startup.mkdir with no host, publishes nothing and releases the mutex', async () => {
    const env = tempEnv()
    let sawMutex = false
    const value = await withStartupMutex({ dataDir: env.dataDir, runtimeBase: env.runtimeBase }, () => {
      sawMutex = existsSync(join(env.runDir, 'startup.mkdir', 'owner.json'))
      return 42
    })
    expect(value).toBe(42)
    expect(sawMutex).toBe(true)
    expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
    expect(existsSync(join(env.runDir, 'daemon.json'))).toBe(false)
    expect(existsSync(join(env.runDir, 'daemon.secret'))).toBe(false)
    // A host can take the folder right after.
    await acquire(env)
  })

  it('refuses while a live host owns the folder, without calling fn', async () => {
    const env = tempEnv()
    await acquire(env, { hostKind: 'inproc' })
    let called = false
    await expect(
      withStartupMutex({ dataDir: env.dataDir, runtimeBase: env.runtimeBase }, () => {
        called = true
      })
    ).rejects.toBeInstanceOf(HostAlreadyRunningError)
    expect(called).toBe(false)
    expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
  })

  it('releases the mutex when fn throws', async () => {
    const env = tempEnv()
    await expect(
      withStartupMutex({ dataDir: env.dataDir, runtimeBase: env.runtimeBase }, () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
  })

  it('a host starting meanwhile waits for fn to finish', async () => {
    const env = tempEnv()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const order: string[] = []
    const held = withStartupMutex({ dataDir: env.dataDir, runtimeBase: env.runtimeBase }, async () => {
      order.push('fn-start')
      await gate
      order.push('fn-end')
    })
    await new Promise((r) => setTimeout(r, 50))
    const host = acquireHostOwnership(opts(env, { retryMs: 10 })).then((own) => {
      order.push('host')
      cleanups.push(() => own.release())
      return own
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(order).toEqual(['fn-start'])
    release()
    await held
    await host
    expect(order).toEqual(['fn-start', 'fn-end', 'host'])
  })
})

/**
 * The same steps with injected liveness and probe, so they run on every OS (windows-latest included; review round 2):
 * `orgai terminal-access` and the level write reach acquire's pre-publish steps only through withStartupMutex. Each case
 * also runs with `platform: 'win32'` injected, which takes the win32 branches (assertSafeDir without the uid / mode
 * checks, named-pipe endpoints, no socket sweep) on any machine.
 */
describe('withStartupMutex, platform-neutral (fake liveness and probe)', () => {
  const plats = [...new Set<NodeJS.Platform>([process.platform, 'win32'])]
  const daemonJson = (env: Env, pid: number, endpoint: string): void => {
    mkdirSync(env.runDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(env.runDir, 'daemon.json'), JSON.stringify({ hostInstanceId: '0123456789ab', pid, endpoint, state: 'ready', startedAt: 1, hostKind: 'inproc' }))
  }
  const endpointFor = (platform: NodeJS.Platform, env: Env): string => (platform === 'win32' ? pipeNameFor(env.dataDir, '0123456789ab', 'win32') : join(env.runDir, 'd-0123456789ab.sock'))

  for (const platform of plats) {
    it(`${platform}: runs fn with no host, publishes nothing and releases the mutex`, async () => {
      const env = tempEnv()
      let probes = 0
      const value = await withStartupMutex(
        {
          dataDir: env.dataDir,
          runtimeBase: env.runtimeBase,
          platform,
          liveness: () => 'dead',
          connectProbe: async () => (probes++, 'refused')
        },
        () => existsSync(join(env.runDir, 'startup.mkdir'))
      )
      expect(value).toBe(true)
      expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
      expect(existsSync(join(env.runDir, 'daemon.json'))).toBe(false)
      expect(existsSync(join(env.runDir, 'daemon.secret'))).toBe(false)
      expect(probes).toBe(0)
    })

    it(`${platform}: a live incumbent (or one whose endpoint answers) refuses without calling fn`, async () => {
      for (const [live, answer] of [
        ['same', 'refused'],
        ['dead', 'connected']
      ] as const) {
        const env = tempEnv()
        daemonJson(env, 4242, endpointFor(platform, env))
        let called = false
        const err = await withStartupMutex(
          { dataDir: env.dataDir, runtimeBase: env.runtimeBase, platform, liveness: () => live, connectProbe: async () => answer },
          () => {
            called = true
          }
        ).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(HostAlreadyRunningError)
        expect((err as HostAlreadyRunningError).info.pid).toBe(4242)
        expect(called).toBe(false)
        expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
      }
    })

    it(`${platform}: a dead incumbent with a dead endpoint is reclaimed and fn runs`, async () => {
      const env = tempEnv()
      daemonJson(env, 4242, endpointFor(platform, env))
      let called = false
      await withStartupMutex({ dataDir: env.dataDir, runtimeBase: env.runtimeBase, platform, liveness: () => 'dead', connectProbe: async () => 'refused' }, () => {
        called = true
      })
      expect(called).toBe(true)
      expect(existsSync(join(env.runDir, 'startup.mkdir'))).toBe(false)
    })

    it(`${platform}: a live process holding the mutex past the wait is HostStartingOrBusyError; fn never runs`, async () => {
      const env = tempEnv()
      const startup = join(env.runDir, 'startup.mkdir')
      mkdirSync(startup, { recursive: true, mode: 0o700 })
      writeFileSync(join(startup, 'owner.json'), JSON.stringify({ pid: 4242, hostInstanceId: '0f0f0f0f0f0f', createdAt: Date.now() }))
      let called = false
      const err = await withStartupMutex(
        { dataDir: env.dataDir, runtimeBase: env.runtimeBase, platform, liveness: () => 'same', liveWaitMs: 60, retryMs: 10 },
        () => {
          called = true
        }
      ).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(HostStartingOrBusyError)
      expect((err as HostStartingOrBusyError).ownerPid).toBe(4242)
      expect(called).toBe(false)
      expect(existsSync(join(startup, 'owner.json'))).toBe(true)
    })
  }
})

describe('readDaemonFileState', () => {
  it('tells missing, ok and unusable apart', () => {
    const base = mkdtempSync(join(tmpdir(), 'orgai-own-state-'))
    cleanups.push(() => rmSync(base, { recursive: true, force: true }))
    expect(readDaemonFileState(base)).toEqual({ kind: 'missing' })
    mkdirSync(join(base, 'run'))
    const path = join(base, 'run', 'daemon.json')
    const good = { hostInstanceId: '0123456789ab', pid: 42, endpoint: '/x/d.sock', state: 'ready', startedAt: 1 }
    writeFileSync(path, JSON.stringify(good))
    expect(readDaemonFileState(base)).toEqual({ kind: 'ok', info: good })
    writeFileSync(path, JSON.stringify({ ...good, state: 'gone', processStartTime: 'p' }))
    expect(readDaemonFileState(base)).toMatchObject({ kind: 'unusable', pid: 42, endpoint: '/x/d.sock', processStartTime: 'p' })
    writeFileSync(path, '[]')
    expect(readDaemonFileState(base)).toEqual({ kind: 'unusable', reason: 'it does not hold a host record this OrgAI understands' })
    writeFileSync(path, '')
    expect(readDaemonFileState(base)).toEqual({ kind: 'missing' })
  })
})

describe('protectSecretOnWindows (review M8, H1, H2 (3); UNVERIFIED on Windows)', () => {
  it('restricts the run folder before the secret is written, then the secret itself', async () => {
    const order: string[] = []
    const restrict = async (path: string, directory: boolean): Promise<undefined> => void order.push(`${directory ? 'dir' : 'file'} ${path}`)
    expect(await protectSecretOnWindows('D:\\data\\run', () => void order.push('write'), { mode: 'required', restrict })).toBeUndefined()
    expect(order).toEqual(['dir D:\\data\\run', 'write', expect.stringMatching(/^file D:\\data\\run.daemon\.secret$/)])
  })

  it('a failure is fatal only when required; best-effort warns, still writes and returns the reason', async () => {
    const restrict = async (): Promise<string> => 'icacls failed: No mapping between account names and security IDs was done.'
    let wrote = 0
    const err = await protectSecretOnWindows('D:\\data\\run', () => void wrote++, { mode: 'required', restrict }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostOwnershipError)
    expect((err as HostOwnershipError).code).toBe('secret_acl_failed')
    expect(wrote).toBe(0)
    const warned: string[] = []
    const w = await protectSecretOnWindows('D:\\data\\run', () => void wrote++, { mode: 'best-effort', restrict, warn: (m) => void warned.push(m) })
    expect(w).toMatch(/Could not restrict daemon\.secret to the current Windows user: icacls failed: No mapping/)
    expect(w).toMatch(/should not listen on this data folder/)
    expect(warned).toHaveLength(1)
    expect(wrote).toBe(1)
    // A throwing stand-in counts as a failure too.
    const thrown = await protectSecretOnWindows('D:\\r', () => {}, { mode: 'best-effort', restrict: async () => Promise.reject(new Error('boom')), warn: () => {} })
    expect(thrown).toMatch(/boom/)
  })

  it('the file step failing after the folder step is still reported', async () => {
    const restrict = async (_p: string, directory: boolean): Promise<string | undefined> => (directory ? undefined : 'icacls failed: denied')
    const err = await protectSecretOnWindows('D:\\r', () => {}, { mode: 'required', restrict }).catch((e: unknown) => e)
    expect((err as HostOwnershipError).code).toBe('secret_acl_failed')
  })
})

describe('pipeNameFor', () => {
  const id = 'a1b2c3d4e5f6'
  it('is deterministic and matches \\\\.\\pipe\\orgai-<sha256(dataDir) 20 hex>-<id>', () => {
    const dir = resolve('/some/user/data')
    const name = pipeNameFor(dir, id, 'linux')
    expect(name).toBe(pipeNameFor(dir, id, 'linux'))
    expect(name).toMatch(/^\\\\\.\\pipe\\orgai-[0-9a-f]{20}-a1b2c3d4e5f6$/)
    expect(name).toBe(`\\\\.\\pipe\\orgai-${createHash('sha256').update(dir).digest('hex').slice(0, 20)}-${id}`)
    expect(pipeNameFor(resolve('/other/data'), id, 'linux')).not.toBe(name)
    expect(pipeNameFor(dir, 'ffffffffffff', 'linux')).not.toBe(name)
  })
  it('folds case on win32 so both spellings of a folder name one pipe', () => {
    expect(pipeNameFor('C:\\Users\\Me\\Data', id, 'win32')).toBe(pipeNameFor('c:\\users\\me\\data', id, 'win32'))
  })
})

describe('readDaemonInfo / parseDaemonInfo', () => {
  const good = { hostInstanceId: '0123456789ab', pid: 42, endpoint: '/x/d.sock', state: 'ready', startedAt: 1 }
  it('accepts a valid record and drops unknown fields', () => {
    expect(parseDaemonInfo({ ...good, extra: 1, hostKind: 'desktop', appVersion: '1' })).toEqual({ ...good, hostKind: 'desktop', appVersion: '1' })
  })
  it("reads a record of the removed 'headless-host' kind as the desktop, and reads the removed 'node' kind as inproc", () => {
    expect(parseDaemonInfo({ ...good, hostKind: 'headless-host' })).toEqual({ ...good, hostKind: 'desktop' })
    expect(parseDaemonInfo({ ...good, hostKind: 'node' })?.hostKind).toBe('inproc')
    expect(parseDaemonInfo({ ...good, hostKind: 'node' })?.legacyKind).toBe('node')
    expect(parseDaemonInfo({ ...good, hostKind: 'inproc' })?.legacyKind).toBeUndefined()
    expect(parseDaemonInfo({ ...good, hostKind: 'bogus' })).toBeNull()
  })
  it('keeps listening only as an explicit false (review M11)', () => {
    expect(parseDaemonInfo({ ...good, listening: false })).toEqual({ ...good, listening: false })
    expect(parseDaemonInfo({ ...good, listening: true })).toEqual(good)
    expect(parseDaemonInfo({ ...good, listening: 'no' })).toEqual(good)
  })
  it.each([
    null,
    [],
    'x',
    { ...good, hostInstanceId: 'XYZ' },
    { ...good, pid: 0 },
    { ...good, pid: 1.5 },
    { ...good, endpoint: '' },
    { ...good, state: 'gone' },
    { ...good, startedAt: Number.NaN },
    { ...good, hostKind: 'robot' },
    { ...good, processStartTime: 5 }
  ])('rejects %j', (raw) => {
    expect(parseDaemonInfo(raw)).toBeNull()
  })
  it('is null for a missing or unparsable file', () => {
    const base = mkdtempSync(join(tmpdir(), 'orgai-own-read-'))
    cleanups.push(() => rmSync(base, { recursive: true, force: true }))
    expect(readDaemonInfo(base)).toBeNull()
    mkdirSync(join(base, 'run'))
    writeFileSync(join(base, 'run', 'daemon.json'), '{')
    expect(readDaemonInfo(base)).toBeNull()
  })
})
