// Headless `orgai exec` / `orgai resume --exec` end to end (cli-spec 6.2; cli-standalone-default.md 4.1, 4.3). Run
// `npm run build` first. Mock adapter only (ORGAI_MOCK=1): no tokens. No Electron: every command hosts itself in its own
// process (a pure-Node host), one at a time.
//
// 1. In an unregistered fixture repo: `exec` exits 2 (not a project). `exec --create-project` creates it and completes
//    ([mock:exec-plan], 0 'completed'); then one exec per outcome: --team single (0 'completed-unplanned'),
//    [mock:exec-blocked] (3 'blocked'), --max-budget 0 (3 'budget-exceeded'), the default script with --on-permission
//    fail (3 'needs-decision'), [mock:turn-fail] (1 'failed'), [mock:rate-limit] (4 'rate-limited'), [mock:exec-question]
//    with --on-question conservative (0 'completed-unplanned'). stream-json lines all parse and end with a `result`
//    line. `exec --prompt-file` with a file holding quotes, & and | (the way untrusted text is passed on Windows,
//    review M12).
// 2. A `wait` decision policy is refused (exit 2): nothing but this process could answer. SIGINT to an exec process ends
//    it 130 'interrupted' (POSIX). `resume R1 --exec --prompt more` exits 0, and `resume --exec --prompt-file` exits 0.
//
// win32 (review H4): child.kill('SIGINT') is TerminateProcess there, so no handler would run and the exit code would
// not be 130. The SIGINT case is skipped with a log line. The script has not been run on Windows yet.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { APP_DIR, DATA_DIR, check, finish, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'
import { writeFileSync as markWrite } from 'node:fs'
import { join as markJoin } from 'node:path'
// The CLI marks its own data folder (spec 3.1); this script seeds files before the first command, so it marks it itself.
markWrite(markJoin(DATA_DIR, 'product.json'), `${JSON.stringify({ product: 'orgai-cli', version: 1 })}\n`, { mode: 0o600 })

process.env.ORGAI_MOCK = '1'
const CLI = path.join(APP_DIR, 'out', 'cli', 'orgai.mjs')
const DAEMON_JSON = path.join(DATA_DIR, 'data', 'run', 'daemon.json')

if (!fs.existsSync(CLI)) {
  console.log('out/cli/orgai.mjs missing. Run `npm run build` first.')
  process.exit(1)
}

const ENV = { ...process.env, ORGAI_CLI_DATA_DIR: DATA_DIR, ORGAI_MOCK: '1', NO_COLOR: '1' }
delete ENV.ELECTRON_RUN_AS_NODE

/** Start the CLI; returns { child, done } where done resolves { code, signal, out, err }. */
function start(args, { cwd, onOut } = {}) {
  const child = spawn(process.execPath, ['--disable-sigusr1', CLI, '--no-color', ...args], { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => {
    out += d
    onOut?.(out)
  })
  child.stderr.on('data', (d) => (err += d))
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal, out, err }))
  })
  return { child, done }
}

/** Run the CLI to the end (killed after timeoutMs). */
async function cli(args, { cwd, timeoutMs = 90_000 } = {}) {
  const { child, done } = start(args, { cwd })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const r = await done
  clearTimeout(timer)
  return r
}

const json = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
const lines = (s) => s.trim().split('\n').filter(Boolean).map(json)
const show = (r) => `exit ${r.code} ${r.out.slice(-400)} ${r.err.slice(-400)}`

async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Before W3-T4 lands the bundle has the contracts stub; skip rather than fail (this guard matches only its text).
const probe = await cli(['exec', 'probe'], { cwd: APP_DIR })
if (probe.err.includes('`orgai exec` is not built yet.')) {
  console.log('SKIP (orgai exec is still the Wave 3 contracts stub)')
  process.exit(0)
}

const repo = makeFixtureRepo('cli-exec')
try {
  // ---------- 1. Per-command inproc host ----------
  const unregistered = await cli(['exec', 'do it'], { cwd: repo })
  check(unregistered.code === 2 && unregistered.err.includes('not an OrgAI project'), 'exec in an unregistered folder exits 2', show(unregistered))

  /** One `exec --output-format json` run; checks the exit code and the outcome. */
  async function execCase(name, args, code, outcome) {
    const r = await cli(['exec', '--output-format', 'json', ...args], { cwd: repo })
    const doc = json(r.out)
    check(r.code === code && doc?.outcome === outcome && doc?.exitCode === code, `${name}: exit ${code}, ${outcome}`, show(r))
    return doc
  }

  const first = await execCase('exec --create-project [mock:exec-plan]', ['--create-project', '[mock:exec-plan] do it'], 0, 'completed')
  check(typeof first?.runId === 'string' && first?.execChainId === first?.runId && first?.summary?.execOutcome === 'completed', 'the json document names the run, its exec chain and summary', JSON.stringify(first)?.slice(0, 300))
  await execCase('exec --team single', ['--team', 'single', 'hello'], 0, 'completed-unplanned')
  await execCase('[mock:exec-blocked]', ['[mock:exec-blocked] do it'], 3, 'blocked')
  await execCase('--max-budget 0', ['--max-budget', '0', 'Spend nothing'], 3, 'budget-exceeded')
  await execCase('default script with --on-permission fail', ['--on-permission', 'fail', 'Do the default work'], 3, 'needs-decision')
  await execCase('--strict-delegation [mock:delegation-skip]', ['--strict-delegation', '[mock:delegation-skip] do it'], 3, 'delegation-incomplete')
  await execCase('[mock:turn-fail]', ['[mock:turn-fail] do it'], 1, 'failed')
  await execCase('[mock:rate-limit]', ['[mock:rate-limit] do it'], 4, 'rate-limited')
  // No plan: the turn-1 set-plan nudge runs, then the run settles unplanned. No window or TUI is open, so the
  // policy answers at once (an exec follower never holds the humanGraceMs window).
  const t0 = Date.now()
  await execCase('[mock:exec-question] --on-question conservative', ['--on-question', 'conservative', '[mock:exec-question] do it'], 0, 'completed-unplanned')
  check(Date.now() - t0 < 45_000, 'the conservative answer does not wait for the human grace window', `${Date.now() - t0} ms`)

  // Untrusted text goes through --prompt-file (or stdin), never argv (review M12).
  const promptFile = path.join(DATA_DIR, 'cli-exec-prompt.txt')
  fs.writeFileSync(promptFile, '\ufeffSay "hi" & echo not-a-command | more\n', 'utf8')
  await execCase('exec --prompt-file (quotes, & and |)', ['--team', 'single', '--prompt-file', promptFile], 0, 'completed-unplanned')

  const streamed = await cli(['exec', '--output-format', 'stream-json', '--team', 'single', 'hello again'], { cwd: repo })
  const sl = lines(streamed.out)
  check(streamed.code === 0 && sl.length > 1 && sl.every((l) => l && l.schemaVersion === 1), 'stream-json: every line parses with schemaVersion', show(streamed))
  check(sl.at(-1)?.type === 'result' && sl.at(-1)?.outcome === 'completed-unplanned', 'stream-json ends with a result line', JSON.stringify(sl.at(-1))?.slice(0, 300))
  check(sl.some((l) => l?.type === 'event' && l.event?.type === 'run.finalized'), 'stream-json carries run.finalized', '')

  // ---------- 2. Wait policies, SIGINT, resume ----------
  const waitRefused = await cli(['exec', '--on-permission', 'wait', 'Do the default work'], { cwd: repo })
  check(waitRefused.code === 2 && /wait is not available/.test(waitRefused.err), 'a wait decision policy is refused (exit 2)', show(waitRefused))

  if (process.platform === 'win32') {
    // No POSIX signals on Windows: kill('SIGINT') would TerminateProcess the CLI before its handler ran.
    log('SKIP SIGINT to an exec process on win32 (kill is TerminateProcess there)')
  } else {
    // SIGINT to an exec process: runs:stop, then 130.
    let sawEvent = false
    const sig = start(['exec', '--output-format', 'stream-json', '[mock:exec-slow] wait for the signal'], { cwd: repo, onOut: (o) => (sawEvent ||= o.includes('"type":"event"')) })
    await until('the exec run to stream', () => sawEvent)
    sig.child.kill('SIGINT')
    const sigDone = await sig.done
    check(sigDone.code === 130 && lines(sigDone.out).at(-1)?.outcome === 'interrupted', 'SIGINT ends exec 130 with outcome interrupted', show(sigDone))
  }

  const resumed = await cli(['resume', 'R1', '--exec', '--prompt', 'more', '--output-format', 'json'], { cwd: repo })
  check(resumed.code === 0 && json(resumed.out)?.exitCode === 0, 'resume R1 --exec --prompt more exits 0', show(resumed))
  const resumedFromFile = await cli(['resume', 'R1', '--exec', '--prompt-file', promptFile, '--output-format', 'json'], { cwd: repo })
  check(resumedFromFile.code === 0 && json(resumedFromFile.out)?.exitCode === 0, 'resume R1 --exec --prompt-file exits 0', show(resumedFromFile))
} catch (e) {
  check(false, 'cli-exec ran to the end', e instanceof Error ? e.stack : String(e))
} finally {
  // An exec process must leave no host behind: a leftover daemon.json fails the script and its pid is killed, so a later
  // script on the same folder is not refused with exit 6.
  const left = fs.existsSync(DAEMON_JSON) ? fs.readFileSync(DAEMON_JSON, 'utf8') : undefined
  check(left === undefined, 'no host is left behind', left)
  if (left !== undefined) {
    try {
      const pid = Number(JSON.parse(left).pid)
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone or unreadable */
    }
    fs.rmSync(DAEMON_JSON, { force: true })
  }
  removeFixture(repo)
  log('done')
}
finish('cli-exec')
