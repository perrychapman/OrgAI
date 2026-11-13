import type {
  EvolveAnalyzeInput,
  EvolveAnalyzeResult,
  EvolveApplyInput,
  EvolveApplyResult,
  EvolveRollbackInput,
  EvolveRollbackResult,
  EvolvePostRunResult,
  EvolutionHistory,
  EvolveStrategy,
  EvolutionGeneration,
  EvolutionPlan,
  EvolutionSpendRaise,
  Project,
  RunRecord,
  RunSummary,
  TeamEvolutionDiagnosis,
  SkillCreateInput,
  SkillFinding,
  SkillMutationResult,
  StaffingGoal,
  StaffingMode
} from '../../shared/types'
import { MIN_WASTE_DEFAULT, applyPlan, effectiveConcurrency, patchFingerprint, planSummary } from './plan'
import {
  addRejected,
  chartProblems,
  clampWindow,
  evaluateActiveTrial,
  isValidProjectId,
  nextGenerationId,
  readLedger,
  restoreSnapshot,
  snapshotOf,
  toHistory,
  trialOf,
  validateEvolutionPlan,
  writeLedger,
  type GateOptions,
  type Ledger,
  type StoredGeneration
} from './ratchet'
import { draftProblem } from '../skills/skillMd'
import { holdSpendRaises, spendRaisesOf } from './spend'
import { buildDigest, synthesize } from './synthesizer'
import { diagnose, isMeasuredRun } from './telemetry'

export interface EvolveAfterRunInput {
  projectId: string
  evolve: boolean
  strategy?: EvolveStrategy
  goal?: StaffingGoal
  minWaste?: number
  evalWindowRuns?: number
}

/** The single hybrid completion request. Mirrors RuntimeAdapter.complete's CompletionInput (kind 'draft'). */
export interface EvolveCompleteRequest {
  system: string
  prompt: string
  /** Always 'medium'. Adapters that cannot set effort ignore it. */
  effort: 'medium'
  /** Aborted when the engine's timeout fires. */
  signal?: AbortSignal
}

export interface EvolveCompleteResult {
  text: string
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number }
}

/**
 * Narrow structural ports. The host satisfies them from its stores; the engine imports no Electron and no store class.
 */
export interface EvolveServiceDeps {
  /** Data folder; the ledger lives at `<dataDir>/evolution/<projectId>.json`. */
  dataDir: string
  /** The saved project, or undefined when unknown. */
  getProject(id: string): Project | undefined
  /** Read-modify-write the project through the store's save (so cleaning and persistence apply). Returns the saved project. */
  updateProject(id: string, fn: (p: Project) => Project): Project
  /**
   * The project's team-files state (TeamFilesState), read before the team is written. 'pending' (the .orgai/ files hold
   * changes waiting for approval) and 'problem' block apply and rollback: the save would merge over what the user is
   * still deciding. Missing = no team files to wait for.
   */
  teamFilesState?(projectId: string): string | undefined
  /**
   * Finished work-run records of the project, NEWEST FIRST, at most `limit` (the engine asks for 50 at most). Quick runs
   * and setup runs may be included; the engine filters. Records as stored (plan, staffing, agents, transcript).
   */
  listRunRecords(projectId: string, limit: number): RunRecord[]
  /**
   * Measured run SUMMARIES of the project, newest first, at most `limit` (cheap: no transcript is read). With
   * getRunRecord, the engine counts runs and finds a trial's window from these and loads only the records it measures.
   * Absent = listRunRecords is used for counting too.
   */
  listRunSummaries?(projectId: string, limit: number): RunSummary[]
  /** One stored record by run id (undefined when missing). Used with listRunSummaries. */
  getRunRecord?(runId: string): RunRecord | undefined
  /** The project's staffing profile (Project.staffing and staffingGoal as defaults.ts reads them). Default auto / balanced. */
  staffingProfile?(projectId: string): { mode: StaffingMode; goal: StaffingGoal }
  /** Deterministic skill findings (src/main/skills/evaluate.ts evaluateSkills quality + gaps) for the project. Absent = none. */
  skillFindings?(projectId: string): SkillFinding[]
  /** SkillService ports. Absent = skill changes (new skills, pruning) are dropped from plans. */
  skills?: {
    create(input: SkillCreateInput): SkillMutationResult
    remove(input: { projectId: string; skillId: string }): SkillMutationResult
    /** The SKILL.md body of a project-owned skill, so a pruned skill can be restored on rollback. Null = cannot restore (then it is not pruned). */
    /** Switch a project skill on or off (SkillService.update({ enabled })). Without it new skills are not applied: they are only reported. */
    setEnabled?(projectId: string, skillId: string, enabled: boolean): void
    readDraft(projectId: string, skillId: string): { name: string; description: string; body: string } | null
  }
  /** Write `.orgai/` team files after a change. Resolves true when files were written. Absent = false. */
  syncTeamFiles?(project: Project): Promise<boolean>
  /** The single hybrid call. Absent, rejecting, slow or unparseable = the deterministic plan. */
  complete?(req: EvolveCompleteRequest): Promise<EvolveCompleteResult>
  /**
   * Told the hybrid call's usage. The engine also copies it into plan.usage (returned by analyze / apply and kept in the
   * generation in the ledger). No app-wide ledger of helper calls exists, so it is not on the Usage page (which reads
   * run records); the host logs it.
   */
  onUsage?(usage: { inputTokens: number; outputTokens: number; costUsd?: number }): void
  now?(): number
  log?(level: 'info' | 'warn', message: string): void
}

export interface EvolveService {
  analyze(input: EvolveAnalyzeInput): Promise<EvolveAnalyzeResult>
  apply(input: EvolveApplyInput): Promise<EvolveApplyResult>
  history(projectId: string): EvolutionHistory
  rollback(input: EvolveRollbackInput): Promise<EvolveRollbackResult>
  /** Post-run ratchet: evaluate an active trial (promote / roll back); when `evolve` and no trial is active and wasteScore >= threshold, apply a new generation. Never starts a run. */
  afterRun(input: EvolveAfterRunInput): Promise<EvolvePostRunResult>
}

/** Fewest measured runs an unattended apply needs. */
export const MIN_RUNS_FOR_APPLY = 3

/** A role stays in cooldown after a decision until this many measured runs have finished since it. */
export const COOLDOWN_RUNS = 5
/** Without usable run records the cooldown ends this long after the decision. */
export const COOLDOWN_MS = 7 * 24 * 3_600_000

/**
 * Roles patched in either of the last two decided (promoted or rolled back) generations, while that generation is still
 * recent: fewer than COOLDOWN_RUNS measured runs have finished since it was decided; when no run records are available
 * (nothing to count), COOLDOWN_MS after the decision. Each generation expires on its own.
 */
export function cooldownOf(l: Ledger, records: readonly Pick<RunRecord, 'summary'>[], nowMs: number): string[] {
  const measured = newestMeasured(records)
  const slugs = new Set<string>()
  for (const g of l.generations.filter((x) => x.status !== 'trial').slice(-2)) {
    const at = typeof g.decidedAt === 'number' ? g.decidedAt : g.appliedAt
    const since = measured.filter((r) => (r.summary.endedAt ?? r.summary.startedAt) > at).length
    const cooling = measured.length ? since < COOLDOWN_RUNS : nowMs - at < COOLDOWN_MS
    if (!cooling) continue
    for (const p of Array.isArray(g.plan?.rolePatches) ? g.plan.rolePatches : []) slugs.add(p.slug)
  }
  return [...slugs]
}

/** The newest `max` measured runs (telemetry.measuredRuns' rule), newest first; summaries are enough. */
function newestMeasured<T extends Pick<RunRecord, 'summary'>>(runs: readonly T[], max = 50): T[] {
  return runs
    .filter(isMeasuredRun)
    .sort((a, b) => b.summary.startedAt - a.summary.startedAt)
    .slice(0, max)
}

/** A hybrid plan analyze made is reusable by an apply naming its fingerprint for this long. */
export const REVIEWED_PLAN_TTL_MS = 30 * 60_000
/** Reviewed hybrid plans kept per project. */
const REVIEWED_PLANS_KEPT = 4

/**
 * The runs one operation reads, loaded at most once per operation (one post-run pass, apply or rollback): summaries for
 * counting and finding a trial's window, full records only for the runs measured.
 */
interface RunSource {
  /** Measured runs (summary only), newest first, at most 50. */
  summaries(): Pick<RunRecord, 'summary'>[]
  /** Full records of the newest `n` measured runs. */
  records(n: number): RunRecord[]
  /** Full records of these runs (missing ones left out). */
  byIds(ids: readonly string[]): RunRecord[]
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const pub = (g: StoredGeneration): EvolutionGeneration => {
  const { snapshot: _snapshot, ...rest } = g
  return rest
}

/** What a plan reads and changes of a project: the roles, the staffing mode and goal, the concurrency limit and the skills. */
const teamKey = (p: Project): string =>
  JSON.stringify([p.roles, p.staffing ?? null, p.staffingGoal ?? null, p.maxConcurrentSubagents ?? null, (p.skills ?? []).map((s) => s.id)])

export function createEvolveService(deps: EvolveServiceDeps): EvolveService {
  const now = deps.now ?? Date.now
  const log = (level: 'info' | 'warn', m: string): void => {
    try {
      deps.log?.(level, m)
    } catch {
      // logging never breaks the engine
    }
  }
  const chains = new Map<string, Promise<unknown>>()
  /** One operation at a time per project: applies, rollbacks and post-run passes never interleave. */
  const serial = <T>(projectId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(projectId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    chains.set(projectId, tail)
    void tail.then(() => {
      if (chains.get(projectId) === tail) chains.delete(projectId)
    })
    return run
  }

  const projectOf = (id: string): Project => {
    if (!isValidProjectId(id)) throw new Error('Invalid project id')
    const p = deps.getProject(id)
    if (!p) throw new Error('Project not found')
    return p
  }
  const ledgerOf = (id: string): Ledger => readLedger(deps.dataDir, id, now, log)
  /** Read paths (analyze, history) never move or write the ledger file. */
  const ledgerForRead = (id: string): Ledger => readLedger(deps.dataDir, id, now, log, { readOnly: true })
  const tryRead = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch (e) {
      log('warn', `Evolution could not read runs: ${e instanceof Error ? e.message : String(e)}`)
      return fallback
    }
  }
  /** One operation's runs, each kind loaded at most once (see RunSource). */
  const runSource = (id: string): RunSource => {
    let recs: RunRecord[] | undefined
    let recLimit = 0
    let sums: Pick<RunRecord, 'summary'>[] | undefined
    const loadRecords = (n: number): RunRecord[] => {
      const want = Math.min(50, Math.max(1, Math.floor(n)))
      // Reloaded only when more are wanted than were asked for and the store had that many to give.
      if (!recs || (want > recLimit && recs.length >= recLimit)) {
        recs = tryRead(() => deps.listRunRecords(id, want), [] as RunRecord[])
        recLimit = want
      }
      return newestMeasured(recs, want)
    }
    const cheap = !!deps.listRunSummaries && !!deps.getRunRecord
    return {
      summaries() {
        if (!sums) sums = cheap ? newestMeasured(tryRead(() => deps.listRunSummaries!(id, 50), [] as RunSummary[]).map((summary) => ({ summary }))) : loadRecords(50)
        return sums
      },
      records: loadRecords,
      byIds(ids) {
        if (!cheap) {
          const want = new Set(ids)
          return loadRecords(50).filter((r) => want.has(r.summary.id))
        }
        const out: RunRecord[] = []
        for (const runId of ids) {
          const hit = recs?.find((r) => r.summary.id === runId) ?? tryRead(() => deps.getRunRecord!(runId), undefined)
          if (hit) out.push(hit)
        }
        return out
      }
    }
  }
  const measuredCount = (src: RunSource): number => src.summaries().length
  /** Hybrid plans analyze made, per project (newest last), so an apply of the reviewed plan makes no second model call. */
  const reviewed = new Map<string, { plan: EvolutionPlan; key: string; at: number }[]>()
  const remember = (project: Project, plan: EvolutionPlan): void => {
    const list = (reviewed.get(project.id) ?? []).filter((e) => now() - e.at < REVIEWED_PLAN_TTL_MS && e.plan.fingerprint !== plan.fingerprint)
    list.push({ plan: structuredClone(plan), key: teamKey(project), at: now() })
    reviewed.set(project.id, list.slice(-REVIEWED_PLANS_KEPT))
  }
  const recall = (project: Project, fingerprint: string): EvolutionPlan | undefined => {
    const hit = (reviewed.get(project.id) ?? []).find((e) => e.plan.fingerprint === fingerprint && e.key === teamKey(project) && now() - e.at < REVIEWED_PLAN_TTL_MS)
    return hit ? structuredClone(hit.plan) : undefined
  }
  const sync = async (p: Project): Promise<boolean> => {
    try {
      return (await deps.syncTeamFiles?.(p)) === true
    } catch (e) {
      log('warn', `Evolution could not write team files: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  /** Diagnose and synthesize. Hybrid only when asked for; skill changes the host cannot make are dropped. */
  /** The diagnosis of the newest runs and the safety gate's options a plan is checked with. Deterministic, no model call. */
  function gateFor(project: Project, input: EvolveAnalyzeInput, ledger: Ledger, src: RunSource): { diagnosis: TeamEvolutionDiagnosis; gate: GateOptions & { diagnosis: TeamEvolutionDiagnosis; cooldownSlugs: string[] } } {
    const profile = deps.staffingProfile?.(project.id)
    let findings: SkillFinding[] = []
    try {
      findings = deps.skillFindings?.(project.id) ?? []
    } catch {
      findings = []
    }
    const records = src.records(Math.min(50, Math.max(1, Math.floor(input.runs ?? 10))))
    const diagnosis = diagnose({ project, runs: records, staffingProfile: profile, skillFindings: findings, goal: input.goal, now: now(), maxRuns: input.runs ?? 10 })
    const cooldownSlugs = cooldownOf(ledger, src.summaries(), now())
    return { diagnosis, gate: { rejected: ledger.rejectedHypotheses, diagnosis, cooldownSlugs } }
  }

  /** Diagnose and synthesize. Hybrid only when asked for; skill changes the host cannot make are dropped. */
  async function planFor(project: Project, input: EvolveAnalyzeInput, ledger: Ledger, strategy: EvolveStrategy, src: RunSource) {
    const { diagnosis, gate } = gateFor(project, input, ledger, src)
    const { cooldownSlugs } = gate
    const minWaste = typeof input.minWaste === 'number' && Number.isFinite(input.minWaste) ? Math.min(100, Math.max(0, input.minWaste)) : MIN_WASTE_DEFAULT
    let plan = await synthesize({ project, diagnosis, strategy, rejected: ledger.rejectedHypotheses, minWaste, complete: deps.complete, onUsage: deps.onUsage, cooldownSlugs })
    // Deleting a project skill is reported, never applied: a skill's folder can hold more than SKILL.md (scripts,
    // references) and an enabled flag, which a generation's snapshot does not keep, so a rollback could not put it back
    // as it was. Removing it stays the user's call.
    if (plan.pruneSkillIds.length) {
      const dropped = plan.pruneSkillIds
      plan = validateEvolutionPlan(project, { ...plan, pruneSkillIds: [] }, gate)
      plan.gate.violations.push({ rule: 'skill_prune_needs_review', message: `Unused skills not removed (remove them yourself if you agree): ${dropped.join(', ').slice(0, 160)}`, action: 'trimmed' })
    }
    // New skills are always created DISABLED (the skills service has an `enabled` flag, so a person turns one on after
    // reading it). Without the setEnabled port they cannot be made safe, so they are dropped and only reported.
    if (plan.newSkills.length && !deps.skills?.setEnabled) {
      const dropped = plan.newSkills.map((s) => s.name)
      plan = validateEvolutionPlan(project, { ...plan, newSkills: [] }, gate)
      plan.gate.violations.push({ rule: 'skill_needs_review', message: `Suggested skills not applied (they need review): ${dropped.join(', ').slice(0, 160)}`, action: 'trimmed' })
    }
    return { diagnosis, plan, minWaste, gate }
  }

  async function analyze(input: EvolveAnalyzeInput): Promise<EvolveAnalyzeResult> {
    const project = projectOf(input.projectId)
    const ledger = ledgerForRead(project.id)
    const strategy = input.strategy ?? 'deterministic'
    const { diagnosis, plan } = await planFor(project, input, ledger, strategy, runSource(project.id))
    plan.spendRaises = spendRaisesOf(project, plan)
    if (strategy === 'hybrid' && plan.gate.ok && !plan.empty) remember(project, plan)
    return { diagnosis, plan, digest: buildDigest(project, diagnosis, ledger.rejectedHypotheses) }
  }

  /** Why the team cannot be written now (team files waiting for approval, or a problem), else undefined. */
  function teamFilesBusy(projectId: string): string | undefined {
    let state: string | undefined
    try {
      state = deps.teamFilesState?.(projectId)
    } catch {
      state = undefined
    }
    if (state === 'pending') return 'the changes waiting for approval in the .orgai/ team files are approved or rejected'
    if (state === 'problem') return 'the problem in the .orgai/ team files is fixed'
    return undefined
  }

  async function applyCore(input: EvolveApplyInput, src: RunSource = runSource(input.projectId)): Promise<EvolveApplyResult> {
    let project = projectOf(input.projectId)
    const ledger = ledgerOf(project.id)
    // A trial whose window filled through ordinary runs (none started with evolve) is decided here, so it can never
    // block a later apply for good and a regression is still rolled back.
    const open = trialOf(ledger)
    const settled = open ? await settleTrial(project, ledger, open, src) : undefined
    if (settled && settled.state !== 'pending' && settled.state !== 'held') project = projectOf(input.projectId)
    const trial = settled?.state === 'pending' || settled?.state === 'held' ? open : undefined
    // A trial in flight or just rolled back: report why, with a cheap deterministic plan (never a model call) for display.
    const hold = trial !== undefined || settled?.state === 'rolled_back'
    const strategy: EvolveStrategy = hold ? 'deterministic' : (input.strategy ?? 'deterministic')
    const expected = typeof input.expectedFingerprint === 'string' ? input.expectedFingerprint : undefined
    // Applying a reviewed hybrid plan reuses the plan this host's analysis made (re-checked by the gate below), never a
    // second model call whose answer the person has not seen.
    let diagnosis: TeamEvolutionDiagnosis
    let plan: EvolutionPlan
    let gate: GateOptions
    let missingReviewed = false
    if (strategy === 'hybrid' && expected !== undefined) {
      const g = gateFor(project, input, ledger, src)
      diagnosis = g.diagnosis
      gate = g.gate
      const kept = recall(project, expected)
      if (kept) {
        const carried = kept.gate.violations.filter((v) => v.rule === 'skill_prune_needs_review' || v.rule === 'skill_needs_review')
        plan = validateEvolutionPlan(project, kept, gate)
        plan.gate.violations.push(...carried)
      } else {
        missingReviewed = true
        plan = validateEvolutionPlan(project, { strategy: 'hybrid', fingerprint: '', rolePatches: [], newSkills: [], pruneSkillIds: [], rationale: '', expectedImpact: {}, gate: { ok: true, violations: [] }, promptChars: { before: 0, after: 0, limit: 0 }, empty: true }, gate)
      }
    } else {
      const made = await planFor(project, input, ledger, strategy, src)
      diagnosis = made.diagnosis
      plan = made.plan
      gate = made.gate
    }
    plan.spendRaises = spendRaisesOf(project, plan)
    let held: EvolutionSpendRaise[] = []
    const refuse = (reason: string): EvolveApplyResult => ({ applied: false, reason, project, diagnosis, plan, teamFilesSynced: false, ...(held.length ? { heldSpendRaises: held } : {}) })
    if (trial && settled?.state === 'pending') return refuse(`Generation ${trial.id} is still on trial; it has ${settled.have} of ${settled.need} finished runs it needs before another change.`)
    if (trial && settled?.state === 'held') return refuse(`Nothing was applied: ${settled.reason}.`)
    const busy = teamFilesBusy(project.id)
    if (busy) return refuse(`Nothing was applied; run evolve again once ${busy}.`)
    if (open && settled?.state === 'rolled_back') return { ...refuse(`Generation ${open.id} finished its trial and was rolled back (${settled.reason}); no new change was applied.`), teamFilesSynced: settled.teamFilesSynced === true }
    // Approving a raise means approving a reviewed plan: without its fingerprint nothing was reviewed.
    if (input.allowSpendRaise === true && expected === undefined) return refuse('Nothing was applied: approving changes that may spend more needs the fingerprint of the plan that was reviewed.')
    if (missingReviewed) return refuse('Nothing was applied: the hybrid plan that was reviewed is no longer available (it is kept for 30 minutes and only while the team is unchanged). Run the analysis again; no model call was made.')
    if (expected !== undefined && plan.fingerprint !== expected) return refuse(`Nothing was applied: the plan changed since it was reviewed (now ${plan.fingerprint}, reviewed ${expected.slice(0, 32)}). Run the analysis again.`)
    if (!plan.gate.ok) return refuse(`The safety gate refused this plan: ${plan.gate.violations.filter((v) => v.action === 'rejected').map((v) => v.rule).join(', ')}.`)
    if (plan.empty) return refuse(diagnosis.wasteScore < (input.minWaste ?? MIN_WASTE_DEFAULT) ? `Waste score ${diagnosis.wasteScore} is below the threshold; nothing to change.` : 'No safe change follows from the findings.')
    // Spend rises only with the person's approval of the reviewed plan: otherwise the raising parts are held (reported
    // as 'spend_held') and only the rest applies, as the team files gate does for an edit that may spend more.
    if (plan.spendRaises.length && input.allowSpendRaise !== true) {
      const h = holdSpendRaises(project, plan, gate)
      plan = h.plan
      held = h.held
      if (!plan.gate.ok) return refuse(`The safety gate refused what is left after holding the changes that may spend more: ${plan.gate.violations.filter((v) => v.action === 'rejected').map((v) => v.rule).join(', ')}.`)
      if (plan.empty) return refuse('Nothing was applied: every change in this plan may spend more and needs your approval (run org evolve --apply in a terminal and confirm it).')
    }
    // Defence in depth: whatever is applied now raises spend only when that was approved.
    if (input.allowSpendRaise !== true && spendRaisesOf(project, plan).length) return refuse('Nothing was applied: a change that may spend more could not be separated from the rest of the plan.')

    const next = applyPlan(project, plan)
    const problems = chartProblems(project, next)
    if (problems.length) return refuse(`The safety gate refused this plan: ${problems.map((v) => v.rule).join(', ')}.`)
    const snapshot = snapshotOf(project, next, plan)
    for (const id of plan.pruneSkillIds) {
      const d = deps.skills?.readDraft(project.id, id)
      if (d) snapshot.prunedSkills.push({ ...d, roleIds: project.roles.filter((r) => r.skills?.includes(id)).map((r) => r.id) })
    }
    const gen: StoredGeneration = {
      id: nextGenerationId(ledger),
      status: 'trial',
      strategy: plan.strategy,
      fingerprint: plan.fingerprint,
      summary: planSummary(plan),
      appliedAt: now(),
      appliedAtRunCount: measuredCount(src),
      evalWindowRuns: clampWindow(input.evalWindowRuns),
      baselineMetrics: diagnosis.metrics,
      plan,
      snapshot
    }
    // The snapshot is on disk before anything changes, so a crash in between still leaves a way back.
    ledger.generations.push(gen)
    writeLedger(deps.dataDir, ledger)
    let mutated = false
    try {
      deps.updateProject(project.id, (p) => {
        // The plan (and the snapshot already on disk) were made from `project`, perhaps around a model call: if the team
        // changed meanwhile (a save, a fixed role, a lower effort), nothing is applied.
        if (teamKey(p) !== teamKey(project)) throw new Error('the team changed while the plan was being made; run evolve again')
        const out = applyPlan(p, plan)
        const bad = chartProblems(p, out)
        if (bad.length) throw new Error(`safety gate: ${bad.map((v) => v.rule).join(', ')}`)
        return out
      })
      mutated = true
      for (const id of plan.pruneSkillIds) {
        try {
          deps.skills?.remove({ projectId: project.id, skillId: id })
        } catch (e) {
          log('warn', `Evolution could not remove a skill: ${e instanceof Error ? e.message : String(e)}`)
          snapshot.prunedSkills = snapshot.prunedSkills.filter((s) => s.name !== deps.skills?.readDraft(project.id, id)?.name)
        }
      }
      for (const s of plan.newSkills) {
        try {
          const fresh = deps.getProject(project.id) ?? next
          const roleIds = fresh.roles.filter((r) => s.grantTo.includes(r.slug)).map((r) => r.id)
          const res = deps.skills?.create({ projectId: project.id, draft: { name: s.name, description: s.description, body: s.body }, roleIds })
          const id = res?.project.skills?.find((k) => k.name === s.name)?.id
          if (id) {
            snapshot.addedSkillIds.push(id)
            try {
              deps.skills?.setEnabled?.(project.id, id, false)
            } catch (e) {
              // A skill that cannot be switched off is not kept: it would reach runs unreviewed.
              deps.skills?.remove({ projectId: project.id, skillId: id })
              snapshot.addedSkillIds = snapshot.addedSkillIds.filter((x) => x !== id)
              throw e
            }
          }
        } catch (e) {
          log('warn', `Evolution could not add skill ${s.name}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      writeLedger(deps.dataDir, ledger)
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      // The team changed already: the generation (on disk since before the change, with its snapshot) stays, so the
      // trial is measured and can be rolled back; only a later step failed.
      if (mutated) {
        log('warn', `Evolution ${gen.id} applied to ${project.id}, but a later step failed: ${why}`)
        const now = deps.getProject(project.id) ?? next
        return { applied: true, reason: `Applied, but a later step failed (${why.slice(0, 200)}); the generation and its snapshot were recorded before the change.`, generation: pub(gen), project: now, diagnosis, plan, teamFilesSynced: await sync(now), ...(held.length ? { heldSpendRaises: held } : {}) }
      }
      ledger.generations = ledger.generations.filter((g) => g !== gen)
      try {
        writeLedger(deps.dataDir, ledger)
      } catch {
        // the generation stays as a trial the next pass can roll back
      }
      return refuse(`Applying the change failed: ${why}`)
    }
    const after = deps.getProject(project.id) ?? next
    const teamFilesSynced = await sync(after)
    log('info', `Evolution ${gen.id} applied to ${project.id}: ${gen.summary}`)
    return { applied: true, generation: pub(gen), project: after, diagnosis, plan, teamFilesSynced, ...(held.length ? { heldSpendRaises: held } : {}) }
  }

  async function rollbackCore(projectId: string, ledger: Ledger, gen: StoredGeneration, reason: string, src: RunSource):Promise<{ project: Project; teamFilesSynced: boolean; unusable?: string; notes: string[] }> {
    let notes: string[] = []
    let unusable: string | undefined
    let updated: Project = deps.getProject(projectId) as Project
    try {
      updated = deps.updateProject(projectId, (p) => {
        const r = restoreSnapshot(p, gen.snapshot, gen.plan)
        notes = r.notes
        if (!r.ok) {
          unusable = r.reason
          return p
        }
        return r.project
      })
    } catch (e) {
      unusable = `restoring failed (${e instanceof Error ? e.message : String(e)})`
    }
    const snap = gen.snapshot
    if (!unusable) {
      // Skill changes are undone only as far as the generation's own plan made them: a skill is removed only when the
      // plan added one by that name, and removed skills come back only when the plan pruned skills (never today).
      const newNames = new Set((Array.isArray(gen.plan?.newSkills) ? gen.plan.newSkills : []).map((s) => s?.name))
      const pruned = Array.isArray(gen.plan?.pruneSkillIds) ? gen.plan.pruneSkillIds.length : 0
      for (const id of Array.isArray(snap?.addedSkillIds) ? snap.addedSkillIds : []) {
        try {
          if (typeof id === 'string' && deps.getProject(projectId)?.skills?.some((s) => s.id === id && newNames.has(s.name))) deps.skills?.remove({ projectId, skillId: id })
        } catch (e) {
          notes.push(`could not remove added skill: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      for (const s of (Array.isArray(snap?.prunedSkills) ? snap.prunedSkills : []).slice(0, pruned)) {
        try {
          if (!isObj(s) || draftProblem({ name: s.name, description: s.description, body: s.body })) throw new Error('malformed skill entry')
          const fresh = deps.getProject(projectId) ?? updated
          if (fresh.skills?.some((k) => k.name === s.name)) continue
          deps.skills?.create({ projectId, draft: { name: s.name, description: s.description, body: s.body }, roleIds: (Array.isArray(s.roleIds) ? s.roleIds : []).filter((id) => fresh.roles.some((r) => r.id === id)) })
        } catch (e) {
          notes.push(`could not restore removed skill: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    // The generation is always closed, so a bad snapshot can never wedge the trial.
    gen.status = 'rolled_back'
    gen.decidedAt = now()
    gen.decidedAtRunCount = measuredCount(src)
    const text = unusable ? `${reason}; the snapshot was unusable, so the project was left unchanged (${unusable})` : notes.length ? `${reason} (${notes.join('; ')})` : reason
    gen.outcomeReason = text.slice(0, 600)
    addRejected(ledger, { fingerprint: gen.fingerprint, summary: gen.summary, reason, generationId: gen.id, at: now() })
    // Each patch too, so the same role change is not re-proposed inside a different plan (the cause cannot be attributed).
    for (const p of Array.isArray(gen.plan?.rolePatches) ? gen.plan.rolePatches : []) addRejected(ledger, { fingerprint: patchFingerprint(p), summary: `${p.slug}: ${p.reason}`, reason, generationId: gen.id, at: now() })
    writeLedger(deps.dataDir, ledger)
    const after = deps.getProject(projectId) ?? updated
    return { project: after, teamFilesSynced: unusable ? false : await sync(after), ...(unusable ? { unusable } : {}), notes }
  }

  async function rollbackLocked(input: EvolveRollbackInput): Promise<EvolveRollbackResult> {
    const project = projectOf(input.projectId)
    const ledger = ledgerOf(project.id)
    const gen = input.generationId ? ledger.generations.find((g) => g.id === input.generationId) : (trialOf(ledger) ?? [...ledger.generations].reverse().find((g) => g.status === 'promoted'))
    if (!gen) return { rolledBack: false, reason: input.generationId ? `No generation ${input.generationId}.` : 'No generation to roll back.', project, teamFilesSynced: false }
    if (gen.status === 'rolled_back') return { rolledBack: false, reason: `${gen.id} was already rolled back.`, project, teamFilesSynced: false }
    const busy = teamFilesBusy(project.id)
    if (busy) return { rolledBack: false, reason: `Nothing was rolled back; try again once ${busy}.`, project, teamFilesSynced: false }
    const why = (typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim().slice(0, 200) : 'rolled back by the user')
    const res = await rollbackCore(project.id, ledger, gen, why, runSource(project.id))
    // Nothing restored: say so. The generation is closed all the same (rollbackCore), so it cannot wedge the trial.
    if (res.unusable) return { rolledBack: false, reason: `${gen.id} could not be restored (${res.unusable}); the team was left unchanged and the generation is closed.`.slice(0, 600), generation: pub(gen), project: res.project, teamFilesSynced: false }
    // Restored in part (a later edit of the user's was kept, a skill could not be put back): the result carries what was not.
    return { rolledBack: true, ...(res.notes.length ? { reason: res.notes.join('; ').slice(0, 600) } : {}), generation: pub(gen), project: res.project, teamFilesSynced: res.teamFilesSynced }
  }

  /**
   * Decide a trial once its window is full: promote it, or roll it back when it regressed. 'pending' while runs are
   * still missing. Callers hold the project's serial chain.
   */
  async function settleTrial(project: Project, ledger: Ledger, trial: StoredGeneration, src: RunSource): Promise<{ state: 'pending'; have: number; need: number } | { state: 'held' | 'promoted' | 'rolled_back'; reason: string; teamFilesSynced?: boolean }> {
    // The window is found from summaries; only the runs it measures are loaded in full.
    const need = clampWindow(trial.evalWindowRuns)
    const since = src
      .summaries()
      .filter((r) => r.summary.startedAt >= trial.appliedAt)
      .sort((a, b) => a.summary.startedAt - b.summary.startedAt)
    if (since.length < need) return { state: 'pending', have: since.length, need }
    const d = evaluateActiveTrial(trial, src.byIds(since.slice(0, need).map((r) => r.summary.id)), effectiveConcurrency(project))
    if (d.state === 'pending') return { state: 'pending', have: d.have, need: d.need }
    if (d.regressed) {
      // The rollback writes the team: it waits (the trial stays open) while the team files cannot be written.
      const busy = teamFilesBusy(project.id)
      if (busy) return { state: 'held', reason: `${trial.id} regressed (${d.reason}) and is rolled back once ${busy}` }
    }
    trial.trialMetrics = d.trialMetrics
    if (d.regressed) {
      const res = await rollbackCore(project.id, ledger, trial, `trial regressed: ${d.reason}`, src)
      return { state: 'rolled_back', reason: res.unusable ? `${d.reason}; the snapshot was unusable, so the team was left unchanged` : d.reason, teamFilesSynced: res.teamFilesSynced }
    }
    trial.status = 'promoted'
    trial.decidedAt = now()
    trial.decidedAtRunCount = measuredCount(src)
    trial.outcomeReason = d.reason.slice(0, 600)
    writeLedger(deps.dataDir, ledger)
    return { state: 'promoted', reason: d.reason }
  }

  async function afterRunLocked(input: EvolveAfterRunInput): Promise<EvolvePostRunResult> {
    const none = { projectId: input.projectId, ratchet: 'none' as const }
    const project = deps.getProject(input.projectId)
    if (!project || !isValidProjectId(input.projectId)) return { ...none, ratchet: 'none' }
    const ledger = ledgerOf(project.id)
    // Every run this pass reads is loaded once, here, and handed down.
    const src = runSource(project.id)
    const trial = trialOf(ledger)
    if (trial) {
      const d = await settleTrial(project, ledger, trial, src)
      if (d.state === 'pending') return { ...none, ratchet: 'none', ratchetReason: `trial ${trial.id}: ${d.have} of ${d.need} runs` }
      if (d.state === 'held') return { ...none, ratchet: 'none', ratchetReason: d.reason }
      return { ...none, ratchet: d.state, ratchetReason: d.reason, decided: pub(trial) }
    }
    if (!input.evolve) return { ...none, ratchet: 'none' }
    if (measuredCount(src) < MIN_RUNS_FOR_APPLY) return { ...none, ratchet: 'none', ratchetReason: `needs ${MIN_RUNS_FOR_APPLY} finished runs` }
    // Unattended: never an expectedFingerprint or allowSpendRaise, so any part that may spend more is held, not applied.
    const res = await applyCore({ projectId: project.id, strategy: input.strategy ?? 'deterministic', goal: input.goal, minWaste: input.minWaste, evalWindowRuns: input.evalWindowRuns }, src)
    const held = res.heldSpendRaises?.length ? { heldSpendRaises: res.heldSpendRaises } : {}
    return { ...none, ratchet: 'none', wasteScore: res.diagnosis.wasteScore, ...(res.applied && res.generation ? { applied: res.generation } : res.reason ? { ratchetReason: res.reason } : {}), ...held }
  }

  return {
    analyze,
    apply: (input) => serial(input.projectId, () => applyCore(input)),
    history(projectId) {
      if (!isValidProjectId(projectId)) throw new Error('Invalid project id')
      return toHistory(ledgerForRead(projectId))
    },
    rollback: (input) => serial(input.projectId, () => rollbackLocked(input)),
    async afterRun(input) {
      try {
        return await serial(input.projectId, () => afterRunLocked(input))
      } catch (e) {
        log('warn', `Evolution post-run pass failed: ${e instanceof Error ? e.message : String(e)}`)
        return { projectId: input.projectId, ratchet: 'none' }
      }
    }
  }
}
