import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EvolutionGeneration,
  EvolutionHistory,
  EvolutionMetrics,
  EvolutionPlan,
  EvolutionSpendRaise,
  EvolvePostRunResult,
  ExecOutcome,
  HostScope,
  Project,
  RunRecord,
  RunsSubscribeResult,
  RunSummary,
  TeamEvolutionDiagnosis
} from '../../shared/types'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, project, record, summary, type Answer } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { execIo, runExec } from './exec'
import { runOrg } from './org'
import { diagnosisLines, evolveLoopIo, EVOLVE_LOOP_MAX_ITERATIONS, historyLines, planLines } from './orgEvolve'
import { evolveLine } from './exec'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realDeps = { ...manageDeps }
const realIo = { ...execIo }
const realLoop = { ...evolveLoopIo }
beforeEach(() => {
  execIo.readStdin = async () => ''
  execIo.timers = { sleep: () => Promise.resolve(), now: () => Date.now() }
})
afterEach(() => {
  Object.assign(manageDeps, realDeps)
  Object.assign(execIo, realIo)
  Object.assign(evolveLoopIo, realLoop)
  vi.restoreAllMocks()
})

const P = project('p1', '/work', { name: 'App' } as Partial<Project>)

const METRICS: EvolutionMetrics = { runs: 4, firstPassRate: 0.5, conflictRate: 0.25, errorRunRate: 0, medianCostUsd: 0.42, medianWallMs: 90_000, medianInputTokens: 52_000, dagConcurrencyRatio: 0.4 }
const DIAGNOSIS: TeamEvolutionDiagnosis = {
  projectId: 'p1',
  runIds: ['r4', 'r3', 'r2', 'r1'],
  wasteScore: 61,
  metrics: METRICS,
  goal: 'balanced',
  analyzedAt: 1,
  findings: [
    { kind: 'tier_overprovisioned', roleSlug: 'researcher', severity: 40, summary: 'researcher runs on deep but only reads\x1b[31m files', evidence: ['12 Read calls, 0 edits'], estSavingsUsd: 0.12, estSavingsTokens: 9000 },
    { kind: 'merge_conflict_hotspot', severity: 21, summary: 'implementers collide on src/a.ts', evidence: ['3 conflicts'] }
  ]
}
const PLAN: EvolutionPlan = {
  strategy: 'deterministic',
  fingerprint: 'abcdef0123456789',
  rolePatches: [{ slug: 'researcher', tier: 'fast', prompt: 'short', reason: 'cheaper tier' }],
  newSkills: [],
  pruneSkillIds: ['skl_old'],
  rationale: 'Move reading to the fast tier.',
  expectedImpact: { costUsd: 0.12, tokens: 9000 },
  gate: { ok: true, violations: [{ rule: 'tier_top', roleSlug: 'implementer', message: 'top tier not granted', action: 'trimmed' }] },
  promptChars: { before: 4000, after: 3100, limit: 5000 },
  empty: false
}
const GEN: EvolutionGeneration = {
  id: 'gen_1',
  status: 'trial',
  strategy: 'deterministic',
  fingerprint: PLAN.fingerprint,
  summary: 'researcher to fast',
  appliedAt: 5,
  appliedAtRunCount: 4,
  evalWindowRuns: 3,
  baselineMetrics: METRICS,
  plan: PLAN
}
const HISTORY: EvolutionHistory = {
  projectId: 'p1',
  generations: [GEN, { ...GEN, id: 'gen_0x', status: 'rolled_back' } as EvolutionGeneration],
  trialId: 'gen_1',
  rejectedHypotheses: [{ fingerprint: 'ffffeeeeddddcccc', summary: 'drop reviewer', reason: 'regressed first-pass', generationId: 'gen_0x', at: 1 }]
}

function setup(answers: Record<string, Answer>, opts: { format?: 'text' | 'json'; tty?: boolean } = {}) {
  const client = new FakeHostClient({ 'projects:list': () => [P], 'projects:get': () => P, ...answers }, { hello: ALL })
  const f = fakeContext({ connect: [client], cwd: '/work', stdinIsTTY: !!opts.tty, globals: { outputFormat: opts.format ?? 'text' } })
  return { f, client }
}
async function exitOf(p: Promise<number>): Promise<number> {
  try {
    return await p
  } catch (e) {
    if (e instanceof CliError) return e.exitCode
    throw e
  }
}

describe('org evolve (dry run)', () => {
  it('analyzes deterministically by default and prints the digest, patches, gate, budget and savings; changes nothing', async () => {
    const { f, client } = setup({ 'org:evolveAnalyze': () => ({ diagnosis: DIAGNOSIS, plan: PLAN, digest: 'd' }) })
    expect(await runOrg(f.ctx, ['evolve'])).toBe(0)
    expect(client.callsOf('org:evolveAnalyze')[0]).toEqual([{ projectId: 'p1', strategy: 'deterministic' }])
    expect(client.callsOf('org:evolveApply')).toHaveLength(0)
    const out = f.out()
    expect(out).not.toContain('\x1b')
    expect(out).toContain('Waste score: 61/100')
    expect(out).toContain('first-pass 50%')
    expect(out).toContain('tier_overprovisioned [researcher]')
    expect(out).toContain('est. saving per run: $0.1200, 9000 tokens')
    expect(out).toContain('role researcher: tier fast; prompt 5 characters')
    expect(out).toContain('remove skill skl_old')
    expect(out).toContain('Safety gate: passed · 1 violation')
    expect(out).toContain('trimmed tier_top [implementer]')
    expect(out).toContain('Prompt budget: 4000 -> 3100 characters (limit 5000)')
    expect(out).toContain('Estimated savings: $0.1200 per run, 9000 tokens per run')
    expect(out).toContain('Dry run: nothing was changed')
  })

  it('passes --runs, --goal, --strategy hybrid and --min-waste and prints the model call usage', async () => {
    const hybrid = { ...PLAN, strategy: 'hybrid' as const, usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.004 } }
    const { f, client } = setup({ 'org:evolveAnalyze': () => ({ diagnosis: DIAGNOSIS, plan: hybrid, digest: 'd' }) })
    expect(await runOrg(f.ctx, ['evolve', '--runs', '5', '--goal', 'cost', '--strategy', 'hybrid', '--min-waste', '20'])).toBe(0)
    expect(client.callsOf('org:evolveAnalyze')[0]).toEqual([{ projectId: 'p1', runs: 5, goal: 'cost', strategy: 'hybrid', minWaste: 20 }])
    expect(f.out()).toContain('Model call: 1200 input + 300 output tokens ($0.0040)')
    // The host allows the model call only with 'configure'; the deterministic dry run stays read-only.
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
    const det = setup({ 'org:evolveAnalyze': () => ({ diagnosis: DIAGNOSIS, plan: PLAN, digest: 'd' }) })
    await runOrg(det.f.ctx, ['evolve'])
    expect(det.f.connectCalls[0].scopes).toEqual(['read'])
  })

  it('json carries the whole diagnosis and plan', async () => {
    const { f } = setup({ 'org:evolveAnalyze': () => ({ diagnosis: DIAGNOSIS, plan: PLAN, digest: 'd' }) }, { format: 'json' })
    expect(await runOrg(f.ctx, ['evolve'])).toBe(0)
    const v = JSON.parse(f.out())
    expect(v).toMatchObject({ dryRun: true, diagnosis: { wasteScore: 61 }, plan: { fingerprint: PLAN.fingerprint } })
    expect(v.diagnosis.findings.map((x: { kind: string }) => x.kind)).toContain('tier_overprovisioned')
  })

  it('refuses bad values with exit 2', async () => {
    for (const args of [['--runs', '0'], ['--runs', '51'], ['--runs', 'x'], ['--goal', 'fast'], ['--strategy', 'llm'], ['--min-waste', '101'], ['--min-waste', 'a'], ['--eval-window', '3'], ['stray']]) {
      const { f } = setup({})
      expect(await exitOf(runOrg(f.ctx, ['evolve', ...args])), args.join(' ')).toBe(2)
      expect(f.connectCalls, args.join(' ')).toHaveLength(0)
    }
  })
})

describe('org evolve --apply', () => {
  const applied = { applied: true, generation: GEN, project: P, diagnosis: DIAGNOSIS, plan: PLAN, teamFilesSynced: true }
  const RAISE_A: EvolutionSpendRaise = { roleSlug: 'researcher', field: 'tier', summary: `researcher may move to the deep tier and cost more per run ${'a'.repeat(300)} END-A` }
  const RAISE_B: EvolutionSpendRaise = { field: 'concurrency', summary: 'the subagent limit rises from 3 to 5, so more agents may run at once' }
  const RAISING: EvolutionPlan = { ...PLAN, spendRaises: [RAISE_A, RAISE_B] }
  const analysisOf = (plan: EvolutionPlan = PLAN) => ({ diagnosis: DIAGNOSIS, plan, digest: 'd' })
  const hist = { ...HISTORY, generations: [{ ...GEN, id: 'gen_1' }, { ...GEN, id: 'gen_3' }], trialId: undefined }
  const flow = (plan: EvolutionPlan = PLAN, apply: unknown = applied, tty = false) =>
    setup({ 'org:evolveAnalyze': () => analysisOf(plan), 'org:evolveHistory': () => hist, 'org:evolveApply': () => apply }, { tty })
  const order = (client: FakeHostClient) => client.calls.map((c) => c.method).filter((m) => m.startsWith('org:evolve'))

  it('--apply --yes analyzes, then applies the reviewed fingerprint (configure scope), passes the window and prints the plan and the trial', async () => {
    const { f, client } = flow()
    expect(await runOrg(f.ctx, ['evolve', '--apply', '--yes', '--eval-window', '2', '--strategy', 'deterministic'])).toBe(0)
    expect(order(client)).toEqual(['org:evolveAnalyze', 'org:evolveHistory', 'org:evolveApply'])
    expect(client.callsOf('org:evolveAnalyze')[0]).toEqual([{ projectId: 'p1', strategy: 'deterministic' }])
    expect(client.callsOf('org:evolveApply')[0]).toEqual([{ projectId: 'p1', strategy: 'deterministic', evalWindowRuns: 2, expectedFingerprint: PLAN.fingerprint }])
    expect(f.connectCalls[0].scopes).toEqual(['read', 'configure'])
    const out = f.out()
    expect(out).toContain('Waste score: 61/100')
    expect(out).toContain('role researcher: tier fast; prompt 5 characters')
    expect(out.indexOf('Safety gate')).toBeLessThan(out.indexOf('Applied gen_1'))
    expect(out).toContain('Applied gen_1 as a trial: researcher to fast')
    expect(out).toContain('The .orgai/ team files were updated.')
    expect(out).toContain('Undo it now with: orgai org evolve rollback gen_1')
    expect(out).not.toContain('rolls back by itself')
  })

  it('-y alone is a usage error, and --yes without --apply too (no host started)', async () => {
    for (const args of [['-y'], ['--yes'], ['-y', '--runs', '5']]) {
      const { f } = flow()
      expect(await exitOf(runOrg(f.ctx, ['evolve', ...args])), args.join(' ')).toBe(2)
      expect(f.connectCalls).toHaveLength(0)
    }
  })

  it('--apply without --yes and without a terminal is exit 2 before any host call (no model call is spent)', async () => {
    for (const args of [['--apply'], ['--apply', '--strategy', 'hybrid']]) {
      const { f, client } = flow(PLAN, applied, false)
      await expect(runOrg(f.ctx, ['evolve', ...args])).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--yes') })
      expect(f.connectCalls).toHaveLength(0)
      expect(client.calls).toHaveLength(0)
    }
  })

  it('with raises: lists every one in full, --yes holds them (no allowSpendRaise) and prints the held ones with how to approve', async () => {
    const held = { ...applied, plan: RAISING, heldSpendRaises: [RAISE_A, RAISE_B] }
    const { f, client } = flow(RAISING, held)
    manageDeps.ttyConfirm = vi.fn(async () => true)
    expect(await runOrg(f.ctx, ['evolve', '--apply', '--yes'])).toBe(0)
    const call = client.callsOf('org:evolveApply')[0] as [Record<string, unknown>]
    expect(call[0].allowSpendRaise).toBeUndefined()
    expect(call[0].expectedFingerprint).toBe(PLAN.fingerprint)
    expect(manageDeps.ttyConfirm).not.toHaveBeenCalled()
    const out = f.out()
    expect(out).toContain('May spend more:')
    expect(out).toContain(RAISE_A.summary)
    expect(out).toContain(RAISE_B.summary)
    expect(out).toContain('will be held, not applied')
    expect(out).toContain('Held, not applied (2 changes may spend more):')
    expect(out.split(RAISE_A.summary).length - 1).toBe(2) // shown in the plan and again as held, never truncated
    expect(out).toContain('in a terminal')
  })

  it('a terminal confirmation names the next id and the raise count, and with raises sends allowSpendRaise', async () => {
    const { f, client } = flow(RAISING, { ...applied, plan: RAISING }, true)
    const ask = vi.fn(async (_q: string) => true)
    manageDeps.ttyConfirm = ask
    expect(await runOrg(f.ctx, ['evolve', '--apply'])).toBe(0)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toContain('Apply this plan as trial gen_4?')
    expect(ask.mock.calls[0][0]).toContain('2 changes may spend more')
    expect(client.callsOf('org:evolveApply')[0]).toEqual([{ projectId: 'p1', expectedFingerprint: PLAN.fingerprint, allowSpendRaise: true }])
    // The analysis printed before the question, not after.
    expect(f.out()).toContain(RAISE_B.summary)
  })

  it('a terminal confirmation without raises sends no allowSpendRaise', async () => {
    const { f, client } = flow(PLAN, applied, true)
    manageDeps.ttyConfirm = vi.fn(async () => true)
    expect(await runOrg(f.ctx, ['evolve', '--apply'])).toBe(0)
    expect(client.callsOf('org:evolveApply')[0]).toEqual([{ projectId: 'p1', expectedFingerprint: PLAN.fingerprint }])
  })

  it('a declined terminal confirmation applies nothing and exits 1', async () => {
    const { f, client } = flow(RAISING, applied, true)
    manageDeps.ttyConfirm = vi.fn(async () => false)
    expect(await runOrg(f.ctx, ['evolve', '--apply'])).toBe(1)
    expect(client.callsOf('org:evolveApply')).toHaveLength(0)
    expect(f.out()).toContain('Nothing was applied')
  })

  it('an empty or gate-refused plan never reaches apply, with or without --yes', async () => {
    for (const plan of [{ ...PLAN, empty: true }, { ...PLAN, gate: { ok: false, violations: [] } }]) {
      const { f, client } = flow(plan)
      expect(await runOrg(f.ctx, ['evolve', '--apply', '--yes'])).toBe(0)
      expect(client.callsOf('org:evolveApply')).toHaveLength(0)
      expect(f.out()).toContain('Nothing would be applied.')
    }
  })

  it('a fingerprint mismatch refusal reads as nothing applied and the plan changed', async () => {
    const { f } = flow(PLAN, { applied: false, reason: 'the plan changed since it was shown (fingerprint mismatch)', project: P, diagnosis: DIAGNOSIS, plan: PLAN, teamFilesSynced: false })
    expect(await runOrg(f.ctx, ['evolve', '--apply', '--yes'])).toBe(0)
    expect(f.out()).toContain('The plan changed since it was shown; nothing was applied.')
  })

  it('json carries the analysis plan, the apply result and heldSpendRaises, and no prompt text goes to stdout', async () => {
    const res = { ...applied, plan: RAISING, heldSpendRaises: [RAISE_A] }
    const { f } = setup({ 'org:evolveAnalyze': () => analysisOf(RAISING), 'org:evolveHistory': () => hist, 'org:evolveApply': () => res }, { format: 'json' })
    expect(await runOrg(f.ctx, ['evolve', '--apply', '--yes'])).toBe(0)
    const v = JSON.parse(f.out())
    expect(v).toMatchObject({ applied: true, generation: { id: 'gen_1' }, analysisPlan: { fingerprint: PLAN.fingerprint }, heldSpendRaises: [{ field: 'tier' }] })
    expect(v.analysisPlan.spendRaises).toHaveLength(2)
    expect(v.spendRaises).toHaveLength(2)
  })

  it('json with a terminal: the question goes to the terminal and the plan to stderr, stdout stays one document', async () => {
    const { f } = setup({ 'org:evolveAnalyze': () => analysisOf(RAISING), 'org:evolveHistory': () => hist, 'org:evolveApply': () => ({ ...applied, plan: RAISING }) }, { format: 'json', tty: true })
    const ask = vi.fn(async (_q: string) => true)
    manageDeps.ttyConfirm = ask
    expect(await runOrg(f.ctx, ['evolve', '--apply'])).toBe(0)
    expect(() => JSON.parse(f.out())).not.toThrow()
    expect(f.err()).toContain(RAISE_B.summary)
    expect(ask).toHaveBeenCalled()
  })

  it('wraps host strings in safeLine (no escape sequences reach the terminal)', () => {
    const lines = [
      ...diagnosisLines({ ...DIAGNOSIS, goal: 'bal\x1b[31manced' as never, findings: [{ ...DIAGNOSIS.findings[0], kind: 'k\x1b[2Jind' as never }] }, 'App'),
      ...planLines({ ...PLAN, strategy: 'det\x1b[1mx' as never, spendRaises: [{ field: 'tier', summary: 'a\x1b[31mb' }], gate: { ok: true, violations: [{ rule: 'r', message: 'm', action: 'tr\x1b[0mm' as never }] } }),
      ...historyLines({ ...HISTORY, generations: [{ ...GEN, status: 'tr\x1b[1mial' as never, strategy: 'st\x1b[1mr' as never }] }, 'App')
    ].join('\n')
    expect(lines).not.toContain('\x1b')
  })

  it('exec --evolve names the undo command, the applied changes and every held raise on one line', () => {
    const line = evolveLine({ projectId: 'p1', ratchet: 'none', applied: GEN })
    expect(line).toContain('applied gen_1 as a trial: researcher to fast')
    expect(line).toContain('changes: researcher→fast/prompt, -1 skill')
    expect(line).toContain('undo: orgai org evolve rollback gen_1')
    const held = evolveLine({ projectId: 'p1', ratchet: 'none', wasteScore: 40, heldSpendRaises: [{ field: 'effort', summary: `effort rises ${'e'.repeat(300)} END` }, { field: 'concurrency', summary: 'limit up' }] })
    expect(held).toContain(`effort rises ${'e'.repeat(300)} END`)
    expect(held).toContain('limit up')
    expect(held).toContain('orgai org evolve --apply')
    expect(held.split('\n')).toHaveLength(1)
    const both = evolveLine({ projectId: 'p1', ratchet: 'promoted', applied: GEN, heldSpendRaises: [{ field: 'tier', summary: 'tier up' }] })
    expect(both).toContain('applied gen_1')
    expect(both).toContain('tier up')
  })

  it('prints each change as before → after, read from the project as it was', async () => {
    const before = { ...P, maxConcurrentSubagents: 3, roles: [{ id: 'r_res', slug: 'researcher', name: 'Researcher', tier: 'deep', model: 'deep', effort: 'high', prompt: 'a much longer prompt' }] } as unknown as Project
    const plan: EvolutionPlan = { ...PLAN, rolePatches: [{ slug: 'researcher', tier: 'everyday', effort: 'medium', prompt: 'short', reason: 'cheaper' }], maxConcurrentSubagents: 5 }
    const { f } = setup({ 'projects:list': () => [before], 'projects:get': () => before, 'org:evolveAnalyze': () => analysisOf(plan), 'org:evolveHistory': () => hist, 'org:evolveApply': () => ({ ...applied, plan }) })
    await runOrg(f.ctx, ['evolve', '--apply', '--yes'])
    expect(f.out()).toContain('role researcher: tier deep → everyday (model deep → everyday); effort high → medium; prompt 20 → 5 characters (cheaper)')
    expect(f.out()).toContain('max concurrent subagents: 3 → 5')
  })

  it('says when team files were not written and when nothing was applied (exit 0, the plan said why)', async () => {
    const a = flow(PLAN, { ...applied, teamFilesSynced: false })
    await runOrg(a.f.ctx, ['evolve', '--apply', '--yes'])
    expect(a.f.out()).toContain('team files were not written')
    const b = flow(PLAN, { applied: false, reason: 'a trial is already active', project: P, diagnosis: DIAGNOSIS, plan: PLAN, teamFilesSynced: false })
    expect(await runOrg(b.f.ctx, ['evolve', '--apply', '--yes'])).toBe(0)
    expect(b.f.out()).toContain('Nothing was applied: a trial is already active')
  })

  it('json has applied, generation and teamFilesSynced', async () => {
    const { f } = setup({ 'org:evolveAnalyze': () => analysisOf(), 'org:evolveHistory': () => hist, 'org:evolveApply': () => applied }, { format: 'json' })
    await runOrg(f.ctx, ['evolve', '--apply', '--yes'])
    expect(JSON.parse(f.out())).toMatchObject({ applied: true, generation: { id: 'gen_1', status: 'trial' }, teamFilesSynced: true })
  })
})

describe('org evolve history and rollback', () => {
  it('history (and its alias status) prints the champion, trial, trajectory and rejected hypotheses', async () => {
    for (const word of ['history', 'status']) {
      const { f } = setup({ 'org:evolveHistory': () => HISTORY })
      expect(await runOrg(f.ctx, ['evolve', word])).toBe(0)
      const out = f.out()
      expect(out).toContain('Champion: none · active trial: gen_1')
      expect(out).toContain('gen_1 [trial] trial')
      expect(out).toContain('baseline cost $0.4200, wall 90.0 s, input 52.0k, first-pass 50%')
      expect(out).toContain('Rejected hypotheses (1):')
      expect(out).toContain('regressed first-pass')
    }
  })

  it('history json', async () => {
    const { f } = setup({ 'org:evolveHistory': () => HISTORY }, { format: 'json' })
    await runOrg(f.ctx, ['evolve', 'history'])
    expect(JSON.parse(f.out()).history.trialId).toBe('gen_1')
  })

  it('rollback names the generation, defaults to the active one, refuses a bad id', async () => {
    const res = { rolledBack: true, generation: { ...GEN, status: 'rolled_back' }, project: P, teamFilesSynced: true }
    const one = setup({ 'org:evolveRollback': () => res })
    expect(await runOrg(one.f.ctx, ['evolve', 'rollback', 'gen_1'])).toBe(0)
    expect(one.client.callsOf('org:evolveRollback')[0]).toMatchObject([{ projectId: 'p1', generationId: 'gen_1' }])
    expect(one.f.out()).toContain('Rolled back gen_1')
    const two = setup({ 'org:evolveRollback': () => res })
    expect(await runOrg(two.f.ctx, ['evolve', 'rollback'])).toBe(0)
    expect(two.client.callsOf('org:evolveRollback')[0]).toEqual([{ projectId: 'p1', reason: 'rolled back from the command line' }])
    expect(await exitOf(runOrg(setup({}).f.ctx, ['evolve', 'rollback', '../x']))).toBe(2)
    const none = setup({ 'org:evolveRollback': () => ({ rolledBack: false, reason: 'no generation to roll back', project: P, teamFilesSynced: false }) })
    expect(await runOrg(none.f.ctx, ['evolve', 'rollback'])).toBe(1)
    expect(none.f.out()).toContain('Nothing was rolled back: no generation to roll back')
  })
})

describe('org retro --unattended', () => {
  const work = summary('run_work_1', { projectId: 'p1', kind: 'work', status: 'finished' })
  const base: Record<string, Answer> = { 'runs:list': () => [work], 'runs:get': () => record(work), 'org:evolveAnalyze': () => ({ diagnosis: DIAGNOSIS, plan: PLAN, digest: 'd' }) }

  it('without a terminal and without --unattended it still refuses, pointing at --unattended', async () => {
    const { f } = setup(base)
    await expect(runOrg(f.ctx, ['retro', 'R1'])).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--unattended') })
  })

  it('--unattended runs the evolve analysis on the run\'s project and says so; nothing is changed', async () => {
    const { f, client } = setup(base)
    expect(await runOrg(f.ctx, ['retro', 'R1', '--unattended'])).toBe(0)
    expect(client.callsOf('org:evolveAnalyze')[0]).toEqual([{ projectId: 'p1', strategy: 'deterministic' }])
    expect(client.callsOf('org:evolveApply')).toHaveLength(0)
    expect(f.out()).toContain('Unattended retrospective')
    expect(f.out()).toContain('Waste score: 61/100')
  })

  const RAISE: EvolutionSpendRaise = { roleSlug: 'researcher', field: 'tier', summary: `researcher may cost more ${'r'.repeat(250)} END` }
  const retroApply = (plan: EvolutionPlan = PLAN, result: unknown = { applied: true, generation: GEN, project: P, diagnosis: DIAGNOSIS, plan, teamFilesSynced: false }, tty = false) =>
    setup({ ...base, 'org:evolveAnalyze': () => ({ diagnosis: DIAGNOSIS, plan, digest: 'd' }), 'org:evolveHistory': () => HISTORY, 'org:evolveApply': () => result }, { tty })

  it('--unattended --apply --yes analyzes then applies the reviewed fingerprint without allowSpendRaise; --apply alone is a usage error; a virtual run is refused', async () => {
    const { f, client } = retroApply({ ...PLAN, spendRaises: [RAISE] }, { applied: true, generation: GEN, project: P, diagnosis: DIAGNOSIS, plan: PLAN, teamFilesSynced: false, heldSpendRaises: [RAISE] })
    expect(await runOrg(f.ctx, ['retro', 'R1', '--unattended', '--apply', '--yes'])).toBe(0)
    expect(client.callsOf('org:evolveAnalyze')).toHaveLength(1)
    expect(client.callsOf('org:evolveApply')).toEqual([[{ projectId: 'p1', expectedFingerprint: PLAN.fingerprint }]])
    expect(f.out()).toContain(RAISE.summary)
    expect(f.out()).toContain('Held, not applied')
    expect(await exitOf(runOrg(f.ctx, ['retro', 'R1', '--apply']))).toBe(2)
    const quick = summary('run_q', { projectId: 'quick', kind: 'work', quick: true } as never)
    const q = setup({ 'runs:list': () => [quick], 'runs:get': () => record(quick) })
    expect(await exitOf(runOrg(q.f.ctx, ['retro', 'R1', '--unattended']))).toBe(2)
  })

  it('--apply without --yes and without a terminal, or --yes without --apply, is exit 2 and makes no host call', async () => {
    for (const args of [['--unattended', '--apply'], ['--unattended', '--yes']]) {
      const { f, client } = retroApply()
      expect(await exitOf(runOrg(f.ctx, ['retro', 'R1', ...args])), args.join(' ')).toBe(2)
      expect(f.connectCalls).toHaveLength(0)
      expect(client.calls).toHaveLength(0)
    }
  })

  it('on a terminal it asks (raise count, next id) and with raises sends allowSpendRaise; declined applies nothing', async () => {
    const plan = { ...PLAN, spendRaises: [RAISE] }
    const yes = retroApply(plan, undefined, true)
    const ask = vi.fn(async (_q: string) => true)
    manageDeps.ttyConfirm = ask
    expect(await runOrg(yes.f.ctx, ['retro', 'R1', '--unattended', '--apply'])).toBe(0)
    expect(ask.mock.calls[0][0]).toContain('Apply this plan as trial gen_2?')
    expect(ask.mock.calls[0][0]).toContain('1 change may spend more')
    expect(yes.client.callsOf('org:evolveApply')[0]).toEqual([{ projectId: 'p1', expectedFingerprint: PLAN.fingerprint, allowSpendRaise: true }])
    const no = retroApply(plan, undefined, true)
    manageDeps.ttyConfirm = vi.fn(async () => false)
    expect(await runOrg(no.f.ctx, ['retro', 'R1', '--unattended', '--apply'])).toBe(1)
    expect(no.client.callsOf('org:evolveApply')).toHaveLength(0)
  })

  it('an empty plan never reaches apply', async () => {
    const { f, client } = retroApply({ ...PLAN, empty: true })
    expect(await runOrg(f.ctx, ['retro', 'R1', '--unattended', '--apply', '--yes'])).toBe(0)
    expect(client.callsOf('org:evolveApply')).toHaveLength(0)
    expect(f.out()).toContain('Nothing would be applied.')
  })
})

// ---------- exec --evolve and the loop ----------

const RUN = 'run_loop01'
const finalSummary = (outcome: ExecOutcome, extra: Partial<RunSummary> = {}): RunSummary =>
  summary(RUN, { status: 'finished', startedAt: 100, endedAt: 4100, execOutcome: outcome, totalCostUsd: 0.25, ...extra })
function snapshotOf(rec: RunRecord): RunsSubscribeResult {
  return { mode: 'snapshot', hostInstanceId: 'aaaaaaaaaaaa', seq: 10, filterKey: 'fk1', snapshot: { liveRuns: [rec.summary], pendingCards: {}, activeRun: rec, recentEndedRuns: [] } }
}
const usage = { tokens: { input: 1500, output: 200, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.25, costSource: 'builtin', models: [], roles: [], wallMs: 4000, turns: 1, toolCalls: 0, retries: 0, agents: 1, agentsWithoutResult: 0, noResultTokens: 0, nudges: 0, waitingMs: 0 }

function runHost(outcomes: ExecOutcome[], extra: Record<string, Answer> = {}, evolve: (n: number) => EvolvePostRunResult | null = () => ({ projectId: 'p1', ratchet: 'none' })) {
  let n = 0
  let afterRuns = 0
  const history = { ...HISTORY, generations: [] as EvolutionGeneration[], trialId: undefined as string | undefined, rejectedHypotheses: [] }
  const client = new FakeHostClient(
    {
      'projects:list': () => [P],
      'runs:list': () => [],
      'runs:start': () => {
        n++
        return summary(RUN, { status: 'starting', startedAt: 100, prompt: 'task' })
      },
      'runs:subscribe': () => snapshotOf(record(finalSummary(outcomes[Math.min(n, outcomes.length) - 1] ?? 'completed', { usage: usage as never }))),
      'runs:get': () => record(finalSummary(outcomes[Math.min(n, outcomes.length) - 1] ?? 'completed', { usage: usage as never })),
      'runs:stop': () => undefined,
      'org:evolveHistory': () => history,
      'org:evolveAfterRun': () => evolve(++afterRuns),
      ...extra
    },
    { hello: ALL }
  )
  return { client, starts: () => n }
}
const liveCtx = (client: FakeHostClient, format: 'text' | 'json' = 'text') => fakeContext({ cwd: '/work', store: { hostState: 'ready', projects: [P] }, connect: [client], globals: { outputFormat: format } })

describe('orgai exec --evolve', () => {
  it('starts with evolve, waits for the post-run pass and prints one stderr line (stdout stays the answer)', async () => {
    const { client } = runHost(['completed'], { 'org:evolveAfterRun': () => ({ projectId: 'p1', ratchet: 'promoted', ratchetReason: 'cheaper', applied: { ...GEN, id: 'gen_2' }, wasteScore: 50 }) })
    const f = liveCtx(client)
    expect(await runExec(f.ctx, ['--evolve=hybrid', '--quiet', 'do it'])).toBe(0)
    expect((client.callsOf('runs:start')[0] as unknown[])[0]).toMatchObject({ projectId: 'p1', evolve: 'hybrid' })
    expect(client.callsOf('org:evolveAfterRun')).toEqual([[{ runId: RUN }]])
    expect(f.connectCalls[0].scopes).toEqual(['read', 'operate', 'configure'])
    expect(f.err()).toContain('Team evolution: ratchet promoted (cheaper); applied gen_2 as a trial')
    expect(f.out()).not.toContain('Team evolution')
  })

  it('a bare --evolve is true and does not take the prompt as its value', async () => {
    const { client } = runHost(['completed'])
    const f = liveCtx(client)
    expect(await runExec(f.ctx, ['--evolve', 'do it'])).toBe(0)
    expect((client.callsOf('runs:start')[0] as unknown[])[0]).toMatchObject({ prompt: 'do it', evolve: true })
  })

  it('json has an evolve object; a failing pass is reported, not fatal', async () => {
    const ok = runHost(['completed'], { 'org:evolveAfterRun': () => ({ projectId: 'p1', ratchet: 'none', wasteScore: 3 }) })
    const f = liveCtx(ok.client, 'json')
    expect(await runExec(f.ctx, ['--evolve', 'x'])).toBe(0)
    expect(JSON.parse(f.out()).evolve).toMatchObject({ ratchet: 'none', wasteScore: 3 })
    const bad = runHost(['completed'], { 'org:evolveAfterRun': () => { throw new Error('boom') } })
    const g = liveCtx(bad.client, 'json')
    expect(await runExec(g.ctx, ['--evolve', 'x'])).toBe(0)
    expect(JSON.parse(g.out()).evolve).toMatchObject({ ratchet: 'none', skipped: true, error: 'boom' })
  })

  it('is refused with --quick and --continue, and rejects an unknown strategy', async () => {
    const { client } = runHost(['completed'])
    for (const args of [['--evolve', '--quick', 'x'], ['--evolve', '--continue', 'x'], ['--evolve=nope', 'x']]) {
      await expect(runExec(liveCtx(client).ctx, args), args.join(' ')).rejects.toMatchObject({ exitCode: EXIT.usage })
    }
    expect(client.callsOf('runs:start')).toHaveLength(0)
  })
})

describe('org evolve loop', () => {
  const loop = (client: FakeHostClient, args: string[], format: 'text' | 'json' = 'text') => {
    const f = liveCtx(client, format)
    return { f, run: () => runOrg(f.ctx, ['evolve', 'loop', ...args]) }
  }

  it('bounds the iterations: default 3, 1..10, anything else is exit 2 before a host starts', async () => {
    const { client } = runHost(['completed'])
    for (const k of ['0', '11', 'x', '-1']) {
      const { f, run } = loop(client, ['--prompt', 't', '--iterations', k])
      expect(await exitOf(run()), k).toBe(2)
      expect(f.connectCalls).toHaveLength(0)
    }
    expect(EVOLVE_LOOP_MAX_ITERATIONS).toBe(10)
    const { run } = loop(client, ['--prompt', 't'])
    expect(await run()).toBe(0)
    expect(client.callsOf('runs:start')).toHaveLength(3)
  })

  it('needs a task, refuses stray words, and bad strategy / goal / eval-window', async () => {
    const { client } = runHost(['completed'])
    for (const args of [[], ['stray'], ['--prompt', 't', '--strategy', 'x'], ['--prompt', 't', '--goal', 'x'], ['--prompt', 't', '--eval-window', '11'], ['--prompt', 't', '--prompt-file', 'f']]) {
      expect(await exitOf(loop(client, args).run()), args.join(' ')).toBe(2)
    }
  })

  it('runs K work runs on one host with evolve and the window, prints the table and a json document', async () => {
    const results: (EvolvePostRunResult | null)[] = [
      { projectId: 'p1', ratchet: 'none', applied: { ...GEN, id: 'gen_1' } },
      { projectId: 'p1', ratchet: 'promoted', decided: { ...GEN, id: 'gen_1' } }
    ]
    const { client } = runHost(['completed'], {}, (n) => results[n - 1])
    const { f, run } = loop(client, ['--prompt', 'task', '--iterations', '2', '--strategy', 'deterministic', '--eval-window', '2'])
    expect(await run()).toBe(0)
    expect(client.callsOf('runs:start')).toHaveLength(2)
    expect((client.callsOf('runs:start')[0] as unknown[])[0]).toMatchObject({ projectId: 'p1', prompt: 'task', evolve: 'deterministic', evolveWindowRuns: 2, overrides: { execMode: true } })
    expect(f.connectCalls).toHaveLength(1)
    const out = f.out()
    expect(out).toContain('Gen')
    expect(out).toContain('Role/Tier Delta')
    expect(out).toContain('Input Tok')
    expect(out).toContain('Ratchet Action')
    expect(out).toContain('gen_0')
    expect(out).toContain('applied gen_1 (trial)')
    expect(out).toContain('promoted gen_1')
    expect(out).toContain('1500')
    expect(out).toContain('$0.2500')
    expect(out).toContain('4000')

    const j = runHost(['completed'], {}, (n) => results[n - 1])
    const g = loop(j.client, ['--prompt', 'task', '--iterations', '2'], 'json')
    expect(await g.run()).toBe(0)
    const doc = JSON.parse(g.f.out())
    expect(doc).toMatchObject({ iterations: 2, completed: 2, stoppedEarly: false, exitCode: 0, strategy: 'deterministic' })
    expect(doc.rows).toHaveLength(2)
    expect(doc.rows[0]).toMatchObject({ iteration: 1, gen: 'gen_0', inputTokens: 1500, outcome: 'completed', ratchet: 'applied gen_1 (trial): researcher→fast/prompt, -1 skill' })
  })

  it('stops early on a failed run with its exit code, and on a refused start', async () => {
    const failed = runHost(['completed', 'failed', 'completed'])
    const a = loop(failed.client, ['--prompt', 't', '--iterations', '5'])
    expect(await a.run()).toBe(1)
    expect(failed.starts()).toBe(2)
    expect(a.f.out()).toContain('Stopped early: iteration 2 did not complete (failed)')

    const refused = runHost(['completed'], {
      'runs:start': () => {
        throw Object.assign(new Error('Trust this folder first'), { data: { code: 'bad_request', message: 'Trust this folder first' } })
      }
    })
    const b = loop(refused.client, ['--prompt', 't'], 'json')
    expect(await b.run()).toBe(2)
    const doc = JSON.parse(b.f.out())
    expect(doc).toMatchObject({ stoppedEarly: true, exitCode: 2 })
    expect(doc.rows[0].outcome).toBe('refused')
    expect(doc.stoppedReason).toContain('Trust this folder first')
  })

  it('an unregistered folder is exit 2 before any run starts', async () => {
    const { client } = runHost(['completed'])
    const f = fakeContext({ cwd: '/elsewhere', store: { hostState: 'ready', projects: [P] }, connect: [client] })
    expect(await exitOf(runOrg(f.ctx, ['evolve', 'loop', '--prompt', 't']))).toBe(2)
    expect(client.callsOf('runs:start')).toHaveLength(0)
  })
})
