import { describe, expect, it } from 'vitest'
import type { RunOutput, TranscriptEntry } from '@shared/types'
import { announceText, collapseOutputCalls, matchOutputId, producedSentence, registeredSentence, unannouncedTitles } from './outputsRun'

let n = 0
const id = (): string => `e${++n}`
const use = (toolId: string, name: string, input: unknown = {}, agentId = 'a1'): TranscriptEntry => ({ id: id(), agentId, at: n, block: { kind: 'tool_use', id: toolId, name, input } })
const result = (toolId: string, content: string, isError = false, agentId = 'a1'): TranscriptEntry => ({ id: id(), agentId, at: n, block: { kind: 'tool_result', toolUseId: toolId, content, isError } })
const harness = (text: string, agentId = 'a1'): TranscriptEntry => ({ id: id(), agentId, at: n, source: 'harness', block: { kind: 'system', text } })
const text = (t: string): TranscriptEntry => ({ id: id(), agentId: 'a1', at: n, block: { kind: 'text', text: t } })

const out = (over: Partial<RunOutput>): RunOutput => ({
  id: 'out_0000000000000001',
  projectId: 'p',
  runId: 'r1',
  kind: 'docx',
  title: 'Project plan',
  fileName: 'Project plan.docx',
  path: '/p/outputs/Project plan.docx',
  relPath: 'outputs/Project plan.docx',
  bytes: 100,
  createdAt: 1,
  source: 'produced',
  ...over
})

describe('collapseOutputCalls', () => {
  it('folds the mock sequence into rows, hiding calls and results', () => {
    const e: TranscriptEntry[] = []
    const produce = (tid: string, kind: string, word: string, title: string, rel: string, tool = 'mcp__orgai__produce_output'): void => {
      e.push(use(tid, tool, { kind, title }))
      e.push(harness(`Produced ${word} ${title}`))
      e.push(result(tid, `Produced ${kind} "${title}" at ${rel} (38 KB). The user can see it in OrgAI's Outputs panel.`))
    }
    produce('t1', 'docx', 'document', 'Project plan', 'outputs/Project plan.docx')
    produce('t2', 'xlsx', 'workbook', 'Budget', 'outputs/Budget.xlsx')
    produce('t3', 'mermaid', 'diagram', 'Architecture diagram', 'outputs/Architecture diagram.mmd')
    produce('t4', 'markdown', 'file', 'Summary', 'outputs/Summary.md', 'produce_output')
    e.push(use('t5', 'register_output', { path: 'outputs/logo.png', title: 'Logo' }))
    e.push(harness('Registered output Logo'))
    e.push(result('t5', 'Registered image "Logo" at outputs/logo.png (2 KB). The user can see it in OrgAI\'s Outputs panel.'))
    e.push(use('t6', 'register_output', { path: '../outside.txt' }))
    e.push(result('t6', 'REFUSED: that file is outside the project folder.'))
    const c = collapseOutputCalls(e)
    const rows = [...c.rows.values()]
    expect(rows.map((r) => [r.state, r.text])).toEqual([
      ['produced', 'Produced Word document: Project plan'],
      ['produced', 'Produced Excel workbook: Budget'],
      ['produced', 'Produced diagram: Architecture diagram'],
      ['produced', 'Produced Markdown: Summary'],
      ['registered', 'Registered image: Logo'],
      ['refused', 'Refused: that file is outside the project folder.']
    ])
    expect(rows[0].relPath).toBe('outputs/Project plan.docx')
    expect(rows[4].title).toBe('Logo')
    // every call and result hidden, harness rows and the refusal result stay
    for (const x of e) {
      const isRow = c.rows.has(x.id)
      expect(c.hidden.has(x.id)).toBe(!isRow)
    }
    const first = e[1]
    expect(c.body.get(first.id)).toMatch(/^Produced docx "Project plan"/)
    expect(c.body.size).toBe(5)
  })

  it('leaves a call with no result alone', () => {
    const e = [use('t1', 'produce_output'), text('x')]
    const c = collapseOutputCalls(e)
    expect(c.hidden.size).toBe(0)
    expect(c.rows.size).toBe(0)
  })

  it('uses the result as the row when no harness row exists', () => {
    const e = [use('t1', 'produce_output'), result('t1', 'Produced xlsx "Budget" at outputs/Budget.xlsx (4 KB). done')]
    const c = collapseOutputCalls(e)
    expect(c.hidden.has(e[0].id)).toBe(true)
    expect(c.rows.get(e[1].id)).toMatchObject({ state: 'produced', text: 'Produced Excel workbook: Budget', title: 'Budget' })
  })

  it('pairs by agent and ignores other tools', () => {
    const e = [use('t1', 'Bash', {}), result('t1', 'ok'), use('t2', 'produce_output', {}, 'a2'), harness('Produced file Notes', 'a1'), harness('Produced file Notes', 'a2'), result('t2', 'Produced text "Notes" at outputs/Notes.txt (1 byte). x', false, 'a2')]
    const c = collapseOutputCalls(e)
    expect(c.hidden.has(e[0].id)).toBe(false)
    expect(c.hidden.has(e[2].id)).toBe(true)
    expect(c.rows.get(e[4].id)?.title).toBe('Notes')
    expect(c.rows.get(e[3].id)?.state).toBe('produced')
  })
})

describe('matchOutputId', () => {
  const a = out({ id: 'out_a', createdAt: 1 })
  const b = out({ id: 'out_b', createdAt: 5, relPath: 'outputs/Project plan 2.docx' })
  const c = out({ id: 'out_c', runId: 'r2', title: 'Other' })
  it('relPath wins, then latest by title in that run', () => {
    expect(matchOutputId([b, a, c], 'r1', 'Project plan', 'outputs/Project plan.docx')).toBe('out_a')
    expect(matchOutputId([b, a, c], 'r1', 'Project plan')).toBe('out_b')
    expect(matchOutputId([b, a, c], 'r1', 'Other')).toBeUndefined()
    expect(matchOutputId([b, a, c], ['r1', 'r2'], 'Other')).toBe('out_c')
    expect(matchOutputId(undefined, 'r1', 'x')).toBeUndefined()
  })
  it('matches a title main altered for the prompt', () => {
    expect(matchOutputId([out({ title: 'A <b> C' })], 'r1', 'A ‹b› C')).toBe('out_0000000000000001')
  })
})

describe('producedSentence', () => {
  it('uses the one label per kind and "file" for an unknown one', () => {
    expect(producedSentence('docx', 'Plan')).toBe('Produced Word document: Plan')
    expect(producedSentence('xlsx', 'Budget')).toBe('Produced Excel workbook: Budget')
    expect(producedSentence('svg', 'Logo')).toBe('Produced SVG: Logo')
    expect(producedSentence(undefined, 'X')).toBe('Produced file: X')
    expect(producedSentence('constructor', 'X')).toBe('Produced file: X')
  })
  it('maps the older harness words when no result names the kind', () => {
    const e = [harness('Produced workbook Budget'), harness('Produced document Plan')]
    const c = collapseOutputCalls(e)
    expect(c.rows.get(e[0].id)?.text).toBe('Produced Excel workbook: Budget')
    expect(c.rows.get(e[1].id)?.text).toBe('Produced Word document: Plan')
  })
})

describe('registeredSentence', () => {
  it('lowers the kind word unless it is a name', () => {
    expect(registeredSentence('image', 'Logo')).toBe('Registered image: Logo')
    expect(registeredSentence('pdf', 'Spec')).toBe('Registered PDF: Spec')
    expect(registeredSentence('mermaid', 'Map')).toBe('Registered diagram: Map')
  })
})

describe('unannouncedTitles', () => {
  it('counts what the chain holds now that was neither there at the start nor said', () => {
    const mine = [out({ id: 'e', title: 'E' }), out({ id: 'd', title: 'D' }), out({ id: 'c', title: 'C' }), out({ id: 'b', title: 'B' }), out({ id: 'a', title: 'A' })]
    // 'a' was there at the start; b..e arrived (one of them while the throttle waited): the sentence counts all 4.
    const titles = unannouncedTitles(mine, new Set(['a']))
    expect(titles).toEqual(['B', 'C', 'D', 'E'])
    expect(announceText(titles)).toBe('Produced 4 outputs')
    expect(unannouncedTitles(mine, new Set(['a', 'b', 'c', 'd', 'e']))).toEqual([])
  })
})

describe('announceText', () => {
  it('names one, counts several', () => {
    expect(announceText([])).toBe('')
    expect(announceText(['Project plan'])).toBe('Produced Project plan')
    expect(announceText(['a', 'b', 'c'])).toBe('Produced 3 outputs')
  })
})

describe("new version rows", () => {
  it("reads Updated rows", () => {
    const row = harness("Updated Project plan to version 3")
    const c = collapseOutputCalls([row])
    expect(c.rows.get(row.id)).toMatchObject({ state: "updated", text: "Updated Project plan to version 3", title: "Project plan" })
  })
})
