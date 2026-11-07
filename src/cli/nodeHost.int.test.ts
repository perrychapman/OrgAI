/**
 * The detached Node host as a real process (Wave 7, cli-standalone.md 4.2): HostLauncher.startBackground('node') spawns
 * `node out/cli/orgai.mjs daemon run-node`, the test talks to it over its socket, then stops it (host.stop) or lets the
 * idle exit end it, and checks the process is gone and the data folder released. Mock adapter only, no tokens.
 *
 * Needs the built bundle (`npm run build`): skipped when out/cli/orgai.mjs is missing, because `npm test` runs before the
 * build in CI. CI runs this file again after the build with ORGAI_REQUIRE_NODE_HOST_INT=1, which turns a missing bundle
 * into a failure instead of a skip. A stale bundle tests the old code. POSIX only (Windows named pipes and detached
 * spawns are not exercised here).
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostStatusResult } from '../shared/types'
import { readDaemonInfo } from '../main/host/ownership'
import { connectHost } from './client/hostClient'
import { createLauncher } from './client/launcher'
import { writeTerminalAccess } from './terminalAccessSettings'
import { CLI_VERSION } from './version'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = resolve(here, '..', '..', 'out', 'cli', 'orgai.mjs')
const posix = process.platform !== 'win32'
/** Set by CI's post-build step: the bundle must be there (review round 1). */
const required = process.env.ORGAI_REQUIRE_NODE_HOST_INT === '1'

let userDataDir: string
let dataDir: string
const pids: number[] = []

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

/**
 * A plain host.stop is accepted at once, even while the boot-time `claude auth status` probe runs: the probe is aborted
 * at quiesce and the drain waits for its exit before ownership is released (never a refusal).
 */
async function stopHost(client: { call<T>(channel: string, args: unknown[]): Promise<T> }): Promise<{ stopping: boolean }> {
  return client.call<{ stopping: boolean }>('host.stop', [{ force: false }])
}

/** The host environment:this process's, without any ORGAI_* of the developer's shell, on the mock adapter. */
function hostEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ORGAI_')) env[k] = v
  return { ...env, ORGAI_MOCK: '1', ...extra }
}

function launcher(extra: Record<string, string>): ReturnType<typeof createLauncher> {
  return createLauncher({ dataDir, userDataDir, userChoseDataDir: true, env: hostEnv(extra), cliEntry: bundle, runtime: { execPath: process.execPath } })
}

beforeEach(() => {
  // Short: the host's d-<id>.sock must stay under the 100-byte socket path limit.
  userDataDir = realpathSync(mkdtempSync(join(posix ? '/tmp' : tmpdir(), 'wpe-')))
  dataDir = join(userDataDir, 'data')
})

afterEach(() => {
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL')
  rmSync(userDataDir, { recursive: true, force: true })
})

describe.runIf(posix && required)('Node background host bundle (CI after the build)', () => {
  it('out/cli/orgai.mjs is built, so the real-process tests below run', () => {
    expect(existsSync(bundle)).toBe(true)
  })
})

describe.skipIf(!posix || !existsSync(bundle))('Node background host (real process)', () => {
  it('starts detached as kind node, serves the socket at the stored level, and exits after host.stop', async () => {
    const l = launcher({ ORGAI_DAEMON_IDLE_MINUTES: '0' })
    const started = l.startBackground!('node')
    expect(started.hostKinds).toEqual(['node'])
    if (started.pid) pids.push(started.pid)
    const ready = await l.waitForReady({ timeoutMs: 45_000, hostKinds: started.hostKinds })
    expect(ready?.hostKind).toBe('node')
    expect(ready?.pid).toBe(started.pid)

    const res = await connectHost({ dataDir, scopes: ['read', 'operate', 'decide', 'configure'], clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid })
    if (!res.ok) throw new Error(`${res.reason}: ${res.message}`)
    // No stored level: 'operate' (never 'full' as an in-process host would grant).
    expect(res.client.hello.hostKind).toBe('node')
    expect([...res.client.hello.grantedScopes].sort()).toEqual(['operate', 'read'])
    // A withheld scope names the orgai commands, not the app's settings (review round 1).
    await expect(res.client.call('runs:decide', [{}])).rejects.toThrow(/orgai terminal-access --level full/)
    const status = await res.client.call<HostStatusResult>('host.status', [])
    expect(status).toMatchObject({ hostKind: 'node', state: 'ready', mock: true })
    await expect(stopHost(res.client)).resolves.toMatchObject({ stopping: true })
    res.client.close()

    expect(await l.waitForGone({ timeoutMs: 20_000, hostInstanceId: ready!.hostInstanceId })).toBe(true)
    expect(await until(() => !alive(ready!.pid), 10_000)).toBe(true)
    expect(readDaemonInfo(dataDir)).toBeNull()
    const log = readFileSync(join(userDataDir, 'logs', 'node-host.log'), 'utf8')
    expect(log).toContain('OrgAI background host stopped.')
  }, 90_000)

  it('grants full when the level was stored full, and leaves on its own through the idle exit', async () => {
    await writeTerminalAccess(dataDir, { level: 'full' })
    // 0.02 minutes = 1.2 s of idleness.
    const l = launcher({ ORGAI_DAEMON_IDLE_MINUTES: '0.02' })
    const started = l.startBackground!('node')
    if (started.pid) pids.push(started.pid)
    const ready = await l.waitForReady({ timeoutMs: 45_000, hostKinds: ['node'] })
    expect(ready).not.toBeNull()
    const res = await connectHost({ dataDir, scopes: ['read', 'decide', 'configure'], clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid })
    if (!res.ok) throw new Error(`${res.reason}: ${res.message}`)
    expect([...res.client.hello.grantedScopes].sort()).toEqual(['configure', 'decide', 'read'])
    res.client.close()
    expect(await l.waitForGone({ timeoutMs: 30_000, hostInstanceId: ready!.hostInstanceId })).toBe(true)
    expect(await until(() => !alive(ready!.pid), 10_000)).toBe(true)
  }, 90_000)

  it('two starters at once: one host wins, the other Node process hands off with exit 0, both waits see the winner (review round 1)', async () => {
    const a = launcher({ ORGAI_DAEMON_IDLE_MINUTES: '0' })
    const b = launcher({ ORGAI_DAEMON_IDLE_MINUTES: '0' })
    const sa = a.startBackground!('node')
    const sb = b.startBackground!('node')
    for (const p of [sa.pid, sb.pid]) if (p) pids.push(p)
    const [ra, rb] = await Promise.all([a.waitForReady({ timeoutMs: 45_000, hostKinds: ['node'] }), b.waitForReady({ timeoutMs: 45_000, hostKinds: ['node'] })])
    expect(ra).not.toBeNull()
    expect(rb?.hostInstanceId).toBe(ra!.hostInstanceId)
    expect([sa.pid, sb.pid]).toContain(ra!.pid)
    const loser = ra!.pid === sa.pid ? sb.pid! : sa.pid!
    expect(await until(() => !alive(loser), 15_000)).toBe(true)
    const log = readFileSync(join(userDataDir, 'logs', 'node-host.log'), 'utf8')
    expect(log).toContain('Another OrgAI host owns this data folder (background')
    expect(log).not.toContain('delete the folder')

    const res = await connectHost({ dataDir, scopes: ['read', 'configure'], clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid })
    if (!res.ok) throw new Error(`${res.reason}: ${res.message}`)
    await stopHost(res.client)
    res.client.close()
    expect(await a.waitForGone({ timeoutMs: 20_000, hostInstanceId: ra!.hostInstanceId })).toBe(true)
    expect(await until(() => !alive(ra!.pid), 10_000)).toBe(true)
  }, 90_000)
})
