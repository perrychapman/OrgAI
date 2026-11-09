// Headless `orgai exec` / `orgai resume --exec` / `orgai decide` end to end (cli-spec 6.2, Wave 3). Run `npm run build`
// first. Mock adapter only (ORGAI_MOCK=1): no tokens. No Electron: every host here is `--host inproc` (a pure-Node host
// in the CLI process), either per command or a long-lived `daemon start --host inproc --foreground`.
//
// 1. In an unregistered fixture repo: `exec` exits 2 (not a project). `--host inproc exec --create-project` creates
//    it and completes ([mock:exec-plan], 0 'completed'); then one exec per outcome: --team single (0
//    'completed-unplanned'), [mock:exec-blocked] (3 'blocked'), --max-budget 0 (3 'budget-exceeded'), the default
//    script with --on-permission fail (3 'needs-decision'), [mock:turn-fail] (1 'failed'), [mock:rate-limit] (4
//    'rate-limited'), [mock:exec-question] with --on-question conservative (0 'completed-unplanned'). stream-json lines all parse and end
//    with a `result` line.
// 2. A long-lived host (`daemon start --host inproc --foreground`): `--host daemon exec --on-permission wait` on the
//    default script waits on a card; `inbox --output-format json` shows its request id; `decide <id> deny` exits 0
//    ('applied'), a second decide exits 1, `decide nope deny` exits 2. On a [mock:exec-slow] exec run, `runs send`,
//    `runs interrupt` and `runs stop` exit 0 and the exec process ends 130 'interrupted'. SIGINT to an exec process
//    ends it 130 'interrupted'. `resume R1 --exec --prompt more` exits 0, and `resume --exec --prompt-file` exits 0.
// 1 also runs `exec --prompt-file` with a file holding quotes, & and | (the way untrusted text is passed on Windows,
// review M12).
//
// win32 (review H4): child.kill('SIGINT') is TerminateProcess there, so no handler would run and the exit code would
// not be 130. The SIGINT case is skipped with a log line and the same stop is driven through `orgai runs stop` on a
// fresh exec run (no interrupt first); the long-lived daemon is ended with `daemon stop --force`, not SIGINT. The script
// has not been run on Windows yet.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { APP_DIR, DATA_DIR, allowFullTerminalAccess, check, finish, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const CLI = path.join(APP_DIR, 'out', 'cli', 'orgai.mjs')
const DAEMON_JSON = path.join(DATA_DIR, 'data', 'run', 'daemon.json')

if (!fs.existsSync(CLI)) {
  console.log('out/cli/orgai.mjs missing. Run `npm run build` first.')
  process.exit(1)
}

const ENV = { ...process.env, ORGAI_DATA_DIR: DATA_DIR, ORGAI_MOCK: '1', NO_COLOR: '1' }
delete ENV.ELECTRON_RUN_AS_NODE

/** Start the CLI; returns { child, done } where done resolves { code, signal, out, err }. */
function start(args, { cwd, onOut } = {}) {
  const child = spawn(process.execPath, [CLI, '--no-color', ...args], { cwd, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] })
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

const readDaemon = () => json(fs.existsSync(DAEMON_JSON) ? fs.readFileSync(DAEMON_JSON, 'utf8') : '')

// Before W3-T4 lands the bundle has the contracts stub; skip rather than fail (this guard matches only its text).
const probe = await cli(['exec', 'probe'], { cwd: APP_DIR })
if (probe.err.includes('`orgai exec` is not built yet.')) {
  console.log('SKIP (orgai exec is still the Wave 3 contracts stub)')
  process.exit(0)
}

const repo = makeFixtureRepo('cli-exec')
let daemon
try {
  // ---------- 1. Per-command inproc host ----------
  const unregistered = await cli(['exec', 'do it'], { cwd: repo })
  check(unregistered.code === 2 && unregistered.err.includes('not an OrgAI project'), 'exec in an unregistered folder exits 2', show(unregistered))

  /** One `--host inproc exec --output-format json` run; checks the exit code and the outcome. */
  async function execCase(name, args, code, outcome) {
    const r = await cli(['--host', 'inproc', 'exec', '--output-format', 'json', ...args], { cwd: repo })
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

  const streamed = await cli(['--host', 'inproc', 'exec', '--output-format', 'stream-json', '--team', 'single', 'hello again'], { cwd: repo })
  const sl = lines(streamed.out)
  check(streamed.code === 0 && sl.length > 1 && sl.every((l) => l && l.schemaVersion === 1), 'stream-json: every line parses with schemaVersion', show(streamed))
  check(sl.at(-1)?.type === 'result' && sl.at(-1)?.outcome === 'completed-unplanned', 'stream-json ends with a result line', JSON.stringify(sl.at(-1))?.slice(0, 300))
  check(sl.some((l) => l?.type === 'event' && l.event?.type === 'run.finalized'), 'stream-json carries run.finalized', '')

  // ---------- 2. A long-lived host ----------
  // Its clients are other processes: decide needs Terminal access 'full', the user's choice (review H2). The
  // per-command `--host inproc` runs above needed nothing: their own process proves itself with the owner key.
  allowFullTerminalAccess()
  daemon = start(['--host', 'inproc', 'daemon', 'start', '--foreground'], { cwd: repo })
  await until('the inproc daemon to be ready', () => readDaemon()?.state === 'ready')

  // A card that waits for a person; decide answers it.
  const waiting = start(['--host', 'daemon', 'exec', '--output-format', 'json', '--on-permission', 'wait', 'Do the default work'], { cwd: repo })
  const item = await until(
    'a pending decision in the inbox',
    async () => {
      const r = await cli(['inbox', '--output-format', 'json'], { cwd: repo })
      return json(r.out)?.items?.[0]
    },
    60_000
  )
  check(typeof item?.requestId === 'string', 'inbox --output-format json lists the waiting card', JSON.stringify(item))
  const denied = await cli(['decide', item.requestId, 'deny'], { cwd: repo })
  check(denied.code === 0, 'decide <id> deny exits 0 (applied)', show(denied))
  const again = await cli(['decide', item.requestId, 'deny'], { cwd: repo })
  check(again.code === 1, 'a second decide exits 1 (already resolved)', show(again))
  const nope = await cli(['decide', 'nope', 'deny'], { cwd: repo })
  check(nope.code === 2, 'decide on an unknown request exits 2', show(nope))
  const waited = await waiting.done
  check([0, 3].includes(waited.code) && typeof json(waited.out)?.outcome === 'string', 'the waiting exec ends with an outcome after the decision', show(waited))

  // runs send / interrupt / stop on a slow exec run; stop finalizes it 'interrupted'.
  let slowOut = ''
  const slow = start(['--host', 'daemon', 'exec', '--output-format', 'stream-json', '[mock:exec-slow] take your time'], { cwd: repo, onOut: (o) => (slowOut = o) })
  const slowRun = await until('the slow run to start', () => lines(slowOut).find((l) => l?.type === 'event')?.event?.runId, 30_000)
  const sent = await cli(['runs', 'send', slowRun, 'a follow-up'], { cwd: repo })
  check(sent.code === 0, 'runs send on the exec run exits 0', show(sent))
  const interrupted = await cli(['runs', 'interrupt', slowRun], { cwd: repo })
  check(interrupted.code === 0, 'runs interrupt exits 0', show(interrupted))
  const stopped = await cli(['runs', 'stop', slowRun], { cwd: repo })
  check(stopped.code === 0, 'runs stop exits 0', show(stopped))
  const slowDone = await slow.done
  const slowLast = lines(slowDone.out).at(-1)
  check(slowDone.code === 130 && slowLast?.outcome === 'interrupted', 'runs stop ends the exec process 130, interrupted', show(slowDone))

  if (process.platform === 'win32') {
    // No POSIX signals on Windows: kill('SIGINT') would TerminateProcess the CLI before its handler runs.
    log('SKIP SIGINT to an exec process on win32 (kill is TerminateProcess there); driving the stop through `orgai runs stop` instead')
    let stopOut = ''
    const viaStop = start(['--host', 'daemon', 'exec', '--output-format', 'stream-json', '[mock:exec-slow] stop me from another terminal'], { cwd: repo, onOut: (o) => (stopOut = o) })
    const stopRun = await until('the exec run to stream', () => lines(stopOut).find((l) => l?.type === 'event')?.event?.runId, 30_000)
    const stoppedOnly = await cli(['runs', 'stop', stopRun], { cwd: repo })
    check(stoppedOnly.code === 0, 'win32: runs stop exits 0', show(stoppedOnly))
    const stopDone = await viaStop.done
    check(stopDone.code === 130 && lines(stopDone.out).at(-1)?.outcome === 'interrupted', 'win32: runs stop (no interrupt first) ends exec 130 with outcome interrupted', show(stopDone))
  } else {
    // SIGINT to an exec process: runs:stop, then 130.
    let sawEvent = false
    const sig = start(['--host', 'daemon', 'exec', '--output-format', 'stream-json', '[mock:exec-slow] wait for the signal'], { cwd: repo, onOut: (o) => (sawEvent ||= o.includes('"type":"event"')) })
    await until('the exec run to stream', () => sawEvent)
    sig.child.kill('SIGINT')
    const sigDone = await sig.done
    check(sigDone.code === 130 && lines(sigDone.out).at(-1)?.outcome === 'interrupted', 'SIGINT ends exec 130 with outcome interrupted', show(sigDone))
  }

  const resumed = await cli(['--host', 'daemon', 'resume', 'R1', '--exec', '--prompt', 'more', '--output-format', 'json'], { cwd: repo })
  check(resumed.code === 0 && json(resumed.out)?.exitCode === 0, 'resume R1 --exec --prompt more exits 0', show(resumed))
  const resumedFromFile = await cli(['--host', 'daemon', 'resume', 'R1', '--exec', '--prompt-file', promptFile, '--output-format', 'json'], { cwd: repo })
  check(resumedFromFile.code === 0 && json(resumedFromFile.out)?.exitCode === 0, 'resume R1 --exec --prompt-file exits 0', show(resumedFromFile))
} catch (e) {
  check(false, 'cli-exec ran to the end', e instanceof Error ? e.stack : String(e))
} finally {
  if (daemon) {
    // win32: SIGINT would TerminateProcess the foreground daemon and leave daemon.json behind; ask it to stop instead.
    if (process.platform === 'win32') await cli(['daemon', 'stop', '--force'], { cwd: APP_DIR, timeoutMs: 30_000 }).catch(() => undefined)
    else daemon.child.kill('SIGINT')
    const t = setTimeout(() => daemon.child.kill('SIGKILL'), 20_000)
    await daemon.done
    clearTimeout(t)
  }
  // Never leave a host behind.
  if (fs.existsSync(DAEMON_JSON)) await cli(['daemon', 'stop', '--force'], { cwd: APP_DIR, timeoutMs: 30_000 }).catch(() => undefined)
  removeFixture(repo)
  log('done')
}
finish('cli-exec')
