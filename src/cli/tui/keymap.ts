/**
 * The TUI's one key table (ux-review-tui-org.md F9). The pane-aware hints (status line and the focused pane's own hint
 * line), the generated /help text and the `?` which-key overlay all read KEYMAP, so a key is described in one place and
 * the three cannot drift (keymap.test.ts checks that every entry shows up in HELP_TEXT and the overlay). Pure; no Ink.
 */
import type { FocusTarget, TuiEnv } from './types'
import { asciiOnly } from './theme'

export type KeyScope = 'global' | 'composer' | 'tree' | 'transcript' | 'plan' | 'worktrees' | 'inspector' | 'tray'

/** What the selected tree row is, for the hint swap. */
/** The inspector uses 'agent' = has a worktree, 'waiting' = has a card open, 'bare' = neither. */
export type RowKind = 'agent' | 'group' | 'waiting' | 'bare'

export interface KeyDef {
  scope: KeyScope
  /** The keys as typed in help ("Up / Down"). */
  keys: string
  /** The full sentence in help and the overlay. */
  label: string
  /** In the one-line hint: its place (lower first) and short wording. Absent = help and overlay only. */
  hint?: { order: number; text: string }
  /** The hint (not the help) applies only to these tree row kinds. */
  rows?: readonly RowKind[]
}

export const KEYMAP: readonly KeyDef[] = [
  // ---- Anywhere ----
  { scope: 'global', keys: 'Alt+D, F2, Ctrl+.', label: 'Focus the Decision Tray (Shift+Tab from the composer too)' },
  { scope: 'global', keys: 'Tab, Shift+Tab', label: 'Cycle the panes' },
  { scope: 'global', keys: 'Esc', label: 'From a pane: back to the composer. On the composer: interrupt the running turn' },
  { scope: 'global', keys: 'Ctrl+C', label: 'Clear the composer; twice on an empty composer quits (runs keep going)' },
  { scope: 'global', keys: 'Ctrl+Z', label: 'Suspend (fg to come back)' },
  { scope: 'global', keys: '?', label: 'In a pane: the keys of that pane (the Composer types it: use /help)', hint: { order: 90, text: '? all keys' } },
  { scope: 'global', keys: '[ , ]', label: 'In a pane: follow the previous / next live run (the status bar lists them)' },
  { scope: 'global', keys: 'm', label: 'In a pane: maximise the transcript, again to bring the panes back (/focus)' },
  // ---- Composer ----
  { scope: 'composer', keys: 'Enter', label: 'Send; Alt+Enter adds a new line', hint: { order: 1, text: 'Enter sends' } },
  { scope: 'composer', keys: '/', label: 'Open the command palette (on an empty composer)', hint: { order: 2, text: '/ commands' } },
  { scope: 'composer', keys: 'Tab', label: 'Go to the panes', hint: { order: 4, text: 'Tab panes' } },
  { scope: 'composer', keys: 'Esc', label: 'Interrupt the running turn', hint: { order: 5, text: 'Esc interrupts' } },
  // ---- Org tree ----
  { scope: 'tree', keys: 'Up, Down', label: 'Move between agents', hint: { order: 1, text: 'Up/Down move' } },
  { scope: 'tree', keys: 'Enter', label: 'Open the agent inspector (on a group: unfold it; on an agent that needs you: its decision)', hint: { order: 2, text: 'Enter details' }, rows: ['agent'] },
  { scope: 'tree', keys: 'Enter', label: 'Open that agent\'s decision card', hint: { order: 2, text: 'Enter decide' }, rows: ['waiting'] },
  { scope: 'tree', keys: 'Right, Enter', label: 'Unfold a "N done" group', hint: { order: 2, text: 'Enter/Right unfold' }, rows: ['group'] },
  { scope: 'tree', keys: 'Left', label: 'Fold an unfolded group back' },
  { scope: 'tree', keys: 'h', label: 'Hide / show finished agents (/fold)', hint: { order: 4, text: 'h finished' }, rows: ['group', 'agent'] },
  { scope: 'tree', keys: 'n, N', label: 'Jump to the next / previous agent that needs you', hint: { order: 3, text: 'n next needs-you' }, rows: ['agent', 'waiting'] },
  { scope: 'tree', keys: 'z', label: 'Focus the tree on this agent and its reports (the transcript follows)', hint: { order: 5, text: 'z focus' }, rows: ['agent', 'waiting'] },
  { scope: 'tree', keys: 'Z, Backspace', label: 'Back out of a focused subtree' },
  // ---- Transcript ----
  { scope: 'transcript', keys: 'Up, Down', label: 'Scroll a line', hint: { order: 1, text: 'Up/Down scroll' } },
  { scope: 'transcript', keys: 'PgUp, PgDn', label: 'Scroll a page', hint: { order: 2, text: 'PgUp/PgDn page' } },
  { scope: 'transcript', keys: 'Home, End', label: 'Oldest row / back to the newest', hint: { order: 3, text: 'End newest' } },
  // ---- Plan ----
  { scope: 'plan', keys: 'Up, Down, PgUp, PgDn, Home, End', label: 'Scroll the plan', hint: { order: 1, text: 'Up/Down scroll' } },
  // ---- Worktrees ----
  { scope: 'worktrees', keys: 'Up, Down', label: 'Move between worktrees', hint: { order: 1, text: 'Up/Down move' } },
  { scope: 'worktrees', keys: 'Enter, v', label: 'View the diff in the pager', hint: { order: 2, text: 'v diff' } },
  // ---- Agent inspector ----
  { scope: 'inspector', keys: 'Up, Down, PgUp, PgDn, Home, End', label: "Scroll this agent's transcript", hint: { order: 5, text: 'Up/Down scroll' } },
  { scope: 'inspector', keys: 'd', label: "Go to this agent's decision card", hint: { order: 2, text: 'd decide' }, rows: ['waiting'] },
  { scope: 'inspector', keys: 'w', label: 'Open its worktree diff in the pager', hint: { order: 1, text: 'w diff' }, rows: ['agent'] },
  { scope: 'inspector', keys: 't', label: 'Show / hide its thinking rows', hint: { order: 2, text: 't thinking' } },
  { scope: 'inspector', keys: 'u', label: 'The usage tables in the pager (/usage)', hint: { order: 3, text: 'u usage' } },
  { scope: 'inspector', keys: 'Esc', label: 'Close; the tree keeps the same row', hint: { order: 4, text: 'Esc back' } },
  // ---- Decision Tray ----
  { scope: 'tray', keys: 'Permission', label: 'y allow once, s allow for the session, a always allow for the project (asks to confirm), n deny' },
  { scope: 'tray', keys: 'Rule request', label: 'r grant for the run, a always grant for the project (asks to confirm), n deny' },
  { scope: 'tray', keys: 'Proposal', label: 'y approve, e revise with a note, d decline, s enter secrets, v view in the pager' },
  { scope: 'tray', keys: 'Question', label: '1-9 pick an option, Space toggle (multiple choice), c custom answer, Enter submit' },
  { scope: 'tray', keys: 'Merge review', label: 'v view the diff, m merge, h hold (keep the branch), x discard (asks to confirm)' },
  { scope: 'tray', keys: 'MCP install', label: 'r allow for the run, p save to the project, l save to the library (both ask), n deny' },
  { scope: 'tray', keys: 'TERM=dumb', label: 'press Enter after a decision key' }
]

export const SCOPE_TITLE: Record<KeyScope, string> = {
  global: 'Anywhere',
  composer: 'Composer',
  tree: 'Agents',
  transcript: 'Transcript',
  plan: 'Plan',
  worktrees: 'Worktrees',
  inspector: 'Agent inspector',
  tray: 'Decision Tray (only while the tray has focus)'
}

/** The scope a focus target uses; the palette and onboarding have their own small hint. */
export function scopeOf(focus: FocusTarget): KeyScope | undefined {
  switch (focus) {
    case 'composer':
    case 'tree':
    case 'transcript':
    case 'plan':
    case 'worktrees':
    case 'inspector':
    case 'tray':
      return focus
    default:
      return undefined
  }
}

export const keysFor = (scope: KeyScope): KeyDef[] => KEYMAP.filter((k) => k.scope === scope)

/**
 * The one-line hint of a pane: at most `max` (default 5) hinted keys that apply to the row kind, in hint order. The
 * global hint ("? all keys") always closes the line; the pane's own keys fill the rest, and with a `width` the least
 * important ones drop until the line fits (it is never cut mid-key).
 */
export function paneHint(scope: KeyScope, row: RowKind = 'agent', max = 5, width?: number): string {
  const defs = KEYMAP.filter((k) => k.scope === scope && k.hint && (!k.rows || k.rows.includes(row))).sort((a, b) => a.hint!.order - b.hint!.order)
  const globals = KEYMAP.filter((k) => k.scope === 'global' && k.hint).map((k) => k.hint!.text)
  let n = Math.min(defs.length, Math.max(1, max - globals.length))
  const text = (count: number): string => [...defs.slice(0, count).map((k) => k.hint!.text), ...globals].join(' · ')
  while (width !== undefined && n > 1 && text(n).length > width) n--
  return text(n)
}

/** The status line's hint for a focus (panes: the short global one, the pane's own line carries its keys). */
export function statusHint(focus: FocusTarget, opts: { readOnly: boolean; stopOnQuit: boolean; row?: RowKind }): string {
  const quit = opts.stopOnQuit ? 'Ctrl+C twice stops and quits' : 'Ctrl+C twice quits'
  switch (focus) {
    case 'composer':
      return opts.readOnly ? `Alt+D decisions · Tab panes · ${quit}` : `Enter sends · / commands · Alt+D decisions · Tab panes · Esc interrupts · ${quit}`
    case 'tray':
      return 'Keys on the card · Esc back'
    case 'palette':
      return 'Enter runs · Esc closes'
    case 'onboarding':
      return 'Esc cancels'
    default:
      return `${paneHint(scopeOf(focus) ?? 'tree', opts.row, 3)} · Esc composer`
  }
}

/** The /help key lines, generated from KEYMAP. */
export function helpKeyLines(): string[] {
  const out: string[] = []
  const order: KeyScope[] = ['global', 'composer', 'tree', 'transcript', 'plan', 'worktrees', 'inspector', 'tray']
  for (const scope of order) {
    if (out.length > 0) out.push('')
    out.push(scope === 'global' ? 'Keys' : SCOPE_TITLE[scope])
    const defs = keysFor(scope)
    const width = Math.min(26, Math.max(...defs.map((d) => d.keys.length)) + 2)
    for (const d of defs) out.push(`  ${d.keys.padEnd(width)}${d.label}`)
  }
  return out
}

/** The glyph legend (the tree's state glyphs; ASCII ones when the terminal has no Unicode or a screen reader is on): two short lines. */
export function glyphLegend(env: Pick<TuiEnv, 'unicode' | 'screenReader' | 'dumbTerminal'>): string[] {
  const ascii = asciiOnly(env as TuiEnv)
  if (env.screenReader) return ['Each agent row starts with its state in words: Thinking, Using a tool, Needs you, Delegating, Idle, Finished, Failed.', 'A folded row says "N done, folded"; "messaging" marks a recent message.']
  return ascii
    ? ['o idle  * thinking  # tool  ! needs you  > delegating  v finished  x failed', '~ recent message  "N done >" folded row  2f files in a worktree']
    : ['○ idle  ● thinking  ◆ tool  ! needs you  ◇ delegating  ✓ finished  ✗ failed', '~ recent message  "N done >" folded row  2f files in a worktree']
}

/** The which-key overlay (`?`): the focused pane's keys, the global ones, then the glyph legend. */
export function whichKeyLines(focus: FocusTarget, env: Pick<TuiEnv, 'unicode' | 'screenReader' | 'dumbTerminal'>): { title: string; lines: string[] } {
  const scope = scopeOf(focus) ?? 'tree'
  const fmt = (defs: KeyDef[]): string[] => {
    const width = Math.min(26, Math.max(...defs.map((d) => d.keys.length)) + 2)
    return defs.map((d) => `  ${d.keys.padEnd(width)}${d.label}`)
  }
  const lines = [SCOPE_TITLE[scope], ...fmt(keysFor(scope)), '', SCOPE_TITLE.global, ...fmt(keysFor('global')), '', 'Glyphs', ...glyphLegend(env).map((l) => `  ${l}`), '', 'All commands: /help']
  return { title: `Keys: ${SCOPE_TITLE[scope]}`, lines }
}
