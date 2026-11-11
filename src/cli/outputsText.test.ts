import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OutputPreview, RunOutput } from '../shared/types'
import { bytesText, countRunOutputs, outputsOfRun, outputsOverlayText, outputSummary, previewLines, previewPlainText } from './outputsText'

const o = (over: Partial<RunOutput> = {}): RunOutput => ({
  id: 'out_1', projectId: 'p1', runId: 'r1', kind: 'docx', title: 'Report\x1b[31m', fileName: 'r.docx', path: '/p/outputs/r.docx', relPath: 'outputs/r.docx', bytes: 1536, createdAt: 1, source: 'produced', version: 3, openNoteCount: 2, ...over
})

describe('outputsText', () => {
  it('sizes and one-line summary, cleaned', () => {
    expect(bytesText(12)).toBe('12 B')
    expect(bytesText(1536)).toBe('1.5 KB')
    expect(bytesText(5 * 1024 * 1024)).toBe('5 MB')
    const s = outputSummary(o())
    expect(s).toBe('Report [out_1] docx · v3 · 1.5 KB · 2 open notes')
    expect(outputSummary(o({ missing: true, openNoteCount: 0 }))).toContain('file missing')
  })

  it('outputsOfRun matches the maker and the current version\'s run', () => {
    const list = [o(), o({ id: 'out_2', runId: 'r2', current: { source: 'agent', at: 1, runId: 'r1' } as never }), o({ id: 'out_3', runId: 'r3' })]
    expect(outputsOfRun(list, 'r1').map((x) => x.id)).toEqual(['out_1', 'out_2'])
  })

  it('previewPlainText flattens documents, sheets and slides; none and image have no text', () => {
    const doc: OutputPreview = { kind: 'document', blocks: [{ type: 'heading', level: 1, runs: [{ text: 'Title' }] }, { type: 'list', ordered: true, items: [[{ text: 'a' }], [{ text: 'b' }]] }, { type: 'table', rows: [[[{ text: 'x' }], [{ text: 'y' }]]] }] }
    expect(previewPlainText(doc)).toBe('Title\n1. a\n2. b\nx | y')
    expect(previewPlainText({ kind: 'sheets', sheets: [{ name: 'S', rows: [[{ v: 1 }, { v: null }, { v: 'z' }]] }] })).toBe('# S\n1 |  | z')
    expect(previewPlainText({ kind: 'none', reason: 'open-only' })).toBeUndefined()
    expect(previewPlainText({ kind: 'image', dataUrl: 'data:image/png;base64,AA' })).toBeUndefined()
  })

  it('previewLines cleans escapes and caps lines and characters', () => {
    expect(previewLines('a\x1b[31mb\nc').lines).toEqual(['ab', 'c'])
    const long = previewLines(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'))
    expect(long.lines).toHaveLength(40)
    expect(long.truncated).toBe(true)
    expect(previewLines('x'.repeat(5000)).truncated).toBe(true)
  })

  it('overlay text lists outputs or says there are none', () => {
    expect(outputsOverlayText([])).toContain('no outputs yet')
    const t = outputsOverlayText([o()], () => 'DATE')
    expect(t).toContain('1 output of this run')
    expect(t).toContain('outputs/r.docx')
  })

  describe('countRunOutputs', () => {
    let dir = ''
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
    it('counts the run\'s entries in the saved index; 0 when missing or broken', () => {
      dir = mkdtempSync(join(tmpdir(), 'orgai-out-'))
      mkdirSync(join(dir, 'projects', 'p1'), { recursive: true })
      expect(countRunOutputs(dir, 'p1', 'r1')).toBe(0)
      writeFileSync(join(dir, 'projects', 'p1', 'outputs.json'), JSON.stringify({ version: 2, outputs: [{ id: 'a', runId: 'r1' }, { id: 'b', runId: 'r2' }, { id: 'c', runId: 'r2', current: { runId: 'r1' } }] }))
      expect(countRunOutputs(dir, 'p1', 'r1')).toBe(2)
      expect(countRunOutputs(dir, '../x', 'r1')).toBe(0)
      writeFileSync(join(dir, 'projects', 'p1', 'outputs.json'), '{nope')
      expect(countRunOutputs(dir, 'p1', 'r1')).toBe(0)
    })
  })
})
