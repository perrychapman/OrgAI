// The two products side by side (docs/design/cli-standalone-default.md 8, "separation.mjs"). Run `npm run build` first.
// Mock adapter only (ORGAI_MOCK=1): no tokens, no network. The desktop app (hidden windows) runs on temp folder A and an
// `orgai exec` that stays alive owns temp folder B at the same time. Proved:
//   a. Each folder carries its own product marker (A orgai-desktop, B orgai-cli); the app listens on no socket
//      (daemon.json listening false) while the orgai command owns B.
//   b. Separate projects, runs, settings files and logs: the app's project is only in A, the CLI's project and run only in
//      B, and neither main.log names the other's project. The CLI's vault key is its own file (ORGAI_CLI_VAULT_KEY_FILE);
//      the app's folder holds no vault key of the CLI. (Custody service names are unit-tested: vaultTypes, secrets.)
//   c. The CLI refuses A (exit non-zero, "belongs to the OrgAI app"; A's marker is untouched). A second orgai on B is refused
//      at once with exit 6. The app, started on B, refuses it ("belongs to the orgai command line tool", exit 2, its
//      dialog text recorded by e2e/dialog-stub.cjs instead of shown) and leaves B alone.
//   d. Quitting the app leaves the orgai command running and owning B; relaunching the app works; stopping the orgai command
//      (SIGINT) leaves the app running.
// Not covered here: approvals and libraries have no cross-product code path left to exercise (unit tests: productMarker,
// folder refusal, cli-standalone-default 3.x); this script checks the file sets stay apart.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { APP_DIR, DATA_DIR, check, cleanup, createProject, electronBinary, finish, hideArgs, launch, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'
import { privateTempDir } from './privateDir.mjs'

const CLI = path.join(APP_DIR, 'out', 'cli', 'orgai.mjs')
const posix = process.platform !== 'win32'
if (!fs.existsSync(CLI) || !fs.existsSync(path.join(APP_DIR, 'out', 'main', 'index.js'))) {
  console.log('out/cli/orgai.mjs or out/main/index.js missing. Run `npm run build` first.')
  process.exit(1)
}

const A = DATA_DIR
const B = path.join(privateTempDir('orgai-e2e-sep-'), 'cli')
const keyDir = privateTempDir('orgai-e2e-sepkey-')
const KEY_FILE = path.join(keyDir, 'vault.key')
fs.writeFileSync(KEY_FILE, randomBytes(32), { mode: 0o600 })
const DIALOG_LOG = path.join(keyDir, 'dialog.log')
const APP_PROJECT = 'SepAppProject'

const cliEnv = { ...process.env, ORGAI_CLI_DATA_DIR: B, ORGAI_MOCK: '1', NO_COLOR: '1', ORGAI_CLI_VAULT_KEY_FILE: KEY_FILE, ORGAI_CLI_VAULT_NO_OS_KEYSTORE: '1' }
delete cliEnv.ELECTRON_RUN_AS_NODE
delete cliEnv.ORGAI_DATA_DIR

function startCli(args, { cwd = APP_DIR, env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, '--no-color', ...args], { cwd, env: { ...cliEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  let exited = false
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  const done = new Promise((resolve) => child.on('close', (code, signal) => ((exited = true), resolve({ code: code ?? (signal ? 128 : 1), out, err }))))
  return { child, done, alive: () => !exited }
}
async function cli(args, opts) {
  const { child, done } = startCli(args, opts)
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const r = await done
  clearTimeout(timer)
  return r
}
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')
const readJson = (f) => {
  try {
    return JSON.parse(read(f))
  } catch {
    return undefined
  }
}
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(200)
  }
  log(`timed out waiting for ${what}`)
  return false
}
/** A run of the app on `folder` with its error dialogs recorded, not shown. Resolves { code, dialog }. */
function appOn(folder) {
  fs.rmSync(DIALOG_LOG, { force: true })
  const stub = path.join(APP_DIR, 'e2e', 'dialog-stub.cjs')
  const child = spawn(electronBinary(), [...hideArgs(), '-r', stub, '--use-mock-keychain', APP_DIR], {
    cwd: APP_DIR,
    env: { ...process.env, ORGAI_DATA_DIR: folder, ORGAI_MOCK: '1', ORGAI_E2E_DIALOG_LOG: DIALOG_LOG },
    stdio: 'ignore'
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  return new Promise((resolve) =>
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, dialog: read(DIALOG_LOG) })
    })
  )
}

const repoA = makeFixtureRepo('sep-app')
const repoB = makeFixtureRepo('sep-cli')
let session
let held
try {
  // ---------- the app on A ----------
  session = await launch({ shotPrefix: 'separation' })
  await createProject(session.page, { path: repoA, name: APP_PROJECT })
  check(readJson(path.join(A, 'product.json'))?.product === 'orgai-desktop', 'folder A carries the orgai-desktop marker', read(path.join(A, 'product.json')))
  const appDaemon = readJson(path.join(A, 'data', 'run', 'daemon.json'))
  check(appDaemon?.hostKind === 'desktop' && appDaemon?.listening === false, 'the app owns A and listens on no socket', JSON.stringify(appDaemon))

  // ---------- an orgai command that stays alive on B ----------
  held = startCli(['exec', '--create-project', '--output-format', 'stream-json', '[mock:exec-slow] hold the folder'], { cwd: repoB })
  const heldUp = await until('the orgai exec to own B', () => fs.existsSync(path.join(B, 'data', 'run', 'daemon.json')) && read(path.join(B, 'data', 'runs.json')).includes('"id"'))
  check(heldUp, 'an orgai exec owns folder B and has a run')
  check(readJson(path.join(B, 'product.json'))?.product === 'orgai-cli', 'folder B carries the orgai-cli marker', read(path.join(B, 'product.json')))

  // ---------- separate data ----------
  const appProjects = read(path.join(A, 'data', 'projects.json'))
  const cliProjects = read(path.join(B, 'data', 'projects.json'))
  const base = path.basename(repoB)
  check(appProjects.includes(APP_PROJECT) && !appProjects.includes(base), 'the app\'s projects hold its project only', appProjects.slice(0, 200))
  check(cliProjects.includes(base) && !cliProjects.includes(APP_PROJECT), 'the CLI\'s projects hold its project only', cliProjects.slice(0, 200))
  const appRuns = read(path.join(A, 'data', 'runs.json'))
  check(!appRuns.includes(path.basename(repoB)) && read(path.join(B, 'data', 'runs.json')).includes('"id"'), 'the CLI\'s run is not in the app\'s runs')
  const logA = read(path.join(A, 'logs', 'main.log'))
  const logB = read(path.join(B, 'logs', 'main.log'))
  check(logA.length > 0 && logB.length > 0, 'each product writes its own main.log', `${logA.length} / ${logB.length} bytes`)
  check(!logA.includes(base) && !logB.includes(APP_PROJECT), 'neither log names the other product\'s project')
  for (const f of ['settings.json', 'vault.json', 'mcp-library.json']) {
    check(!(fs.existsSync(path.join(A, 'data', f)) && fs.existsSync(path.join(B, 'data', f)) && fs.realpathSync(path.join(A, 'data', f)) === fs.realpathSync(path.join(B, 'data', f))), `${f} is not shared between the folders`)
  }
  check(!fs.readdirSync(A).some((f) => f.includes('vault.key')), 'the app folder holds no CLI vault key')

  // ---------- mutual refusals ----------
  const onA = await cli(['projects', 'list'], { env: { ORGAI_CLI_DATA_DIR: A } })
  check(onA.code !== 0 && /belongs to the OrgAI app/.test(onA.err), 'orgai refuses the app\'s folder A', `${onA.code} ${onA.err.slice(0, 200)}`)
  check(readJson(path.join(A, 'product.json'))?.product === 'orgai-desktop', 'folder A still carries the desktop marker after the refusal')
  const began = Date.now()
  const second = await cli(['connections', 'list'])
  check(second.code === 6 && /already running/.test(second.err), 'a second orgai on B is refused with exit 6', `${second.code} ${second.err.slice(0, 200)}`)
  check(Date.now() - began < 15_000, 'the refusal came at once', `${Date.now() - began} ms`)
  const appOnB = await appOn(B)
  check(appOnB.code === 2 && /belongs to the orgai command line tool/.test(appOnB.dialog), 'the app refuses the orgai folder B (exit 2, dialog text recorded)', `${appOnB.code} ${appOnB.dialog.slice(0, 200)}`)
  check(readJson(path.join(B, 'product.json'))?.product === 'orgai-cli' && held.alive(), 'folder B is untouched and its orgai still runs after the app\'s refusal')

  // ---------- quitting one leaves the other ----------
  await session.app.close().catch(() => {})
  await sleep(1500)
  check(held.alive() && fs.existsSync(path.join(B, 'data', 'run', 'daemon.json')), 'quitting the app leaves the orgai command running and owning B')
  const status = await cli(['status', '--output-format', 'json'], { env: { ORGAI_CLI_DATA_DIR: B } }).catch(() => undefined)
  check(status !== undefined, 'a read-only orgai command still answers beside the running one')
  session = await launch({ shotPrefix: 'separation', clearPrefs: false })
  check(await session.page.locator('.sidebar').count() > 0, 'the app starts again on A while the orgai command runs')
  held.child.kill('SIGINT')
  const heldEnd = await Promise.race([held.done, sleep(30_000).then(() => undefined)])
  check(heldEnd !== undefined && (!posix || heldEnd.code === 130), 'stopping the orgai command ends it (130)', heldEnd ? `exit ${heldEnd.code}` : 'still running')
  check(!fs.existsSync(path.join(B, 'data', 'run', 'daemon.json')), 'the orgai command released B')
  check(!session.page.isClosed() && (await session.page.locator('.sidebar').count()) > 0, 'stopping the orgai command leaves the app running')
  // Asked once B is free: beside the owner the command answers from a snapshot without the vault.
  const sec = await cli(['secrets', 'status', '--output-format', 'json'], { env: { ORGAI_CLI_DATA_DIR: B } })
  check(sec.code === 0 && JSON.parse(sec.out || '{}')?.secrets?.keyFile === KEY_FILE, 'the CLI vault key is its own ORGAI_CLI_VAULT_KEY_FILE', sec.out.slice(0, 200) + sec.err.slice(0, 200))
} catch (e) {
  check(false, 'separation ran to the end', e instanceof Error ? e.stack : String(e))
} finally {
  if (held?.alive()) held.child.kill('SIGKILL')
  await cleanup(session?.app, session?.page, APP_PROJECT)
  removeFixture(repoA)
  removeFixture(repoB)
  for (const d of [path.dirname(B), keyDir]) fs.rmSync(d, { recursive: true, force: true })
}
finish('separation')
