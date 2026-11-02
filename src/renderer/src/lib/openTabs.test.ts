import { describe, expect, it } from 'vitest'
import { OPEN_TABS_MAX, parseOpenTabs, serializeOpenTabs } from './openTabs'

describe('openTabs', () => {
  it('reads a stored value back', () => {
    const raw = serializeOpenTabs({ chains: ['run_a', 'run_b'], viewed: 'run_b' })
    expect(parseOpenTabs(raw)).toEqual({ chains: ['run_a', 'run_b'], viewed: 'run_b' })
  })
  it('reads junk as empty', () => {
    for (const raw of [null, undefined, '', 'nope', '[]', '"x"', '{"chains":5}', 'null']) expect(parseOpenTabs(raw).chains).toEqual([])
  })
  it('drops ids that do not match, duplicates and anything past 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => `run_${i}`)
    const out = parseOpenTabs(JSON.stringify({ chains: ['../x', 7, 'a b', 'run_1', 'run_1', ...many], viewed: 'bad id' }))
    expect(out.chains).toHaveLength(OPEN_TABS_MAX)
    expect(out.chains[0]).toBe('run_1')
    expect(out.chains).not.toContain('../x')
    expect(out.viewed).toBeUndefined()
  })
  it('refuses an id over 80 characters', () => {
    expect(parseOpenTabs(JSON.stringify({ chains: ['a'.repeat(81), 'a'.repeat(80)] })).chains).toEqual(['a'.repeat(80)])
  })
})
