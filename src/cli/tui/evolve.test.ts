import { describe, expect, it, vi } from 'vitest'
import type { EvolutionGeneration, EvolutionMetrics, EvolutionPlan, EvolveAnalyzeResult, TeamEvolutionDiagnosis } from '../../shared/types'
import { analyzeText, applyText, historyText, parseEvolve, rollbackText } from './evolve'
import { SLASH_COMMANDS } from './slashCommands'
import { createInitialState, setProject } from './state'
import type { SlashContext, TuiSessionApi, TuiState } from './types'

const metrics = (o: Partial<EvolutionMetrics> = {}): EvolutionMetrics => ({ runs: 5, firstPassRate: 0.6, conflictRate: 0, errorRunRate: 0, medianCostUsd: 0.5, medianWallMs: 120000, medianInputTokens: 40000, dagConcurrencyRatio: 1, ...o })
const plan = (o: Partial<EvolutionPlan> = {}): EvolutionPlan =>
  ({ strategy: 'deterministic', fingerprint: 'f', rolePatches: [{ slug: 'dev', tier: 'fast', reason: 'cheap' }], newSkills: [], pruneSkillIds: [], rationale: '', expectedImpact: { costUsd: 0.2 }, gate: { ok: true, violations: [] }, promptChars: { before: 1, after: 1, limit: 9 }, empty: false, ...o }) as EvolutionPlan
const diagnosis = (n = 9): TeamEvolutionDiagnosis =>
  ({
    projectId: 'p1', runIds: ['a', 'b'], wasteScore: 42, metrics: metrics(), goal: 'balanced', analyzedAt: 1,
    findings: Array.from({ length: n }, (_, i) => ({ kind: 'tool_friction', roleSlug: `r${i}`, severity: 5, summary: i === 0 ? 'bad \u001b[31mred\u001b]0;title\u0007 text' : `finding ${i}`, evidence: [], estSavingsUsd: 0.1 }))
  }) as TeamEvolutionDiagnosis
const gen = (o: Partial<EvolutionGeneration> = {}): EvolutionGeneration =>
  ({ id: 'gen_1', status: 'trial', strategy: 'deterministic', fingerprint: 'f', summary: 'tier down', appliedAt: 1, appliedAtRunCount: 5, evalWindowRuns: 3, baselineMetrics: metrics(), plan: plan(), ...o }) as EvolutionGeneration

describe('parseEvolve', () => {
  it('parses all four forms and bad arguments', () => {
    expect(parseEvolve('')).toEqual({ kind: 'analyze' })
    expect(parseEvolve('analyze')).toEqual({ kind: 'analyze' })
    expect(parseEvolve('apply')).toEqual({ kind: 'apply', strategy: 'deterministic' })
    expect(parseEvolve('apply HYBRID')).toEqual({ kind: 'apply', strategy: 'hybrid' })
    expect(parseEvolve('history')).toEqual({ kind: 'history' })
    expect(parseEvolve('rollback')).toEqual({ kind: 'rollback' })
    expect(parseEvolve('rollback gen_2')).toEqual({ kind: 'rollback', generationId: 'gen_2' })
    for (const bad of ['apply fast', 'apply hybrid x', 'history now', 'rollback a b', 'rollback ../x', 'nope']) expect(parseEvolve(bad).kind).toBe('error')
  })
})

describe('formatters', () => {
  it('bounds findings and strips escape sequences', () => {
    const text = analyzeText({ diagnosis: diagnosis(), plan: plan(), digest: '' } as EvolveAnalyzeResult)
    expect(text).toContain('Waste score 42/100')
    expect(text).toContain('+3 more')
    expect(text).toContain('first-pass 60%')
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('\u0007')
    expect(text).toContain('Safety gate: passed')
  })
  it('shows gate violations and hybrid usage', () => {
    const p = plan({ gate: { ok: true, violations: Array.from({ length: 6 }, (_, i) => ({ rule: 'tier_top', message: `m${i}`, action: 'trimmed' as const })) }, usage: { inputTokens: 2000, outputTokens: 300, costUsd: 0.01 } })
    const lines = applyText({ applied: true, generation: gen(), project: {} as never, diagnosis: diagnosis(1), plan: p, teamFilesSynced: true }, 'hybrid')
    expect(lines).toContain('Applied gen_1')
    expect(lines).toContain('Undo it now with /evolve rollback gen_1.')
    // Every violation is listed (a person may approve from this text).
    expect(lines).toContain('m5')
    expect(lines).not.toContain('more')
    expect(lines).toContain('Synthesis used 2.0k input')
    expect(lines).toContain('were synced')
  })
  it('history and rollback text', () => {
    const h = historyText({ projectId: 'p1', generations: [gen({ status: 'promoted', trialMetrics: metrics({ firstPassRate: 0.9 }) }), gen({ id: 'gen_2' })], championId: 'gen_1', trialId: 'gen_2', rejectedHypotheses: [{ fingerprint: 'x', summary: 's', reason: 'worse', at: 1 }] })
    expect(h).toContain('Champion: gen_1')
    expect(h).toContain('Trial: gen_2')
    expect(h).toContain('60%->90%')
    expect(h).toContain('Rejected hypotheses: 1')
    expect(rollbackText({ rolledBack: false, reason: 'no gen', project: {} as never, teamFilesSynced: false })).toContain('no gen')
  })
})

function ctxFor(s: TuiState, answer = true, p: EvolutionPlan = plan()) {
  const session = {
    evolveAnalyze: vi.fn(async () => ({ diagnosis: diagnosis(1), plan: p, digest: '' })),
    evolveHistory: vi.fn(async () => ({ projectId: 'p1', generations: [], rejectedHypotheses: [] })),
    evolveApply: vi.fn(async () => ({ applied: true, generation: gen(), project: { id: 'p1' }, diagnosis: diagnosis(1), plan: plan(), teamFilesSynced: true })),
    evolveRollback: vi.fn(async () => ({ rolledBack: true, generation: gen(), project: { id: 'p1' }, teamFilesSynced: false }))
  }
  const ctx = { session: session as unknown as TuiSessionApi, state: () => s, notify: vi.fn(), openText: vi.fn(async () => {}), confirm: vi.fn(async () => answer) } as unknown as SlashContext
  return { ctx, session }
}
const evolve = SLASH_COMMANDS.find((c) => c.name === 'evolve')!
const withProject = (): TuiState => setProject(createInitialState('/tmp/p'), { id: 'p1', name: 'P' } as never)

describe('/evolve command', () => {
  it('calls each channel with the project id', async () => {
    const { ctx, session } = ctxFor(withProject())
    await evolve.run(ctx, '')
    expect(session.evolveAnalyze).toHaveBeenCalledWith({ projectId: 'p1' })
    await evolve.run(ctx, 'history')
    expect(session.evolveHistory).toHaveBeenCalledWith('p1')
    await evolve.run(ctx, 'apply hybrid')
    expect(session.evolveAnalyze).toHaveBeenLastCalledWith({ projectId: 'p1', strategy: 'hybrid' })
    expect(session.evolveApply).toHaveBeenCalledWith({ projectId: 'p1', strategy: 'hybrid', expectedFingerprint: 'f' })
    await evolve.run(ctx, 'rollback gen_1')
    expect(session.evolveRollback).toHaveBeenCalledWith({ projectId: 'p1', generationId: 'gen_1' })
    // analyze, history, the plan before the apply, the applied text
    expect(ctx.openText).toHaveBeenCalledTimes(4)
  })
  it('apply analyzes, shows every spend raise in full, asks with the next id and the count, and applies that fingerprint with allowSpendRaise', async () => {
    const long = `dev may move to the deep tier and cost more per run: ${'x'.repeat(400)} END`
    const p = plan({ fingerprint: 'fp9', spendRaises: [{ roleSlug: 'dev', field: 'tier', summary: long }, { field: 'concurrency', summary: 'more subagents at once' }] })
    const { ctx, session } = ctxFor(withProject(), true, p)
    session.evolveHistory.mockResolvedValueOnce({ projectId: 'p1', generations: [gen({ id: 'gen_2' }), gen({ id: 'gen_4' })], rejectedHypotheses: [] } as never)
    await evolve.run(ctx, 'apply')
    expect(session.evolveAnalyze).toHaveBeenCalledWith({ projectId: 'p1', strategy: 'deterministic' })
    const shown = (ctx.openText as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    expect(shown).toContain('May spend more:')
    expect(shown).toContain(long)
    expect(shown).toContain('more subagents at once')
    expect(ctx.confirm).toHaveBeenCalledWith('Apply this plan as trial gen_5? 2 changes may spend more.')
    expect(session.evolveApply).toHaveBeenCalledWith({ projectId: 'p1', strategy: 'deterministic', expectedFingerprint: 'fp9', allowSpendRaise: true })
  })
  it('Esc (a declined question) applies nothing', async () => {
    const p = plan({ spendRaises: [{ field: 'effort', summary: 'raises effort' }] })
    const { ctx, session } = ctxFor(withProject(), false, p)
    await evolve.run(ctx, 'apply')
    expect(session.evolveAnalyze).toHaveBeenCalled()
    expect(ctx.confirm).toHaveBeenCalled()
    expect(session.evolveApply).not.toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenCalledWith('Nothing applied.')
  })
  it('an empty or gate-refused plan never asks and never applies', async () => {
    for (const p of [plan({ empty: true }), plan({ gate: { ok: false, violations: [] } })]) {
      const { ctx, session } = ctxFor(withProject(), true, p)
      await evolve.run(ctx, 'apply')
      expect(ctx.confirm).not.toHaveBeenCalled()
      expect(session.evolveApply).not.toHaveBeenCalled()
      expect(ctx.notify).toHaveBeenCalledWith(expect.stringMatching(/Nothing to change|refused/), 'warn')
    }
  })
  it('lists held raises and the whole refusal reason in the applied text', () => {
    const reason = `the plan changed since it was shown ${'y'.repeat(300)} DONE`
    const held = [{ roleSlug: 'dev', field: 'tier' as const, summary: `held sentence ${'z'.repeat(300)} END` }]
    const refused = applyText({ applied: false, reason, project: {} as never, diagnosis: diagnosis(1), plan: plan(), teamFilesSynced: false, heldSpendRaises: held }, 'deterministic')
    expect(refused).toContain(reason)
    expect(refused).toContain(held[0].summary)
    const ok = applyText({ applied: true, generation: gen(), project: {} as never, diagnosis: diagnosis(1), plan: plan(), teamFilesSynced: true, heldSpendRaises: held }, 'deterministic')
    expect(ok).toContain(held[0].summary)
  })
  it('refuses without a project, on bad args, and while a run works', async () => {
    const none = ctxFor(createInitialState('/tmp/p'))
    await evolve.run(none.ctx, 'analyze')
    expect(none.ctx.notify).toHaveBeenCalledWith(expect.stringContaining('saved project'), 'warn')
    const bad = ctxFor(withProject())
    await evolve.run(bad.ctx, 'apply fast')
    expect(bad.session.evolveApply).not.toHaveBeenCalled()
    const s = withProject()
    Object.assign(s, { activeRunId: 'r1', runs: { r1: { summary: { id: 'r1', status: 'running' } } } })
    const busy = ctxFor(s)
    await evolve.run(busy.ctx, 'apply')
    expect(busy.session.evolveAnalyze).not.toHaveBeenCalled()
    expect(busy.session.evolveApply).not.toHaveBeenCalled()
    expect(busy.ctx.notify).toHaveBeenCalledWith(expect.stringContaining('run is working'), 'warn')
  })
  it('surfaces host errors as a notice', async () => {
    const { ctx, session } = ctxFor(withProject())
    session.evolveAnalyze.mockRejectedValueOnce(new Error('unknown channel org:evolveAnalyze'))
    await evolve.run(ctx, 'analyze')
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining('unknown channel'), 'danger')
  })
})
