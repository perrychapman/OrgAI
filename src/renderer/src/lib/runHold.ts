import type { RunHold as MainRunHold, RunHoldAction, RunHoldKind, RunPlan, RunSummary } from '@shared/types'
import { connectionLabel } from './connectionLabel'
import { formatUntil } from './layout'
import { money } from './usage'

/**
 * The hold actions that ask first (focus on Cancel, a confirmation that names what happens): each one starts a new
 * provider turn, raises a limit or skips a gate, so it can spend or weaken a check. Switching the model only moves focus,
 * and ending keeps the work.
 */
const HOLD_ACTIONS_THAT_ASK: ReadonlySet<RunHoldAction> = new Set<RunHoldAction>(['resume', 'addBudget', 'retry', 'skipReview'])

/** True when the card must confirm before this action runs. */
export function holdActionAsks(action: RunHoldAction): boolean {
  return HOLD_ACTIONS_THAT_ASK.has(action)
}

/**
 * What stopped a run, as the "what stopped the run" card shows it. Pure; the card owns actions and the clock.
 * The six kinds come from main (`RunSummary.hold`); 'failed' is the fallback for an ended run with an error and no hold.
 */
export type HoldKind = RunHoldKind | 'failed'
export type HoldTone = 'waiting' | 'retrying' | 'failed'

export interface HoldFact {
  label: string
  value: string
}

export interface RunHoldView {
  kind: HoldKind
  /** The state pill word. */
  word: string
  tone: HoldTone
  title: string
  text: string
  facts: HoldFact[]
  /** The reassurance at the right of the pill. */
  safe: string
  /** Exactly the actions main accepts (hold.actions); derived from the old summary fields when main sent no hold. */
  actions: RunHoldAction[]
  /** The run's own limit in USD for kind 'budget' / 'spend-limit' (the amount field's default). */
  limitUsd?: number
}

export interface HoldExtras {
  /** Wall clock for "in 12m"; defaults to Date.now(). */
  now?: number
  /** True while the run's session is open (a failure only holds a run that is no longer open). */
  sessionOpen?: boolean
}

type SummaryFields = Pick<RunSummary, 'status' | 'pausedUntil' | 'pauseReason' | 'autoResume' | 'error'> & { hold?: MainRunHold }
type PlanFields = Pick<RunPlan, 'status' | 'blockedReason'>

const SAFE = 'Nothing is lost while it waits'
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const day = (at: number): string => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

const SCOPE_WORDS: Record<NonNullable<MainRunHold['budget']>['scope'], string> = {
  run: 'for this run',
  conversation: 'for this conversation',
  day: 'for today',
  month: 'for this month'
}

function usageFacts(summary: SummaryFields, now: number): HoldFact[] {
  const facts: HoldFact[] = []
  const until = summary.pausedUntil
  if (until) {
    facts.push({ label: summary.autoResume ? 'Resumes at' : 'Resets at', value: clock(until) })
    facts.push({ label: 'In', value: formatUntil(until, now) })
  }
  facts.push({ label: 'Auto-resume', value: summary.autoResume ? 'On' : 'Off' })
  return facts
}

function fromHold(h: MainRunHold, summary: SummaryFields, now: number): RunHoldView {
  const since: HoldFact = { label: 'Since', value: day(h.since) }
  switch (h.kind) {
    case 'budget':
    case 'spend-limit': {
      const b = h.budget
      const facts: HoldFact[] = []
      let title = h.kind === 'budget' ? 'Paused at the spending limit' : 'Paused at the project spending limit'
      if (b) {
        title = `Paused at the ${money(b.limitUsd)} limit ${SCOPE_WORDS[b.scope]}`
        facts.push({ label: 'Spent', value: money(b.spentUsd) }, { label: 'Limit', value: money(b.limitUsd) })
        if (b.resetsAt) facts.push({ label: 'Resets', value: day(b.resetsAt) })
      }
      facts.push(since)
      return { kind: h.kind, word: 'Paused', tone: 'waiting', title, text: h.reason, facts, safe: SAFE, actions: h.actions, limitUsd: b?.limitUsd }
    }
    case 'usage-limit':
      return {
        kind: h.kind,
        word: 'Paused',
        tone: 'waiting',
        title: 'Waiting for your plan limit to reset',
        text: h.reason,
        facts: [...usageFacts(summary, now), since],
        safe: SAFE,
        actions: h.actions
      }
    case 'provider': {
      const p = h.provider
      const facts: HoldFact[] = []
      if (p?.connection) facts.push({ label: 'Connection', value: connectionLabel(p.connection) })
      if (p?.lastOkAt) facts.push({ label: 'Last worked', value: day(p.lastOkAt) })
      if (p?.error) facts.push({ label: 'Last answer', value: p.error })
      facts.push(since)
      return {
        kind: h.kind,
        word: 'Waiting',
        tone: 'waiting',
        title: p?.connection ? `Can't reach ${connectionLabel(p.connection)}` : "Can't reach the provider",
        text: h.reason,
        facts,
        safe: SAFE,
        actions: h.actions
      }
    }
    case 'agent-failed': {
      const f = h.failed
      const facts: HoldFact[] = []
      if (f?.name) facts.push({ label: 'Agent', value: f.name })
      if (f?.costUsd !== undefined) facts.push({ label: 'Cost', value: money(f.costUsd) })
      facts.push(since)
      return { kind: h.kind, word: 'Failed', tone: 'failed', title: `${f?.name ?? 'An agent'} failed`, text: h.reason, facts, safe: 'The rest of the run is kept', actions: h.actions }
    }
    case 'plan-blocked':
      return {
        kind: h.kind,
        word: 'Waiting',
        tone: 'waiting',
        title: 'The orchestrator needs your decision',
        text: h.plan?.blockedReason ?? h.reason,
        facts: [since],
        safe: 'Automatic continues are stopped',
        actions: h.actions
      }
  }
}

/** What holds the run, or null. Main's `summary.hold` first; without one: a usage-limit pause, a blocked plan, then a failure. */
export function holdOf(summary: SummaryFields | undefined | null, plan?: PlanFields | null, extras: HoldExtras = {}): RunHoldView | null {
  if (!summary) return null
  const now = extras.now ?? Date.now()
  if (summary.hold) return fromHold(summary.hold, summary, now)

  if (summary.status === 'paused') {
    return {
      kind: 'usage-limit',
      word: 'Paused',
      tone: 'waiting',
      title: 'Waiting for your plan limit to reset',
      text: `${summary.pauseReason ?? 'The plan usage limit was reached.'} Only this run is paused; your other runs keep running unaffected.${
        summary.autoResume ? '' : ' Auto-resume is off. Continue it when you are ready.'
      }`,
      facts: usageFacts(summary, now),
      safe: SAFE,
      actions: ['resume', 'switchModel', 'end']
    }
  }

  if (plan?.status === 'blocked') {
    return {
      kind: 'plan-blocked',
      word: 'Waiting',
      tone: 'waiting',
      title: 'The orchestrator needs your decision',
      text: plan.blockedReason ?? 'It marked the plan blocked.',
      facts: [],
      safe: 'Automatic continues are stopped',
      actions: []
    }
  }

  if (!extras.sessionOpen && summary.error) {
    return { kind: 'failed', word: 'Failed', tone: 'failed', title: 'This run failed', text: summary.error, facts: [], safe: 'Your work so far is kept', actions: [] }
  }

  return null
}
