import type {
  McpInstallDecision,
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
  QuestionAnswer,
  RunEvent,
  UserQuestion
} from '@shared/types'

/**
 * The cards a live run holds open for the user, keyed by request id (RunManager's ActiveRun has these maps). Each
 * entry keeps the object its `*.request` event carried, so runs:pendingCards can hand them to a fresh renderer.
 */
export interface PendingCardMaps {
  pending: Map<string, { request: PermissionRequest; resolve: (d: PermissionDecision) => void }>
  pendingProposals: Map<string, { proposal: Proposal; resolve: (d: ProposalDecision) => void }>
  pendingQuestions: Map<string, { question: UserQuestion; resolve: (a: QuestionAnswer) => void }>
  pendingMerges: Map<string, { review: MergeReview; resolve: (d: MergeDecision) => void }>
  /** The install's own resolve broadcasts mcpInstall.resolved; `cancelled` adds the flag. */
  pendingInstalls: Map<string, { request: McpInstallRequest; resolve: (d: McpInstallDecision, cancelled?: boolean) => void }>
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
 * nothing. Returns how many cards it cancelled.
 */
export function cancelPending(cards: PendingCardMaps, runId: string, broadcast: (e: RunEvent) => void): number {
  let count = 0
  for (const [requestId, { resolve }] of cards.pending) {
    resolve({ behavior: 'deny', message: RUN_ENDED })
    broadcast({ type: 'permission.resolved', runId, requestId, cancelled: true })
    count++
  }
  cards.pending.clear()
  for (const [proposalId, { resolve }] of cards.pendingProposals) {
    const decision: ProposalDecision = { behavior: 'revise', feedback: RUN_ENDED }
    resolve(decision)
    broadcast({ type: 'proposal.resolved', runId, proposalId, decision, cancelled: true })
    count++
  }
  cards.pendingProposals.clear()
  for (const [questionId, q] of cards.pendingQuestions) {
    q.resolve({ selected: [] })
    broadcast({ type: 'question.resolved', runId, questionId, answer: { selected: [] }, cancelled: true })
    count++
  }
  cards.pendingQuestions.clear()
  for (const [requestId, r] of cards.pendingRules) {
    r.resolve({ behavior: 'deny', message: RUN_ENDED })
    broadcast({ type: 'rules.resolved', runId, requestId, decision: { behavior: 'deny', message: RUN_ENDED }, cancelled: true })
    count++
  }
  cards.pendingRules.clear()
  for (const [reviewId, { resolve }] of cards.pendingMerges) {
    resolve({ behavior: 'hold' })
    broadcast({ type: 'merge.resolved', runId, reviewId, decision: { behavior: 'hold' }, cancelled: true })
    count++
  }
  cards.pendingMerges.clear()
  // Cleared first so an mcp:answerInstall racing the end cannot resolve twice.
  const installs = [...cards.pendingInstalls.values()]
  cards.pendingInstalls.clear()
  for (const p of installs) {
    p.resolve({ approved: false, scope: 'run' }, true)
    count++
  }
  return count
}
