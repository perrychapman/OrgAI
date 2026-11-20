#!/usr/bin/env node
// Token-free benchmark of unattended org chart self-healing (src/main/evolve/). For each reference chart (small,
// medium, large) and each injected defect, it simulates finished team work runs, and after every run calls the REAL
// engine the way the host's post-run pass does: createEvolveService (in-memory project store, a temp ledger folder)
// with analyze (read-only, for detection) then afterRun({ evolve: true, strategy: 'deterministic' }) (settle a trial,
// else diagnose, synthesize, gate, hold spend raises, apply as a trial). No Electron, no model calls, no network.
//
//   node scripts/bench-org-heal.mjs                     all cases, report under bench-results/org-heal/<UTC>/
//   node scripts/bench-org-heal.mjs --seed 7            another seed (default 1)
//   node scripts/bench-org-heal.mjs --case small:serial one case (or a defect id for all its charts, or 'control')
//   node scripts/bench-org-heal.mjs --out <dir>         write results.json and report.md there
//   node scripts/bench-org-heal.mjs --json              print results.json to stdout instead of the summary
//
// Method, simulator rules and limits: docs/design/org-chart-self-healing-bench.md.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { COMPLEXITIES, referenceCharts } from './lib/org-bench/heal/charts.mjs'
import { CONTROL, DEFECTS } from './lib/org-bench/heal/defects.mjs'
import { simulateRun } from './lib/org-bench/heal/simulate.mjs'
import { LAST_WINDOW, WASTE_THRESHOLD, chartDiff, classify, collateral, detectedAt, diffText, excessUsd, fieldHealed, gapsOf, matrixOf, matchFinding, oscillations, reportMarkdown, symptomOf, windowStats } from './lib/org-bench/heal/measure.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Runs simulated per case (fixed, so excess costs compare across cases). */
export const HORIZON = 60
/** Generations the loop allows per case; once this many are applied and decided, later runs get no post-run pass. */
export const MAX_GENERATIONS = 6

let engine
async function loadEngine() {
  if (engine) return engine
  const require = createRequire(import.meta.url)
  const jiti = require('jiti').createJiti(import.meta.url, { fsCache: false, alias: { '@shared': join(root, 'src/shared') } })
  const load = (rel) => jiti.import(join(root, rel))
  const service = await load('src/main/evolve/service.ts')
  const skills = await load('src/main/skills/evaluate.ts')
  const synth = await load('src/main/evolve/synthesizer.ts')
  const plan = await load('src/main/evolve/plan.ts')
  engine = { createEvolveService: service.createEvolveService, evaluateSkills: skills.evaluateSkills, deterministicPlan: synth.deterministicPlan, patchFingerprint: plan.patchFingerprint }
  return engine
}

const clone = (v) => structuredClone(v)

/** Every case id the bench knows, in order: `<complexity>:<defect>` and `<complexity>:control`. */
export function allCases() {
  const out = []
  for (const cx of COMPLEXITIES) {
    out.push({ id: `${cx}:control`, complexity: cx, defect: CONTROL })
    for (const d of DEFECTS) if (d.target(cx) !== null && d.target(cx) !== undefined) out.push({ id: `${cx}:${d.id}`, complexity: cx, defect: d })
  }
  return out
}

function selectCases(filter) {
  const all = allCases()
  if (!filter) return all
  const hit = all.filter((c) => c.id === filter || c.defect.id === filter || c.complexity === filter)
  if (!hit.length) throw new Error(`Unknown case "${filter}". Known: ${all.map((c) => c.id).join(', ')}`)
  return hit
}

/** The frozen reference: the same runs on the healthy chart with evolution off. */
function baselineOf(complexity, seed) {
  const chart = referenceCharts()[complexity]
  const rows = []
  for (let i = 1; i <= HORIZON; i++) rows.push(simulateRun({ chart, project: chart.project, runIndex: i, seed }).sim)
  return rows
}

async function runCase(spec, seed, base) {
  const { createEvolveService, evaluateSkills, deterministicPlan, patchFingerprint } = await loadEngine()
  const ref = referenceCharts()[spec.complexity]
  const chart = referenceCharts()[spec.complexity]
  const target = spec.defect.target(spec.complexity)
  const inj = spec.defect.inject(chart, target)
  const start = clone(chart.project)
  const simChart = { id: spec.complexity, truth: chart.truth, tasks: chart.tasks }
  // The counterfactual: the same runs on the defective chart with evolution off.
  const frozen = []
  for (let i = 1; i <= HORIZON; i++) frozen.push(simulateRun({ chart: simChart, project: start, runIndex: i, seed }).sim)
  const store = { project: clone(chart.project), runs: [] }
  let clock = 0
  const dataDir = mkdtempSync(join(tmpdir(), 'orgai-heal-'))
  const svc = createEvolveService({
    dataDir,
    getProject: (id) => (id === store.project.id ? clone(store.project) : undefined),
    updateProject: (id, fn) => {
      if (id !== store.project.id) throw new Error('Project not found')
      store.project = fn(clone(store.project))
      return clone(store.project)
    },
    // Newest first, measured runs only (the host's listRunRecords filters the same way).
    listRunRecords: (_id, limit) => store.runs.slice(0, limit),
    staffingProfile: () => ({ mode: 'auto', goal: 'balanced' }),
    // As if the skill evaluation had just run over the newest SKILL_EVALUATION_RUNS (20) work runs; no project skill
    // bodies are given, so only the gap findings (repeated tool sequences) can appear.
    skillFindings: () => {
      const ev = evaluateSkills({ roles: store.project.roles, skills: [], runs: store.runs.slice(0, 20).map((r) => ({ summary: r.summary, transcript: r.transcript })), pathExists: () => true })
      return [...ev.quality, ...ev.gaps]
    },
    now: () => clock,
    log: () => {}
  })
  const rows = []
  const events = []
  const gateRules = {}
  const held = new Set()
  let heldPasses = 0
  let rejectedReproposed = 0
  let proposedForDefect = false
  let lastChangeRun = 0
  let passes = 0
  let finalWaste = 0
  const appliedSummaries = []
  const applies = []
  let gens = []
  const touchesDefect = (plan) =>
    plan.rolePatches.some((p) => inj.touched.some((t) => t.slug === p.slug)) ||
    (inj.touched.some((t) => t.project === 'maxConcurrentSubagents') && plan.maxConcurrentSubagents !== undefined) ||
    (spec.defect.id === 'conflict' && plan.rolePatches.some((p) => p.prompt !== undefined))
  try {
    for (let i = 1; i <= HORIZON; i++) {
      const { record, sim } = simulateRun({ chart: simChart, project: store.project, runIndex: i, seed })
      store.runs.unshift(record)
      clock = record.summary.endedAt + 1000
      const histBefore = svc.history(store.project.id)
      const capped = histBefore.generations.length >= MAX_GENERATIONS && !histBefore.trialId
      const an = await svc.analyze({ projectId: store.project.id, strategy: 'deterministic' })
      finalWaste = an.diagnosis.wasteScore
      let pass = 'no pass (generation cap reached)'
      if (!capped) {
        passes++
        const planRules = [...new Set(an.plan.gate.violations.map((v) => v.rule))]
        for (const r of planRules) gateRules[r] = (gateRules[r] ?? 0) + 1
        if (!an.plan.empty && touchesDefect(an.plan)) proposedForDefect = true
        // A rejected hypothesis proposed again: the plan the synthesizer builds with no memory holds a patch whose
        // fingerprint is on the ledger's rejected list (deterministicPlan drops it silently, so the gate never sees it).
        const rejected = new Set(histBefore.rejectedHypotheses.map((h) => h.fingerprint))
        if (rejected.size) {
          const fresh = deterministicPlan(store.project, an.diagnosis, [])
          if (fresh.rolePatches.some((p) => rejected.has(patchFingerprint(p)))) rejectedReproposed++
        }
        const before = clone(store.project)
        const pr = await svc.afterRun({ projectId: store.project.id, evolve: true, strategy: 'deterministic' })
        if (pr.heldSpendRaises?.length) {
          heldPasses++
          gateRules.spend_held = (gateRules.spend_held ?? 0) + 1
          for (const h of pr.heldSpendRaises) held.add(`${h.roleSlug ?? 'project'}.${h.field}`)
        }
        if (pr.applied) {
          appliedSummaries.push(`r${i} ${pr.applied.summary}`)
          applies.push({ run: i, id: pr.applied.id, window: pr.applied.evalWindowRuns, slugs: pr.applied.plan.rolePatches.map((p) => p.slug), limit: pr.applied.plan.maxConcurrentSubagents !== undefined })
        }
        if (chartDiff(before, store.project).length) {
          lastChangeRun = i
          events.push({ run: i, cause: pr.applied ? 'apply' : pr.ratchet === 'rolled_back' ? 'rollback' : 'other', before, after: clone(store.project) })
        }
        pass = pr.applied ? `applied ${pr.applied.id}: ${pr.applied.summary}` : pr.ratchet !== 'none' ? `${pr.ratchet}: ${pr.ratchetReason ?? ''}` : (pr.ratchetReason ?? '')
      }
      clock += 1000
      rows.push({
        run: i,
        task: sim.task,
        costUsd: sim.costUsd,
        baseCostUsd: base[i - 1].costUsd,
        frozenCostUsd: frozen[i - 1].costUsd,
        failures: sim.stepFailures,
        baseFailures: base[i - 1].stepFailures,
        frozenFailures: frozen[i - 1].stepFailures,
        wallMs: sim.wallMs,
        baseWallMs: base[i - 1].wallMs,
        frozenWallMs: frozen[i - 1].wallMs,
        roles: [...new Set(Object.values(record.agents).map((a) => a.roleSlug))].sort(),
        waste: an.diagnosis.wasteScore,
        findings: an.diagnosis.findings.map((f) => `${f.kind}${f.roleSlug ? `@${f.roleSlug}` : ''}`),
        findingsFull: an.diagnosis.findings.map((f) => ({ kind: f.kind, roleSlug: f.roleSlug, data: f.data })),
        pass,
        fieldHealed: fieldHealed(inj.touched, store.project, ref.project)
      })
    }
    gens = svc.history(store.project.id).generations
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
  // A trial decided on runs in which no patched role ran (a limit change always counts as exercised).
  const blindTrials = applies
    .map((a) => {
      const g = gens.find((x) => x.id === a.id)
      const win = rows.filter((r) => r.run > a.run).slice(0, a.window)
      const exercised = a.limit || win.some((r) => a.slugs.some((s) => r.roles.includes(s)))
      return { id: a.id, status: g?.status ?? 'unknown', exercised }
    })
    .filter((t) => t.status !== 'trial' && !t.exercised)
  const lastWin = rows.slice(-LAST_WINDOW)
  const asFrozen = (r) => ({ ...r, costUsd: r.frozenCostUsd, wallMs: r.frozenWallMs, failures: r.frozenFailures })
  const windows = { unhealed: windowStats(rows.map(asFrozen)), last: windowStats(lastWin), lastUnhealed: windowStats(lastWin.map(asFrozen)) }
  let healRun = null
  for (let k = rows.length - 1; k >= 0 && rows[k].fieldHealed; k--) healRun = rows[k].run
  const field = rows.length ? rows[rows.length - 1].fieldHealed : false
  const symptom = symptomOf(windows, chartDiff(start, store.project).length > 0)
  const c = {
    id: spec.id,
    complexity: spec.complexity,
    defect: spec.defect.id,
    label: spec.defect.label,
    group: spec.defect.group,
    target: target === '*' ? null : target,
    expect: inj.expect,
    detectedAtRun: detectedAt(rows, inj.expect),
    relatedAtRun: inj.related ? detectedAt(rows, inj.related) : null,
    proposedForDefect,
    gateRules,
    spendHeld: { passes: heldPasses, fields: [...held].sort() },
    healed: { field: inj.touched.length ? field : false, wasteUnder: finalWaste < WASTE_THRESHOLD, symptom: symptom.healed, costlyBefore: symptom.costlyBefore },
    healRun: inj.touched.length && field ? healRun : null,
    finalWaste,
    generations: { applied: gens.length, promoted: gens.filter((g) => g.status === 'promoted').length, rolledBack: gens.filter((g) => g.status === 'rolled_back').length, trial: gens.filter((g) => g.status === 'trial').length },
    generationLog: gens.map((g) => ({ id: g.id, status: g.status, summary: g.summary, outcome: g.outcomeReason ?? '' })),
    appliedSummaries,
    runs: rows.length,
    passes,
    lastChangeRun,
    collateral: collateral(start, store.project, inj.touched).map(diffText),
    changedEver: [...new Set(events.flatMap((e) => chartDiff(e.before, e.after).map(diffText)))],
    oscillation: oscillations(events),
    rejectedReproposed,
    blindTrials,
    windows,
    excessUsd: excessUsd(rows),
    unhealedExcessUsd: excessUsd(rows.map(asFrozen)),
    excessUntilHealUsd: excessUsd(healRun ? rows.filter((r) => r.run < healRun) : rows),
    finalFindings: rows.length ? rows[rows.length - 1].findings : [],
    rows: rows.map(({ findingsFull: _f, ...r }) => r)
  }
  c.status = classify(c)
  return c
}

/** Run the bench. Deterministic for a given seed and case filter (apart from `generatedAt`). */
export async function runBench({ seed = 1, caseFilter } = {}) {
  const specs = selectCases(caseFilter)
  const bases = {}
  for (const cx of new Set(specs.map((s) => s.complexity))) bases[cx] = baselineOf(cx, seed)
  const cases = []
  for (const s of specs) cases.push(await runCase(s, seed, bases[s.complexity]))
  let sha = 'unknown'
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    // not a git checkout
  }
  const defects = DEFECTS.filter((d) => cases.some((c) => c.defect === d.id))
  const cx = COMPLEXITIES.filter((c) => cases.some((x) => x.complexity === c))
  return {
    bench: 'org-heal',
    version: 1,
    seed,
    sha,
    generatedAt: new Date().toISOString(),
    horizon: HORIZON,
    complexities: cx,
    baseline: Object.fromEntries(Object.entries(bases).map(([k, v]) => [k, { meanCostUsd: Math.round((v.reduce((n, r) => n + r.costUsd, 0) / v.length) * 1e4) / 1e4, failures: v.reduce((n, r) => n + r.stepFailures, 0) }])),
    matrix: matrixOf(cases, defects, cx),
    gaps: gapsOf(cases.filter((c) => c.group !== 'control'), defects),
    cases
  }
}

function parseArgs(argv) {
  const out = { seed: 1, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--seed') out.seed = Number(argv[++i])
    else if (a === '--case') out.caseFilter = argv[++i]
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--json') out.json = true
    else throw new Error(`Unknown argument ${a}`)
  }
  if (!Number.isInteger(out.seed)) throw new Error('--seed takes an integer')
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const results = await runBench({ seed: args.seed, caseFilter: args.caseFilter })
  const stamp = results.generatedAt.replace(/[:.]/g, '-')
  const dir = resolve(args.out ?? join(root, 'bench-results', 'org-heal', stamp))
  mkdirSync(dir, { recursive: true })
  const report = reportMarkdown(results)
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
  writeFileSync(join(dir, 'report.md'), `${report}\n`)
  if (args.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
  else {
    const n = results.cases.filter((c) => c.group !== 'control')
    const tally = {}
    for (const c of n) tally[c.status] = (tally[c.status] ?? 0) + 1
    process.stdout.write(`${results.cases.length} cases, seed ${results.seed}: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}; controls with a change: ${results.cases.filter((c) => c.group === 'control' && c.status !== 'clean').length}\n${dir}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
    process.exit(1)
  })
}

export { matchFinding }
