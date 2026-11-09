import { describe, expect, it } from 'vitest'
import type { AgentInstance, RunSummary } from './types'
import { applyRunDelegation, delegationBadges, DELEGATION_BADGE_LABEL } from './delegationView'

const agent = (id: string, delegation?: AgentInstance['delegation']): Pick<AgentInstance, 'delegation'> & { id: string } => ({ id, delegation })

describe('applyRunDelegation', () => {
  it('sets the summary and each listed agent, leaving the rest and unknown ids alone', () => {
    const summary = { id: 'r1' } as RunSummary
    const agents = { a: agent('a'), b: agent('b') }
    const d = { verdict: 'failed' as const, missing: ['policy'], corrected: false, nativeSpawns: 0 }
    const out = applyRunDelegation(summary, agents, { summary: { failed: 1, corrected: 0, nativeSpawns: 0 }, agents: { a: d, ghost: d } })
    expect(out.summary.delegation).toEqual({ failed: 1, corrected: 0, nativeSpawns: 0 })
    expect(out.agents.a?.delegation).toEqual(d)
    expect(out.agents.b).toBe(agents.b)
    expect(out.agents.ghost).toBeUndefined()
    expect(agents.a.delegation).toBeUndefined()
  })
})

describe('delegationBadges', () => {
  it('lists failed, corrected and native in order', () => {
    expect(delegationBadges(undefined)).toEqual([])
    expect(delegationBadges({ verdict: 'ok', missing: [], corrected: false, nativeSpawns: 0 })).toEqual([])
    expect(delegationBadges({ verdict: 'failed', missing: ['x'], corrected: true, nativeSpawns: 2 })).toEqual(['failed', 'corrected', 'native'])
    expect(DELEGATION_BADGE_LABEL.failed).toBe('Skipped required reports')
  })
})
