import { describe, expect, it } from 'vitest'
import { buildTextContextMenu, type TextContextMenuParams } from './textContextMenu'

const on = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
const off = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false }
const base: TextContextMenuParams = { isEditable: false, selectionText: '', linkURL: '', editFlags: off }

describe('buildTextContextMenu', () => {
  it('editable field with all flags on', () => {
    const items = buildTextContextMenu({ ...base, isEditable: true, editFlags: on })
    expect(items).toEqual([
      { kind: 'role', role: 'cut', label: 'Cut', enabled: true },
      { kind: 'role', role: 'copy', label: 'Copy', enabled: true },
      { kind: 'role', role: 'paste', label: 'Paste', enabled: true },
      { kind: 'separator' },
      { kind: 'role', role: 'selectAll', label: 'Select all', enabled: true }
    ])
  })
  it('editable field with flags off still shows disabled items', () => {
    const items = buildTextContextMenu({ ...base, isEditable: true, editFlags: off })
    expect(items?.filter((i) => i.kind === 'role').every((i) => i.kind === 'role' && !i.enabled)).toBe(true)
    expect(items).toHaveLength(5)
  })
  it('selection in a non-editable surface gives Copy only', () => {
    expect(buildTextContextMenu({ ...base, selectionText: 'hi', editFlags: on })).toEqual([
      { kind: 'role', role: 'copy', label: 'Copy', enabled: true }
    ])
  })
  it('whitespace-only selection is nothing', () => {
    expect(buildTextContextMenu({ ...base, selectionText: '  \n' })).toBeNull()
  })
  it('http and https links give Copy link address', () => {
    for (const url of ['http://example.com/a', 'https://example.com/a?b=1']) {
      expect(buildTextContextMenu({ ...base, linkURL: url })).toEqual([{ kind: 'copyLink', label: 'Copy link address', url }])
    }
  })
  it('selected link text shows Copy and Copy link address', () => {
    const items = buildTextContextMenu({ ...base, selectionText: 'x', linkURL: 'https://a.test/', editFlags: on })
    expect(items?.map((i) => i.kind)).toEqual(['role', 'copyLink'])
  })
  it('ignores other schemes and garbage', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:a@b.c', 'orgai://x', 'not a url']) {
      expect(buildTextContextMenu({ ...base, linkURL: url })).toBeNull()
    }
  })
  it('nothing gives null', () => {
    expect(buildTextContextMenu(base)).toBeNull()
  })
})
