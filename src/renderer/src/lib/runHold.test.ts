import { describe, expect, it } from 'vitest'
import { holdOf } from './runHold'

const base = { status: 'running' as const }
describe('holdOf', () => {
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
  it('plugs in extras', () => {
    expect(holdOf(base, null, { budget: { spentUsd: 5, capUsd: 5 } })?.facts[0]).toEqual({ label: 'Spent', value: '$5.00' })
    expect(holdOf(base, null, { provider: { name: 'Codex', reason: 'x', retrying: true } })?.tone).toBe('retrying')
    expect(holdOf(base, null, { agentFailed: { agent: 'Reviewer', reason: 'x' } })?.kind).toBe('agent-failed')
  })
})
