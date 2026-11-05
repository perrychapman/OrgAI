// Unified Electron host lifecycle (cli-spec 3.2(1), Wave 2): --headless-host, second-instance, window-all-closed
// background mode. Mock adapter, no tokens, no CLI and no socket: only the Electron app (run `npm run build` first).
//
// 1. Headless host: no window, daemon.json ready with hostKind 'headless-host'; a plain second launch opens one window
//    in the incumbent; a second --headless-host launch opens none. Both losers exit 0.
// 2. window-all-closed while a run works ([mock:exec-slow], about 30 s of steps): the host stays up and ready; a plain
//    launch brings a window back with the run still live; after End session a run that only waits on the user (the
//    default script, idle) no longer keeps it busy (review H3): closing the window sends the host (it started
//    headless, so it is the background daemon) back to the background, and it quits through its idle exit (6 s here),
//    never at once, ending that waiting run.
// 3. Desktop first: a --headless-host launch against a running desktop host opens no window. Terminal access off
//    removes the listener and daemon.secret and daemon.json says `listening: false`; on brings them back (review M11).
//    The Terminal access text names the same-user trust model and the access level choice is shown (review H2). On
//    macOS closing the desktop host's last window keeps the app (Dock behaviour, review H3).
//
// macOS-only observations: Dock hide / show are not checked here (not visible to the driver). Windows and Linux are
// unverified on this machine (the close prompt "Keep working in the background / Stop and quit" is Windows / Linux only
// and is not driven).
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { APP_DIR, DATA_DIR, SHOTS_DIR, check, createProject, electronBinary, finish, launch, log, makeFixtureRepo, openAppSettings, removeFixture, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E cli host'
// A short idle exit (6 s; polled every 15 s): a background host that still has short background work when its last
// window closes (the Team review after a finished run) goes 'background' and leaves through the idle exit.
const ENV = { ...process.env, ORGAI_MOCK: '1', ORGAI_DATA_DIR: DATA_DIR, ORGAI_DAEMON_IDLE_MINUTES: '0.1' }
delete ENV.ELECTRON_RUN_AS_NODE
const DAEMON_JSON = path.join(DATA_DIR, 'data', 'run', 'daemon.json')

if (!fs.existsSync(path.join(APP_DIR, 'out', 'main', 'index.js'))) throw new Error('out/main/index.js missing. Run `npm run build` first.')

function readDaemon() {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf8'))
  } catch {
    return null
  }
}

async function waitFor(fn, timeoutMs, stepMs = 200) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return v
    await sleep(stepMs)
  }
}

/** Spawn a second launch on the same data dir; resolves with its exit code (or 'timeout'). */
function secondLaunch(extra = []) {
  return new Promise((resolve) => {
    const child = spawn(electronBinary(), [APP_DIR, ...extra], { cwd: APP_DIR, env: ENV, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      resolve('timeout')
    }, 30_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length)

function exited(app) {
  const proc = app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => proc.once('exit', () => resolve(true)))
}

async function preparePage(page) {
  page.on('dialog', (d) => void d.accept())
  page.on('pageerror', (e) => log('pageerror:', e.message.slice(0, 200)))
  await page.waitForSelector('.sidebar', { timeout: 60_000 })
}

let repo
let app
try {
  // ---------- 1. Headless host ----------
  app = await electron.launch({ executablePath: electronBinary(), args: [APP_DIR, '--headless-host'], cwd: APP_DIR, timeout: 60_000, env: ENV })
  const daemon = await waitFor(() => readDaemon()?.state === 'ready' && readDaemon(), 30_000)
  check((await windowCount(app)) === 0, 'a --headless-host boot opens no window')
  check(daemon?.state === 'ready' && daemon?.hostKind === 'headless-host', "daemon.json is ready with hostKind 'headless-host'", JSON.stringify(daemon))

  const firstWindow = app.waitForEvent('window', { timeout: 30_000 })
  const plain = await secondLaunch()
  check(plain === 0, 'a plain second launch exits 0', String(plain))
  const page = await firstWindow
  await waitFor(async () => (await windowCount(app)) === 1, 10_000)
  check((await windowCount(app)) === 1, 'the incumbent opened one window for the plain launch')

  const headless2 = await secondLaunch(['--headless-host'])
  check(headless2 === 0, 'a second --headless-host launch exits 0', String(headless2))
  await sleep(1500)
  check((await windowCount(app)) === 1, 'a --headless-host launch against a running host opens no window')
  check(readDaemon()?.hostInstanceId === daemon?.hostInstanceId, 'the incumbent still owns the data folder')

  // ---------- 2. window-all-closed while busy ----------
  await preparePage(page)
  repo = makeFixtureRepo('cli-host')
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'mock project created in the window')
  await page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: 'Live', exact: true }).click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 15_000 })
  // [mock:exec-slow]: about 30 one-second steps, so the run is working (not waiting on the user) while the window is gone.
  await ta.fill('Background host task [mock:exec-slow]')
  await page.locator('.composer .btn.primary').click()
  const first = await waitFor(async () => (await page.evaluate(() => window.orgai.runs.listLive())).find((r) => r.status === 'running'), 30_000, 300)
  check(!!first, 'the mock run is working', JSON.stringify(first?.status))
  const runId = first?.id

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close()
  })
  await sleep(3000)
  const proc = app.process()
  check(proc.exitCode === null && proc.signalCode === null, 'the host stays up after the last window closed while a run is working')
  check(readDaemon()?.state === 'ready', 'daemon.json stays ready in the background', JSON.stringify(readDaemon()?.state))
  check((await windowCount(app)) === 0, 'no window is left')

  const backWindow = app.waitForEvent('window', { timeout: 30_000 })
  const plain2 = await secondLaunch()
  check(plain2 === 0, 'a plain launch against the background host exits 0', String(plain2))
  const page2 = await backWindow
  await preparePage(page2)
  check((await windowCount(app)) === 1, 'a window is back')
  const live = await page2.evaluate(() => window.orgai.runs.listLive())
  check(live.some((r) => r.id === runId), 'the run is still live after the window came back', JSON.stringify(live.map((r) => r.status)))

  await page2.evaluate((id) => window.orgai.runs.stop(id), runId)
  const ended = await waitFor(async () => (await page2.evaluate(() => window.orgai.runs.listLive())).length === 0, 20_000, 300)
  check(ended, 'End session ends the run')
  // A run that only waits on the user (the default script settles idle or on a card) keeps nothing busy (review H3).
  const waiting = await page2.evaluate(async (pid) => (await window.orgai.runs.start({ projectId: pid, prompt: 'Waiting host task' }))?.id, project?.id).catch(() => undefined)
  const waitingLive = await waitFor(async () => (await page2.evaluate(() => window.orgai.runs.listLive())).some((r) => r.id === waiting), 20_000, 300)
  check(!!waiting && waitingLive, 'a second mock run starts', String(waiting))
  // Waiting on the user: idle, or a decision card open (the default script asks for a permission).
  const isWaiting = async () =>
    page2.evaluate(async (id) => {
      const run = (await window.orgai.runs.listLive()).find((r) => r.id === id)
      if (!run) return false
      if (run.status === 'idle') return true
      const cards = await window.orgai.runs.pendingCards(id)
      return Object.values(cards).some((list) => Array.isArray(list) && list.length > 0)
    }, waiting)
  check((await waitFor(isWaiting, 45_000, 500)) === true, 'the second run settles waiting on the user (idle or a card open)')
  await sleep(2000)
  const quitStarted = Date.now()
  const gone = exited(app)
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close()
  }).catch(() => {})
  await sleep(2000)
  const stillUp = app.process().exitCode === null && app.process().signalCode === null
  check(stillUp, 'an idle close of the last window keeps a host that started headless running (daemon mode)')
  check(readDaemon()?.state === 'ready', 'daemon.json stays ready after the idle close', JSON.stringify(readDaemon()?.state))
  const didExit = await Promise.race([gone, sleep(60_000).then(() => false)])
  check(didExit === true, 'the background daemon then leaves through its idle exit', `after ${Date.now() - quitStarted} ms`)
  if (didExit) log(`host exited ${Date.now() - quitStarted} ms after the windows closed`)
  check((await waitFor(() => !fs.existsSync(DAEMON_JSON), 5000)) === true, 'daemon.json is removed on quit')
  app = undefined

  // ---------- 3. Desktop first ----------
  const desktop = await launch({ shotPrefix: 'cli-host' })
  app = desktop.app
  check((await windowCount(app)) === 1, 'a desktop launch opens one window')
  check((await waitFor(() => readDaemon()?.hostKind === 'desktop', 10_000)) === true, "daemon.json names hostKind 'desktop'", JSON.stringify(readDaemon()))
  const headless3 = await secondLaunch(['--headless-host'])
  check(headless3 === 0, 'a --headless-host launch against the desktop host exits 0', String(headless3))
  await sleep(1500)
  check((await windowCount(app)) === 1, 'the desktop host opened no new window for it')

  // Terminal access switch (App settings > General > Advanced settings). The headless boots above opened it for their
  // own session only and never saved it (review H2), so the desktop host starts with it off.
  const p3 = desktop.page
  await openAppSettings(p3)
  const adv = p3.locator('[data-testid=settings-advanced][data-pane=app-general]')
  await adv.waitFor({ timeout: 10_000 })
  if (!(await adv.evaluate((el) => el.open))) await adv.locator('> summary').click()
  const sw = p3.locator('[data-testid=terminal-server-switch]')
  await sw.waitFor({ timeout: 10_000 })
  const before = await p3.evaluate(() => window.orgai.settings.get().then((s) => s.terminalServer))
  check(before === false && (await sw.getAttribute('aria-checked')) === 'false', 'Terminal access stays off (not saved) after a headless boot', String(before))
  // Review M11: the listener and daemon.secret exist only while Terminal access is on.
  const SECRET = path.join(DATA_DIR, 'data', 'run', 'daemon.secret')
  const endpoint = readDaemon()?.endpoint
  const listenerUp = () => readDaemon()?.listening === undefined && fs.existsSync(SECRET) && (process.platform === 'win32' || (!!endpoint && fs.existsSync(endpoint)))
  const listenerDown = () => readDaemon()?.listening === false && !fs.existsSync(SECRET) && (process.platform === 'win32' || (!!endpoint && !fs.existsSync(endpoint)))
  check((await waitFor(listenerDown, 5000)) === true, 'Terminal access off: no listener, no daemon.secret, daemon.json says listening false', JSON.stringify(readDaemon()))
  await sw.click()
  const on = await waitFor(async () => (await p3.evaluate(() => window.orgai.settings.get().then((s) => s.terminalServer))) === true, 5000)
  check(on === true && (await sw.getAttribute('aria-checked')) === 'true', 'turning Terminal access on saves terminalServer true')
  check((await waitFor(listenerUp, 5000)) === true, 'with Terminal access on the desktop host listens and has daemon.secret', JSON.stringify(readDaemon()))
  await sw.click()
  const off = await waitFor(async () => (await p3.evaluate(() => window.orgai.settings.get().then((s) => s.terminalServer))) === false, 5000)
  check(off === true && (await sw.getAttribute('aria-checked')) === 'false', 'turning it off again saves terminalServer false')
  check((await waitFor(listenerDown, 5000)) === true, 'Terminal access off again: the listener and daemon.secret are gone', JSON.stringify(readDaemon()))
  check(readDaemon()?.state === 'ready' && readDaemon()?.endpoint === endpoint, 'daemon.json stays ready and keeps naming the endpoint')
  // Review H2: the row names the same-user trust model; the access level choice sits under it.
  const desc = (await p3.locator('#terminal-server-row-desc').textContent().catch(() => '')) ?? ''
  check(/any program you run/.test(desc) && /agent shells/.test(desc), 'the Terminal access text says any program you run, agent shells included, can control OrgAI', desc)
  const level = p3.locator('[data-testid=terminal-access-level] select')
  check((await level.count()) === 1 && (await level.inputValue().catch(() => '')) === 'operate', "the access level choice is shown and starts at 'operate'")

  // orgai command row (cli-spec 7(3), Wave 6), right under Terminal access. A dev build always reports 'unavailable',
  // so only that state is driven here; install, update and remove are covered by the unit tests in lib/cliShim.test.ts.
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(300)
    for (const theme of ['dark', 'light']) {
      await p3.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      const at = `${w}x${h} ${theme}`
      const row = p3.locator('[data-testid=cli-shim-row]')
      await row.waitFor({ timeout: 10_000 }).catch(() => {})
      check(await row.isVisible(), `orgai command row is visible (${at})`)
      const order = await p3.evaluate(() => {
        const sw = document.querySelector('[data-testid=terminal-server-switch]')
        const r = document.querySelector('[data-testid=cli-shim-row]')
        return !!sw && !!r && (sw.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && sw.closest('.settings-card') === r.closest('.settings-card')
      })
      check(order, `the row sits under Terminal access in the same card (${at})`)
      const status = p3.locator('[data-testid=cli-shim-status]')
      const state = await waitFor(async () => (await status.getAttribute('data-state').catch(() => null)) === 'unavailable', 5000)
      check(state === true, `the status line says unavailable in a dev build (${at})`, String(await status.getAttribute('data-state').catch(() => null)))
      const text = (await status.textContent().catch(() => '')) ?? ''
      check(text.trim().length > 0 && !/undefined|null/.test(text), `the status line has a plain sentence (${at})`, text)
      check((await p3.locator('[data-testid=cli-shim-install]').count()) === 0, `no Install button when unavailable (${at})`)
      check((await p3.locator('[data-testid=cli-shim-remove]').count()) === 0, `no Remove button when unavailable (${at})`)
      check((await p3.locator('[data-testid=cli-shim-path-hint]').count()) === 0, `no PATH hint when unavailable (${at})`)
      // Bring the row into view through the settings scroller only (scrollIntoView could shift its ancestors).
      await row.evaluate((el) => {
        const sc = el.closest('.settings-scroll')
        if (sc) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 40
      })
      await sleep(100)
      await p3.screenshot({ path: path.join(SHOTS_DIR, `cli-shim-${w}x${h}-${theme}.png`) }).catch(() => {})
      const shift = await windowShift(p3)
      check(shift.ok, `the window did not scroll (${at})`, JSON.stringify(shift))
      const fits = await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
      check(fits, `the row does not overflow sideways (${at})`)
    }
  }

  // Leave the data dir clean: forget the project made in scenario 2.
  const projects = await p3.evaluate(() => window.orgai.projects.list())
  for (const p of projects.filter((x) => x.name === NAME)) await p3.evaluate((id) => window.orgai.projects.remove(id), p.id).catch(() => {})
  if (process.platform === 'darwin') {
    // Review H3: on macOS closing the desktop host's last window keeps the app running (Dock), never the background.
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.close()
    })
    await sleep(2000)
    const up = app.process().exitCode === null && app.process().signalCode === null
    check(up && (await windowCount(app)) === 0, 'macOS: closing the last desktop window keeps OrgAI running')
  }
  const gone3 = exited(app)
  await app.close().catch(() => {})
  check((await Promise.race([gone3, sleep(20_000).then(() => false)])) === true, 'the desktop host quits')
  app = undefined
} catch (e) {
  check(false, 'cli-host run', e?.stack ?? String(e))
} finally {
  await app?.close().catch(() => {})
  removeFixture(repo)
  finish('cli-host')
}
