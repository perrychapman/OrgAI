import type {
  MergeDecision,
  MergeReview,
  PermissionDecision,
  PermissionRequest,
  Project,
  Proposal,
  ProposalDecision,
  ProviderAuth,
  ProviderId,
  QuestionAnswer,
  Role,
  RunEvent,
  RunPlan,
  RunSummary,
  UsageStatus,
  UserQuestion
} from '@shared/types'

/** Harness id of the root orchestrator's AgentInstance, shared by every adapter. */
export const ROOT_AGENT_ID = 'root'

/**
 * Everything a runtime adapter needs to run one project session.
 * The adapter turns vendor-specific output into normalized RunEvents.
 */
export interface RuntimeContext {
  run: RunSummary
  project: Project
  /** The org chart to run. For setup runs this is the built-in Architect, not the project's roles. */
  roles: Role[]
  prompt: string
  /** Extra text sent with the first message but kept out of the transcript (repo profile, project facts). */
  hiddenContext?: string
  /** Resume this provider session instead of starting fresh (continuing a finished run). */
  resumeSessionId?: string
  /**
   * Cost already recorded on the run being continued. A resumed session's reported total may
   * include the earlier turns; the adapter subtracts this so the new run counts only new spend.
   */
  resumeBaseCostUsd?: number
  emit(event: RunEvent): void
  /** Ask the user to approve a tool call. Resolves with their decision. */
  requestPermission(req: Omit<PermissionRequest, 'id' | 'runId'>): Promise<PermissionDecision>
  /** Setup runs only: put a proposal in front of the user. Resolves when they approve or ask for changes. */
  requestProposal(req: Omit<Proposal, 'id' | 'runId' | 'createdAt'>): Promise<ProposalDecision>
  /** Work runs with reviewMerges: show a finished report's diff and wait for merge, discard or hold. */
  requestMergeReview(req: Omit<MergeReview, 'id' | 'runId' | 'createdAt'>): Promise<MergeDecision>
  /** Setup runs only: the Architect declares setup finished. */
  completeSetup(summary: string): Promise<void>
  /** Ask the user a multiple-choice question (ask_user). Resolves with their answer (empty if the run ends first). */
  requestQuestion(req: Omit<UserQuestion, 'id' | 'runId' | 'createdAt'>): Promise<QuestionAnswer>
  /** Work runs: an agent edited the architecture document; record the time on the project. */
  noteArchitectureUpdated(): Promise<void>
  /**
   * The provider rejected a request on a subscription usage limit. `until` is when the window resets
   * (epoch ms), `window` the provider's name for it. If the session then ends, the run is paused and
   * continues automatically at `until`.
   */
  rateLimited(info: { until?: number; window?: string }): void
  /** Weekly-window percent at or above which projects with preferSonnetNearLimit spawn Opus reports on Sonnet. */
  opusGuardThreshold?: number
  /** Work runs: the orchestrator's plan, if it set one (plan tools, continuation). */
  getPlan(): RunPlan | undefined
  /** Store the plan on the run, persist it and tell the renderer (plan.updated). */
  updatePlan(plan: RunPlan): Promise<void>
  /** Cards waiting for the user: pending permissions, proposals, questions and merge reviews. */
  pendingInteractions(): number
  /** Work runs: keep the orchestrator going until the plan is complete (project.autoContinue). Default true. */
  autoContinue?: boolean
  /** Automatic continues allowed in this run (project.maxAutoContinues). */
  maxAutoContinues?: number
  /** Delay between a turn ending and the continuation check, in ms. Tests shorten it. */
  continuationDelayMs?: number
}

export interface RuntimeSession {
  /** Send a follow-up user message to the orchestrator. */
  send(text: string): Promise<void>
  /** Interrupt the current turn but keep the session open. */
  interrupt(): Promise<void>
  /** End the session. */
  stop(): Promise<void>
  /** Resolves once the underlying session has fully ended. */
  finished: Promise<void>
}

export interface CompletionInput {
  system: string
  prompt: string
  cwd?: string
  model?: string
}

/**
 * A provider adapter. One per AI vendor. The harness only ever talks to this
 * interface, which is what keeps the app provider-agnostic.
 */
export interface RuntimeAdapter {
  readonly id: ProviderId
  /** Start a live org-chart session. */
  start(ctx: RuntimeContext): Promise<RuntimeSession>
  /** One-shot text completion with no tools, used by the org chart drafter. */
  complete(input: CompletionInput): Promise<string>
  /**
   * Read plan usage without a run, e.g. at boot. Returns null when the provider cannot report it.
   * Must not spend tokens.
   */
  probeUsage?(auth: ProviderAuth): Promise<UsageStatus | null>
}
