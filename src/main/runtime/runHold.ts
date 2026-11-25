import type { AgentInstance, ConnectionId, RunHold, RunHoldAction, RunHoldKind, RunPlan } from '@shared/types'
import { clampText } from '../capabilities/sanitize'
import { money, type CapReached } from './spendGuard'

/**
 * UI overhaul run holds (RunSummary.hold, docs/design/ui-overhaul/impl-runtime.md): the pure side. Builds the RunHold a run
 * stopped waiting on the user gets, and decides which actions main accepts for it right now. RunManager gathers the facts
 * (is the session open, is a cap reached) and stores / broadcasts the result. Every reason is an OrgAI-written sentence:
 * never a provider's or an agent's own words (the plan's blockedReason is carried as data in `plan`, not as the reason).
 */

/** What decides the actions of a hold right now. */
export interface HoldFacts {
  /** The session is open (starting, running or idle). */
  live: boolean
  /** The run is paused (status 'paused'). */
  paused: boolean
  /** The run has a provider session or a saved model selection to continue from (continueRun's own rule). */
  continuable: boolean
  /** A daily or monthly cap of the project is reached now (a continuation would be refused). */
  capReached: boolean
  /** The hold is a budget stop on an unknown price: raising the limit cannot help, so 'addBudget' is never offered. */
  unpriced?: boolean
}

/** Kinds that belong to a live run (the user answers the run itself, the session stays open). */
export function isLiveHoldKind(kind: RunHoldKind): boolean {
  return kind === 'plan-blocked' || kind === 'agent-failed'
}

/**
 * The actions main accepts for a hold of `kind` right now. Only what the run can really do:
 * - 'addBudget' and 'retry' need an ended run that can continue and no cap in the way (continueRun refuses otherwise);
 *   'addBudget' is also never offered for a budget hold on an unknown price (`facts.unpriced`);
 * - 'resume' only a paused run; 'switchModel' is always saved for the next continuation (never for a live run's hold);
 * - 'end' only while the session is open.
 */
export function holdActionsFor(kind: RunHoldKind, f: HoldFacts): RunHoldAction[] {
  const out: RunHoldAction[] = []
  const canContinue = !f.live && f.continuable && !f.capReached
  switch (kind) {
    case 'budget':
      // An unpriced stop is not a limit that was used up: more budget would only buy uncounted spend (see budgetHold).
      if (canContinue && !f.unpriced) out.push('addBudget')
      if (!f.live) out.push('switchModel')
      break
    case 'spend-limit':
      if (canContinue) out.push(f.paused ? 'resume' : 'retry')
      if (!f.live) out.push('switchModel')
      break
    case 'usage-limit':
      if (!f.live && f.continuable && f.paused && !f.capReached) out.push('resume')
      else if (canContinue) out.push('retry')
      if (!f.live) out.push('switchModel')
      break
    case 'provider':
    case 'agent-failed':
    case 'plan-blocked':
      if (canContinue) out.push('retry')
      if (!f.live) out.push('switchModel')
      break
  }
  if (f.live) out.push('end')
  return out
}

/** One bounded line of agent-written text kept as data (never as a sentence of ours). */
function dataText(s: unknown, max: number): string | undefined {
  const t = clampText(s, max)
  return t || undefined
}

/**
 * The run stopped on its own spending limit ('run': its per-run cap, 'conversation': the model-handoff chain's total).
 * `unpriced`: it did not use the limit up; part of its cost has no known price, so the limit could not be enforced and the
 * run stopped (the money shown is the known part only). The reason then says so instead of "used all of".
 */
export function budgetHold(input: { scope: 'run' | 'conversation'; limitUsd: number; spentUsd: number; since: number; facts: HoldFacts; unpriced?: boolean }): RunHold {
  const what = input.scope === 'run' ? "this run's spending limit" : "this conversation's spending limit"
  const unpriced = input.unpriced === true
  return {
    kind: 'budget',
    since: input.since,
    reason: unpriced
      ? `The run stopped because part of it used a model with no known price, so its cost cannot be counted against ${what} (${money(input.limitUsd)}). Set a price for that model in Settings, or remove the limit.`
      : `The run stopped because it used all of ${what} (${money(input.limitUsd)}).`,
    budget: { scope: input.scope, limitUsd: input.limitUsd, spentUsd: input.spentUsd, ...(unpriced ? { unpriced: true as const } : {}) },
    actions: holdActionsFor('budget', { ...input.facts, unpriced })
  }
}

/** The run reached the project's daily or monthly cap. `reason` is the sentence RunManager also logs (spendLimitReason). */
export function spendLimitHold(input: { cap: CapReached; reason: string; since: number; facts: HoldFacts }): RunHold {
  return {
    kind: 'spend-limit',
    since: input.since,
    reason: input.reason,
    budget: { scope: input.cap.scope, limitUsd: input.cap.limitUsd, spentUsd: input.cap.spentUsd, resetsAt: input.cap.resetsAt },
    actions: holdActionsFor('spend-limit', input.facts)
  }
}

/** The provider's plan window is used up; status 'paused', the run continues at its reset (today's behaviour). */
export function usageLimitHold(input: { since: number; facts: HoldFacts }): RunHold {
  return {
    kind: 'usage-limit',
    since: input.since,
    reason: "The provider's usage limit was reached, so the run is paused until it resets.",
    actions: holdActionsFor('usage-limit', input.facts)
  }
}

/** The run ended in an error from the provider or the connection. Never the provider's own text. */
export function providerHold(input: { connection?: ConnectionId; auth: boolean; lastOkAt?: number; tries?: number; since: number; facts: HoldFacts }): RunHold {
  const error = input.auth ? 'The provider did not accept the sign-in for this connection.' : 'The provider could not be reached or answered with an error.'
  return {
    kind: 'provider',
    since: input.since,
    reason: input.auth ? `${error} Sign in again, then retry.` : `${error} Retry, or choose another model.`,
    provider: {
      ...(input.connection ? { connection: input.connection } : {}),
      error,
      ...(input.lastOkAt !== undefined ? { lastOkAt: input.lastOkAt } : {}),
      // How many times the provider SDK retried before giving up (provider.retry); absent when none was reported.
      ...(input.tries !== undefined && Number.isInteger(input.tries) && input.tries > 0 ? { tries: input.tries } : {})
    },
    actions: holdActionsFor('provider', input.facts)
  }
}

/**
 * The agent a blocked plan is waiting on: a failed (state 'error') non-root agent a blocked step names as its owner (role
 * slug, handle or name), else the only failed non-root agent. Null when none is identifiable.
 */
export function failedAgentFor(plan: RunPlan, agents: readonly AgentInstance[], rootId: string): AgentInstance | null {
  const failed = agents.filter((a) => a.state === 'error' && a.id !== rootId)
  if (!failed.length) return null
  const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase()
  const owners = plan.steps.filter((s) => s.status === 'blocked' && s.owner).map((s) => norm(s.owner))
  for (const o of owners) {
    const hit = failed.find((a) => o && (norm(a.roleSlug) === o || norm(a.handle) === o || norm(a.name) === o))
    if (hit) return hit
  }
  return failed.length === 1 ? failed[0] : null
}

/**
 * The hold a blocked plan puts on a live run: 'agent-failed' when a failed agent is identifiable, else 'plan-blocked'.
 * Null when the plan is not blocked.
 */
export function planHold(input: { plan: RunPlan | undefined; agents: readonly AgentInstance[]; rootId: string; since: number; facts: HoldFacts }): RunHold | null {
  const { plan } = input
  if (!plan || plan.status !== 'blocked') return null
  const blockedStepIds = plan.steps.filter((s) => s.status === 'blocked').map((s) => s.id).slice(0, 50)
  const blockedReason = dataText(plan.blockedReason, 500)
  const planPart = { ...(blockedReason ? { blockedReason } : {}), ...(blockedStepIds.length ? { blockedStepIds } : {}) }
  const failed = failedAgentFor(plan, input.agents, input.rootId)
  if (failed) {
    const name = dataText(failed.name, 80) ?? 'An agent'
    return {
      kind: 'agent-failed',
      since: input.since,
      reason: `${name} failed, so the plan is blocked until you decide what to do.`,
      failed: { agentId: failed.id, roleId: failed.roleId, name, ...(Number.isFinite(failed.costUsd) ? { costUsd: failed.costUsd } : {}) },
      plan: planPart,
      actions: holdActionsFor('agent-failed', input.facts)
    }
  }
  return {
    kind: 'plan-blocked',
    since: input.since,
    reason: 'The orchestrator marked the plan blocked and needs your decision before it can go on.',
    plan: planPart,
    actions: holdActionsFor('plan-blocked', input.facts)
  }
}

/** Two holds say the same thing (ignoring when they began): nothing needs to be sent again. */
export function sameHold(a: RunHold | undefined | null, b: RunHold | undefined | null): boolean {
  if (!a || !b) return !a && !b
  const strip = (h: RunHold): string => JSON.stringify({ ...h, since: 0 })
  return strip(a) === strip(b)
}
