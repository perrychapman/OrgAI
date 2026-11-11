// Shared helpers of the Wave 5 CLI e2e scripts (cli-projects, cli-org, cli-connections, cli-mcp, cli-skills-kit).
// Run `npm run build` first. Mock adapter only (ORGAI_MOCK=1): no tokens, no network. Every command hosts itself in its
// own process (one orgai at a time, cli-standalone-default.md), so a script runs commands one after the other and seeds
// state through commands (`seedProject`); nothing keeps a host alive or attaches to one.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { privateTempDir } from './privateDir.mjs'
import { APP_DIR, DATA_DIR, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'

// The CLI marks its own data folder (spec 3.1); a script that seeds files first marks it itself.
fs.writeFileSync(path.join(DATA_DIR, 'product.json'), `${JSON.stringify({ product: 'orgai-cli', version: 1 })}\n`, { mode: 0o600 })

/** A key file only its owner can read. Windows gives a new file inherited entries (SYSTEM, Administrators) that the key-file custodian refuses, so restrict the DACL to this user as its error message says. */
export function writeRestrictedKeyFile(file, bytes) {
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  if (process.platform !== 'win32') return
  const who = spawnSync(path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
  const sid = /"(S-1-[0-9-]+)"\s*$/m.exec(who.stdout ?? '')?.[1]
  if (!sid) throw new Error(`could not read the user SID: ${who.stdout} ${who.stderr}`)
  const r = spawnSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid}:F`, '/remove:g', '*S-1-5-18', '*S-1-5-32-544'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`icacls failed: ${r.stdout} ${r.stderr}`)
}

export const CLI = path.join(APP_DIR, 'out', 'cli', 'orgai.mjs')
/** `<userDataDir>/data`: where the host keeps run/daemon.json and the stores. */
export const HOST_DATA_DIR = path.join(DATA_DIR, 'data')
export const DAEMON_JSON = path.join(HOST_DATA_DIR, 'run', 'daemon.json')
export const PROJECTS_JSON = path.join(HOST_DATA_DIR, 'projects.json')

export const ENV = { ...process.env, ORGAI_CLI_DATA_DIR: DATA_DIR, ORGAI_MOCK: '1', NO_COLOR: '1' }
delete ENV.ELECTRON_RUN_AS_NODE
// A mock inproc host never touches an OS key store (a throwaway data folder must not leave keychain items); the
// vault key comes from a throwaway key file instead.
const KEY_DIR = privateTempDir('orgai-e2e-key-')
writeRestrictedKeyFile(path.join(KEY_DIR, 'vault.key'), randomBytes(32))
ENV.ORGAI_CLI_VAULT_KEY_FILE = path.join(KEY_DIR, 'vault.key')
// Belt and braces beside the key file: a CLI e2e child never reaches the real OS keychain, even without it.
ENV.ORGAI_CLI_VAULT_NO_OS_KEYSTORE = '1'
process.on('exit', () => fs.rmSync(KEY_DIR, { recursive: true, force: true }))

/** Exit 1 with a hint when the CLI bundle is missing. */
export function requireBuild() {
  if (!fs.existsSync(CLI)) {
    console.log('out/cli/orgai.mjs missing. Run `npm run build` first.')
    process.exit(1)
  }
}

/** Start the CLI (always --no-color); returns { child, done } where done resolves { code, signal, out, err }. */
export function startCli(args, { cwd = APP_DIR, input, env } = {}) {
  const stdin = input === undefined ? 'ignore' : 'pipe'
  const child = spawn(process.execPath, [CLI, '--no-color', ...args], { cwd, env: { ...ENV, ...env }, stdio: [stdin, 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  if (input !== undefined) {
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  }
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal, out, err }))
  })
  return { child, done }
}

/** Run the CLI to the end (SIGKILL after timeoutMs). Resolves { code, out, err }. stdin is piped only with `input`. */
export async function cli(args, { cwd, input, env, timeoutMs = 90_000 } = {}) {
  const { child, done } = startCli(args, { cwd, input, env })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const r = await done
  clearTimeout(timer)
  return { code: r.code, out: r.out, err: r.err }
}

/** JSON.parse, or null. */
export function json(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** A one-line summary of a CLI result for check() details. */
export const show = (r) => `exit ${r.code} ${r.out.slice(-400)} ${r.err.slice(-400)}`

export async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export const readDaemon = () => json(fs.existsSync(DAEMON_JSON) ? fs.readFileSync(DAEMON_JSON, 'utf8') : '')

/** The stored Project with this id, read from the data folder's projects.json (no host needed), or undefined. */
export function storedProject(id) {
  const doc = json(fs.existsSync(PROJECTS_JSON) ? fs.readFileSync(PROJECTS_JSON, 'utf8') : '')
  return doc?.projects?.find((p) => p.id === id)
}

/**
 * Create an OrgAI project on the mock adapter at `dir` with `orgai projects create` (kind 'code' or 'engagement'). Each
 * command hosts itself (one orgai at a time), so a script seeds state through commands, not through a long-lived host.
 * Resolves the Project.
 */
export async function seedProject(dir, { name = path.basename(dir), kind = 'code' } = {}) {
  const r = await cli(['projects', 'create', dir, '--name', name, '--kind', kind, '--output-format', 'json'])
  const project = json(r.out)?.project
  if (r.code !== 0 || !project?.id) throw new Error(`projects create failed: ${show(r)}`)
  return storedProject(project.id) ?? project
}
