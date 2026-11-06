import { describe, expect, it } from 'vitest'
import { OPEN_TABS_MAX, parseOpenTabs, sameRunSummaries, serializeOpenTabs, tabsSignature } from './openTabs'

describe('sameRunSummaries (L13)', () => {
  it('is true only when every run keeps its summary object', () => {
    const s1 = { id: 'a' }
    const s2 = { id: 'b' }
    const a = { a: { summary: s1, transcript: [1] }, b: { summary: s2 } }
    const onlyTranscript = { a: { summary: s1, transcript: [] }, b: { summary: s2 } }
    expect(sameRunSummaries(a, onlyTranscript)).toBe(true)
    expect(sameRunSummaries(a, { a: { summary: { id: 'a' } }, b: { summary: s2 } })).toBe(false)
    expect(sameRunSummaries(a, { a: { summary: s1 } })).toBe(false)
    expect(sameRunSummaries(a, { a: { summary: s1 }, c: { summary: s2 } })).toBe(false)
  })
})

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

describe('tabsSignature', () => {
  const a = { id: 'a', status: 'running' }
  it('ignores streamed changes inside a status class and notices links, class, dismissal and view', () => {
    const base = tabsSignature([a], [], 'a', false)
    expect(tabsSignature([{ id: 'a', status: 'idle' }], [], 'a', false)).toBe(base)
    expect(tabsSignature([{ id: 'a', status: 'finished' }], [], 'a', false)).not.toBe(base)
    expect(tabsSignature([{ ...a, resumedFrom: 'z' }], [], 'a', false)).not.toBe(base)
    expect(tabsSignature([a], ['a'], 'a', false)).not.toBe(base)
    expect(tabsSignature([a], [], undefined, true)).not.toBe(base)
  })
})
