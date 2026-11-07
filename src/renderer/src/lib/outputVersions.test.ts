import { describe, expect, it } from 'vitest'
import type { OutputDeletePreview, OutputVersion } from '@shared/types'
import { bulkDeleteCopy, deleteCopy, externalNotice, oldVersionText, restoredNotice, sizeDelta, versionOptionLabel, versionSourceText } from './outputVersions'

const v = (n: number, extra: Partial<OutputVersion> = {}): OutputVersion => ({ n, source: 'agent', createdAt: Date.UTC(2026, 10, 7, 12), title: 't', bytes: 10, digest: 'd', noteCount: 0, openNoteCount: 0, ...extra })
const prev = (extra: Partial<OutputDeletePreview> = {}): OutputDeletePreview => ({ path: 'C:/p/outputs/a.docx', relPath: 'outputs/a.docx', outsideOutputsFolder: false, versions: 3, trash: true, missing: false, ...extra })

describe('version wording', () => {
  it('labels select options', () => {
    expect(versionOptionLabel(v(3, { role: 'Analyst' }), 3)).toMatch(/^v3 · now, Analyst · 7 Nov$/)
    expect(versionOptionLabel(v(2, { source: 'edit' }), 3)).toMatch(/^v2 · edited by you · 7 Nov$/)
    expect(versionOptionLabel(v(2, { source: 'edit', label: 'Final' }), 3)).toContain('v2 · Final · edited by you')
  })
  it('words the sources', () => {
    expect(versionSourceText(v(1, { role: 'Analyst' }), { first: true, runTag: 'R2' })).toBe('Produced by Analyst · R2')
    expect(versionSourceText(v(3, { role: 'Analyst' }), { first: false, runTag: 'R3', answeredNotes: 2 })).toBe('Updated by Analyst · R3 (answering 2 notes)')
    expect(versionSourceText(v(2, { source: 'edit' }), { first: false })).toBe('Edited by you')
    expect(versionSourceText(v(2, { source: 'external' }), { first: false })).toBe('Changed outside OrgAI')
    expect(versionSourceText(v(4, { source: 'restore', restoredFrom: 1 }), { first: false })).toBe('Restored from version 1')
  })
  it('sizes and notices', () => {
    expect(sizeDelta(1024, 3200)).toBe('+2.1 KB')
    expect(sizeDelta(300, 100)).toBe('-200 bytes')
    expect(sizeDelta(5, 5)).toBe('')
    expect(sizeDelta(undefined, 5)).toBe('')
    expect(restoredNotice(2, 5)).toBe('Restored version 2 as version 5.')
    expect(externalNotice(4, 'Word')).toBe('Version 4 added from your changes in Word.')
    expect(oldVersionText(2, 3)).toBe('You are looking at version 2. The current version is 3.')
  })
})

describe('delete wording', () => {
  it('produced', () => {
    const c = deleteCopy('Plan', { source: 'produced' }, prev())
    expect(c.title).toBe('Delete Plan?')
    expect(c.lead).toContain('outputs/a.docx and its 2 earlier versions from your computer')
  })
  it('registered shows the full path', () => {
    const c = deleteCopy('Plan', { source: 'registered' }, prev({ outsideOutputsFolder: true }))
    expect(c.title).toBe('Delete Plan and its file?')
    expect(c.path).toBe('C:/p/outputs/a.docx')
  })
  it('missing and no trash', () => {
    expect(deleteCopy('Plan', { source: 'produced' }, prev({ missing: true })).title).toBe('Remove Plan from OrgAI?')
    expect(deleteCopy('Plan', { source: 'produced' }, prev({ trash: false, versions: 1 })).lead).toContain('deleted for good')
  })
  it('bulk', () => {
    const b = bulkDeleteCopy([prev({ versions: 3 }), prev({ versions: 4 }), prev({ missing: true, versions: 0 })])
    expect(b.title).toBe('Delete 3 outputs?')
    expect(b.lead).toContain('2 files and 7 stored versions')
  })
})
