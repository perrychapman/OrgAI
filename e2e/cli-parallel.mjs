// Sessions: several orgai processes on one CLI data folder (docs/design/cli-sessions.md). Two terminal UIs in two
// projects at the same time, each on a real pseudo-terminal (e2e/ptyDriver.mjs), with plain commands running beside
// them. Run `npm run build` first. Mock adapter only (ORGAI_MOCK=1): no tokens, no network. SKIPs (exit 0) on win32 or
// when no pty backend works, like cli-tui.
//
// Checked:
//  1. Two TUIs open at once in different projects; neither is refused; `orgai status` lists both sessions with the
//     project each holds; daemon.json names one of them and says the folder is shared.
//  2. Both run work at the same time; each run reaches the index and neither loses the other's.
//  3. A third TUI and an `orgai exec` in a held project are refused (exit 6) naming the session's folder and pid, and
//     change nothing; a command in a third project and a management command work beside both.
//  4. From a third terminal the held project's run reads as live, with no "saved snapshot" note.
//  5. The session daemon.json names quits: the record goes to the other session at once; its project is free again.
//  6. A session is killed (SIGKILL): its run reads as ended when orgai closed, the survivor is untouched, and the
//     killed session's project opens again.
//  7. After the last session nothing advertises the folder and no session file is left.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DATA_DIR, check, finish, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'
import { CLI, DAEMON_JSON, HOST_DATA_DIR, cli, json, readDaemon, requireBuild, seedProject, show, until } from './cliLib.mjs'
import { probePty, spawnTui } from './ptyDriver.mjs'

const skip = (why) => {
  console.log(`SKIP cli-parallel: ${why}`)
  process.exit(0)
}
if (process.platform === 'win32') skip('pseudo-terminal tests do not run on Windows')
requireBuild()
if (!fs.existsSync(path.join(path.dirname(CLI), 'tui.mjs'))) {
  console.log('out/cli/tui.mjs missing. Run `npm run build` first.')
  process.exit(1)
}
const backend = await probePty()
if (!backend) skip('no pseudo-terminal backend works here (need python3, or script + perl with job control)')
log(`pty backend: ${backend}`)

const SESSIONS_DIR = path.join(HOST_DATA_DIR, 'run', 'sessions')

/** A mock run that says one line and then waits for the next message (the run stays open, idle). */
const scriptFile = (name, text) => {
  const f = path.join(DATA_DIR, `mock-${name}.json`)
  fs.writeFileSync(f, JSON.stringify({ delayMs: 60, work: [{ type: 'text', text }] }))
  return f
}
const SCRIPT = { a: scriptFile('par-a', 'E2E-PARALLEL-ALPHA-DONE'), b: scriptFile('par-b', 'E2E-PARALLEL-BETA-DONE'), c: scriptFile('par-c', 'E2E-PARALLEL-GAMMA-DONE') }

const tuiEnv = (script) => {
  const env = { ...process.env, ORGAI_CLI_DATA_DIR: DATA_DIR, ORGAI_MOCK: '1', NO_COLOR: '1', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ORGAI_MOCK_SCRIPT: script, ORGAI_CLI_VAULT_NO_OS_KEYSTORE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CI // Ink's is-in-ci would turn interactive rendering off
  delete env.FORCE_COLOR
  return env
}
const tui = (cwd, script, args = ['tui']) => spawnTui([process.execPath, '--disable-sigusr1', CLI, '--no-color', ...args], { cols: 120, rows: 30, cwd, env: tuiEnv(script) })
async function type(t, text) {
  for (const ch of text) {
    t.write(ch)
    await sleep(8)
  }
}
const READY = /What would you like your team to work on\?|(?:Message|Send to continue) R\d+/
async function quit(t) {
  await type(t, '/quit')
  t.key('enter')
  for (const step of [async () => undefined, async () => t.key('ctrl+d'), async () => t.write('y'), async () => t.key('enter')]) {
    await step()
    const e = await Promise.race([t.exited, sleep(2500).then(() => null)])
    if (e) return e
  }
  return null
}
const statusJson = async (cwd) => json((await cli(['status', '--all-projects', '--output-format', 'json'], { cwd })).out)
const runsOf = async (cwd) => json((await cli(['runs', 'list', '--output-format', 'json'], { cwd })).out)?.runs ?? []
const sessionFiles = () => (fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR).filter((n) => /^[0-9a-f]{12}\.(json|lock)$/.test(n)).sort() : [])

const repoA = makeFixtureRepo('cli-par-a')
const repoB = makeFixtureRepo('cli-par-b')
const repoC = makeFixtureRepo('cli-par-c')
const open = []
try {
  const projA = await seedProject(repoA, { name: 'Alpha' })
  const projB = await seedProject(repoB, { name: 'Beta' })
  const projC = await seedProject(repoC, { name: 'Gamma' })
  check(!fs.existsSync(DAEMON_JSON) && sessionFiles().length === 0, 'three projects seeded; no orgai is running', sessionFiles().join(' '))

  // ---------- 1. Two terminal UIs at once ----------
  const a = tui(repoA, SCRIPT.a)
  open.push(a)
  await a.waitFor(READY, 30_000)
  const b = tui(repoB, SCRIPT.b)
  open.push(b)
  await b.waitFor(READY, 30_000)
  const pidA = await a.waitPid()
  const pidB = await b.waitPid()
  check(!a.exitInfo && !b.exitInfo, 'two terminal UIs are open at once in two projects; neither was refused', `${JSON.stringify(a.exitInfo)} ${JSON.stringify(b.exitInfo)}`)
  let st = await statusJson(repoC)
  const holds = (pid) => st?.sessions?.find((s) => s.pid === pid)?.projects ?? []
  check(st?.sessions?.length === 2 && st.hostState === 'ready', 'status lists two running sessions', JSON.stringify(st?.sessions)?.slice(0, 400))
  check(holds(pidA).includes(projA.id) && holds(pidB).includes(projB.id), 'each session holds the project its terminal opened', JSON.stringify(st?.sessions)?.slice(0, 400))
  check(st?.sessions?.every((s) => s.command === 'tui'), 'both sessions say they run the terminal UI', JSON.stringify(st?.sessions?.map((s) => s.command)))
  const daemon = readDaemon()
  check(daemon?.sessions === true && [pidA, pidB].includes(daemon.pid), 'daemon.json names one of the two and says the folder is shared', JSON.stringify(daemon)?.slice(0, 300))
  const statusText = (await cli(['status', '--all-projects'], { cwd: repoC })).out
  check(/orgai sessions running: 2/.test(statusText) && /holds Alpha/.test(statusText) && /holds Beta/.test(statusText), 'the status text names both sessions and what they hold', statusText.slice(0, 500))

  // ---------- 2. Work in both at the same time ----------
  await type(a, 'do the alpha work')
  a.key('enter')
  await type(b, 'do the beta work')
  b.key('enter')
  await Promise.all([a.waitFor('E2E-PARALLEL-ALPHA-DONE', 40_000), b.waitFor('E2E-PARALLEL-BETA-DONE', 40_000)])
  check(true, 'both terminals ran a turn while the other was running')
  check(!a.screen().includes('E2E-PARALLEL-BETA') && !b.screen().includes('E2E-PARALLEL-ALPHA'), 'neither terminal shows the other project\'s work')
  const runsA = await runsOf(repoA)
  const runsB = await runsOf(repoB)
  check(runsA.length === 1 && runsB.length === 1, 'each project has its run in the index (no run was lost to the other session\'s write)', `${runsA.length} ${runsB.length}`)
  const index = json(fs.readFileSync(path.join(HOST_DATA_DIR, 'runs.json'), 'utf8'))
  const owners = Object.values(index?.owners ?? {})
  check(owners.length === 2 && new Set(owners).size === 2, 'the run index names a different host for each open run', JSON.stringify(index?.owners))

  // ---------- 3. A held project is refused; everything else works beside ----------
  const c = tui(repoA, SCRIPT.c)
  open.push(c)
  const refused = await Promise.race([c.exited, sleep(20_000).then(() => null)])
  const refusedText = `${c.text()} ${c.stderr()}`
  check(refused?.code === 6, 'a second terminal UI on a held project exits 6', `${JSON.stringify(refused)} ${refusedText.slice(-300)}`)
  check(new RegExp(`The project Alpha is open in another orgai session \\(.*, pid ${pidA}\\)\\. Use that one, or quit it first\\.`).test(refusedText.replace(/\s+/g, ' ')), 'the refusal names the project, the other session\'s folder and its pid', refusedText.slice(-400))
  const execRefused = await cli(['exec', '--team', 'single', 'refused work'], { cwd: repoA, env: { ORGAI_MOCK_SCRIPT: SCRIPT.c } })
  check(execRefused.code === 6 && /open in another orgai session/.test(execRefused.err), 'orgai exec in a held project exits 6 with the same sentence', show(execRefused))
  const setRefused = await cli(['projects', 'set', '--brief', 'changed from outside'], { cwd: repoB })
  check(setRefused.code === 6, 'changing a held project from another terminal exits 6', show(setRefused))
  check((await runsOf(repoA)).length === 1 && (json((await cli(['projects', 'show', '--output-format', 'json'], { cwd: repoB })).out)?.project?.brief ?? '') === '', 'the refused commands changed nothing')
  const execC = await cli(['exec', '--team', 'single', '--output-format', 'json', 'gamma work'], { cwd: repoC, env: { ORGAI_MOCK_SCRIPT: SCRIPT.c }, timeoutMs: 120_000 })
  check(execC.code === 0 && json(execC.out)?.outcome, 'orgai exec in a third project runs beside both terminals', show(execC))
  const settings = await cli(['settings', 'list', '--output-format', 'json'], { cwd: repoC })
  check(settings.code === 0, 'a management command runs beside both terminals', show(settings))
  st = await statusJson(repoC)
  check(st?.sessions?.length === 2, 'the two terminal sessions are the ones left once those commands ended', JSON.stringify(st?.sessions?.map((s) => s.command)))

  // ---------- 4. A third terminal reads the held project's run as live ----------
  const listA = await cli(['runs', 'list'], { cwd: repoA })
  check(listA.code === 0 && /R1\s+(Idle|Running|Waiting)/.test(listA.out), 'runs list shows the other session\'s run as live', listA.out.slice(0, 300))
  check(!/saved snapshot/.test(listA.err), 'and prints no "saved snapshot" note: the index says which session hosts the run', listA.err.slice(0, 200))

  // ---------- 5. The advertised session quits: the record is handed over ----------
  const advertised = readDaemon().pid === pidA ? { t: a, pid: pidA, repo: repoA, other: pidB } : { t: b, pid: pidB, repo: repoB, other: pidA }
  const survivor = advertised.pid === pidA ? { t: b, pid: pidB, repo: repoB, done: 'E2E-PARALLEL-BETA-DONE' } : { t: a, pid: pidA, repo: repoA, done: 'E2E-PARALLEL-ALPHA-DONE' }
  const quitInfo = await quit(advertised.t)
  check(quitInfo !== null, 'the session daemon.json names quits', JSON.stringify(quitInfo))
  const after = readDaemon()
  check(after?.pid === survivor.pid && after?.sessions === true, 'daemon.json names the other session at once (never nothing while one runs)', JSON.stringify(after)?.slice(0, 300))
  st = await statusJson(repoC)
  check(st?.sessions?.length === 1 && st.sessions[0].pid === survivor.pid, 'status lists the one session left', JSON.stringify(st?.sessions)?.slice(0, 300))
  check(!survivor.t.exitInfo && survivor.t.screen().includes(survivor.done), 'the other terminal is untouched by that quit')
  const freed = await cli(['exec', '--team', 'single', '--output-format', 'json', 'work after the quit'], { cwd: advertised.repo, env: { ORGAI_MOCK_SCRIPT: SCRIPT.c }, timeoutMs: 120_000 })
  check(freed.code === 0, 'the project that session held is free again', show(freed))

  // ---------- 6. A session is killed ----------
  const killedRuns = await runsOf(survivor.repo)
  const liveRun = killedRuns.find((r) => r.summary.status !== 'finished' && r.summary.status !== 'error')
  check(!!liveRun, 'the surviving session has an open run to lose', JSON.stringify(killedRuns.map((r) => r.summary.status)))
  await survivor.t.signal('SIGKILL')
  await Promise.race([survivor.t.exited, sleep(10_000)])
  check(sessionFiles().length > 0, 'the killed session left its files behind (no cleanup ran)', sessionFiles().join(' '))
  const settled = (await runsOf(survivor.repo)).find((r) => r.summary.id === liveRun?.summary.id)
  check(settled?.summary.status === 'finished' && settled.summary.endedBy === 'app', 'its run reads as ended when orgai closed', JSON.stringify(settled?.summary)?.slice(0, 300))
  st = await statusJson(repoC)
  check(st?.sessions?.length === 0 && st.hostState === 'stopped', 'status lists no running session (a lock nobody holds is a dead session, whatever its files say)', JSON.stringify(st)?.slice(0, 300))
  const reopened = tui(survivor.repo, SCRIPT.c)
  open.push(reopened)
  await reopened.waitFor(READY, 30_000)
  check(!reopened.exitInfo, 'the killed session\'s project opens again')
  check(sessionFiles().length === 2, 'and that start swept what the killed session left', sessionFiles().join(' '))
  await quit(reopened)

  // ---------- 7. Nothing left ----------
  await until('the last session to end', () => sessionFiles().length === 0, 15_000).catch(() => undefined)
  check(!fs.existsSync(DAEMON_JSON), 'no daemon.json once the last session ended')
  check(sessionFiles().length === 0, 'no session file is left', sessionFiles().join(' '))
  const all = json(fs.readFileSync(path.join(HOST_DATA_DIR, 'runs.json'), 'utf8'))
  check((all?.runs ?? []).length >= 4 && new Set(all.runs.map((r) => r.projectId)).size === 3, 'every run of the three projects is in the index', JSON.stringify(all?.runs?.map((r) => [r.projectId, r.status])))
  void projC
} catch (e) {
  check(false, 'cli-parallel ran to the end', e?.stack ?? String(e))
} finally {
  for (const t of open) await t.close().catch(() => undefined)
  for (const r of [repoA, repoB, repoC]) removeFixture(r)
}
finish('cli-parallel')
