import { describe, expect, it } from 'vitest'
import { journeyDuration, routesConflict, sampleJourney } from './motion'

describe('Office message journeys', () => {
  const path = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]
  it('walks in integer pixels at a distance-based cadence and turns with the route', () => {
    expect(sampleJourney(path, 60)).toMatchObject({ x: 24, y: 16, direction: 'right', phase: 'outbound' })
    expect(sampleJourney(path, 120)).toMatchObject({ x: 32, y: 16, direction: 'down', pose: 'walk-2' })
    expect(Number.isInteger(sampleJourney(path, 91).x)).toBe(true)
  })
  it('holds a real arrival, reverses the same route and ends exactly at its desk', () => {
    expect(journeyDuration(path)).toBe(720)
    expect(sampleJourney(path, 240)).toMatchObject({ x: 32, y: 32, phase: 'settle', pose: 'idle' })
    expect(sampleJourney(path, 479).phase).toBe('settle')
    expect(sampleJourney(path, 540)).toMatchObject({ x: 32, y: 24, phase: 'return', direction: 'up' })
    expect(sampleJourney(path, 660)).toMatchObject({ x: 24, y: 16, phase: 'return', direction: 'left' })
    expect(sampleJourney(path, 720)).toMatchObject({ x: 16, y: 16, phase: 'done' })
  })
  it('rejects empty, discontinuous and excessively long journeys instead of rushing them', () => {
    expect(journeyDuration([])).toBeNull()
    expect(journeyDuration([{ x: 0, y: 0 }, { x: 3, y: 0 }])).toBeNull()
    expect(journeyDuration(Array.from({ length: 42 }, (_, x) => ({ x, y: 0 })))).toBeNull()
    expect(journeyDuration(Array.from({ length: 41 }, (_, x) => ({ x, y: 0 })))).toBe(9840)
  })
  it('reserves intersecting and adjacent target corridors while allowing disjoint walks', () => {
    expect(routesConflict(path, [{ x: 2, y: 3 }])).toBe(true)
    expect(routesConflict([{ x: 1, y: 1 }], [{ x: 1, y: 3 }])).toBe(true)
    expect(routesConflict(path, [{ x: 5, y: 5 }])).toBe(false)
  })
})
