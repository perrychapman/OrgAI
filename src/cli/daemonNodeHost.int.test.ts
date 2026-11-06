/**
 * Integration (Wave 7, cli-standalone.md 4.1 and 4.2): `--host daemon` with no app and no live host goes through the
 * REAL ensureHost and the REAL launcher's startBackground('node'): a detached `node out/cli/orgai.mjs daemon run-node`
 * process starts, the command connects to it as kind 'node', and the host leaves through the shutdown coordinator when
 * it gets SIGTERM (exit code 0, "OrgAI Node host stopped." in node-host.log, daemon.json gone). Mock adapter, a temp
 * data folder, no tokens.
 *
 * Needs the built bundle (`npm run build`): skipped when out/cli/orgai.mjs is missing, a failure when
 * ORGAI_REQUIRE_NODE_HOST_INT=1 (CI after the build). POSIX only.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readDaemonInfo } from '../main/host/ownership'
import { buildContext } from './context'
import { ensureHost } from './client/ensureHost'
import { createLauncher } from './client/launcher'
import type { CliContext } from './types'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = resolve(here, '..', '..', 'out', 'cli', 'orgai.mjs')
const posix = process.platform !== 'win32'
const required = process.env.ORGAI_REQUIRE_NODE_HOST_INT === '1'

let userDataDir: string
let dataDir: string
const pids: number[] = []

const alive = (pid: number): boolean => {
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

beforeEach(() => {
  // Short: the host's d-<id>.sock must stay under the 100-byte socket path limit.
  userDataDir = realpathSync(mkdtempSync(join(posix ? '/tmp' : tmpdir(), 'wpd-')))
  dataDir = join(userDataDir, 'data')
})
afterEach(() => {
  for (const pid of pids.splice(0)) if (alive(pid)) process.kill(pid, 'SIGKILL')
  rmSync(userDataDir, { recursive: true, force: true })
})

describe.runIf(posix && required)('daemon + Node host bundle (CI after the build)', () => {
  it('out/cli/orgai.mjs is built', () => {
    expect(existsSync(bundle)).toBe(true)
  })
})

describe.skipIf(!posix || !existsSync(bundle))('--host daemon without the app (real ensureHost, real launcher, real Node host)', () => {
  it('starts the Node host through startBackground, connects as kind node, and SIGTERM leaves through the coordinator', async () => {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('ORGAI_')) env[k] = v
    Object.assign(env, { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' })
    let err = ''
    const ctx: CliContext = buildContext({
      globals: { host: 'daemon', outputFormat: 'text', color: false, secretEnv: [], dataDir: userDataDir },
      env,
      cwd: userDataDir,
      platform: process.platform,
      io: { stdout: { write: () => true }, stderr: { write: (s: string) => ((err += s), true) }, stdinIsTTY: false }
    })
    // The unit under test is the launcher's startBackground, run from the built bundle; no app exists on this machine.
    const real = createLauncher({ dataDir, userDataDir, userChoseDataDir: true, env, cliEntry: bundle, runtime: { execPath: process.execPath } })
    ctx.launcher = { ...real, locate: () => ({ status: 'absent', message: 'OrgAI app not found' }) }

    const ensured = await ensureHost(ctx, ['read', 'operate'])
    try {
      expect(ensured.started).toBe(true)
      expect(ensured.inproc).toBeUndefined()
      expect(ensured.client.hello.hostKind).toBe('node')
    } finally {
      ensured.client.close()
    }
    const daemon = readDaemonInfo(dataDir)
    expect(daemon?.hostKind).toBe('node')
    pids.push(daemon!.pid)
    expect(daemon!.pid).not.toBe(process.pid)

    process.kill(daemon!.pid, 'SIGTERM')
    expect(await until(() => !alive(daemon!.pid), 30_000)).toBe(true)
    expect(readDaemonInfo(dataDir)).toBeNull()
    const log = readFileSync(join(userDataDir, 'logs', 'node-host.log'), 'utf8')
    expect(log).toContain('OrgAI Node host stopped.')
    expect(err).not.toContain('running the host inside this command')
  }, 90_000)
})
