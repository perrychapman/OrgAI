// `orgai projects` and `orgai init` end to end (cli-spec 6.3, Wave 5, task W5-T1). Run `npm run build` first. Mock
// adapter only (ORGAI_MOCK=1): no tokens, no network. Every command hosts itself, one at a time (e2e/cliLib.mjs).
//
// a. projects create (code, JSON) / create (engagement with --client, text) / list (text and JSON) / show / set
//    (--max-budget 5 then none, --max-depth auto, --plan-guard off) / check / remove --yes (JSON), and a second create
//    of the same folder exits 1.
// b. init --skip-architect in a fixture repo exits 0 and registers it; again says "Already an OrgAI project".
// c. `orgai init` on a pseudo-terminal (e2e/ptyDriver.mjs, as cli-tui.mjs): every card the mock Architect raises (its
//    git status permission, then the architecture, org chart and settings proposals) is approved with `y`; the process
//    exits 0 after complete_setup and the project's setup reads complete.
// d. A second `orgai init` session: Ctrl+C twice exits 130 and the setup run reads Stopped.
//
// (c) and (d) SKIP on win32 and when no pty backend passes ptyDriver's probe.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DATA_DIR, check, finish, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'
import { CLI, ENV, cli, json, requireBuild, show, storedProject } from './cliLib.mjs'
import { probePty, spawnTui } from './ptyDriver.mjs'

requireBuild()

const fixtures = []
const fixture = (tag) => {
  const dir = makeFixtureRepo(tag)
  fixtures.push(dir)
  return dir
}

// A faster copy of the default mock scripts (the setup script is the default one).
const SCRIPT = path.join(DATA_DIR, 'mock-cli-projects.json')
fs.writeFileSync(SCRIPT, JSON.stringify({ delayMs: 60 }))

const ttyEnv = () => {
  const env = { ...ENV, TERM: 'xterm-256color', ORGAI_MOCK_SCRIPT: SCRIPT, LANG: 'en_US.UTF-8' }
  delete env.CI // Ink's is-in-ci would turn interactive rendering off
  delete env.FORCE_COLOR
  return env
}

async function partA() {
  const codeDir = fixture('cli-projects-code')
  const engDir = fixture('cli-projects-eng')

  const created = await cli(['projects', 'create', codeDir, '--name', 'E2E code', '--output-format', 'json'])
  const cj = json(created.out)
  check(created.code === 0 && cj?.schemaVersion === 1 && cj.project?.kind === 'code' && cj.project.name === 'E2E code', 'projects create (code, JSON)', show(created))

  const eng = await cli(['projects', 'create', engDir, '--kind', 'engagement', '--client', 'Acme Corp', '--name', 'E2E engagement'])
  check(eng.code === 0 && /Created engagement E2E engagement/.test(eng.out) && /Client:\s+Acme Corp/.test(eng.out), 'projects create (engagement, text, --client)', show(eng))

  const again = await cli(['projects', 'create', codeDir])
  check(again.code === 1 && again.err.includes('already the OrgAI project "E2E code"'), 'creating the same folder again exits 1 naming it', show(again))

  const list = await cli(['projects', 'list'])
  check(list.code === 0 && /E2E code\s+Project/.test(list.out) && /E2E engagement\s+Engagement\s+Acme Corp/.test(list.out), 'projects list (text)', show(list))
  const lj = json((await cli(['projects', 'list', '--output-format', 'json'])).out)
  check(lj?.projects?.length === 2 && lj.projects.some((p) => p.kind === 'engagement' && p.client === 'Acme Corp'), 'projects list (JSON)', JSON.stringify(lj))

  const shown = await cli(['projects', 'show'], { cwd: codeDir })
  check(shown.code === 0 && /Subagent depth:\s+Automatic \(\d\)/.test(shown.out) && /Budget per run:\s+no cap/.test(shown.out), 'projects show (cwd project, automatic limits)', show(shown))

  const set = await cli(['projects', 'set', '--max-budget', '5', '--max-depth', '3', '--plan-guard', 'off', '--output-format', 'json'], { cwd: codeDir })
  const sj = json(set.out)
  check(set.code === 0 && sj?.project?.maxBudgetUsd === 5 && sj.project.limits?.depth === 3 && sj.project.planGuard === 'off', 'projects set --max-budget 5 --max-depth 3 --plan-guard off', show(set))
  const cleared = await cli(['projects', 'set', '--max-budget', 'none', '--max-depth', 'auto'], { cwd: codeDir })
  check(cleared.code === 0 && /Budget per run:\s+no cap/.test(cleared.out) && /Subagent depth:\s+Automatic/.test(cleared.out), 'projects set --max-budget none --max-depth auto clears both', show(cleared))
  const stored = storedProject(cj?.project?.id)
  check(stored && stored.maxBudgetUsd === undefined && stored.maxSubagentDepth === undefined && stored.preferEverydayNearLimit === false, 'the cleared fields are stored as unset', JSON.stringify(stored && { b: stored.maxBudgetUsd, d: stored.maxSubagentDepth }))

  // Run staffing, review and retention flags (cli-parity 3.2).
  const sShown = json((await cli(['projects', 'show', '--output-format', 'json'], { cwd: codeDir })).out)
  const sp = sShown?.project
  check(sp && sp.staffing === 'auto' && sp.staffingGoal === 'balanced' && sp.reviewPolicy === 'risk' && sp.reviewMerges === false && sp.maxWindowShare === null && sp.keepRuns === 100 && sp.brief === '', 'projects show --output-format json returns staffing, staffingGoal, reviewPolicy, reviewMerges, maxWindowShare, keepRuns and brief', JSON.stringify(sp))
  const fixed = await cli(['projects', 'set', '--staffing', 'fixed', '--staffing-goal', 'speed', '--review-policy', 'always', '--review-merges', 'on', '--max-window-share', '40', '--keep-runs', '7', '--output-format', 'json'], { cwd: codeDir })
  const fj = json(fixed.out)?.project
  check(fixed.code === 0 && fj?.staffing === 'fixed' && fj.staffingGoal === 'speed' && fj.reviewPolicy === 'always' && fj.reviewMerges === true && fj.maxWindowShare === 40 && fj.keepRuns === 7, 'projects set --staffing fixed --staffing-goal speed --review-policy always --review-merges on --max-window-share 40 --keep-runs 7', show(fixed))
  const sStored = storedProject(cj?.project?.id)
  check(sStored && sStored.staffing === 'fixed' && sStored.staffingGoal === 'speed' && sStored.reviewPolicy === 'always' && sStored.reviewMerges === true && sStored.maxWindowShare === 40 && sStored.keepRuns === 7, 'the staffing, review and retention fields are stored', JSON.stringify(sStored))
  const refused = await cli(['projects', 'set', '--staffing', 'auto'], { cwd: codeDir })
  check(refused.code !== 0 && storedProject(cj?.project?.id)?.staffing === 'fixed', '--staffing auto from fixed without --yes (no terminal) changes nothing', show(refused))
  const auto = await cli(['projects', 'set', '--staffing', 'auto', '--yes', '--staffing-goal', 'balanced', '--review-policy', 'risk', '--review-merges', 'off', '--max-window-share', 'auto', '--keep-runs', 'auto', '--output-format', 'json'], { cwd: codeDir })
  const aj = json(auto.out)?.project
  check(auto.code === 0 && aj?.staffing === 'auto' && aj.staffingGoal === 'balanced' && aj.reviewPolicy === 'risk' && aj.reviewMerges === false && aj.maxWindowShare === null && aj.keepRuns === 100, 'projects set --staffing auto --yes and the other defaults restore them', show(auto))
  const badShare = await cli(['projects', 'set', '--max-window-share', '0.4'], { cwd: codeDir })
  check(badShare.code === 2 && /--max-window-share/.test(badShare.err), '--max-window-share as a fraction exits 2', show(badShare))
  const badPolicy = await cli(['projects', 'set', '--review-policy', 'sometimes'], { cwd: codeDir })
  check(badPolicy.code === 2 && /--review-policy must be one of/.test(badPolicy.err), '--review-policy outside always|risk|never exits 2', show(badPolicy))

  const badKind = await cli(['projects', 'create', engDir, '--kind', 'website'])
  check(badKind.code === 2, '--kind outside code|engagement exits 2', show(badKind))

  const checked = await cli(['projects', 'check', codeDir])
  check(checked.code === 0 && /Git repository:\s+yes/.test(checked.out) && /Already a project: E2E code/.test(checked.out), 'projects check', show(checked))

  const removed = await cli(['projects', 'remove', engDir, '--yes', '--output-format', 'json'])
  const rj = json(removed.out)
  check(removed.code === 0 && rj?.removed === true && rj.result?.kind === 'engagement', 'projects remove --yes (JSON)', show(removed))
  const noTty = await cli(['projects', 'remove', codeDir])
  check(noTty.code === 2 && /--yes/.test(noTty.err), 'projects remove without a terminal or --yes exits 2', show(noTty))
  const removedCode = await cli(['projects', 'remove', codeDir, '--yes'])
  check(removedCode.code === 0 && /Removed E2E code/.test(removedCode.out), 'projects remove --yes (text)', show(removedCode))
}

async function partB() {
  const dir = fixture('cli-init-skip')
  const r = await cli(['init', '--skip-architect', '--name', 'E2E init'], { cwd: dir })
  check(r.code === 0 && /Created project E2E init/.test(r.out), 'init --skip-architect creates the project and exits 0', show(r))
  const again = await cli(['init', '--skip-architect'], { cwd: dir })
  check(again.code === 0 && again.out.includes('Already an OrgAI project: E2E init'), 'init --skip-architect again says it is already a project', show(again))
  const noTty = await cli(['init'], { cwd: fixture('cli-init-notty') })
  check(noTty.code === 2 && noTty.err.includes('needs a terminal for the Architect interview'), 'init without a terminal exits 2', show(noTty))
}

// An unfocused tray shows only "Alt+D or F2 to answer" (keymap.ts UNFOCUSED_HINT); a focused one shows "Approve" / "Allow once".
const CARD_ON_SCREEN = /Approve|Allow once|to answer/

async function partC() {
  const dir = fixture('cli-init-tui')
  const t = spawnTui([process.execPath, '--disable-sigusr1', CLI, '--no-color', 'init', '--name', 'E2E architect'], { cols: 120, rows: 34, cwd: dir, env: ttyEnv() })
  let approved = 0
  try {
    await t.waitFor('Architect setup', 30_000)
    check(true, 'init opens the TUI with the "Architect setup" title')
    const end = Date.now() + 120_000
    while (!t.exitInfo && Date.now() < end) {
      if (CARD_ON_SCREEN.test(t.screen())) {
        t.key('f2')
        await sleep(900) // past the 750 ms card-swap guard
        t.write('y')
        approved++
        await t.waitFor((s) => !CARD_ON_SCREEN.test(s), 8_000).catch(() => undefined)
      }
      await sleep(250)
    }
    const e = await Promise.race([t.exited, sleep(20_000).then(() => null)])
    check(e?.code === 0, 'init exits 0 after complete_setup', `exit ${e?.code} after ${approved} approvals; screen:\n${t.screen().slice(-1200)}\n${t.stderr().slice(-400)}`)
    check(approved >= 4, 'the permission, architecture, org chart and settings cards were approved with y', `approved ${approved}`)
    check(/Architect setup finished/.test(t.text()), 'init prints "Architect setup finished." after restoring the terminal', t.text().slice(-400))
    const list = json((await cli(['projects', 'list', '--output-format', 'json'])).out)
    const p = list?.projects?.find((x) => x.name === 'E2E architect')
    const stored = p ? storedProject(p.id) : null
    check(stored?.setup?.state === 'complete', "the project's setup reads complete", JSON.stringify(stored?.setup))
  } finally {
    await t.close()
  }
}

async function partD() {
  const dir = fixture('cli-init-stop')
  const t = spawnTui([process.execPath, '--disable-sigusr1', CLI, '--no-color', 'init', '--name', 'E2E stop'], { cols: 120, rows: 34, cwd: dir, env: ttyEnv() })
  try {
    await t.waitFor('Architect setup', 30_000)
    // Wait for the first card so the run is surely open, then quit with Ctrl+C twice.
    await t.waitFor(CARD_ON_SCREEN, 30_000).catch(() => undefined)
    t.key('ctrl+c')
    await sleep(300)
    t.key('ctrl+c')
    const e = await Promise.race([t.exited, sleep(20_000).then(() => null)])
    check(e?.code === 130, 'Ctrl+C twice stops the setup run and exits 130', `exit ${e?.code}; screen:\n${t.screen().slice(-800)}`)
    check(/Architect setup stopped/.test(t.text()), 'it prints "Architect setup stopped."', t.text().slice(-300))
    const runs = await cli(['runs', 'list'], { cwd: dir })
    check(runs.code === 0 && /Stopped/.test(runs.out), 'the setup run reads Stopped', show(runs))
  } finally {
    await t.close()
  }
}

try {
  await partA()
  await partB()
  const backend = process.platform === 'win32' ? null : await probePty()
  if (!backend) log('SKIP cli-projects (c), (d): no pseudo-terminal backend here')
  else {
    log(`pty backend: ${backend}`)
    await partC()
    await partD()
  }
} catch (e) {
  check(false, 'cli-projects ran to the end', e?.stack ?? String(e))
} finally {
  for (const d of fixtures) removeFixture(d)
}
finish('cli-projects')
