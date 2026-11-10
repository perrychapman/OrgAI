import { describe, expect, it } from 'vitest'
import { STAFFING_SOURCES, type StaffingAssignment } from '../shared/types'
import { latestByAgent, staffingLabel, staffingLine, staffingReason, stepStaffText, stepRanText, latestForStep } from './staffingText'

const a = (over: Partial<StaffingAssignment> = {}): StaffingAssignment => ({ agentId: 'a1', roleId: 'engineer', tier: 'everyday', model: 'sonnet', effort: 'medium', source: 'orchestrator', at: 1, ...over })

describe('staffingLabel', () => {
  it('is tier / effort, the model when there is no tier, and the tier alone without effort', () => {
    expect(staffingLabel(a())).toBe('everyday / medium')
    expect(staffingLabel(a({ tier: undefined }))).toBe('sonnet / medium')
    expect(staffingLabel(a({ effort: undefined }))).toBe('everyday')
  })
})

describe('staffingReason', () => {
  it.each([
    ['orchestrator', 'chosen by the orchestrator'],
    ['role', "the role's setting"],
    ['profile', "from this project's history"],
    ['clamped', 'capped by the role'],
    ['plan-guard', 'moved down by the plan guard'],
    ['escalated', 'raised after a failed attempt']
  ] as const)('%s reads "%s"', (source, words) => {
    expect(staffingReason({ source })).toBe(words)
  })
  it('covers every source and adds the note when there is one', () => {
    for (const s of STAFFING_SOURCES) expect(staffingReason({ source: s })).not.toBe(s)
    expect(staffingReason({ source: 'clamped', note: 'fast is the most it may use' })).toBe('capped by the role: fast is the most it may use')
    expect(staffingReason({ source: 'clamped', note: 'Capped by the role' })).toBe('capped by the role')
  })
  it('sanitizes a hostile note', () => {
    const out = staffingReason({ source: 'role', note: 'x\u001b[31mred\u001b]0;pwn\u0007\nnext' })
    expect(out).toBe("the role's setting: xred next")
    expect(out).not.toContain('\u001b')
  })
})

describe('latestByAgent', () => {
  it('keeps the newest assignment of each agent and skips ones without an agent', () => {
    const m = latestByAgent({ assignments: [a({ at: 1, effort: 'low' }), a({ at: 5, effort: 'high' }), a({ at: 3, effort: 'max' }), a({ agentId: 'a2', at: 2 }), a({ agentId: undefined, at: 9 })] })
    expect(m.size).toBe(2)
    expect(m.get('a1')?.effort).toBe('high')
    expect(latestByAgent(undefined).size).toBe(0)
  })
  it('prefers the later entry on equal times', () => {
    expect(latestByAgent({ assignments: [a({ source: 'role' }), a({ source: 'escalated' })] }).get('a1')?.source).toBe('escalated')
  })
})

describe('staffingLine and stepStaffText', () => {
  it('reads like an agent line', () => {
    expect(staffingLine('engineer-1', a())).toBe('engineer-1 on everyday / medium (chosen by the orchestrator)')
  })
  it('sanitizes the name and model', () => {
    const out = staffingLine('eng\u001b[2Jx', a({ tier: undefined, model: 'm\u001b[31m1' }))
    expect(out).toBe('engx on m1 / medium (chosen by the orchestrator)')
  })
  it('shows a step pick', () => {
    expect(stepStaffText({ role: 'engineer', tier: 'fast', effort: 'low' })).toBe('engineer (fast / low)')
    expect(stepStaffText({ role: 'engineer' })).toBe('engineer')
    expect(stepStaffText({ role: 'e\u001b[31mng' })).toBe('eng')
  })
})

describe('stepRanText', () => {
  const ask = { role: 'reviewer', tier: 'top' as const, effort: 'max' as const }
  // roleId is a Role.id (opaque): the text keeps the step's own role name.
  const row = (o: object) => ({ roleId: 'r_8f2c', model: 'm', source: 'orchestrator' as const, at: 1, ...o }) as never
  it('falls back to the request, shows what ran, and what was asked when different', () => {
    expect(stepRanText(ask, undefined)).toBe('reviewer (top / max)')
    expect(stepRanText(ask, row({ tier: 'top', effort: 'max' }))).toBe('reviewer (top / max)')
    expect(stepRanText(ask, row({ tier: 'everyday', effort: 'high' }))).toBe('reviewer (everyday / high, asked top / max)')
  })
  it('picks the newest row for a step', () => {
    const a = row({ stepId: 's1', at: 1 })
    const b = row({ stepId: 's1', at: 2 })
    expect(latestForStep({ assignments: [a, b] }, 's1')).toBe(b)
    expect(latestForStep({ assignments: [a] }, 's2')).toBeUndefined()
  })
})
