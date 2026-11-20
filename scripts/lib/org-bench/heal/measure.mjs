// Pure metrics and the report of the self-healing bench. No I/O.

export const ROLE_FIELDS = ['tier', 'model', 'effort', 'staffing', 'prompt', 'tools', 'skills']
/** The engine's own threshold (plan.ts MIN_WASTE_DEFAULT), used only to report "waste under threshold". */
export const WASTE_THRESHOLD = 15
export const LAST_WINDOW = 5

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
 * Whether the defect cost anything measurable before the first change (`costlyBefore`) and whether the last window is
 * back within the tolerances of the frozen reference (`healed`).
 */
export function symptomOf(windows) {
  return { costlyBefore: costly(windows.first), healed: !costly(windows.last) }
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
  const first = c.windows.first
  const worse = applied && (last.excessRel > first.excessRel + 0.03 || last.wallRel > first.wallRel + 0.05 || last.failures > first.failures + Math.max(1, Math.round(first.failures * 0.5)))
  if (c.group === 'control') return !applied ? 'clean' : costly(last) ? 'fp-worse' : 'fp'
  if (c.healed.field) return 'healed'
  if (worse) return 'worse'
  if (!c.healed.costlyBefore && c.healed.symptom) return 'negligible'
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
      row.cells[cx] = c ? { status: c.status, detectedAtRun: c.detectedAtRun, healRun: c.healRun, gens: c.generations.applied, excessUsd: c.excessUsd } : null
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

const cellText = (cell) => {
  if (!cell) return 'n/a'
  const bits = [CELL[cell.status] ?? cell.status]
  if (cell.detectedAtRun !== null && cell.detectedAtRun !== undefined) bits.push(`det r${cell.detectedAtRun}`)
  if (cell.healRun) bits.push(`heal r${cell.healRun}`)
  if (cell.gens) bits.push(`${cell.gens} gen`)
  bits.push(`+$${r2(cell.excessUsd)}`)
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
  L.push('Cell: status, run of first detection (det), run from which the defect\'s fields held the reference values to the end (heal), generations applied, simulated excess cost over the frozen reference across the horizon.')
  L.push('')
  L.push(`| Defect | ${cx.join(' | ')} |`)
  L.push(`| --- | ${cx.map(() => '---').join(' | ')} |`)
  for (const row of results.matrix) L.push(`| ${row.label} (${row.group}) | ${cx.map((c) => cellText(row.cells[c])).join(' | ')} |`)
  L.push('')
  const counts = {}
  for (const c of results.cases.filter((x) => x.group !== 'control')) counts[c.status] = (counts[c.status] ?? 0) + 1
  L.push(`Totals over ${results.cases.filter((x) => x.group !== 'control').length} defect cases: ${Object.entries(counts).sort().map(([k, v]) => `${CELL[k] ?? k} ${v}`).join(', ')}.`)
  L.push('')
  L.push('## Controls')
  L.push('')
  const ctl = results.cases.filter((c) => c.group === 'control')
  L.push(`False positives: ${ctl.filter((c) => c.status !== 'clean').length} of ${ctl.length} healthy charts had a change applied.`)
  L.push('')
  L.push('| Chart | Status | Generations (applied / promoted / rolled back) | Changes applied | Final waste | Excess cost |')
  L.push('| --- | --- | --- | --- | --- | --- |')
  for (const c of ctl) L.push(`| ${c.complexity} | ${CELL[c.status]} | ${c.generations.applied} / ${c.generations.promoted} / ${c.generations.rolledBack} | ${c.appliedSummaries.join('; ') || 'none'} | ${c.finalWaste} | +$${r2(c.excessUsd)} |`)
  L.push('')
  L.push('## Per case')
  L.push('')
  L.push('Cost / wall / failed steps: the first window (runs before the first change) and the last five runs, against the frozen reference on the same tasks.')
  L.push('')
  L.push('| Case | Status | Detected | Plan for the defect | Gate rules seen (passes) | Spend held | Healed field / waste < 15 / symptom | Gens (a/p/r) | Runs | First window cost, wall, fails | Last window cost, wall, fails | Changes applied | Collateral at end | Oscillation | Rejected re-proposed | Excess $ |')
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  const pct = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 1000) / 10}%`
  const win = (w) => `${pct(w.excessRel)}, ${pct(w.wallRel)}, ${w.failures} (ref ${w.baseFailures})`
  for (const c of results.cases) {
    const rules = Object.entries(c.gateRules).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'
    L.push(`| ${c.id} | ${CELL[c.status] ?? c.status} | ${c.detectedAtRun ? `run ${c.detectedAtRun}` : c.expect ? 'no' : 'no finding kind'} | ${c.proposedForDefect ? 'yes' : 'no'} | ${rules} | ${c.spendHeld.fields.join(', ') || 'none'} | ${c.healed.field ? 'yes' : 'no'} / ${c.healed.wasteUnder ? 'yes' : 'no'} (${c.finalWaste}) / ${c.healed.symptom ? 'yes' : 'no'} | ${c.generations.applied}/${c.generations.promoted}/${c.generations.rolledBack} | ${c.runs} | ${win(c.windows.first)} | ${win(c.windows.last)} | ${c.appliedSummaries.join('; ') || 'none'} | ${c.collateral.join('; ') || 'none'} | ${c.oscillation.count}${c.oscillation.fields.length ? ` (${c.oscillation.fields.join(', ')})` : ''} | ${c.rejectedReproposed} | ${r2(c.excessUsd)} |`)
  }
  L.push('')
  L.push('## Ranked gaps')
  L.push('')
  L.push('Ranked by the simulated excess cost of the unhealed cases (the price of not healing over the horizon).')
  L.push('')
  results.gaps.forEach((g, i) => {
    L.push(`${i + 1}. **${g.label}** (${cx.map((c) => `${c} ${CELL[g.statuses[c]] ?? 'n/a'}`).join(', ')}; +$${r2(g.unhealedExcessUsd)}). Could heal it today: ${g.mechanism || 'n/a'}. What stops the unattended path: ${g.blocker || 'see the per-case rows'}${g.gateRules.length ? ` Gate rules seen: ${g.gateRules.join(', ')}.` : ''}${g.held.length ? ` Held raises: ${g.held.join(', ')}.` : ''}`)
  })
  L.push('')
  return L.join('\n')
}
