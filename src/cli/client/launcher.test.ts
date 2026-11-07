import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { basename, dirname, join, resolve } from 'node:path'
import { packagedLayout } from '../../main/host/packagedLayout'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APP_NOT_FOUND,
  CHECKOUT_MARKER,
  cliBundleEntry,
  createLauncher,
  devAppRoot,
  devCheckoutNoElectron,
  devCheckoutUnbuilt,
  discoverInstalledApp,
  HostTakenError,
  hostSpawnCwd,
  hostSpawnEnv,
  installedAppBroken,
  installedAppCandidates,
  isOrgAICheckout,
  NODE_HOST_BUNDLE_MISSING,
  NODE_HOST_LOG_MAX_BYTES,
  NODE_HOST_NEEDS_NODE,
  packagedAppMissing,
  rotateNodeHostLog,
  type SpawnFn
} from './launcher'

const PLAT = process.platform // packaged-layout paths are per platform (path.posix vs path.win32)
let base: string
let dataDir: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'lch-')))
  dataDir = join(base, 'ud', 'data')
  mkdirSync(join(dataDir, 'run'), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/**
 * A fake dev checkout: package.json name orgai with electron in devDependencies, electron.vite.config.ts, out/main and
 * out/cli, an installed electron package.
 */
function fakeRepo(at = join(base, 'repo')): string {
  const root = at
  mkdirSync(join(root, 'out', 'main'), { recursive: true })
  mkdirSync(join(root, 'out', 'cli'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'orgai', devDependencies: { electron: '45.1.0' } }))
  writeFileSync(join(root, CHECKOUT_MARKER), '')
  writeFileSync(join(root, 'out', 'main', 'index.js'), '')
  const el = join(root, 'node_modules', 'electron')
  mkdirSync(join(el, 'dist'), { recursive: true })
  writeFileSync(join(el, 'package.json'), JSON.stringify({ name: 'electron', main: 'index.js' }))
  writeFileSync(join(el, 'path.txt'), 'electron-bin')
  writeFileSync(join(el, 'dist', 'electron-bin'), '')
  return root
}

const daemon = (id: string, state = 'ready', pid = 4242): void =>
  writeFileSync(join(dataDir, 'run', 'daemon.json'), JSON.stringify({ hostInstanceId: id, pid, endpoint: '/x.sock', state, startedAt: 1 }))

describe('launcher', () => {
  it('resolves ORGAI_ELECTRON_PATH (with ORGAI_APP_ROOT) first', () => {
    const l = createLauncher({ dataDir, userDataDir: join(base, 'ud'), userChoseDataDir: false, env: { ORGAI_ELECTRON_PATH: '/opt/electron', ORGAI_APP_ROOT: '/opt/app' } })
    expect(l.resolve()).toEqual({ command: '/opt/electron', args: [resolve('/opt/app')], source: 'env' })
  })

  it('resolves a dev checkout from out/cli and from src/cli/client', () => {
    const root = fakeRepo()
    const bin = join(root, 'node_modules', 'electron', 'dist', 'electron-bin')
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(root, 'out', 'cli') })
    expect(l.resolve()).toEqual({ command: bin, args: [root], source: 'dev' })
    mkdirSync(join(root, 'src', 'cli', 'client'), { recursive: true })
    const l2 = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(root, 'src', 'cli', 'client') })
    expect(l2.resolve()).toMatchObject({ source: 'dev', args: [root] })
  })

  it('reports a missing app', () => {
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(base, 'nowhere', 'a'), platform: 'linux' })
    expect(l.resolve()).toEqual({ error: APP_NOT_FOUND })
  })

  it('locate (Wave 7 contract) maps resolve(): found, absent for APP_NOT_FOUND, broken for an unbuilt checkout', () => {
    const env = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: { ORGAI_ELECTRON_PATH: '/opt/electron' } })
    expect(env.locate()).toEqual({ status: 'found', command: '/opt/electron', args: [], source: 'env' })
    const none = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(base, 'nowhere', 'a'), platform: 'linux' })
    expect(none.locate()).toEqual({ status: 'absent', message: APP_NOT_FOUND })
    const root = fakeRepo()
    rmSync(join(root, 'out', 'main', 'index.js'))
    const unbuilt = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(root, 'out', 'cli') })
    expect(unbuilt.locate()).toEqual({ status: 'broken', path: root, message: devCheckoutUnbuilt(root) })
  })

  it('a checkout without its electron binary is broken naming the checkout, never a fall-through to an installed app (review round 2)', () => {
    const root = fakeRepo()
    rmSync(join(root, 'node_modules', 'electron'), { recursive: true, force: true })
    // An installed app exists too: it must not be picked for a broken checkout.
    const realExists = (p: string): boolean => p === '/Applications/OrgAI.app' || p === '/Applications/OrgAI.app/Contents/MacOS/OrgAI' || p === '/Applications/OrgAI.app/Contents/Resources/app.asar' || existsSync(p)
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(root, 'out', 'cli'), platform: 'darwin', home: '/Users/me', exists: realExists, installInfo: { channel: 'dev', source: 'absent' } })
    expect(l.resolve()).toEqual({ error: devCheckoutNoElectron(root), path: root })
    expect(l.locate()).toEqual({ status: 'broken', path: root, message: devCheckoutNoElectron(root) })
    expect(devCheckoutNoElectron(root)).toContain('npm install')
    // The injected binary lookup is what decides (an installed electron makes it found again).
    const ok = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(root, 'out', 'cli'), platform: 'darwin', home: '/Users/me', exists: realExists, installInfo: { channel: 'dev', source: 'absent' }, electronBinary: () => '/x/electron' })
    expect(ok.locate()).toEqual({ status: 'found', command: '/x/electron', args: [root], source: 'dev' })
  })

  it('spawns detached with the flags and a cleaned environment', () => {
    const calls: { command: string; args: string[]; options: Parameters<SpawnFn>[2] }[] = []
    let unrefs = 0
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options })
      return { pid: 77, unref: () => void unrefs++ }
    }
    const E = resolve('/e') // absolute on every platform (a bare '/e' is drive-relative on Windows)
    const env = { ORGAI_ELECTRON_PATH: E, PATH: '/bin', ORGAI_SECRET_LITELLM_API_KEY: 'sk', ORGAI_SECRET_X: 'y', ELECTRON_RUN_AS_NODE: '1' }
    const l = createLauncher({ dataDir, userDataDir: '/ud', userChoseDataDir: false, env, spawn })
    expect(l.spawn({ headless: true, run: 'run_1' })).toEqual({ pid: 77 })
    expect(calls[0].command).toBe(E)
    expect(calls[0].args).toEqual(['--headless-host', '--run', 'run_1'])
    expect(calls[0].options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    expect(calls[0].options.env).toEqual({ ORGAI_ELECTRON_PATH: E, PATH: '/bin' })
    // Never the caller's cwd (review H1): the app's own folder.
    expect(calls[0].options.cwd).toBe(dirname(E))
    expect(calls[0].options.cwd).not.toBe(process.cwd())
    expect(unrefs).toBe(1)
    const chosen = createLauncher({ dataDir, userDataDir: '/ud', userChoseDataDir: true, env, spawn })
    chosen.spawn({ headless: false })
    expect(calls[1].args).toEqual([])
    expect(calls[1].options.env?.ORGAI_DATA_DIR).toBe('/ud')
    // Wave 7: spawn the app locate() found, without resolving again.
    chosen.spawn({ headless: true, app: { command: '/Applications/OrgAI.app/Contents/MacOS/OrgAI', args: [], source: 'installed' } })
    expect(calls[2].command).toBe('/Applications/OrgAI.app/Contents/MacOS/OrgAI')
    expect(calls[2].args).toEqual(['--headless-host'])
  })

  it('hostSpawnCwd is the binary folder for an absolute command, else home; never the cwd', () => {
    expect(hostSpawnCwd(join(base, 'bin', 'OrgAI'), { home: '/home/me', isDir: () => true })).toBe(join(base, 'bin'))
    expect(hostSpawnCwd(join(base, 'gone', 'OrgAI'), { home: '/home/me', isDir: () => false })).toBe('/home/me')
    expect(hostSpawnCwd('electron', { home: '/home/me', isDir: () => true })).toBe('/home/me')
    expect(hostSpawnCwd('./electron', { home: '/home/me', isDir: () => true })).toBe('/home/me')
  })

  it('hostSpawnEnv drops an inherited ORGAI_DATA_DIR unless chosen', () => {
    expect(hostSpawnEnv({ ORGAI_DATA_DIR: '/x' }, { userDataDir: '/y', userChoseDataDir: false })).toEqual({})
    expect(hostSpawnEnv({ ORGAI_DATA_DIR: '/x' }, { userDataDir: '/y', userChoseDataDir: true })).toEqual({ ORGAI_DATA_DIR: '/y' })
  })

  it('waitForReady waits for a ready, live, different host', async () => {
    let t = 0
    const live = new Set([4242])
    const l = createLauncher({
      dataDir,
      userDataDir: '',
      userChoseDataDir: false,
      env: {},
      isLive: (pid) => live.has(pid),
      now: () => t,
      sleep: async (ms) => {
        t += ms
        if (t >= 300) daemon('bbbbbbbbbbbb', 'starting')
        if (t >= 600) daemon('bbbbbbbbbbbb', 'ready')
      }
    })
    daemon('aaaaaaaaaaaa')
    const d = await l.waitForReady({ timeoutMs: 2000, notInstanceId: 'aaaaaaaaaaaa' })
    expect(d?.hostInstanceId).toBe('bbbbbbbbbbbb')
    expect(t).toBeGreaterThanOrEqual(600)
    t = 0
    expect(await l.waitForReady({ timeoutMs: 400, notInstanceId: 'bbbbbbbbbbbb' })).toBeNull()
  })

  it('waitForReady filters by host kind (an inproc host never counts as the app being ready)', async () => {
    let t = 0
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, isLive: () => true, now: () => t, sleep: async (ms) => void (t += ms) })
    writeFileSync(join(dataDir, 'run', 'daemon.json'), JSON.stringify({ hostInstanceId: 'aaaaaaaaaaaa', pid: 1, endpoint: '/x', state: 'ready', startedAt: 1, hostKind: 'inproc' }))
    expect(await l.waitForReady({ timeoutMs: 300, hostKinds: ['desktop', 'headless-host'] })).toBeNull()
    expect((await l.waitForReady({ timeoutMs: 300 }))?.hostKind).toBe('inproc')
    expect(l.current()?.hostKind).toBe('inproc')
  })

  it('a spawn error or a non-zero exit of the spawned app fails waitForReady at once; exit 0 (a hand-off) does not (review M)', async () => {
    const children: EventEmitter[] = []
    const spawn: SpawnFn = () => {
      const c = Object.assign(new EventEmitter(), { pid: 77, unref: () => undefined })
      children.push(c)
      return c
    }
    let t = 0
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: { ORGAI_ELECTRON_PATH: '/nope' }, spawn, isLive: () => true, now: () => t, sleep: async (ms) => void (t += ms) })
    // The 'error' event has a listener (an unheard one would throw), and waitForReady rejects with it.
    l.spawn({ headless: true })
    expect(() => children[0].emit('error', new Error('spawn /nope ENOENT'))).not.toThrow()
    await expect(l.waitForReady({ timeoutMs: 5000 })).rejects.toThrow('spawn /nope ENOENT')
    expect(t).toBe(0)
    // Exit 6: another host owns the data folder.
    l.spawn({ headless: true })
    children[1].emit('exit', 6, null)
    await expect(l.waitForReady({ timeoutMs: 5000 })).rejects.toThrow(/code 6/)
    // Exit 0 hands off to a running OrgAI: keep waiting for it.
    l.spawn({ headless: false })
    children[2].emit('exit', 0, null)
    t = 0
    expect(await l.waitForReady({ timeoutMs: 300 })).toBeNull()
    expect(t).toBeGreaterThanOrEqual(300)
  })

  it('the default spawn hears the error of a missing command (no uncaught exception)', async () => {
    let t = 0
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: { ORGAI_ELECTRON_PATH: join(base, 'no-such-electron') }, isLive: () => true, now: () => t, sleep: async (ms) => {
      t += ms
      await new Promise((r) => setTimeout(r, 5))
    } })
    l.spawn({ headless: true })
    await expect(l.waitForReady({ timeoutMs: 10_000 })).rejects.toThrow(/ENOENT/)
  })

  it('waitForGone: missing file, dead pid or another instance', async () => {
    let t = 0
    let alive = true
    const l = createLauncher({
      dataDir,
      userDataDir: '',
      userChoseDataDir: false,
      env: {},
      isLive: () => alive,
      now: () => t,
      sleep: async (ms) => void (t += ms)
    })
    expect(await l.waitForGone({ timeoutMs: 100 })).toBe(true)
    daemon('aaaaaaaaaaaa')
    expect(await l.waitForGone({ timeoutMs: 300, hostInstanceId: 'aaaaaaaaaaaa' })).toBe(false)
    expect(await l.waitForGone({ timeoutMs: 300, hostInstanceId: 'cccccccccccc' })).toBe(true)
    alive = false
    expect(await l.waitForGone({ timeoutMs: 300, hostInstanceId: 'aaaaaaaaaaaa' })).toBe(true)
  })
})

describe('launcher: startBackground (Wave 7, cli-standalone.md 4.2)', () => {
  it("'node' spawns execPath <orgai.mjs> daemon run-node detached, stdio to <userDataDir>/logs/node-host.log", () => {
    const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = []
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options: options as Record<string, unknown> })
      return { pid: 91, unref() {} }
    }
    const userDataDir = join(base, 'ud')
    // Host-platform absolute paths (a POSIX literal is not absolute on Windows, where the spawn cwd is the exe's folder).
    // A real folder: the host's cwd is the binary's own folder only when that folder exists (else the home folder).
    const nodeExe = join(base, 'nodebin', 'node')
    mkdirSync(dirname(nodeExe), { recursive: true })
    writeFileSync(nodeExe, '')
    const entry = resolve('/pkg/out/cli/orgai.mjs')
    const env = { PATH: '/bin', ORGAI_SECRET_X: 'nope', ELECTRON_RUN_AS_NODE: '1', ORGAI_DAEMON_IDLE_MINUTES: '5' }
    const l = createLauncher({ dataDir, userDataDir, userChoseDataDir: true, env, spawn, runtime: { execPath: nodeExe }, cliEntry: entry })
    expect(l.startBackground!('node')).toEqual({ pid: 91, hostKinds: ['node'] })
    expect(calls[0].command).toBe(nodeExe)
    expect(calls[0].args).toEqual([entry, 'daemon', 'run-node'])
    const o = calls[0].options
    expect(o.detached).toBe(true)
    expect(o.windowsHide).toBe(true)
    expect(o.shell).toBe(false)
    const stdio = o.stdio as unknown[]
    expect(stdio[0]).toBe('ignore')
    expect(typeof stdio[1]).toBe('number')
    expect(stdio[2]).toBe(stdio[1])
    const log = join(userDataDir, 'logs', 'node-host.log')
    expect(existsSync(log)).toBe(true)
    if (process.platform !== 'win32') expect(statSync(log).mode & 0o777).toBe(0o600)
    // The host environment: no secrets, no ELECTRON_RUN_AS_NODE, the chosen data folder, the idle setting kept.
    expect(o.env).toEqual({ PATH: '/bin', ORGAI_DAEMON_IDLE_MINUTES: '5', ORGAI_DATA_DIR: userDataDir })
    expect(o.cwd).toBe(dirname(nodeExe))
  })

  it("'node' refuses on Electron (no real Node) and without a bundle", () => {
    const spawn: SpawnFn = () => ({ pid: 1, unref() {} })
    const onElectron = createLauncher({ dataDir, userDataDir: base, userChoseDataDir: false, env: {}, spawn, runtime: { execPath: '/OrgAI', electron: '40.0.0' }, cliEntry: '/x/orgai.mjs' })
    expect(() => onElectron.startBackground!('node')).toThrow(NODE_HOST_NEEDS_NODE)
    const noBundle = createLauncher({ dataDir, userDataDir: base, userChoseDataDir: false, env: {}, spawn, runtime: { execPath: '/node' }, bundleDir: join(base, 'nowhere') })
    expect(() => noBundle.startBackground!('node')).toThrow(/orgai\.mjs\) was not found/)
  })

  it("'app' spawns the app headless and waits for the Electron kinds", () => {
    const calls: { command: string; args: string[] }[] = []
    const spawn: SpawnFn = (command, args) => {
      calls.push({ command, args })
      return { pid: 5, unref() {} }
    }
    const electron = resolve('/opt/e')
    const appRoot = resolve('/opt/app')
    const l = createLauncher({ dataDir, userDataDir: base, userChoseDataDir: false, env: { ORGAI_ELECTRON_PATH: electron, ORGAI_APP_ROOT: appRoot }, spawn })
    expect(l.startBackground!('app')).toEqual({ pid: 5, hostKinds: ['headless-host', 'desktop'] })
    expect(calls[0]).toEqual({ command: electron, args: [appRoot, '--headless-host'] })
  })

  it('a background host that exits before it is ready fails waitForReady with its exit code', async () => {
    const children: EventEmitter[] = []
    const spawn: SpawnFn = () => {
      const c = Object.assign(new EventEmitter(), { pid: 3, unref() {} })
      children.push(c)
      return c
    }
    let t = 0
    const l = createLauncher({ dataDir, userDataDir: base, userChoseDataDir: false, env: {}, spawn, runtime: { execPath: '/node' }, cliEntry: '/x/orgai.mjs', isLive: () => true, now: () => t, sleep: async (ms) => void (t += ms) })
    l.startBackground!('node')
    children[0].emit('exit', 1, null)
    await expect(l.waitForReady({ timeoutMs: 5000, hostKinds: ['node'] })).rejects.toThrow('OrgAI exited (code 1)')
  })

  it('a background host that lost the data folder exits 0 (a hand-off): wait for the winner, fail at once for a ready host of another kind (review round 1)', async () => {
    const children: EventEmitter[] = []
    const spawn: SpawnFn = () => {
      const c = Object.assign(new EventEmitter(), { pid: 3, unref() {} })
      children.push(c)
      return c
    }
    let t = 0
    const l = createLauncher({
      dataDir,
      userDataDir: base,
      userChoseDataDir: false,
      env: {},
      spawn,
      runtime: { execPath: '/node' },
      cliEntry: '/x/orgai.mjs',
      isLive: () => true,
      now: () => t,
      sleep: async (ms) => {
        t += ms
        // The winner (another Node host) becomes ready a moment later.
        if (t >= 300) writeFileSync(join(dataDir, 'run', 'daemon.json'), JSON.stringify({ hostInstanceId: 'dddddddddddd', pid: 9, endpoint: '/x', state: 'ready', startedAt: 1, hostKind: 'node' }))
      }
    })
    writeFileSync(join(dataDir, 'run', 'daemon.json'), JSON.stringify({ hostInstanceId: 'dddddddddddd', pid: 9, endpoint: '/x', state: 'starting', startedAt: 1, hostKind: 'node' }))
    l.startBackground!('node')
    children[0].emit('exit', 0, null)
    expect((await l.waitForReady({ timeoutMs: 5000, hostKinds: ['node'] }))?.hostInstanceId).toBe('dddddddddddd')
    // The folder went to a ready app host instead: no Node host will come, so say so now (not at the timeout).
    writeFileSync(join(dataDir, 'run', 'daemon.json'), JSON.stringify({ hostInstanceId: 'eeeeeeeeeeee', pid: 10, endpoint: '/x', state: 'ready', startedAt: 1, hostKind: 'desktop' }))
    const m = createLauncher({ dataDir, userDataDir: base, userChoseDataDir: false, env: {}, spawn, runtime: { execPath: '/node' }, cliEntry: '/x/orgai.mjs', isLive: () => true, now: () => 0, sleep: async () => undefined })
    m.startBackground!('node')
    children[1].emit('exit', 0, null)
    await expect(m.waitForReady({ timeoutMs: 5000, hostKinds: ['node'] })).rejects.toThrow('Another OrgAI host (desktop, pid 10) took this data folder first.')
    // A HostTakenError carrying the winner, so a starter can report it as running (review round 2).
    const err = await m.waitForReady({ timeoutMs: 5000, hostKinds: ['node'] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HostTakenError)
    expect((err as HostTakenError).info).toMatchObject({ hostInstanceId: 'eeeeeeeeeeee', hostKind: 'desktop', pid: 10 })
  })

  it('checkBackground names why startBackground would throw, without spawning (review round 2)', () => {
    let spawned = 0
    const spawn: SpawnFn = () => (spawned++, { pid: 1, unref() {} })
    const mk = (extra: Partial<Parameters<typeof createLauncher>[0]>) => createLauncher({ dataDir, userDataDir: base, userChoseDataDir: false, env: {}, spawn, ...extra })
    expect(mk({ runtime: { execPath: '/OrgAI', electron: '40.0.0' }, cliEntry: '/x/orgai.mjs' }).checkBackground!('node')).toBe(NODE_HOST_NEEDS_NODE)
    expect(mk({ runtime: { execPath: '/node' }, bundleDir: join(base, 'nowhere') }).checkBackground!('node')).toBe(NODE_HOST_BUNDLE_MISSING)
    expect(mk({ runtime: { execPath: '/node' }, cliEntry: '/x/orgai.mjs' }).checkBackground!('node')).toBeUndefined()
    expect(mk({ bundleDir: join(base, 'nowhere') }).checkBackground!('app')).toBe(APP_NOT_FOUND)
    expect(mk({ env: { ORGAI_ELECTRON_PATH: '/opt/e' } }).checkBackground!('app')).toBeUndefined()
    expect(spawned).toBe(0)
  })

  it('node-host.log is never rotated while a live host owns the data folder (review round 2)', () => {
    const userDataDir = join(base, 'ud')
    const logs = join(userDataDir, 'logs')
    mkdirSync(logs, { recursive: true })
    const log = join(logs, 'node-host.log')
    const old = join(logs, 'node-host.old.log')
    writeFileSync(log, Buffer.alloc(NODE_HOST_LOG_MAX_BYTES + 1))
    // The winner of a start race (or a host still starting) has node-host.log open.
    writeFileSync(join(dataDir, 'run', 'daemon.json'), JSON.stringify({ hostInstanceId: 'dddddddddddd', pid: 9, endpoint: '/x', state: 'starting', startedAt: 1, hostKind: 'node' }))
    let live = true
    const l = createLauncher({ dataDir, userDataDir, userChoseDataDir: false, env: {}, spawn: () => ({ pid: 1, unref() {} }), runtime: { execPath: '/node' }, cliEntry: '/x/orgai.mjs', isLive: () => live })
    l.startBackground!('node')
    expect(existsSync(old)).toBe(false)
    expect(statSync(log).size).toBe(NODE_HOST_LOG_MAX_BYTES + 1)
    // Once that host is gone, the next start rotates.
    live = false
    l.startBackground!('node')
    expect(statSync(old).size).toBe(NODE_HOST_LOG_MAX_BYTES + 1)
    expect(statSync(log).size).toBe(0)
  })

  it('node-host.log is moved to node-host.old.log past the size cap before a start (review round 1)', () => {
    const logs = join(base, 'ud', 'logs')
    mkdirSync(logs, { recursive: true })
    const log = join(logs, 'node-host.log')
    const old = join(logs, 'node-host.old.log')
    writeFileSync(log, 'x'.repeat(10))
    expect(rotateNodeHostLog(logs, 10)).toBe(false)
    writeFileSync(log, 'y'.repeat(11))
    writeFileSync(old, 'older')
    expect(rotateNodeHostLog(logs, 10)).toBe(true)
    expect(existsSync(log)).toBe(false)
    expect(readFileSync(old, 'utf8')).toBe('y'.repeat(11))
    expect(rotateNodeHostLog(join(base, 'missing'))).toBe(false)
    expect(NODE_HOST_LOG_MAX_BYTES).toBe(5 * 1024 * 1024)
    // startBackground rotates first, then appends to a fresh file.
    writeFileSync(log, Buffer.alloc(NODE_HOST_LOG_MAX_BYTES + 1))
    const l = createLauncher({ dataDir, userDataDir: join(base, 'ud'), userChoseDataDir: false, env: {}, spawn: () => ({ pid: 1, unref() {} }), runtime: { execPath: '/node' }, cliEntry: '/x/orgai.mjs' })
    l.startBackground!('node')
    expect(statSync(old).size).toBe(NODE_HOST_LOG_MAX_BYTES + 1)
    expect(statSync(log).size).toBe(0)
  })

  it('cliBundleEntry: the bundle folder, else a dev checkout build, else undefined', () => {
    const root = fakeRepo()
    writeFileSync(join(root, 'out', 'cli', 'orgai.mjs'), '')
    expect(cliBundleEntry(join(root, 'out', 'cli'))).toBe(join(root, 'out', 'cli', 'orgai.mjs'))
    mkdirSync(join(root, 'src', 'cli', 'client'), { recursive: true })
    expect(cliBundleEntry(join(root, 'src', 'cli', 'client'))).toBe(join(root, 'out', 'cli', 'orgai.mjs'))
    expect(cliBundleEntry(join(base, 'elsewhere'))).toBeUndefined()
  })
})

describe('launcher: packaged app (cli-spec 7, Wave 6)', () => {
  /**
   * A fake packaged app: Contents/{MacOS/OrgAI, Resources/app.asar.unpacked/out/cli} (or the host platform's layout),
   * with the install.json the app builder writes (channel 'app') unless `channel` says otherwise (null: no file).
   */
  function fakeApp(withBinary = true, channel: string | null = 'app', withAsar = true): { bundleDir: string; binary: string; asar: string } {
    const resources = join(base, 'Apps', 'OrgAI.app', 'Contents', 'Resources')
    const bundleDir = join(resources, 'app.asar.unpacked', 'out', 'cli')
    mkdirSync(bundleDir, { recursive: true })
    if (channel !== null) writeFileSync(join(bundleDir, 'install.json'), JSON.stringify({ channel, version: '0.2.0' }))
    // The app binary of the host platform's layout (MacOS/OrgAI, OrgAI.exe or orgai): the layout code is per platform.
    const binary = packagedLayout(PLAT, resources).appBinary
    mkdirSync(dirname(binary), { recursive: true })
    if (withBinary) writeFileSync(binary, '')
    const asar = join(resources, 'app.asar')
    if (withAsar) writeFileSync(asar, '')
    return { bundleDir, binary, asar }
  }

  it('resolves the app binary next to a packaged bundle, with no arguments', () => {
    const { bundleDir, binary } = fakeApp()
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: PLAT, runtime: { execPath: '/usr/bin/node' } })
    expect(l.resolve()).toEqual({ command: binary, args: [], source: 'packaged' })
  })

  it('prefers the running binary under Electron when it is the layout app binary (compared real-path-wise)', () => {
    const { bundleDir, binary } = fakeApp()
    // A linked folder (a junction on Windows needs no privilege, a file symlink does) holding the binary's name.
    const linkDir = join(base, 'OrgAI-link')
    symlinkSync(dirname(binary), linkDir, 'junction')
    const link = join(linkDir, basename(binary))
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: PLAT, runtime: { execPath: link, electron: '45.1.0' } })
    expect(l.resolve()).toEqual({ command: link, args: [], source: 'packaged' })
    // Another Electron (not this app's binary) does not count; the layout binary is used.
    const other = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: PLAT, runtime: { execPath: '/opt/electron', electron: '45.1.0' } })
    expect(other.resolve()).toEqual({ command: binary, args: [], source: 'packaged' })
  })

  it('a missing app binary is an error naming it (never a fall-through to dev)', () => {
    const { bundleDir, binary } = fakeApp(false)
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: PLAT, runtime: { execPath: '/usr/bin/node' } })
    const r = l.resolve()
    expect(r).toEqual({ error: packagedAppMissing(binary), path: binary })
    expect('error' in r && r.error).toContain('reinstall OrgAI or set ORGAI_ELECTRON_PATH')
    // Wave 7: locate() reports it broken with the binary's path, never absent (which would fall back to inproc).
    expect(l.locate()).toEqual({ status: 'broken', path: binary, message: packagedAppMissing(binary) })
  })

  it('ORGAI_ELECTRON_PATH still wins over the packaged app', () => {
    const { bundleDir } = fakeApp()
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: { ORGAI_ELECTRON_PATH: '/e' }, bundleDir, platform: PLAT })
    expect(l.resolve()).toEqual({ command: '/e', args: [], source: 'env' })
  })

  it('a dev checkout is unchanged (its out/cli is not a packaged layout)', () => {
    const root = fakeRepo()
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(root, 'out', 'cli'), platform: PLAT, runtime: { execPath: '/x', electron: '45.1.0' } })
    expect(l.resolve()).toMatchObject({ source: 'dev', args: [root] })
  })

  it('a missing app.asar is broken naming it, even under the running app binary (4.1 step 3; review round 1)', () => {
    const { bundleDir, binary, asar } = fakeApp(true, 'app', false)
    for (const runtime of [{ execPath: '/usr/bin/node' }, { execPath: binary, electron: '45.1.0' }]) {
      const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: PLAT, runtime })
      expect(l.resolve()).toEqual({ error: packagedAppMissing(asar), path: asar })
      expect(l.locate()).toEqual({ status: 'broken', path: asar, message: packagedAppMissing(asar) })
    }
  })

  it('no install.json: the packaged layout still counts (only an app has that path shape; until WP-A writes the file)', () => {
    const { bundleDir, binary } = fakeApp(true, null)
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: PLAT, runtime: { execPath: '/usr/bin/node' } })
    expect(l.resolve()).toEqual({ command: binary, args: [], source: 'packaged' })
    expect(l.locate()).toMatchObject({ status: 'found', source: 'packaged' })
    // An unreadable install.json never takes it.
    const bad = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: 'linux', installInfo: { channel: 'dev', source: 'invalid', problem: 'x' } })
    expect(bad.locate().status).toBe('absent')
  })

  it('the packaged layout is never used when install.json names another channel (Wave 7, 4.1 step 3)', () => {
    for (const channel of ['npm', 'archive']) {
      rmSync(join(base, 'Apps'), { recursive: true, force: true })
      const { bundleDir } = fakeApp(true, channel)
      const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: 'linux', runtime: { execPath: '/usr/bin/node' } })
      expect(l.resolve()).toEqual({ error: APP_NOT_FOUND })
      expect(l.locate()).toEqual({ status: 'absent', message: APP_NOT_FOUND })
    }
    // A missing binary is not 'broken' either when install.json does not claim the layout.
    rmSync(join(base, 'Apps'), { recursive: true, force: true })
    const { bundleDir } = fakeApp(false, 'npm')
    expect(createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: 'linux' }).locate().status).toBe('absent')
  })

  it('the packaged spawn never passes ELECTRON_RUN_AS_NODE on', () => {
    const { bundleDir, binary } = fakeApp()
    const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = []
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, env: options.env })
      return { pid: 1, unref: () => undefined }
    }
    const env = { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env, bundleDir, platform: PLAT, runtime: { execPath: binary, electron: '45.1.0' }, spawn })
    l.spawn({ headless: true })
    expect(calls[0]).toEqual({ command: binary, args: ['--headless-host'], env: { PATH: '/bin' } })
    expect(hostSpawnEnv({ ELECTRON_RUN_AS_NODE: '1' }, { userDataDir: '', userChoseDataDir: false })).toEqual({})
  })
})

describe('launcher: dev checkout rule (Wave 7, 4.1 step 3)', () => {
  it('needs electron.vite.config.ts and electron in devDependencies; an npm package folder is never a checkout', () => {
    const root = fakeRepo()
    expect(isOrgAICheckout(root)).toBe(true)
    expect(devAppRoot(join(root, 'out', 'cli'))).toBe(root)
    rmSync(join(root, CHECKOUT_MARKER))
    expect(isOrgAICheckout(root)).toBe(false)
    expect(devAppRoot(join(root, 'out', 'cli'))).toBeUndefined()
    writeFileSync(join(root, CHECKOUT_MARKER), '')
    // The npm package: name orgai, electron only as a dependency (or not at all).
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'orgai', dependencies: { electron: '45.1.0' } }))
    expect(isOrgAICheckout(root)).toBe(false)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'other', devDependencies: { electron: '45.1.0' } }))
    expect(isOrgAICheckout(root)).toBe(false)
    // Even with both markers, a root inside node_modules is an installed package.
    const pkg = fakeRepo(join(base, 'g', 'lib', 'node_modules', 'orgai'))
    expect(isOrgAICheckout(pkg)).toBe(false)
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(pkg, 'out', 'cli'), platform: 'linux', installInfo: { channel: 'dev', source: 'absent' } })
    expect(l.locate()).toEqual({ status: 'absent', message: APP_NOT_FOUND })
  })

  it('is used only when install.json is absent: a written or unreadable one never makes a checkout', () => {
    const root = fakeRepo()
    const bundleDir = join(root, 'out', 'cli')
    const mk = (info?: Parameters<typeof createLauncher>[0]['installInfo']) =>
      createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: 'linux', ...(info ? { installInfo: info } : {}) })
    expect(mk().resolve()).toMatchObject({ source: 'dev', args: [root] })
    expect(mk({ channel: 'npm', source: 'file' }).resolve()).toEqual({ error: APP_NOT_FOUND })
    expect(mk({ channel: 'dev', source: 'invalid', problem: 'install.json is not JSON' }).resolve()).toEqual({ error: APP_NOT_FOUND })
    // The real reader: an install.json next to the bundle switches the checkout off.
    writeFileSync(join(bundleDir, 'install.json'), JSON.stringify({ channel: 'npm', version: '0.2.0' }))
    expect(mk().resolve()).toEqual({ error: APP_NOT_FOUND })
    writeFileSync(join(bundleDir, 'install.json'), '{not json')
    expect(mk().resolve()).toEqual({ error: APP_NOT_FOUND })
  })
})

describe('launcher: installed app discovery (Wave 7, 4.1 step 3)', () => {
  const MAC_SYS = '/Applications/OrgAI.app'
  const MAC_USER = '/Users/me/Applications/OrgAI.app'
  const macFiles = (root: string): string[] => [root, `${root}/Contents/MacOS/OrgAI`, `${root}/Contents/Resources/app.asar`]
  const has = (files: string[]) => (p: string): boolean => files.includes(p)

  it('candidates per platform: macOS /Applications then ~/Applications, Windows LOCALAPPDATA then ProgramFiles, Linux none', () => {
    expect(installedAppCandidates('darwin', {}, '/Users/me')).toEqual([
      { root: MAC_SYS, binary: `${MAC_SYS}/Contents/MacOS/OrgAI`, asar: `${MAC_SYS}/Contents/Resources/app.asar` },
      { root: MAC_USER, binary: `${MAC_USER}/Contents/MacOS/OrgAI`, asar: `${MAC_USER}/Contents/Resources/app.asar` }
    ])
    expect(installedAppCandidates('darwin', {}, '')).toHaveLength(1)
    const win = installedAppCandidates('win32', { localappdata: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, 'C:\\Users\\me')
    expect(win).toEqual([
      { root: 'C:\\Users\\me\\AppData\\Local\\Programs\\OrgAI', binary: 'C:\\Users\\me\\AppData\\Local\\Programs\\OrgAI\\OrgAI.exe', asar: 'C:\\Users\\me\\AppData\\Local\\Programs\\OrgAI\\resources\\app.asar' },
      { root: 'C:\\Program Files\\OrgAI', binary: 'C:\\Program Files\\OrgAI\\OrgAI.exe', asar: 'C:\\Program Files\\OrgAI\\resources\\app.asar' }
    ])
    // A relative or empty variable is ignored.
    expect(installedAppCandidates('win32', { LOCALAPPDATA: 'relative', ProgramFiles: '' }, '')).toEqual([])
    expect(installedAppCandidates('linux', { HOME: '/home/me' }, '/home/me')).toEqual([])
  })

  it('found, broken (naming the missing path) and absent', () => {
    const c = installedAppCandidates('darwin', {}, '/Users/me')
    expect(discoverInstalledApp(c, has(macFiles(MAC_SYS)))).toEqual({ command: `${MAC_SYS}/Contents/MacOS/OrgAI`, args: [], source: 'installed' })
    expect(discoverInstalledApp(c, has(macFiles(MAC_USER)))).toEqual({ command: `${MAC_USER}/Contents/MacOS/OrgAI`, args: [], source: 'installed' })
    expect(discoverInstalledApp(c, has([MAC_SYS, `${MAC_SYS}/Contents/Resources/app.asar`]))).toEqual({
      error: installedAppBroken(MAC_SYS, `${MAC_SYS}/Contents/MacOS/OrgAI`),
      path: `${MAC_SYS}/Contents/MacOS/OrgAI`
    })
    expect(discoverInstalledApp(c, has([MAC_SYS, `${MAC_SYS}/Contents/MacOS/OrgAI`]))).toMatchObject({ path: `${MAC_SYS}/Contents/Resources/app.asar` })
    // A broken /Applications copy does not hide a complete ~/Applications one.
    expect(discoverInstalledApp(c, has([MAC_SYS, ...macFiles(MAC_USER)]))).toMatchObject({ source: 'installed', command: `${MAC_USER}/Contents/MacOS/OrgAI` })
    expect(discoverInstalledApp(c, has([]))).toBeUndefined()
  })

  it('locate() reports an installed app as found (source installed) and an incomplete one as broken, after env and checkout', () => {
    const mk = (files: string[], env: NodeJS.ProcessEnv = {}) =>
      createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env, bundleDir: join(base, 'npm', 'out', 'cli'), platform: 'darwin', home: '/Users/me', exists: has(files), installInfo: { channel: 'npm', source: 'file' } })
    expect(mk(macFiles(MAC_SYS)).locate()).toEqual({ status: 'found', command: `${MAC_SYS}/Contents/MacOS/OrgAI`, args: [], source: 'installed' })
    expect(mk([MAC_SYS]).locate()).toEqual({ status: 'broken', path: `${MAC_SYS}/Contents/MacOS/OrgAI`, message: installedAppBroken(MAC_SYS, `${MAC_SYS}/Contents/MacOS/OrgAI`) })
    expect(mk([]).locate()).toEqual({ status: 'absent', message: APP_NOT_FOUND })
    expect(mk(macFiles(MAC_SYS), { ORGAI_ELECTRON_PATH: '/e' }).locate()).toMatchObject({ status: 'found', source: 'env' })
    // Windows through the env, case-insensitively.
    const w = createLauncher({
      dataDir,
      userDataDir: '',
      userChoseDataDir: false,
      env: { programfiles: 'C:\\Program Files' },
      bundleDir: join(base, 'npm', 'out', 'cli'),
      platform: 'win32',
      home: 'C:\\Users\\me',
      exists: has(['C:\\Program Files\\OrgAI', 'C:\\Program Files\\OrgAI\\OrgAI.exe', 'C:\\Program Files\\OrgAI\\resources\\app.asar']),
      installInfo: { channel: 'npm', source: 'file' }
    })
    expect(w.locate()).toEqual({ status: 'found', command: 'C:\\Program Files\\OrgAI\\OrgAI.exe', args: [], source: 'installed' })
  })

  it('a dev checkout wins over an installed app', () => {
    const root = fakeRepo()
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(root, 'out', 'cli'), platform: 'darwin', home: '/Users/me', exists: (p) => macFiles(MAC_SYS).includes(p) || existsSync(p) })
    expect(l.resolve()).toMatchObject({ source: 'dev' })
  })
})
