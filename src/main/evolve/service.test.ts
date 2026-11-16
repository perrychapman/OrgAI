import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunRecord, SkillSpec } from '../../shared/types'
import { project, role, run } from './fixtures'
import { cooldownOf, createEvolveService, type EvolveServiceDeps } from './service'
import { readLedger } from './ratchet'

const NOW = 5_000_000
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evolve-svc-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Clean, simple dev work in `n` runs starting at `t0` (over-provisioned: effort high, first pass 100%). */
const cleanRuns = (n: number, t0: number, over: Parameters<typeof run>[0] = {}): RunRecord[] =>
  Array.from({ length: n }, (_, i) => run({ startedAt: t0 + i * 1000, agents: [{ slug: 'dev', turns: 3, out: 400 }, { slug: 'dev', turns: 3, out: 400 }], assignments: [{ tier: 'deep' }, { tier: 'deep' }], ...over }))

function harness(opts: { runs?: RunRecord[]; proj?: Project; complete?: EvolveServiceDeps['complete']; skills?: boolean | 'no-enable'; sync?: () => Promise<boolean>; skillFindings?: EvolveServiceDeps['skillFindings']; teamFilesState?: () => string | undefined } = {}) {
  let proj = opts.proj ?? project()
  let runs = opts.runs ?? cleanRuns(8, 1_000_000)
  const log: string[] = []
  const created: string[] = []
  const disabled: string[] = []
  const state = { updates: 0, inFlight: 0, maxInFlight: 0, listCalls: 0 }
  const skills: NonNullable<EvolveServiceDeps['skills']> = {
    create: vi.fn((input) => {
      const spec = { id: `sk_${input.draft.name}`, name: input.draft.name, description: input.draft.description } as SkillSpec
      proj = { ...proj, skills: [...(proj.skills ?? []), spec], roles: proj.roles.map((r) => (input.roleIds?.includes(r.id) ? { ...r, skills: [...(r.skills ?? []), spec.id] } : r)) }
      created.push(spec.name)
      return { project: structuredClone(proj), skills: [] }
    }),
    remove: vi.fn((input) => {
      proj = { ...proj, skills: (proj.skills ?? []).filter((s) => s.id !== input.skillId), roles: proj.roles.map((r) => ({ ...r, skills: r.skills?.filter((s) => s !== input.skillId) })) }
      return { project: structuredClone(proj), skills: [] }
    }),
    setEnabled: vi.fn((_pid: string, id: string, on: boolean) => { if (!on) disabled.push(id) }),
    readDraft: vi.fn((_pid, id) => ((proj.skills ?? []).some((s) => s.id === id) ? { name: `old-${id.replace('_', '-')}`, description: 'd', body: 'b' } : null))
  }
  const deps: EvolveServiceDeps = {
    dataDir: dir,
    getProject: (id) => (id === proj.id ? structuredClone(proj) : undefined),
    updateProject: (_id, fn) => {
      state.inFlight++
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      state.updates++
      proj = fn(structuredClone(proj))
      state.inFlight--
      return structuredClone(proj)
    },
    listRunRecords: () => {
      state.listCalls++
      return runs
    },
    syncTeamFiles: opts.sync ?? (async () => true),
    complete: opts.complete,
    ...(opts.skills ? { skills: opts.skills === 'no-enable' ? { create: skills.create, remove: skills.remove, readDraft: skills.readDraft } : skills } : {}),
    ...(opts.skillFindings ? { skillFindings: opts.skillFindings } : {}),
    ...(opts.teamFilesState ? { teamFilesState: opts.teamFilesState } : {}),
    now: () => NOW,
    log: (l, m) => log.push(`${l}: ${m}`)
  }
  const svc = createEvolveService(deps)
  return { svc, deps, state, log, created, disabled, skills, svcLedger: () => readLedger(dir, 'p1'), get proj() { return proj }, set proj(p: Project) { proj = p }, setRuns: (r: RunRecord[]) => { runs = r } }
}

describe('analyze', () => {
  it('spends no tokens, returns a bounded digest and never mutates', async () => {
    const complete = vi.fn(async () => ({ text: '{}' }))
    const h = harness({ complete })
    const r = await h.svc.analyze({ projectId: 'p1' })
    expect(complete).not.toHaveBeenCalled()
    expect(r.diagnosis.wasteScore).toBeGreaterThan(0)
    expect(r.digest.length).toBeLessThan(2800)
    expect(h.state.updates).toBe(0)
    expect(h.svc.history('p1').generations).toEqual([])
  })
  it('refuses an unsafe or unknown project id', async () => {
    const h = harness()
    await expect(h.svc.analyze({ projectId: '../etc' })).rejects.toThrow('Invalid project id')
    await expect(h.svc.analyze({ projectId: 'nope' })).rejects.toThrow('Project not found')
    expect(() => h.svc.history('a/b')).toThrow()
  })
  it('hybrid analysis calls the model once and records usage', async () => {
    const complete = vi.fn(async () => ({ text: '{"rationale":"ok"}', usage: { inputTokens: 10, outputTokens: 2 } }))
    const onUsage = vi.fn()
    const h = harness({ complete })
    const svc = createEvolveService({ ...h.deps, onUsage })
    const r = await svc.analyze({ projectId: 'p1', strategy: 'hybrid' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(r.plan.usage).toEqual({ inputTokens: 10, outputTokens: 2 })
  })
})

describe('apply and the single-trial rule', () => {
  it('applies a gated plan, snapshots first, syncs team files, then refuses a second apply while on trial', async () => {
    const h = harness()
    const before = structuredClone(h.proj)
    const res = await h.svc.apply({ projectId: 'p1' })
    expect(res.applied).toBe(true)
    expect(res.teamFilesSynced).toBe(true)
    expect(res.generation).toMatchObject({ id: 'gen_1', status: 'trial', evalWindowRuns: 3, strategy: 'deterministic' })
    expect(JSON.stringify(res.generation)).not.toContain('snapshot')
    expect(h.proj.roles.find((r) => r.slug === 'dev')?.effort).toBe('medium')
    expect(h.proj.permissionMode).toBe(before.permissionMode)
    const h2 = h.svc.history('p1')
    expect(h2.trialId).toBe('gen_1')
    const again = await h.svc.apply({ projectId: 'p1' })
    expect(again.applied).toBe(false)
    expect(again.reason).toContain('still on trial')
    expect(h.state.updates).toBe(1)
  })
  it('a second apply settles a trial whose window filled through ordinary runs: promoted, never stuck on trial', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    // Three ordinary runs (no afterRun pass): the trial window is full, nothing decided it yet.
    h.setRuns([...cleanRuns(3, NOW + 10), ...cleanRuns(8, 1_000_000)])
    const again = await h.svc.apply({ projectId: 'p1' })
    expect(again.reason ?? '').not.toContain('still on trial')
    expect(h.svc.history('p1')).toMatchObject({ championId: 'gen_1' })
    expect(h.svc.history('p1').generations[0]).toMatchObject({ id: 'gen_1', status: 'promoted' })
  })
  it('a second apply rolls back a trial that regressed over ordinary runs, says so and applies nothing new', async () => {
    const h = harness()
    const original = structuredClone(h.proj)
    await h.svc.apply({ projectId: 'p1' })
    const bad = cleanRuns(3, NOW + 10, { status: 'error', agents: [{ slug: 'dev', state: 'error' }, { slug: 'dev', state: 'error' }] })
    h.setRuns([...bad, ...cleanRuns(8, 1_000_000)])
    const again = await h.svc.apply({ projectId: 'p1' })
    expect(again.applied).toBe(false)
    expect(again.reason).toContain('gen_1 finished its trial and was rolled back')
    expect(again.teamFilesSynced).toBe(true) // the rollback wrote the team files
    expect(again.project.roles).toEqual(original.roles)
    expect(h.proj.roles).toEqual(original.roles)
    expect(h.svc.history('p1').trialId).toBeUndefined()
    expect(h.svc.history('p1').generations).toHaveLength(1)
  })
  it('a plan is not applied when the team changed while it was being made (a stale hybrid plan)', async () => {
    let h!: ReturnType<typeof harness>
    const complete = vi.fn(async () => {
      // The user fixes the dev role while the model call is in flight.
      h.proj = { ...h.proj, roles: h.proj.roles.map((r) => (r.slug === 'dev' ? { ...r, staffing: { mode: 'fixed' as const } } : r)) }
      return { text: '{}' }
    })
    h = harness({ complete })
    const before = structuredClone(h.proj.roles.find((r) => r.slug === 'dev'))
    const res = await h.svc.apply({ projectId: 'p1', strategy: 'hybrid' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(res.applied).toBe(false)
    expect(res.reason).toContain('the team changed while the plan was being made')
    expect(h.proj.roles.find((r) => r.slug === 'dev')?.effort).toBe(before?.effort)
    expect(h.svc.history('p1').generations).toEqual([])
  })
  it('team files waiting for approval (or with a problem) block apply, rollback and a regression rollback until they are settled', async () => {
    let state: string | undefined = 'pending'
    const h = harness({ teamFilesState: () => state })
    const before = structuredClone(h.proj)
    const blocked = await h.svc.apply({ projectId: 'p1' })
    expect(blocked.applied).toBe(false)
    expect(blocked.reason).toContain('waiting for approval')
    expect(h.proj.roles).toEqual(before.roles)
    state = undefined
    expect((await h.svc.apply({ projectId: 'p1' })).applied).toBe(true)
    state = 'problem'
    const rb = await h.svc.rollback({ projectId: 'p1' })
    expect(rb.rolledBack).toBe(false)
    expect(rb.reason).toContain('problem in the .orgai/ team files')
    // A regression waits: the trial stays open and nothing is written.
    h.setRuns([...cleanRuns(3, NOW + 10, { status: 'error', agents: [{ slug: 'dev', state: 'error' }] }), ...cleanRuns(8, 1_000_000)])
    const r = await h.svc.afterRun({ projectId: 'p1', evolve: false })
    expect(r.ratchet).toBe('none')
    expect(r.ratchetReason).toContain('regressed')
    expect(h.svc.history('p1').trialId).toBe('gen_1')
    state = undefined
    expect((await h.svc.afterRun({ projectId: 'p1', evolve: false })).ratchet).toBe('rolled_back')
    expect(h.proj.roles).toEqual(before.roles)
  })
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a failure after the team changed keeps the generation and its snapshot, and says the change was applied', async () => {
    const h = harness()
    const svc = createEvolveService({
      ...h.deps,
      updateProject: (id, fn) => {
        const out = h.deps.updateProject(id, fn)
        chmodSync(join(dir, 'evolution'), 0o500) // the ledger write after the change fails
        return out
      }
    })
    try {
      const res = await svc.apply({ projectId: 'p1' })
      expect(res.applied).toBe(true)
      expect(res.reason).toContain('a later step failed')
      expect(h.proj.roles.find((r) => r.slug === 'dev')?.effort).toBe('medium')
      expect(svc.history('p1').generations.map((g) => g.id)).toEqual(['gen_1'])
    } finally {
      chmodSync(join(dir, 'evolution'), 0o700)
    }
  })
  it('a trial still short of its window refuses with how many runs it has', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    h.setRuns([...cleanRuns(1, NOW + 10), ...cleanRuns(8, 1_000_000)])
    expect((await h.svc.apply({ projectId: 'p1' })).reason).toContain('1 of 3 finished runs')
  })
  it('does not apply below the waste threshold or with an empty plan', async () => {
    const h = harness({ runs: [run({ startedAt: 1_000_000, agents: [{ slug: 'dev', turns: 30 }] })] })
    const r = await h.svc.apply({ projectId: 'p1' })
    expect(r.applied).toBe(false)
    expect(h.state.updates).toBe(0)
    expect((await h.svc.apply({ projectId: 'p1', minWaste: 0 })).applied).toBe(false)
  })
  it('clamps the evaluation window to 1..10', async () => {
    const h = harness()
    expect((await h.svc.apply({ projectId: 'p1', evalWindowRuns: 99 })).generation?.evalWindowRuns).toBe(10)
  })
  it('restores the snapshot and drops the generation when the project update fails', async () => {
    const h = harness()
    const svc = createEvolveService({ ...h.deps, updateProject: () => { throw new Error('disk full') } })
    const r = await svc.apply({ projectId: 'p1' })
    expect(r.applied).toBe(false)
    expect(r.reason).toContain('disk full')
    expect(svc.history('p1').generations).toEqual([])
  })
  it('serialises concurrent applies per project: exactly one wins and updates never overlap', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = harness({ sync: async () => { await gate; return true } })
    const a = h.svc.apply({ projectId: 'p1' })
    const b = h.svc.apply({ projectId: 'p1' })
    release()
    const [ra, rb] = await Promise.all([a, b])
    expect([ra.applied, rb.applied].sort()).toEqual([false, true])
    expect(h.state.updates).toBe(1)
    expect(h.state.maxInFlight).toBe(1)
  })
})

describe('afterRun ratchet', () => {
  it('does nothing without a trial unless evolve is set, and needs enough runs', async () => {
    const h = harness()
    expect(await h.svc.afterRun({ projectId: 'p1', evolve: false })).toEqual({ projectId: 'p1', ratchet: 'none' })
    expect(h.state.updates).toBe(0)
    const few = harness({ runs: cleanRuns(2, 1_000_000) })
    expect((await few.svc.afterRun({ projectId: 'p1', evolve: true })).applied).toBeUndefined()
    expect(few.state.updates).toBe(0)
  })
  it('evolve: applies one generation with the deterministic strategy and never calls the model unless hybrid was asked for', async () => {
    const complete = vi.fn(async () => ({ text: '{}' }))
    const h = harness({ complete })
    const r = await h.svc.afterRun({ projectId: 'p1', evolve: true })
    expect(r.applied?.id).toBe('gen_1')
    expect(r.wasteScore).toBeGreaterThan(0)
    expect(complete).not.toHaveBeenCalled()
    // the very next run end: the trial is pending, nothing else is applied
    const next = await h.svc.afterRun({ projectId: 'p1', evolve: true })
    expect(next.ratchet).toBe('none')
    expect(next.applied).toBeUndefined()
    expect(h.state.updates).toBe(1)
  })
  it('hybrid is used only when explicitly passed', async () => {
    const complete = vi.fn(async () => ({ text: '{"rationale":"model"}' }))
    const h = harness({ complete })
    const r = await h.svc.afterRun({ projectId: 'p1', evolve: true, strategy: 'hybrid' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(r.applied?.strategy).toBe('hybrid')
  })
  it('promotes a trial that held up, and does not apply in the same pass', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    h.setRuns([...cleanRuns(3, NOW + 10), ...cleanRuns(8, 1_000_000)])
    const r = await h.svc.afterRun({ projectId: 'p1', evolve: true })
    expect(r.ratchet).toBe('promoted')
    expect(r.decided).toMatchObject({ id: 'gen_1', status: 'promoted' })
    expect(r.applied).toBeUndefined()
    expect(h.svc.history('p1')).toMatchObject({ championId: 'gen_1' })
    expect(h.svc.history('p1').trialId).toBeUndefined()
    expect(h.proj.roles.find((x) => x.slug === 'dev')?.effort).toBe('medium')
  })
  it('stays pending until the window is full', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    h.setRuns([...cleanRuns(2, NOW + 10), ...cleanRuns(8, 1_000_000)])
    const r = await h.svc.afterRun({ projectId: 'p1', evolve: true })
    expect(r.ratchet).toBe('none')
    expect(r.ratchetReason).toContain('2 of 3')
  })
  it('rolls back a regression, restores the chart, records the rejection and does not re-propose it', async () => {
    const h = harness()
    const original = structuredClone(h.proj)
    await h.svc.apply({ projectId: 'p1' })
    const bad = cleanRuns(3, NOW + 10, { status: 'error', agents: [{ slug: 'dev', state: 'error' }, { slug: 'dev', state: 'error' }] })
    h.setRuns([...bad, ...cleanRuns(8, 1_000_000)])
    const r = await h.svc.afterRun({ projectId: 'p1', evolve: true })
    expect(r.ratchet).toBe('rolled_back')
    expect(r.decided?.status).toBe('rolled_back')
    expect(h.proj.roles).toEqual(original.roles)
    const hist = h.svc.history('p1')
    expect(hist.rejectedHypotheses).toHaveLength(2) // the plan and its one patch
    expect(hist.rejectedHypotheses[0]).toMatchObject({ generationId: 'gen_1', fingerprint: r.decided?.fingerprint })
    expect(hist.trialId).toBeUndefined()
    // the same hypothesis is not proposed again
    h.setRuns(cleanRuns(8, 2_000_000))
    const a = await h.svc.analyze({ projectId: 'p1' })
    expect(a.plan.rolePatches.find((p) => p.slug === 'dev' && p.effort === 'medium')).toBeUndefined()
    expect(a.plan.empty).toBe(true)
    expect((await h.svc.apply({ projectId: 'p1' })).applied).toBe(false)
  })
  it('a rollback keeps what the user edited since and says so', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    h.proj = { ...h.proj, roles: h.proj.roles.map((r) => (r.slug === 'dev' ? { ...r, effort: 'low' as const } : r)) }
    h.setRuns([...cleanRuns(3, NOW + 10, { status: 'error', agents: [{ slug: 'dev', state: 'error' }] }), ...cleanRuns(8, 1_000_000)])
    const r = await h.svc.afterRun({ projectId: 'p1', evolve: false })
    expect(r.ratchet).toBe('rolled_back')
    expect(h.proj.roles.find((x) => x.slug === 'dev')?.effort).toBe('low')
    expect(r.decided?.outcomeReason).toContain('kept your later edit to dev.effort')
  })
  it('never throws into the caller', async () => {
    const h = harness()
    const boom = createEvolveService({ ...h.deps, listRunRecords: () => { throw new Error('store down') } })
    expect((await boom.afterRun({ projectId: 'p1', evolve: true })).ratchet).toBe('none')
    const gone = createEvolveService({ ...h.deps, getProject: () => { throw new Error('x') } })
    expect(await gone.afterRun({ projectId: 'p1', evolve: true })).toEqual({ projectId: 'p1', ratchet: 'none' })
    expect(await h.svc.afterRun({ projectId: '../bad', evolve: true })).toEqual({ projectId: '../bad', ratchet: 'none' })
    const noSync = createEvolveService({ ...h.deps, syncTeamFiles: async () => { throw new Error('ro fs') } })
    expect((await noSync.afterRun({ projectId: 'p1', evolve: true })).applied).toBeDefined()
    expect(h.log.length).toBeGreaterThanOrEqual(0)
  })
  it('a corrupt ledger starts empty and does not block', async () => {
    const h = harness()
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(join(dir, 'evolution'))
    writeFileSync(join(dir, 'evolution', 'p1.json'), '\0\0garbage')
    expect(h.svc.history('p1').generations).toEqual([])
    expect((await h.svc.apply({ projectId: 'p1' })).applied).toBe(true)
  })
})

describe('manual rollback', () => {
  it('rolls back the trial, writes a tombstone and refuses a repeat', async () => {
    const h = harness()
    const original = structuredClone(h.proj)
    await h.svc.apply({ projectId: 'p1' })
    const r = await h.svc.rollback({ projectId: 'p1', reason: 'not now' })
    expect(r).toMatchObject({ rolledBack: true, teamFilesSynced: true })
    expect(h.proj.roles).toEqual(original.roles)
    expect(h.svc.history('p1').rejectedHypotheses[0]).toMatchObject({ reason: 'not now', generationId: 'gen_1' })
    expect((await h.svc.rollback({ projectId: 'p1' })).rolledBack).toBe(false)
    expect((await h.svc.rollback({ projectId: 'p1', generationId: 'gen_9' })).reason).toContain('No generation')
  })
  it('an unusable snapshot is not reported as rolled back: nothing restored, the reason says so, the generation is closed', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    const file = join(dir, 'evolution', 'p1.json')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const led = JSON.parse(readFileSync(file, 'utf8'))
    led.generations[0].snapshot.edits[0].pre.canSpawn = true
    led.generations[0].snapshot.edits[0].post.canSpawn = false
    writeFileSync(file, JSON.stringify(led))
    const afterApply = structuredClone(h.proj)
    const r = await h.svc.rollback({ projectId: 'p1' })
    expect(r.rolledBack).toBe(false)
    expect(r.teamFilesSynced).toBe(false)
    expect(r.reason).toContain('could not be restored')
    expect(r.reason).toContain('left unchanged')
    expect(h.proj.roles).toEqual(afterApply.roles)
    expect(h.svc.history('p1').trialId).toBeUndefined()
  })
  it('a rollback that kept a later edit of the user says what was not restored', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    h.proj = { ...h.proj, roles: h.proj.roles.map((r) => (r.slug === 'dev' ? { ...r, effort: 'low' as const } : r)) }
    const r = await h.svc.rollback({ projectId: 'p1' })
    expect(r.rolledBack).toBe(true)
    expect(r.reason).toContain('kept your later edit to dev.effort')
    expect(h.proj.roles.find((x) => x.slug === 'dev')?.effort).toBe('low')
  })
  it('a clean rollback carries no reason', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    expect((await h.svc.rollback({ projectId: 'p1' })).reason).toBeUndefined()
  })
  it('defaults to the newest promoted generation when no trial is active', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    h.setRuns([...cleanRuns(3, NOW + 10), ...cleanRuns(8, 1_000_000)])
    await h.svc.afterRun({ projectId: 'p1', evolve: false })
    const r = await h.svc.rollback({ projectId: 'p1' })
    expect(r.generation?.id).toBe('gen_1')
    expect(h.proj.roles.find((x) => x.slug === 'dev')?.effort).toBe('high')
  })
})

describe('skills', () => {
  const goodSkill = { name: 'run-tests', description: 'When tests must run', body: 'Run npm test and read failures.', grantTo: ['dev', 'lead'], reason: 'r' }
  const modelAnswer = JSON.stringify({ newSkills: [goodSkill], pruneSkillIds: ['s_old'] })
  const withOld = (): Project => project({ skills: [{ id: 's_old', name: 'old', description: 'd' } as SkillSpec] }, [role('lead', { id: 'r_lead', reportsTo: null }), role('dev', { tier: 'deep', model: 'deep', effort: 'high', skills: ['s_old'] }), role('review', { tools: ['Read'] })])
  const never = () => [{ id: 'n', kind: 'neverLoaded' as const, severity: 'info' as const, skillIds: ['s_old'], title: '', detail: '' }]

  it('adds skills DISABLED, only for non-root non-review roles; reports a skill removal without applying it; a rollback undoes the addition', async () => {
    const h = harness({ proj: withOld(), skills: true, skillFindings: never, complete: async () => ({ text: modelAnswer }) })
    const res = await h.svc.apply({ projectId: 'p1', strategy: 'hybrid' })
    expect(res.applied).toBe(true)
    expect(h.disabled).toEqual(['sk_run-tests'])
    // The unused skill stays: its folder may hold more than a snapshot can restore, so removing it is the user's call.
    expect(h.proj.skills?.map((s) => s.name)).toEqual(['old', 'run-tests'])
    expect(res.plan.pruneSkillIds).toEqual([])
    expect(res.plan.gate.violations.some((v) => v.rule === 'skill_prune_needs_review' && v.message.includes('s_old'))).toBe(true)
    expect(h.skills.remove).not.toHaveBeenCalled()
    // Taking the unused grant off a role is applied (a rollback restores the grant).
    expect(h.proj.roles.find((r) => r.slug === 'dev')?.skills).toEqual(['sk_run-tests'])
    expect(h.proj.roles.find((r) => r.slug === 'lead')?.skills).toBeUndefined()
    const rb = await h.svc.rollback({ projectId: 'p1' })
    expect(rb.rolledBack).toBe(true)
    expect(h.proj.skills?.map((s) => s.name)).toEqual(['old'])
    expect(h.proj.roles.find((r) => r.slug === 'dev')?.effort).toBe('high')
  })
  it('a rollback undoes skill changes only as far as the plan made them (entries added to the snapshot later are ignored)', async () => {
    const h = harness({ proj: withOld(), skills: true })
    expect((await h.svc.apply({ projectId: 'p1' })).applied).toBe(true)
    const file = join(dir, 'evolution', 'p1.json')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const led = JSON.parse(readFileSync(file, 'utf8'))
    led.generations[0].snapshot.prunedSkills = [{ name: 'injected', description: 'd', body: 'b', roleIds: ['r_lead'] }]
    led.generations[0].snapshot.addedSkillIds = ['s_old']
    writeFileSync(file, JSON.stringify(led))
    const rb = await h.svc.rollback({ projectId: 'p1' })
    expect(rb.rolledBack).toBe(true)
    expect(h.skills.create).not.toHaveBeenCalled()
    expect(h.skills.remove).not.toHaveBeenCalled()
    expect(h.proj.skills?.map((s) => s.name)).toEqual(['old'])
  })
  it('without a setEnabled port new skills are not applied, only reported', async () => {
    const h = harness({ proj: withOld(), skills: 'no-enable', skillFindings: never, complete: async () => ({ text: modelAnswer }) })
    const res = await h.svc.apply({ projectId: 'p1', strategy: 'hybrid' })
    expect(res.plan.newSkills).toEqual([])
    expect(res.plan.gate.violations.some((v) => v.rule === 'skill_needs_review')).toBe(true)
    expect(h.created).toEqual([])
  })
  it('drops skill changes when the host has no skills port', async () => {
    const h = harness({ proj: withOld(), skillFindings: never, complete: async () => ({ text: modelAnswer }) })
    const res = await h.svc.apply({ projectId: 'p1', strategy: 'hybrid' })
    expect(res.plan.newSkills).toEqual([])
    expect(res.plan.pruneSkillIds).toEqual([])
    expect(h.proj.skills?.map((s) => s.name)).toEqual(['old'])
  })
  it('a pruned skill needs a finding, even from the model', async () => {
    const h = harness({ proj: withOld(), skills: true, complete: async () => ({ text: JSON.stringify({ pruneSkillIds: ['s_old'] }) }) })
    const res = await h.svc.apply({ projectId: 'p1', strategy: 'hybrid' })
    expect(res.plan.pruneSkillIds).toEqual([])
    expect(h.proj.skills?.map((s) => s.name)).toEqual(['old'])
  })
})

describe('unusable snapshots and cooldown', () => {
  it('an unusable snapshot still closes the trial, leaves the project unchanged and never throws from afterRun', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    const file = join(dir, 'evolution', 'p1.json')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const led = JSON.parse(readFileSync(file, 'utf8'))
    led.generations[0].snapshot.edits[0].pre.canSpawn = true
    led.generations[0].snapshot.edits[0].post.canSpawn = false
    writeFileSync(file, JSON.stringify(led))
    const afterApply = structuredClone(h.proj)
    h.setRuns([...cleanRuns(3, NOW + 10, { status: 'error', agents: [{ slug: 'dev', state: 'error' }] }), ...cleanRuns(8, 1_000_000)])
    const r = await h.svc.afterRun({ projectId: 'p1', evolve: true })
    expect(r.ratchet).toBe('rolled_back')
    expect(r.decided?.outcomeReason).toContain('snapshot was unusable')
    expect(h.proj.roles).toEqual(afterApply.roles)
    expect(h.svc.history('p1').trialId).toBeUndefined()
  })
  it('a malformed generation entry in the ledger cannot wedge afterRun', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    const file = join(dir, 'evolution', 'p1.json')
    const { readFileSync, writeFileSync } = await import('node:fs')
    const led = JSON.parse(readFileSync(file, 'utf8'))
    led.generations[0].snapshot = { edits: 7 }
    led.generations[0].plan.rolePatches = 'x'
    writeFileSync(file, JSON.stringify(led))
    h.setRuns([...cleanRuns(3, NOW + 10, { status: 'error', agents: [{ slug: 'dev', state: 'error' }] }), ...cleanRuns(8, 1_000_000)])
    await expect(h.svc.afterRun({ projectId: 'p1', evolve: true })).resolves.toBeDefined()
    expect(h.svc.history('p1').trialId).toBeUndefined()
  })
  it('does not patch a role changed in either of the last two decided generations, until the cooldown expires', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    h.setRuns([...cleanRuns(3, NOW + 10), ...cleanRuns(8, 1_000_000)])
    await h.svc.afterRun({ projectId: 'p1', evolve: false }) // promoted gen_1 (dev effort high to medium) at NOW
    h.proj = { ...h.proj, roles: h.proj.roles.map((r) => (r.slug === 'dev' ? { ...r, effort: 'high' as const } : r)) }
    // 3 runs finished since the decision (the trial's own): still cooling
    const patched = async () => (await h.svc.analyze({ projectId: 'p1' })).plan
    h.setRuns([...cleanRuns(3, NOW + 10), ...cleanRuns(8, 1_000_000)])
    const cooling = await patched()
    expect(cooling.rolePatches.find((p) => p.slug === 'dev')).toBeUndefined()
    expect(cooling.gate.violations.some((v) => v.rule === 'role_cooldown')).toBe(true)
    // 4 measured runs since: still cooling (needs 5)
    h.setRuns([...cleanRuns(4, NOW + 10), ...cleanRuns(8, 1_000_000)])
    expect((await patched()).rolePatches.find((p) => p.slug === 'dev')).toBeUndefined()
    // 5 measured runs since the decision: the cooldown has expired
    h.setRuns([...cleanRuns(5, NOW + 10), ...cleanRuns(8, 1_000_000)])
    expect((await patched()).rolePatches.find((p) => p.slug === 'dev')).toMatchObject({ effort: 'medium' })
  })
  it('without usable run records the cooldown expires 7 days after the decision', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    h.setRuns([...cleanRuns(3, NOW + 10), ...cleanRuns(8, 1_000_000)])
    await h.svc.afterRun({ projectId: 'p1', evolve: false })
    expect(cooldownOf(h.svcLedger(), [], NOW + 6 * 24 * 3_600_000)).toEqual(['dev'])
    expect(cooldownOf(h.svcLedger(), [], NOW + 7 * 24 * 3_600_000 + 1)).toEqual([])
    expect(cooldownOf(h.svcLedger(), cleanRuns(4, NOW + 10), NOW + 30 * 24 * 3_600_000)).toEqual(['dev']) // counts available: counts rule
  })
})

describe('spend raises need the person (review H1)', () => {
  /** dev on everyday / medium that fails half its assignments: the plan raises its tier one step. */
  const underProject = (): Project =>
    project({}, [
      role('lead', { id: 'r_lead', reportsTo: null, canSpawn: true, spawnable: ['r_dev'], tier: 'deep', model: 'deep' }),
      role('dev', { id: 'r_dev', name: 'Developer', tools: ['Read', 'Edit', 'Write', 'Bash'], tier: 'everyday', model: 'everyday', effort: 'medium' }),
      role('review', { id: 'r_review', name: 'Reviewer', tools: ['Read', 'Grep'] })
    ])
  const failingRuns = (n: number, t0: number): RunRecord[] =>
    Array.from({ length: n }, (_, i) => run({ startedAt: t0 + i * 1000, agents: [{ slug: 'dev', state: 'error', turns: 3 }, { slug: 'dev', turns: 3 }, { slug: 'dev', state: 'error', turns: 3 }], assignments: [{ tier: 'everyday' }, { tier: 'everyday' }, { tier: 'everyday' }] }))
  const devOf = (p: Project) => p.roles.find((r) => r.slug === 'dev')!

  it('the analysis lists the raise; an unattended post-run pass holds it, reports it and changes nothing that spends more', async () => {
    const h = harness({ proj: underProject(), runs: failingRuns(6, 1_000_000) })
    const before = structuredClone(devOf(h.proj))
    const a = await h.svc.analyze({ projectId: 'p1' })
    expect(a.plan.spendRaises?.some((r) => r.roleSlug === 'dev')).toBe(true)
    const r = await h.svc.afterRun({ projectId: 'p1', evolve: true })
    expect(r.heldSpendRaises?.some((x) => x.roleSlug === 'dev')).toBe(true)
    const dev = devOf(h.proj)
    expect([dev.tier, dev.model, dev.effort, dev.staffing]).toEqual([before.tier, before.model, before.effort, before.staffing])
    // Whatever was applied, if anything, holds no sizing change for dev.
    for (const g of h.svc.history('p1').generations) {
      const p = g.plan.rolePatches.find((x) => x.slug === 'dev')
      expect([p?.tier, p?.effort, p?.staffing]).toEqual([undefined, undefined, undefined])
    }
  })
  it('an apply without allowSpendRaise holds the raise and reports it as spend_held', async () => {
    const h = harness({ proj: underProject(), runs: failingRuns(6, 1_000_000) })
    const before = structuredClone(devOf(h.proj))
    const res = await h.svc.apply({ projectId: 'p1' })
    expect(res.heldSpendRaises?.some((x) => x.roleSlug === 'dev')).toBe(true)
    expect(res.plan.gate.violations.some((v) => v.rule === 'spend_held' && v.roleSlug === 'dev')).toBe(true)
    expect(devOf(h.proj).staffing).toEqual(before.staffing)
    expect(devOf(h.proj).tier).toBe('everyday')
  })
  it('allowSpendRaise without a fingerprint is refused and writes nothing', async () => {
    const h = harness({ proj: underProject(), runs: failingRuns(6, 1_000_000) })
    const res = await h.svc.apply({ projectId: 'p1', allowSpendRaise: true })
    expect(res.applied).toBe(false)
    expect(res.reason).toContain('fingerprint')
    expect(h.state.updates).toBe(0)
    expect(h.svc.history('p1').generations).toEqual([])
  })
  it('a fingerprint that does not match the plan built at apply time is refused, with or without allowSpendRaise', async () => {
    const h = harness({ proj: underProject(), runs: failingRuns(6, 1_000_000) })
    for (const allow of [false, true]) {
      const res = await h.svc.apply({ projectId: 'p1', expectedFingerprint: 'deadbeefdeadbeef', allowSpendRaise: allow })
      expect(res.applied).toBe(false)
      expect(res.reason).toContain('changed since it was reviewed')
    }
    expect(h.state.updates).toBe(0)
    expect(h.svc.history('p1').generations).toEqual([])
  })
  it('the reviewed plan with allowSpendRaise applies the raise', async () => {
    const h = harness({ proj: underProject(), runs: failingRuns(6, 1_000_000) })
    const a = await h.svc.analyze({ projectId: 'p1' })
    const res = await h.svc.apply({ projectId: 'p1', expectedFingerprint: a.plan.fingerprint, allowSpendRaise: true })
    expect(res.applied).toBe(true)
    expect(res.heldSpendRaises).toBeUndefined()
    const patch = a.plan.rolePatches.find((p) => p.slug === 'dev')
    expect(patch?.tier ?? patch?.effort ?? patch?.staffing).toBeDefined()
    if (patch?.staffing) expect(devOf(h.proj).staffing).toEqual(patch.staffing)
    if (patch?.tier) expect(devOf(h.proj).tier).toBe(patch.tier)
    expect(res.generation?.fingerprint).toBe(a.plan.fingerprint)
  })
  it('the reviewed plan without allowSpendRaise lands only what does not raise spend', async () => {
    const h = harness({ proj: underProject(), runs: failingRuns(6, 1_000_000) })
    const before = structuredClone(devOf(h.proj))
    const a = await h.svc.analyze({ projectId: 'p1' })
    const res = await h.svc.apply({ projectId: 'p1', expectedFingerprint: a.plan.fingerprint })
    expect([devOf(h.proj).tier, devOf(h.proj).staffing]).toEqual([before.tier, before.staffing])
    expect(res.heldSpendRaises?.length).toBeGreaterThan(0)
  })
  it('a reviewed hybrid plan is applied without a second model call; without one the apply refuses and calls nothing', async () => {
    const complete = vi.fn(async () => ({ text: '{"rationale":"ok"}', usage: { inputTokens: 10, outputTokens: 2 } }))
    const h = harness({ complete })
    const a = await h.svc.analyze({ projectId: 'p1', strategy: 'hybrid' })
    expect(complete).toHaveBeenCalledTimes(1)
    // Another service instance (another process) never saw that analysis: it refuses and makes no model call.
    const other = createEvolveService(h.deps)
    const missing = await other.apply({ projectId: 'p1', strategy: 'hybrid', expectedFingerprint: a.plan.fingerprint })
    expect(missing.applied).toBe(false)
    expect(missing.reason).toContain('no longer available')
    expect(complete).toHaveBeenCalledTimes(1)
    expect(h.state.updates).toBe(0)
    const res = await h.svc.apply({ projectId: 'p1', strategy: 'hybrid', expectedFingerprint: a.plan.fingerprint })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(res.applied).toBe(true)
    expect(res.generation?.fingerprint).toBe(a.plan.fingerprint)
  })
})

describe('run loading (review M: synchronous records)', () => {
  it('one post-run pass lists the records at most once', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    h.setRuns([...cleanRuns(3, NOW + 10), ...cleanRuns(8, 1_000_000)])
    h.state.listCalls = 0
    await h.svc.afterRun({ projectId: 'p1', evolve: true })
    expect(h.state.listCalls).toBeLessThanOrEqual(1)
  })
  it('with summaries and single-record ports, a pending trial loads no full record and a full window loads only its runs', async () => {
    const h = harness()
    await h.svc.apply({ projectId: 'p1' })
    let runs = cleanRuns(8, 1_000_000)
    const listRunRecords = vi.fn(() => runs)
    const getRunRecord = vi.fn((id: string) => runs.find((r) => r.summary.id === id))
    const svc = createEvolveService({ ...h.deps, listRunRecords, getRunRecord, listRunSummaries: () => runs.map((r) => r.summary) })
    runs = [...cleanRuns(1, NOW + 10), ...runs]
    expect((await svc.afterRun({ projectId: 'p1', evolve: false })).ratchetReason).toContain('1 of 3')
    expect(listRunRecords).not.toHaveBeenCalled()
    expect(getRunRecord).not.toHaveBeenCalled()
    runs = [...cleanRuns(3, NOW + 10_000), ...runs]
    expect((await svc.afterRun({ projectId: 'p1', evolve: false })).ratchet).toBe('promoted')
    expect(listRunRecords).not.toHaveBeenCalled()
    expect(getRunRecord).toHaveBeenCalledTimes(3)
  })
  it('analyze and history never move a corrupt ledger file aside', async () => {
    const h = harness()
    const { mkdirSync, writeFileSync, readdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'evolution'), { recursive: true })
    writeFileSync(join(dir, 'evolution', 'p1.json'), '{not json')
    await h.svc.analyze({ projectId: 'p1' })
    h.svc.history('p1')
    expect(readdirSync(join(dir, 'evolution'))).toEqual(['p1.json'])
  })
})
