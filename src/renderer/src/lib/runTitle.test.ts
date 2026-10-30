import { describe, expect, it } from 'vitest'
import type { RunSummary } from '../../../shared/types'
import { withRunTitle } from './runTitle'

const row = (id: string): RunSummary => ({ id, projectId: 'p', kind: 'work', prompt: 'x', status: 'finished', startedAt: 0, totalCostUsd: 0 })

describe('withRunTitle', () => {
  it('sets the title on the matching row only', () => {
    const list = [row('a'), row('b')]
    const out = withRunTitle(list, 'b', 'Fix it')
    expect(out[0]).toBe(list[0])
    expect(out[1].title).toBe('Fix it')
  })
  it('returns the same list when the run is absent', () => {
    const list = [row('a')]
    expect(withRunTitle(list, 'z', 't')).toBe(list)
  })
})
