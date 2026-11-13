// `orgai org evolve` (Pareto-ratchet team evolution) end to end. Run `npm run build` first. Mock adapter only
// (ORGAI_MOCK=1): no tokens, no network, no windows. Every command hosts itself in its own process, one at a time.
//
// Fixture A (a git repo, a deliberately poor chart): `researcher` on `deep` with a >1,000-char prompt full of repeated
// lines, an `implementer` whose reports collide on `src/routes/` worktrees, a read-only `reviewer`, an unused skill
// grant, and four seeded finished work runs plus a seeded skill evaluation (repeated tool routine, never-loaded
// skill), written in the stores' real on-disk formats (runs.json / runs/<id>.json, skill-evaluations/<id>.json).
//
// 1. `org evolve` (text and JSON): the findings, wasteScore > 0, nothing changed (dry run).
// 2. `org evolve --apply --eval-window 10` non-TTY: gen_1 on trial in <data>/evolution/<projectId>.json, the researcher
//    cheaper, the prompt budget kept, the read-only reviewer gains no write / exec tool, `.orgai/` state as the fixture has it.
// 3. `org evolve loop --iterations 2` and `exec --evolve` unattended on mock runs (the trial window of 10 stays open).
// 4. `org retro <run> --unattended` (the headless retro).
// 5. Fixture B (same chart): apply a 2-run trial, seed two regressed runs right after it, settle the window with
//    `exec --evolve` (the post-run ratchet): automatic rollback, the fingerprint in rejectedHypotheses[], and a following
//    `org evolve` does not re-propose it.
// 6. `org evolve history` and a manual `org evolve rollback` on fixture A.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { check, finish, log, makeFixtureRepo, removeFixture } from './lib.mjs'
import { cli, HOST_DATA_DIR, json, requireBuild, seedProject, show, storedProject, PROJECTS_JSON } from './cliLib.mjs'

requireBuild()

const WRITE_EXEC = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit'])
const MOCK_TASK = '[mock:exec-plan] tidy the notes api'

// ---------- fixture ----------

const FILLER = [
  'Always read the relevant files before you answer a question about the code base.',
  'Cite file paths and line numbers for every claim you make about the code base.',
  'Always read the relevant files before you answer a question about the code base.',
  'Never guess: when a fact is missing, say what you would read next to find it.',
  'Cite file paths and line numbers for every claim you make about the code base.',
  'Summarise findings in short bullet points and keep every bullet to one line.',
  'Never guess: when a fact is missing, say what you would read next to find it.',
  'Summarise findings in short bullet points and keep every bullet to one line.'
]
const LONG_PROMPT = `You are the researcher. ${FILLER.join('\n')}\n${FILLER.join('\n')}\n${FILLER.join('\n')}\nReport back to the orchestrator with what you found and what is still unknown.`

const NOW = Date.now()
const HOUR = 3_600_000

function agentOf({ id, slug, roleId, parent = 'root', start, wallMs = 20_000, cost, turns = 3, out = 500, input = 1000, conflict = false, files }) {
  return {
    id,
    roleId,
    roleSlug: slug,
    name: slug,
    parentId: parent,
    spawnToolUseId: null,
    state: 'done',
    activity: '',
    inputTokens: input,
    outputTokens: out,
    costUsd: cost,
    usage: { tokens: { input, output: out, cacheRead: 0, cacheWrite: 0 }, models: [], costUsd: cost, costSource: 'provider', turns, toolCalls: 4, retries: 0 },
    startedAt: start,
    endedAt: start + wallMs,
    result: 'ok',
    ...(files ? { worktree: { path: `/wt/${id}`, branch: `wt-${id}`, status: conflict ? 'conflict' : 'merged', changedFiles: files } } : {})
  }
}

/** One finished work run in the stores' format: baseline (cheap-ish, researcher heavy, implementers colliding) or regressed. */
function runRecord({ id, projectId, startedAt, ids, conflicts = false, regressed = false }) {
  const wallMs = regressed ? 900_000 : 120_000
  const cost = regressed ? 14 : 1.5
  const agents = {
    root: agentOf({ id: 'root', slug: 'orchestrator', roleId: ids.orchestrator, parent: null, start: startedAt, wallMs, cost: 0.2 }),
    r1: agentOf({ id: 'r1', slug: 'researcher', roleId: ids.researcher, start: startedAt + 1000, cost: regressed ? 2 : 0.45, turns: 3, out: 600, input: 9000 }),
    r2: agentOf({ id: 'r2', slug: 'researcher', roleId: ids.researcher, start: startedAt + 2000, cost: regressed ? 2 : 0.45, turns: 3, out: 700, input: 9000 }),
    i1: agentOf({ id: 'i1', slug: 'implementer', roleId: ids.implementer, start: startedAt + 3000, cost: 0.12, files: ['src/routes/notes.js', 'src/routes/index.js'] }),
    i2: agentOf({ id: 'i2', slug: 'implementer', roleId: ids.implementer, start: startedAt + 3500, cost: 0.12, conflict: conflicts, files: ['src/routes/notes.js'] })
  }
  if (regressed) agents.i2.state = 'error'
  const usage = {
    tokens: { input: regressed ? 400_000 : 40_000, output: 5000, cacheRead: 0, cacheWrite: 0 },
    costUsd: cost,
    costSource: 'provider',
    models: [],
    roles: [],
    wallMs,
    turns: 5,
    toolCalls: 5,
    retries: 0,
    agents: 5,
    agentsWithoutResult: 0,
    noResultTokens: 0,
    nudges: 0,
    waitingMs: 0,
    limitHoldMs: 0,
    idleMs: 0,
    updatedAt: 0
  }
  const summary = { id, projectId, kind: 'work', prompt: 'improve the notes api', status: regressed ? 'error' : 'finished', startedAt, endedAt: startedAt + wallMs, totalCostUsd: cost, usage, ...(regressed ? { error: 'seeded failure' } : {}) }
  return { summary, agents, transcript: [], logs: [] }
}

function writeRuns(records) {
  const idx = path.join(HOST_DATA_DIR, 'runs.json')
  const existing = fs.existsSync(idx) ? JSON.parse(fs.readFileSync(idx, 'utf8')) : { version: 1, runs: [] }
  fs.mkdirSync(path.join(HOST_DATA_DIR, 'runs'), { recursive: true })
  for (const rec of records) {
    existing.runs.push(rec.summary)
    fs.writeFileSync(path.join(HOST_DATA_DIR, 'runs', `${rec.summary.id}.json`), JSON.stringify(rec))
  }
  fs.writeFileSync(idx, JSON.stringify({ version: 1, runs: existing.runs }, null, 2))
}

function editStoredProject(id, fn) {
  const doc = JSON.parse(fs.readFileSync(PROJECTS_JSON, 'utf8'))
  const p = doc.projects.find((x) => x.id === id)
  fn(p)
  fs.writeFileSync(PROJECTS_JSON, JSON.stringify(doc, null, 2))
}

/** Seed one poor project: the chart, an unused skill grant, four finished runs and a skill evaluation. Returns { project, ids, repo }. */
async function seedPoorProject(tag, name) {
  const repo = makeFixtureRepo(tag)
  const seeded = await seedProject(repo, { name })
  editStoredProject(seeded.id, (p) => {
    const orch = p.roles.find((r) => r.slug === 'orchestrator')
    const researcher = p.roles.find((r) => r.slug === 'researcher')
    researcher.tier = 'deep'
    researcher.model = 'opus'
    researcher.prompt = LONG_PROMPT
    researcher.tools = ['Read', 'Glob', 'Grep']
    p.roles = p.roles.filter((r) => ['orchestrator', 'implementer', 'reviewer', 'researcher'].includes(r.slug))
    orch.spawnable = p.roles.filter((r) => r.id !== orch.id).map((r) => r.id)
    p.staffing = 'auto'
    p.staffingGoal = 'balanced'
  })
  let r = await cli(['--output-format', 'json', 'skills', 'create', '--name', 'unused-helper', '--description', 'A helper no run ever loads', '--text', 'Use this helper for nothing in particular.', '--role', 'implementer'], { cwd: repo })
  if (r.code !== 0) throw new Error(`skills create failed: ${show(r)}`)
  const project = storedProject(seeded.id)
  const ids = Object.fromEntries(project.roles.map((x) => [x.slug, x.id]))
  const skillId = project.skills?.[0]?.id
  if (!skillId) throw new Error('the seeded skill has no id')
  const records = []
  for (let i = 0; i < 4; i++) {
    records.push(runRecord({ id: `run_${tag}_${i + 1}`, projectId: project.id, startedAt: NOW - (10 - i) * HOUR, ids, conflicts: i % 2 === 0 }))
  }
  writeRuns(records)
  const evalFile = path.join(HOST_DATA_DIR, 'skill-evaluations', `${project.id}.json`)
  fs.mkdirSync(path.dirname(evalFile), { recursive: true })
  fs.writeFileSync(
    evalFile,
    JSON.stringify({
      projectId: project.id,
      at: NOW - HOUR,
      runsConsidered: 4,
      findings: [
        { id: 'f1', kind: 'neverLoaded', severity: 'info', skillIds: [skillId], title: 'unused-helper was never loaded', detail: 'No run loaded it.' },
        { id: 'f2', kind: 'repeatedToolSequence', severity: 'info', skillIds: [], title: 'Grep, Read, Edit repeats', detail: 'The same routine in 4 runs.', evidence: { runIds: records.map((x) => x.summary.id), sequence: ['Grep', 'Read', 'Edit'], count: 4 } }
      ],
      suggestions: [],
      modelAssisted: false
    })
  )
  return { project, ids, repo, runIds: records.map((x) => x.summary.id) }
}

const ledgerPath = (projectId) => path.join(HOST_DATA_DIR, 'evolution', `${projectId}.json`)
const readLedger = (projectId) => json(fs.existsSync(ledgerPath(projectId)) ? fs.readFileSync(ledgerPath(projectId), 'utf8') : '')
const promptChars = (p) => p.roles.reduce((n, r) => n + (r.prompt?.length ?? 0), 0)
const kindsOf = (v) => (v?.diagnosis?.findings ?? []).map((f) => f.kind)

const repos = []
try {
  // ---------- fixture A ----------
  const A = await seedPoorProject('evoA', 'Evolve A')
  repos.push(A.repo)
  const at = (args, opts = {}) => cli(args, { cwd: A.repo, timeoutMs: 180_000, ...opts })
  const jsonAt = async (args, opts) => {
    const r = await at(['--output-format', 'json', ...args], opts)
    return { r, v: json(r.out) }
  }
  log('fixture A at', A.repo, 'project', A.project.id)
  const before = storedProject(A.project.id)

  // ---------- 1. dry run ----------
  let r = await at(['org', 'evolve'])
  check(r.code === 0 && /Waste score: \d+\/100/.test(r.out) && r.out.includes('Findings') && r.out.includes('Safety gate:') && r.out.includes('Prompt budget:') && r.out.includes('Estimated savings:'), 'org evolve prints the digest, findings, gate, prompt budget and savings', show(r))
  let j = await jsonAt(['org', 'evolve'])
  const kinds = kindsOf(j.v)
  check(j.r.code === 0 && j.v?.dryRun === true && j.v.diagnosis.wasteScore > 0, 'org evolve JSON: dry run with wasteScore > 0', show(j.r))
  check(kinds.includes('tier_overprovisioned'), 'finding: tier_overprovisioned (the researcher on deep)', kinds.join(','))
  check(kinds.includes('prompt_deflation') || kinds.includes('skill_crystallization'), 'finding: prompt_deflation or skill_crystallization', kinds.join(','))
  check(kinds.includes('merge_conflict_hotspot') || kinds.includes('serial_bottleneck'), 'finding: merge_conflict_hotspot or serial_bottleneck', kinds.join(','))
  check(j.v?.plan && typeof j.v.plan.fingerprint === 'string' && j.v.plan.gate && j.v.plan.promptChars?.limit > 0, 'the plan carries a fingerprint, the gate verdict and the prompt budget', JSON.stringify(j.v?.plan ?? {}).slice(0, 300))
  check(!fs.existsSync(ledgerPath(A.project.id)) && JSON.stringify(storedProject(A.project.id).roles) === JSON.stringify(before.roles), 'the dry run changed nothing (no ledger, same chart)')
  r = await at(['org', 'evolve', '--runs', '0'])
  check(r.code === 2, 'org evolve --runs 0 is exit 2', show(r))
  r = await at(['org', 'evolve', '--eval-window', '3'])
  check(r.code === 2, 'org evolve --eval-window without --apply is exit 2', show(r))

  // ---------- 2. apply ----------
  // Without a terminal and without --yes the apply asks nobody: exit 2 before any host call, nothing written.
  r = await at(['org', 'evolve', '--apply'])
  check(r.code === 2 && /--yes/.test(r.err), 'org evolve --apply without --yes and without a terminal is exit 2', show(r))
  r = await at(['org', 'evolve', '-y'])
  check(r.code === 2, 'org evolve -y alone (no --apply) is exit 2', show(r))
  r = await at(['org', 'retro', A.runIds[0], '--unattended', '--apply'])
  check(r.code === 2, 'org retro --unattended --apply without --yes and without a terminal is exit 2', show(r))
  check(!fs.existsSync(ledgerPath(A.project.id)) && JSON.stringify(storedProject(A.project.id).roles) === JSON.stringify(before.roles), 'the refused applies wrote nothing (no ledger, same chart)')
  const applied = await jsonAt(['org', 'evolve', '--apply', '--yes', '--eval-window', '10'])
  check(applied.r.code === 0 && applied.v?.applied === true && applied.v.generation?.id === 'gen_1' && applied.v.generation.status === 'trial', 'org evolve --apply (non-TTY) applies gen_1 as a trial', show(applied.r))
  const ledger = readLedger(A.project.id)
  const gens = ledger?.generations ?? []
  check(gens.some((g) => g.id === 'gen_1' && g.status === 'trial'), `<dataDir>/evolution/<projectId>.json holds gen_1 with status trial`, JSON.stringify(ledger ?? {}).slice(0, 300))
  const after = storedProject(A.project.id)
  const roleOf = (p, slug) => p.roles.find((x) => x.slug === slug)
  const TIER_RANK = { fast: 0, everyday: 1, deep: 2, top: 3 }
  const newResearcher = roleOf(after, 'researcher')
  check(TIER_RANK[newResearcher.tier] < TIER_RANK.deep, `the researcher is cheaper than deep (now ${newResearcher.tier})`, JSON.stringify({ tier: newResearcher.tier, model: newResearcher.model, effort: newResearcher.effort }))
  const limit = applied.v?.plan?.promptChars?.limit ?? 0
  check(limit > 0 && promptChars(after) <= limit && promptChars(after) < promptChars(before), `total prompt characters ${promptChars(before)} -> ${promptChars(after)} within the anti-bloat limit ${limit}`)
  check(!(roleOf(after, 'reviewer').tools ?? []).some((t) => WRITE_EXEC.has(t)), 'the read-only reviewer gained no write or exec tool', JSON.stringify(roleOf(after, 'reviewer').tools))
  // No repo-derived text (the seeded conflict paths src/routes/...) may reach a role prompt.
  const leaked = after.roles.filter((x) => /routes|notes\.js|src\/routes/i.test(x.prompt ?? '')).map((x) => x.slug)
  check(leaked.length === 0, 'no role prompt contains a directory or file name from the seeded conflict paths', leaked.map((s) => `${s}: ${(roleOf(after, s).prompt.match(/.{0,60}(routes|notes\.js).{0,60}/is) ?? [''])[0]}`).join(' | '))
  const orgaiDir = path.join(A.repo, '.orgai')
  check(typeof applied.v?.teamFilesSynced === 'boolean' && applied.v.teamFilesSynced === fs.existsSync(orgaiDir), `.orgai/ sync state matches the fixture (teamFilesSynced=${applied.v?.teamFilesSynced}, folder ${fs.existsSync(orgaiDir) ? 'present' : 'absent'})`)
  r = await at(['org', 'evolve', '--apply', '--yes'])
  check(r.code === 0 && /Nothing (was|would be) applied/.test(r.out), 'a second --apply --yes while a trial is active applies nothing', show(r))

  // ---------- 3. loop and exec --evolve ----------
  r = await at(['org', 'evolve', 'loop', '--prompt', MOCK_TASK, '--iterations', '2'])
  check(r.code === 0 && /Gen\s+\|\s+Role\/Tier Delta\s+\|\s+Input Tok\s+\|\s+Cost\s+\|\s+Wall ms\s+\|\s+Outcome\s+\|\s+Ratchet Action/.test(r.out) && (r.out.match(/\| completed/g) ?? []).length === 2, 'org evolve loop --iterations 2 prints the generation table with two completed runs', show(r))
  log('loop table:\n' + r.out.split('\n').slice(0, 8).join('\n'))
  j = await jsonAt(['org', 'evolve', 'loop', '--prompt', MOCK_TASK, '--iterations', '1'])
  check(j.r.code === 0 && j.v?.iterations === 1 && j.v.rows?.length === 1 && j.v.rows[0].outcome === 'completed' && j.v.rows[0].gen === 'gen_1' && j.v.stoppedEarly === false, 'loop JSON: one row on gen_1, completed, not stopped early', show(j.r))
  r = await at(['org', 'evolve', 'loop', '--prompt', MOCK_TASK, '--iterations', '11'])
  check(r.code === 2, 'loop --iterations 11 is exit 2 (hard bound of 10)', show(r))
  r = await at(['exec', '--evolve', MOCK_TASK])
  check(r.code === 0 && /Team evolution: /.test(r.err) && !/Team evolution/.test(r.out), 'exec --evolve (text): the pass is one stderr line, stdout stays the run', show(r))
  j = await jsonAt(['exec', '--evolve=deterministic', MOCK_TASK])
  check(j.r.code === 0 && j.v?.evolve && typeof j.v.evolve.ratchet === 'string' && j.v.outcome === 'completed', 'exec --evolve (json) carries an evolve object', show(j.r))
  r = await at(['exec', '--evolve', '--quick', MOCK_TASK])
  check(r.code === 2, 'exec --evolve --quick is exit 2', show(r))

  // ---------- 4. retro --unattended ----------
  r = await at(['org', 'retro', A.runIds[0]])
  check(r.code === 2 && r.err.includes('--unattended'), 'org retro without a terminal points at --unattended (exit 2)', show(r))
  j = await jsonAt(['org', 'retro', A.runIds[0], '--unattended'])
  check(j.r.code === 0 && j.v?.mode === 'evolve-analysis' && j.v.diagnosis?.findings && j.v.dryRun === true, 'org retro --unattended runs the evolve analysis of the run\'s project', show(j.r))

  // ---------- 5. regressed trial, automatic rollback (fixture B) ----------
  const B = await seedPoorProject('evoB', 'Evolve B')
  repos.push(B.repo)
  const atB = (args, opts = {}) => cli(args, { cwd: B.repo, timeoutMs: 180_000, ...opts })
  const beforeB = storedProject(B.project.id)
  const appliedB = json((await atB(['--output-format', 'json', 'org', 'evolve', '--apply', '--yes', '--eval-window', '2'])).out)
  check(appliedB?.applied === true && appliedB.generation?.id === 'gen_1', 'fixture B: gen_1 applied as a 2-run trial', JSON.stringify(appliedB ?? {}).slice(0, 300))
  const appliedAt = readLedger(B.project.id)?.generations?.find((g) => g.id === 'gen_1')?.appliedAt
  check(typeof appliedAt === 'number', 'fixture B: the ledger records appliedAt', String(appliedAt))
  const fingerprint = appliedB?.generation?.fingerprint
  writeRuns([
    runRecord({ id: 'run_evoB_bad1', projectId: B.project.id, startedAt: appliedAt + 1, ids: B.ids, regressed: true }),
    runRecord({ id: 'run_evoB_bad2', projectId: B.project.id, startedAt: appliedAt + 2, ids: B.ids, regressed: true })
  ])
  // The post-run pass evaluates the full window: the first two runs after the trial began are the regressed ones.
  const settle = json((await atB(['--output-format', 'json', 'exec', '--evolve', MOCK_TASK])).out)
  check(settle?.evolve?.ratchet === 'rolled_back', 'exec --evolve settles the trial: ratchet rolled_back', JSON.stringify(settle?.evolve ?? settle ?? {}).slice(0, 400))
  const histB = json((await atB(['--output-format', 'json', 'org', 'evolve', 'history'])).out)?.history
  const gen1 = histB?.generations?.find((g) => g.id === 'gen_1')
  check(gen1?.status === 'rolled_back' && !histB.trialId, 'history: gen_1 rolled_back and no active trial', JSON.stringify(histB ?? {}).slice(0, 400))
  check((histB?.rejectedHypotheses ?? []).some((h) => h.fingerprint === fingerprint), 'the rolled-back fingerprint is in rejectedHypotheses[]', JSON.stringify(histB?.rejectedHypotheses ?? []).slice(0, 300))
  const restored = storedProject(B.project.id)
  check(roleOf(restored, 'researcher').tier === roleOf(beforeB, 'researcher').tier && roleOf(restored, 'researcher').prompt === roleOf(beforeB, 'researcher').prompt, 'the researcher is back to its pre-trial tier and prompt')
  const again = json((await atB(['--output-format', 'json', 'org', 'evolve'])).out)
  const reproposed = again?.plan && !again.plan.empty && again.plan.fingerprint === fingerprint && again.plan.gate?.ok !== false && !(again.plan.gate?.violations ?? []).some((v) => v.rule === 'rejected_hypothesis')
  check(again && !reproposed, 'a following org evolve does not re-propose the rejected plan', JSON.stringify(again?.plan ?? {}).slice(0, 400))

  // ---------- 6. history and manual rollback (fixture A) ----------
  r = await at(['org', 'evolve', 'history'])
  check(r.code === 0 && r.out.includes('active trial: gen_1') && r.out.includes('gen_1 [trial]'), 'org evolve history (text): the active trial', show(r))
  r = await at(['org', 'evolve', 'status'])
  check(r.code === 0 && r.out.includes('gen_1'), 'org evolve status is an alias of history', show(r))
  j = await jsonAt(['org', 'evolve', 'history'])
  check(j.r.code === 0 && j.v?.history?.trialId === 'gen_1' && Array.isArray(j.v.history.generations) && j.v.history.generations[0].baselineMetrics, 'history JSON: trialId, generations with baseline metrics', show(j.r))
  r = await at(['org', 'evolve', 'rollback', 'nope'])
  check(r.code === 2, 'rollback with a malformed generation id is exit 2', show(r))
  j = await jsonAt(['org', 'evolve', 'rollback'])
  check(j.r.code === 0 && j.v?.rolledBack === true && j.v.generation?.id === 'gen_1', 'org evolve rollback undoes the active trial', show(j.r))
  const rolled = storedProject(A.project.id)
  check(roleOf(rolled, 'researcher').tier === 'deep' && roleOf(rolled, 'researcher').prompt === LONG_PROMPT, 'the chart is as it was before gen_1')
  const histA = json((await at(['--output-format', 'json', 'org', 'evolve', 'history'])).out)?.history
  check(histA?.generations?.find((g) => g.id === 'gen_1')?.status === 'rolled_back' && !histA.trialId, 'history after rollback: gen_1 rolled_back, no trial', JSON.stringify(histA ?? {}).slice(0, 300))
  r = await at(['org', 'evolve', 'rollback'])
  check(r.code !== 0, 'a second rollback with nothing left to undo is not success', show(r))
} catch (e) {
  check(false, 'the script ran to the end', e?.stack ?? String(e))
} finally {
  for (const repo of repos) removeFixture(repo)
}
finish('cli-org-evolve')
