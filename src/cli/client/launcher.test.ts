import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_NOT_FOUND, createLauncher, hostSpawnEnv, type SpawnFn } from './launcher'

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
    expect(unrefs).toBe(1)
    const chosen = createLauncher({ dataDir, userDataDir: '/ud', userChoseDataDir: true, env, spawn })
    chosen.spawn({ headless: false })
    expect(calls[1].args).toEqual([])
    expect(calls[1].options.env?.ORGAI_DATA_DIR).toBe('/ud')
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
