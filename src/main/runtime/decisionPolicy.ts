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
  QuestionAnswer
} from '@shared/types'
import { DEFAULT_HEADLESS_DECISION_POLICY, HEADLESS_POLICY_DENY_MESSAGE } from '@shared/types'

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
 * The conservative answer to a question (review Low): no option is selected. Every option, its label, description and
 * any "(Recommended)" mark or `isDefault` flag, is written by the agent that asks, so following one would let the agent
 * steer its own answer. The agent is told instead that nobody can answer and to take the most cautious path.
 */
export const HEADLESS_CONSERVATIVE_ANSWER =
  'Nobody can answer questions in this run (orgai exec, --on-question conservative), and no option was chosen for you. ' +
  'Do not treat any option as approved. Take the most cautious path that needs no decision and changes nothing that cannot be undone, ' +
  'or stop and say what decision you need.'

/** The conservative policy's answer: never an option, only HEADLESS_CONSERVATIVE_ANSWER as text. */
export function conservativeAnswer(): QuestionAnswer {
  return { selected: [], text: HEADLESS_CONSERVATIVE_ANSWER }
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
    case 'question':
      // The card's options are never read: they are agent-authored (see HEADLESS_CONSERVATIVE_ANSWER).
      return choice === 'conservative' ? resolve(conservativeAnswer() as PolicyDecisions[K]) : { kind: 'fail' }
    default:
      return { kind: 'fail' }
  }
}

/**
 * Whether a policy resolution counts toward maxAutoDenials ("auto-denials/declines"): every refusal does. A conservative
 * answer does not, and neither does a merge 'hold', which keeps the report's branch for review and refuses nothing
 * (a reviewMerges exec run holds one per report and must not end after maxAutoDenials of them).
 */
export function countsAsDenial(kind: CardKind): boolean {
  return kind !== 'question' && kind !== 'merge'
}
