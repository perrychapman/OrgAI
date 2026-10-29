import type {
  MergeDecision,
  MergeReview,
  PermissionDecision,
  PermissionRequest,
  Project,
  Proposal,
  ProposalDecision,
  ProviderId,
  Role,
  RunEvent,
  RunSummary
} from '@shared/types'

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
  emit(event: RunEvent): void
  /** Ask the user to approve a tool call. Resolves with their decision. */
  requestPermission(req: Omit<PermissionRequest, 'id' | 'runId'>): Promise<PermissionDecision>
  /** Setup runs only: put a proposal in front of the user. Resolves when they approve or ask for changes. */
  requestProposal(req: Omit<Proposal, 'id' | 'runId' | 'createdAt'>): Promise<ProposalDecision>
  /** Work runs with reviewMerges: show a finished report's diff and wait for merge, discard or hold. */
  requestMergeReview(req: Omit<MergeReview, 'id' | 'runId' | 'createdAt'>): Promise<MergeDecision>
  /** Setup runs only: the Architect declares setup finished. */
  completeSetup(summary: string): Promise<void>
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
}
