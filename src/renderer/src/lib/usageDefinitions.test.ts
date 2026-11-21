import { describe, expect, it } from 'vitest'
import { USAGE_DEFINITIONS, definitionOf, reasonParts } from './usageDefinitions'

describe('USAGE_DEFINITIONS', () => {
  it('keeps only terms that have a label on the page', () => {
    const terms = USAGE_DEFINITIONS.map((d) => d.term)
    for (const gone of ['Tokens per turn', 'Waiting on you', 'Limit hold', 'Team vs Ask', 'Truncated', 'Legacy']) expect(terms).not.toContain(gone)
    for (const kept of ['Estimated cost', 'Cache hit', 'Cost per run', 'Retries', 'No result', 'Nudges', 'Wall time', 'Idle', 'Not priced']) expect(terms).toContain(kept)
  })
  it('says "Not priced", never "unknown", for a cost without a price', () => {
    for (const d of USAGE_DEFINITIONS) expect(d.text).not.toMatch(/\bunknown\b/i)
    expect(definitionOf('Estimated cost')).toContain('"Not priced"')
  })
  it('has a definition for every term and none for an unknown one', () => {
    for (const d of USAGE_DEFINITIONS) expect(d.text.length).toBeGreaterThan(20)
    expect(definitionOf('Nope')).toBe('')
  })
})

describe('reasonParts', () => {
  it('splits a reason around the word it defines', () => {
    expect(reasonParts('retries', 'Retried 3 times')).toMatchObject({ before: '', term: 'Retried', after: ' 3 times', definition: definitionOf('Retries') })
    expect(reasonParts('nudges', 'Auto-continued once')).toMatchObject({ term: 'Auto-continued', definition: definitionOf('Nudges') })
    expect(reasonParts('cache', 'Cache hit 12%')).toMatchObject({ term: 'Cache hit', after: ' 12%', definition: definitionOf('Cache hit') })
    expect(reasonParts('idle', 'Idle 50% of its time')).toMatchObject({ term: 'Idle', definition: definitionOf('Idle') })
    expect(reasonParts('cost', 'Not priced; 1,640 tokens')).toMatchObject({ term: 'Not priced', after: '; 1,640 tokens' })
  })
  it('finds "no result" inside the sentence', () => {
    const p = reasonParts('no-result', 'implementer-1 spent 1,640 tokens and produced no result')
    expect(p).toMatchObject({ before: 'implementer-1 spent 1,640 tokens and produced ', term: 'no result', after: '', definition: definitionOf('No result') })
  })
  it('is null when the text has no defined word', () => {
    expect(reasonParts('no-result', 'The run failed')).toBeNull()
    expect(reasonParts('cost', 'Estimated $0.12')).toBeNull()
    expect(reasonParts('other', 'Anything')).toBeNull()
  })
})
