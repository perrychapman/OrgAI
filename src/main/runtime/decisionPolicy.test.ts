import { describe, expect, it } from 'vitest'
import type { HeadlessDecisionPolicy, UserQuestion } from '@shared/types'
import { DEFAULT_HEADLESS_DECISION_POLICY, HEADLESS_POLICY_DENY_MESSAGE } from '@shared/types'
import { HEADLESS_POLICY_DECLINE_NOTE, countsAsDenial, fullPolicy, policyAction, recommendedOption } from './decisionPolicy'

const question = (options: UserQuestion['options']): UserQuestion => ({
  id: 'q1',
  runId: 'r1',
  agentId: 'root',
  question: 'Which?',
  options,
  allowMultiple: false,
  allowFreeText: false,
  createdAt: 0
})

const policy = (over: Partial<HeadlessDecisionPolicy> = {}): HeadlessDecisionPolicy => ({ ...DEFAULT_HEADLESS_DECISION_POLICY, ...over })

describe('policyAction', () => {
  it('denies permissions, rules and installs by default', () => {
    expect(policyAction('permission', {}, undefined)).toEqual({ kind: 'resolve', decision: { behavior: 'deny', message: HEADLESS_POLICY_DENY_MESSAGE } })
    expect(policyAction('rules', {}, undefined)).toEqual({ kind: 'resolve', decision: { behavior: 'deny', message: HEADLESS_POLICY_DENY_MESSAGE } })
    expect(policyAction('mcpInstall', {}, undefined)).toEqual({ kind: 'resolve', decision: { approved: false, scope: 'run', note: HEADLESS_POLICY_DENY_MESSAGE } })
  })

  it('declines proposals with a note and holds merges by default', () => {
    expect(policyAction('proposal', {}, undefined)).toEqual({ kind: 'resolve', decision: { behavior: 'decline', note: HEADLESS_POLICY_DECLINE_NOTE } })
    expect(policyAction('merge', {}, undefined)).toEqual({ kind: 'resolve', decision: { behavior: 'hold' } })
  })

  it('fails questions by default', () => {
    expect(policyAction('question', question([{ label: '(Recommended) A' }]), undefined)).toEqual({ kind: 'fail' })
  })

  it.each(['permission', 'rules', 'mcpInstall', 'question', 'proposal', 'merge'] as const)('%s: fail and wait', (kind) => {
    expect(policyAction(kind, question([]), policy({ [kind]: 'fail' }))).toEqual({ kind: 'fail' })
    expect(policyAction(kind, question([]), policy({ [kind]: 'wait' }))).toEqual({ kind: 'wait' })
  })

  it('conservative answers the recommended option by label, description or isDefault', () => {
    const p = policy({ question: 'conservative' })
    expect(policyAction('question', question([{ label: 'A' }, { label: '(Recommended) B' }]), p)).toEqual({ kind: 'resolve', decision: { selected: ['(Recommended) B'] } })
    expect(policyAction('question', question([{ label: 'A', description: '(Recommended) safest' }, { label: 'B' }]), p)).toEqual({
      kind: 'resolve',
      decision: { selected: ['A'] }
    })
    const withDefault = question([{ label: 'A' }, { label: 'B', isDefault: true } as UserQuestion['options'][number]])
    expect(policyAction('question', withDefault, p)).toEqual({ kind: 'resolve', decision: { selected: ['B'] } })
  })

  it('conservative without a recommended option fails', () => {
    expect(policyAction('question', question([{ label: 'A' }, { label: 'B', description: 'maybe (Recommended)' }]), policy({ question: 'conservative' }))).toEqual({
      kind: 'fail'
    })
    expect(policyAction('question', undefined, policy({ question: 'conservative' }))).toEqual({ kind: 'fail' })
  })
})

describe('helpers', () => {
  it('fullPolicy fills defaults and keeps given values', () => {
    expect(fullPolicy(undefined)).toEqual(DEFAULT_HEADLESS_DECISION_POLICY)
    expect(fullPolicy({ maxAutoDenials: 2, question: 'wait' } as Partial<HeadlessDecisionPolicy>)).toMatchObject({ maxAutoDenials: 2, question: 'wait', permission: 'deny' })
  })

  it('recommendedOption returns the first match only', () => {
    expect(recommendedOption(question([{ label: '(Recommended) x' }, { label: '(Recommended) y' }]))).toBe('(Recommended) x')
    expect(recommendedOption(question([]))).toBeUndefined()
  })

  it('questions never count as denials', () => {
    expect(countsAsDenial('question')).toBe(false)
    expect(countsAsDenial('permission')).toBe(true)
    expect(countsAsDenial('merge')).toBe(false)
    for (const k of ['rules', 'proposal', 'mcpInstall'] as const) expect(countsAsDenial(k)).toBe(true)
  })
})
