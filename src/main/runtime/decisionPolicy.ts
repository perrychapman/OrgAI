/**
 * Headless decision policy (cli-spec 6.2(1)): what RunManager does with a decision card on an `orgai exec` run when
 * nobody answers it. Pure: the caller (RunManager) applies the decision through the same decision method a human
 * would use, with `decidedBy: { surface: 'policy' }`, and owns the timers and the auto-denial count.
 */
import type {
  CardKind,
  HeadlessDecisionPolicy,
  McpInstallDecision,
  MergeDecision,
  PermissionDecision,
  PermissionRuleDecision,
  ProposalDecision,
  QuestionAnswer,
  UserQuestion
} from '@shared/types'
import { DEFAULT_HEADLESS_DECISION_POLICY, HEADLESS_POLICY_DENY_MESSAGE, RECOMMENDED_OPTION_PREFIX } from '@shared/types'

/** The decision a policy applies, per card kind. */
export interface PolicyDecisions {
  permission: PermissionDecision
  rules: PermissionRuleDecision
  proposal: ProposalDecision
  question: QuestionAnswer
  merge: MergeDecision
  mcpInstall: McpInstallDecision
}

export type PolicyAction<K extends CardKind = CardKind> =
  | { kind: 'resolve'; decision: PolicyDecisions[K] }
  /** End the run as 'needs-decision' now. */
  | { kind: 'fail' }
  /** Leave the card for a human, up to waitTimeoutMs. */
  | { kind: 'wait' }

/** The note a declined proposal carries back to the agent. */
export const HEADLESS_POLICY_DECLINE_NOTE = 'Declined by the headless decision policy (orgai exec); nobody can review proposals in this run.'

/** A partial or missing policy with every default filled in. */
export function fullPolicy(policy: Partial<HeadlessDecisionPolicy> | undefined): Required<HeadlessDecisionPolicy> {
  const out: Required<HeadlessDecisionPolicy> = { ...DEFAULT_HEADLESS_DECISION_POLICY }
  if (!policy) return out
  for (const [k, v] of Object.entries(policy) as [keyof HeadlessDecisionPolicy, unknown][]) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/**
 * The conservative pick of a question: the first option whose label or description starts with
 * RECOMMENDED_OPTION_PREFIX, or that carries a truthy `isDefault` (not part of UserQuestion today; honoured if an
 * adapter sends it). undefined when there is none.
 */
export function recommendedOption(question: Pick<UserQuestion, 'options'>): string | undefined {
  for (const o of question.options ?? []) {
    if (!o || typeof o.label !== 'string') continue
    const isDefault = (o as { isDefault?: unknown }).isDefault
    if (isDefault) return o.label
    if (o.label.trimStart().startsWith(RECOMMENDED_OPTION_PREFIX)) return o.label
    if (typeof o.description === 'string' && o.description.trimStart().startsWith(RECOMMENDED_OPTION_PREFIX)) return o.label
  }
  return undefined
}

/** What the policy does with one card. `card` is the card's request object (only questions are read). */
export function policyAction<K extends CardKind>(kind: K, card: unknown, policy: Partial<HeadlessDecisionPolicy> | undefined): PolicyAction<K> {
  const p = fullPolicy(policy)
  const choice = p[kind]
  if (choice === 'fail') return { kind: 'fail' }
  if (choice === 'wait') return { kind: 'wait' }
  const resolve = <T extends PolicyDecisions[K]>(decision: T): PolicyAction<K> => ({ kind: 'resolve', decision })
  switch (kind) {
    case 'permission':
      return choice === 'deny' ? resolve({ behavior: 'deny', message: HEADLESS_POLICY_DENY_MESSAGE } as PolicyDecisions[K]) : { kind: 'fail' }
    case 'rules':
      return choice === 'deny' ? resolve({ behavior: 'deny', message: HEADLESS_POLICY_DENY_MESSAGE } as PolicyDecisions[K]) : { kind: 'fail' }
    case 'proposal':
      return choice === 'decline' ? resolve({ behavior: 'decline', note: HEADLESS_POLICY_DECLINE_NOTE } as PolicyDecisions[K]) : { kind: 'fail' }
    case 'mcpInstall':
      return choice === 'deny' ? resolve({ approved: false, scope: 'run', note: HEADLESS_POLICY_DENY_MESSAGE } as PolicyDecisions[K]) : { kind: 'fail' }
    case 'merge':
      return choice === 'hold' ? resolve({ behavior: 'hold' } as PolicyDecisions[K]) : { kind: 'fail' }
    case 'question': {
      if (choice !== 'conservative') return { kind: 'fail' }
      const label = card && typeof card === 'object' ? recommendedOption(card as UserQuestion) : undefined
      return label !== undefined ? resolve({ selected: [label] } as PolicyDecisions[K]) : { kind: 'fail' }
    }
    default:
      return { kind: 'fail' }
  }
}

/** Whether a policy resolution counts toward maxAutoDenials (every refusal does; a conservative answer does not). */
export function countsAsDenial(kind: CardKind): boolean {
  return kind !== 'question'
}
