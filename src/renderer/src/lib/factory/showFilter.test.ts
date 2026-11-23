import { describe, expect, it } from 'vitest'
import { filteredOut, inShow, showCounts } from './showFilter'

describe('factory show filter', () => {
  it('counts workers by the lamp they light', () => {
    expect(showCounts(['running', 'running', 'needs-you', 'off', 'failed'])).toEqual({ all: 5, working: 2, waiting: 1 })
  })

  it('maps Working to the running lamp and Waiting to needs you', () => {
    expect(inShow('all', 'off')).toBe(true)
    expect(inShow('working', 'running')).toBe(true)
    expect(inShow('working', 'needs-you')).toBe(false)
    expect(inShow('waiting', 'needs-you')).toBe(true)
    expect(inShow('waiting', 'failed')).toBe(false)
  })

  it('keeps the selected, focused or hovered worker out of the filtered set', () => {
    const workers = [{ id: 'a', lamp: 'running' as const }, { id: 'b', lamp: 'off' as const }, { id: 'c', lamp: 'needs-you' as const }]
    expect([...filteredOut('all', workers, [])]).toEqual([])
    expect([...filteredOut('working', workers, [])].sort()).toEqual(['b', 'c'])
    expect([...filteredOut('working', workers, ['c', null])]).toEqual(['b'])
  })
})
