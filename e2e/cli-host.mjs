// Unified Electron host lifecycle (cli-spec 3.2(1), Wave 2): --headless-host, second-instance, window-all-closed
// background mode. Mock adapter, no tokens, no CLI and no socket: only the Electron app (run `npm run build` first).
//
// 1. Headless host: no window, daemon.json ready with hostKind 'headless-host'; a plain second launch opens one window
//    in the incumbent; a second --headless-host launch opens none. Both losers exit 0.
// 2. window-all-closed while busy (a live idle mock run): the host stays up and ready; a plain launch brings a window
//    back with the run still live; after End session closing the window quits the host (it started headless): at
//    once when nothing is counted busy, else through the idle exit once its background work ends.
// 3. Desktop first: a --headless-host launch against a running desktop host opens no window.
//
// macOS-only observations: Dock hide / show are not checked here (not visible to the driver). Windows and Linux are
// unverified on this machine.
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { APP_DIR, DATA_DIR, check, createProject, electronBinary, finish, launch, log, makeFixtureRepo, openAppSettings, removeFixture, sleep } from './lib.mjs'

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
  await ta.fill('Background host task')
  await page.locator('.composer .btn.primary').click()
  // The default mock script settles waiting on the user (idle, or a permission card open): live, nothing to do.
  const first = await waitFor(async () => (await page.evaluate(() => window.orgai.runs.listLive()))[0], 30_000, 300)
  await sleep(4000)
  const settled = (await page.evaluate(() => window.orgai.runs.listLive())).find((r) => r.id === first?.id)
  check(!!settled, 'the mock run settles and stays live', JSON.stringify(settled?.status))
  const runId = settled?.id

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close()
  })
  await sleep(3000)
  const proc = app.process()
  check(proc.exitCode === null && proc.signalCode === null, 'the host stays up after the last window closed while a run is live')
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
  await sleep(2000)
  const quitStarted = Date.now()
  const gone = exited(app)
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.close()
  }).catch(() => {})
  const didExit = await Promise.race([gone, sleep(60_000).then(() => false)])
  check(didExit === true, 'an idle close of the last window quits a host that started headless', `after ${Date.now() - quitStarted} ms`)
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

  // Terminal access switch (App settings > General > Advanced settings). The headless boot turned it on.
  const p3 = desktop.page
  await openAppSettings(p3)
  const adv = p3.locator('[data-testid=settings-advanced][data-pane=app-general]')
  await adv.waitFor({ timeout: 10_000 })
  if (!(await adv.evaluate((el) => el.open))) await adv.locator('> summary').click()
  const sw = p3.locator('[data-testid=terminal-server-switch]')
  await sw.waitFor({ timeout: 10_000 })
  const before = await p3.evaluate(() => window.orgai.settings.get().then((s) => s.terminalServer))
  check(before === true && (await sw.getAttribute('aria-checked')) === 'true', 'Terminal access shows on after a headless boot', String(before))
  await sw.click()
  const off = await waitFor(async () => (await p3.evaluate(() => window.orgai.settings.get().then((s) => s.terminalServer))) === false, 5000)
  check(off === true && (await sw.getAttribute('aria-checked')) === 'false', 'turning Terminal access off saves terminalServer false')
  await sw.click()
  const on = await waitFor(async () => (await p3.evaluate(() => window.orgai.settings.get().then((s) => s.terminalServer))) === true, 5000)
  check(on === true, 'turning it back on saves terminalServer true')

  // Leave the data dir clean: forget the project made in scenario 2.
  const projects = await p3.evaluate(() => window.orgai.projects.list())
  for (const p of projects.filter((x) => x.name === NAME)) await p3.evaluate((id) => window.orgai.projects.remove(id), p.id).catch(() => {})
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
