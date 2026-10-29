import { mkdirSync, realpathSync } from 'node:fs'
import type {
  MergeDecision,
  MergeReview,
  PermissionDecision,
  PermissionRequest,
  Project,
  Proposal,
  ProposalDecision,
  ProviderId,
  QuestionAnswer,
  RunEvent,
  RunKind,
  RunPlan,
  RunRecord,
  RunSummary,
  UserQuestion
} from '@shared/types'
import { newId } from '@shared/defaults'
import { DEFAULT_MAX_AUTO_CONTINUES } from '@shared/types'
import { architectRole } from '@shared/setup'
import { ROOT_AGENT_ID, type RuntimeAdapter, type RuntimeSession } from './types'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { logPermission, logRunEvent } from '../log'
import { describePlanChange } from './continuation'

/** The path as the file system spells it (true case on Windows). Falls back to the input when it cannot be resolved. */
export function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

const FLUSH_INTERVAL_MS = 1500
/** When a usage limit gives no reset time, try again after this long. */
export const DEFAULT_PAUSE_MS = 5 * 60 * 1000
/** Sent to the orchestrator when a paused run continues. */
export const RESUME_TEXT =
  'The usage window has reset. Continue exactly where you left off; the harness has reconciled any report branches left in progress.'

const WINDOW_LABELS: Record<string, string> = {
  five_hour: 'five-hour',
  seven_day: 'seven-day',
  seven_day_opus: 'Opus weekly',
  seven_day_sonnet: 'Sonnet weekly'
}

/** The pause reason shown to the user. */
export function pauseReasonText(window: string | undefined, error?: string): string {
  const label = window ? `${WINDOW_LABELS[window] ?? window.replace(/_/g, ' ')} usage limit` : 'subscription usage limit'
  return (
    `The ${label} was reached${error ? ` (${error.slice(0, 120)})` : ''}, so the session ended. ` +
    'Reports still working were cut off; any worktrees they left are committed by the continued run, which tells the orchestrator what is pending.'
  )
}

interface ActiveRun {
  summary: RunSummary
  session?: RuntimeSession
  pending: Map<string, (d: PermissionDecision) => void>
  pendingProposals: Map<string, (d: ProposalDecision) => void>
  pendingQuestions: Map<string, { question: UserQuestion; resolve: (a: QuestionAnswer) => void }>
  pendingMerges: Map<string, (d: MergeDecision) => void>
  /** Everything needed to redraw the run later; flushed to disk on a timer and at the end. */
  record: RunRecord
  flushTimer?: ReturnType<typeof setTimeout>
  /** Set when the provider reported a usage-limit rejection; the run pauses instead of ending. */
  limited?: { until?: number; window?: string }
  /** The user ended the session; never pause it. */
  userStopped?: boolean
}

export interface RunManagerOptions {
  /** The current project for a run being resumed automatically. */
  resolveProject?: (projectId: string) => Project | null | undefined
  /** App setting passed to adapters (see RuntimeContext.opusGuardThreshold). */
  opusGuardThreshold?: () => number
  /** Delay between a turn ending and the automatic-continue check (RuntimeContext.continuationDelayMs). */
  continuationDelayMs?: number
}

export interface StartInput {
  project: Project
  prompt: string
  kind?: RunKind
  hiddenContext?: string
  /** A new project's first build run; recorded on the project so the UI stops offering it. */
  scaffold?: boolean
  /** Continue an earlier run: resume its provider session. */
  resumeSessionId?: string
  /** The run being continued. */
  resumedFrom?: string
  /** Cost already recorded on the run being continued. */
  resumeBaseCostUsd?: number
  /** The continued run's plan; it carries over with a fresh automatic-continue count. */
  plan?: RunPlan
}

export class RunManager {
  private runs = new Map<string, ActiveRun>()
  /** Paused run id -> its auto-resume timer. Lives only as long as the app process. */
  private resumeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private adapters: Partial<Record<ProviderId, RuntimeAdapter>>,
    private broadcast: (e: RunEvent) => void,
    private store: RunStore,
    private setup: SetupService,
    /** Retention per project; older finished runs are deleted when a run ends. */
    private keepRunsFor: (projectId: string) => number,
    private options: RunManagerOptions = {}
  ) {}

  /** Drop every run of a deleted project. Live runs are stopped first. */
  async removeProject(projectId: string): Promise<void> {
    for (const r of this.runs.values()) {
      if (r.summary.projectId === projectId) {
        r.userStopped = true
        await r.session?.stop().catch(() => {})
        if (r.flushTimer) clearTimeout(r.flushTimer)
        this.runs.delete(r.summary.id)
      }
    }
    for (const s of this.store.list(projectId)) this.clearResume(s.id)
    this.store.removeProject(projectId)
  }

  adapterFor(project: Project): RuntimeAdapter {
    const adapter = this.adapters[project.provider.id]
    if (!adapter) throw new Error(`No runtime adapter for provider "${project.provider.id}"`)
    return adapter
  }

  async start({
    project,
    prompt,
    kind = 'work',
    hiddenContext,
    scaffold,
    resumeSessionId,
    resumedFrom,
    resumeBaseCostUsd,
    plan: carriedPlan
  }: StartInput): Promise<RunSummary> {
    const summary: RunSummary = {
      id: newId('run'),
      projectId: project.id,
      kind,
      prompt,
      status: 'starting',
      startedAt: Date.now(),
      totalCostUsd: 0
    }
    if (resumedFrom) summary.resumedFrom = resumedFrom
    const active: ActiveRun = {
      summary,
      pending: new Map(),
      pendingProposals: new Map(),
      pendingQuestions: new Map(),
      pendingMerges: new Map(),
      record: { summary, agents: {}, transcript: [], logs: [] }
    }
    this.runs.set(summary.id, active)
    this.store.upsert(summary)

    const emit = (raw: RunEvent): void => {
      let e = raw
      // A session that ends after a usage-limit rejection is paused, not finished.
      if (e.type === 'run.status' && (e.status === 'finished' || e.status === 'error') && active.limited && !active.userStopped) {
        const now = Date.now()
        const until = active.limited.until && active.limited.until > now ? active.limited.until : now + DEFAULT_PAUSE_MS
        e = { ...e, status: 'paused', pausedUntil: until, pauseReason: pauseReasonText(active.limited.window, e.error), autoResume: true }
      }
      if (e.type === 'run.status') {
        summary.status = e.status
        if (e.sessionId) summary.sessionId = e.sessionId
        if (e.error) summary.error = e.error
        if (e.status === 'finished' || e.status === 'error' || e.status === 'paused') summary.endedAt = Date.now()
        if (e.status === 'paused') {
          summary.pausedUntil = e.pausedUntil
          summary.pauseReason = e.pauseReason
          summary.autoResume = e.autoResume
          this.scheduleResume(summary.id, e.pausedUntil ?? Date.now() + DEFAULT_PAUSE_MS)
        }
        this.store.upsert(summary)
      } else if (e.type === 'run.cost') {
        summary.totalCostUsd = e.totalCostUsd
        this.store.upsert(summary)
      }
      this.recordEvent(active, e)
      logRunEvent(summary, e)
      this.broadcast(e)
    }

    emit({ type: 'run.status', runId: summary.id, status: 'starting' })
    if (carriedPlan && kind === 'work') emit({ type: 'plan.updated', runId: summary.id, plan: { ...structuredClone(carriedPlan), autoContinues: 0 } })

    const updatePlan = async (plan: RunPlan): Promise<void> => {
      const previous = active.record.plan
      const next = structuredClone(plan)
      emit({ type: 'plan.updated', runId: summary.id, plan: next })
      const change = describePlanChange(previous, next)
      if (change) emit({ type: 'log', runId: summary.id, level: 'info', message: change })
      if (next.status === 'blocked' && previous?.status !== 'blocked') {
        const text = `The orchestrator needs you: ${next.blockedReason ?? 'it marked the plan blocked.'} Reply below to continue.`
        emit({ type: 'transcript', runId: summary.id, entry: { id: newId('t'), agentId: ROOT_AGENT_ID, at: Date.now(), block: { kind: 'system', text } } })
      }
    }

    const adapter = this.adapterFor(project)
    try {
      // A new project's folder may not exist yet, and the provider needs a real cwd.
      mkdirSync(project.path, { recursive: true })
      // Git and Claude Code compare paths case-sensitively on Windows; a project path typed in a different
      // case than the folder on disk makes worktree isolation refuse to start. Use the on-disk spelling.
      project = { ...project, path: canonicalPath(project.path) }
      if (scaffold) {
        const updated = this.setup.markScaffolded(project.id)
        this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
      }
      active.session = await adapter.start({
        run: summary,
        project,
        roles: kind === 'setup' ? [architectRole()] : project.roles,
        prompt,
        hiddenContext,
        resumeSessionId,
        resumeBaseCostUsd,
        emit,
        requestPermission: (req) => this.requestPermission(active, req),
        requestProposal: (req) => this.requestProposal(active, req),
        requestQuestion: (req) => this.requestQuestion(active, req),
        noteArchitectureUpdated: async () => {
          const updated = this.setup.markArchitectureUpdated(project.id)
          this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
        },
        requestMergeReview: (req) => this.requestMergeReview(active, req),
        rateLimited: (info) => {
          active.limited = { ...active.limited, ...info }
        },
        opusGuardThreshold: this.options.opusGuardThreshold?.(),
        getPlan: () => active.record.plan,
        updatePlan,
        pendingInteractions: () => active.pending.size + active.pendingProposals.size + active.pendingQuestions.size + active.pendingMerges.size,
        autoContinue: project.autoContinue !== false,
        maxAutoContinues: project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES,
        ...(this.options.continuationDelayMs !== undefined ? { continuationDelayMs: this.options.continuationDelayMs } : {}),
        completeSetup: async (text) => {
          const updated = this.setup.complete(project.id, text)
          this.broadcast({ type: 'project.updated', runId: summary.id, project: updated })
        }
      })
      void active.session.finished.finally(() => {
        for (const resolve of active.pending.values()) resolve({ behavior: 'deny', message: 'Run ended' })
        active.pending.clear()
        for (const resolve of active.pendingProposals.values()) resolve({ behavior: 'revise', feedback: 'Run ended' })
        active.pendingProposals.clear()
        for (const [questionId, q] of active.pendingQuestions) {
          q.resolve({ selected: [] })
          this.broadcast({ type: 'question.resolved', runId: summary.id, questionId, answer: { selected: [] } })
        }
        active.pendingQuestions.clear()
        // Unanswered merge reviews keep their branch for later (maintenance panel or a future run).
        for (const [reviewId, resolve] of active.pendingMerges) {
          resolve({ behavior: 'hold' })
          this.broadcast({ type: 'merge.resolved', runId: summary.id, reviewId, decision: { behavior: 'hold' } })
        }
        active.pendingMerges.clear()
        this.flush(active)
        this.runs.delete(summary.id)
        this.store.prune(this.keepRunsFor)
      })
    } catch (e) {
      emit({ type: 'run.status', runId: summary.id, status: 'error', error: (e as Error).message })
      this.flush(active)
    }
    return summary
  }

  private recordEvent(active: ActiveRun, e: RunEvent): void {
    const r = active.record
    switch (e.type) {
      case 'agent.upsert':
        r.agents[e.agent.id] = e.agent
        break
      case 'agent.remove':
        delete r.agents[e.agentId]
        break
      case 'transcript':
        r.transcript.push(e.entry)
        break
      case 'log':
        r.logs.push({ at: Date.now(), level: e.level, message: e.message })
        break
      case 'plan.updated':
        r.plan = e.plan
        break
      default:
        return
    }
    if (!active.flushTimer) active.flushTimer = setTimeout(() => this.flush(active), FLUSH_INTERVAL_MS)
  }

  private flush(active: ActiveRun): void {
    if (active.flushTimer) clearTimeout(active.flushTimer)
    active.flushTimer = undefined
    try {
      this.store.saveRecord(active.record)
    } catch (e) {
      console.error('Failed to persist run record:', e)
    }
  }

  /** Summary of a live run, without copying its record. Undefined once the run has ended. */
  /** Runs whose session is still open. */
  liveRunCount(): number {
    return this.runs.size
  }

  summaryOf(runId: string): RunSummary | undefined {
    return this.runs.get(runId)?.summary
  }

  get(runId: string): RunRecord | null {
    const active = this.runs.get(runId)
    if (active) return { ...active.record, summary: { ...active.summary } }
    return this.store.getRecord(runId)
  }

  private requestPermission(
    active: ActiveRun,
    req: Omit<PermissionRequest, 'id' | 'runId'>
  ): Promise<PermissionDecision> {
    const request: PermissionRequest = { ...req, id: newId('perm'), runId: active.summary.id }
    logPermission(active.summary, request)
    return new Promise((resolve) => {
      active.pending.set(request.id, (decision) => {
        logPermission(active.summary, request, decision)
        resolve(decision)
      })
      this.broadcast({ type: 'permission.request', runId: active.summary.id, request })
    })
  }

  decide(runId: string, requestId: string, decision: PermissionDecision): void {
    const active = this.runs.get(runId)
    const resolve = active?.pending.get(requestId)
    if (!active || !resolve) return
    active.pending.delete(requestId)
    resolve(decision)
    this.broadcast({ type: 'permission.resolved', runId, requestId })
  }

  private requestProposal(
    active: ActiveRun,
    req: Omit<Proposal, 'id' | 'runId' | 'createdAt'>
  ): Promise<ProposalDecision> {
    const proposal = { ...req, id: newId('prop'), runId: active.summary.id, createdAt: Date.now() } as Proposal
    return new Promise((resolve) => {
      active.pendingProposals.set(proposal.id, (decision) => {
        if (decision.behavior === 'approve') {
          try {
            const updated = this.setup.applyProposal(active.summary.projectId, proposal)
            this.broadcast({ type: 'project.updated', runId: active.summary.id, project: updated })
          } catch (e) {
            const message = (e as Error).message
            logRunEvent(active.summary, { type: 'log', runId: active.summary.id, level: 'error', message: `Could not apply proposal: ${message}` })
            this.broadcast({ type: 'log', runId: active.summary.id, level: 'error', message: `Could not apply proposal: ${message}` })
            resolve({ behavior: 'revise', feedback: `The harness could not apply this proposal: ${message}` })
            return
          }
        }
        resolve(decision)
      })
      this.broadcast({ type: 'proposal.request', runId: active.summary.id, proposal })
    })
  }

  decideProposal(runId: string, proposalId: string, decision: ProposalDecision): void {
    const active = this.runs.get(runId)
    const resolve = active?.pendingProposals.get(proposalId)
    if (!active || !resolve) return
    active.pendingProposals.delete(proposalId)
    resolve(decision)
    this.broadcast({ type: 'proposal.resolved', runId, proposalId, decision })
  }

  private requestQuestion(
    active: ActiveRun,
    req: Omit<UserQuestion, 'id' | 'runId' | 'createdAt'>
  ): Promise<QuestionAnswer> {
    const question: UserQuestion = { ...req, id: newId('q'), runId: active.summary.id, createdAt: Date.now() }
    return new Promise((resolve) => {
      active.pendingQuestions.set(question.id, { question, resolve })
      this.broadcast({ type: 'question.request', runId: active.summary.id, question })
    })
  }

  answerQuestion(runId: string, questionId: string, answer: QuestionAnswer): void {
    const active = this.runs.get(runId)
    const pending = active?.pendingQuestions.get(questionId)
    if (!active || !pending) return
    active.pendingQuestions.delete(questionId)
    // Only labels that were offered count; a single-choice question keeps the first.
    const labels = new Set(pending.question.options.map((o) => o.label))
    let selected = (Array.isArray(answer?.selected) ? answer.selected : []).filter((l) => typeof l === 'string' && labels.has(l))
    if (!pending.question.allowMultiple) selected = selected.slice(0, 1)
    const text = pending.question.allowFreeText && typeof answer?.text === 'string' && answer.text.trim() ? answer.text.trim() : undefined
    const clean: QuestionAnswer = text ? { selected, text } : { selected }
    pending.resolve(clean)
    this.broadcast({ type: 'question.resolved', runId, questionId, answer: clean })
  }

  private requestMergeReview(
    active: ActiveRun,
    req: Omit<MergeReview, 'id' | 'runId' | 'createdAt'>
  ): Promise<MergeDecision> {
    const review: MergeReview = { ...req, id: newId('merge'), runId: active.summary.id, createdAt: Date.now() }
    return new Promise((resolve) => {
      active.pendingMerges.set(review.id, resolve)
      this.broadcast({ type: 'merge.request', runId: active.summary.id, review })
    })
  }

  decideMerge(runId: string, reviewId: string, decision: MergeDecision): void {
    const active = this.runs.get(runId)
    const resolve = active?.pendingMerges.get(reviewId)
    if (!active || !resolve) return
    active.pendingMerges.delete(reviewId)
    resolve(decision)
    this.broadcast({ type: 'merge.resolved', runId, reviewId, decision })
  }

  async send(runId: string, text: string): Promise<void> {
    const active = this.runs.get(runId)
    if (!active?.session) throw new Error('Run is not active')
    this.broadcast({ type: 'run.status', runId, status: 'running' })
    await active.session.send(text)
  }

  async interrupt(runId: string): Promise<void> {
    await this.runs.get(runId)?.session?.interrupt()
  }

  async stop(runId: string): Promise<void> {
    const active = this.runs.get(runId)
    if (!active?.session) return
    active.userStopped = true
    this.broadcast({ type: 'run.status', runId, status: 'stopping' })
    await active.session.stop()
  }

  async stopAll(): Promise<void> {
    for (const runId of [...this.resumeTimers.keys()]) this.clearResume(runId)
    for (const r of this.runs.values()) r.userStopped = true
    await Promise.allSettled([...this.runs.values()].map((r) => r.session?.stop()))
    for (const r of this.runs.values()) this.flush(r)
  }

  list(projectId: string): RunSummary[] {
    return this.store.list(projectId)
  }

  /** A run's summary, live or persisted. */
  summary(runId: string): RunSummary | null {
    const active = this.runs.get(runId)
    return active ? { ...active.summary } : this.store.get(runId)
  }

  /**
   * Start a new run that resumes a finished run's provider session, so the orchestrator keeps
   * its memory. Same kind as the old run: setup runs keep the Architect (with its hidden profile
   * context), work runs use the project's roles. `project` must be the old run's project.
   */
  async continueRun(project: Project, fromRunId: string, text: string): Promise<RunSummary> {
    const from = this.summary(fromRunId)
    if (!from) throw new Error('Run not found')
    if (from.projectId !== project.id) throw new Error('Run belongs to another project')
    if (from.status !== 'finished' && from.status !== 'error' && from.status !== 'paused') throw new Error('Run is still active; send a message instead')
    if (!from.sessionId) throw new Error('This run has no session to continue')
    const prompt = text.trim()
    if (!prompt) throw new Error('Nothing to send')
    if (from.status === 'paused') {
      // The paused run is handed over to its continuation; it stays in history as finished.
      this.clearResume(from.id)
      const done = this.patchSummary(from.id, { status: 'finished', autoResume: false })
      if (done) this.broadcast({ type: 'run.status', runId: done.id, status: 'finished', pausedUntil: done.pausedUntil, pauseReason: done.pauseReason, autoResume: false })
    }
    return this.start({
      project,
      prompt,
      kind: from.kind,
      hiddenContext: from.kind === 'setup' ? this.setup.hiddenContext(project) : undefined,
      resumeSessionId: from.sessionId,
      resumedFrom: from.id,
      resumeBaseCostUsd: from.totalCostUsd,
      plan: from.kind === 'work' ? this.get(from.id)?.plan : undefined
    })
  }

  // ---------- pause and auto-resume ----------

  private scheduleResume(runId: string, at: number): void {
    this.clearResume(runId)
    const delay = Math.max(0, at - Date.now())
    const timer = setTimeout(() => {
      this.resumeTimers.delete(runId)
      this.resumeNow(runId).catch((err) => {
        const message = `Could not resume the paused run: ${(err as Error).message}`
        this.broadcast({ type: 'log', runId, level: 'error', message })
        const s = this.patchSummary(runId, { autoResume: false })
        if (s) this.broadcast({ type: 'run.status', runId, status: s.status, pausedUntil: s.pausedUntil, pauseReason: s.pauseReason, autoResume: false })
      })
    }, delay)
    this.resumeTimers.set(runId, timer)
  }

  private clearResume(runId: string): void {
    const t = this.resumeTimers.get(runId)
    if (t) clearTimeout(t)
    this.resumeTimers.delete(runId)
  }

  /** Is an auto-resume timer pending for this run? */
  hasAutoResume(runId: string): boolean {
    return this.resumeTimers.has(runId)
  }

  /** Change a run's summary, live or persisted, and save it. Returns the updated copy. */
  private patchSummary(runId: string, patch: Partial<RunSummary>): RunSummary | null {
    const active = this.runs.get(runId)
    if (active) {
      Object.assign(active.summary, patch)
      this.store.upsert(active.summary)
      return { ...active.summary }
    }
    const stored = this.store.get(runId)
    if (!stored) return null
    const next = { ...stored, ...patch }
    this.store.upsert(next)
    return next
  }

  /** Continue a paused run now, with the harness's resume message. */
  async resumeNow(runId: string): Promise<RunSummary> {
    this.clearResume(runId)
    const from = this.summary(runId)
    if (!from) throw new Error('Run not found')
    if (from.status !== 'paused') throw new Error('Run is not paused')
    const current = this.options.resolveProject?.(from.projectId)
    if (!current) throw new Error('Project not found')
    // Setup runs re-profile the repo like setup:start so the Architect's hidden context is current.
    const project = from.kind === 'setup' ? await this.setup.prepare(current) : current
    return this.continueRun(project, runId, RESUME_TEXT)
  }

  /** Keep a paused run paused; the user continues it by hand. */
  cancelAutoResume(runId: string): void {
    this.clearResume(runId)
    const s = this.patchSummary(runId, { autoResume: false })
    if (s && s.status === 'paused') {
      this.broadcast({ type: 'run.status', runId, status: 'paused', pausedUntil: s.pausedUntil, pauseReason: s.pauseReason, autoResume: false })
    }
  }
}
