// The two products side by side (docs/design/cli-standalone-default.md 8, "separation.mjs"). Run `npm run build` first.
// Mock adapter only (ORGAI_MOCK=1): no tokens, no network. The desktop app (hidden windows) runs on temp folder A and an
// `orgai exec` that stays alive owns temp folder B at the same time (a mock script with a one-hour step pause, so the
// hold lasts until the script interrupts it, however slow the machine). Every step makes a change in one product and
// checks the other is unchanged. Proved:
//   a. Each folder carries its own product marker (A orgai-desktop, B orgai-cli); the app listens on no socket
//      (daemon.json listening false) while the orgai command owns B.
//   b. Settings: a setting changed in the app is in A's settings.json and not in B's.
//      Runs and logs: the app's project is only in A, the CLI's project and run only in B, and neither main.log names the
//      other's project.
//   c. Approvals: a permission card raised in the app (a [mock:fatigue] run in the default permission mode) is not seen by the CLI (its run, its output
//      and its runs.json stay as they were), the app has no card for the CLI's run, and answering the card leaves the
//      held orgai exec untouched.
//   d. Libraries: an MCP library entry added in the app is in A's mcp-library.json only; one added by the orgai command is
//      in B's only; each product lists only its own.
//   e. Secrets and vault custody (the app's own names are asserted by a unit test this script runs): the app has its own key file (ORGAI_VAULT_KEY_FILE, the CLI's variable is set in its
//      environment too and ignored) and the CLI its own (ORGAI_CLI_VAULT_KEY_FILE); each status reports its own file and
//      its own vault id; a secret saved by one is counted only in its own vault.json; with no key file set, the CLI's
//      doctor names its own key store (OrgAI CLI Vault on macOS, not the app's "OrgAI Vault").
//   f. The CLI refuses A (exit non-zero, "belongs to the OrgAI app"; A's marker is untouched). A second orgai on B is refused
//      at once with exit 6. The app, started on B, refuses it ("belongs to the orgai command line tool", exit 2, its
//      dialog text recorded by e2e/dialog-stub.cjs instead of shown) before it writes anything there: B's top-level
//      listing is the same before and after.
//      The app also refuses a folder whose data/ is a CLI folder (its parent) and one whose data entry links into one.
//   g. Quitting the app leaves the orgai command running and owning B; `orgai status` answers beside it; relaunching the app
//      works; stopping the orgai command (SIGINT; skipped on Windows, where it is a hard kill) leaves the app running.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { APP_DIR, DATA_DIR, check, cleanup, createProject, electronBinary, finish, launch, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'
import { privateTempDir, writePrivateKeyFile } from './privateDir.mjs'

const CLI = path.join(APP_DIR, 'out', 'cli', 'orgai.mjs')
const posix = process.platform !== 'win32'
if (!fs.existsSync(CLI) || !fs.existsSync(path.join(APP_DIR, 'out', 'main', 'index.js'))) {
  console.log('out/cli/orgai.mjs or out/main/index.js missing. Run `npm run build` first.')
  process.exit(1)
}

const A = DATA_DIR
const B = path.join(privateTempDir('orgai-e2e-sep-'), 'cli')
const C = path.join(privateTempDir('orgai-e2e-sepc-'), 'cli')
const keyDir = privateTempDir('orgai-e2e-sepkey-')
const KEY_FILE = path.join(keyDir, 'cli.key')
const APP_KEY_FILE = path.join(keyDir, 'app.key')
writePrivateKeyFile(KEY_FILE, randomBytes(32))
const DIALOG_LOG = path.join(keyDir, 'dialog.log')
// A one-hour pause between the exec-slow steps: the hold ends only when the script interrupts it.
const HOLD_SCRIPT = path.join(keyDir, 'hold.json')
fs.writeFileSync(HOLD_SCRIPT, JSON.stringify({ delayMs: 3_600_000 }))
// The app is started hidden here (a local hook may also hide it; CI relies on this variable).
process.env.ORGAI_WINDOW_HIDDEN = '1'
// The app runs the mock adapter too: without this the card test below started a real model run (flaky, spends tokens).
process.env.ORGAI_MOCK = '1'
const PARENT = privateTempDir('orgai-e2e-sepp-')
const APP_PROJECT = 'SepAppProject'
const APP_LIB = 'sep-app-lib'
const CLI_LIB = 'sep-cli-lib'

// The app has its own key file and its own custody; the CLI's variable is set in its environment as well and must be ignored.
process.env.ORGAI_VAULT_KEY_FILE = APP_KEY_FILE
process.env.ORGAI_CLI_VAULT_KEY_FILE = KEY_FILE
const cliEnv = { ...process.env, ORGAI_CLI_DATA_DIR: B, ORGAI_MOCK: '1', NO_COLOR: '1', ORGAI_CLI_VAULT_KEY_FILE: KEY_FILE, ORGAI_CLI_VAULT_NO_OS_KEYSTORE: '1' }
delete cliEnv.ELECTRON_RUN_AS_NODE
delete cliEnv.ORGAI_DATA_DIR
delete cliEnv.ORGAI_VAULT_KEY_FILE

/** Spawns the orgai command; an env value of undefined removes the variable. */
function startCli(args, { cwd = APP_DIR, env = {} } = {}) {
  const merged = { ...cliEnv, ...env }
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
  const child = spawn(process.execPath, [CLI, '--no-color', ...args], { cwd, env: merged, stdio: ['ignore', 'pipe', 'pipe'] })
  const held = { out: '', err: '', exited: false }
  child.stdout.on('data', (d) => (held.out += d))
  child.stderr.on('data', (d) => (held.err += d))
  const done = new Promise((resolve) =>
    child.on('close', (code, signal) => {
      held.exited = true
      resolve({ code: code ?? (signal ? 128 : 1), out: held.out, err: held.err })
    })
  )
  return { child, done, alive: () => !held.exited, output: () => held.out }
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
const parse = (text) => {
  try {
    return JSON.parse(text)
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
  // (A local hidden-window hook, when present, reaches this child through NODE_OPTIONS, set by lib.mjs.)
  const child = spawn(electronBinary(), ['-r', stub, '--use-mock-keychain', APP_DIR], {
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
/** A timer that does not keep the process alive (a race that is won early leaves no 30 s tail). */
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref())
const topLevel = (dir) => fs.readdirSync(dir).sort()
/** The held orgai exec must still run for the checks that need it; says so plainly when it ended early. */
const heldStillRuns = (what) => check(held.alive(), `the held orgai exec is still running ${what}`, held.alive() ? '' : `exec ended early: ${held.output().slice(-200)}`)

// A hung step must not hang CI: the whole script gets ten minutes.
setTimeout(() => {
  console.log('FAIL separation timed out after 10 minutes')
  process.exit(1)
}, 600_000).unref()

const repoA = makeFixtureRepo('sep-app')
const repoB = makeFixtureRepo('sep-cli')
let session
let held
try {
  // ---------- the app on A ----------
  session = await launch({ shotPrefix: 'separation' })
  await createProject(session.page, { path: repoA, name: APP_PROJECT })
  const appProjectId = await session.page.evaluate(async (n) => (await window.orgai.projects.list()).find((p) => p.name === n)?.id, APP_PROJECT)
  check(readJson(path.join(A, 'product.json'))?.product === 'orgai-desktop', 'folder A carries the orgai-desktop marker', read(path.join(A, 'product.json')))
  const appDaemon = readJson(path.join(A, 'data', 'run', 'daemon.json'))
  check(appDaemon?.hostKind === 'desktop' && appDaemon?.listening === false, 'the app owns A and listens on no socket', JSON.stringify(appDaemon))

  // A setting, a library entry with a secret, and a permission card: all made in the app only.
  await session.page.evaluate(async () => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: 'light', reduceMotion: 'on' } })
  })
  await session.page.evaluate(
    async ([name]) => {
      const list = await window.orgai.mcpLibrary.upsert({ id: 'lib-sep-app', name, transport: 'stdio', command: 'node', args: ['app-server.js'], secretEnv: ['SEP_APP_TOKEN'], source: 'user', addedAt: new Date().toISOString() })
      const id = list.find((i) => i.entry.name === name).entry.id
      await window.orgai.mcpLibrary.setSecret({ libraryId: id, kind: 'env', name: 'SEP_APP_TOKEN', value: 'app-secret-value' })
    },
    [APP_LIB]
  )
  const appSecrets = await session.page.evaluate(() => window.orgai.secrets.status())
  check(appSecrets.state === 'open' && appSecrets.keyFile === APP_KEY_FILE, 'the app\'s vault is open on the app\'s own key file (not the CLI\'s)', JSON.stringify({ state: appSecrets.state, keyFile: appSecrets.keyFile }))
  check(appSecrets.counts.vault >= 1, 'the app saved its secret in its own vault', JSON.stringify(appSecrets.counts))
  const settingsA = read(path.join(A, 'data', 'settings.json'))
  check(/"theme":\s*"light"/.test(settingsA) && /"reduceMotion":\s*"on"/.test(settingsA), 'the app\'s setting change is in A/data/settings.json', settingsA.slice(0, 200))
  check(read(path.join(A, 'data', 'mcp-library.json')).includes(APP_LIB), 'the app\'s library entry is in A/data/mcp-library.json')

  // A permission card in the app (a project in the default mode asks for each command).
  await session.page.evaluate(async (id) => {
    const p = await window.orgai.projects.get(id)
    await window.orgai.projects.save({ ...p, permissionMode: 'default' })
  }, appProjectId)
  const appRun = await session.page.evaluate((i) => window.orgai.runs.start(i), { projectId: appProjectId, prompt: '[mock:fatigue] tidy up' })
  const cardUp = await until('the app\'s permission card', async () => (await session.page.evaluate((id) => window.orgai.runs.pendingCards(id), appRun.id)).permissions.length > 0, 30_000)
  const cardDetail = cardUp ? '' : JSON.stringify(await session.page.evaluate((id) => window.orgai.runs.get?.(id) ?? null, appRun.id).catch((e) => String(e))).slice(0, 300)
  check(cardUp, 'the app raised a permission card on its own run', cardDetail)

  // ---------- an orgai command that stays alive on B ----------
  held = startCli(['exec', '--create-project', '--output-format', 'stream-json', '[mock:exec-slow] hold the folder'], { cwd: repoB, env: { ORGAI_MOCK_SCRIPT: HOLD_SCRIPT } })
  const heldUp = await until('the orgai exec to own B', () => fs.existsSync(path.join(B, 'data', 'run', 'daemon.json')) && read(path.join(B, 'data', 'runs.json')).includes('"id"'))
  check(heldUp, 'an orgai exec owns folder B and has a run')
  check(readJson(path.join(B, 'product.json'))?.product === 'orgai-cli', 'folder B carries the orgai-cli marker', read(path.join(B, 'product.json')))
  const cliRunId = readJson(path.join(B, 'data', 'runs.json'))?.runs?.[0]?.id

  // ---------- separate data ----------
  const appProjects = read(path.join(A, 'data', 'projects.json'))
  const cliProjects = read(path.join(B, 'data', 'projects.json'))
  const base = path.basename(repoB)
  check(appProjects.includes(APP_PROJECT) && !appProjects.includes(base), 'the app\'s projects hold its project only', appProjects.slice(0, 200))
  check(cliProjects.includes(base) && !cliProjects.includes(APP_PROJECT), 'the CLI\'s projects hold its project only', cliProjects.slice(0, 200))
  const appRuns = read(path.join(A, 'data', 'runs.json'))
  const cliRuns = read(path.join(B, 'data', 'runs.json'))
  check(!appRuns.includes(path.basename(repoB)) && !!cliRunId && !appRuns.includes(cliRunId), 'the CLI\'s run is not in the app\'s runs')
  check(!cliRuns.includes(appRun.id) && !cliRuns.includes(APP_PROJECT), 'the app\'s run is not in the CLI\'s runs')
  const logA = read(path.join(A, 'logs', 'main.log'))
  const logB = read(path.join(B, 'logs', 'main.log'))
  check(logA.length > 0 && logB.length > 0, 'each product writes its own main.log', `${logA.length} / ${logB.length} bytes`)
  check(!logA.includes(base) && !logB.includes(APP_PROJECT), 'neither log names the other product\'s project')

  // Settings: the change made in the app is not in B (B may hold no settings file at all).
  const settingsB = read(path.join(B, 'data', 'settings.json'))
  check(!/"theme":\s*"light"/.test(settingsB) && !/"reduceMotion":\s*"on"/.test(settingsB), 'the app\'s setting change is not in B/data/settings.json', settingsB.slice(0, 200))
  // Libraries and secrets: nothing of the app's is in B.
  check(!read(path.join(B, 'data', 'mcp-library.json')).includes(APP_LIB), 'the app\'s library entry is not in B')
  check(!fs.existsSync(path.join(B, 'data', 'vault.json')) || readJson(path.join(B, 'data', 'vault.json'))?.id !== readJson(path.join(A, 'data', 'vault.json'))?.id, 'B holds no copy of the app\'s vault')
  check(!fs.existsSync(APP_KEY_FILE) || !fs.readFileSync(APP_KEY_FILE).equals(fs.readFileSync(KEY_FILE)), 'the app\'s key file and the CLI\'s are different keys')

  // Approvals: the app's card is not the CLI's; the app has no card for the CLI's run; answering it leaves the exec alone.
  heldStillRuns('while the app has a permission card open')
  const cardId = (await session.page.evaluate((id) => window.orgai.runs.pendingCards(id), appRun.id)).permissions[0]?.id
  check(!!cardId && !held.output().includes(cardId) && !held.output().includes(appRun.id), 'the CLI\'s output names neither the app\'s card nor its run', held.output().slice(0, 200))
  const cliCards = await session.page.evaluate((id) => window.orgai.runs.pendingCards(id).catch(() => null), cliRunId)
  check(!cliCards || Object.values(cliCards).every((l) => l.length === 0), 'the app has no card for the CLI\'s run', JSON.stringify(cliCards))
  await session.page.evaluate((i) => window.orgai.runs.decide(i), { runId: appRun.id, requestId: cardId, decision: { behavior: 'deny', message: 'separation e2e' } })
  await sleep(500)
  heldStillRuns('after the app\'s card was answered')
  check(readJson(path.join(B, 'data', 'runs.json'))?.runs?.[0]?.status === 'running', 'the CLI\'s run is still running after the app answered its own card')

  // ---------- mutual refusals ----------
  const onA = await cli(['projects', 'list'], { env: { ORGAI_CLI_DATA_DIR: A } })
  check(onA.code !== 0 && /belongs to the OrgAI app/.test(onA.err), 'orgai refuses the app\'s folder A', `${onA.code} ${onA.err.slice(0, 200)}`)
  check(readJson(path.join(A, 'product.json'))?.product === 'orgai-desktop', 'folder A still carries the desktop marker after the refusal')
  const began = Date.now()
  const second = await cli(['connections', 'list'])
  check(second.code === 6 && /already running/.test(second.err), 'a second orgai on B is refused with exit 6', `${second.code} ${second.err.slice(0, 200)}`)
  check(Date.now() - began < 15_000, 'the refusal came at once', `${Date.now() - began} ms`)
  const beforeB = topLevel(B)
  const markerB = read(path.join(B, 'product.json'))
  const appOnB = await appOn(B)
  check(appOnB.code === 2 && /belongs to the orgai command line tool/.test(appOnB.dialog), 'the app refuses the orgai folder B (exit 2, dialog text recorded)', `${appOnB.code} ${appOnB.dialog.slice(0, 200)}`)
  const afterB = topLevel(B)
  check(JSON.stringify(afterB) === JSON.stringify(beforeB), 'the app wrote nothing into folder B (same top-level listing)', `${beforeB.join(',')} -> ${afterB.join(',')}`)
  check(read(path.join(B, 'product.json')) === markerB && readJson(path.join(B, 'product.json'))?.product === 'orgai-cli', 'folder B\'s marker is untouched')
  heldStillRuns('after the app\'s refusal')
  // A folder inside B is refused the same way (the app never nests in the CLI's tree).
  // The held exec keeps writing its own files while it starts; let its run folder appear before the listing is taken.
  await until('the exec\'s runs folder', () => fs.existsSync(path.join(B, 'data', 'runs')), 15_000)
  await sleep(1000)
  const dataB = topLevel(path.join(B, 'data'))
  const nested = await appOn(path.join(B, 'data'))
  check(nested.code === 2 && /belongs to the orgai command line tool/.test(nested.dialog), 'the app refuses a folder inside B too', `${nested.code} ${nested.dialog.slice(0, 120)}`)
  check(JSON.stringify(topLevel(path.join(B, 'data'))) === JSON.stringify(dataB) && !fs.existsSync(path.join(B, 'data', 'product.json')), 'nothing was written inside B/data (no desktop marker, same listing)', topLevel(path.join(B, 'data')).join(',') + ' vs ' + dataB.join(','))

  // A CLI folder named `data` (its own data folder is data/data): the app refuses its parent, and a folder whose `data`
  // links into it, and writes nothing in either.
  const cliData = path.join(PARENT, 'data')
  const made = await cli(['secrets', 'status', '--output-format', 'json'], { env: { ORGAI_CLI_DATA_DIR: cliData } })
  check(made.code === 0 && readJson(path.join(cliData, 'product.json'))?.product === 'orgai-cli', 'the orgai command can use a folder named data', `${made.code} ${made.err.slice(0, 200)}`)
  fs.mkdirSync(path.join(cliData, 'data'), { recursive: true })
  const parentBefore = topLevel(PARENT)
  const onParent = await appOn(PARENT)
  check(onParent.code === 2 && /belongs to the orgai command line tool/.test(onParent.dialog), 'the app refuses a folder whose data/ is a CLI folder', `${onParent.code} ${onParent.dialog.slice(0, 120)}`)
  check(JSON.stringify(topLevel(PARENT)) === JSON.stringify(parentBefore) && !fs.existsSync(path.join(PARENT, 'product.json')), 'nothing was written beside it (no desktop marker)')
  const linkFolder = path.join(PARENT, 'link')
  fs.mkdirSync(linkFolder)
  fs.symlinkSync(path.join(cliData, 'data'), path.join(linkFolder, 'data'), 'junction')
  const onLink = await appOn(linkFolder)
  check(onLink.code === 2 && /belongs to the orgai command line tool/.test(onLink.dialog), 'the app refuses a folder whose data entry links into a CLI folder', `${onLink.code} ${onLink.dialog.slice(0, 120)}`)
  check(!fs.existsSync(path.join(linkFolder, 'product.json')), 'and marks nothing there')

  // ---------- quitting one leaves the other ----------
  await session.app.close().catch(() => {})
  await sleep(1500)
  heldStillRuns('after quitting the app')
  check(fs.existsSync(path.join(B, 'data', 'run', 'daemon.json')), 'quitting the app leaves the orgai command owning B')
  // Beside the running owner, a read-only command answers from the saved state.
  const status = await cli(['status', '--output-format', 'json'], { env: { ORGAI_CLI_DATA_DIR: B } })
  const statusDoc = parse(status.out)
  check(status.code === 0 && statusDoc?.schemaVersion === 1 && statusDoc?.liveInboxAvailable === false, 'orgai status answers beside the running one (exit 0, saved state, no live inbox)', `${status.code} ${status.out.slice(0, 160)} ${status.err.slice(0, 160)}`)
  check(typeof statusDoc?.host?.dataDir === 'string' && fs.realpathSync(statusDoc.host.dataDir) === fs.realpathSync(path.join(B, 'data')), 'its status describes folder B\'s host, not the app\'s')
  session = await launch({ shotPrefix: 'separation', clearPrefs: false })
  check(await session.page.locator('.sidebar').count() > 0, 'the app starts again on A while the orgai command runs')
  heldStillRuns('after the app started again')
  const settingsAgain = await session.page.evaluate(() => window.orgai.settings.get())
  check(settingsAgain.appearance.theme === 'light', 'the app kept its own setting across the restart')

  // ---------- stopping the orgai command ----------
  if (posix) {
    held.child.kill('SIGINT')
    const heldEnd = await Promise.race([held.done, after(30_000).then(() => undefined)])
    check(heldEnd !== undefined && heldEnd.code === 130, 'stopping the orgai command ends it (130)', heldEnd ? `exit ${heldEnd.code}` : 'still running')
    check(await until('B to be released', () => !fs.existsSync(path.join(B, 'data', 'run', 'daemon.json')), 10_000), 'the orgai command released B')
  } else {
    // kill('SIGINT') is TerminateProcess on Windows: no handler runs, so neither the exit code nor the release can be checked.
    log('SKIP: the SIGINT exit code and the release of B (Windows has no SIGINT for a child)')
    held.child.kill('SIGKILL')
    await Promise.race([held.done, after(15_000)])
  }
  check(!session.page.isClosed() && (await session.page.locator('.sidebar').count()) > 0, 'stopping the orgai command leaves the app running')

  // ---------- B is free: the CLI changes things, the app does not see them ----------
  const secB = await cli(['secrets', 'status', '--output-format', 'json'], { env: { ORGAI_CLI_DATA_DIR: B } })
  check(secB.code === 0 && parse(secB.out)?.secrets?.keyFile === KEY_FILE, 'the CLI vault key is its own ORGAI_CLI_VAULT_KEY_FILE', secB.out.slice(0, 200) + secB.err.slice(0, 200))
  const libAdd = await cli(['mcp', 'library', 'add', CLI_LIB, '--command', 'node', '--arg', 'cli-server.js', '--secret-var', 'SEP_CLI_TOKEN'])
  check(libAdd.code === 0, 'the orgai command adds an MCP library entry', `${libAdd.code} ${libAdd.err.slice(0, 200)}`)
  const libSecret = await cli(['mcp', 'library', 'set-secret', CLI_LIB, 'SEP_CLI_TOKEN', '--from-env', 'SEP_CLI_VALUE'], { env: { SEP_CLI_VALUE: 'cli-secret-value' } })
  check(libSecret.code === 0, 'and saves a secret for it', `${libSecret.code} ${libSecret.err.slice(0, 200)}`)
  check(read(path.join(B, 'data', 'mcp-library.json')).includes(CLI_LIB) && !read(path.join(B, 'data', 'mcp-library.json')).includes(APP_LIB), 'B/data/mcp-library.json holds the CLI\'s entry only')
  check(read(path.join(A, 'data', 'mcp-library.json')).includes(APP_LIB) && !read(path.join(A, 'data', 'mcp-library.json')).includes(CLI_LIB), 'A/data/mcp-library.json still holds the app\'s entry only')
  const appLibNow = await session.page.evaluate(() => window.orgai.mcpLibrary.list())
  check(appLibNow.some((i) => i.entry.name === APP_LIB) && !appLibNow.some((i) => i.entry.name === CLI_LIB), 'the app lists only its own library entries', appLibNow.map((i) => i.entry.name).join(','))
  const secB2 = parse((await cli(['secrets', 'status', '--output-format', 'json'], { env: { ORGAI_CLI_DATA_DIR: B } })).out)?.secrets
  const appSecrets2 = await session.page.evaluate(() => window.orgai.secrets.status())
  check(secB2?.counts?.vault >= 1 && !!secB2?.vaultId && secB2.vaultId !== appSecrets.vaultId, 'the CLI saved its secret in its own vault (a different vault id)', `${secB2?.vaultId} / ${appSecrets.vaultId}`)
  check(appSecrets2.counts.vault === appSecrets.counts.vault && appSecrets2.keyFile === APP_KEY_FILE, 'the app\'s vault did not change when the CLI saved a secret')
  const vaultA = read(path.join(A, 'data', 'vault.json'))
  const vaultB = read(path.join(B, 'data', 'vault.json'))
  check(vaultA.length > 0 && vaultB.length > 0 && vaultA !== vaultB && !vaultA.includes('cli-secret-value') && !vaultB.includes('app-secret-value'), 'each vault.json holds only its own product\'s secrets')
  // The app's custody names (OrgAI Vault, ORGAI_VAULT_*) are asserted by the unit test, run from here so this script fails when they change.
  const names = spawnSync(process.execPath, [path.join(APP_DIR, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'src/main/store/vaultTypes.test.ts', '-t', 'product custody names'], { cwd: APP_DIR, encoding: 'utf8' })
  check(names.status === 0, 'the app keeps its own custody names (OrgAI Vault, ORGAI_VAULT_*) apart from the CLI\'s', (names.stdout + names.stderr).slice(-300))
  // Custody names: with no key file set, the CLI's doctor names the CLI's own key store, never the app's.
  const doctor = await cli(['doctor', '--output-format', 'json'], { env: { ORGAI_CLI_DATA_DIR: C, ORGAI_CLI_VAULT_KEY_FILE: undefined } })
  const custody = /"id":\s*"vault-custody"[^}]*?"detail":\s*"((?:[^"\\]|\\.)*)"/.exec(doctor.out)?.[1] ?? ''
  check(/OrgAI CLI [Vv]ault|orgai-cli/.test(custody) && !/OrgAI Vault/.test(custody), 'the orgai command\'s custody is its own key store (OrgAI CLI Vault), not "OrgAI Vault"', custody || doctor.out.slice(0, 300))
} catch (e) {
  check(false, 'separation ran to the end', e instanceof Error ? e.stack : String(e))
} finally {
  if (held?.alive()) held.child.kill('SIGKILL')
  await cleanup(session?.app, session?.page, APP_PROJECT)
  removeFixture(repoA)
  removeFixture(repoB)
  for (const d of [path.dirname(B), path.dirname(C), keyDir, PARENT]) fs.rmSync(d, { recursive: true, force: true })
}
finish('separation')
