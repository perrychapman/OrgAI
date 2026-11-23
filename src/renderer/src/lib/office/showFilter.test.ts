import { describe, expect, it } from 'vitest'
import { inShow, showCounts } from './showFilter'

describe('office show filter', () => {
  it('counts working and waiting people from their statuses', () => {
    expect(showCounts(['thinking', 'tool', 'waiting', 'done', 'idle', 'error'])).toEqual({ all: 6, working: 2, waiting: 1 })
    expect(showCounts([])).toEqual({ all: 0, working: 0, waiting: 0 })
  })

  it('keeps everyone under All and only the matching state otherwise', () => {
    expect(inShow('all', 'done')).toBe(true)
    expect(inShow('working', 'delegating')).toBe(true)
    expect(inShow('working', 'waiting')).toBe(false)
    expect(inShow('waiting', 'waiting')).toBe(true)
    expect(inShow('waiting', 'thinking')).toBe(false)
  })
})
