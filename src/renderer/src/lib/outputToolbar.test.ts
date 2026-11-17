import { describe, expect, it } from 'vitest'
import type { OutputKind } from '@shared/types'
import { canOpenOutput, canReviseFallback, externalAppName, isEditableKind } from './outputs'
import { hasPreviewKind, menuLeadActions, primaryAction, toolbarControlCount, type PrimaryInput } from './outputToolbar'

const base: PrimaryInput = { kind: 'markdown', missing: false, isCurrent: true, canEdit: true, external: null, canOpen: true, canRevise: true }

/** The input the detail builds for a kind (current version, nothing blocking Edit). */
function forKind(kind: OutputKind, over: Partial<PrimaryInput> = {}): PrimaryInput {
  const o = { kind }
  return { kind, missing: false, isCurrent: true, canEdit: isEditableKind(kind), external: externalAppName(kind), canOpen: canOpenOutput(o), canRevise: canReviseFallback(o), ...over }
}

describe('hasPreviewKind', () => {
  it('is false for pdf and other only', () => {
    expect(hasPreviewKind('pdf')).toBe(false)
    expect(hasPreviewKind('other')).toBe(false)
    for (const k of ['docx', 'xlsx', 'pptx', 'mermaid', 'markdown', 'text', 'csv', 'json', 'svg', 'image'] as const) expect(hasPreviewKind(k)).toBe(true)
  })
})

describe('primaryAction', () => {
  it('leads with in-app Edit for an editable kind on the current version', () => {
    expect(primaryAction(base)).toBe('edit')
    for (const k of ['markdown', 'text', 'csv', 'json', 'mermaid', 'svg'] as const) expect(primaryAction(forKind(k))).toBe('edit')
  })
  it('leads with Edit in the app for an Office kind on the current version', () => {
    for (const k of ['docx', 'xlsx', 'pptx'] as const) expect(primaryAction(forKind(k))).toBe('edit-external')
  })
  it('leads with Open for pdf and image', () => {
    expect(primaryAction(forKind('pdf'))).toBe('open')
    expect(primaryAction(forKind('image'))).toBe('open')
  })
  it('has nothing to lead with for an "other" file (not openable, not revisable)', () => {
    expect(primaryAction(forKind('other'))).toBeNull()
  })
  it('asks for a revision on an older version when that is possible', () => {
    expect(primaryAction(forKind('markdown', { isCurrent: false, canEdit: false }))).toBe('revise')
    expect(primaryAction(forKind('docx', { isCurrent: false }))).toBe('revise')
  })
  it('falls back to Open on an older version that cannot be revised', () => {
    expect(primaryAction(forKind('pdf', { isCurrent: false }))).toBe('open')
    expect(primaryAction(forKind('image', { isCurrent: false }))).toBe('open')
  })
  it('has nothing on an older version that can be neither revised nor opened', () => {
    expect(primaryAction(forKind('other', { isCurrent: false }))).toBeNull()
  })
  it('opens a current file that is too large to edit, else asks for a revision', () => {
    expect(primaryAction({ ...base, canEdit: false })).toBe('open')
    expect(primaryAction({ ...base, canEdit: false, canOpen: false })).toBe('revise')
    expect(primaryAction({ ...base, canEdit: false, canOpen: false, canRevise: false })).toBeNull()
  })
  it('asks for a revision of a missing file when allowed, else nothing', () => {
    expect(primaryAction({ ...base, missing: true, canEdit: false, canOpen: false, canRevise: true })).toBe('revise')
    expect(primaryAction({ ...base, missing: true, canEdit: false, canOpen: false, canRevise: false })).toBeNull()
    expect(primaryAction(forKind('docx', { missing: true, canRevise: false }))).toBeNull()
  })
  it('leads with nothing while the editor is open', () => {
    expect(primaryAction({ ...base, editing: true })).toBeNull()
  })
})

describe('menuLeadActions', () => {
  const all = { canEdit: true, canEditExternal: true, canOpen: true, canRevise: true }
  it('never repeats the primary in More', () => {
    expect(menuLeadActions('edit', all)).toEqual({ edit: false, editExternal: true, open: true, revise: true })
    expect(menuLeadActions('edit-external', all)).toEqual({ edit: true, editExternal: false, open: true, revise: true })
    expect(menuLeadActions('open', all)).toEqual({ edit: true, editExternal: true, open: false, revise: true })
    expect(menuLeadActions('revise', all)).toEqual({ edit: true, editExternal: true, open: true, revise: false })
  })
  it('lists an available action when there is no primary, and hides an unavailable one', () => {
    expect(menuLeadActions(null, { canEdit: false, canEditExternal: false, canOpen: true, canRevise: true })).toEqual({ edit: false, editExternal: false, open: true, revise: true })
  })
  it('puts a markdown output on its current version as Edit in the toolbar, Open and Revise in More', () => {
    const p = primaryAction(forKind('markdown'))
    expect(menuLeadActions(p, { canEdit: true, canEditExternal: false, canOpen: true, canRevise: true })).toEqual({ edit: false, editExternal: false, open: true, revise: true })
  })
})

describe('toolbarControlCount', () => {
  it('is at most four at rest', () => {
    expect(toolbarControlCount({ primary: 'edit', notes: true, larger: true })).toBe(4)
    expect(toolbarControlCount({ primary: 'open', notes: false, larger: false })).toBe(2)
    expect(toolbarControlCount({ primary: null, notes: false, larger: false })).toBe(1)
  })
})
