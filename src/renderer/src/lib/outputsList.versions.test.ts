import { describe, expect, it } from 'vitest'
import type { RunOutput } from '@shared/types'
import { cardMetaLine, currentProvenance, dayGroups, deletedText, gridColumns, gridTarget, isNewVersion, openNotesLabel, readViewMode, rowMetaLine, updatedText, updatedVersions } from './outputsList'

function out(id: string, over: Partial<RunOutput> = {}): RunOutput {
  return { id, projectId: 'p', runId: 'r1', kind: 'docx', title: `Title ${id}`, fileName: `${id}.docx`, path: `/p/outputs/${id}.docx`, relPath: `outputs/${id}.docx`, bytes: 10, createdAt: 1000, source: 'produced', ...over }
}

describe('version helpers', () => {
  it('meta lines', () => {
    expect(rowMetaLine(out('a', { kind: 'xlsx', bytes: 24 * 1024, version: 2, versionCount: 3 }))).toBe('Excel workbook · v2 · 3 versions · 24 KB')
    expect(rowMetaLine(out('a', { kind: 'xlsx', bytes: 24 * 1024 }))).toBe('Excel workbook · 24 KB')
    expect(cardMetaLine(out('a', { kind: 'xlsx', version: 2, versionCount: 2 }))).toBe('v2 · Excel')
    expect(cardMetaLine(out('a', { kind: 'pptx' }))).toBe('Deck')
  })
  it('provenance of the current version', () => {
    const tag = (r: string): string => `R-${r}`
    expect(currentProvenance(out('a', { current: { source: 'edit', at: 1 } }), tag)).toMatch(/^You · edited/)
    expect(currentProvenance(out('a', { current: { source: 'restore', at: 1 } }), tag)).toMatch(/^You · restored/)
    expect(currentProvenance(out('a', { current: { source: 'external', at: 1 } }), tag)).toMatch(/^Changed outside OrgAI/)
    expect(currentProvenance(out('a', { role: 'Analyst', runId: 'r1' }), tag)).toMatch(/^Analyst · R-r1 · /)
  })
  it('new badge and updates', () => {
    expect(isNewVersion(out('a', { version: 3 }), { a: 2 })).toBe(true)
    expect(isNewVersion(out('a', { version: 2 }), { a: 2 })).toBe(false)
    expect(isNewVersion(out('a', { version: 2 }), {})).toBe(false)
    const up = updatedVersions([out('a', { title: 'Plan', version: 2 })], [out('b'), out('a', { title: 'Plan', version: 3 })])
    expect(up).toEqual([{ id: 'a', title: 'Plan', version: 3 }])
    expect(updatedText(up)).toBe('Updated Plan to version 3')
    expect(openNotesLabel(1)).toBe('1 open note')
    expect(deletedText(3)).toBe('Deleted 3 outputs.')
  })
  it('groups by the current version time', () => {
    const day = 86_400_000
    const g = dayGroups([out('a', { createdAt: 1_000, updatedAt: 10 * day })], 10 * day + 5)
    expect(g[0].label).toBe('Today')
  })
  it('grid keys', () => {
    expect(gridColumns([0, 0, 0, 100, 100])).toBe(3)
    expect(gridTarget('ArrowDown', 1, 7, 3)).toBe(4)
    expect(gridTarget('ArrowDown', 5, 7, 3)).toBe(5)
    expect(gridTarget('ArrowLeft', 0, 7, 3)).toBe(0)
    expect(gridTarget('End', 0, 7, 3)).toBe(6)
    expect(readViewMode('grid')).toBe('grid')
    expect(readViewMode('x')).toBe('list')
  })
})
