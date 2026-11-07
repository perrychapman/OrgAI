import type {
  CardKind,
  DecidedBy,
  McpInstallDecision,
  McpInstallOutcome,
  McpInstallRequest,
  MergeDecision,
  MergeReview,
  PendingCards,
  PermissionDecision,
  PermissionRequest,
  PermissionRuleDecision,
  PermissionRuleRequest,
  Proposal,
  ProposalDecision,
  ProposalEffect,
  ProposalKind,
  ProposalOutcome,
  ProviderId,
  RunSummary,
  QuestionAnswer,
  RunEvent,
  UserQuestion
} from '@shared/types'
import { PROPOSAL_NOTE_MAX_CHARS, isVirtualProjectId } from '@shared/types'

/**
 * The cards a live run holds open for the user, keyed by request id (RunManager's ActiveRun has these maps). Each
 * entry keeps the object its `*.request` event carried, so runs:pendingCards can hand them to a fresh renderer.
 */
export interface PendingCardMaps {
  pending: Map<string, { request: PermissionRequest; resolve: (d: PermissionDecision) => void }>
  pendingProposals: Map<string, { proposal: Proposal; resolve: (d: ProposalDecision) => ProposalOutcome | void }>
  pendingQuestions: Map<string, { question: UserQuestion; resolve: (a: QuestionAnswer) => void }>
  pendingMerges: Map<string, { review: MergeReview; resolve: (d: MergeDecision) => void }>
  /**
   * The install's own resolve broadcasts mcpInstall.resolved; `cancelled` adds the flag, `decidedBy` rides on the event.
   * Returns the secret-free outcome (RunManager's DecisionOutcome reads whether it was really installed).
   */
  pendingInstalls: Map<string, { request: McpInstallRequest; resolve: (d: McpInstallDecision, cancelled?: boolean, decidedBy?: DecidedBy) => McpInstallOutcome | void }>
  pendingRules: Map<string, { request: PermissionRuleRequest; resolve: (d: PermissionRuleDecision) => void }>
}

const RUN_ENDED = 'Run ended'

/**
 * runs:pendingCards: the request objects still open, in the order they were raised (Map insertion order). Fresh
 * arrays of the stored objects, which are the same secret-free shapes the `*.request` events broadcast.
 */
export function listPending(cards: PendingCardMaps): PendingCards {
  return {
    permissions: [...cards.pending.values()].map((p) => p.request),
    questions: [...cards.pendingQuestions.values()].map((q) => q.question),
    proposals: [...cards.pendingProposals.values()].map((p) => p.proposal),
    ruleRequests: [...cards.pendingRules.values()].map((r) => r.request),
    mergeReviews: [...cards.pendingMerges.values()].map((m) => m.review),
    mcpInstalls: [...cards.pendingInstalls.values()].map((i) => i.request)
  }
}

export function emptyPending(): PendingCards {
  return { permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] }
}

/**
 * Answer every card still waiting because the run ended, and empty the maps: permissions and rule requests are
 * denied, proposals revised, questions answered with nothing, merge reviews held (the branch stays for the
 * maintenance panel or a later run), MCP installs denied. Each gets its *.resolved event with `cancelled: true`
 * (installs through their own resolve, which keeps secrets out of the event). Idempotent: a second call finds
 * nothing. Returns how many cards it cancelled. `onCancelled` hears each card (RunManager records 'cancelled' tombstones).
 */
export function cancelPending(cards: PendingCardMaps, runId: string, broadcast: (e: RunEvent) => void, onCancelled?: (requestId: string, kind: CardKind) => void): number {
  let count = 0
  const note = (id: string, kind: CardKind): void => {
    count++
    onCancelled?.(id, kind)
  }
  for (const [requestId, { resolve }] of cards.pending) {
    resolve({ behavior: 'deny', message: RUN_ENDED })
    broadcast({ type: 'permission.resolved', runId, requestId, cancelled: true })
    note(requestId, 'permission')
  }
  cards.pending.clear()
  for (const [proposalId, { resolve }] of cards.pendingProposals) {
    const decision: ProposalDecision = { behavior: 'revise', feedback: RUN_ENDED }
    resolve(decision)
    broadcast({ type: 'proposal.resolved', runId, proposalId, decision, cancelled: true })
    note(proposalId, 'proposal')
  }
  cards.pendingProposals.clear()
  for (const [questionId, q] of cards.pendingQuestions) {
    q.resolve({ selected: [] })
    broadcast({ type: 'question.resolved', runId, questionId, answer: { selected: [] }, cancelled: true })
    note(questionId, 'question')
  }
  cards.pendingQuestions.clear()
  for (const [requestId, r] of cards.pendingRules) {
    r.resolve({ behavior: 'deny', message: RUN_ENDED })
    broadcast({ type: 'rules.resolved', runId, requestId, decision: { behavior: 'deny', message: RUN_ENDED }, cancelled: true })
    note(requestId, 'rules')
  }
  cards.pendingRules.clear()
  for (const [reviewId, { resolve }] of cards.pendingMerges) {
    resolve({ behavior: 'hold' })
    broadcast({ type: 'merge.resolved', runId, reviewId, decision: { behavior: 'hold' }, cancelled: true })
    note(reviewId, 'merge')
  }
  cards.pendingMerges.clear()
  // Cleared first so an mcp:answerInstall racing the end cannot resolve twice.
  const installs = [...cards.pendingInstalls.entries()]
  cards.pendingInstalls.clear()
  for (const [requestId, p] of installs) {
    p.resolve({ approved: false, scope: 'run' }, true)
    note(requestId, 'mcpInstall')
  }
  return count
}

/**
 * When an approved proposal takes effect (Proposal.effect): a work run's own 'mcpServers' / 'skills' change reaches
 * the live session, at once on the mock and after the current turn on Claude and Codex (both answer configChanged;
 * Claude sometimes sooner, so 'after-turn' is the upper bound); everything else, and every setup-like, assistant or
 * quick run, changes only later runs.
 */
export function proposalEffect(kind: ProposalKind, summary: Pick<RunSummary, 'kind' | 'projectId' | 'quick'>, adapter: ProviderId | undefined): ProposalEffect {
  // App settings are saved at once and every surface reads them live (Chat only).
  if (kind === 'appSettings') return 'now'
  if (summary.kind !== 'work' || summary.quick || isVirtualProjectId(summary.projectId)) return 'next-run'
  if (kind !== 'mcpServers' && kind !== 'skills') return 'next-run'
  return adapter === 'mock' ? 'now' : 'after-turn'
}

const SECRET_VALUE_MAX = 4000
const PROPOSAL_SECRET_KEYS_MAX = 100

function clip(text: unknown): string {
  return typeof text === 'string' ? text.slice(0, PROPOSAL_NOTE_MAX_CHARS) : ''
}

/**
 * A proposal decision rebuilt field by field (RunManager's last line of defence; ipc.ts refuses bad shapes first):
 * approve keeps only string secrets (at most 100, values at most 4,000 chars), revise its feedback, decline its note;
 * anything else declines (nothing is applied).
 */
export function cleanProposalDecision(raw: unknown): ProposalDecision {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (d.behavior === 'approve') {
    const src = d.secrets && typeof d.secrets === 'object' && !Array.isArray(d.secrets) ? (d.secrets as Record<string, unknown>) : undefined
    const secrets: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [k, v] of Object.entries(src ?? {}).slice(0, PROPOSAL_SECRET_KEYS_MAX)) {
      if (typeof v === 'string' && v && v.length <= SECRET_VALUE_MAX && k.length <= 300) secrets[k] = v
    }
    return Object.keys(secrets).length ? { behavior: 'approve', secrets } : { behavior: 'approve' }
  }
  if (d.behavior === 'revise') return { behavior: 'revise', feedback: clip(d.feedback) }
  const note = clip(d.note).trim()
  return { behavior: 'decline', ...(note ? { note } : {}) }
}

/** The secret-free outcome of a decision (approve drops its secrets). */
export function proposalOutcome(d: ProposalDecision): ProposalOutcome {
  if (d.behavior === 'approve') return { behavior: 'approve' }
  return d.behavior === 'revise' ? { behavior: 'revise', feedback: d.feedback } : { behavior: 'decline', ...(d.note ? { note: d.note } : {}) }
}
