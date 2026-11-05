import { describe, expect, it } from 'vitest'
import type { KnowledgeInferredLink, KnowledgeNode } from '@shared/types'
import { POSSIBLE_WORD_PLACEHOLDER, confirmWord, dismissLabel, inferredStatus, initialWord, linkWhy, linkedStatus, possiblePartialNote, possibleRows, rowAfterRemoval, splitEvidence, visibleLinkCount, whyText } from './knowledgePossible'

const node = (id: string, name: string, extra: Partial<KnowledgeNode> = {}): KnowledgeNode => ({ id, name, kind: 'person', aliases: [], facts: [], noteIds: [], createdAt: 1, updatedAt: 1, ...extra }) as unknown as KnowledgeNode
const link = (id: string, from: string, to: string, extra: Partial<KnowledgeInferredLink> = {}): KnowledgeInferredLink => ({ id, from, to, basis: 'mention', evidence: 'Fact: "Works at Acme"', strength: 0.5, count: 1, ...extra })

describe('the blank word field', () => {
  it('starts blank without a suggestion and its placeholder is no relation word', () => {
    expect(initialWord({})).toBe('')
    expect(POSSIBLE_WORD_PLACEHOLDER).toBe('How they relate')
    expect(POSSIBLE_WORD_PLACEHOLDER).not.toMatch(/works at/)
  })
})

describe('possiblePartialNote', () => {
  it('says the list is partial only when the matcher stopped early', () => {
    expect(possiblePartialNote(undefined)).toBeNull()
    expect(possiblePartialNote(null)).toBeNull()
    expect(possiblePartialNote({ scannedEntities: 1200, totalEntities: 2000 })).toBe('This list is partial: OrgAI checked 1,200 of 2,000 items before stopping.')
    expect(possiblePartialNote({ scannedEntities: Number.NaN, totalEntities: 5 })).toBeNull()
  })
})

describe('splitEvidence', () => {
  it('strips the label and the quotes', () => {
    expect(splitEvidence('Fact: "Jane works at Acme"')).toEqual({ label: 'fact', snippet: 'Jane works at Acme' })
    expect(splitEvidence('Summary: "Sponsor of Acme"')).toEqual({ label: 'summary', snippet: 'Sponsor of Acme' })
  })
  it('tolerates a clipped closing quote and unlabelled text', () => {
    expect(splitEvidence('Fact: "Jane works at Acme and…').snippet).toBe('Jane works at Acme and…')
    expect(splitEvidence('Just text')).toEqual({ label: null, snippet: 'Just text' })
  })
  it('removes control and bidi characters', () => {
    expect(splitEvidence('Fact: "a‮b\u0007c"').snippet).toBe('a b c')
  })
})

describe('linkWhy', () => {
  it('words it from this item when it is from', () => {
    const w = linkWhy(link('kl_1', 'a', 'b'), 'a')
    expect(w.otherId).toBe('b')
    expect(whyText(w, 'Acme')).toBe('Named in a fact: Works at Acme')
    expect(whyText(linkWhy(link('kl_1', 'a', 'b', { evidence: 'Summary: "Acme"' }), 'a'), 'Acme')).toBe('Named in the summary: Acme')
  })
  it('words it from this item when it is to', () => {
    expect(whyText(linkWhy(link('kl_1', 'a', 'b'), 'b'), 'Jane')).toBe('Names this in a fact: Works at Acme')
    expect(whyText(linkWhy(link('kl_1', 'a', 'b', { evidence: 'Summary: "Acme"' }), 'b'), 'Jane')).toBe('Names this in its summary: Acme')
  })
  it('hides the evidence of a same-name link', () => {
    const w = linkWhy(link('kl_2', 'a', 'b', { basis: 'same-name', evidence: 'Both are called "Acme"' }), 'b')
    expect(w.sameName).toBe(true)
    expect(w.snippet).toBe('')
    expect(whyText(w, 'Acme Ltd')).toBe('Same name as Acme Ltd: might be the same thing')
  })
})

describe('possibleRows', () => {
  const nodes = [node('a', 'Jane'), node('b', 'Acme'), node('c', 'Tom'), node('d', 'Old', { retired: true })]
  it('keeps this item\'s links, strongest first', () => {
    const rows = possibleRows([link('kl_1', 'a', 'b', { strength: 0.4 }), link('kl_2', 'c', 'a', { strength: 0.9 }), link('kl_3', 'b', 'c')], 'a', nodes, [])
    expect(rows.map((r) => r.link.id)).toEqual(['kl_2', 'kl_1'])
    expect(rows[0]!.other.name).toBe('Tom')
  })
  it('drops retired ends, unknown ends and pairs with an edge', () => {
    const rows = possibleRows([link('kl_1', 'a', 'd'), link('kl_2', 'a', 'zz'), link('kl_3', 'a', 'b'), link('kl_4', 'a', 'c')], 'a', nodes, [{ from: 'b', to: 'a' }])
    expect(rows.map((r) => r.link.id)).toEqual(['kl_4'])
  })
  it('shows nothing for a retired or missing item', () => {
    expect(possibleRows([link('kl_1', 'd', 'a')], 'd', nodes, [])).toEqual([])
    expect(possibleRows([link('kl_1', 'x', 'a')], 'x', nodes, [])).toEqual([])
  })
  it('breaks ties by count then name', () => {
    const rows = possibleRows([link('kl_1', 'a', 'c'), link('kl_2', 'a', 'b'), link('kl_3', 'a', 'b', { count: 2 })], 'a', nodes, [])
    expect(rows.map((r) => r.link.id)).toEqual(['kl_3', 'kl_2', 'kl_1'])
  })
})

describe('words and texts', () => {
  it('starts from the suggestion as words', () => {
    expect(initialWord({ suggestedRelation: 'works-at' })).toBe('works at')
    expect(initialWord({})).toBe('')
  })
  it('validates the typed word', () => {
    expect(confirmWord('  Works  at ')).toEqual({ key: 'works-at' })
    expect(confirmWord('   ')).toEqual({ error: 'Add a word for how they relate, such as works at.' })
    expect('error' in confirmWord('!!!')).toBe(true)
  })
  it('writes the status and labels', () => {
    expect(linkedStatus('Jane Doe', 'works at', 'Acme Corp')).toBe('Linked Jane Doe works at Acme Corp.')
    expect(dismissLabel('Acme')).toBe('Dismiss the possible connection with Acme')
    expect(inferredStatus(1)).toBe('Showing 1 inferred link.')
    expect(inferredStatus(3)).toBe('Showing 3 inferred links.')
  })
  it('counts drawn links', () => {
    expect(visibleLinkCount([{ from: 'a', to: 'b' }, { from: 'a', to: 'z' }], new Set(['a', 'b']))).toBe(1)
  })
})

describe('rowAfterRemoval', () => {
  it('takes the following row that is still there', () => {
    expect(rowAfterRemoval(['x', 'y', 'z'], ['x', 'z'], 'y')).toBe('z')
    expect(rowAfterRemoval(['x', 'y', 'z'], ['x'], 'y')).toBeNull()
    expect(rowAfterRemoval(['x', 'y'], ['x'], 'q')).toBeNull()
  })
})
