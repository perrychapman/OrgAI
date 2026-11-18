/**
 * Native text context menu (pure part). Takes the fields of Electron's `context-menu` params that matter and returns a
 * menu description, or null when nothing should show (so plain surfaces stay free for the renderer's own menus). It
 * imports no electron code: index.ts turns the description into a Menu. Spellcheck is not enabled in this app, so
 * there are no suggestion items.
 */

export interface TextContextMenuParams {
  isEditable: boolean
  selectionText: string
  linkURL: string
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }
}

export type TextContextMenuItem =
  | { kind: 'role'; role: 'cut' | 'copy' | 'paste' | 'selectAll'; label: string; enabled: boolean }
  | { kind: 'copyLink'; label: string; url: string }
  | { kind: 'separator' }

function isWebUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function buildTextContextMenu(params: TextContextMenuParams): TextContextMenuItem[] | null {
  const flags = params.editFlags
  if (params.isEditable) {
    return [
      { kind: 'role', role: 'cut', label: 'Cut', enabled: flags.canCut },
      { kind: 'role', role: 'copy', label: 'Copy', enabled: flags.canCopy },
      { kind: 'role', role: 'paste', label: 'Paste', enabled: flags.canPaste },
      { kind: 'separator' },
      { kind: 'role', role: 'selectAll', label: 'Select all', enabled: flags.canSelectAll }
    ]
  }
  const items: TextContextMenuItem[] = []
  if (params.selectionText.trim() !== '') {
    items.push({ kind: 'role', role: 'copy', label: 'Copy', enabled: flags.canCopy })
  }
  if (params.linkURL !== '' && isWebUrl(params.linkURL)) {
    items.push({ kind: 'copyLink', label: 'Copy link address', url: params.linkURL })
  }
  return items.length > 0 ? items : null
}
