/**
 * /evolve text (Team evolution): parsing and plain-text summaries of a diagnosis, a plan, the history and the apply /
 * rollback outcomes. Everything the host sends derives from run transcripts, so every string goes through cleanLine
 * (sanitizeTty) and every list is bounded ("+N more").
 */
import type {
  EvolutionGeneration,
  EvolutionHistory,
  EvolutionMetrics,
  EvolutionPlan,
  EvolutionSpendRaise,
  EvolveAnalyzeResult,
  EvolveApplyResult,
  EvolveRollbackResult,
  EvolveStrategy,
  Project,
  TeamEvolutionDiagnosis
} from '../../shared/types'
import { effectiveConcurrency, patchChanges } from '../../main/evolve/plan'
import { cleanLine } from './slashCommands'

export type EvolveRequest =
  | { kind: 'analyze' }
  | { kind: 'apply'; strategy: EvolveStrategy }
  | { kind: 'history' }
  | { kind: 'rollback'; generationId?: string }
  | { kind: 'error'; message: string }

export const EVOLVE_USAGE = 'Use /evolve [analyze], /evolve apply [deterministic|hybrid], /evolve history or /evolve rollback [genId].'

const GEN_ID = /^[A-Za-z0-9_-]{1,40}$/

export function parseEvolve(args: string): EvolveRequest {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const sub = (words[0] ?? 'analyze').toLowerCase()
  const rest = words.slice(1)
  if (sub === 'analyze' || sub === 'history') {
    return rest.length ? { kind: 'error', message: `/evolve ${sub} takes no arguments. ${EVOLVE_USAGE}` } : { kind: sub }
  }
  if (sub === 'apply') {
    if (rest.length > 1) return { kind: 'error', message: EVOLVE_USAGE }
    const strategy = (rest[0] ?? 'deterministic').toLowerCase()
    if (strategy !== 'deterministic' && strategy !== 'hybrid') return { kind: 'error', message: `Strategy is deterministic or hybrid, not "${cleanLine(rest[0], 30)}".` }
    return { kind: 'apply', strategy }
  }
  if (sub === 'rollback') {
    if (rest.length > 1) return { kind: 'error', message: EVOLVE_USAGE }
    if (rest[0] !== undefined && !GEN_ID.test(rest[0])) return { kind: 'error', message: 'A generation id looks like gen_2.' }
    return { kind: 'rollback', ...(rest[0] !== undefined ? { generationId: rest[0] } : {}) }
  }
  return { kind: 'error', message: `Unknown /evolve subcommand "${cleanLine(words[0], 30)}". ${EVOLVE_USAGE}` }
}

const MAX_FINDINGS = 6
const MAX_GENERATIONS = 5

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)
const pct = (n: unknown): string => `${Math.round(num(n) * 100)}%`
const usd = (n: unknown): string => {
  const v = num(n)
  return v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
}
const secs = (ms: unknown): string => {
  const v = num(ms) / 1000
  return v >= 90 ? `${Math.round(v / 60)}m` : `${Math.round(v)}s`
}
const toks = (n: unknown): string => {
  const v = num(n)
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : String(Math.round(v))
}
const list = <T>(v: T[] | undefined): T[] => (Array.isArray(v) ? v : [])
const more = (lines: string[], total: number, shown: number): void => {
  if (total > shown) lines.push(`  +${total - shown} more`)
}

export function metricsLine(m: EvolutionMetrics | undefined): string {
  if (!m) return 'no data'
  return `${num(m.runs)} runs, first-pass ${pct(m.firstPassRate)}, median ${usd(m.medianCostUsd)}, ${secs(m.medianWallMs)}, ${toks(m.medianInputTokens)} input tokens`
}

function savingsParts(f: { estSavingsUsd?: number; estSavingsTokens?: number; estSavingsMs?: number }): string {
  const parts: string[] = []
  if (f.estSavingsUsd) parts.push(usd(f.estSavingsUsd))
  if (f.estSavingsTokens) parts.push(`${toks(f.estSavingsTokens)} tokens`)
  if (f.estSavingsMs) parts.push(secs(f.estSavingsMs))
  return parts.join(', ')
}

export function diagnosisLines(d: TeamEvolutionDiagnosis): string[] {
  const lines = [`Waste score ${Math.round(num(d.wasteScore))}/100 over ${list(d.runIds).length} runs.`, `Medians: ${metricsLine(d.metrics)}.`]
  const findings = list(d.findings)
  if (findings.length === 0) lines.push('No findings.')
  else {
    lines.push('Findings:')
    for (const f of findings.slice(0, MAX_FINDINGS)) {
      const role = f.roleSlug ? ` [${cleanLine(f.roleSlug, 40)}]` : ''
      const sv = savingsParts(f)
      lines.push(`  ${cleanLine(f.kind, 40)}${role}: ${cleanLine(f.summary, 160)}${sv ? ` (saves ~${sv} per run)` : ''}`)
    }
    more(lines, findings.length, MAX_FINDINGS)
  }
  return lines
}

/** The plan as text. With `before` (the project as it was), each change reads `field before → after`. */
export function planLines(p: EvolutionPlan, before?: Project): string[] {
  const lines: string[] = []
  const changes: string[] = []
  for (const r of list(p.rolePatches)) {
    const bits = patchChanges(before?.roles?.find((x) => x.slug === r.slug), r).map((b) => cleanLine(b, 160))
    changes.push(`  ${cleanLine(r.slug, 40)}: ${bits.join(', ') || 'no change'}${r.reason ? ` - ${cleanLine(r.reason, 100)}` : ''}`)
  }
  for (const s of list(p.newSkills)) changes.push(`  new skill ${cleanLine(s.name, 40)} for ${list(s.grantTo).map((g) => cleanLine(g, 40)).join(', ') || 'no one'}`)
  const pruned = list(p.pruneSkillIds).length
  if (pruned) changes.push(`  prune ${pruned} skill${pruned === 1 ? '' : 's'}`)
  if (p.maxConcurrentSubagents !== undefined) changes.push(`  max concurrent subagents ${before?.roles ? `${num(effectiveConcurrency(before))} → ` : ''}${num(p.maxConcurrentSubagents)}`)
  if (p.empty || changes.length === 0) lines.push('Proposed change: none.')
  else {
    lines.push(`Proposed change (${cleanLine(p.strategy, 20)}):`)
    // Every change is listed: a person may approve this plan from this text (review fix-50 L-3).
    lines.push(...changes)
  }
  const imp = p.expectedImpact ?? {}
  const est = savingsParts({ estSavingsUsd: imp.costUsd, estSavingsTokens: imp.tokens, estSavingsMs: imp.wallMs })
  if (est) lines.push(`Estimated savings per run: ${est}.`)
  const violations = list(p.gate?.violations)
  if (p.gate && !p.gate.ok) lines.push(`Safety gate: refused (${violations.length} violation${violations.length === 1 ? '' : 's'}).`)
  else lines.push(violations.length ? `Safety gate: passed, ${violations.length} trimmed.` : 'Safety gate: passed.')
  for (const v of violations) lines.push(`  ${cleanLine(v.action, 12)} ${cleanLine(v.rule, 40)}${v.roleSlug ? ` [${cleanLine(v.roleSlug, 40)}]` : ''}: ${full(v.message)}`)
  if (p.usage) lines.push(`Synthesis used ${toks(p.usage.inputTokens)} input and ${toks(p.usage.outputTokens)} output tokens${p.usage.costUsd !== undefined ? ` (${usd(p.usage.costUsd)})` : ''}.`)
  lines.push(...raiseLines(p.spendRaises))
  return lines
}

/** Sanitized, whitespace folded, never cut: text a person decides on is shown whole. */
const full = (s: string | undefined): string => cleanLine(s, Number.POSITIVE_INFINITY)

/** Every part that may make runs spend more, in full (no bound, no "+N more"). */
export function raiseLines(raises: readonly EvolutionSpendRaise[] | undefined): string[] {
  const l = list(raises as EvolutionSpendRaise[] | undefined)
  return l.length ? ['May spend more:', ...l.map((r) => `  - ${full(r.summary)}`)] : []
}

function heldLines(held: readonly EvolutionSpendRaise[] | undefined): string[] {
  const l = list(held as EvolutionSpendRaise[] | undefined)
  if (!l.length) return []
  return [`Held, not applied (${l.length} change${l.length === 1 ? '' : 's'} may spend more):`, ...l.map((r) => `  - ${full(r.summary)}`), 'Run /evolve apply again and press Enter on the question to approve them.']
}

/** The short notify line for held raises (the opened text lists them whole). */
export function heldNotice(held: readonly EvolutionSpendRaise[] | undefined): string {
  const n = list(held as EvolutionSpendRaise[] | undefined).length
  return n ? ` ${n} change${n === 1 ? '' : 's'} that may spend more ${n === 1 ? 'was' : 'were'} held.` : ''
}

export function analyzeText(r: EvolveAnalyzeResult, before?: Project): string {
  return [r.plan?.strategy === 'hybrid' ? 'Team evolution analysis (one tracked model call)' : 'Team evolution analysis (no tokens spent)',...diagnosisLines(r.diagnosis), ...planLines(r.plan, before), 'Apply with /evolve apply.'].join('\n')
}

const genChange = (g: EvolutionGeneration): string => {
  const b = g.baselineMetrics
  const t = g.trialMetrics
  if (!t) return `baseline ${metricsLine(b)}`
  return `first-pass ${pct(b?.firstPassRate)}->${pct(t.firstPassRate)}, cost ${usd(b?.medianCostUsd)}->${usd(t.medianCostUsd)}, time ${secs(b?.medianWallMs)}->${secs(t.medianWallMs)}, tokens ${toks(b?.medianInputTokens)}->${toks(t.medianInputTokens)}`
}

function generationLine(g: EvolutionGeneration): string {
  return `${cleanLine(g.id, 20)} ${cleanLine(g.status, 20)}: ${cleanLine(g.summary, 90)}; ${genChange(g)}`
}

/** `before`: the project as it was before the apply, so each change reads `field before → after`. */
export function applyText(r: EvolveApplyResult, strategy: EvolveStrategy, before?: Project): string {
  const lines: string[] = []
  if (!r.applied || !r.generation) {
    lines.push(`Nothing applied: ${full(r.reason) || 'no reason given'}.`)
    lines.push(...planLines(r.plan, before))
    lines.push(...heldLines(r.heldSpendRaises))
    return lines.join('\n')
  }
  const g = r.generation
  lines.push(`Applied ${cleanLine(g.id, 20)} (${cleanLine(g.status, 20)}, ${strategy}): ${cleanLine(g.summary, 160)}`)
  lines.push(...planLines(r.plan, before))
  lines.push(...heldLines(r.heldSpendRaises))
  lines.push(`Trial: measured over the next ${num(g.evalWindowRuns)} work runs, then a later evolve pass (exec --evolve, org evolve --apply, loop) promotes it or, on a regression, rolls it back.`)
  lines.push(`Undo it now with /evolve rollback ${cleanLine(g.id, 20)}.`)
  lines.push(r.teamFilesSynced ? 'Team files in .orgai/ were synced.' : 'Team files in .orgai/ were not changed.')
  return lines.join('\n')
}

export function rollbackText(r: EvolveRollbackResult): string {
  if (!r.rolledBack) return `Nothing rolled back: ${cleanLine(r.reason, 200) || 'no reason given'}.`
  const id = r.generation ? ` ${cleanLine(r.generation.id, 20)}` : ''
  const kept = r.reason ? ` Not everything was restored: ${cleanLine(r.reason, 200)}.` : ''
  return `Rolled back${id}.${kept} ${r.teamFilesSynced ? 'Team files in .orgai/ were synced.' : 'Team files in .orgai/ were not changed.'}`
}

export function historyText(h: EvolutionHistory): string {
  const gens = list(h.generations)
  if (gens.length === 0) return 'No evolution history yet. /evolve analyze shows what could change.'
  const lines = ['Team evolution history', `Champion: ${h.championId ? cleanLine(h.championId, 20) : 'none'}.`]
  const trial = h.trialId ? gens.find((g) => g.id === h.trialId) : undefined
  if (trial) lines.push(`Trial: ${cleanLine(trial.id, 20)}, window ${num(trial.evalWindowRuns)} runs (applied at run ${num(trial.appliedAtRunCount)}).`)
  else lines.push('No trial running.')
  const shown = gens.slice(-MAX_GENERATIONS).reverse()
  for (const g of shown) lines.push(`  ${generationLine(g)}`)
  more(lines, gens.length, shown.length)
  const rej = list(h.rejectedHypotheses)
  lines.push(`Rejected hypotheses: ${rej.length}.`)
  for (const r of rej.slice(-3).reverse()) lines.push(`  ${cleanLine(r.summary, 100)} - ${cleanLine(r.reason, 80)}`)
  return lines.join('\n')
}
