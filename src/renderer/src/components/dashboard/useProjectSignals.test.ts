import { describe, expect, it } from 'vitest'
import { branchCount, signalPlan } from './useProjectSignals'

const code = (id: string) => ({ id, kind: 'code' as const })
const eng = (id: string) => ({ id, kind: 'engagement' as const })

describe('signalPlan', () => {
  it('asks for worktrees on code projects only and a team review on every project, in tile order', () => {
    const plan = signalPlan([code('a'), eng('b'), code('c')], new Set())
    expect(plan.worktrees).toEqual(['a', 'c'])
    expect(plan.teamReview).toEqual(['a', 'b', 'c'])
  })
  it('skips what this mount already requested', () => {
    const plan = signalPlan([code('a'), code('b')], new Set(['worktrees:a', 'teamReview:a', 'teamReview:b']))
    expect(plan.worktrees).toEqual(['b'])
    expect(plan.teamReview).toEqual([])
  })
  it('treats a missing kind as a code project', () => {
    expect(signalPlan([{ id: 'x' }], new Set()).worktrees).toEqual(['x'])
  })
  it('never plans calls for virtual ids', () => {
    expect(signalPlan([code('quick')], new Set()).worktrees).toEqual([])
  })
})

describe('branchCount', () => {
  it('counts entries with commits ahead or uncommitted files', () => {
    expect(
      branchCount([
        { commitsAhead: 0, uncommittedFiles: 0 },
        { commitsAhead: 2, uncommittedFiles: 0 },
        { commitsAhead: 0, uncommittedFiles: 3 }
      ])
    ).toBe(2)
  })
  it('counts a failed or missing list as none', () => {
    expect(branchCount(null)).toBe(0)
    expect(branchCount(undefined)).toBe(0)
    expect(branchCount([])).toBe(0)
  })
})
