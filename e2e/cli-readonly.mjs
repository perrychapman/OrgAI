// CLI read-only commands end to end (cli-spec Wave 2). Run `npm run build` first. Mock adapter only: no tokens.
//
// 1. The desktop app (Playwright) with Terminal access on, a mock project and a mock run; then, with
//    `node out/cli/orgai.mjs`: status (hostKind desktop, ready), runs list, runs show R1, inbox, watch R1 in
//    stream-json (the session is ended from the renderer and watch exits 0) and doctor (exit 0). The app is closed.
// 2. `orgai daemon start` starts the headless host: status says headless-host; `daemon stop` exits 0 and daemon.json
//    is gone.
// 3. Hostless: `orgai runs list --project <path>` lists the run with an ended status word and the
//    "No OrgAI host is running" note on stderr.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { APP_DIR, DATA_DIR, check, finish, launch, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const CLI = path.join(APP_DIR, 'out', 'cli', 'orgai.mjs')
const DAEMON_JSON = path.join(DATA_DIR, 'data', 'run', 'daemon.json')

if (!fs.existsSync(CLI)) {
  console.log('out/cli/orgai.mjs missing. Run `npm run build` first.')
  process.exit(1)
}

/** Run the CLI; resolves { code, out, err }. `onOut` sees stdout as it arrives. */
function cli(args, { timeoutMs = 60_000, onOut } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--no-color', ...args], {
      cwd: APP_DIR,
      env: { ...process.env, ORGAI_DATA_DIR: DATA_DIR, ORGAI_MOCK: '1', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d
      onOut?.(out)
    })
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: code ?? (signal ? 128 : 1), out, err, child })
    })
  })
}

const json = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Before W2-T4's entry lands the bundle is the contracts stub; skip rather than fail (this guard matches only its text).
const probe = await cli(['status'])
if (probe.err.includes('the CLI is not available yet in this build')) {
  console.log('SKIP (the CLI entry is still the Wave 2 contracts stub)')
  process.exit(0)
}

const repo = makeFixtureRepo('cli-readonly')
let app
let page
try {
  // ---------- 1. Desktop host ----------
  ;({ app, page } = await launch({ shotPrefix: 'cli-readonly' }))
  const sw = page.locator('[data-testid=terminal-server-switch]')
  if (await sw.count()) {
    if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click()
  } else {
    await page.evaluate(async () => {
      const s = await window.orgai.settings.get()
      await window.orgai.settings.set({ ...s, terminalServer: true })
    })
  }
  const terminalOn = await page.evaluate(async () => (await window.orgai.settings.get()).terminalServer === true)
  check(terminalOn, 'Terminal access is on')

  const project = await page.evaluate((dir) => window.orgai.projects.create({ name: 'CLI readonly', path: dir, brief: '', mock: true }), repo)
  const run = await page.evaluate((projectId) => window.orgai.runs.start({ projectId, prompt: 'Hello from the CLI e2e', team: 'single' }), project.id)
  await until('the mock run to go idle', async () => (await page.evaluate((id) => window.orgai.runs.get(id), run.id))?.summary.status === 'idle')

  const status = await cli(['--project', repo, 'status', '--output-format', 'json'])
  const sj = json(status.out)
  check(status.code === 0 && sj?.host?.hostKind === 'desktop' && sj?.hostState === 'ready', 'status: desktop host, ready', `${status.code} ${status.out.slice(0, 300)} ${status.err}`)

  const list = await cli(['runs', 'list', '--project', repo])
  check(list.code === 0 && /R1\s+(Idle|Running)/.test(list.out), 'runs list shows R1 live', list.out + list.err)

  const show = await cli(['--project', repo, 'runs', 'show', 'R1'])
  check(show.code === 0 && show.out.includes('Hello from the CLI e2e'), 'runs show R1', show.out.slice(0, 400) + show.err)

  const inbox = await cli(['--project', repo, 'inbox'])
  check(inbox.code === 0, 'inbox exits 0', inbox.out + inbox.err)

  let snapshotSeen = false
  const watching = cli(['--project', repo, 'watch', 'R1', '--output-format', 'stream-json'], { onOut: (o) => (snapshotSeen ||= o.includes('"type":"snapshot"')) })
  await until('the watch snapshot', () => snapshotSeen, 20_000)
  await page.evaluate((id) => window.orgai.runs.stop(id), run.id)
  const watched = await watching
  const events = watched.out.trim().split('\n').map(json).filter(Boolean)
  check(watched.code === 0 && events.some((e) => e.event?.type === 'run.status' && e.event.status === 'finished'), 'watch exits 0 when the session ends', `${watched.code} ${watched.err}`)

  const doctor = await cli(['doctor'])
  check(doctor.code === 0, 'doctor exits 0 with the app running', doctor.out + doctor.err)

  await app.close().catch(() => {})
  app = undefined
  await until('the desktop host to release the data folder', () => !fs.existsSync(DAEMON_JSON), 20_000).catch(() => undefined)

  // ---------- 2. Headless host ----------
  const started = await cli(['daemon', 'start', '--timeout', '60'], { timeoutMs: 90_000 })
  check(started.code === 0, 'daemon start exits 0', started.out + started.err)
  const hs = await cli(['status', '--output-format', 'json'])
  check(json(hs.out)?.host?.hostKind === 'headless-host', 'status shows the headless host', hs.out.slice(0, 300) + hs.err)
  const stopped = await cli(['daemon', 'stop'], { timeoutMs: 60_000 })
  check(stopped.code === 0, 'daemon stop exits 0', stopped.out + stopped.err)
  check(!fs.existsSync(DAEMON_JSON), 'daemon.json is gone after stop')

  // ---------- 3. Hostless ----------
  const hostless = await cli(['runs', 'list', '--project', repo])
  check(hostless.code === 0 && /R1\s+(Finished|Stopped)/.test(hostless.out), 'hostless runs list shows the run ended', hostless.out + hostless.err)
  check(hostless.err.includes('No OrgAI host is running'), 'hostless note on stderr', hostless.err)
} catch (e) {
  check(false, 'cli-readonly ran to the end', e instanceof Error ? e.stack : String(e))
} finally {
  if (app) await app.close().catch(() => {})
  // Never leave a headless host behind.
  if (fs.existsSync(DAEMON_JSON)) await cli(['daemon', 'stop', '--force'], { timeoutMs: 30_000 }).catch(() => undefined)
  removeFixture(repo)
  log('done')
}
finish('cli-readonly')
