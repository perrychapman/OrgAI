import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_NOT_FOUND, createLauncher, hostSpawnCwd, hostSpawnEnv, packagedAppMissing, type SpawnFn } from './launcher'

let base: string
let dataDir: string
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'lch-')))
  dataDir = join(base, 'ud', 'data')
  mkdirSync(join(dataDir, 'run'), { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** A fake dev checkout: package.json name orgai, out/main and out/cli, an installed electron package. */
function fakeRepo(): string {
  const root = join(base, 'repo')
  mkdirSync(join(root, 'out', 'main'), { recursive: true })
  mkdirSync(join(root, 'out', 'cli'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'orgai' }))
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
    expect(l.resolve()).toEqual({ command: '/opt/electron', args: ['/opt/app'], source: 'env' })
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
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(base, 'nowhere', 'a') })
    expect(l.resolve()).toEqual({ error: APP_NOT_FOUND })
  })

  it('locate (Wave 7 contract) maps resolve(): found, absent for APP_NOT_FOUND, broken for an unbuilt checkout', () => {
    const env = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: { ORGAI_ELECTRON_PATH: '/opt/electron' } })
    expect(env.locate()).toEqual({ status: 'found', command: '/opt/electron', args: [], source: 'env' })
    const none = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(base, 'nowhere', 'a') })
    expect(none.locate()).toEqual({ status: 'absent', message: APP_NOT_FOUND })
    const root = fakeRepo()
    rmSync(join(root, 'out', 'main', 'index.js'))
    const unbuilt = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(root, 'out', 'cli') })
    expect(unbuilt.locate()).toMatchObject({ status: 'broken', path: root })
  })

  it('spawns detached with the flags and a cleaned environment', () => {
    const calls: { command: string; args: string[]; options: Parameters<SpawnFn>[2] }[] = []
    let unrefs = 0
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options })
      return { pid: 77, unref: () => void unrefs++ }
    }
    const env = { ORGAI_ELECTRON_PATH: '/e', PATH: '/bin', ORGAI_SECRET_LITELLM_API_KEY: 'sk', ORGAI_SECRET_X: 'y', ELECTRON_RUN_AS_NODE: '1' }
    const l = createLauncher({ dataDir, userDataDir: '/ud', userChoseDataDir: false, env, spawn })
    expect(l.spawn({ headless: true, run: 'run_1' })).toEqual({ pid: 77 })
    expect(calls[0].command).toBe('/e')
    expect(calls[0].args).toEqual(['--headless-host', '--run', 'run_1'])
    expect(calls[0].options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    expect(calls[0].options.env).toEqual({ ORGAI_ELECTRON_PATH: '/e', PATH: '/bin' })
    // Never the caller's cwd (review H1): the app's own folder.
    expect(calls[0].options.cwd).toBe(dirname(resolve('/e')))
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

describe('launcher: packaged app (cli-spec 7, Wave 6)', () => {
  /** A fake macOS bundle: OrgAI.app/Contents/{MacOS/OrgAI, Resources/app.asar.unpacked/out/cli}. */
  function fakeApp(withBinary = true): { bundleDir: string; binary: string } {
    const contents = join(base, 'Apps', 'OrgAI.app', 'Contents')
    const bundleDir = join(contents, 'Resources', 'app.asar.unpacked', 'out', 'cli')
    mkdirSync(bundleDir, { recursive: true })
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    const binary = join(contents, 'MacOS', 'OrgAI')
    if (withBinary) writeFileSync(binary, '')
    return { bundleDir, binary }
  }

  it('resolves the app binary next to a packaged bundle, with no arguments', () => {
    const { bundleDir, binary } = fakeApp()
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: 'darwin', runtime: { execPath: '/usr/bin/node' } })
    expect(l.resolve()).toEqual({ command: binary, args: [], source: 'packaged' })
  })

  it('prefers the running binary under Electron when it is the layout app binary (compared real-path-wise)', () => {
    const { bundleDir, binary } = fakeApp()
    const link = join(base, 'OrgAI-link')
    symlinkSync(binary, link)
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: 'darwin', runtime: { execPath: link, electron: '45.1.0' } })
    expect(l.resolve()).toEqual({ command: link, args: [], source: 'packaged' })
    // Another Electron (not this app's binary) does not count; the layout binary is used.
    const other = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: 'darwin', runtime: { execPath: '/opt/electron', electron: '45.1.0' } })
    expect(other.resolve()).toEqual({ command: binary, args: [], source: 'packaged' })
  })

  it('a missing app binary is an error naming it (never a fall-through to dev)', () => {
    const { bundleDir, binary } = fakeApp(false)
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir, platform: 'darwin', runtime: { execPath: '/usr/bin/node' } })
    const r = l.resolve()
    expect(r).toEqual({ error: packagedAppMissing(binary), path: binary })
    expect('error' in r && r.error).toContain('reinstall OrgAI or set ORGAI_ELECTRON_PATH')
    // Wave 7: locate() reports it broken with the binary's path, never absent (which would fall back to inproc).
    expect(l.locate()).toEqual({ status: 'broken', path: binary, message: packagedAppMissing(binary) })
  })

  it('ORGAI_ELECTRON_PATH still wins over the packaged app', () => {
    const { bundleDir } = fakeApp()
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: { ORGAI_ELECTRON_PATH: '/e' }, bundleDir, platform: 'darwin' })
    expect(l.resolve()).toEqual({ command: '/e', args: [], source: 'env' })
  })

  it('a dev checkout is unchanged (its out/cli is not a packaged layout)', () => {
    const root = fakeRepo()
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env: {}, bundleDir: join(root, 'out', 'cli'), platform: 'darwin', runtime: { execPath: '/x', electron: '45.1.0' } })
    expect(l.resolve()).toMatchObject({ source: 'dev', args: [root] })
  })

  it('the packaged spawn never passes ELECTRON_RUN_AS_NODE on', () => {
    const { bundleDir, binary } = fakeApp()
    const calls: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = []
    const spawn: SpawnFn = (command, args, options) => {
      calls.push({ command, args, env: options.env })
      return { pid: 1, unref: () => undefined }
    }
    const env = { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }
    const l = createLauncher({ dataDir, userDataDir: '', userChoseDataDir: false, env, bundleDir, platform: 'darwin', runtime: { execPath: binary, electron: '45.1.0' }, spawn })
    l.spawn({ headless: true })
    expect(calls[0]).toEqual({ command: binary, args: ['--headless-host'], env: { PATH: '/bin' } })
    expect(hostSpawnEnv({ ELECTRON_RUN_AS_NODE: '1' }, { userDataDir: '', userChoseDataDir: false })).toEqual({})
  })
})
