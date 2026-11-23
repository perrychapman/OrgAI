import type { RunPlan, RunSummary } from '@shared/types'
import { formatUntil } from './layout'

/** What stopped a run, as the "what stopped the run" card shows it. Pure; the card owns actions and the clock. */
export type HoldKind = 'usage-limit' | 'plan-blocked' | 'failed' | 'budget' | 'provider' | 'agent-failed'
export type HoldTone = 'waiting' | 'retrying' | 'failed'

export interface HoldFact {
  label: string
  value: string
}

export interface RunHold {
  kind: HoldKind
  /** The state pill word. */
  word: string
  tone: HoldTone
  title: string
  text: string
  facts: HoldFact[]
  /** The reassurance at the right of the pill. */
  safe: string
}

/** Data the runtime will supply for the kinds that do not come from the summary today. */
export interface HoldExtras {
  /** Wall clock for "in 12m"; defaults to Date.now(). */
  now?: number
  /** True while the run's session is open (a failure only holds a run that is no longer open). */
  sessionOpen?: boolean
  budget?: { spentUsd: number; capUsd: number; reason?: string }
  provider?: { name: string; reason: string; retryAt?: number; retrying?: boolean }
  agentFailed?: { agent: string; reason: string; model?: string }
}

type SummaryFields = Pick<RunSummary, 'status' | 'pausedUntil' | 'pauseReason' | 'autoResume' | 'error'>
type PlanFields = Pick<RunPlan, 'status' | 'blockedReason'>

const SAFE = 'Nothing is lost while it waits'
const usd = (n: number): string => `$${n.toFixed(2)}`
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** What holds the run, or null. Order: a usage-limit pause, then runtime holds, then a blocked plan, then a failure. */
export function holdOf(summary: SummaryFields | undefined | null, plan?: PlanFields | null, extras: HoldExtras = {}): RunHold | null {
  if (!summary) return null
  const now = extras.now ?? Date.now()

  if (summary.status === 'paused') {
    const until = summary.pausedUntil
    const facts: HoldFact[] = []
    if (until) {
      facts.push({ label: summary.autoResume ? 'Resumes at' : 'Resets at', value: clock(until) })
      facts.push({ label: 'In', value: formatUntil(until, now) })
    }
    facts.push({ label: 'Auto-resume', value: summary.autoResume ? 'On' : 'Off' })
    return {
      kind: 'usage-limit',
      word: 'Paused',
      tone: 'waiting',
      title: 'Waiting for your plan limit to reset',
      text: `${summary.pauseReason ?? 'The plan usage limit was reached.'} Only this run is paused; your other runs keep running unaffected.${
        summary.autoResume ? '' : ' Auto-resume is off. Continue it when you are ready.'
      }`,
      facts,
      safe: SAFE
    }
  }

  if (extras.budget) {
    const { spentUsd, capUsd, reason } = extras.budget
    return {
      kind: 'budget',
      word: 'Paused',
      tone: 'waiting',
      title: 'The spending limit was reached',
      text: reason ?? 'The run stopped before it went over its spending limit.',
      facts: [
        { label: 'Spent', value: usd(spentUsd) },
        { label: 'Limit', value: usd(capUsd) }
      ],
      safe: SAFE
    }
  }

  if (extras.provider) {
    const p = extras.provider
    const facts: HoldFact[] = [{ label: 'Provider', value: p.name }]
    if (p.retryAt) facts.push({ label: 'Next try in', value: formatUntil(p.retryAt, now) })
    return {
      kind: 'provider',
      word: p.retrying ? 'Retrying' : 'Waiting',
      tone: p.retrying ? 'retrying' : 'waiting',
      title: `${p.name} is not answering`,
      text: p.reason,
      facts,
      safe: SAFE
    }
  }

  if (extras.agentFailed) {
    const a = extras.agentFailed
    const facts: HoldFact[] = [{ label: 'Agent', value: a.agent }]
    if (a.model) facts.push({ label: 'Model', value: a.model })
    return { kind: 'agent-failed', word: 'Failed', tone: 'failed', title: `${a.agent} could not finish`, text: a.reason, facts, safe: 'The rest of the run is kept' }
  }

  if (plan?.status === 'blocked') {
    return {
      kind: 'plan-blocked',
      word: 'Waiting',
      tone: 'waiting',
      title: 'The orchestrator needs your decision',
      text: plan.blockedReason ?? 'It marked the plan blocked.',
      facts: [],
      safe: 'Automatic continues are stopped'
    }
  }

  if (!extras.sessionOpen && summary.error) {
    return { kind: 'failed', word: 'Failed', tone: 'failed', title: 'This run failed', text: summary.error, facts: [], safe: 'Your work so far is kept' }
  }

  return null
}
