import type { McpInstallRequest, MergeReview, PermissionRequest, PermissionRuleRequest, Proposal, UserQuestion } from '@shared/types'

/** Mirrors the main-process `PendingCards` (runs:pendingCards). Declared locally until that contract is merged. */
export interface PendingCards {
  permissions: PermissionRequest[]
  questions: UserQuestion[]
  proposals: Proposal[]
  ruleRequests: PermissionRuleRequest[]
  mergeReviews: MergeReview[]
  mcpInstalls: McpInstallRequest[]
}

export interface HeldCards {
  permissions: PermissionRequest[]
  questions?: UserQuestion[]
  proposals: Proposal[]
  ruleRequests?: PermissionRuleRequest[]
  mergeReviews?: MergeReview[]
  mcpInstalls?: McpInstallRequest[]
}

/** Appends seeded items whose id is not held yet; a *.request event may have raced the pendingCards call. */
export function mergeById<T extends { id: string }>(held: T[] | undefined, seeded: T[] | undefined): T[] {
  const base = held ?? []
  if (!seeded?.length) return base
  const ids = new Set(base.map((c) => c.id))
  const extra = seeded.filter((c) => !ids.has(c.id))
  return extra.length ? [...base, ...extra] : base
}

/** Folds a pendingCards answer into a run's held card arrays. */
export function mergePendingCards(held: HeldCards, seeded: Partial<PendingCards>): Required<HeldCards> {
  return {
    permissions: mergeById(held.permissions, seeded.permissions),
    questions: mergeById(held.questions, seeded.questions),
    proposals: mergeById(held.proposals, seeded.proposals),
    ruleRequests: mergeById(held.ruleRequests, seeded.ruleRequests),
    mergeReviews: mergeById(held.mergeReviews, seeded.mergeReviews),
    mcpInstalls: mergeById(held.mcpInstalls, seeded.mcpInstalls)
  }
}
