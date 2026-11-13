/**
 * `orgai org evolve` (Pareto-ratchet team evolution, src/main/evolve/): the waste digest, the proposed patches and the
 * generation ledger. Everything here works unattended (no TTY, pipes, CI, `--output-format json`).
 *
 * - `org evolve [--runs N] [--goal balanced|cost|speed] [--strategy deterministic|hybrid] [--min-waste <0-100>]`:
 *   org:evolveAnalyze (read). A dry run: nothing is changed. The default strategy is deterministic (spends nothing);
 *   `--strategy hybrid` makes the engine's one tracked model call and prints its token usage.
 * - `org evolve --apply [--yes]`: org:evolveAnalyze, the plan printed in full with every part that may spend more, a
 *   confirmation (a terminal's y/N, or --yes), then org:evolveApply (configure) with the reviewed fingerprint. Parts that
 *   may spend more are applied only after the interactive answer; `--yes` never approves them (they are held).
 * - `org evolve history` (alias `status`): org:evolveHistory (read).
 * - `org evolve rollback [genId]`: org:evolveRollback (configure).
 * - `org evolve loop --prompt "<task>" [--iterations K]`: K sequential unattended work runs on ONE in-process host with the
 *   post-run ratchet between them (org:evolveAfterRun), then a table of what changed.
 * - `org retro <runRef> --unattended [--apply]` (org.ts calls retroUnattended): the headless retrospective.
 *
 * The changes (apply, rollback, the post-run pass) are served to the in-process CLI and the desktop only; the host
 * refuses a socket client. Every untrusted string goes through safe / safeLine.
 */
import {
  EVOLVE_IPC,
  EVOLVE_STRATEGIES,
  STAFFING_GOALS,
  isStaffingGoal,
  isVirtualProjectId,
  type EvolutionFinding,
  type EvolutionGeneration,
  type EvolutionHistory,
  type EvolutionPlan,
  type EvolutionSpendRaise,
  type EvolveAnalyzeInput,
  type EvolveAnalyzeResult,
  type EvolveApplyInput,
  type EvolveApplyResult,
  type EvolveRollbackResult,
  type EvolveStrategy,
  type EvolutionMetrics,
  type EvolvePostRunResult,
  type ExecOutcome,
  type Project,
  type RunRecord,
  type RunSummary,
  type StaffingGoal,
  type TeamEvolutionDiagnosis
} from '../../shared/types'
import { isOpenStatus } from '../../shared/view/runChains'
import { parseFlags } from '../flags'
import { confirm, hostCall, requireProject, withHost } from '../manage'
import { emit, emitLine, isJsonOutput, note, printText, safe, safeLine, warn, type Json } from '../output'
import { liveSource, resolveRunFromSource } from '../runRef'
import { CliError, EXIT, type CliContext, type HostClient } from '../types'
import {
  UNREGISTERED_MESSAGE,
  call,
  hostFailure,
  planDeltaText,
  openSession,
  overridesFromFlags,
  readPrompt,
  refuseManagedWorktree,
  runAndFollow,
  type ExecRunResult,
  type RunOutput,
  type Session
} from './exec'
import { intFlag } from './runs'
import { effectiveConcurrency, patchChanges } from '../../main/evolve/plan'

/** Analysis and the hybrid model call can take a while. */
const EVOLVE_CALL_TIMEOUT_MS = 10 * 60_000

/** The loop's bounds: iterations default 3, at most 10. */
export const EVOLVE_LOOP_DEFAULT_ITERATIONS = 3
export const EVOLVE_LOOP_MAX_ITERATIONS = 10

const usage = (message: string): CliError => new CliError(message, EXIT.usage)

export const EVOLVE_USAGE =
  'org evolve [--runs N] [--goal balanced|cost|speed] [--strategy deterministic|hybrid] [--min-waste <0-100>] [--apply [--yes]] [--eval-window <1-10>] | org evolve history | org evolve rollback [genId] | org evolve loop --prompt "<task>" [--iterations K] [--strategy ...] [--goal ...] [--eval-window M]'

// ---------- Formatting ----------

const usd = (n: number | undefined | null): string => (n === undefined || n === null ? '-' : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`)
const pct = (n: number): string => `${Math.round(n * 100)}%`
const secs = (ms: number): string => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)
const tokens = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))

function metricsLine(m: EvolutionMetrics): string {
  return `${m.runs} run${m.runs === 1 ? '' : 's'} · first-pass ${pct(m.firstPassRate)} · conflicts ${pct(m.conflictRate)} · errors ${pct(m.errorRunRate)} · median cost ${usd(m.medianCostUsd)} · median wall ${secs(m.medianWallMs)} · median input ${tokens(m.medianInputTokens)} tokens · DAG concurrency ${m.dagConcurrencyRatio.toFixed(2)}`
}

function savingsText(f: Pick<EvolutionFinding, 'estSavingsUsd' | 'estSavingsTokens' | 'estSavingsMs'>): string {
  const parts: string[] = []
  if (f.estSavingsUsd) parts.push(`${usd(f.estSavingsUsd)}`)
  if (f.estSavingsTokens) parts.push(`${tokens(f.estSavingsTokens)} tokens`)
  if (f.estSavingsMs) parts.push(secs(f.estSavingsMs))
  return parts.length ? `est. saving per run: ${parts.join(', ')}` : ''
}

export function diagnosisLines(d: TeamEvolutionDiagnosis, projectName: string): string[] {
  const lines = [`Waste digest for ${safeLine(projectName)} (goal ${safeLine(d.goal)}; ${d.runIds.length} run${d.runIds.length === 1 ? '' : 's'} read)`, `Waste score: ${d.wasteScore}/100`, `Metrics: ${metricsLine(d.metrics)}`]
  if (d.findings.length === 0) lines.push('Findings: none')
  else {
    lines.push(`Findings (${d.findings.length}):`)
    d.findings.forEach((f, i) => {
      const saving = savingsText(f)
      lines.push(`  ${i + 1}. ${safeLine(f.kind)}${f.roleSlug ? ` [${safeLine(f.roleSlug)}]` : ''} · severity ${f.severity} · ${safeLine(f.summary)}${saving ? ` (${saving})` : ''}`)
      for (const e of f.evidence) lines.push(`       - ${safeLine(e)}`)
    })
  }
  return lines
}

export { planDeltaText }

/** The parts of a plan that may make runs spend more, every summary in full (never truncated), one line each. */
export function raiseLines(raises: readonly EvolutionSpendRaise[] | undefined): string[] {
  if (!raises?.length) return []
  return ['May spend more:', ...raises.map((r) => `  - ${safeLine(r.summary)}`)]
}

/** Held raises (not applied) in full, and how to approve them. */
export function heldLines(held: readonly EvolutionSpendRaise[] | undefined): string[] {
  if (!held?.length) return []
  return [`Held, not applied (${held.length} change${held.length === 1 ? '' : 's'} may spend more):`, ...held.map((r) => `  - ${safeLine(r.summary)}`), 'To approve them, run orgai org evolve --apply again in a terminal and answer the question (without --yes).']
}

/** The plan as text. With `before` (the project as it was), each change reads `field before → after`. */
export function planLines(plan: EvolutionPlan, before?: Project): string[] {
  const lines = [`Proposed changes (strategy ${safeLine(plan.strategy)}${plan.empty ? ', nothing to change' : ''}):`]
  for (const p of plan.rolePatches) {
    const bits = patchChanges(before?.roles.find((r) => r.slug === p.slug), p).map(safeLine)
    lines.push(`  role ${safeLine(p.slug)}: ${bits.join('; ') || 'no change'} (${safeLine(p.reason)})`)
  }
  for (const s of plan.newSkills) lines.push(`  new skill ${safeLine(s.name)} for ${s.grantTo.map(safeLine).join(', ') || 'no role'} (${safeLine(s.reason)})`)
  for (const id of plan.pruneSkillIds) lines.push(`  remove skill ${safeLine(id)}`)
  if (plan.maxConcurrentSubagents !== undefined) lines.push(`  max concurrent subagents: ${before ? `${effectiveConcurrency(before)} → ` : ''}${plan.maxConcurrentSubagents}`)
  if (plan.rationale) lines.push(`Rationale: ${safeLine(plan.rationale)}`)
  const g = plan.gate
  lines.push(`Safety gate: ${g.ok ? 'passed' : 'REFUSED'}${g.violations.length ? ` · ${g.violations.length} violation${g.violations.length === 1 ? '' : 's'}` : ''}`)
  for (const v of g.violations) lines.push(`  ${safeLine(v.action)} ${safeLine(v.rule)}${v.roleSlug ? ` [${safeLine(v.roleSlug)}]` : ''}: ${safeLine(v.message)}`)
  lines.push(`Prompt budget: ${plan.promptChars.before} -> ${plan.promptChars.after} characters (limit ${plan.promptChars.limit})`)
  const i = plan.expectedImpact
  const impact = [i.costUsd ? `${usd(i.costUsd)} per run` : '', i.tokens ? `${tokens(i.tokens)} tokens per run` : '', i.wallMs ? `${secs(i.wallMs)} per run` : ''].filter(Boolean)
  lines.push(`Estimated savings: ${impact.length ? impact.join(', ') : 'none'}`)
  if (plan.usage) lines.push(`Model call: ${plan.usage.inputTokens} input + ${plan.usage.outputTokens} output tokens${plan.usage.costUsd !== undefined ? ` (${usd(plan.usage.costUsd)})` : ''}`)
  lines.push(...raiseLines(plan.spendRaises))
  return lines
}

function generationLine(g: EvolutionGeneration, history?: EvolutionHistory): string {
  const mark = history?.championId === g.id ? ' [champion]' : history?.trialId === g.id ? ' [trial]' : ''
  const m = g.trialMetrics
  const b = g.baselineMetrics
  const traj = m ? ` · cost ${usd(b.medianCostUsd)} -> ${usd(m.medianCostUsd)} · wall ${secs(b.medianWallMs)} -> ${secs(m.medianWallMs)} · input ${tokens(b.medianInputTokens)} -> ${tokens(m.medianInputTokens)} · first-pass ${pct(b.firstPassRate)} -> ${pct(m.firstPassRate)}` : ` · baseline cost ${usd(b.medianCostUsd)}, wall ${secs(b.medianWallMs)}, input ${tokens(b.medianInputTokens)}, first-pass ${pct(b.firstPassRate)}`
  return `  ${safeLine(g.id)}${mark} ${safeLine(g.status)} · ${safeLine(g.strategy)} · ${safeLine(g.summary)}${traj}${g.outcomeReason ? ` · ${safeLine(g.outcomeReason)}` : ''}`
}

export function historyLines(h: EvolutionHistory, projectName: string): string[] {
  const lines = [`Team evolution of ${safeLine(projectName)}`]
  lines.push(`Champion: ${h.championId ? safeLine(h.championId) : 'none'} · active trial: ${h.trialId ? safeLine(h.trialId) : 'none'}`)
  if (h.generations.length === 0) lines.push('Generations: none yet (run `orgai org evolve --apply`).')
  else {
    lines.push(`Generations (${h.generations.length}, oldest first):`)
    for (const g of h.generations) lines.push(generationLine(g, h))
  }
  if (h.rejectedHypotheses.length) {
    lines.push(`Rejected hypotheses (${h.rejectedHypotheses.length}):`)
    for (const r of h.rejectedHypotheses) lines.push(`  ${safeLine(r.fingerprint).slice(0, 16)} · ${safeLine(r.summary)} · ${safeLine(r.reason)}${r.generationId ? ` (${safeLine(r.generationId)})` : ''}`)
  }
  return lines
}

const projectJson = (p: Pick<Project, 'id' | 'name' | 'path'>): Json => ({ id: p.id, name: p.name, path: p.path })

// ---------- org evolve / history / rollback ----------

function analyzeInput(projectId: string, values: Record<string, string | boolean | undefined>, defaultStrategy: EvolveStrategy | undefined): EvolveAnalyzeInput & { evalWindowRuns?: number } {
  const out: EvolveAnalyzeInput & { evalWindowRuns?: number } = { projectId }
  if (typeof values.runs === 'string') out.runs = intFlag('runs', values.runs, 10, 50) || usageRuns()
  if (typeof values.goal === 'string') {
    if (!isStaffingGoal(values.goal)) throw usage(`--goal must be one of ${STAFFING_GOALS.join(', ')}.`)
    out.goal = values.goal
  }
  const strategy = typeof values.strategy === 'string' ? values.strategy : defaultStrategy
  if (strategy !== undefined) {
    if (!(EVOLVE_STRATEGIES as readonly string[]).includes(strategy)) throw usage(`--strategy must be ${EVOLVE_STRATEGIES.join(' or ')}.`)
    out.strategy = strategy as EvolveStrategy
  }
  if (typeof values['min-waste'] === 'string') {
    const raw = values['min-waste'].trim()
    const n = Number(raw)
    if (raw === '' || !Number.isFinite(n) || n < 0 || n > 100) throw usage('--min-waste must be a number from 0 to 100.')
    out.minWaste = n
  }
  if (typeof values['eval-window'] === 'string') {
    const n = intFlag('eval-window', values['eval-window'], 3, 10)
    if (n < 1) throw usage('--eval-window must be from 1 to 10.')
    out.evalWindowRuns = n
  }
  return out
}

function usageRuns(): never {
  throw usage('--runs must be a whole number from 1 to 50.')
}

const ANALYZE_FLAGS = {
  runs: { type: 'string' },
  goal: { type: 'string' },
  strategy: { type: 'string' },
  'min-waste': { type: 'string' },
  'eval-window': { type: 'string' },
  apply: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' }
} as const

/** `orgai org evolve ...`: routes the words and the analyze / apply form. */
export async function orgEvolve(ctx: CliContext, args: string[]): Promise<number> {
  const [first, ...rest] = args
  if (first === 'history' || first === 'status') return evolveHistory(ctx, rest)
  if (first === 'rollback') return evolveRollback(ctx, rest)
  if (first === 'loop') return evolveLoop(ctx, rest)
  const { values, positionals } = parseFlags(args, ANALYZE_FLAGS)
  if (positionals.length) throw usage(`Unexpected argument "${safeLine(positionals[0]).slice(0, 64)}". Usage: orgai ${EVOLVE_USAGE}`)
  const apply = values.apply === true
  const yes = values.yes === true
  analyzeInput('p', values, undefined) // the flags are checked before any host starts
  if (!apply && values['eval-window'] !== undefined) throw usage('--eval-window applies with --apply (it sets how many runs the trial is measured over).')
  checkApplyFlags(ctx, apply, yes)
  // A hybrid analysis spends a model call, which the host allows only with 'configure'.
  return withHost(ctx, apply || values.strategy === 'hybrid' ? ['read', 'configure'] : ['read'], async (client) => {
    const project = await requireProject(ctx, client)
    const input = analyzeInput(project.id, values, apply ? undefined : 'deterministic')
    if (apply) return reviewAndApply(ctx, client, project, input, yes)
    const res = await hostCall<EvolveAnalyzeResult>(client, EVOLVE_IPC.orgEvolveAnalyze, [input], { timeoutMs: EVOLVE_CALL_TIMEOUT_MS })
    emit(ctx, { project: projectJson(project), dryRun: true, diagnosis: res.diagnosis as unknown as Json, plan: res.plan as unknown as Json, digest: res.digest }, () => [
      ...diagnosisLines(res.diagnosis, project.name),
      '',
      ...planLines(res.plan, project),
      '',
      res.plan.empty || !res.plan.gate.ok ? 'Nothing would be applied.' : 'Dry run: nothing was changed. Apply it as a trial generation with: orgai org evolve --apply'
    ])
    return EXIT.ok
  })
}

/**
 * The checks of the apply form that need no host (so no model call is spent either): `-y` / `--yes` mean only "confirm
 * without asking", so they need --apply; and an apply with nobody to ask needs --yes.
 */
export function checkApplyFlags(ctx: CliContext, apply: boolean, yes: boolean): void {
  if (yes && !apply) throw usage('--yes confirms an apply: use it with --apply (orgai org evolve --apply --yes).')
  if (apply && !yes && !ctx.io.stdinIsTTY) throw usage('--apply changes the team and asks first, but there is no terminal to ask in. Pass --yes to apply without asking (parts that may spend more are then held, not applied). Nothing was changed.')
}

/** `gen_<max+1>`: the id the next applied generation gets. */
function nextGenerationId(h: EvolutionHistory | undefined): string {
  let max = 0
  for (const g of h?.generations ?? []) {
    const m = /^gen_(\d{1,9})$/.exec(g.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `gen_${max + 1}`
}

/**
 * `org evolve --apply` and `org retro <run> --unattended --apply`: analyze, print the whole plan (every part that may
 * spend more in full), confirm, then apply exactly the plan that was shown (expectedFingerprint). Parts that may spend
 * more are applied only when the person answered the interactive question; `--yes` never approves them (they are held).
 */
async function reviewAndApply(ctx: CliContext, client: HostClient, project: Project, input: EvolveApplyInput, yes: boolean): Promise<number> {
  const { evalWindowRuns, ...analyzeIn } = input
  const json = isJsonOutput(ctx)
  const analysis = await hostCall<EvolveAnalyzeResult>(client, EVOLVE_IPC.orgEvolveAnalyze, [analyzeIn], { timeoutMs: EVOLVE_CALL_TIMEOUT_MS })
  const plan = analysis.plan
  const raises = plan.spendRaises ?? []
  const shown = [...diagnosisLines(analysis.diagnosis, project.name), '', ...planLines(plan, project)]
  const base: { [k: string]: Json } = { project: projectJson(project), diagnosis: analysis.diagnosis as unknown as Json, analysisPlan: plan as unknown as Json, spendRaises: raises as unknown as Json }

  if (plan.empty || !plan.gate.ok) {
    emit(ctx, { ...base, applied: false, reason: plan.empty ? 'nothing to change' : 'the safety gate refused the plan', generation: null, teamFilesSynced: false, heldSpendRaises: [] }, () => [...shown, '', 'Nothing would be applied.'])
    return EXIT.ok
  }

  // The plan goes before the question: stdout in text mode; on stderr in json mode when a person is going to be asked.
  if (!json) printText(ctx, [...shown, ''])
  else if (!yes) for (const line of shown) if (line) warn(ctx, line)
  if (raises.length && yes) {
    const msg = `With --yes the ${raises.length} part${raises.length === 1 ? '' : 's'} listed under "May spend more" will be held, not applied.`
    if (json) warn(ctx, msg)
    else printText(ctx, [msg, ''])
  }

  const history = await hostCall<EvolutionHistory>(client, EVOLVE_IPC.orgEvolveHistory, [{ projectId: project.id }])
  const genId = nextGenerationId(history)
  const question = `Apply this plan as trial ${genId}?${raises.length ? ` ${raises.length} change${raises.length === 1 ? '' : 's'} may spend more (listed above).` : ''}`
  if (!(await confirm(ctx, question, yes))) {
    emit(ctx, { ...base, applied: false, cancelled: true, reason: 'declined', generation: null, teamFilesSynced: false, heldSpendRaises: [] }, () => 'Cancelled. Nothing was applied.')
    return EXIT.failure
  }
  // Raises are approved only by an answered question, never by --yes.
  const allowSpendRaise = raises.length > 0 && !yes

  const res = await hostCall<EvolveApplyResult>(client, EVOLVE_IPC.orgEvolveApply, [{ ...input, ...(evalWindowRuns !== undefined ? { evalWindowRuns } : {}), expectedFingerprint: plan.fingerprint, ...(allowSpendRaise ? { allowSpendRaise: true } : {}) }], { timeoutMs: EVOLVE_CALL_TIMEOUT_MS })
  const held = res.heldSpendRaises ?? []
  emit(
    ctx,
    { ...base, applied: res.applied, reason: res.reason ?? null, generation: (res.generation ?? null) as unknown as Json, teamFilesSynced: res.teamFilesSynced, plan: res.plan as unknown as Json, heldSpendRaises: held as unknown as Json },
    () => {
      const lines: string[] = []
      if (res.applied && res.generation) {
        const g = res.generation
        lines.push(`Applied ${safeLine(g.id)} as a trial: ${safeLine(g.summary)}`)
        lines.push(`It is measured over the next ${g.evalWindowRuns} finished work run${g.evalWindowRuns === 1 ? '' : 's'}; once they have run, a later evolve pass (exec --evolve, org evolve --apply, org evolve loop) decides it, and finding a regression rolls it back (orgai org evolve history).`)
        lines.push(`Undo it now with: orgai org evolve rollback ${safeLine(g.id)}`)
        lines.push(res.teamFilesSynced ? 'The .orgai/ team files were updated.' : 'The .orgai/ team files were not written (team files are off for this project, or its .orgai/ folder needs attention).')
      } else {
        lines.push(`Nothing was applied${res.reason ? `: ${safeLine(res.reason)}` : '.'}`)
        if (res.reason && /fingerprint|plan changed|changed since/i.test(res.reason)) lines.push('The plan changed since it was shown; nothing was applied. Run the command again to review the new plan.')
      }
      lines.push(...heldLines(held))
      return lines
    }
  )
  // A refused or empty apply is not a failure of the command: the plan said why.
  return EXIT.ok
}

async function evolveHistory(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, {})
  if (positionals.length) throw usage('Usage: orgai org evolve history')
  return withHost(ctx, ['read'], async (client) => {
    const project = await requireProject(ctx, client)
    const history = await hostCall<EvolutionHistory>(client, EVOLVE_IPC.orgEvolveHistory, [{ projectId: project.id }])
    emit(ctx, { project: projectJson(project), history: history as unknown as Json }, () => historyLines(history, project.name))
    return EXIT.ok
  })
}

async function evolveRollback(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, {})
  if (positionals.length > 1) throw usage('Usage: orgai org evolve rollback [genId]')
  const gen = positionals[0]
  if (gen !== undefined && !/^gen_\d{1,6}$/.test(gen)) throw usage('The generation id looks like gen_1 (see: orgai org evolve history).')
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const res = await hostCall<EvolveRollbackResult>(client, EVOLVE_IPC.orgEvolveRollback, [{ projectId: project.id, ...(gen ? { generationId: gen } : {}), reason: 'rolled back from the command line' }])
    emit(ctx, { project: projectJson(project), rolledBack: res.rolledBack, reason: res.reason ?? null, generation: (res.generation ?? null) as unknown as Json, teamFilesSynced: res.teamFilesSynced }, () =>
      res.rolledBack && res.generation
        ? [res.reason ? `Rolled back ${safeLine(res.generation.id)}, except: ${safeLine(res.reason)}.` : `Rolled back ${safeLine(res.generation.id)}: the team is as it was before it.`, res.teamFilesSynced ? 'The .orgai/ team files were updated.' : 'The .orgai/ team files were not written (team files are off for this project, or its .orgai/ folder needs attention).']
        : [`Nothing was rolled back${res.reason ? `: ${safeLine(res.reason)}` : '.'}`]
    )
    return res.rolledBack ? EXIT.ok : EXIT.failure
  })
}

// ---------- org evolve loop ----------

/** One row of the loop table. */
export interface LoopRow {
  iteration: number
  /** The generation the team ran as for this run ('gen_0' = the chart as it was). */
  gen: string
  /** What that generation changed (planDeltaText), '-' for the baseline. */
  delta: string
  inputTokens: number
  costUsd: number | null
  wallMs: number
  outcome: string
  /** What the post-run pass did. */
  ratchet: string
  runId: string | null
}

export interface LoopRunInput {
  session: Session
  ctx: CliContext
  project: Project
  prompt: string
  overrides: ReturnType<typeof overridesFromFlags>
  strategy: EvolveStrategy
  /** Runs a trial generation is measured over (the post-run pass's evalWindowRuns), when given. */
  evalWindowRuns?: number
}

/** Injection seam: how one loop iteration runs a work run (tests replace it with a fake host's run). */
export const evolveLoopIo: { runOnce: (i: LoopRunInput) => Promise<ExecRunResult> } = {
  runOnce: async ({ session, ctx, project, prompt, overrides, strategy, evalWindowRuns }) => {
    let result: ExecRunResult | undefined
    const output: RunOutput = { quiet: true, silent: true, keepSession: true, evolve: true, onResult: (r) => (result = r) }
    const code = await runAndFollow(ctx, session, output, () => call<RunSummary>(session.client, 'runs:start', [{ projectId: project.id, prompt, overrides, evolve: strategy, ...(evalWindowRuns !== undefined ? { evolveWindowRuns: evalWindowRuns } : {}) }]))
    return result ?? { runId: null, outcome: null, exitCode: code, summary: null, record: null, result: null, evolve: undefined }
  }
}

function ratchetText(r: EvolvePostRunResult | null | undefined, error?: string): string {
  if (!r) return error ? 'error' : 'none'
  const parts: string[] = []
  if (r.ratchet !== 'none') parts.push(`${r.ratchet === 'promoted' ? 'promoted' : 'rolled back'} ${safeLine(r.decided?.id ?? '')}`.trim())
  if (r.applied) {
    const delta = r.applied.plan ? planDeltaText(r.applied.plan) : ''
    parts.push(`applied ${safeLine(r.applied.id)} (trial)${delta ? `: ${delta}` : r.applied.summary ? `: ${safeLine(r.applied.summary)}` : ''}`)
  }
  for (const h of r.heldSpendRaises ?? []) parts.push(`held, may spend more: ${safeLine(h.summary)}`)
  return parts.length ? parts.join('; ') : 'none'
}

function tableLines(rows: LoopRow[]): string[] {
  const header = ['Gen', 'Role/Tier Delta', 'Input Tok', 'Cost', 'Wall ms', 'Outcome', 'Ratchet Action']
  const body = rows.map((r) => [r.gen, r.delta || '-', String(Math.round(r.inputTokens)), usd(r.costUsd), String(Math.round(r.wallMs)), r.outcome, r.ratchet])
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => safeLine(b[i]).length)))
  const fmt = (cells: string[]): string => cells.map((c, i) => safeLine(c).padEnd(widths[i])).join(' | ').trimEnd()
  return [fmt(header), widths.map((w) => '-'.repeat(w)).join('-+-'), ...body.map(fmt)]
}

/** The generation a team runs as: the active trial, else the newest promoted one, else the baseline. */
function activeGeneration(h: EvolutionHistory | undefined): { id: string; delta: string } {
  if (!h) return { id: 'gen_0', delta: '-' }
  const id = h.trialId ?? h.championId
  const g = id ? h.generations.find((x) => x.id === id) : undefined
  return g ? { id: g.id, delta: planDeltaText(g.plan) || '-' } : { id: 'gen_0', delta: '-' }
}

function runFigures(rec: RunRecord | null, summary: RunSummary | null): { inputTokens: number; costUsd: number | null; wallMs: number } {
  const s = rec?.summary ?? summary
  const usageOf = s?.usage
  const input = usageOf?.tokens?.input ?? 0
  const cost = usageOf ? usageOf.costUsd : s ? s.totalCostUsd : null
  const wall = usageOf?.wallMs ?? (s?.endedAt ? s.endedAt - s.startedAt : 0)
  return { inputTokens: input, costUsd: cost, wallMs: wall }
}

const COMPLETED: ReadonlySet<ExecOutcome> = new Set<ExecOutcome>(['completed', 'completed-unplanned'])

async function evolveLoop(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    prompt: { type: 'string' },
    'prompt-file': { type: 'string' },
    iterations: { type: 'string' },
    strategy: { type: 'string' },
    goal: { type: 'string' },
    'eval-window': { type: 'string' },
    'max-budget': { type: 'string' },
    'max-cost': { type: 'string' },
    'permission-mode': { type: 'string' }
  })
  if (positionals.length) throw usage('Give the task with --prompt "<task>" or --prompt-file <path>.')
  if (values.prompt !== undefined && values['prompt-file'] !== undefined) throw usage('Give --prompt or --prompt-file, not both.')
  const iterations = values.iterations === undefined ? EVOLVE_LOOP_DEFAULT_ITERATIONS : intFlag('iterations', values.iterations, EVOLVE_LOOP_DEFAULT_ITERATIONS, EVOLVE_LOOP_MAX_ITERATIONS)
  if (iterations < 1) throw usage(`--iterations must be from 1 to ${EVOLVE_LOOP_MAX_ITERATIONS}.`)
  const strategyRaw = values.strategy ?? 'deterministic'
  if (!(EVOLVE_STRATEGIES as readonly string[]).includes(strategyRaw)) throw usage(`--strategy must be ${EVOLVE_STRATEGIES.join(' or ')}.`)
  const strategy = strategyRaw as EvolveStrategy
  if (values.goal !== undefined && !isStaffingGoal(values.goal)) throw usage(`--goal must be one of ${STAFFING_GOALS.join(', ')}.`)
  const goal = values.goal as StaffingGoal | undefined
  const evalWindow = values['eval-window'] === undefined ? undefined : intFlag('eval-window', values['eval-window'], 3, 10)
  if (evalWindow !== undefined && evalWindow < 1) throw usage('--eval-window must be from 1 to 10.')
  const prompt = await readPrompt(ctx, values.prompt, values['prompt-file'], 'Give the task: orgai org evolve loop --prompt "<task>" (or --prompt-file <path>).')
  const overrides = overridesFromFlags({
    ...(goal ? { goal } : {}),
    ...(values['max-budget'] !== undefined ? { 'max-budget': values['max-budget'] } : {}),
    ...(values['max-cost'] !== undefined ? { 'max-cost': values['max-cost'] } : {}),
    ...(values['permission-mode'] !== undefined ? { 'permission-mode': values['permission-mode'] } : {})
  })

  // The same cwd refusals exec has, before any host starts.
  if (ctx.globals.project === undefined) refuseManagedWorktree(ctx.resolveProject([]).managedWorktree)
  const snap = await ctx.readStore().catch(() => undefined)
  if (snap && snap.hostState === 'stopped') {
    const res = ctx.resolveProject(snap.projects)
    if (res.error) throw usage(res.error)
    refuseManagedWorktree(res.managedWorktree)
    if (!res.project) throw usage(UNREGISTERED_MESSAGE)
  }

  const session = await openSession(ctx, true)
  const rows: LoopRow[] = []
  let exitCode: number = EXIT.ok
  let stopped: string | undefined
  let project: Project | undefined
  let history: EvolutionHistory | undefined
  try {
    const projects = await call<Project[]>(session.client, 'projects:list', [])
    const res = ctx.resolveProject(Array.isArray(projects) ? projects : [])
    if (res.error) throw usage(res.error)
    refuseManagedWorktree(res.managedWorktree)
    if (!res.project) throw usage(UNREGISTERED_MESSAGE)
    project = res.project
    for (let i = 1; i <= iterations; i++) {
      history = await call<EvolutionHistory>(session.client, EVOLVE_IPC.orgEvolveHistory, [{ projectId: project.id }])
      const gen = activeGeneration(history)
      note(ctx, `Iteration ${i}/${iterations}: running the task on ${gen.id}...`)
      let result: ExecRunResult
      try {
        result = await evolveLoopIo.runOnce({ session, ctx, project, prompt, overrides, strategy, ...(evalWindow !== undefined ? { evalWindowRuns: evalWindow } : {}) })
      } catch (e) {
        // A refused start (a trust or budget refusal, a busy host) ends the loop.
        const err = hostFailure(e)
        exitCode = err.exitCode
        stopped = `iteration ${i} was refused: ${safeLine(err.message)}`
        rows.push({ iteration: i, gen: gen.id, delta: gen.delta, inputTokens: 0, costUsd: null, wallMs: 0, outcome: 'refused', ratchet: 'none', runId: null })
        break
      }
      const fig = runFigures(result.record, result.summary)
      const outcome = result.outcome ?? 'interrupted'
      rows.push({
        iteration: i,
        gen: gen.id,
        delta: gen.delta,
        ...fig,
        outcome: outcome,
        ratchet: ratchetText(result.evolve),
        runId: result.runId
      })
      if (result.exitCode === EXIT.sigint || result.exitCode === EXIT.sigterm) {
        exitCode = result.exitCode
        stopped = 'interrupted'
        break
      }
      if (!result.outcome || !COMPLETED.has(result.outcome)) {
        exitCode = result.exitCode || EXIT.failure
        stopped = `iteration ${i} did not complete (${outcome}); stopping early`
        break
      }
    }
    history = await call<EvolutionHistory>(session.client, EVOLVE_IPC.orgEvolveHistory, [{ projectId: project.id }]).catch(() => history)
  } finally {
    await session.cleanup()
  }
  emitLoop(ctx, { project, rows, iterations, exitCode, stopped, history, strategy })
  return exitCode
}

function emitLoop(ctx: CliContext, r: { project: Project | undefined; rows: LoopRow[]; iterations: number; exitCode: number; stopped: string | undefined; history: EvolutionHistory | undefined; strategy: EvolveStrategy }): void {
  const doc: Json = {
    project: r.project ? projectJson(r.project) : null,
    strategy: r.strategy,
    iterations: r.iterations,
    completed: r.rows.filter((x) => x.outcome === 'completed' || x.outcome === 'completed-unplanned').length,
    stoppedEarly: r.stopped !== undefined,
    ...(r.stopped ? { stoppedReason: r.stopped } : {}),
    exitCode: r.exitCode,
    rows: r.rows as unknown as Json,
    ...(r.history ? { history: r.history as unknown as Json } : {})
  }
  if (ctx.globals.outputFormat === 'stream-json') {
    emitLine(ctx, { type: 'result', ...doc })
    return
  }
  emit(ctx, doc, () => {
    const lines = [...tableLines(r.rows)]
    if (r.stopped) lines.push('', `Stopped early: ${safeLine(r.stopped)}.`)
    if (r.history) lines.push('', ...historyLines(r.history, r.project?.name ?? ''))
    return lines
  })
}

// ---------- org retro --unattended ----------

/**
 * `orgai org retro <runRef> --unattended [--apply [--yes]]`: the headless retrospective. The interactive retro is a Team
 * assistant session in a terminal UI; unattended there is nobody to answer its questions, so this routes to the evolve
 * analysis of the run's project (org:evolveAnalyze, deterministic unless --strategy hybrid) and, with --apply, to
 * org:evolveApply, whose safety gate (permission widening, read-only roles, required reports, prompt budget, rejected
 * hypotheses) decides what may change. It says so in its output. The run only has to be a finished work run of a real project.
 */
export async function retroUnattended(ctx: CliContext, ref: string, flags: { apply: boolean; yes?: boolean; strategy?: string; goal?: string; runs?: string; 'min-waste'?: string }): Promise<number> {
  checkApplyFlags(ctx, flags.apply, flags.yes === true)
  const values = { ...(flags.strategy ? { strategy: flags.strategy } : {}), ...(flags.goal ? { goal: flags.goal } : {}), ...(flags.runs ? { runs: flags.runs } : {}), ...(flags['min-waste'] ? { 'min-waste': flags['min-waste'] } : {}) }
  return withHost(ctx, flags.apply || flags.strategy === 'hybrid' ? ['read', 'configure'] : ['read'], async (client) => {
    const src = liveSource(client)
    const { runId, projects } = await resolveRunFromSource(ctx, src, ref)
    const rec = await src.record(runId)
    if (!rec) throw new CliError(`Run ${safeLine(ref)} was not found.`, EXIT.usage)
    const s = rec.summary
    if (isVirtualProjectId(s.projectId)) throw new CliError('An Org retrospective needs a run of a real project, not an assistant session.', EXIT.usage)
    if (s.kind !== 'work' || s.quick) throw new CliError('An Org retrospective looks back at a work run; this run is not one.', EXIT.usage)
    if (isOpenStatus(s.status)) throw new CliError('That run is still open. End it first, then run the retrospective.', EXIT.usage)
    const project = projects.find((p) => p.id === s.projectId)
    if (!project) throw new CliError('The run’s project was not found.', EXIT.usage)
    const input = analyzeInput(project.id, values, flags.apply ? undefined : 'deterministic')
    const nature = 'Unattended retrospective: the interactive retro is a Team assistant session, so this reads the recent work runs of the run\'s project (including this one) through the team-evolution analysis instead.'
    if (flags.apply) {
      if (!isJsonOutput(ctx)) note(ctx, nature)
      const code = await reviewAndApply(ctx, client, project, input, flags.yes === true)
      return code
    }
    const res = await hostCall<EvolveAnalyzeResult>(client, EVOLVE_IPC.orgEvolveAnalyze, [input], { timeoutMs: EVOLVE_CALL_TIMEOUT_MS })
    emit(ctx, { mode: 'evolve-analysis', runId, project: projectJson(project), dryRun: true, diagnosis: res.diagnosis as unknown as Json, plan: res.plan as unknown as Json }, () => [
      safe(nature),
      '',
      ...diagnosisLines(res.diagnosis, project.name),
      '',
      ...planLines(res.plan, project),
      '',
      res.plan.empty || !res.plan.gate.ok ? 'Nothing would be applied.' : `Dry run: nothing was changed. Apply what passes the safety gate with: orgai org retro ${safeLine(ref)} --unattended --apply`
    ])
    return EXIT.ok
  })
}
