/**
 * The keyboard shortcuts table (copied from the renderer's lib/menuActions.ts; the Keyboard shortcuts dialog and the
 * app atlas read it). Pure data, no renderer imports.
 */
export interface ShortcutDef {
  group: 'General' | 'Runs' | 'Canvas'
  label: string
  /** Alternatives; each is the keys pressed together. 'Mod' is Ctrl, or Cmd on a Mac. */
  combos: string[][]
  /** Extra condition, shown as a caption. */
  note?: string
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { group: 'General', label: 'New project', combos: [['Mod', 'N']] },
  { group: 'General', label: 'New chat', combos: [['Mod', 'Shift', 'N']] },
  { group: 'General', label: 'App settings', combos: [['Mod', ',']] },
  { group: 'General', label: 'Collapse or expand the sidebar', combos: [['Mod', 'B']] },
  { group: 'General', label: 'Live, History, Team, Project settings', combos: [['Mod', '1'], ['Mod', '2'], ['Mod', '3'], ['Mod', '4']] },
  { group: 'Runs', label: 'New run', combos: [['Mod', 'T']] },
  { group: 'Runs', label: 'Close tab', combos: [['Mod', 'W']] },
  { group: 'Runs', label: 'Go to decision', combos: [['Mod', '.'], ['Alt', 'D']] },
  { group: 'Runs', label: 'Open the tab menu', combos: [['Shift', 'F10']], note: 'on a focused tab' },
  { group: 'Runs', label: 'Hide a finished tab', combos: [['Delete']], note: 'on a focused tab' },
  { group: 'Canvas', label: 'Zoom in', combos: [['+']], note: 'with the canvas focused' },
  { group: 'Canvas', label: 'Zoom out', combos: [['-']], note: 'with the canvas focused' },
  { group: 'Canvas', label: 'Fit to view', combos: [['0']], note: 'with the canvas focused' }
]
