import { describe, expect, it } from 'vitest'
import type { RunHold } from '@shared/types'
import { holdOf } from './runHold'

const base = { status: 'running' as const }
const mk = (h: Partial<RunHold> & Pick<RunHold, 'kind'>): RunHold => ({ since: 1_000_000, reason: 'Because.', actions: [], ...h })

describe('holdOf fallbacks (no summary.hold)', () => {
  it('is null for a healthy run', () => {
    expect(holdOf(base, { status: 'active' })).toBeNull()
    expect(holdOf(undefined)).toBeNull()
  })
  it('describes a usage limit with auto-resume', () => {
    const now = 1_000_000
    const h = holdOf({ status: 'paused', pausedUntil: now + 12 * 60_000, autoResume: true }, null, { now })
    expect(h?.kind).toBe('usage-limit')
    expect(h?.facts).toContainEqual({ label: 'In', value: '12m' })
    expect(h?.facts).toContainEqual({ label: 'Auto-resume', value: 'On' })
    expect(h?.actions).toContain('resume')
  })
  it('says auto-resume is off', () => {
    const h = holdOf({ status: 'paused', autoResume: false }, null)
    expect(h?.facts).toEqual([{ label: 'Auto-resume', value: 'Off' }])
    expect(h?.text).toContain('Auto-resume is off')
  })
  it('a pause wins over a blocked plan', () => {
    expect(holdOf({ status: 'paused' }, { status: 'blocked' })?.kind).toBe('usage-limit')
  })
  it('describes a blocked plan', () => {
    const h = holdOf(base, { status: 'blocked', blockedReason: 'Pick a database' })
    expect(h).toMatchObject({ kind: 'plan-blocked', text: 'Pick a database' })
    expect(holdOf(base, { status: 'blocked' })?.text).toBe('It marked the plan blocked.')
  })
  it('describes a failed run only when the session is closed', () => {
    const s = { status: 'error' as const, error: 'boom' }
    expect(holdOf(s, null)).toMatchObject({ kind: 'failed', title: 'This run failed', text: 'boom', tone: 'failed' })
    expect(holdOf(s, null, { sessionOpen: true })).toBeNull()
  })
})

describe('holdOf with summary.hold', () => {
  it('budget: titles with the limit and scope, facts from the numbers', () => {
    const hold = mk({ kind: 'budget', reason: 'The run reached its limit.', budget: { scope: 'run', limitUsd: 5, spentUsd: 5.01 }, actions: ['addBudget', 'end'] })
    const h = holdOf({ ...base, hold }, null)
    expect(h).toMatchObject({ kind: 'budget', title: 'Paused at the $5.00 limit for this run', text: 'The run reached its limit.', limitUsd: 5, actions: ['addBudget', 'end'] })
    expect(h?.facts).toContainEqual({ label: 'Spent', value: '$5.01' })
    expect(h?.facts).toContainEqual({ label: 'Limit', value: '$5.00' })
  })
  it('spend-limit: day scope and a reset time', () => {
    const hold = mk({ kind: 'spend-limit', budget: { scope: 'day', limitUsd: 20, spentUsd: 20, resetsAt: 2_000_000 } })
    const h = holdOf({ ...base, hold }, null)
    expect(h?.title).toBe('Paused at the $20.00 limit for today')
    expect(h?.facts.map((f) => f.label)).toContain('Resets')
  })
  it('a budget hold without numbers invents none', () => {
    const h = holdOf({ ...base, hold: mk({ kind: 'budget' }) }, null)
    expect(h?.title).toBe('Paused at the spending limit')
    expect(h?.facts.map((f) => f.label)).toEqual(['Since'])
  })
  it('usage-limit keeps the paused facts and uses the hold reason', () => {
    const now = 1_000_000
    const h = holdOf({ status: 'paused', autoResume: true, pausedUntil: now + 60_000, hold: mk({ kind: 'usage-limit', reason: 'Plan window used.', actions: ['resume', 'switchModel'] }) }, null, { now })
    expect(h).toMatchObject({ kind: 'usage-limit', title: 'Waiting for your plan limit to reset', text: 'Plan window used.', actions: ['resume', 'switchModel'] })
    expect(h?.facts).toContainEqual({ label: 'In', value: '1m' })
  })
  it('provider: names the connection and the last answer', () => {
    const h = holdOf({ ...base, hold: mk({ kind: 'provider', provider: { connection: 'anthropic', error: 'Timed out', lastOkAt: 900_000 }, actions: ['retry', 'switchModel'] }) }, null)
    expect(h?.title).toBe("Can't reach Anthropic")
    expect(h?.facts).toContainEqual({ label: 'Last answer', value: 'Timed out' })
    expect(h?.actions).toEqual(['retry', 'switchModel'])
  })
  it('agent-failed: agent name and cost', () => {
    const h = holdOf({ ...base, hold: mk({ kind: 'agent-failed', failed: { agentId: 'a1', name: 'Reviewer', costUsd: 0.5 }, actions: ['retry', 'skipReview'] }) }, null)
    expect(h).toMatchObject({ kind: 'agent-failed', tone: 'failed', title: 'Reviewer failed' })
    expect(h?.facts).toContainEqual({ label: 'Cost', value: '$0.50' })
  })
  it('plan-blocked: the blocked reason is the text', () => {
    const h = holdOf({ ...base, hold: mk({ kind: 'plan-blocked', plan: { blockedReason: 'Pick a database' } }) }, null)
    expect(h).toMatchObject({ kind: 'plan-blocked', title: 'The orchestrator needs your decision', text: 'Pick a database' })
  })
  it('the hold wins over the fallbacks', () => {
    const h = holdOf({ status: 'error', error: 'boom', hold: mk({ kind: 'provider' }) }, { status: 'blocked' })
    expect(h?.kind).toBe('provider')
  })
})
