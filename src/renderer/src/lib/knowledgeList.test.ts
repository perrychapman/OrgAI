import { describe, expect, it } from 'vitest'
import type { KnowledgeFact, KnowledgeNode } from '@shared/types'
import type { KnowledgeItem } from './knowledge'
import { groupItems, itemsOf } from './knowledge'
import {
  EMPTY_BATCH,
  GROUP_TITLE_PX,
  RECORDED_ANNOUNCE_MS,
  ROW_PLAIN_PX,
  ROW_PX,
  addRecorded,
  aliasesText,
  edgeRow,
  emptyKind,
  entryHeight,
  entryOffsets,
  eventItemIds,
  factInputs,
  flattenGroups,
  flushRecorded,
  hiddenNewIds,
  isOwnEvent,
  isTypeAheadKey,
  itemsCapText,
  kindsInUse,
  nextTypeAhead,
  noteCandidates,
  notesCapText,
  parseAliases,
  relationCandidates,
  relationsInUse,
  restoreReady,
  retireNoticeText,
  rowIndexOf,
  scrollTopFor,
  stepRow,
  typeAheadMatch,
  windowRange,
  withFactRetired,
  withFactText,
  withNewFact,
  withoutFact
} from './knowledgeList'

const T0 = 1_700_000_000_000
const src = { by: 'agent' as const, runId: 'r1', role: 'Analyst', at: T0 }
const node = (id: string, kind: string, name: string, p: Partial<KnowledgeNode> = {}): KnowledgeNode => ({ id, kind, name, facts: [], source: src, createdAt: T0, updatedAt: T0, ...p })

const facts: KnowledgeFact[] = [
  { id: 'kf_1', text: 'Headquartered in Leeds', source: src },
  { id: 'kf_2', text: 'Fiscal year ends in March', source: src, retired: true }
]
const acme = node('kn_a', 'organisation', 'Acme Corp', { aliases: ['Acme'], facts })
const jane = node('kn_j', 'person', 'Jane Doe', { aliases: ['J. Doe'] })
const joe = node('kn_joe', 'person', 'Joe Bloggs')
const gone = node('kn_g', 'person', 'Gone Person', { retired: true })
const items = (): KnowledgeItem[] => itemsOf({ nodes: [acme, jane, joe] }, [])

describe('flat list and windowing', () => {
  it('flattens groups into titles and rows with fixed heights', () => {
    const entries = flattenGroups(groupItems(items()))
    expect(entries.map((e) => e.type)).toEqual(['title', 'row', 'row', 'title', 'row'])
    expect(entries[0]).toMatchObject({ type: 'title', kind: 'person', label: 'People', count: 2 })
    expect(entryHeight(entries[0])).toBe(GROUP_TITLE_PX)
    expect(entryHeight(entries[1])).toBe(ROW_PLAIN_PX)
    expect(entryHeight(entries[4])).toBe(ROW_PX)
    const { offsets, total } = entryOffsets(entries)
    expect(offsets).toEqual([0, 32, 76, 120, 152])
    expect(total).toBe(208)
  })

  it('renders everything at or under the threshold and windows past it', () => {
    const small = flattenGroups(groupItems(items()))
    expect(windowRange(small, 0, 100)).toEqual({ start: 0, end: 5, topPad: 0, bottomPad: 0 })
    const many = itemsOf({ nodes: Array.from({ length: 150 }, (_, i) => node(`kn_${i}`, 'person', `P${String(i).padStart(3, '0')}`)) }, [])
    const entries = flattenGroups(groupItems(many))
    const r = windowRange(entries, 44 * 50, 440, 20)
    // Title at 0 (32 px), row k at 32 + 44k: the first row whose bottom passes 2200 is k = 49 (index 50), so the
    // slice starts 20 rows earlier at index 30 and the top spacer covers the title plus 29 rows.
    expect(r.start).toBe(30)
    expect(r.end).toBeGreaterThan(60)
    expect(r.end).toBeLessThan(entries.length)
    expect(r.topPad).toBe(32 + 44 * 29)
    const { total } = entryOffsets(entries)
    expect(r.topPad + (r.end - r.start) * 44 + r.bottomPad).toBe(total)
    const last = windowRange(entries, 10_000, 440, 20)
    expect(last.end).toBe(entries.length)
    expect(last.bottomPad).toBe(0)
  })

  it('scrollTopFor moves as little as needed and keeps a group title above the first row', () => {
    const entries = flattenGroups(groupItems(items()))
    expect(scrollTopFor(entries, 1, 0, 100)).toBe(0)
    expect(scrollTopFor(entries, 4, 0, 100)).toBe(152 + 56 - 100)
    expect(scrollTopFor(entries, 4, 150, 100)).toBe(150)
    expect(scrollTopFor(entries, 4, 160, 100)).toBe(120)
    expect(scrollTopFor(entries, 1, 60, 100)).toBe(0)
    expect(scrollTopFor(entries, 9, 60, 100)).toBe(60)
  })

  it('steps over titles and finds the edges', () => {
    const entries = flattenGroups(groupItems(items()))
    expect(rowIndexOf(entries, 'kn_a')).toBe(4)
    expect(rowIndexOf(entries, null)).toBe(-1)
    expect(stepRow(entries, 2, 1)).toBe(4)
    expect(stepRow(entries, 4, 1)).toBe(-1)
    expect(stepRow(entries, 1, -1)).toBe(-1)
    expect(edgeRow(entries, 'first')).toBe(1)
    expect(edgeRow(entries, 'last')).toBe(4)
    expect(edgeRow([], 'first')).toBe(-1)
  })
})

describe('retire notice', () => {
  it('words the notice like the announcement', () => {
    expect(retireNoticeText('Jane Doe', 'retired')).toBe('Retired Jane Doe.')
    expect(retireNoticeText('Jane Doe', 'deleted')).toBe('Deleted Jane Doe.')
  })
  it('is ready to focus only when the item is shown and live', () => {
    const live = itemsOf({ nodes: [acme] }, [])
    const retired = itemsOf({ nodes: [{ ...acme, retired: true }] }, [])
    expect(restoreReady(live, 'kn_a')).toBe(true)
    expect(restoreReady(retired, 'kn_a')).toBe(false)
    expect(restoreReady([], 'kn_a')).toBe(false)
  })
})

describe('type-ahead', () => {
  it('appends within 500 ms and starts over after', () => {
    const a = nextTypeAhead(null, 'j', 1000)
    expect(a).toEqual({ text: 'j', at: 1000 })
    expect(nextTypeAhead(a, 'a', 1400).text).toBe('ja')
    expect(nextTypeAhead(a, 'a', 1600).text).toBe('a')
  })

  it('matches a prefix from the focused row and cycles a repeated letter', () => {
    const names = ['Jane Doe', 'Joe Bloggs', 'Acme Corp', 'Jim Ray']
    expect(typeAheadMatch(names, -1, 'j')).toBe(0)
    expect(typeAheadMatch(names, 0, 'j')).toBe(1)
    expect(typeAheadMatch(names, 3, 'j')).toBe(0)
    expect(typeAheadMatch(names, 0, 'ja')).toBe(0)
    expect(typeAheadMatch(names, 0, 'jo')).toBe(1)
    expect(typeAheadMatch(names, 1, 'jj')).toBe(3)
    expect(typeAheadMatch(names, 0, 'ACME')).toBe(2)
    expect(typeAheadMatch(names, 0, 'zz')).toBe(-1)
    expect(typeAheadMatch([], 0, 'a')).toBe(-1)
  })

  it('isTypeAheadKey takes one printable character without modifiers', () => {
    const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods })
    expect(isTypeAheadKey(k('a'))).toBe(true)
    expect(isTypeAheadKey(k('Enter'))).toBe(false)
    expect(isTypeAheadKey(k(' '))).toBe(false)
    expect(isTypeAheadKey(k('a', { ctrlKey: true }))).toBe(false)
  })
})

describe('recorded announcements', () => {
  it('announces at once when quiet and batches within 5 s', () => {
    const first = addRecorded(EMPTY_BATCH, 2, 10_000)
    expect(first.announce).toBe('The team recorded 2 items')
    expect(first.batch).toEqual({ pending: 0, lastAt: 10_000 })
    const held = addRecorded(first.batch, 1, 11_000)
    expect(held.announce).toBeNull()
    expect(held.delay).toBe(RECORDED_ANNOUNCE_MS - 1000)
    const more = addRecorded(held.batch, 1, 12_000)
    expect(more.batch.pending).toBe(2)
    const flushed = flushRecorded(more.batch, 15_000)
    expect(flushed.announce).toBe('The team recorded 2 items')
    expect(flushed.batch).toEqual({ pending: 0, lastAt: 15_000 })
    expect(flushRecorded(flushed.batch, 16_000).announce).toBeNull()
    expect(addRecorded(flushed.batch, 0, 16_000).announce).toBeNull()
    expect(addRecorded(EMPTY_BATCH, 1, 1).announce).toBe('The team recorded 1 item')
  })

  it('counts nodes and notes as items, never relations', () => {
    expect(eventItemIds(['kn_1', 'ke_2', 'n3'])).toEqual(['kn_1', 'n3'])
    expect(eventItemIds(undefined)).toEqual([])
  })

  it('tells own writes apart by in-flight writes or recently written ids', () => {
    const own = new Map([['kn_1', 1000]])
    expect(isOwnEvent(['kn_9'], own, 1, 2000)).toBe(true)
    expect(isOwnEvent(['kn_1'], own, 0, 2000)).toBe(true)
    expect(isOwnEvent(['kn_1', 'kn_2'], own, 0, 2000)).toBe(false)
    expect(isOwnEvent(['kn_1'], own, 0, 1000 + 20_000)).toBe(false)
    expect(isOwnEvent(undefined, own, 0, 2000)).toBe(false)
    expect(isOwnEvent([], own, 0, 2000)).toBe(false)
  })

  it('hiddenNewIds names the pushed items the filter hides', () => {
    expect(hiddenNewIds(['kn_1', 'kn_2', 'kn_x'], new Set(['kn_1', 'kn_2']), new Set(['kn_1']))).toEqual(['kn_2'])
  })
})

describe('empty states', () => {
  it('picks the state', () => {
    expect(emptyKind(3, 2, false, false)).toBeNull()
    expect(emptyKind(0, 0, false, false)).toBe('none')
    expect(emptyKind(0, 0, false, true)).toBe('none-runs')
    expect(emptyKind(3, 0, true, true)).toBe('filter')
    expect(emptyKind(3, 0, false, true)).toBe('retired')
  })
})

describe('detail pane edits', () => {
  it('parses and prints aliases', () => {
    expect(parseAliases(' Acme , acme, ACME Ltd,, Acme  Ltd ')).toEqual(['Acme', 'ACME Ltd'])
    expect(parseAliases('a,b,c', 2)).toEqual(['a', 'b'])
    expect(aliasesText(['Acme', 'ACME Ltd'])).toBe('Acme, ACME Ltd')
    expect(aliasesText(undefined)).toBe('')
  })

  it('keeps fact ids through edits so every fact keeps its source', () => {
    expect(factInputs(facts)).toEqual([
      { id: 'kf_1', text: 'Headquartered in Leeds' },
      { id: 'kf_2', text: 'Fiscal year ends in March', retired: true }
    ])
    expect(withFactText(facts, 'kf_1', 'HQ in Leeds')[0]).toEqual({ id: 'kf_1', text: 'HQ in Leeds' })
    expect(withFactRetired(facts, 'kf_1', true)[0]).toEqual({ id: 'kf_1', text: 'Headquartered in Leeds', retired: true })
    expect(withFactRetired(facts, 'kf_2', false)[1]).toEqual({ id: 'kf_2', text: 'Fiscal year ends in March', retired: false })
    expect(withoutFact(facts, 'kf_2')).toEqual([{ id: 'kf_1', text: 'Headquartered in Leeds' }])
    expect(withNewFact(facts, 'New').at(-1)).toEqual({ text: 'New' })
  })

  it('lists kinds and relations in use', () => {
    expect(kindsInUse([jane, acme, node('x', 'vendor', 'V')])).toEqual(['person', 'organisation', 'vendor'])
    expect(relationsInUse([{ relation: 'works-at' }, { relation: 'owns' }, { relation: 'works-at' }])).toEqual(['works-at', 'owns'])
  })

  it('offers live nodes for a relation, names first, never itself', () => {
    const nodes = [acme, jane, joe, gone]
    expect(relationCandidates(nodes, 'j', 'kn_a').map((n) => n.name)).toEqual(['Jane Doe', 'Joe Bloggs'])
    expect(relationCandidates(nodes, 'doe', 'kn_a').map((n) => n.name)).toEqual(['Jane Doe'])
    expect(relationCandidates(nodes, 'acme', 'kn_a')).toEqual([])
    expect(relationCandidates(nodes, '', 'kn_j').map((n) => n.name)).toEqual(['Acme Corp', 'Joe Bloggs'])
    expect(relationCandidates(nodes, 'gone', 'kn_a')).toEqual([])
    expect(relationCandidates(nodes, '', 'kn_a', 1)).toHaveLength(1)
  })

  it('offers notes to link, the linked and retired ones left out', () => {
    const notes = [
      { id: 'n1', title: 'Kickoff call summary' },
      { id: 'n2', title: 'Glossary' },
      { id: 'n3', title: 'Old', retired: true }
    ]
    expect(noteCandidates(notes, '', ['n2']).map((n) => n.id)).toEqual(['n1'])
    expect(noteCandidates(notes, 'glo', []).map((n) => n.id)).toEqual(['n2'])
    expect(noteCandidates(notes, 'old', [])).toEqual([])
  })

  it('cap sentences', () => {
    expect(notesCapText(200)).toBe('200 notes is the most an engagement can keep.')
    expect(itemsCapText(2000)).toBe('2,000 items is the most an engagement can keep.')
  })
})
