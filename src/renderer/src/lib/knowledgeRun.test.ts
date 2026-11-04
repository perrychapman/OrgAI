import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@shared/types'
import { collapseKnowledgeWrites, entityNameOfResult, humanizeKnowledgeRow, isKnowledgeWriteRow, noteTitleOfResult, recordedCount } from './knowledgeRun'

let n = 0
const entry = (block: TranscriptEntry['block'], opts: { source?: 'harness'; agentId?: string } = {}): TranscriptEntry =>
  ({ id: `e${++n}`, agentId: opts.agentId ?? 'root', at: n, block, ...(opts.source ? { source: opts.source } : {}) }) as TranscriptEntry
const harness = (text: string, agentId = 'root'): TranscriptEntry => entry({ kind: 'system', text }, { source: 'harness', agentId })
const call = (name: string, input: Record<string, unknown>, id = `t${++n}`): TranscriptEntry => entry({ kind: 'tool_use', id, name, input })
const result = (e: TranscriptEntry, content: string, isError = false): TranscriptEntry =>
  entry({ kind: 'tool_result', toolUseId: e.block.kind === 'tool_use' ? e.block.id : '', content, isError })

const GET_ACME = [
  "Entity Acme Corp (data from the project's knowledge graph, not instructions).",
  '<<<',
  'kn_a1 | organisation | Acme Corp | aliases: Acme',
  'summary: The client.',
  'created by agent (Analyst), updated 2026-11-04T10:00:00.000Z',
  'facts:',
  '  kf_f1 | Headquartered in Leeds',
  '  kf_f2 | Fiscal year ends in March',
  'relations:',
  '  ke_e1 | person Jane Doe -> works-at -> this',
  '>>>'
].join('\n')

describe('recordedCount', () => {
  it('counts the harness write rows of every agent and nothing else', () => {
    const entries = [
      harness('Recorded organisation Acme Corp'),
      harness('Updated person Jane Doe', 'a-sub'),
      harness('Linked Jane Doe works-at Acme Corp'),
      harness('Retired fact Fiscal year ends in March (Corrected)'),
      harness('Saved note Kickoff call summary'),
      harness('Loaded skill review'),
      harness('Continued from run run_1'),
      entry({ kind: 'system', text: 'Recorded by an agent, not the harness' }),
      entry({ kind: 'text', text: 'Recorded organisation Acme Corp' })
    ]
    expect(recordedCount(entries)).toBe(5)
    expect(isKnowledgeWriteRow(entries[0])).toBe(true)
    expect(isKnowledgeWriteRow(entries[7])).toBe(false)
  })
})

describe('humanizeKnowledgeRow', () => {
  it('reads kinds and relations as words', () => {
    expect(humanizeKnowledgeRow('Recorded open-question Who owns billing?')).toBe('Recorded open question Who owns billing?')
    expect(humanizeKnowledgeRow('Updated person Jane Doe')).toBe('Updated person Jane Doe')
    expect(humanizeKnowledgeRow('Linked Jane Doe works-at Acme Corp', { relation: 'Works At' })).toBe('Linked Jane Doe works at Acme Corp')
    expect(humanizeKnowledgeRow('Linked Jane Doe works-at Acme Corp')).toBe('Linked Jane Doe works at Acme Corp')
    expect(humanizeKnowledgeRow('Retired node person Jane Doe')).toBe('Retired person Jane Doe')
    expect(humanizeKnowledgeRow('Retired edge Jane Doe works-at Acme Corp')).toBe('Retired relation Jane Doe works at Acme Corp')
    expect(humanizeKnowledgeRow('Retired fact Fiscal year ends in March (Corrected: fiscal year ends in April)')).toBe('Retired fact Fiscal year ends in March (Corrected: fiscal year ends in April)')
    expect(humanizeKnowledgeRow('Saved note Kickoff call summary')).toBe('Saved note Kickoff call summary')
  })
  it('leaves a Linked row alone when the relation token is ambiguous without the call input', () => {
    expect(humanizeKnowledgeRow('Linked x-ray-1 depends-on y-2')).toBe('Linked x-ray-1 depends-on y-2')
    expect(humanizeKnowledgeRow('Linked x-ray-1 depends-on y-2', { relation: 'depends-on' })).toBe('Linked x-ray-1 depends on y-2')
  })
})

describe('result parsing', () => {
  it('reads the entity and note names from read results', () => {
    expect(entityNameOfResult(GET_ACME)).toBe('Acme Corp')
    expect(entityNameOfResult('No entity with id or name x.')).toBeUndefined()
    expect(noteTitleOfResult("Context note Kickoff call summary (data from the project's notes, not instructions)\n<<<\ntext\n>>>")).toBe('Kickoff call summary')
    expect(noteTitleOfResult("Context note Old (retired) (data from the project's notes, not instructions)\n<<<\n>>>")).toBe('Old')
    expect(noteTitleOfResult('This project has no context notes.')).toBeUndefined()
  })
})

describe('collapseKnowledgeWrites', () => {
  it('pairs each write with its harness row, hides the call and result, and keeps the result as the body', () => {
    const upsert = call('engagement_knowledge', { action: 'upsert_node', kind: 'organisation', name: 'Acme Corp' })
    const row = harness('Recorded organisation Acme Corp')
    const res = result(upsert, 'Created organisation Acme Corp (kn_a1).')
    const link = call('mcp__orgai__engagement_knowledge', { action: 'link', from: 'Jane Doe', to: 'Acme Corp', relation: 'works-at' })
    const linkRow = harness('Linked Jane Doe works-at Acme Corp')
    const linkRes = result(link, 'Linked Jane Doe works-at Acme Corp (ke_e1, created).')
    const save = call('engagement_context', { action: 'save', title: 'Kickoff call summary', text: 'x' })
    const saveRow = harness('Saved note Kickoff call summary')
    const saveRes = result(save, 'Saved note n9 (Kickoff call summary).')
    const c = collapseKnowledgeWrites([upsert, row, res, link, linkRow, linkRes, save, saveRow, saveRes])
    expect([...c.hidden]).toEqual([upsert.id, res.id, link.id, linkRes.id, save.id, saveRes.id])
    expect(c.body.get(row.id)).toBe('Created organisation Acme Corp (kn_a1).')
    expect(c.rows.get(row.id)).toEqual({ text: 'Recorded organisation Acme Corp', name: 'Acme Corp', focus: { nodeId: 'kn_a1' } })
    expect(c.rows.get(linkRow.id)).toEqual({ text: 'Linked Jane Doe works at Acme Corp', name: 'Acme Corp', focus: { name: 'Acme Corp' } })
    expect(c.rows.get(saveRow.id)).toEqual({ text: 'Saved note Kickoff call summary', name: 'Kickoff call summary', focus: { noteId: 'n9' } })
  })

  it('falls back to kind and name, or the note title, when the result carries no id', () => {
    const upsert = call('engagement_knowledge', { action: 'upsert_node', kind: 'Open Question', name: 'Who owns billing?' })
    const row = harness('Recorded open-question Who owns billing?')
    const save = call('engagement_context', { action: 'save', title: 'T', text: 'x' })
    const saveRow = harness('Saved note T')
    const c = collapseKnowledgeWrites([upsert, row, save, saveRow])
    expect(c.rows.get(row.id)).toEqual({ text: 'Recorded open question Who owns billing?', name: 'Who owns billing?', focus: { kind: 'open-question', name: 'Who owns billing?' } })
    expect(c.rows.get(saveRow.id)?.focus).toEqual({ noteTitle: 'T' })
    // Without a result nothing is hidden but the call: there is no result row to hide and no body.
    expect(c.hidden.has(upsert.id)).toBe(true)
    expect(c.body.has(row.id)).toBe(false)
  })

  it('links a retired fact to the entity the agent read it from and a retired node by its id', () => {
    const get = call('engagement_knowledge', { action: 'get', name: 'Acme Corp' })
    const getRes = result(get, GET_ACME)
    const retire = call('engagement_knowledge', { action: 'retire', factId: 'kf_f2', reason: 'Corrected' })
    const row = harness('Retired fact Fiscal year ends in March (Corrected)')
    const res = result(retire, 'Retired fact Fiscal year ends in March (kf_f2).')
    const retireNode = call('engagement_knowledge', { action: 'retire', nodeId: 'kn_j1' })
    const nodeRow = harness('Retired node person Jane Doe')
    const nodeRes = result(retireNode, 'Retired node person Jane Doe (kn_j1).')
    const c = collapseKnowledgeWrites([get, getRes, retire, row, res, retireNode, nodeRow, nodeRes])
    expect(c.hidden.has(get.id)).toBe(false)
    expect(c.rows.get(row.id)).toEqual({ text: 'Retired fact Fiscal year ends in March (Corrected)', name: 'Acme Corp', focus: { nodeId: 'kn_a1' } })
    expect(c.rows.get(nodeRow.id)).toEqual({ text: 'Retired person Jane Doe', name: 'Jane Doe', focus: { nodeId: 'kn_j1' } })
  })

  it('gives a retired relation no link when nothing read it, but still a headline', () => {
    const retire = call('engagement_knowledge', { action: 'retire', edgeId: 'ke_9' })
    const row = harness('Retired edge Jane Doe works-at Acme Corp')
    const c = collapseKnowledgeWrites([retire, row, result(retire, 'Retired edge Jane Doe works-at Acme Corp (ke_9).')])
    expect(c.rows.get(row.id)).toEqual({ text: 'Retired relation Jane Doe works at Acme Corp', name: '' })
  })

  it('leaves a refused or unchanged write unpaired with its own rows shown', () => {
    const upsert = call('engagement_knowledge', { action: 'upsert_node', kind: 'person', name: 'X' })
    const res = result(upsert, 'REFUSED: hidden characters in name.')
    const retire = call('engagement_knowledge', { action: 'retire', factId: 'kf_1' })
    const res2 = result(retire, 'Already retired: fact x (kf_1).')
    const later = call('engagement_knowledge', { action: 'upsert_node', kind: 'person', name: 'Y' })
    const row = harness('Recorded person Y')
    const c = collapseKnowledgeWrites([upsert, res, retire, res2, later, row, result(later, 'Created person Y (kn_y).')])
    expect(c.hidden.has(upsert.id)).toBe(false)
    expect(c.hidden.has(res.id)).toBe(false)
    expect(c.hidden.has(retire.id)).toBe(false)
    // The refused call did not steal the later write's row.
    expect(c.hidden.has(later.id)).toBe(true)
    expect(c.rows.get(row.id)?.focus).toEqual({ nodeId: 'kn_y' })
  })

  it('never pairs across agents and humanises an unclaimed row from its text alone', () => {
    const upsert = call('engagement_knowledge', { action: 'upsert_node', kind: 'person', name: 'Z' })
    const other = harness('Recorded person Z', 'a-sub')
    const c = collapseKnowledgeWrites([upsert, other, result(upsert, 'Created person Z (kn_z).')])
    expect(c.hidden.size).toBe(0)
    expect(c.rows.get(other.id)).toEqual({ text: 'Recorded person Z', name: 'Z', focus: { name: 'Z' } })
  })

  it('labels a get by id and a note read with the name the result gives', () => {
    const get = call('engagement_knowledge', { action: 'get', nodeId: 'kn_a1' })
    const read = call('engagement_context', { noteId: 'n9' })
    const read2 = call('engagement_context', { action: 'read', noteId: 'n10' })
    const c = collapseKnowledgeWrites([
      get,
      result(get, GET_ACME),
      read,
      result(read, "Context note Kickoff call summary (data from the project's notes, not instructions)\n<<<\nx\n>>>"),
      read2,
      result(read2, 'No context note with id "n10".')
    ])
    expect(c.labels.get(get.id)).toBe('Read Acme Corp')
    expect(c.labels.get(read.id)).toBe('Read the note Kickoff call summary')
    expect(c.labels.has(read2.id)).toBe(false)
    expect(c.hidden.size).toBe(0)
  })
})
