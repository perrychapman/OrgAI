// Shared helpers for the OrgAI end-to-end scripts. Each script launches the BUILT app (run `npm run build` first)
// with playwright-core's Electron driver, works against a throwaway fixture repository under os.tmpdir(), and
// removes its OrgAI project at the end. The app runs against a fresh temp data dir per script (ORGAI_DATA_DIR, which
// replaces userData and holds the logs too), or against E2E_DATA_DIR if you set it yourself. A plain ORGAI_DATA_DIR in the environment (CI sets one to keep strays off
// the runner's profile) is ignored: scripts leave library entries and settings behind that would change the next script.
import { _electron as electron } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// Test isolation: ORGAI_VAULT_NO_OS_KEYSTORE (the app's vault) and ORGAI_CLI_VAULT_NO_OS_KEYSTORE (the orgai CLI's own
// vault, a separate product) keep the vaults off the OS keystore for every app, CLI or helper an e2e script starts.
// Every child inherits process.env, so setting them here (an import side effect, before any launch) covers launch(),
// startCli() and the pty driver. A script that names its own key file (ORGAI_VAULT_KEY_FILE, ORGAI_CLI_VAULT_KEY_FILE)
// keeps it; the flags are harmless beside it.
process.env.ORGAI_VAULT_NO_OS_KEYSTORE = '1'
process.env.ORGAI_CLI_VAULT_NO_OS_KEYSTORE = '1'
// Electron's own safeStorage (the app's older secrets.json) would otherwise create a "... Safe Storage" keychain item on
// macOS. Only launch() passes Chromium's --use-mock-keychain (key kept in memory); apps started elsewhere (cli-readonly,
// verify-pack) do not, so they can still reach the real keychain through safeStorage.

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url))
export const APP_DIR = path.resolve(E2E_DIR, '..')
export const SHOTS_DIR = path.join(E2E_DIR, 'shots')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ---------- One slow-runner scale for every wait ----------
// The CI runners are two cores and a software GPU; the same product code passed or failed a script depending on how slow the
// runner happened to be (a 65 to 92 minute chain, a different script red each time). TIME_SCALE stretches how long a WAIT may
// take, never how long anything is allowed to sleep for ordering: a wait ends the moment its state is there, so a fast machine
// loses nothing, and a slow one gets room. E2E_TIME_SCALE=N sets it; the default is 1, and 3 when CI is set.
// It is applied to Playwright's default timeout and navigation timeout on EVERY window of a launched app (the app's 'window'
// event, so a window a script opens later is covered), to any page.setDefaultTimeout a script calls afterwards (the call is
// scaled, so `page.setDefaultTimeout(8000)` means 8 s at scale 1), and to the shared helpers below. Scripts use t(ms) for their
// own explicit timeouts: `{ timeout: t(8000) }`, the deadline of a poll loop. Do NOT wrap a sleep that orders two things in t():
// wait on the state instead (a MutationObserver installed before the action, a standing state, a mock hold).
const scaleEnv = Number(process.env.E2E_TIME_SCALE)
export const TIME_SCALE = Number.isFinite(scaleEnv) && scaleEnv > 0 ? scaleEnv : process.env.CI ? 3 : 1
export const t = (ms) => (ms === 0 || !Number.isFinite(ms) ? ms : Math.round(ms * TIME_SCALE))
let scaleLogged = false
const logScaleOnce = () => {
  if (scaleLogged) return
  scaleLogged = true
  log(`time scale ${TIME_SCALE} (E2E_TIME_SCALE; default 3 when CI is set, else 1): every wait may take ${TIME_SCALE} times as long`)
}

/**
 * Scale one Playwright page: its default timeout and navigation timeout (Playwright's 30 s times the scale), and any later
 * page.setDefaultTimeout call by a script. Safe to call twice on a page.
 */
export function scalePage(page) {
  if (page.__orgaiScaled) return page
  page.__orgaiScaled = true
  const setTimeoutOrig = page.setDefaultTimeout.bind(page)
  page.setDefaultTimeout = (ms) => setTimeoutOrig(t(ms))
  setTimeoutOrig(t(30_000))
  page.setDefaultNavigationTimeout(t(30_000))
  return page
}

/**
 * Scale every window of an Electron app: those open now and any opened later (a run window, a second window), so no script
 * can miss one. launch() calls this; a script that starts Electron itself calls it right after electron.launch().
 */
export function scaleApp(app) {
  logScaleOnce()
  for (const w of app.windows()) scalePage(w)
  app.on('window', (w) => scalePage(w))
  return app
}

/** Poll `fn` (sync or async; a throw counts as false) until it returns something truthy, which is returned; null after `ms` (scaled). */
export async function until(fn, ms = 10_000, every = 150) {
  const end = Date.now() + t(ms)
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* keep polling */
    }
    if (Date.now() > end) return null
    await sleep(every)
  }
}

/** os.tmpdir() with symlinks resolved (macOS: /var/folders/... is /private/var/folders/...), as the app reports paths. */
export const TMP = fs.realpathSync.native(os.tmpdir())

// One data dir per script run, shared by every launch() in it (history.mjs restarts the app). A dir we created is
// removed when the script passes and kept (path printed) when it fails, so its logs/main.log can be read.
const ownDataDir = !process.env.E2E_DATA_DIR?.trim()
export const DATA_DIR = ownDataDir ? fs.mkdtempSync(path.join(TMP, 'orgai-e2e-data-')) : path.resolve(process.env.E2E_DATA_DIR.trim())
process.on('exit', (code) => {
  if (!ownDataDir) return
  let used = true
  try {
    used = fs.readdirSync(DATA_DIR).length > 0
  } catch {
    used = false
  }
  if ((code || process.exitCode) && used) {
    console.log(`data dir kept for inspection: ${DATA_DIR}`)
    return
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* a file the app still holds; the OS temp cleaner gets it */
  }
})

/** Path of the Electron binary. The `electron` package's main export is that path (electron.exe on Windows). */
export function electronBinary() {
  const require = createRequire(path.join(APP_DIR, 'package.json'))
  const bin = require('electron')
  if (typeof bin !== 'string' || !fs.existsSync(bin)) throw new Error(`Electron binary not found (got ${bin}). Run npm install.`)
  return bin
}

// ---------- Checks ----------

const failures = []

/** Record a check. Failures are collected and reported by `finish()`. */
export function check(ok, what, detail = '') {
  if (ok) log(`PASS ${what}`)
  else {
    failures.push(what)
    log(`FAIL ${what}${detail ? ` -- ${detail}` : ''}`)
  }
  return ok
}

/** Print the summary and set the exit code. */
export function finish(name) {
  if (failures.length) {
    console.log(`\n${name}: ${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`)
    process.exitCode = 1
  } else console.log(`\n${name}: all checks passed`)
}

/** For token-spending scripts: print the cost warning and exit unless --yes was passed. */
export function requireYes(name, estimate) {
  console.log(`\n${name} drives REAL agent sessions and spends API tokens (roughly ${estimate}).`)
  if (!process.argv.includes('--yes')) {
    console.log('Re-run with --yes to proceed.\n')
    process.exit(2)
  }
  console.log('--yes given; proceeding.\n')
}

// ---------- Fixture repository ----------

const GIT_ID = ['-c', 'user.name=OrgAI E2E', '-c', 'user.email=e2e@orgai.local']

export function git(cwd, args) {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Like git() but returns `ERR …` instead of throwing; for diagnostics. */
export function gitSafe(cwd, args) {
  try {
    return git(cwd, args)
  } catch (e) {
    return `ERR ${String(e.message).split('\n')[0]}`
  }
}

export function writeFile(root, rel, content) {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

/**
 * A tiny Express notes API in a fresh git repo under os.tmpdir(). Dependencies are not installed.
 * Returns the absolute path (Windows separators on Windows, which is what users type into the form).
 */
export function makeFixtureRepo(tag = 'fixture', { initGit = true, at } = {}) {
  if (at) fs.mkdirSync(at, { recursive: true })
  const root = at ?? fs.mkdtempSync(path.join(TMP, `orgai-e2e-${tag}-`))
  writeFile(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'tiny-notes-api',
        version: '0.1.0',
        type: 'module',
        scripts: { start: 'node src/server.js', test: 'node --test test/*.test.js' },
        dependencies: { express: '^4.19.2' }
      },
      null,
      2
    ) + '\n'
  )
  writeFile(root, 'README.md', '# tiny-notes-api\n\nA small Express API for storing notes in memory. Used as an OrgAI e2e fixture.\n\n- `npm start` runs the server on port 3000\n- `npm test` runs node\'s built-in test runner\n')
  writeFile(root, '.gitignore', 'node_modules/\n')
  writeFile(
    root,
    'src/server.js',
    `import express from 'express'
import { createStore } from './store.js'

const app = express()
app.use(express.json())
const store = createStore()

app.get('/notes', (_req, res) => res.json(store.list()))
app.post('/notes', (req, res) => {
  const note = store.add(String(req.body?.text ?? ''))
  res.status(201).json(note)
})

app.listen(3000, () => console.log('listening on 3000'))
`
  )
  writeFile(
    root,
    'src/store.js',
    `export function createStore() {
  const notes = []
  return {
    list: () => notes.slice(),
    add: (text) => {
      const note = { id: notes.length + 1, text, createdAt: new Date().toISOString() }
      notes.push(note)
      return note
    }
  }
}
`
  )
  writeFile(
    root,
    'test/store.test.js',
    `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.js'

test('adds and lists notes', () => {
  const s = createStore()
  s.add('hello')
  assert.equal(s.list().length, 1)
})
`
  )
  if (initGit) {
    git(root, ['init', '-q', '-b', 'main'])
    // The app's own git calls (merges) run without -c; give the repo an identity.
    git(root, ['config', 'user.name', 'OrgAI E2E'])
    git(root, ['config', 'user.email', 'e2e@orgai.local'])
    git(root, ['config', 'core.autocrlf', 'false'])
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'initial notes api'])
  }
  return root
}

export function removeFixture(root) {
  if (!root || !root.startsWith(TMP)) return
  try {
    if (fs.existsSync(path.join(root, '.git'))) gitSafe(root, ['worktree', 'prune'])
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch (e) {
    log('could not remove fixture', root, e.message)
  }
}

// ---------- App ----------

/** The content size the app's default window has on a normal screen (1440x920 window: 1424x881 inside its frame on Windows). */
export const DEFAULT_CONTENT = { width: 1424, height: 881 }

/**
 * Give every script the window a normal screen gives it. The macOS CI runner has a 1024x684 work area, and the window opens
 * clamped to it (ORGAI_WINDOW_LARGER_THAN_SCREEN only lets a later setContentSize exceed the screen): the sidebar is then
 * the rail (no Inbox badge, only its rail count), the run frame is compact (a shell permission lands on Details, not on
 * Allow) and the project form folds, so a script that reads the default window measured another layout than on Windows.
 * Scripts that test a size call setContentSize themselves; this only widens a window that is smaller than the default,
 * so on a normal screen nothing changes.
 */
export async function ensureDefaultViewport(app, page) {
  // E2E_CLAMP_WINDOW=1024x656 makes the window open at that size, as the macOS CI runner's 1024x684 work area does (a titled
  // window's content is shorter than the work area), so this widening can be tried on any machine.
  const clamp = /^(\d+)x(\d+)$/.exec(process.env.E2E_CLAMP_WINDOW ?? '')
  if (clamp) {
    await app.evaluate(({ BrowserWindow }, [nw, nh]) => BrowserWindow.getAllWindows()[0].setContentSize(nw, nh), [Number(clamp[1]), Number(clamp[2])])
    await page.waitForFunction((x) => Math.abs(window.innerWidth - x) <= 1, Number(clamp[1]), { timeout: t(10_000) }).catch(() => {})
  }
  const [cw, ch] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
  if (cw >= DEFAULT_CONTENT.width && ch >= DEFAULT_CONTENT.height) return
  const w = Math.max(cw, DEFAULT_CONTENT.width)
  const h = Math.max(ch, DEFAULT_CONTENT.height)
  log(`window opened at ${cw}x${ch}; widening to ${w}x${h} (a small screen clamps the default window)`)
  await app.evaluate(({ BrowserWindow }, [nw, nh]) => BrowserWindow.getAllWindows()[0].setContentSize(nw, nh), [w, h])
  await page.waitForFunction((x) => Math.abs(window.innerWidth - x) <= 1, w, { timeout: t(10_000) }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
}

/**
 * Launch the built app and wait until the renderer is up. Returns { app, page, shot }.
 * Dialogs (confirm()) are accepted automatically; renderer console errors are logged.
 */
export async function launch({ shotPrefix = 'shot', clearPrefs = true, welcome = false } = {}) {
  if (!fs.existsSync(path.join(APP_DIR, 'out', 'main', 'index.js'))) throw new Error('out/main/index.js missing. Run `npm run build` first.')
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  // process.env is read here, so flags a script sets before launching (ORGAI_MOCK=1) still reach the app.
  const app = await electron.launch({ executablePath: electronBinary(), args: ['--use-mock-keychain', APP_DIR], cwd: APP_DIR, timeout: t(60_000), env: { ...process.env, ORGAI_DATA_DIR: DATA_DIR } })
  // Before anything is awaited on a window: the scale covers this window and every one the app opens later.
  scaleApp(app)
  const page = await app.firstWindow()
  scalePage(page)
  page.on('dialog', (d) => {
    log('dialog:', d.message().slice(0, 100))
    void d.accept()
  })
  page.on('console', (m) => {
    if (m.type() === 'error') log('console.error:', m.text().slice(0, 200))
  })
  page.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 200)))
  await page.waitForSelector('.sidebar', { timeout: t(60_000) })
  await ensureDefaultViewport(app, page)
  // E2E_CPU_THROTTLE=4 slows the renderer four times (CDP Emulation.setCPUThrottlingRate), to reproduce on a fast machine the
  // races a slow CI runner shows. Opt-in; nothing changes without it.
  const throttle = Number(process.env.E2E_CPU_THROTTLE)
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
    log('cpu throttle', throttle)
  }
  // A shared ORGAI_DATA_DIR (CI) keeps the renderer's localStorage between scripts, so an earlier script's UI choices
  // (orgai.sidebar, orgai.sidePanel.*, widths) would leak into this one. Start every script from auto state; projects
  // and runs live in the main process data and are untouched.
  const cleared = !clearPrefs ? [] : await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('orgai.'))
    keys.forEach((k) => localStorage.removeItem(k))
    return keys
  })
  if (cleared.length) {
    log('cleared stale UI preferences from a shared data dir:', cleared.join(', '))
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: t(60_000) })
  }
  // First launch opens on the three setup steps (FirstLaunch, ui-overhaul Welcome). Scripts start past them, on the
  // start choice and its New project form, unless they ask for the steps with `welcome: true`.
  if (!welcome) {
    const onSetup = await page.evaluate(() => {
      localStorage.setItem('orgai.welcome.done', '1')
      return !!document.querySelector('[data-testid=welcome-setup]')
    })
    if (onSetup) {
      await page.reload()
      await page.waitForSelector('.sidebar', { timeout: t(60_000) })
    }
  }
  // A relaunch on existing data may open on the dashboard or a run.
  if (clearPrefs) await page.waitForSelector('[data-testid=dashboard], .editor', { timeout: t(60_000) })
  let n = 0
  const shot = (name) => screenshot(page, `${shotPrefix}-${String(++n).padStart(2, '0')}-${name}`)
  return { app, page, shot }
}

/**
 * Quit the running app and start it again on the SAME data dir (runs, projects and the renderer's localStorage stay,
 * so open tabs and widths are restored). Returns { app, page, shot } like launch(). Runs that were live when the app
 * quit come back as 'Ended when OrgAI closed'.
 */
export async function relaunch(app, { shotPrefix = 'shot' } = {}) {
  await app.close().catch(() => {})
  return launch({ shotPrefix, clearPrefs: false })
}

export async function screenshot(page, name) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  const file = path.join(SHOTS_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  log('shot', path.relative(APP_DIR, file))
  return file
}

export async function gotoProjects(page) {
  // The Home row (data-testid nav-home, also in the rail) first; older trees fall back to the Dashboard / Projects row.
  await page
    .locator('[data-testid=nav-home]')
    .or(page.locator('.sidebar .nav-item', { hasText: /^\s*(Home|Dashboard|Projects)\s*$/ }))
    .or(page.locator('.sidebar [aria-label="Dashboard"], .sidebar [aria-label="All projects"]'))
    .first()
    .click()
  await page.waitForSelector('[data-testid=dashboard]', { timeout: t(10_000) })
}

/**
 * Open the new-project form. With projects it sits in `new-project-dialog` behind the topbar "New project" button;
 * on first launch it is the inline form of the Dashboard. Returns the form locator.
 */
export async function openProjectForm(page) {
  const trigger = page.locator('[data-testid=new-project]')
  if (await trigger.count()) {
    await trigger.click()
    const form = page.locator('[data-testid=new-project-dialog] form')
    await form.waitFor({ timeout: t(10_000) })
    return form
  }
  // First launch on the setup steps (a script that launched the app itself): skip to the start choice.
  const skip = page.locator('[data-testid=welcome-setup] [data-testid=welcome-skip]')
  if (await skip.isVisible().catch(() => false)) await skip.click()
  // First launch: "Start a project" is checked by default.
  const choice = page.locator('[data-testid=dash-start-choice]').getByRole('radio', { name: 'Start a project' })
  if (!(await choice.isChecked())) await choice.check({ force: true })
  const form = page.locator('[data-testid=dashboard] form.project-form')
  await form.waitFor({ state: 'visible', timeout: t(10_000) })
  return form
}

/**
 * Choose whether the new project runs the Architect setup. The form shows either the "Set up with the Architect"
 * checkbox (`architect-setup`; checked = run setup) or, when templates (the built-in charts count) or importable agents
 * exist, the "How should the team start?" fieldset (`setup-choice`), whose radios are picked by value: 'architect'
 * runs setup, 'default' starts with the default roles. Both start on the Architect interview on a fresh profile.
 */
export async function pickSetup(form, skipSetup) {
  const box = form.locator('[data-testid=architect-setup]')
  const fieldset = form.locator('[data-testid=setup-choice]')
  await box.or(fieldset).first().waitFor({ timeout: t(30_000) })
  if (await box.count()) {
    if ((await box.isChecked()) === skipSetup) await form.locator('label.checkbox', { hasText: /Set up with the Architect|Start with the setup interview/ }).click()
    if ((await box.isChecked()) === skipSetup) throw new Error('could not toggle "Set up with the Architect"')
    return
  }
  const radio = fieldset.locator(`input[type=radio][value=${skipSetup ? 'default' : 'architect'}]`)
  // The form's submit row is sticky: Playwright's own scroll can leave the last radio underneath it, and a forced click
  // then lands on "Create project" (it created the project with the Architect choice). Centre the radio first.
  await checkRadio(radio, `the "${skipSetup ? 'default' : 'architect'}" setup choice`)
}

/**
 * Choose a radio of a form so it stays chosen, on any speed of renderer. A forced click lands on whatever is on top at the
 * radio's centre and the form's submit row is sticky, so the radio is centred first; Playwright then verifies the state right
 * after the click, and a controlled radio whose re-render is a frame or more behind (a slow CI runner, or the first-launch
 * form re-rendering under the click) reads "Clicking the checkbox did not change its state" although nothing is wrong. The
 * locator is resolved again on each try, so a radio that was replaced by a re-render is found, and a try that finds it already
 * chosen clicks nothing. Says so in the log when a second try was needed. (CI macOS 2026-11-24: self-help; two runs earlier:
 * maintenance, on the "Existing code" radio.) Every script that picks a radio of the project form goes through this.
 */
export async function checkRadio(radio, what = 'radio') {
  for (let attempt = 0; ; attempt++) {
    try {
      await radio.waitFor({ state: 'attached', timeout: t(10_000) })
      await radio.evaluate((el) => el.scrollIntoView({ block: 'center' }), undefined, { timeout: t(10_000) })
      await radio.check({ force: true, timeout: t(10_000) })
      if (await until(() => radio.isChecked(), 3000, 100)) return
      throw new Error(`${what} did not stay chosen`)
    } catch (e) {
      if (attempt >= 3) throw e
      log(`${what}: the choice did not stick (${String(e.message).split('\n')[0]}); choosing again`)
      await sleep(500)
    }
  }
}

/**
 * Create a project through the New project form.
 * mode: 'existing' (repository folder) or 'new' (idea + folder). skipSetup: tick "Skip AI setup" (token-free).
 * Resolves once the app has navigated away from the projects view.
 */
export async function createProject(page, { mode = 'existing', path: dir, name, brief = '', skipSetup = true, useMock = true }) {
  await gotoProjects(page)
  const form = await openProjectForm(page)
  // Two radios: what the project is for (code) and how it starts. A forced click lands on whatever is on top at the radio's
  // centre, and the form's submit row is sticky, so centre each radio first, as pickSetup does. The macOS CI run failed on
  // the second one with "Clicking the checkbox did not change its state" (click performed, nothing changed): either the
  // click did not reach the radio or the first-launch form re-rendered over it, as the submit click below also guards
  // against. Neither reproduced on Windows (also at a 1024x656 window), so verify the pair and choose again if it did not
  // stick, saying so in the log, instead of failing the whole script on one lost click.
  const kindRadio = form.locator('[data-testid=project-kind-option][data-kind=code] input[type=radio]')
  const modeRadio = form.getByRole('radio', { name: mode === 'new' ? 'New idea' : 'Existing code', exact: true })
  const choose = (radio) => checkRadio(radio, 'create project: the kind / mode choice')
  for (let attempt = 0; ; attempt++) {
    try {
      await choose(kindRadio)
      await choose(modeRadio)
      await sleep(250)
      if ((await kindRadio.isChecked()) && (await modeRadio.isChecked())) break
      throw new Error('the kind and mode radios did not both stay checked')
    } catch (e) {
      if (attempt >= 3) throw e
      log(`create project: the kind / mode choice did not stick (${String(e.message).split('\n')[0]}); choosing again`)
      await sleep(500)
    }
  }
  if (mode === 'new') {
    await form.locator('input[placeholder="My app"]').fill(name)
    await form.locator('textarea').first().fill(brief)
    await form.locator('input[placeholder*="new-folder"]').fill(dir)
  } else {
    await form.locator('input[placeholder*="repo"]').fill(dir)
    await form.locator('input[placeholder*="Defaults to the folder name"]').fill(name)
    if (brief) await form.locator('textarea').first().fill(brief)
  }
  await pickSetup(form, skipSetup)
  // The mock checkbox only exists under ORGAI_MOCK=1 and is on by default; useMock: false saves the project with the real adapter.
  const mock = form.locator('[data-testid=use-mock]')
  if ((await mock.count()) && (await mock.isChecked()) !== useMock) await form.locator('label.checkbox', { hasText: 'Use the mock adapter' }).click()
  const submit = form.getByRole('button', { name: skipSetup ? 'Create project' : 'Create and start setup' })
  // The dashboard (and its dialog or form) goes away once the project exists and the app navigates to it.
  // A click can be lost when the first-launch inline form re-renders as the app finishes loading (CI run 42181924350:
  // the filled form was still showing after 120 s with no project made), so re-click, but only while no project of
  // this name exists yet.
  for (let attempt = 0; ; attempt++) {
    await submit.click()
    try {
      await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: attempt < 3 ? 20_000 : 120_000 })
      break
    } catch (e) {
      if (attempt >= 3 || (await findProject(page, name)) || !(await submit.count())) throw e
      log('create project: submit did not leave the Dashboard, clicking again')
    }
  }
  return await findProject(page, name)
}

/**
 * Turn "Hide finished agents" off in the run view that is on screen. With it on (the default) a report folds into its parent's
 * "done" group COLLAPSE_GRACE_MS (6 s) after it ended, so a check that reads an agent's node, its provider tag or its name at
 * some later moment depends on how fast the machine got there: a quick one reads the node, a slow one (a CI runner) finds a
 * group. A user looking for a named agent turns the fold off; with it off the node is there at any speed. Call it right after
 * the run header is up, before the agents can finish. The choice is the renderer's own (localStorage orgai.collapseFinished).
 */
export async function showFinishedAgents(page) {
  const fold = page.getByRole('switch', { name: 'Hide finished agents' })
  await fold.waitFor({ state: 'attached', timeout: t(15_000) })
  if ((await fold.getAttribute('aria-checked')) === 'true') await fold.click()
  await until(async () => (await fold.getAttribute('aria-checked')) === 'false', 5000)
}

/** The project as the main process stores it, looked up by name. */
export async function findProject(page, name) {
  const list = await page.evaluate(() => window.orgai.projects.list())
  return list.find((p) => p.name === name)
}

/** Open a project from the sidebar. */
export async function openProject(page, name) {
  await page.locator(`.sidebar [data-testid=nav-project][data-name="${name.replace(/"/g, '\\"')}"]`).first().click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: t(10_000) })
}

/** Delete every project tile with this name. Returns how many tiles remain (0 on success). */
export async function deleteProject(page, name) {
  await gotoProjects(page)
  const tiles = () => page.locator(`[data-testid=project-tile][data-name="${name.replace(/"/g, '\\"')}"]`)
  for (let i = 0; i < 5; i++) {
    const tile = tiles().first()
    const before = await tiles().count()
    if (!before) break
    await tile.locator('[data-testid=project-tile-more]').click()
    await page.locator('[data-testid=project-tile-delete]').click()
    await page.getByRole('button', { name: /^(Delete project|Forget engagement)$/ }).click()
    // The tile goes once the main process has removed the project (a fixed sleep read the count too early on a slow runner).
    await until(async () => (await tiles().count()) < before, 10_000)
    await sleep(300)
  }
  return tiles().count()
}

/** End a live session if the button is there. `timeout` is for the click (a renderer busy with a very large run answers late). */
export async function endSession(page, { timeout } = {}) {
  const end = page.getByRole('button', { name: 'End session' })
  if (await end.count()) {
    await end.click(timeout ? { timeout } : undefined)
    // The button goes when the session has ended; callers go on from there (a fixed sleep alone was a guess on a slow runner).
    await end.first().waitFor({ state: 'detached', timeout: t(8000) }).catch(() => {})
    await sleep(1500)
  }
}

/** Best-effort cleanup for a finally block: delete the project and close the app. */
export async function cleanup(app, page, name) {
  try {
    if (page && !page.isClosed()) {
      await endSession(page).catch(() => {})
      const left = await deleteProject(page, name)
      check(left === 0, `project "${name}" deleted`, `${left} card(s) left`)
    }
  } catch (e) {
    check(false, `project "${name}" deleted`, e.message)
  }
  await app?.close().catch(() => {})
}

// ---------- Token-spending helpers ----------

/**
 * Drive a setup session until the project's setup is complete (or the deadline passes).
 * decide(kind, proposal) returns 'approve' or a feedback string to request changes.
 * Nudges the Architect when it waits on a question. Returns { done, approved }.
 */
export async function driveSetup(page, name, { deadlineMs = 12 * 60_000, decide = () => 'approve', shot } = {}) {
  const started = Date.now()
  const approved = []
  let nudges = 0
  let lastNudge = 0
  while (Date.now() - started < deadlineMs) {
    const proposal = page.locator('article.decision-card').first()
    if (await proposal.count()) {
      const kind = await proposal.getAttribute('data-kind')
      const title = await proposal.locator('.decision-title').innerText().catch(() => '')
      log(`proposal [${kind}] "${title}"`)
      if (shot) await shot(`proposal-${kind}`)
      const verdict = decide(kind, proposal)
      if (verdict === 'approve') {
        await proposal.getByRole('button', { name: 'Approve' }).click()
        approved.push(kind)
        log('approved', kind)
      } else {
        await proposal.getByRole('button', { name: 'Request changes' }).click()
        await proposal.locator('textarea').fill(verdict)
        await proposal.getByRole('button', { name: 'Send feedback' }).click()
        log('requested changes on', kind)
      }
      await sleep(2500)
      continue
    }
    const p = await findProject(page, name)
    if (p?.setup?.state === 'complete') return { done: true, approved }

    const activity = await page.locator('.agent-node .activity').first().innerText().catch(() => '')
    if (/Waiting for you/i.test(activity) && Date.now() - lastNudge > 25_000 && nudges < 4) {
      nudges++
      lastNudge = Date.now()
      const last = await page.locator('.transcript .entry.text').last().innerText().catch(() => '')
      log('architect says:', last.replace(/\s+/g, ' ').slice(0, 300))
      const ta = page.locator('.composer textarea')
      await ta.fill('Proceed with your best judgment. No further questions needed; propose when ready.')
      await ta.press('Enter')
      log('nudged')
    }
    const status = await page.locator('.run-tab[aria-selected=true]').first().innerText().catch(() => '')
    if (/finished|failed|stopped/i.test(status) && !(await page.locator('article.decision-card').count())) {
      log('run ended early, status:', status)
      break
    }
    await sleep(3000)
  }
  return { done: false, approved }
}

/** Directory holding per-run record files: <userData>/data/runs, where userData is the ORGAI_DATA_DIR the app got. */
export function runRecordsDir() {
  return path.join(DATA_DIR, 'data', 'runs')
}

/** A tab of the project topbar (Live, History, Team, Settings). */
export function projectTab(page, name) {
  // A tab with a count badge is named "<label>, <countLabel>" (Team: ", N suggestions"), so match the bare
  // label or the label plus that suffix, and nothing looser.
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${esc}(, \\d+\\+? [a-z ]+)?$`)
  return page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: re })
}

/** Open the project's Team tab (`tab-team`). */
export async function openTeam(page) {
  await page.locator('[data-testid=tab-team]').click()
  await page.locator('.editor [data-testid=team-panel-tabs]').waitFor({ state: 'visible', timeout: t(10_000) })
}

/** The Role | Catalog tab of the Team side panel. */
export function teamPanelTab(page, name) {
  return page.getByRole('tablist', { name: 'Team panel' }).getByRole('tab', { name, exact: true })
}

/** Open App settings through the sidebar gear. */
export async function openAppSettings(page) {
  await page.getByRole('button', { name: 'App settings', exact: true }).click()
}

/**
 * How far a deep link shifted the window (ux-review-config-2 N1): `<html>` / `<body>` scrollTop, the app root's top
 * edge, and every ancestor of the settings scroller that is scrolled. All zero / empty when only the scroller moved.
 */
export async function windowShift(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('.settings-scroll')
    const shifted = []
    for (let p = scroller?.parentElement; p; p = p.parentElement) {
      if (p.scrollTop !== 0) shifted.push(`${p.tagName.toLowerCase()}.${String(p.className).split(' ')[0]}:${p.scrollTop}`)
    }
    const root = document.querySelector('#root') ?? document.body
    return {
      html: document.documentElement.scrollTop,
      body: document.body.scrollTop,
      appTop: Math.round(root.getBoundingClientRect().top),
      shifted,
      ok: document.documentElement.scrollTop === 0 && document.body.scrollTop === 0 && Math.round(root.getBoundingClientRect().top) === 0 && shifted.length === 0
    }
  })
}

/**
 * Appearance > Reduce motion ('on' | 'off' | 'system', docs/design/motion.md 5). With 'on', every motion token is ~0 and
 * entry offsets are 0, so state changes are instant. Waits until <html data-reduce-motion> follows.
 */
export async function setReduceMotion(page, mode) {
  await page.evaluate(async (m) => {
    const info = await window.orgai.settings.get()
    const { dataDir: _d, appVersion: _v, ...s } = info
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, reduceMotion: m } })
  }, mode)
  // lib/theme.ts writes data-reduce-motion='on' only for 'on' and removes it otherwise.
  await page
    .waitForFunction((m) => (document.documentElement.getAttribute('data-reduce-motion') === 'on') === (m === 'on'), mode, { timeout: t(5000) })
    .catch(() => {})
}

/** Shortcut: reduced motion on. */
export const motionOff = (page) => setReduceMotion(page, 'on')

/**
 * Wait (at most `ms`) until every finite animation in the document has finished: the view crossfade's short rise
 * (motion.md 3.3) moves a view by a few pixels, so a layout measure taken during it reads a scroll that is not there.
 * Infinite animations (breathing marks) are ignored.
 */
export async function settleMotion(page, ms = 1500) {
  await page
    .evaluate(async (limit) => {
      const finite = document.getAnimations().filter((a) => {
        const end = a.effect?.getComputedTiming?.().endTime
        return typeof end === 'number' && Number.isFinite(end) && a.playState === 'running'
      })
      if (finite.length === 0) return
      await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, limit))])
    }, ms)
    .catch(() => {})
}
