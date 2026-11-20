// node --test scripts/lib/org-bench/heal/heal.test.mjs
// The self-healing bench runs deterministically and its metric functions are right. It does not assert that the engine
// heals anything: the bench reports that.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COMPLEXITIES, referenceCharts } from './charts.mjs'
import { CONTROL, DEFECTS } from './defects.mjs'
import { chartDiff, classify, collateral, excessUsd, fieldHealed, matchFinding, money, oscillations, structureKey, symptomOf, windowStats, worseThanUnhealed } from './measure.mjs'
import { hash32, hopsOf, mulberry32, rngFor, simulateRun } from './simulate.mjs'

const clone = (v) => structuredClone(v)
const roleOf = (p, slug) => p.roles.find((r) => r.slug === slug)

test('PRNG: same key, same stream; values in [0, 1)', () => {
  const a = rngFor('k')
  const b = rngFor('k')
  for (let i = 0; i < 100; i++) {
    const x = a()
    assert.equal(x, b())
    assert.ok(x >= 0 && x < 1)
  }
  assert.notEqual(rngFor('k')(), rngFor('j')())
  assert.equal(hash32(''), 0x811c9dc5)
  assert.equal(mulberry32(1)(), mulberry32(1)())
})

test('reference charts: one root, every reportsTo and spawnable resolves, tiers equal the truth', () => {
  for (const cx of COMPLEXITIES) {
    const { project, truth } = referenceCharts()[cx]
    const ids = new Set(project.roles.map((r) => r.id))
    assert.equal(project.roles.filter((r) => r.reportsTo === null).length, 1, cx)
    for (const r of project.roles) {
      if (r.reportsTo !== null) assert.ok(ids.has(r.reportsTo), `${cx} ${r.slug}`)
      for (const s of r.spawnable) assert.ok(ids.has(s))
      assert.equal(r.tier, truth[r.slug].needTier, `${cx} ${r.slug} tier`)
      assert.equal(r.effort, truth[r.slug].needEffort, `${cx} ${r.slug} effort`)
    }
  }
  assert.deepEqual(COMPLEXITIES.map((c) => referenceCharts()[c].project.roles.length), [4, 7, 12])
})

test('every defect changes its chart, and the control changes nothing', () => {
  for (const cx of COMPLEXITIES) {
    for (const d of DEFECTS) {
      const t = d.target(cx)
      if (t === null) continue
      const ref = referenceCharts()[cx]
      const chart = referenceCharts()[cx]
      const inj = d.inject(chart, t)
      assert.ok(inj.touched.length, `${cx}:${d.id} touches something`)
      assert.ok(chartDiff(ref.project, chart.project).length, `${cx}:${d.id} differs from the reference`)
      assert.equal(fieldHealed(inj.touched, chart.project, ref.project), false, `${cx}:${d.id} starts unhealed`)
    }
    const chart = referenceCharts()[cx]
    CONTROL.inject(chart, '*')
    assert.deepEqual(chartDiff(referenceCharts()[cx].project, chart.project), [])
  }
})

test('simulateRun is deterministic and keyed by seed and run index', () => {
  const chart = referenceCharts().medium
  const a = simulateRun({ chart, project: chart.project, runIndex: 4, seed: 1 })
  const b = simulateRun({ chart, project: clone(chart.project), runIndex: 4, seed: 1 })
  assert.deepEqual(a, b)
  const c = simulateRun({ chart, project: chart.project, runIndex: 4, seed: 2 })
  assert.notDeepEqual(a.record, c.record)
  assert.equal(a.record.summary.kind, 'work')
  assert.equal(a.record.summary.projectId, chart.project.id)
  assert.ok(a.record.agents.root)
  assert.ok(Object.values(a.record.agents).every((x) => x.id === 'root' || x.parentId !== null))
})

test('simulator rules: a missing tool errors with "No such tool available"; deep costs more than fast', () => {
  const chart = referenceCharts().small
  const p = clone(chart.project)
  roleOf(p, 'researcher').tools = ['Read', 'Glob']
  // the 'question' task uses only the researcher; find a run index that draws it
  let i = 1
  while (simulateRun({ chart, project: chart.project, runIndex: i, seed: 1 }).sim.task !== 'question') i++
  const res = simulateRun({ chart, project: p, runIndex: i, seed: 1 })
  const errs = res.record.transcript.filter((e) => e.block.kind === 'tool_result' && e.block.isError)
  assert.ok(errs.length >= 2)
  assert.ok(errs.every((e) => /No such tool available: Grep/.test(e.block.content)))
  const deep = clone(chart.project)
  Object.assign(roleOf(deep, 'researcher'), { tier: 'deep', model: 'deep' })
  assert.ok(simulateRun({ chart, project: deep, runIndex: i, seed: 1 }).sim.costUsd > simulateRun({ chart, project: chart.project, runIndex: i, seed: 1 }).sim.costUsd)
})

test('simulator rules: concurrency 1 never runs two step agents at once', () => {
  const chart = referenceCharts().medium
  const p = clone(chart.project)
  p.maxConcurrentSubagents = 1
  for (let i = 1; i <= 8; i++) {
    const { record } = simulateRun({ chart, project: p, runIndex: i, seed: 1 })
    const work = Object.values(record.agents).filter((a) => a.id !== 'root').sort((a, b) => a.startedAt - b.startedAt)
    // redo agents follow a conflict and are not scheduled steps; none occur in the reference chart
    for (let k = 1; k < work.length; k++) assert.ok(work[k].startedAt >= work[k - 1].endedAt, `run ${i}`)
  }
})

test('hopsOf walks the current chart', () => {
  const { project } = referenceCharts().large
  assert.deepEqual(hopsOf(project, roleOf(project, 'builder-a')).map((r) => r.slug), ['build-lead'])
  assert.deepEqual(hopsOf(project, roleOf(project, 'build-lead')), [])
})

test('structureKey, fieldHealed, chartDiff and collateral', () => {
  const ref = referenceCharts().small.project
  const p = clone(ref)
  assert.equal(structureKey(p), structureKey(ref))
  Object.assign(roleOf(p, 'researcher'), { tier: 'deep', model: 'deep' })
  roleOf(p, 'builder').effort = 'high'
  const touched = [{ slug: 'researcher', field: 'tier' }, { slug: 'researcher', field: 'model' }]
  assert.equal(fieldHealed(touched, p, ref), false)
  assert.deepEqual(chartDiff(ref, p).map((d) => `${d.slug}.${d.field}`), ['builder.effort', 'researcher.tier', 'researcher.model'])
  assert.deepEqual(collateral(ref, p, touched), [{ slug: 'builder', field: 'effort', from: 'medium', to: 'high' }])
  Object.assign(roleOf(p, 'researcher'), { tier: 'fast', model: 'fast' })
  assert.equal(fieldHealed(touched, p, ref), true)
  p.maxConcurrentSubagents = 1
  assert.equal(fieldHealed([{ project: 'maxConcurrentSubagents' }], p, ref), false)
  p.roles[0].spawnable = p.roles[0].spawnable.slice(1)
  assert.notEqual(structureKey(p), structureKey(ref))
  assert.equal(fieldHealed([{ structure: true }], p, ref), false)
})

test('oscillations count an apply that returns a field to an earlier value; a rollback does not count', () => {
  const a = referenceCharts().small.project
  const b = clone(a)
  roleOf(b, 'builder').tier = 'everyday'
  const c = clone(b)
  roleOf(c, 'builder').tier = 'deep'
  assert.equal(oscillations([{ cause: 'apply', before: a, after: b }, { cause: 'rollback', before: b, after: c }]).count, 0)
  const o = oscillations([{ cause: 'apply', before: a, after: b }, { cause: 'apply', before: b, after: c }])
  assert.equal(o.count, 1)
  assert.deepEqual(o.fields, ['builder.tier'])
})

test('windowStats, excessUsd, symptomOf and worseThanUnhealed', () => {
  const rows = [
    { costUsd: 2, baseCostUsd: 1, wallMs: 10, baseWallMs: 10, failures: 1, baseFailures: 0 },
    { costUsd: 1, baseCostUsd: 1, wallMs: 30, baseWallMs: 10, failures: 0, baseFailures: 0 }
  ]
  const w = windowStats(rows)
  assert.equal(w.excessRel, 0.5)
  assert.equal(w.wallRel, 1)
  assert.equal(w.failures, 1)
  assert.equal(excessUsd(rows), 1)
  const clean = windowStats([{ costUsd: 1, baseCostUsd: 1, wallMs: 10, baseWallMs: 10, failures: 0, baseFailures: 0 }])
  assert.deepEqual(symptomOf({ unhealed: w, last: clean }), { costlyBefore: true, healed: true })
  assert.deepEqual(symptomOf({ unhealed: w, last: clean }, false), { costlyBefore: true, healed: false })
  assert.equal(worseThanUnhealed({ last: w, lastUnhealed: clean }), true)
  assert.equal(worseThanUnhealed({ last: clean, lastUnhealed: w }), false)
  assert.equal(money(-0.031), '-$0.03')
  assert.equal(money(1.2), '+$1.20')
})

test('classify', () => {
  const clean = { excessRel: 0, wallRel: 0, wallMs: 10, costUsd: 1, failures: 0, baseFailures: 0 }
  const bad = { excessRel: 0.2, wallRel: 0.2, wallMs: 12, costUsd: 1.2, failures: 0, baseFailures: 0 }
  const base = { group: 'engine', generations: { applied: 0 }, detectedAtRun: null, healed: { field: false, symptom: false, costlyBefore: true }, windows: { last: bad, lastUnhealed: bad } }
  assert.equal(classify(base), 'missed')
  assert.equal(classify({ ...base, detectedAtRun: 3 }), 'detected')
  assert.equal(classify({ ...base, healed: { field: true, symptom: true, costlyBefore: true } }), 'healed')
  assert.equal(classify({ ...base, healed: { field: false, symptom: false, costlyBefore: false } }), 'negligible')
  assert.equal(classify({ ...base, generations: { applied: 1 }, healed: { field: false, symptom: true, costlyBefore: true }, windows: { last: clean, lastUnhealed: bad } }), 'symptom')
  assert.equal(classify({ ...base, generations: { applied: 1 }, windows: { last: bad, lastUnhealed: clean } }), 'worse')
  assert.equal(classify({ ...base, group: 'control', windows: { last: clean, lastUnhealed: clean } }), 'clean')
  assert.equal(classify({ ...base, group: 'control', generations: { applied: 1 }, windows: { last: clean, lastUnhealed: clean } }), 'fp')
  assert.equal(classify({ ...base, group: 'control', generations: { applied: 1 }, windows: { last: bad, lastUnhealed: clean } }), 'fp-worse')
})

test('matchFinding: kind, role and routine window', () => {
  assert.equal(matchFinding({ kind: 'tool_friction', roleSlug: 'researcher' }, { kind: 'tool_friction', roleSlug: 'researcher' }), true)
  assert.equal(matchFinding({ kind: 'tool_friction', roleSlug: 'writer' }, { kind: 'tool_friction', roleSlug: 'researcher' }), false)
  assert.equal(matchFinding({ kind: 'serial_bottleneck' }, { kind: 'serial_bottleneck' }), true)
  const routine = ['Glob', 'Read', 'Bash', 'Read', 'Edit', 'Bash']
  assert.equal(matchFinding({ kind: 'skill_crystallization', data: { sequence: 'Read>Bash>Read>Edit' } }, { kind: 'skill_crystallization', match: routine }), true)
  assert.equal(matchFinding({ kind: 'skill_crystallization', data: { sequence: 'Read>Grep>Read>Edit' } }, { kind: 'skill_crystallization', match: routine }), false)
  assert.equal(matchFinding({ kind: 'x' }, null), false)
})

test('the bench runs the real engine deterministically (two cases, twice)', async () => {
  const { runBench } = await import('../../../bench-org-heal.mjs')
  const strip = (r) => ({ ...r, generatedAt: undefined })
  const a = await runBench({ seed: 5, caseFilter: 'small:prompt-bloat' })
  const b = await runBench({ seed: 5, caseFilter: 'small:prompt-bloat' })
  assert.deepEqual(strip(a), strip(b))
  assert.equal(a.cases.length, 1)
  const c = a.cases[0]
  assert.equal(c.runs, 60)
  assert.ok(['healed', 'symptom', 'negligible', 'detected', 'missed', 'worse'].includes(c.status))
  assert.equal(typeof c.excessUsd, 'number')
  const ctl = await runBench({ seed: 5, caseFilter: 'small:control' })
  assert.equal(ctl.cases[0].group, 'control')
  assert.ok(['clean', 'fp', 'fp-worse'].includes(ctl.cases[0].status))
})
