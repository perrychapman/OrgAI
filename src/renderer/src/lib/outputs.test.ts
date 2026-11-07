import { describe, expect, it } from 'vitest'
import type { RunOutput } from '@shared/types'
import { PreviewCache, canDeleteOutput, canOpenOutput, extBadgeText, fileExtension, formatBytes, kindChipLabel, kindLabel, mergeOutput, outputKindLabel, outputMetaLine, outputSearchTerms, outputsCountLabel, outputsOfRuns, previewKey, provenanceLine } from './outputs'

function out(id: string, extra: Partial<RunOutput> = {}): RunOutput {
  return {
    id,
    projectId: 'p1',
    runId: 'r1',
    kind: 'docx',
    title: `Title ${id}`,
    fileName: `${id}.docx`,
    path: `/p/outputs/${id}.docx`,
    relPath: `outputs/${id}.docx`,
    bytes: 38 * 1024,
    createdAt: Date.UTC(2026, 10, 7, 12),
    source: 'produced',
    ...extra
  }
}

describe('outputs helpers', () => {
  it('labels kinds in plain words', () => {
    expect(kindLabel('docx')).toBe('Word document')
    expect(kindLabel('xlsx')).toBe('Excel workbook')
    expect(kindLabel('mermaid')).toBe('Diagram')
    expect(kindLabel('markdown')).toBe('Markdown')
    expect(kindLabel('text')).toBe('Text')
    expect(kindLabel('csv')).toBe('CSV')
    expect(kindLabel('json')).toBe('JSON')
    expect(kindLabel('svg')).toBe('SVG')
    expect(kindLabel('image')).toBe('Image')
    expect(kindLabel('pdf')).toBe('PDF')
    expect(kindLabel('other')).toBe('File')
    expect(outputKindLabel('docx')).toBe('Word document')
  })

  it('shortens only the two Office chips', () => {
    expect(kindChipLabel('docx')).toBe('Word')
    expect(kindChipLabel('xlsx')).toBe('Excel')
    expect(kindChipLabel('mermaid')).toBe('Diagram')
  })

  it('reads the extension for the badge', () => {
    expect(extBadgeText('Project plan.docx')).toBe('.docx')
    expect(extBadgeText('a.b.XLSX')).toBe('.xlsx')
    expect(extBadgeText('outputs\\x.md')).toBe('.md')
    expect(extBadgeText('README')).toBe('')
    expect(extBadgeText('.env')).toBe('')
    expect(extBadgeText('x.not an ext')).toBe('')
    expect(fileExtension('x.verylongextension')).toBe('')
  })

  it('search terms carry the kind name, extension and the words a user types', () => {
    const terms = outputSearchTerms(out('a'))
    expect(terms).toEqual(expect.arrayContaining(['Word document', 'docx', 'word']))
    expect(outputSearchTerms(out('b', { kind: 'xlsx', fileName: 'b.xlsx' }))).toEqual(expect.arrayContaining(['excel', 'xlsx']))
  })

  it('formats sizes and never says 0 KB for a non-empty file', () => {
    expect(formatBytes(0)).toBe('0 bytes')
    expect(formatBytes(1)).toBe('1 byte')
    expect(formatBytes(512)).toBe('512 bytes')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(38 * 1024)).toBe('38 KB')
    expect(formatBytes(1.2 * 1024 * 1024)).toBe('1.2 MB')
    expect(formatBytes(25 * 1024 * 1024)).toBe('25 MB')
    expect(formatBytes(Number.NaN)).toBe('')
    expect(formatBytes(-1)).toBe('')
  })

  it('builds the meta and provenance lines', () => {
    expect(outputMetaLine(out('a'))).toBe('Word document · 38 KB · outputs/a.docx')
    expect(provenanceLine({ role: 'Analyst', createdAt: Date.UTC(2026, 10, 7, 12) }, 'R1')).toMatch(/^Analyst · R1 · 7 Nov 2026$/)
    expect(provenanceLine({ createdAt: Date.UTC(2026, 10, 7, 12) })).toMatch(/^An agent · 7 Nov 2026$/)
    expect(provenanceLine({ role: '  ', createdAt: Date.UTC(2026, 10, 7, 12) }, 'R2')).toMatch(/^An agent · R2 /)
  })

  it('opens every kind but other, deletes only produced files that exist', () => {
    expect(canOpenOutput({ kind: 'image' })).toBe(true)
    expect(canOpenOutput({ kind: 'other' })).toBe(false)
    expect(canOpenOutput({ kind: 'svg' })).toBe(false)
    expect(canOpenOutput({ kind: 'docx', missing: true })).toBe(false)
    expect(canDeleteOutput({ source: 'produced' })).toBe(true)
    expect(canDeleteOutput({ source: 'registered' })).toBe(false)
    expect(canDeleteOutput({ source: 'produced', missing: true })).toBe(false)
  })

  it('merges newest first and replaces by id in place', () => {
    const a = out('a')
    const b = out('b')
    expect(mergeOutput(undefined, a)).toEqual([a])
    expect(mergeOutput([a], b).map((o) => o.id)).toEqual(['b', 'a'])
    const a2 = { ...a, title: 'New' }
    const merged = mergeOutput([b, a], a2)
    expect(merged.map((o) => o.id)).toEqual(['b', 'a'])
    expect(merged[1].title).toBe('New')
  })

  it('filters to a chain and counts', () => {
    const list = [out('a', { runId: 'r2' }), out('b', { runId: 'r1' }), out('c', { runId: 'r9' })]
    expect(outputsOfRuns(list, ['r1', 'r2']).map((o) => o.id)).toEqual(['a', 'b'])
    expect(outputsOfRuns(list, new Set(['r9'])).map((o) => o.id)).toEqual(['c'])
    expect(outputsOfRuns(undefined, ['r1'])).toEqual([])
    expect(outputsCountLabel(1)).toBe('1 output')
    expect(outputsCountLabel(5)).toBe('5 outputs')
  })

  it('keys previews by updatedAt and evicts the least recently used', () => {
    expect(previewKey({ id: 'x', createdAt: 1 })).toBe('x@1')
    expect(previewKey({ id: 'x', createdAt: 1, updatedAt: 5 })).toBe('x@5')
    const c = new PreviewCache(2)
    c.set('a', { kind: 'none', reason: 'a' })
    c.set('b', { kind: 'none', reason: 'b' })
    expect(c.get('a')).toBeDefined()
    c.set('c', { kind: 'none', reason: 'c' })
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBeDefined()
    expect(c.size).toBe(2)
  })
})
