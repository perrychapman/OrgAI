// Pure metrics and the report of the self-healing bench. No I/O.

export const ROLE_FIELDS = ['tier', 'model', 'effort', 'staffing', 'prompt', 'tools', 'skills']
/** The engine's own threshold (plan.ts MIN_WASTE_DEFAULT), used only to report "waste under threshold". */
export const WASTE_THRESHOLD = 15
export const LAST_WINDOW = 10

const json = (v) => JSON.stringify(v ?? null)
const r4 = (n) => Math.round(n * 1e4) / 1e4
const r2 = (n) => Math.round(n * 100) / 100

/** The chart's structure: every role's slug, parent slug and spawnable slugs, sorted. */
export function structureKey(project) {
  const slug = new Map(project.roles.map((r) => [r.id, r.slug]))
  return json(
    project.roles
      .map((r) => [r.slug, r.reportsTo === null ? null : (slug.get(r.reportsTo) ?? r.reportsTo), [...(r.spawnable ?? [])].map((id) => slug.get(id) ?? id).sort()])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  )
}

const roleOf = (project, slug) => project.roles.find((r) => r.slug === slug)
const valueOf = (project, slug, field) => {
  const r = roleOf(project, slug)
  return r ? (r[field] ?? null) : undefined
}

/** True when every field the defect touched holds the reference value again. */
export function fieldHealed(touched, project, reference) {
  if (!touched.length) return true
  return touched.every((t) => {
    if (t.structure) return structureKey(project) === structureKey(reference)
    if (t.project) return json(project[t.project]) === json(reference[t.project])
    return json(valueOf(project, t.slug, t.field)) === json(valueOf(reference, t.slug, t.field))
  })
}

/** Every field that differs between two charts: role fields by slug, the concurrency limit and the structure. */
export function chartDiff(a, b) {
  const out = []
  const slugs = [...new Set([...a.roles.map((r) => r.slug), ...b.roles.map((r) => r.slug)])].sort()
  for (const slug of slugs) {
    const ra = roleOf(a, slug)
    const rb = roleOf(b, slug)
    if (!ra || !rb) continue
    for (const f of ROLE_FIELDS) if (json(ra[f]) !== json(rb[f])) out.push({ slug, field: f, from: ra[f] ?? null, to: rb[f] ?? null })
  }
  if (json(a.maxConcurrentSubagents) !== json(b.maxConcurrentSubagents)) out.push({ project: 'maxConcurrentSubagents', from: a.maxConcurrentSubagents ?? null, to: b.maxConcurrentSubagents ?? null })
  if (structureKey(a) !== structureKey(b)) out.push({ structure: true })
  return out
}

const sameTarget = (d, t) => (t.structure ? !!d.structure : t.project ? d.project === t.project : d.slug === t.slug && d.field === t.field)

/** Changes from `start` to `end` that the defect did not touch. */
export function collateral(start, end, touched) {
  return chartDiff(start, end).filter((d) => !touched.some((t) => sameTarget(d, t)))
}

/** Short text of a diff entry (prompts by length). */
export function diffText(d) {
  if (d.structure) return 'structure'
  if (d.project) return `${d.project} ${d.from ?? 'default'} -> ${d.to ?? 'default'}`
  const v = (x) => (d.field === 'prompt' ? `${String(x ?? '').length} chars` : typeof x === 'object' && x !== null ? json(x) : String(x))
  return `${d.slug}.${d.field} ${v(d.from)} -> ${v(d.to)}`
}

/** Whether a finding matches what a defect should produce. */
export function matchFinding(f, expect) {
  if (!expect || f.kind !== expect.kind) return false
  if (expect.roleSlug && f.roleSlug !== expect.roleSlug) return false
  if (expect.match) {
    const seq = String(f.data?.sequence ?? '').split('>').filter(Boolean)
    if (!seq.length) return false
    const hay = expect.match.join('>')
    return hay.includes(seq.join('>'))
  }
  return true
}

/** First run (1-based) whose diagnosis held a matching finding, or null. */
export function detectedAt(rows, expect) {
  if (!expect) return null
  for (const r of rows) if ((r.findingsFull ?? []).some((f) => matchFinding(f, expect))) return r.run
  return null
}

/**
 * Oscillations in a chart history: a field that an APPLIED generation set back to a value it held before its previous
 * value (A -> B -> A by applies). A rollback restoring a value is the ratchet working and is counted apart.
 * `events`: [{ cause: 'apply' | 'rollback', before: Project, after: Project }] in order.
 */
export function oscillations(events) {
  const seen = new Map()
  let osc = 0
  const flips = []
  for (const e of events) {
    for (const d of chartDiff(e.before, e.after)) {
      const k = d.structure ? 'structure' : d.project ? d.project : `${d.slug}.${d.field}`
      const vals = seen.get(k) ?? [json(d.from)]
      const to = json(d.to)
      if (e.cause === 'apply' && vals.slice(0, -1).includes(to)) {
        osc++
        flips.push(k)
      }
      vals.push(to)
      seen.set(k, vals)
    }
  }
  return { count: osc, fields: [...new Set(flips)] }
}

/** Relative excess cost and failures of a window of runs against the frozen reference baseline. */
export function windowStats(rows) {
  const cost = rows.reduce((n, r) => n + r.costUsd, 0)
  const base = rows.reduce((n, r) => n + r.baseCostUsd, 0)
  const wall = rows.reduce((n, r) => n + (r.wallMs ?? 0), 0)
  const baseWall = rows.reduce((n, r) => n + (r.baseWallMs ?? 0), 0)
  return {
    runs: rows.length,
    costUsd: r4(cost),
    baseCostUsd: r4(base),
    excessRel: base > 0 ? r4((cost - base) / base) : 0,
    wallMs: wall,
    wallRel: baseWall > 0 ? r4((wall - baseWall) / baseWall) : 0,
    failures: rows.reduce((n, r) => n + r.failures, 0),
    baseFailures: rows.reduce((n, r) => n + r.baseFailures, 0)
  }
}

/** Tolerances of the symptom test: cost within 2%, wall time within 5%, no more failed steps than the reference. */
export const COST_TOL = 0.02
export const WALL_TOL = 0.05
const costly = (w) => w.excessRel > COST_TOL || w.wallRel > WALL_TOL || w.failures > w.baseFailures

/**
 * Whether the defect, left alone, costs anything measurable over the horizon (`costlyBefore`: the frozen defective
 * chart against the frozen reference on the same runs) and whether the last window is back within the tolerances of the
 * reference (`healed`). `windows`: { unhealed, last, lastUnhealed } from windowStats.
 */
export function symptomOf(windows, changed = true) {
  return { costlyBefore: costly(windows.unhealed), healed: changed && !costly(windows.last) }
}

/**
 * Whether the evolved chart is worse than leaving the defect alone, on the same last runs: cost 3 points or wall 5 points
 * above the frozen defective chart, or more than one extra failed step.
 */
export function worseThanUnhealed(windows) {
  const a = windows.last
  const b = windows.lastUnhealed
  const rel = (x, y) => (y > 0 ? (x - y) / y : 0)
  return rel(a.costUsd, b.costUsd) > 0.03 || rel(a.wallMs, b.wallMs) > 0.05 || a.failures > b.failures + 1
}

/** Sum of (case cost - baseline cost) over rows, in USD. */
export const excessUsd = (rows) => r4(rows.reduce((n, r) => n + (r.costUsd - r.baseCostUsd), 0))

/**
 * Classify one case.
 *   'healed'     the defect's fields hold the reference values at the end.
 *   'worse'      a generation was applied and the last window is worse than the window before the first change (cost
 *                3 points or wall 5 points higher, or clearly more failed steps).
 *   'symptom'    fields not restored, but the defect was costly before and the last window is within tolerance.
 *   'negligible' fields not restored and the defect never cost more than the tolerances in this simulator.
 *   'detected'   a matching finding, still costly at the end.   'missed' no matching finding, still costly.
 * Controls: 'clean' (nothing applied), 'fp' (something applied, last window within tolerance), 'fp-worse'.
 */
export function classify(c) {
  const applied = c.generations.applied > 0
  const last = c.windows.last
  const worse = applied && worseThanUnhealed(c.windows)
  if (c.group === 'control') return !applied ? 'clean' : costly(last) ? 'fp-worse' : 'fp'
  if (c.healed.field) return 'healed'
  if (worse) return 'worse'
  if (!c.healed.costlyBefore) return 'negligible'
  if (c.healed.symptom) return 'symptom'
  return c.detectedAtRun !== null ? 'detected' : 'missed'
}

export const CELL = { healed: 'healed', symptom: 'symptom healed', negligible: 'negligible here', detected: 'detected only', missed: 'missed', worse: 'made worse', clean: 'clean', fp: 'false positive', 'fp-worse': 'false positive, worse' }

/** The defect x complexity matrix. */
export function matrixOf(cases, defects, complexities) {
  const rows = []
  for (const d of defects) {
    const row = { defect: d.id, label: d.label, group: d.group, cells: {} }
    for (const cx of complexities) {
      const c = cases.find((x) => x.defect === d.id && x.complexity === cx)
      row.cells[cx] = c ? { status: c.status, detectedAtRun: c.detectedAtRun, healRun: c.healRun, gens: c.generations.applied, collateral: c.collateral.length, excessUsd: c.excessUsd } : null
    }
    rows.push(row)
  }
  return rows
}

/** Ranked gaps: every defect with at least one unhealed case, by the simulated excess cost of its unhealed cases. */
export function gapsOf(cases, defects) {
  const out = []
  for (const d of defects) {
    const mine = cases.filter((c) => c.defect === d.id)
    const open = mine.filter((c) => c.status !== 'healed')
    if (!open.length) continue
    out.push({
      defect: d.id,
      label: d.label,
      statuses: Object.fromEntries(mine.map((c) => [c.complexity, c.status])),
      unhealedExcessUsd: r4(open.reduce((n, c) => n + c.excessUsd, 0)),
      gateRules: [...new Set(open.flatMap((c) => Object.keys(c.gateRules)))].sort(),
      held: [...new Set(open.flatMap((c) => c.spendHeld.fields))].sort(),
      mechanism: d.heal.mechanism,
      blocker: d.heal.blocker
    })
  }
  return out.sort((a, b) => b.unhealedExcessUsd - a.unhealedExcessUsd || (a.defect < b.defect ? -1 : 1))
}

/** Ratchet-wide counts over all cases. */
export function ratchetSummary(cases) {
  const sum = (f) => cases.reduce((n, c) => n + f(c), 0)
  const wastes = cases.map((c) => c.finalWaste).sort((a, b) => a - b)
  const mid = wastes.length ? (wastes.length % 2 ? wastes[wastes.length >> 1] : (wastes[wastes.length / 2 - 1] + wastes[wastes.length / 2]) / 2) : 0
  const ctlKinds = new Set(cases.filter((c) => c.group === 'control').flatMap((c) => c.finalFindings.map((f) => f.split('@')[0])))
  return {
    applied: sum((c) => c.generations.applied),
    promoted: sum((c) => c.generations.promoted),
    rolledBack: sum((c) => c.generations.rolledBack),
    trial: sum((c) => c.generations.trial),
    blind: sum((c) => c.blindTrials.length),
    blindPromoted: sum((c) => c.blindTrials.filter((t) => t.status === 'promoted').length),
    blindRolledBack: sum((c) => c.blindTrials.filter((t) => t.status === 'rolled_back').length),
    reproposed: sum((c) => c.rejectedReproposed),
    casesReproposing: cases.filter((c) => c.rejectedReproposed > 0).length,
    heldPasses: sum((c) => c.spendHeld.passes),
    casesHeld: cases.filter((c) => c.spendHeld.passes > 0).length,
    wasteUnder: cases.filter((c) => c.healed.wasteUnder).length,
    medianWaste: mid,
    controlFindings: [...ctlKinds].sort().join(', ')
  }
}

/** Signed dollars, two decimals: +$1.20, -$0.03. */
export const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(r2(x)).toFixed(2)}`

const cellText = (cell) => {
  if (!cell) return 'n/a'
  const bits = [CELL[cell.status] ?? cell.status]
  if (cell.detectedAtRun !== null && cell.detectedAtRun !== undefined) bits.push(`det r${cell.detectedAtRun}`)
  if (cell.healRun) bits.push(`heal r${cell.healRun}`)
  if (cell.gens) bits.push(`${cell.gens} gen`)
  if (cell.collateral) bits.push(`${cell.collateral} collateral`)
  bits.push(money(cell.excessUsd))
  return bits.join(', ')
}

/** The Markdown report. */
export function reportMarkdown(results) {
  const L = []
  const cx = results.complexities
  L.push(`# Org chart self-healing bench`)
  L.push('')
  L.push(`Seed ${results.seed}, commit ${results.sha}, horizon ${results.horizon} runs per case, ${results.cases.length} cases. Strategy deterministic, unattended post-run pass (createEvolveService afterRun, evolve on), token-free.`)
  L.push('')
  L.push('Cell: status, run of first detection (det), run from which the defect\'s fields held the reference values to the end (heal), generations applied, fields changed at the end that the defect did not touch (collateral), simulated excess cost over the frozen reference across the horizon.')
  L.push('')
  L.push(`Status: healed = the defect's fields hold the reference values at the end; symptom healed = fields not restored, the chart was changed, and the last ${LAST_WINDOW} runs are within 2% cost, 5% wall time and no more failed steps than the reference; negligible here = the defect, left alone, never left those tolerances over the horizon in this simulator; detected only = a matching finding, still costly; missed = no matching finding; made worse = the evolved chart is worse than leaving the defect alone on the same last ${LAST_WINDOW} runs.`)
  L.push('')
  L.push(`| Defect | ${cx.join(' | ')} |`)
  L.push(`| --- | ${cx.map(() => '---').join(' | ')} |`)
  for (const row of results.matrix) L.push(`| ${row.label} (${row.group}) | ${cx.map((c) => cellText(row.cells[c])).join(' | ')} |`)
  L.push('')
  const counts = {}
  for (const c of results.cases.filter((x) => x.group !== 'control')) counts[c.status] = (counts[c.status] ?? 0) + 1
  L.push(`Totals over ${results.cases.filter((x) => x.group !== 'control').length} defect cases: ${Object.entries(counts).sort().map(([k, v]) => `${CELL[k] ?? k} ${v}`).join(', ')}.`)
  L.push('')
  const r = ratchetSummary(results.cases)
  L.push('## The ratchet across all cases')
  L.push('')
  L.push(`- Generations applied ${r.applied}: promoted ${r.promoted}, rolled back ${r.rolledBack}, still on trial at the end ${r.trial}.`)
  L.push(`- Trials decided on runs in which no patched role ran (the change was never exercised): ${r.blind} (promoted ${r.blindPromoted}, rolled back ${r.blindRolledBack}).`)
  L.push(`- Passes on which a rolled-back patch was rebuilt and silently dropped (rejected hypothesis re-proposed): ${r.reproposed} over ${r.casesReproposing} cases.`)
  L.push(`- Passes that held a spend raise: ${r.heldPasses} over ${r.casesHeld} cases.`)
  L.push(`- Cases where the final waste score is under the engine threshold (${WASTE_THRESHOLD}): ${r.wasteUnder} of ${results.cases.length}; median final waste ${r.medianWaste}. Final findings on the healthy controls: ${r.controlFindings || 'none'}.`)
  L.push('')
  L.push('## Controls')
  L.push('')
  const ctl = results.cases.filter((c) => c.group === 'control')
  L.push(`False positives: ${ctl.filter((c) => c.status !== 'clean').length} of ${ctl.length} healthy charts had a change applied.`)
  L.push('')
  L.push('| Chart | Status | Generations (applied / promoted / rolled back) | Changes applied | Final waste | Excess cost |')
  L.push('| --- | --- | --- | --- | --- | --- |')
  for (const c of ctl) L.push(`| ${c.complexity} | ${CELL[c.status]} | ${c.generations.applied} / ${c.generations.promoted} / ${c.generations.rolledBack} | ${c.generationLog.map((g) => `${g.id} ${g.summary} (${g.status}: ${g.outcome})`).join('; ') || 'none'} | ${c.finalWaste} | ${money(c.excessUsd)} |`)
  L.push('')
  L.push('## Per case')
  L.push('')
  L.push(`Cost, wall and failed steps against the frozen reference on the same runs: "left alone" is the defective chart with evolution off over the whole horizon; "last ${LAST_WINDOW}" is the evolved chart over the last ${LAST_WINDOW} runs. Excess $: evolved run costs minus the reference over the horizon; left alone $: the same for the frozen defective chart. Blind trials: generations decided on runs where no patched role ran.`)
  L.push('')
  L.push(`| Case | Status | Detected | Plan for the defect | Gate rules seen (passes) | Spend held | Healed field / waste < 15 / symptom | Gens (a/p/r) | Last change | Left alone: cost, wall, fails | Last ${LAST_WINDOW}: cost, wall, fails | Changes applied | Collateral at end | Oscillation | Rejected re-proposed (passes) | Blind trials | Excess $ / left alone $ |`)
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  const pct = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 1000) / 10}%`
  const win = (w) => `${pct(w.excessRel)}, ${pct(w.wallRel)}, ${w.failures} (ref ${w.baseFailures})`
  for (const c of results.cases) {
    const rules = Object.entries(c.gateRules).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
    L.push(`| ${c.id} | ${CELL[c.status] ?? c.status} | ${c.detectedAtRun ? `run ${c.detectedAtRun}` : c.expect ? 'no' : 'no finding kind'} | ${c.proposedForDefect ? 'yes' : 'no'} | ${rules} | ${c.spendHeld.fields.join(', ') || 'none'} | ${c.healed.field ? 'yes' : 'no'} / ${c.healed.wasteUnder ? 'yes' : 'no'} (${c.finalWaste}) / ${c.healed.symptom ? 'yes' : 'no'} | ${c.generations.applied}/${c.generations.promoted}/${c.generations.rolledBack} | ${c.lastChangeRun ? `run ${c.lastChangeRun}` : 'none'} | ${win(c.windows.unhealed)} | ${win(c.windows.last)} | ${c.appliedSummaries.join('; ') || 'none'} | ${c.collateral.join('; ') || 'none'} | ${c.oscillation.count}${c.oscillation.fields.length ? ` (${c.oscillation.fields.join(', ')})` : ''} | ${c.rejectedReproposed} | ${c.blindTrials.map((t) => `${t.id} ${t.status}`).join(', ') || 'none'} | ${r2(c.excessUsd)} / ${r2(c.unhealedExcessUsd)} |`)
  }
  L.push('')
  L.push('## Ranked gaps')
  L.push('')
  L.push('Ranked by the simulated excess cost of the unhealed cases (the price of not healing over the horizon).')
  L.push('')
  results.gaps.forEach((g, i) => {
    L.push(`${i + 1}. **${g.label}** (${cx.map((c) => `${c} ${CELL[g.statuses[c]] ?? 'n/a'}`).join(', ')}; ${money(g.unhealedExcessUsd)}). Could heal it today: ${g.mechanism || 'n/a'}. What stops the unattended path: ${g.blocker || 'see the per-case rows'}${g.gateRules.length ? ` Gate rules seen: ${g.gateRules.join(', ')}.` : ''}${g.held.length ? ` Held raises: ${g.held.join(', ')}.` : ''}`)
  })
  L.push('')
  return L.join('\n')
}
