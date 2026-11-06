import { describe, expect, it } from 'vitest'
import type { EngagementNote, KnowledgeGraph, KnowledgeNode } from '@shared/types'
import { ROLE_COLORS } from '@shared/defaults'
import {
  EMPTY_FILTER,
  clearCountsLine,
  countLine,
  groupItems,
  historyLines,
  idAfterRemoval,
  itemExcerpt,
  itemSource,
  itemsOf,
  keyWords,
  kindColor,
  kindMark,
  kindCounts,
  kindGroupLabel,
  kindLabel,
  kindOrder,
  knowledgeSummaryLine,
  orderItems,
  originCounts,
  provenanceLine,
  relatedRows,
  resolveFocus,
  roleWord,
  searchItems,
  searchRank,
  splitHistoryLine
} from './knowledge'

const T0 = new Date(2026, 10, 4, 11, 46).getTime()
const agent = (at = T0) => ({ by: 'agent' as const, runId: 'r1', agentId: 'root', role: 'Analyst', at })
const user = (at = T0) => ({ by: 'user' as const, at })

function node(p: Partial<KnowledgeNode> & { id: string; name: string; kind: string }): KnowledgeNode {
  return { facts: [], source: agent(), createdAt: T0, updatedAt: T0, ...p }
}
function note(p: Partial<EngagementNote> & { id: string; title: string }): EngagementNote {
  return { excerpt: '', createdAt: T0, updatedAt: T0, chars: 10, ...p }
}

const acme = node({
  id: 'kn_acme',
  kind: 'organisation',
  name: 'Acme Corp',
  aliases: ['Acme'],
  summary: 'The client.',
  facts: [
    { id: 'kf_1', text: 'Headquartered in Leeds', source: agent() },
    { id: 'kf_2', text: 'Fiscal year ends in March', source: agent(), retired: true }
  ],
  createdAt: T0 + 1
})
const jane = node({ id: 'kn_jane', kind: 'person', name: 'Jane Doe', aliases: ['J. Doe'], facts: [{ id: 'kf_3', text: 'Role: CFO', source: agent() }], createdAt: T0 + 2 })
const decision = node({ id: 'kn_dec', kind: 'decision', name: 'Migrate billing to Stripe', facts: [{ id: 'kf_4', text: 'Agreed at the kickoff call', source: agent() }], createdAt: T0 + 3 })
const vendor = node({ id: 'kn_v', kind: 'vendor', name: 'Stripe', source: user(), createdAt: T0 + 4, retired: true })
const kickoff = note({ id: 'n1', title: 'Kickoff call summary', excerpt: 'Kickoff call with Jane Doe (CFO).', source: 'agent', recordedBy: { runId: 'r1', role: 'Analyst' }, createdAt: T0 + 5 })
const mine = note({ id: 'n2', title: 'Glossary', excerpt: 'Terms.', createdAt: T0 })

const graph: KnowledgeGraph = {
  version: 1,
  nodes: [acme, jane, decision, vendor],
  edges: [
    { id: 'ke_1', from: 'kn_jane', to: 'kn_acme', relation: 'works-at', source: agent(), createdAt: T0 + 2 },
    { id: 'ke_2', from: 'kn_dec', to: 'kn_jane', relation: 'decided-by', note: 'Sponsor sign-off', source: agent(), createdAt: T0 + 3 }
  ]
}
const items = itemsOf(graph, [kickoff, mine])
const runs = { indexes: new Map([['r1', 1]]), names: new Map([['r1', 'Summarise the kickoff']]) }

describe('kinds', () => {
  it('labels common kinds with plurals and free-form kinds as typed', () => {
    expect(kindLabel('open-question')).toBe('Open question')
    expect(kindGroupLabel('open-question')).toBe('Open questions')
    expect(kindGroupLabel('person')).toBe('People')
    expect(kindGroupLabel('vendor')).toBe('Vendor')
    expect(kindGroupLabel('note')).toBe('Notes')
    expect(kindLabel('note')).toBe('Note')
    expect(keyWords('decided-by')).toBe('decided by')
  })
  it('orders common kinds first, free-form kinds alphabetically, notes last', () => {
    expect(kindOrder(['note', 'zebra', 'risk', 'person', 'apple'])).toEqual(['person', 'risk', 'apple', 'zebra', 'note'])
  })
  it('gives kinds a role colour slot, common ones fixed', () => {
    expect(kindColor('person')).toBe(ROLE_COLORS[0])
    expect(kindColor('organisation')).toBe(ROLE_COLORS[1])
    // A free-form kind's colour depends only on its own key.
    expect(ROLE_COLORS).toContain(kindColor('vendor'))
    expect(kindColor('vendor')).toBe(kindColor('vendor'))
    expect(kindColor('constructor')).toBeDefined()
    expect(kindMark('person')).toBe('solid')
    expect(kindMark('meeting')).toBe('ring')
    expect(kindMark('vendor')).toBe('ring-dot')
    expect(kindMark('constructor')).toBe('ring-dot')
    // Prototype keys are plain free-form kinds everywhere: no throw while sorting or labelling.
    expect(kindGroupLabel('constructor')).toBe('Constructor')
    expect(kindOrder(['constructor', 'vendor', 'to-string'])).toEqual(expect.arrayContaining(['constructor', 'vendor', 'to-string']))
  })
})

describe('items', () => {
  it('reads the excerpt from the first live fact, the summary, or the note excerpt', () => {
    expect(itemExcerpt(items[0])).toBe('Headquartered in Leeds')
    expect(itemExcerpt(items[3])).toBe('')
    expect(itemExcerpt(items[4])).toBe('Kickoff call with Jane Doe (CFO).')
    expect(itemExcerpt({ type: 'node', id: 'x', node: node({ id: 'x', kind: 'system', name: 'SAP', summary: '  An ERP\n system ' }) })).toBe('An ERP system')
  })
  it('reads the source of nodes and notes, old notes as the user', () => {
    expect(itemSource(items[0])).toEqual({ by: 'agent', runId: 'r1', role: 'Analyst', at: T0 })
    expect(itemSource(items[4])).toEqual({ by: 'agent', runId: 'r1', role: 'Analyst', at: T0 + 5 })
    expect(itemSource(items[5])).toEqual({ by: 'user', at: T0 })
  })
  it('orders by creation time, never by updates', () => {
    const touched = { ...jane, updatedAt: T0 + 100 }
    expect(orderItems(itemsOf({ nodes: [touched, acme] }, [mine])).map((i) => i.id)).toEqual(['n2', 'kn_acme', 'kn_jane'])
  })
  it('groups in kind order, notes last', () => {
    const groups = groupItems(searchItems(items, { ...EMPTY_FILTER, showRetired: true }))
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['People', ['kn_jane']],
      ['Organisations', ['kn_acme']],
      ['Decisions', ['kn_dec']],
      ['Vendor', ['kn_v']],
      ['Notes', ['n2', 'n1']]
    ])
  })
  it('hides retired items unless asked, and filters by kind and origin', () => {
    expect(searchItems(items, EMPTY_FILTER).map((i) => i.id)).toEqual(['n2', 'kn_acme', 'kn_jane', 'kn_dec', 'n1'])
    expect(searchItems(items, { ...EMPTY_FILTER, kinds: ['person', 'note'] }).map((i) => i.id)).toEqual(['n2', 'kn_jane', 'n1'])
    expect(searchItems(items, { ...EMPTY_FILTER, origins: ['user'], showRetired: true }).map((i) => i.id)).toEqual(['n2', 'kn_v'])
    expect(kindCounts(items, false)).toEqual([
      { kind: 'person', label: 'People', count: 1 },
      { kind: 'organisation', label: 'Organisations', count: 1 },
      { kind: 'decision', label: 'Decisions', count: 1 },
      { kind: 'note', label: 'Notes', count: 2 }
    ])
    expect(originCounts(items, false)).toEqual({ user: 1, agent: 4 })
    expect(originCounts(items, true)).toEqual({ user: 2, agent: 4 })
  })
})

describe('search', () => {
  it('ranks name, alias, then facts and notes', () => {
    expect(searchRank(items[0], 'acme')).toBe(1)
    expect(searchRank(items[0], 'corp')).toBe(2)
    expect(searchRank(items[1], 'doe')).toBe(2)
    expect(searchRank(items[1], 'j. d')).toBe(3)
    expect(searchRank(items[0], 'leeds')).toBe(4)
    expect(searchRank(items[0], 'march')).toBeNull()
    expect(searchRank(items[4], 'cfo')).toBe(4)
    expect(searchRank(items[0], '')).toBe(0)
    expect(searchRank(items[0], 'acme leeds')).toBe(4)
    expect(searchRank(items[0], 'acme corp')).toBe(1)
  })
  it('lists best matches first, creation order within a rank', () => {
    expect(searchItems(items, { ...EMPTY_FILTER, query: 'Acme' }).map((i) => i.id)).toEqual(['kn_acme'])
    expect(searchItems(items, { ...EMPTY_FILTER, query: 'kickoff' }).map((i) => i.id)).toEqual(['n1', 'kn_dec'])
    expect(searchItems(items, { ...EMPTY_FILTER, query: 'jane' }).map((i) => i.id)).toEqual(['kn_jane', 'n1'])
    expect(countLine(2, 6)).toBe('2 of 6 items')
    expect(countLine(1, 1)).toBe('1 of 1 item')
  })
})

describe('provenance', () => {
  it('writes the row line', () => {
    expect(provenanceLine(itemSource(items[0]), runs)).toBe('Analyst · R1 · 4 Nov 2026')
    expect(provenanceLine({ by: 'agent', runId: 'r9', at: T0 }, runs)).toBe('Agent · R? · 4 Nov 2026')
    expect(provenanceLine({ by: 'user', at: T0 }, runs)).toBe('You · 4 Nov 2026')
    expect(roleWord('Ana​lyst')).toBe('Agent')
    expect(roleWord('x'.repeat(70))).toHaveLength(64)
  })
  it('writes the history block', () => {
    expect(historyLines(items[0], runs)).toEqual([{ text: 'Recorded by Analyst in R1 Summarise the kickoff, 4 Nov 2026 11:46', runId: 'r1', at: T0 }])
    const edited = { ...acme, updatedBy: user(T0 + 60_000) }
    expect(historyLines({ type: 'node', id: edited.id, node: edited }, runs).map((l) => l.text)).toEqual([
      'Recorded by Analyst in R1 Summarise the kickoff, 4 Nov 2026 11:46',
      'Edited by you, 4 Nov 2026 11:47'
    ])
    const retired = { ...acme, retired: true, updatedBy: agent(T0 + 60_000) }
    expect(historyLines({ type: 'node', id: retired.id, node: retired }, runs).map((l) => l.text)[1]).toBe('Retired by Analyst in R1 Summarise the kickoff, 4 Nov 2026 11:47')
    expect(historyLines({ type: 'node', id: 'v', node: vendor }, runs).map((l) => l.text)).toEqual(['Added by you, 4 Nov 2026 11:46', 'Retired'])
    const editedNote = { ...kickoff, updatedBy: 'user' as const, updatedAt: T0 + 120_000 }
    expect(historyLines({ type: 'note', id: 'n1', note: editedNote }, runs).map((l) => l.text)).toEqual([
      'Recorded by Analyst in R1 Summarise the kickoff, 4 Nov 2026 11:46',
      'Edited by you, 4 Nov 2026 11:48'
    ])
  })
})

describe('relations and summaries', () => {
  it('reads edges from both sides with hyphens as spaces', () => {
    expect(relatedRows(graph, 'kn_jane', false).map((r) => r.text)).toEqual(['works at Acme Corp', 'Migrate billing to Stripe decided by'])
    expect(relatedRows(graph, 'kn_acme', false)[0]).toMatchObject({ outgoing: false, text: 'Jane Doe works at' })
  })
  it('writes the settings summary and the clear counts', () => {
    expect(knowledgeSummaryLine(graph, [kickoff, mine])).toBe('3 items (1 person, 1 organisation, 1 decision), 2 notes, 3 facts')
    expect(knowledgeSummaryLine({ nodes: [] }, [])).toBe('Nothing recorded yet')
    expect(knowledgeSummaryLine({ nodes: [] }, [kickoff, mine])).toBe('2 notes')
    expect(knowledgeSummaryLine({ nodes: [jane, { ...acme, kind: 'person', id: 'p2' }] }, [])).toBe('2 items (2 people), 2 facts')
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => node({ id: `kn_${k}`, kind: `kind-${k}`, name: k }))
    expect(knowledgeSummaryLine({ nodes: many }, [])).toBe('7 items (1 kind a, 1 kind b, 1 kind c, 1 kind d, 1 kind e, 2 more)')
    expect(clearCountsLine(graph)).toBe('4 items (1 retired), 4 facts (1 retired), 2 relations')
    expect(clearCountsLine({ nodes: [], edges: [] })).toBe('0 items, 0 facts, 0 relations')
  })
  it('resolves focus requests by id, name or title', () => {
    expect(resolveFocus(items, { nodeId: 'kn_jane' })).toBe('kn_jane')
    expect(resolveFocus(items, { kind: 'person', name: 'j. doe' })).toBe('kn_jane')
    expect(resolveFocus(items, { kind: 'risk', name: 'Jane Doe' })).toBeNull()
    expect(resolveFocus(items, { noteTitle: 'kickoff call summary' })).toBe('n1')
    expect(resolveFocus(items, { nodeId: 'kn_gone' })).toBeNull()
    expect(idAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c')
    expect(idAfterRemoval(['a', 'b'], 'b')).toBe('a')
    expect(idAfterRemoval(['a'], 'a')).toBeNull()
  })
  it('splits a history line around its run link', () => {
    const [line] = historyLines({ type: 'node', id: jane.id, node: jane }, runs)
    expect(splitHistoryLine(line, runs)).toEqual({ before: 'Recorded by Analyst in ', link: 'R1 Summarise the kickoff', after: ', 4 Nov 2026 11:46' })
    expect(splitHistoryLine({ text: 'Added by you, 4 Nov 2026 11:46', at: T0 }, runs)).toBeNull()
    expect(splitHistoryLine({ text: 'Recorded by Analyst in R? , now', runId: 'r9', at: T0 }, runs)).toEqual({ before: 'Recorded by Analyst in ', link: 'R?', after: ' , now' })
  })
})
