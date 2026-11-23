import { describe, expect, it } from 'vitest'
import type { AgentInstance, RunPlan } from '@shared/types'
import { budgetHold, failedAgentFor, holdActionsFor, isLiveHoldKind, planHold, providerHold, sameHold, spendLimitHold, usageLimitHold, type HoldFacts } from './runHold'

const ended: HoldFacts = { live: false, paused: false, continuable: true, capReached: false }
const live: HoldFacts = { live: true, paused: false, continuable: true, capReached: false }

function agent(over: Partial<AgentInstance> & { id: string }): AgentInstance {
  return {
    roleId: 'r-eng',
    roleSlug: 'engineer',
    name: 'Engineer',
    parentId: 'root',
    spawnToolUseId: null,
    state: 'error',
    activity: '',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0.5,
    startedAt: 0,
    ...over
  }
}

function plan(over: Partial<RunPlan> = {}): RunPlan {
  return {
    goal: 'Ship',
    steps: [{ id: 'p1', title: 'Build', status: 'blocked', owner: 'engineer' }, { id: 'p2', title: 'Test', status: 'pending' }],
    status: 'blocked',
    blockedReason: 'Need a decision on the schema',
    autoContinues: 0,
    updatedAt: 1,
    ...over
  }
}

describe('holdActionsFor', () => {
  it('a budget hold on an ended run offers add budget and a model switch, never retry or end', () => {
    expect(holdActionsFor('budget', ended)).toEqual(['addBudget', 'switchModel'])
  })

  it('offers nothing that continueRun would refuse: no add budget with a cap reached or no session to continue', () => {
    expect(holdActionsFor('budget', { ...ended, capReached: true })).toEqual(['switchModel'])
    expect(holdActionsFor('budget', { ...ended, continuable: false })).toEqual(['switchModel'])
  })

  it('a spend-limit pause resumes only once no cap is reached; an ended one retries', () => {
    expect(holdActionsFor('spend-limit', { ...ended, paused: true, capReached: true })).toEqual(['switchModel'])
    expect(holdActionsFor('spend-limit', { ...ended, paused: true })).toEqual(['resume', 'switchModel'])
    expect(holdActionsFor('spend-limit', ended)).toEqual(['retry', 'switchModel'])
  })

  it('a usage-limit pause keeps resume and switchModel', () => {
    expect(holdActionsFor('usage-limit', { ...ended, paused: true })).toEqual(['resume', 'switchModel'])
  })

  it('provider, agent-failed and plan-blocked retry once ended and only end while live', () => {
    for (const kind of ['provider', 'agent-failed', 'plan-blocked'] as const) {
      expect(holdActionsFor(kind, ended)).toEqual(['retry', 'switchModel'])
      expect(holdActionsFor(kind, live)).toEqual(['end'])
    }
  })

  it('knows which holds belong to a live run', () => {
    expect(isLiveHoldKind('plan-blocked')).toBe(true)
    expect(isLiveHoldKind('agent-failed')).toBe(true)
    expect(isLiveHoldKind('budget')).toBe(false)
  })
})

describe('hold builders', () => {
  it('budget: OrgAI words and the figures', () => {
    const h = budgetHold({ scope: 'run', limitUsd: 5, spentUsd: 5.1, since: 9, facts: ended })
    expect(h).toMatchObject({ kind: 'budget', since: 9, budget: { scope: 'run', limitUsd: 5, spentUsd: 5.1 } })
    expect(h.reason).toContain('$5.00')
    expect(budgetHold({ scope: 'conversation', limitUsd: 5, spentUsd: 5, since: 1, facts: ended }).reason).toContain('conversation')
  })

  it('spend limit carries the period and when it resets', () => {
    const h = spendLimitHold({ cap: { scope: 'day', limitUsd: 5, spentUsd: 5, resetsAt: 77 }, reason: 'why', since: 1, facts: ended })
    expect(h).toMatchObject({ kind: 'spend-limit', reason: 'why', budget: { scope: 'day', limitUsd: 5, spentUsd: 5, resetsAt: 77 } })
  })

  it('usage limit and provider say fixed sentences, never a provider message', () => {
    expect(usageLimitHold({ since: 1, facts: { ...ended, paused: true } }).reason).toContain('usage limit')
    const auth = providerHold({ connection: 'anthropic', auth: true, since: 1, facts: ended })
    expect(auth.reason).toContain('Sign in again')
    expect(auth.provider).toMatchObject({ connection: 'anthropic' })
    const other = providerHold({ auth: false, lastOkAt: 3, since: 1, facts: ended })
    expect(other.provider).toEqual({ error: 'The provider could not be reached or answered with an error.', lastOkAt: 3 })
  })
})

describe('plan holds', () => {
  it('is plan-blocked when no failed agent is identifiable, keeping the orchestrator text as data only', () => {
    const h = planHold({ plan: plan(), agents: [], rootId: 'root', since: 1, facts: live })!
    expect(h.kind).toBe('plan-blocked')
    expect(h.plan).toEqual({ blockedReason: 'Need a decision on the schema', blockedStepIds: ['p1'] })
    expect(h.reason).not.toContain('schema')
    expect(h.actions).toEqual(['end'])
  })

  it('is agent-failed when the blocked step names a failed agent', () => {
    const agents = [agent({ id: 'a1' }), agent({ id: 'a2', roleSlug: 'reviewer', name: 'Reviewer' })]
    const h = planHold({ plan: plan(), agents, rootId: 'root', since: 1, facts: live })!
    expect(h.kind).toBe('agent-failed')
    expect(h.failed).toEqual({ agentId: 'a1', roleId: 'r-eng', name: 'Engineer', costUsd: 0.5 })
  })

  it('a single failed agent is identifiable even without an owner; two are not', () => {
    const noOwner = plan({ steps: [{ id: 'p1', title: 'x', status: 'blocked' }] })
    expect(failedAgentFor(noOwner, [agent({ id: 'a1' })], 'root')?.id).toBe('a1')
    expect(failedAgentFor(noOwner, [agent({ id: 'a1' }), agent({ id: 'a2' })], 'root')).toBeNull()
    expect(failedAgentFor(noOwner, [agent({ id: 'root', state: 'error' })], 'root')).toBeNull()
    expect(failedAgentFor(noOwner, [agent({ id: 'a1', state: 'done' })], 'root')).toBeNull()
  })

  it('is null unless the plan is blocked', () => {
    expect(planHold({ plan: plan({ status: 'active' }), agents: [], rootId: 'root', since: 1, facts: live })).toBeNull()
    expect(planHold({ plan: undefined, agents: [], rootId: 'root', since: 1, facts: live })).toBeNull()
  })

  it('bounds and cleans an agent-written reason and name', () => {
    const h = planHold({ plan: plan({ blockedReason: `a\u0000b${'x'.repeat(900)}` }), agents: [], rootId: 'root', since: 1, facts: live })!
    expect(h.plan?.blockedReason?.length).toBeLessThanOrEqual(500)
    expect(h.plan?.blockedReason).not.toContain('\u0000')
  })
})

describe('sameHold', () => {
  it('ignores when it began but not the figures or the actions', () => {
    const a = budgetHold({ scope: 'run', limitUsd: 5, spentUsd: 5, since: 1, facts: ended })
    expect(sameHold(a, { ...a, since: 99 })).toBe(true)
    expect(sameHold(a, { ...a, actions: ['end'] })).toBe(false)
    expect(sameHold(a, budgetHold({ scope: 'run', limitUsd: 6, spentUsd: 5, since: 1, facts: ended }))).toBe(false)
    expect(sameHold(undefined, null)).toBe(true)
    expect(sameHold(a, undefined)).toBe(false)
  })
})
