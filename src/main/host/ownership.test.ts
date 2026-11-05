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
  acquireHostOwnership,
  parseDaemonInfo,
  pipeNameFor,
  readDaemonInfo,
  socketPathFor,
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
    const own = await acquire(env, { hostKind: 'headless-host', appVersion: '1.2.3' })
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
    expect(info).toMatchObject({ hostInstanceId: own.info.hostInstanceId, pid: process.pid, endpoint: own.endpoint, state: 'starting', hostKind: 'headless-host', appVersion: '1.2.3' })
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
