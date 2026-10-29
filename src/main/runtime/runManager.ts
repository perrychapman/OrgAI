import { mkdirSync } from 'node:fs'
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
  RunRecord,
  RunSummary,
  UserQuestion
} from '@shared/types'
import { newId } from '@shared/defaults'
import { architectRole } from '@shared/setup'
import type { RuntimeAdapter, RuntimeSession } from './types'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'

const FLUSH_INTERVAL_MS = 1500

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
}

export class RunManager {
  private runs = new Map<string, ActiveRun>()

  constructor(
    private adapters: Record<ProviderId, RuntimeAdapter>,
    private broadcast: (e: RunEvent) => void,
    private store: RunStore,
    private setup: SetupService,
    /** Retention per project; older finished runs are deleted when a run ends. */
    private keepRunsFor: (projectId: string) => number
  ) {}

  /** Drop every run of a deleted project. Live runs are stopped first. */
  async removeProject(projectId: string): Promise<void> {
    for (const r of this.runs.values()) {
      if (r.summary.projectId === projectId) {
        await r.session?.stop().catch(() => {})
        if (r.flushTimer) clearTimeout(r.flushTimer)
        this.runs.delete(r.summary.id)
      }
    }
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
    resumeBaseCostUsd
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

    const emit = (e: RunEvent): void => {
      if (e.type === 'run.status') {
        summary.status = e.status
        if (e.sessionId) summary.sessionId = e.sessionId
        if (e.error) summary.error = e.error
        if (e.status === 'finished' || e.status === 'error') summary.endedAt = Date.now()
        this.store.upsert(summary)
      } else if (e.type === 'run.cost') {
        summary.totalCostUsd = e.totalCostUsd
        this.store.upsert(summary)
      }
      this.recordEvent(active, e)
      this.broadcast(e)
    }

    emit({ type: 'run.status', runId: summary.id, status: 'starting' })

    const adapter = this.adapterFor(project)
    try {
      // A new project's folder may not exist yet, and the provider needs a real cwd.
      mkdirSync(project.path, { recursive: true })
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
    return new Promise((resolve) => {
      active.pending.set(request.id, resolve)
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
    this.broadcast({ type: 'run.status', runId, status: 'stopping' })
    await active.session.stop()
  }

  async stopAll(): Promise<void> {
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
    if (from.status !== 'finished' && from.status !== 'error') throw new Error('Run is still active; send a message instead')
    if (!from.sessionId) throw new Error('This run has no session to continue')
    const prompt = text.trim()
    if (!prompt) throw new Error('Nothing to send')
    return this.start({
      project,
      prompt,
      kind: from.kind,
      hiddenContext: from.kind === 'setup' ? this.setup.hiddenContext(project) : undefined,
      resumeSessionId: from.sessionId,
      resumedFrom: from.id,
      resumeBaseCostUsd: from.totalCostUsd
    })
  }
}
