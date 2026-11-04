import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KnowledgeGraph, KnowledgeSource } from '@shared/types'
import {
  KNOWLEDGE_ALIASES_MAX,
  KNOWLEDGE_EDGES_MAX,
  KNOWLEDGE_EDGE_NOTE_MAX_CHARS,
  KNOWLEDGE_FACT_MAX_CHARS,
  KNOWLEDGE_NAME_MAX_CHARS,
  KNOWLEDGE_NODES_MAX,
  KNOWLEDGE_NODE_FACTS_MAX,
  KNOWLEDGE_NODE_NOTES_MAX,
  KNOWLEDGE_SUMMARY_MAX_CHARS
} from '@shared/types'
import {
  clearKnowledge,
  knowledgeFile,
  knowledgeNodeCount,
  knowledgeStore,
  readKnowledge,
  removeEdge,
  removeNode,
  retireItem,
  saveEdge,
  saveNodeForUser,
  upsertNode
} from './knowledge'
import { projectDataDir, removeNote, saveNote } from './projectData'

let dir: string
const P = 'proj_a'
const agent: KnowledgeSource = { by: 'agent', at: 1000, runId: 'run_1', agentId: 'agent_1', role: 'Analyst' }
const user: KnowledgeSource = { by: 'user', at: 2000 }
const ZWSP = '​'
const RLO = '‮'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-kg-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const graphOf = (): KnowledgeGraph => readKnowledge(dir, P)
const fileText = (): string => readFileSync(knowledgeFile(dir, P), 'utf8')
const writeRaw = (value: unknown, projectId = P): void => {
  mkdirSync(projectDataDir(dir, projectId), { recursive: true })
  writeFileSync(knowledgeFile(dir, projectId), typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}
const person = (name: string, extra: Record<string, unknown> = {}) => upsertNode(dir, P, { kind: 'person', name, ...extra }, agent)
const noTmp = (): void => expect(readdirSync(projectDataDir(dir, P)).filter((f) => f.endsWith('.tmp'))).toEqual([])

describe('paths and empty reads', () => {
  it('builds the file path under the project data dir and refuses an unsafe id', () => {
    expect(knowledgeFile(dir, P)).toBe(join(dir, 'projects', P, 'knowledge.json'))
    expect(() => knowledgeFile(dir, '../x')).toThrow()
    expect(readKnowledge(dir, '../x')).toEqual({ version: 1, nodes: [], edges: [] })
    expect(knowledgeNodeCount(dir, '../x')).toBe(0)
    expect(() => upsertNode(dir, '../x', { kind: 'person', name: 'A' }, agent)).toThrow('Invalid project id')
    expect(() => saveNodeForUser(dir, 'a/b', { kind: 'person', name: 'A' })).toThrow()
  })

  it('reads an empty graph when there is no file, and 0 nodes', () => {
    expect(graphOf()).toEqual({ version: 1, nodes: [], edges: [] })
    expect(knowledgeNodeCount(dir, P)).toBe(0)
  })
})

describe('upsertNode (agent path)', () => {
  it('creates a node with ids, source, facts and the graph timestamp', () => {
    const r = person('Ada Lovelace', { aliases: ['Ada'], summary: ' Analyst at Acme ', facts: ['Leads the data team', 'Based in London'], noteIds: [] })
    expect(r.created).toBe(true)
    expect(r.node.id).toMatch(/^kn_[0-9a-f]{12}$/)
    expect(r.node).toMatchObject({ kind: 'person', name: 'Ada Lovelace', aliases: ['Ada'], summary: 'Analyst at Acme', source: agent, createdAt: expect.any(Number) })
    expect(r.node.facts.map((f) => f.id)).toEqual([expect.stringMatching(/^kf_[0-9a-f]{12}$/), expect.stringMatching(/^kf_[0-9a-f]{12}$/)])
    expect(r.node.facts[0]).toMatchObject({ text: 'Leads the data team', source: agent })
    expect(r.node.noteIds).toBeUndefined()
    expect(r.node.updatedBy).toBeUndefined()
    const g = graphOf()
    expect(g.nodes).toEqual([r.node])
    expect(g.updatedAt).toEqual(expect.any(Number))
    expect(JSON.parse(fileText())).toMatchObject({ version: 1 })
    expect(knowledgeNodeCount(dir, P)).toBe(1)
    noTmp()
  })

  it('matches by name case- and whitespace-insensitively and merges instead of creating', () => {
    const a = person('Ada Lovelace', { facts: ['Fact one'] })
    const b = upsertNode(dir, P, { kind: 'Person', name: '  ada   LOVELACE ', facts: ['fact ONE', 'Fact two'], summary: 'New summary' }, { ...agent, at: 5000, role: 'Lead' })
    expect(b.created).toBe(false)
    expect(b.node.id).toBe(a.node.id)
    expect(b.node.name).toBe('Ada Lovelace')
    expect(b.node.aliases).toBeUndefined()
    expect(b.node.facts.map((f) => f.text)).toEqual(['Fact one', 'Fact two'])
    expect(b.node.facts[1].source.role).toBe('Lead')
    expect(b.node.summary).toBe('New summary')
    expect(b.node.updatedBy).toMatchObject({ by: 'agent', role: 'Lead' })
    expect(graphOf().nodes).toHaveLength(1)
    // A different kind with the same name is a different entity.
    expect(upsertNode(dir, P, { kind: 'system', name: 'Ada Lovelace' }, agent).created).toBe(true)
  })

  it('matches by alias, adds the input name as an alias, keeps the stored name', () => {
    const a = person('Acme Corporation', { aliases: ['Acme'] })
    const b = upsertNode(dir, P, { kind: 'person', name: 'ACME', aliases: ['Acme Corp'] }, agent)
    expect(b.created).toBe(false)
    expect(b.node.id).toBe(a.node.id)
    expect(b.node.name).toBe('Acme Corporation')
    expect(b.node.aliases).toEqual(['Acme', 'Acme Corp'])
    // Matching through an alias of the input against an existing name.
    const c = upsertNode(dir, P, { kind: 'person', name: 'Something else', aliases: ['acme corporation'] }, agent)
    expect(c.created).toBe(false)
    expect(c.node.aliases).toEqual(['Acme', 'Acme Corp', 'Something else'])
  })

  it('nodeId wins over the name; an unknown id throws', () => {
    const a = person('Ada')
    const b = upsertNode(dir, P, { nodeId: a.node.id, kind: 'organisation', name: 'Different', facts: ['x'] }, agent)
    expect(b.created).toBe(false)
    expect(b.node).toMatchObject({ id: a.node.id, kind: 'person', name: 'Ada', aliases: ['Different'] })
    expect(() => upsertNode(dir, P, { nodeId: 'kn_000000000000', kind: 'person', name: 'Ada' }, agent)).toThrow('No entity with id "kn_000000000000".')
  })

  it('ignores an empty summary, does not re-append a live fact text, re-appends a retired one, and adds note links', () => {
    const n1 = saveNote(dir, P, { title: 'Brief', text: 'b' })
    const a = person('Ada', { summary: 'Keep me', facts: ['Same text'] })
    const b = upsertNode(dir, P, { kind: 'person', name: 'Ada', summary: '  ', facts: ['same   TEXT', 'same text'], noteIds: [n1.id] }, agent)
    expect(b.node.summary).toBe('Keep me')
    expect(b.node.facts).toHaveLength(1)
    expect(b.node.noteIds).toEqual([n1.id])
    retireItem(dir, P, { factId: a.node.facts[0].id }, agent)
    const c = upsertNode(dir, P, { kind: 'person', name: 'Ada', facts: ['Same text'], noteIds: [n1.id] }, agent)
    expect(c.node.facts.map((f) => !!f.retired)).toEqual([true, false])
    expect(c.node.noteIds).toEqual([n1.id])
  })

  it('merges into a retired node without un-retiring it and prefers a live match over a retired one', () => {
    const a = person('Ada')
    retireItem(dir, P, { nodeId: a.node.id }, agent)
    const b = person('ada')
    expect(b.created).toBe(false)
    expect(b.node.retired).toBe(true)
    // Two nodes answer to the same alias: the live one wins.
    const c = person('Grace', { aliases: ['GH'] })
    const d = upsertNode(dir, P, { kind: 'person', name: 'GH' }, agent)
    expect(d.node.id).toBe(c.node.id)
    retireItem(dir, P, { nodeId: c.node.id }, agent)
    const e = saveNodeForUser(dir, P, { kind: 'person', name: 'Grace Hopper', aliases: ['GH2'] })
    writeRaw({ ...graphOf(), nodes: graphOf().nodes.map((n) => (n.id === e.id ? { ...n, aliases: ['GH'] } : n)) })
    expect(upsertNode(dir, P, { kind: 'person', name: 'gh' }, agent).node.id).toBe(e.id)
  })

  it('skips an alias that names another entity of the kind on merge', () => {
    person('Ada')
    const g = person('Grace')
    const r = upsertNode(dir, P, { kind: 'person', name: 'Grace', aliases: ['ada', 'Hopper'] }, agent)
    expect(r.node.id).toBe(g.node.id)
    expect(r.node.aliases).toEqual(['Hopper'])
  })

  it('normalises kinds and refuses bad ones', () => {
    expect(upsertNode(dir, P, { kind: ' Open  Question_x ', name: 'Why' }, agent).node.kind).toBe('open-question-x')
    for (const kind of ['', '   ', 'a'.repeat(41), '-lead', 'kind!', 'ünicode', 5 as never, undefined as never]) {
      expect(() => upsertNode(dir, P, { kind, name: 'Why' }, agent), JSON.stringify(kind)).toThrow('The kind must be 1..40 characters of letters, digits and dashes, e.g. person or open-question.')
    }
  })

  it('refuses hidden characters in every string field, never stripping them', () => {
    for (const bad of [ZWSP, RLO, '\u0007']) {
      expect(() => person(`Ada${bad}B`)).toThrow(/The name contains a hidden character/)
      expect(() => person('Ada', { aliases: [`Lo${bad}ve`] })).toThrow(/An alias contains a hidden character/)
      expect(() => person('Ada', { summary: `Sum${bad}mary` })).toThrow(/The summary contains a hidden character/)
      expect(() => person('Ada', { facts: [`Fa${bad}ct`] })).toThrow(/A fact contains a hidden character/)
    }
    expect(() => person('Ada\nB')).toThrow(/hidden character/)
    expect(() => person('Ada', { aliases: ['A\tB'] })).toThrow(/hidden character/)
    expect(person('Ada', { summary: 'Line 1\nLine\t2\r\n', facts: ['multi\nline'] }).node.summary).toBe('Line 1\nLine\t2')
    expect(graphOf().nodes).toHaveLength(1)
  })

  it('refuses over-long values (never cuts) and leaves the stored file untouched', () => {
    person('Ada')
    const before = fileText()
    expect(() => person('x'.repeat(KNOWLEDGE_NAME_MAX_CHARS + 1))).toThrow(/The name is longer than 120 characters \(121\)/)
    expect(() => person('Ada', { aliases: ['x'.repeat(KNOWLEDGE_NAME_MAX_CHARS + 1)] })).toThrow(/An alias is longer than 120/)
    expect(() => person('Ada', { summary: 'x'.repeat(KNOWLEDGE_SUMMARY_MAX_CHARS + 1) })).toThrow(/The summary is longer than 2,000 characters \(2,001\)/)
    expect(() => person('Ada', { facts: ['x'.repeat(KNOWLEDGE_FACT_MAX_CHARS + 1)] })).toThrow(/A fact is longer than 1,000/)
    expect(() => person('Ada', { facts: ['  '] })).toThrow('A fact is empty.')
    expect(() => person('   ')).toThrow('The name is empty.')
    expect(() => person(5 as never)).toThrow('The name must be text.')
    expect(() => person('Ada', { aliases: 'Ada' })).toThrow('Aliases must be a list of names.')
    expect(() => person('Ada', { facts: 'x' })).toThrow('Facts must be a list of texts.')
    expect(() => person('Ada', { noteIds: 'x' })).toThrow('Note links must be a list of note ids.')
    expect(upsertNode(dir, P, { kind: 'person', name: 'x'.repeat(KNOWLEDGE_NAME_MAX_CHARS) }, agent).node.name).toHaveLength(KNOWLEDGE_NAME_MAX_CHARS)
    expect(fileText()).not.toBe(before)
    noTmp()
  })

  it('enforces the alias, note-link and per-node fact caps before writing', () => {
    const many = Array.from({ length: KNOWLEDGE_ALIASES_MAX + 1 }, (_, i) => `alias ${i}`)
    expect(() => person('Ada', { aliases: many })).toThrow(/at most 10 aliases \(11 given\)/)
    expect(person('Ada', { aliases: [...many.slice(0, KNOWLEDGE_ALIASES_MAX), 'ALIAS 0', 'Ada'] }).node.aliases).toHaveLength(KNOWLEDGE_ALIASES_MAX)
    expect(() => upsertNode(dir, P, { kind: 'person', name: 'Ada', aliases: ['one more'] }, agent)).toThrow(/at most 10 aliases \(11 would be stored\)/)
    const notes = Array.from({ length: KNOWLEDGE_NODE_NOTES_MAX + 1 }, (_, i) => saveNote(dir, P, { title: `n${i}`, text: 'x' }).id)
    expect(() => person('Grace', { noteIds: notes })).toThrow(/at most 20 notes \(21 given\)/)
    person('Grace', { noteIds: notes.slice(0, KNOWLEDGE_NODE_NOTES_MAX) })
    expect(() => person('Grace', { noteIds: [notes[KNOWLEDGE_NODE_NOTES_MAX]] })).toThrow(/at most 20 notes \(21 would be stored\)/)
    expect(() => person('Grace', { noteIds: ['note_nope'] })).toThrow('Unknown note id "note_nope".')
    expect(() => person('Grace', { noteIds: [5] })).toThrow('Unknown note id (not text).')
    const facts = Array.from({ length: KNOWLEDGE_NODE_FACTS_MAX + 1 }, (_, i) => `fact ${i}`)
    expect(() => person('Linus', { facts })).toThrow(/at most 50 facts \(51 would be stored\)/)
    expect(graphOf().nodes.map((n) => n.name)).toEqual(['Ada', 'Grace'])
    person('Linus', { facts: facts.slice(0, KNOWLEDGE_NODE_FACTS_MAX) })
    const before = fileText()
    expect(() => person('Linus', { facts: ['fact 0', 'fact 50'] })).toThrow(/at most 50 facts/)
    expect(fileText()).toBe(before)
    expect(upsertNode(dir, P, { kind: 'person', name: 'Linus', facts: ['fact 0'] }, agent).node.facts).toHaveLength(KNOWLEDGE_NODE_FACTS_MAX)
    noTmp()
  })

  it('refuses a new node once the graph is full, still merges', () => {
    const now = 1
    const nodes = Array.from({ length: KNOWLEDGE_NODES_MAX }, (_, i) => ({ id: `kn_${i.toString(16).padStart(12, '0')}`, kind: 'person', name: `P${i}`, facts: [], source: user, createdAt: now, updatedAt: now }))
    writeRaw({ version: 1, nodes, edges: [] })
    expect(graphOf().nodes).toHaveLength(KNOWLEDGE_NODES_MAX)
    expect(() => person('One more')).toThrow('The knowledge graph is full (2,000 entities). Retire or remove entities first.')
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'One more' })).toThrow(/is full/)
    expect(person('p7').created).toBe(false)
  })
})

describe('saveNodeForUser', () => {
  it('creates with the user source and refuses a duplicate name or alias of the kind', () => {
    const a = saveNodeForUser(dir, P, { kind: 'Person', name: ' Ada ', aliases: ['AL', 'al', 'Ada'], summary: 'S', facts: [{ text: 'F1' }, { text: 'F2', retired: true }], retired: false })
    expect(a).toMatchObject({ kind: 'person', name: 'Ada', aliases: ['AL'], summary: 'S', source: { by: 'user' } })
    expect(a.facts.map((f) => [f.text, !!f.retired, f.source.by])).toEqual([['F1', false, 'user'], ['F2', true, 'user']])
    expect(a.retired).toBeUndefined()
    expect(a.updatedBy).toBeUndefined()
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'ADA' })).toThrow('An entity of kind person named "Ada" already exists; edit it instead.')
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'Other', aliases: ['al'] })).toThrow(/already exists; edit it instead/)
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'AL' })).toThrow(/already exists/)
    expect(saveNodeForUser(dir, P, { kind: 'organisation', name: 'Ada' }).id).not.toBe(a.id)
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'New', facts: [{ id: 'kf_000000000000', text: 'x' }] })).toThrow('Unknown fact id "kf_000000000000".')
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'New', facts: [{ id: 'bad', text: 'x' }] })).toThrow('Unknown fact id "bad".')
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'New', retired: 'yes' as never })).toThrow('retired must be true or false.')
    expect(() => saveNodeForUser(dir, P, { kind: 'person', name: 'New', facts: [{ text: `a${ZWSP}` }] })).toThrow(/A fact contains a hidden character/)
    expect(graphOf().nodes).toHaveLength(2)
  })

  it('replaces field by field: facts by id keep their source, omitted fields stay, rename is checked', () => {
    const n1 = saveNote(dir, P, { title: 'Brief', text: 'b' })
    const a = person('Ada', { aliases: ['AL'], summary: 'agent summary', facts: ['agent fact', 'drop me'], noteIds: [n1.id] })
    person('Grace')
    const [keep, drop] = a.node.facts
    const edited = saveNodeForUser(dir, P, { nodeId: a.node.id, kind: 'contact', name: 'Ada L', facts: [{ id: keep.id, text: 'agent fact, edited' }, { text: 'user fact' }] })
    expect(edited).toMatchObject({ id: a.node.id, kind: 'contact', name: 'Ada L', aliases: ['AL'], summary: 'agent summary', noteIds: [n1.id], source: agent, updatedBy: { by: 'user' } })
    expect(edited.facts.map((f) => [f.text, f.source.by])).toEqual([['agent fact, edited', 'agent'], ['user fact', 'user']])
    expect(edited.facts.find((f) => f.id === drop.id)).toBeUndefined()
    expect(edited.updatedAt).toBeGreaterThanOrEqual(a.node.updatedAt)
    // Retired flag of a kept fact survives unless given; given false clears it.
    retireItem(dir, P, { factId: keep.id }, agent)
    expect(saveNodeForUser(dir, P, { nodeId: a.node.id, kind: 'contact', name: 'Ada L', facts: [{ id: keep.id, text: 'still' }] }).facts[0].retired).toBe(true)
    expect(saveNodeForUser(dir, P, { nodeId: a.node.id, kind: 'contact', name: 'Ada L', facts: [{ id: keep.id, text: 'still', retired: false }] }).facts[0].retired).toBeUndefined()
    // Replacing aliases / summary / noteIds; '' clears the summary; retired sets.
    const cleared = saveNodeForUser(dir, P, { nodeId: a.node.id, kind: 'contact', name: 'Ada L', aliases: [], summary: '', noteIds: [], retired: true })
    expect(cleared.aliases).toBeUndefined()
    expect(cleared.summary).toBeUndefined()
    expect(cleared.noteIds).toBeUndefined()
    expect(cleared.retired).toBe(true)
    expect(cleared.facts).toHaveLength(1)
    expect(saveNodeForUser(dir, P, { nodeId: a.node.id, kind: 'contact', name: 'Ada L', retired: false }).retired).toBeUndefined()
    // Renaming onto another entity of the kind is refused; a rename onto an own alias drops that alias.
    expect(() => saveNodeForUser(dir, P, { nodeId: a.node.id, kind: 'person', name: 'grace' })).toThrow(/named "Grace" already exists/)
    const own = saveNodeForUser(dir, P, { nodeId: a.node.id, kind: 'person', name: 'Ada', aliases: ['Lovelace'] })
    expect(saveNodeForUser(dir, P, { nodeId: own.id, kind: 'person', name: 'lovelace' }).aliases).toBeUndefined()
    expect(() => saveNodeForUser(dir, P, { nodeId: a.node.id, kind: 'person', name: 'x', facts: [{ id: keep.id, text: 'a' }, { id: keep.id, text: 'b' }] })).toThrow(/listed twice/)
    expect(() => saveNodeForUser(dir, P, { nodeId: 'kn_000000000000', kind: 'person', name: 'x' })).toThrow('No entity with id "kn_000000000000".')
    expect(() => saveNodeForUser(dir, P, { nodeId: a.node.id, kind: 'person', name: 'x', noteIds: ['note_gone'] })).toThrow('Unknown note id "note_gone".')
  })
})

describe('edges', () => {
  it('creates, dedupes on the triple, edits by id, and refuses self-links and unknown endpoints', () => {
    const a = person('Ada').node
    const b = person('Acme').node
    const r1 = saveEdge(dir, P, { from: a.id, to: b.id, relation: ' Works  At ', note: ' since 2020 ' }, agent)
    expect(r1.created).toBe(true)
    expect(r1.edge).toMatchObject({ id: expect.stringMatching(/^ke_[0-9a-f]{12}$/), from: a.id, to: b.id, relation: 'works-at', note: 'since 2020', source: agent, createdAt: agent.at })
    const r2 = saveEdge(dir, P, { from: a.id, to: b.id, relation: 'works-at', note: 'since 2021' }, user)
    expect(r2.created).toBe(false)
    expect(r2.edge.id).toBe(r1.edge.id)
    expect(r2.edge).toMatchObject({ note: 'since 2021', source: agent })
    expect(graphOf().edges).toHaveLength(1)
    // Without a note the note stays; the reverse direction is another edge.
    expect(saveEdge(dir, P, { from: a.id, to: b.id, relation: 'works-at' }, agent).edge.note).toBe('since 2021')
    expect(saveEdge(dir, P, { from: b.id, to: a.id, relation: 'works-at' }, agent).created).toBe(true)
    // Retired flag: untouched without `retired`, set and cleared with it; '' clears the note.
    expect(saveEdge(dir, P, { from: a.id, to: b.id, relation: 'works-at', retired: true }, agent).edge.retired).toBe(true)
    expect(saveEdge(dir, P, { from: a.id, to: b.id, relation: 'works-at' }, agent).edge.retired).toBe(true)
    const byId = saveEdge(dir, P, { edgeId: r1.edge.id, from: a.id, to: b.id, relation: 'ignored-here', note: '', retired: false }, user)
    expect(byId.created).toBe(false)
    expect(byId.edge).toMatchObject({ id: r1.edge.id, relation: 'works-at' })
    expect(byId.edge.note).toBeUndefined()
    expect(byId.edge.retired).toBeUndefined()
    expect(() => saveEdge(dir, P, { edgeId: 'ke_000000000000', from: a.id, to: b.id, relation: 'x' }, user)).toThrow('No relation with id "ke_000000000000".')
    expect(() => saveEdge(dir, P, { from: a.id, to: a.id, relation: 'knows' }, agent)).toThrow('An entity cannot relate to itself.')
    expect(() => saveEdge(dir, P, { from: 'kn_000000000000', to: b.id, relation: 'knows' }, agent)).toThrow('The "from" entity "kn_000000000000" does not exist.')
    expect(() => saveEdge(dir, P, { from: a.id, to: 'Acme', relation: 'knows' }, agent)).toThrow('The "to" entity "Acme" does not exist.')
    expect(() => saveEdge(dir, P, { from: a.id, to: b.id, relation: 'Bad!' }, agent)).toThrow('The relation must be 1..40 characters of letters, digits and dashes, e.g. works-at or depends-on.')
    expect(() => saveEdge(dir, P, { from: a.id, to: b.id, relation: 'knows', note: `a${RLO}` }, agent)).toThrow(/The note contains a hidden character/)
    expect(() => saveEdge(dir, P, { from: a.id, to: b.id, relation: 'knows', note: 'x'.repeat(KNOWLEDGE_EDGE_NOTE_MAX_CHARS + 1) }, agent)).toThrow(/The note is longer than 500/)
    expect(() => saveEdge(dir, P, { from: a.id, to: b.id, relation: 'knows', retired: 1 as never }, agent)).toThrow('retired must be true or false.')
    expect(graphOf().edges).toHaveLength(2)
    noTmp()
  })

  it('removeNode cascades edges; removeEdge removes one; unknown ids throw', () => {
    const a = person('Ada').node
    const b = person('Acme').node
    const c = person('Grace').node
    const e1 = saveEdge(dir, P, { from: a.id, to: b.id, relation: 'works-at' }, agent).edge
    const e2 = saveEdge(dir, P, { from: c.id, to: a.id, relation: 'reports-to' }, agent).edge
    const e3 = saveEdge(dir, P, { from: c.id, to: b.id, relation: 'works-at' }, agent).edge
    expect(removeEdge(dir, P, e3.id).edges.map((e) => e.id)).toEqual([e1.id, e2.id])
    expect(() => removeEdge(dir, P, e3.id)).toThrow(`No relation with id "${e3.id}".`)
    const after = removeNode(dir, P, a.id)
    expect(after.nodes.map((n) => n.id)).toEqual([b.id, c.id])
    expect(after.edges).toEqual([])
    expect(graphOf()).toEqual(after)
    expect(() => removeNode(dir, P, a.id)).toThrow(`No entity with id "${a.id}".`)
  })

  it('refuses a new edge once the graph is full', () => {
    const nodes = Array.from({ length: 101 }, (_, i) => ({ id: `kn_${i.toString(16).padStart(12, '0')}`, kind: 'person', name: `P${i}`, facts: [], source: user, createdAt: 1, updatedAt: 1 }))
    const edges: unknown[] = []
    for (let i = 0; i < 100 && edges.length < KNOWLEDGE_EDGES_MAX; i++) {
      for (let j = 0; j < 100 && edges.length < KNOWLEDGE_EDGES_MAX; j++) {
        if (i !== j) edges.push({ id: `ke_${edges.length.toString(16).padStart(12, '0')}`, from: nodes[i].id, to: nodes[j].id, relation: 'knows', source: user, createdAt: 1 })
      }
    }
    writeRaw({ version: 1, nodes, edges })
    expect(graphOf().edges).toHaveLength(KNOWLEDGE_EDGES_MAX)
    expect(() => saveEdge(dir, P, { from: nodes[100].id, to: nodes[0].id, relation: 'knows' }, agent)).toThrow('The knowledge graph is full (5,000 relations). Remove relations first.')
    expect(saveEdge(dir, P, { from: nodes[0].id, to: nodes[1].id, relation: 'knows', note: 'n' }, agent).created).toBe(false)
  })
})

describe('retireItem', () => {
  it('requires exactly one id, refuses user-written items for agents, reports already retired, labels', () => {
    const a = saveNodeForUser(dir, P, { kind: 'person', name: 'Ada', facts: [{ text: 'User fact' }] })
    const b = person('Acme', { facts: ['Agent fact'] }).node
    const ue = saveEdge(dir, P, { from: a.id, to: b.id, relation: 'works-at' }, user).edge
    const ae = saveEdge(dir, P, { from: b.id, to: a.id, relation: 'employs' }, agent).edge
    expect(() => retireItem(dir, P, {}, agent)).toThrow('Name exactly one of nodeId, edgeId or factId.')
    expect(() => retireItem(dir, P, { nodeId: a.id, edgeId: ae.id }, agent)).toThrow('Name exactly one of nodeId, edgeId or factId.')
    expect(() => retireItem(dir, P, { nodeId: a.id }, agent)).toThrow('Only the user can change that.')
    expect(() => retireItem(dir, P, { edgeId: ue.id }, agent)).toThrow('Only the user can change that.')
    expect(() => retireItem(dir, P, { factId: a.facts[0].id }, agent)).toThrow('Only the user can change that.')
    expect(() => retireItem(dir, P, { nodeId: 'kn_000000000000' }, agent)).toThrow(/No entity with id/)
    expect(() => retireItem(dir, P, { edgeId: 'ke_000000000000' }, agent)).toThrow(/No relation with id/)
    expect(() => retireItem(dir, P, { factId: 'kf_000000000000' }, agent)).toThrow('No fact with id "kf_000000000000".')
    expect(graphOf().nodes.every((n) => !n.retired)).toBe(true)
    expect(retireItem(dir, P, { factId: b.facts[0].id, reason: 'wrong' }, agent)).toEqual({ item: 'fact', id: b.facts[0].id, label: 'Agent fact', alreadyRetired: false })
    expect(retireItem(dir, P, { factId: b.facts[0].id }, agent)).toEqual({ item: 'fact', id: b.facts[0].id, label: 'Agent fact', alreadyRetired: true })
    expect(retireItem(dir, P, { edgeId: ae.id }, agent)).toEqual({ item: 'edge', id: ae.id, label: 'Acme employs Ada', alreadyRetired: false })
    const stamp = { ...agent, at: 9999 }
    expect(retireItem(dir, P, { nodeId: b.id }, stamp)).toEqual({ item: 'node', id: b.id, label: 'person Acme', alreadyRetired: false })
    const stored = graphOf().nodes.find((n) => n.id === b.id)!
    expect(stored).toMatchObject({ retired: true, updatedBy: stamp, updatedAt: 9999 })
    expect(stored.facts[0].retired).toBe(true)
    expect(graphOf().edges.find((e) => e.id === ae.id)!.retired).toBe(true)
    expect(retireItem(dir, P, { nodeId: b.id }, agent).alreadyRetired).toBe(true)
    // The user may retire anything, including their own items.
    expect(retireItem(dir, P, { nodeId: a.id }, user)).toMatchObject({ item: 'node', label: 'person Ada', alreadyRetired: false })
    expect(retireItem(dir, P, { edgeId: ue.id }, user).alreadyRetired).toBe(false)
  })
})

describe('reading junk and legacy files', () => {
  it('drops bad nodes, facts, edges, duplicates and non-object entries, keeping the rest', () => {
    const n1 = saveNote(dir, P, { title: 'kept', text: 'x' })
    const good = { id: 'kn_aaaaaaaaaaaa', kind: 'person', name: 'Ada', facts: [], source: { by: 'agent', at: 1, runId: '../x', agentId: 5, role: `r${ZWSP}` }, createdAt: 1, updatedAt: 2 }
    const other = { id: 'kn_bbbbbbbbbbbb', kind: 'system', name: 'CRM', aliases: ['crm-system', 'CRM-System', 5, `x${RLO}`, 'CRM '], summary: 'ok', noteIds: [n1.id, 'note_gone', n1.id], facts: [
      null, { id: 'kf_111111111111', text: 'ok', source: { by: 'user', at: 1 }, retired: 'yes' }, { id: 'kf_111111111111', text: 'dup', source: { by: 'user', at: 1 } }, { id: 'bad', text: 'x', source: { by: 'user', at: 1 } }, { id: 'kf_222222222222', text: '', source: { by: 'user', at: 1 } }, { id: 'kf_333333333333', text: 'no source' }
    ], source: { by: 'user', at: 1 }, updatedBy: { by: 'nobody', at: 1 }, createdAt: 1, updatedAt: 1, retired: 'yes' }
    writeRaw({
      version: 1,
      nodes: [
        null, 5, 'x', good, { ...good }, { ...good, id: 'kn_cccccccccccc', kind: 'Bad Kind' }, { ...good, id: 'kn_dddddddddddd', name: '' }, { ...good, id: 'kn_eeeeeeeeeeee', source: { by: 'robot', at: 1 } },
        { ...good, id: 'kn_ffffffffffff', createdAt: 'yesterday' }, { ...good, id: 'bad_id' }, { ...good, id: 'ke_aaaaaaaaaaaa' }, { ...good, id: 'kn_111111111111', name: `A${ZWSP}` }, other
      ],
      edges: [
        null, { id: 'ke_000000000001', from: 'kn_aaaaaaaaaaaa', to: 'kn_bbbbbbbbbbbb', relation: 'uses', source: { by: 'user', at: 1 }, createdAt: 1, note: 'n', retired: true },
        { id: 'ke_000000000002', from: 'kn_aaaaaaaaaaaa', to: 'kn_bbbbbbbbbbbb', relation: 'uses', source: { by: 'user', at: 1 }, createdAt: 1 },
        { id: 'ke_000000000001', from: 'kn_bbbbbbbbbbbb', to: 'kn_aaaaaaaaaaaa', relation: 'used-by', source: { by: 'user', at: 1 }, createdAt: 1 },
        { id: 'ke_000000000003', from: 'kn_aaaaaaaaaaaa', to: 'kn_cccccccccccc', relation: 'uses', source: { by: 'user', at: 1 }, createdAt: 1 },
        { id: 'ke_000000000004', from: 'kn_aaaaaaaaaaaa', to: 'kn_aaaaaaaaaaaa', relation: 'uses', source: { by: 'user', at: 1 }, createdAt: 1 },
        { id: 'ke_000000000005', from: 'kn_aaaaaaaaaaaa', to: 'kn_bbbbbbbbbbbb', relation: 'Bad Relation', source: { by: 'user', at: 1 }, createdAt: 1 },
        { id: 'ke_000000000006', from: 'kn_aaaaaaaaaaaa', to: 'kn_bbbbbbbbbbbb', relation: 'knows', createdAt: 1 },
        { id: 'ke_000000000007', from: 'kn_bbbbbbbbbbbb', to: 'kn_aaaaaaaaaaaa', relation: 'knows', source: { by: 'agent', at: 1 }, createdAt: 1, note: `x${ZWSP}`, retired: 0 }
      ],
      updatedAt: 'now'
    })
    const g = graphOf()
    expect(g.nodes.map((n) => n.id)).toEqual(['kn_aaaaaaaaaaaa', 'kn_bbbbbbbbbbbb'])
    expect(g.nodes[0].source).toEqual({ by: 'agent', at: 1 })
    expect(g.nodes[1]).toEqual({ id: 'kn_bbbbbbbbbbbb', kind: 'system', name: 'CRM', aliases: ['crm-system'], summary: 'ok', noteIds: [n1.id], facts: [{ id: 'kf_111111111111', text: 'ok', source: { by: 'user', at: 1 } }], source: { by: 'user', at: 1 }, createdAt: 1, updatedAt: 1 })
    expect(g.edges.map((e) => e.id)).toEqual(['ke_000000000001', 'ke_000000000007'])
    expect(g.edges[0]).toMatchObject({ note: 'n', retired: true })
    expect(g.edges[1].note).toBeUndefined()
    expect(g.edges[1].retired).toBeUndefined()
    expect(g.updatedAt).toBeUndefined()
    expect(knowledgeNodeCount(dir, P)).toBe(2)
    // A note link whose note is gone is dropped on the next read.
    removeNote(dir, P, n1.id)
    expect(graphOf().nodes[1].noteIds).toBeUndefined()
  })

  it('reads a truncated file, a non-object root and a directory as empty', () => {
    writeRaw('{"version":1,"nodes":[{"id":"kn_aaaaaaaaaaaa"')
    expect(graphOf()).toEqual({ version: 1, nodes: [], edges: [] })
    writeRaw('[]')
    expect(graphOf()).toEqual({ version: 1, nodes: [], edges: [] })
    writeRaw('"text"')
    expect(graphOf()).toEqual({ version: 1, nodes: [], edges: [] })
    writeRaw({ version: 1, nodes: 'x', edges: {} })
    expect(graphOf()).toEqual({ version: 1, nodes: [], edges: [] })
    rmSync(knowledgeFile(dir, P))
    mkdirSync(knowledgeFile(dir, P))
    expect(graphOf()).toEqual({ version: 1, nodes: [], edges: [] })
    expect(() => person('Ada')).toThrow(/not a plain file/)
  })

  it('applies the node, edge and fact caps on read', () => {
    const nodes = Array.from({ length: KNOWLEDGE_NODES_MAX + 2 }, (_, i) => ({
      id: `kn_${i.toString(16).padStart(12, '0')}`,
      kind: 'person',
      name: `P${i}`,
      facts: i === 0 ? Array.from({ length: KNOWLEDGE_NODE_FACTS_MAX + 3 }, (_, j) => ({ id: `kf_${j.toString(16).padStart(12, '0')}`, text: `f${j}`, source: user })) : [],
      source: user,
      createdAt: 1,
      updatedAt: 1
    }))
    writeRaw({ version: 1, nodes, edges: [] })
    const g = graphOf()
    expect(g.nodes).toHaveLength(KNOWLEDGE_NODES_MAX)
    expect(g.nodes[0].facts).toHaveLength(KNOWLEDGE_NODE_FACTS_MAX)
  })

  it('keeps project files apart', () => {
    person('Ada')
    expect(readKnowledge(dir, 'proj_b').nodes).toEqual([])
    expect(knowledgeNodeCount(dir, 'proj_b')).toBe(0)
    upsertNode(dir, 'proj_b', { kind: 'person', name: 'Grace' }, agent)
    expect(graphOf().nodes.map((n) => n.name)).toEqual(['Ada'])
    expect(readKnowledge(dir, 'proj_b').nodes.map((n) => n.name)).toEqual(['Grace'])
  })
})

describe('clearKnowledge and the bound store', () => {
  it('deletes the file and reads empty afterwards; clearing nothing is fine', () => {
    expect(clearKnowledge(dir, P)).toEqual({ version: 1, nodes: [], edges: [] })
    person('Ada')
    expect(existsSync(knowledgeFile(dir, P))).toBe(true)
    expect(clearKnowledge(dir, P)).toEqual({ version: 1, nodes: [], edges: [] })
    expect(existsSync(knowledgeFile(dir, P))).toBe(false)
    expect(graphOf()).toEqual({ version: 1, nodes: [], edges: [] })
  })

  it('knowledgeStore binds the data dir', () => {
    const store = knowledgeStore(dir)
    const a = store.upsertNode(P, { kind: 'person', name: 'Ada' }, agent)
    const b = store.upsertNode(P, { kind: 'organisation', name: 'Acme' }, agent)
    const e = store.saveEdge(P, { from: a.node.id, to: b.node.id, relation: 'works-at' }, agent)
    expect(store.retire(P, { edgeId: e.edge.id }, agent)).toMatchObject({ item: 'edge', label: 'Ada works-at Acme' })
    expect(store.get(P).nodes).toHaveLength(2)
    expect(store.get(P)).toEqual(graphOf())
    expect(store.get('proj_zzz')).toEqual({ version: 1, nodes: [], edges: [] })
  })
})
