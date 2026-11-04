import { describe, expect, it } from 'vitest'
import type { KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '@shared/types'
import { ROLE_COLORS } from '@shared/defaults'
import { EMPTY_FILTER, kindColor } from './knowledge'
import {
  DEFAULT_GRAPH_DEPTH,
  EDGE_LABEL_MIN_ZOOM,
  SHOW_ALL_WARN_AT,
  drawnAnnouncement,
  drawnGraph,
  drawnNeighbours,
  edgeLabelsShown,
  factCount,
  filteredNodeIds,
  foldRetired,
  graphCentreId,
  groupSpokenName,
  isRetiredGroupId,
  knowledgeNodeSize,
  layoutItems,
  legendEntries,
  needsShowAllConfirm,
  neighbourInDirection,
  neighbourhood,
  nodeCountsLine,
  nodeSpokenName,
  relationTexts,
  retiredGroupId,
  retiredGroupLabel,
  retiredGroupSize,
  showAllWarning,
  topologyKey
} from './knowledgeGraph'

const T0 = new Date(2026, 10, 4, 11, 46).getTime()
const agent = { by: 'agent' as const, runId: 'r1', agentId: 'root', role: 'Analyst', at: T0 }
const user = { by: 'user' as const, at: T0 }

let seq = 0
function node(p: Partial<KnowledgeNode> & { id: string; name: string; kind: string }): KnowledgeNode {
  seq += 1
  return { facts: [], source: agent, createdAt: T0 + seq * 1000, updatedAt: T0, ...p }
}
function edge(id: string, from: string, to: string, relation: string, extra: Partial<KnowledgeEdge> = {}): KnowledgeEdge {
  seq += 1
  return { id, from, to, relation, source: agent, createdAt: T0 + seq * 1000, ...extra }
}

/** The [mock:knowledge] shape plus a retired vendor hanging off Acme and a retired relation from Jane to a live tool. */
function fixture(): KnowledgeGraph {
  seq = 0
  const acme = node({ id: 'kn_acme', name: 'Acme Corp', kind: 'organisation', facts: [{ id: 'kf_1', text: 'Headquartered in Leeds', source: agent }, { id: 'kf_2', text: 'Fiscal year ends in March', source: agent, retired: true }] })
  const jane = node({ id: 'kn_jane', name: 'Jane Doe', kind: 'person', facts: [{ id: 'kf_3', text: 'Role: CFO', source: agent }, { id: 'kf_4', text: 'Prefers written summaries', source: agent }] })
  const decision = node({ id: 'kn_dec', name: 'Migrate billing to Stripe', kind: 'decision', facts: [{ id: 'kf_5', text: 'Agreed at the kickoff call', source: agent }] })
  const risk = node({ id: 'kn_risk', name: 'Legacy export format undocumented', kind: 'risk', facts: [{ id: 'kf_6', text: 'No one owns the export spec', source: agent }] })
  const vendor = node({ id: 'kn_vendor', name: 'Old Vendor', kind: 'organisation', retired: true, source: user })
  const tool = node({ id: 'kn_tool', name: 'Spreadsheet tracker', kind: 'system' })
  return {
    version: 1,
    nodes: [acme, jane, decision, risk, vendor, tool],
    edges: [
      edge('ke_1', 'kn_jane', 'kn_acme', 'works-at'),
      edge('ke_2', 'kn_dec', 'kn_jane', 'decided-by', { note: 'Sponsor sign-off' }),
      edge('ke_3', 'kn_acme', 'kn_vendor', 'used'),
      edge('ke_4', 'kn_jane', 'kn_tool', 'uses', { retired: true })
    ]
  }
}

describe('neighbourhood', () => {
  it('draws the centre and its live neighbours at depth 1, their edges only', () => {
    const nb = neighbourhood(fixture(), 'kn_jane', 1)!
    expect(nb.ids).toEqual(['kn_jane', 'kn_acme', 'kn_dec'])
    expect(nb.edges.map((e) => e.id)).toEqual(['ke_1', 'ke_2'])
    expect(nb.parents.get('kn_acme')).toBe('kn_jane')
    expect(nb.parents.get('kn_dec')).toBe('kn_jane')
    expect(nb.parents.has('kn_jane')).toBe(false)
  })
  it('depth 2 reaches the neighbours of neighbours but not retired ones or retired relations', () => {
    const nb = neighbourhood(fixture(), 'kn_dec', 2)!
    expect(nb.ids).toEqual(['kn_dec', 'kn_jane', 'kn_acme'])
    expect(nb.parents.get('kn_acme')).toBe('kn_jane')
  })
  it('with Show retired the retired vendor and the retired relation count', () => {
    const nb = neighbourhood(fixture(), 'kn_jane', 2, { ...EMPTY_FILTER, showRetired: true })!
    expect(nb.ids).toEqual(['kn_jane', 'kn_acme', 'kn_dec', 'kn_tool', 'kn_vendor'])
    expect(nb.edges.map((e) => e.id)).toEqual(['ke_1', 'ke_2', 'ke_3', 'ke_4'])
  })
  it('a neighbour the kind filter drops is not reached, nor what is behind it', () => {
    const nb = neighbourhood(fixture(), 'kn_dec', 2, { ...EMPTY_FILTER, kinds: ['decision', 'organisation'] })!
    expect(nb.ids).toEqual(['kn_dec'])
  })
  it('the centre stays even when the filter drops it; an unknown centre is null', () => {
    expect(neighbourhood(fixture(), 'kn_jane', 1, { ...EMPTY_FILTER, kinds: ['organisation'] })!.ids).toEqual(['kn_jane', 'kn_acme'])
    expect(neighbourhood(fixture(), 'kn_nope', 1)).toBeNull()
  })
  it('depth 0 is the centre alone', () => {
    expect(neighbourhood(fixture(), 'kn_jane', 0)!.ids).toEqual(['kn_jane'])
  })
})

describe('foldRetired', () => {
  it('folds the retired vendor under Acme and the far end of the retired relation under Jane', () => {
    const groups = foldRetired(fixture(), ['kn_jane', 'kn_acme', 'kn_dec'])
    expect(groups.map((g) => [g.parentId, g.members.map((m) => m.id), g.edges.map((e) => e.id)])).toEqual([
      ['kn_jane', ['kn_tool'], ['ke_4']],
      ['kn_acme', ['kn_vendor'], ['ke_3']]
    ])
  })
  it('an item hanging off two drawn nodes folds under the first only', () => {
    const g = fixture()
    g.edges.push(edge('ke_5', 'kn_dec', 'kn_vendor', 'about'))
    const groups = foldRetired(g, ['kn_dec', 'kn_acme'])
    expect(groups.map((x) => [x.parentId, x.members.map((m) => m.id)])).toEqual([['kn_dec', ['kn_vendor']]])
  })
  it('nothing folds with Show retired, or for a drawn member, or for a kind the filter drops', () => {
    expect(foldRetired(fixture(), ['kn_acme'], { ...EMPTY_FILTER, showRetired: true })).toEqual([])
    expect(foldRetired(fixture(), ['kn_acme', 'kn_vendor'])).toEqual([])
    expect(foldRetired(fixture(), ['kn_acme'], { ...EMPTY_FILTER, kinds: ['person'] })).toEqual([])
  })
  it('group ids', () => {
    expect(retiredGroupId('kn_x')).toBe('retired:kn_x')
    expect(isRetiredGroupId('retired:kn_x')).toBe(true)
    expect(isRetiredGroupId('kn_x')).toBe(false)
  })
})

describe('drawnGraph', () => {
  const base = { graph: fixture(), filter: EMPTY_FILTER, depth: DEFAULT_GRAPH_DEPTH, showAll: false }
  it('nothing without a selected node (or a note selected)', () => {
    expect(drawnGraph({ ...base, selectedId: null }).nodes).toEqual([])
    expect(drawnGraph({ ...base, selectedId: 'note_1' }).nodes).toEqual([])
  })
  it('the neighbourhood in list order with its groups and tree', () => {
    const d = drawnGraph({ ...base, selectedId: 'kn_jane' })
    expect(d.nodes.map((n) => n.id)).toEqual(['kn_acme', 'kn_jane', 'kn_dec'])
    expect(d.edges.map((e) => e.id)).toEqual(['ke_1', 'ke_2'])
    expect(d.groups.map((g) => g.parentId)).toEqual(['kn_jane', 'kn_acme'])
    expect(d.parents.get('retired:kn_acme')).toBe('kn_acme')
    expect(d.parents.get('kn_acme')).toBe('kn_jane')
    expect(d.centreId).toBe('kn_jane')
    expect(d.expandedMembers.size).toBe(0)
  })
  it('an expanded group draws its members as retired nodes with dashed-to-be relations', () => {
    const d = drawnGraph({ ...base, selectedId: 'kn_jane', expanded: new Set(['kn_acme']) })
    expect(d.nodes.map((n) => n.id)).toEqual(['kn_acme', 'kn_jane', 'kn_dec', 'kn_vendor'])
    expect(d.groups.map((g) => g.parentId)).toEqual(['kn_jane'])
    expect(d.edges.map((e) => e.id)).toEqual(['ke_1', 'ke_2', 'ke_3'])
    expect(d.expandedMembers).toEqual(new Set(['kn_vendor']))
    expect(d.parents.get('kn_vendor')).toBe('kn_acme')
  })
  it('an expanded retired relation draws its live far end and the retired edge', () => {
    const d = drawnGraph({ ...base, selectedId: 'kn_jane', expanded: new Set(['kn_jane']) })
    expect(d.nodes.map((n) => n.id)).toContain('kn_tool')
    expect(d.edges.map((e) => e.id)).toContain('ke_4')
  })
  it('Show all draws every filtered node as a forest from the centre, retired folded', () => {
    const d = drawnGraph({ ...base, selectedId: 'kn_jane', showAll: true })
    expect(d.nodes.map((n) => n.id)).toEqual(['kn_acme', 'kn_jane', 'kn_dec', 'kn_risk', 'kn_tool'])
    expect(d.parents.get('kn_acme')).toBe('kn_jane')
    expect(d.parents.has('kn_risk')).toBe(false)
    expect(d.parents.has('kn_tool')).toBe(false)
    expect(d.groups.map((g) => [g.parentId, g.members.map((m) => m.id)])).toEqual([['kn_acme', ['kn_vendor']]])
  })
  it('Show all without a selection and with Show retired', () => {
    const d = drawnGraph({ ...base, selectedId: null, showAll: true, filter: { ...EMPTY_FILTER, showRetired: true } })
    expect(d.nodes).toHaveLength(6)
    expect(d.edges).toHaveLength(4)
    expect(d.groups).toEqual([])
    expect(d.centreId).toBeNull()
  })
  it('Show all keeps the centre even when the filter drops it', () => {
    const d = drawnGraph({ ...base, selectedId: 'kn_jane', showAll: true, filter: { ...EMPTY_FILTER, kinds: ['risk'] } })
    expect(d.nodes.map((n) => n.id)).toEqual(['kn_jane', 'kn_risk'])
  })
  it('filteredNodeIds follows applyFilter', () => {
    expect(filteredNodeIds(fixture(), EMPTY_FILTER)).toHaveLength(5)
    expect(filteredNodeIds(fixture(), { ...EMPTY_FILTER, origins: ['user'], showRetired: true })).toEqual(['kn_vendor'])
  })
  it('graphCentreId', () => {
    expect(graphCentreId(fixture(), 'kn_jane')).toBe('kn_jane')
    expect(graphCentreId(fixture(), 'note_1')).toBeNull()
    expect(graphCentreId(fixture(), null)).toBeNull()
  })
})

describe('names', () => {
  it('facts and relation texts from the node side, live only unless asked', () => {
    const g = fixture()
    expect(factCount(g.nodes[0])).toBe(1)
    expect(factCount(g.nodes[0], true)).toBe(2)
    expect(relationTexts(g, 'kn_jane')).toEqual(['works at Acme Corp', 'Migrate billing to Stripe decided by'])
    expect(relationTexts(g, 'kn_jane', true)).toEqual(['works at Acme Corp', 'Migrate billing to Stripe decided by', 'uses Spreadsheet tracker'])
    expect(relationTexts(g, 'kn_acme')).toEqual(['Jane Doe works at'])
  })
  it('the spoken name reads kind, counts, relations and the Enter hint', () => {
    expect(nodeSpokenName({ name: 'Jane Doe', kind: 'person' }, 3, ['works at Acme Corp', 'Migrate billing to Stripe decided by'])).toBe(
      'Jane Doe, person. 3 facts, 2 relations: works at Acme Corp, Migrate billing to Stripe decided by. Press Enter to open.'
    )
    expect(nodeSpokenName({ name: 'X', kind: 'open-question', retired: true }, 1, [])).toBe('X, open question, retired. 1 fact, 0 relations. Press Enter to open.')
    const many = Array.from({ length: 8 }, (_, i) => `r${i}`)
    expect(nodeSpokenName({ name: 'X', kind: 'system' }, 0, many)).toBe('X, system. 0 facts, 8 relations: r0, r1, r2, r3, r4, r5, and 2 more. Press Enter to open.')
  })
  it('group names and labels', () => {
    expect(groupSpokenName(3, 'Jane Doe')).toBe('3 retired items under Jane Doe. Press Enter to show them.')
    expect(groupSpokenName(1, 'Acme Corp')).toBe('1 retired item under Acme Corp. Press Enter to show them.')
    expect(retiredGroupLabel(2)).toBe('2 retired')
    expect(nodeCountsLine(1, 1)).toBe('1 fact · 1 relation')
    expect(nodeCountsLine(3, 2)).toBe('3 facts · 2 relations')
  })
  it('the announcement counts items, relations and folded retired', () => {
    const d = drawnGraph({ graph: fixture(), filter: EMPTY_FILTER, depth: 1, showAll: false, selectedId: 'kn_jane' })
    expect(drawnAnnouncement(d)).toBe('Showing 3 items and 2 relations, 2 retired folded.')
    expect(drawnAnnouncement({ nodes: [d.nodes[0]], edges: [], groups: [] })).toBe('Showing 1 item and 0 relations.')
  })
})

describe('legend, warning and zoom', () => {
  it('lists the drawn kinds in order with their colours, the relations alphabetically, and the retired cues', () => {
    const g = fixture()
    const kindsInUse = ['organisation', 'person', 'decision', 'risk', 'system']
    const d = drawnGraph({ graph: g, filter: EMPTY_FILTER, depth: 1, showAll: false, selectedId: 'kn_jane' })
    const l = legendEntries(d, kindsInUse)
    expect(l.kinds.map((k) => k.label)).toEqual(['Person', 'Organisation', 'Decision'])
    expect(l.kinds[0].color).toBe(kindColor('person', kindsInUse))
    expect(ROLE_COLORS).toContain(l.kinds[0].color)
    expect(l.relations.map((r) => r.label)).toEqual(['decided by', 'works at'])
    expect(l.retired).toBe(false)
    expect(l.groups).toBe(true)
    const all = legendEntries(drawnGraph({ graph: g, filter: { ...EMPTY_FILTER, showRetired: true }, depth: 2, showAll: false, selectedId: 'kn_jane' }), kindsInUse)
    expect(all.retired).toBe(true)
    expect(all.groups).toBe(false)
  })
  it('Show all asks past 150 nodes', () => {
    expect(SHOW_ALL_WARN_AT).toBe(150)
    expect(needsShowAllConfirm(150)).toBe(false)
    expect(needsShowAllConfirm(151)).toBe(true)
    expect(showAllWarning(420)).toBe('Showing all 420 items may be slow and hard to read. Show them anyway?')
  })
  it('edge labels show at zoom 1 and above', () => {
    expect(EDGE_LABEL_MIN_ZOOM).toBe(1)
    expect(edgeLabelsShown(1)).toBe(true)
    expect(edgeLabelsShown(1.4)).toBe(true)
    expect(edgeLabelsShown(0.99)).toBe(false)
    expect(edgeLabelsShown(Number.NaN)).toBe(false)
  })
})

describe('sizes, layout items and keys', () => {
  it('node and group boxes per style', () => {
    expect(knowledgeNodeSize('card', 'top-down')).toEqual({ width: 220, height: 96 })
    expect(knowledgeNodeSize('compact', 'top-down')).toEqual({ width: 160, height: 40 })
    expect(knowledgeNodeSize('station', 'top-down')).toEqual({ width: 160, height: 40 })
    expect(knowledgeNodeSize('station', 'radial')).toEqual({ width: 120, height: 64 })
    expect(knowledgeNodeSize('hex', 'radial')).toEqual({ width: 120, height: 104 })
    expect(retiredGroupSize('card', 'top-down')).toEqual({ width: 220, height: 56 })
    expect(retiredGroupSize('compact', 'top-down')).toEqual({ width: 160, height: 40 })
    expect(retiredGroupSize('hex', 'radial')).toEqual({ width: 120, height: 104 })
  })
  it('layout items hang nodes and groups off their parents', () => {
    const d = drawnGraph({ graph: fixture(), filter: EMPTY_FILTER, depth: 1, showAll: false, selectedId: 'kn_jane' })
    const items = layoutItems(d, { width: 220, height: 96 }, { width: 220, height: 56 })
    expect(items.map((i) => [i.id, i.parentId])).toEqual([
      ['kn_acme', 'kn_jane'],
      ['kn_jane', null],
      ['kn_dec', 'kn_jane'],
      ['retired:kn_jane', 'kn_jane'],
      ['retired:kn_acme', 'kn_acme']
    ])
    expect(items[3]).toMatchObject({ width: 220, height: 56 })
    const key = topologyKey(d)
    expect(key).toContain('kn_acme>kn_jane')
    expect(key).toContain('retired:kn_acme>kn_acme:1')
    expect(topologyKey(drawnGraph({ graph: fixture(), filter: EMPTY_FILTER, depth: 2, showAll: false, selectedId: 'kn_jane' }))).toBe(key)
  })
})

describe('keyboard', () => {
  it('drawn neighbours over both directions, each once', () => {
    expect(drawnNeighbours(fixture().edges, 'kn_jane')).toEqual(['kn_acme', 'kn_dec', 'kn_tool'])
    expect(drawnNeighbours([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], 'a')).toEqual(['b'])
  })
  it('Ctrl+Arrow picks the neighbour most in that direction', () => {
    const pos = { c: { x: 0, y: 0 }, r: { x: 200, y: 10 }, d: { x: 20, y: 200 }, u: { x: -10, y: -150 }, far: { x: 400, y: 300 } }
    const all = ['r', 'd', 'u', 'far']
    expect(neighbourInDirection(pos, 'c', all, 'right')).toBe('r')
    expect(neighbourInDirection(pos, 'c', all, 'down')).toBe('d')
    expect(neighbourInDirection(pos, 'c', all, 'up')).toBe('u')
    expect(neighbourInDirection(pos, 'c', all, 'left')).toBeNull()
    expect(neighbourInDirection(pos, 'c', ['far', 'r'], 'right')).toBe('r')
    expect(neighbourInDirection(pos, 'nope', all, 'right')).toBeNull()
  })
})
