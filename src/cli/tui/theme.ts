/**
 * TUI colours and glyphs. Colours are Ink colour names (chalk), none when colour is off (--no-color, NO_COLOR, a
 * non-TTY). Glyphs fall back to ASCII without Unicode, for screen readers and on TERM=dumb.
 */
import type { AgentState } from '../../shared/types'
import type { Tone, TuiEnv } from './types'

/**
 * ANSI-16 names only (the terminal's own palette decides the shade). 'dim' has no foreground: it is the dimColor
 * attribute alone, because grey plus dimColor stacked into text too faint to read (issue #32). 'running' is
 * blueBright, not blue (plain blue is nearly invisible on PowerShell's dark-blue background), and 'warn' is magenta,
 * not yellow (yellow washes out on a white background). UNVERIFIED: no real light or dark terminal background was
 * looked at; this is chosen from the usual palettes (Windows Terminal Campbell / One Half Light, macOS Terminal Basic).
 */
const TONE_COLORS: Record<Tone, string | undefined> = {
  ok: 'green',
  warn: 'magenta',
  danger: 'red',
  dim: undefined,
  accent: 'cyan',
  running: 'blueBright'
}

/** The Ink colour for a tone, or undefined when colour is off, no tone is given or the tone has no foreground ('dim'). */
export function toneColor(tone: Tone | undefined, env: TuiEnv): string | undefined {
  if (!env.color || !tone) return undefined
  return TONE_COLORS[tone]
}

export interface Glyphs {
  /** Box drawing: horizontal, vertical, corners, tee. */
  h: string
  v: string
  tl: string
  tr: string
  bl: string
  br: string
  tee: string
  /** Tree branch and last branch for nested agents. */
  branch: string
  lastBranch: string
  bullet: string
  arrow: string
  check: string
  cross: string
  ellipsis: string
  /** Spinner frames. */
  spinner: readonly string[]
}

const UNICODE_GLYPHS: Glyphs = {
  h: '─',
  v: '│',
  tl: '┌',
  tr: '┐',
  bl: '└',
  br: '┘',
  tee: '├',
  branch: '├─',
  lastBranch: '└─',
  bullet: '•',
  arrow: '→',
  check: '✓',
  cross: '✗',
  ellipsis: '…',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
}

const ASCII_GLYPHS: Glyphs = {
  h: '-',
  v: '|',
  tl: '+',
  tr: '+',
  bl: '+',
  br: '+',
  tee: '+',
  branch: '|-',
  lastBranch: '`-',
  bullet: '*',
  arrow: '->',
  check: 'v',
  cross: 'x',
  ellipsis: '...',
  spinner: ['-', '\\', '|', '/']
}

/** ASCII when the terminal has no Unicode, a screen reader is on, or TERM=dumb. */
export function asciiOnly(env: TuiEnv): boolean {
  return !env.unicode || env.screenReader || env.dumbTerminal
}

/**
 * The one list separator for status, tray and hint lines (issue #26 L11): ', ' for a screen reader, ' | ' in ASCII mode
 * (no Unicode, TERM=dumb), else ' · '.
 */
export function separatorFor(env: Pick<TuiEnv, 'unicode' | 'screenReader' | 'dumbTerminal'>): string {
  if (env.screenReader) return ', '
  return asciiOnly(env as TuiEnv) ? ' | ' : ' · '
}

export function glyphs(env: TuiEnv): Glyphs {
  return asciiOnly(env) ? ASCII_GLYPHS : UNICODE_GLYPHS
}

const STATE_UNICODE: Record<AgentState, string> = {
  starting: '◌',
  thinking: '●',
  tool: '◆',
  waiting: '!',
  delegating: '◇',
  idle: '○',
  done: '✓',
  error: '✗'
}

const STATE_ASCII: Record<AgentState, string> = {
  starting: '.',
  thinking: '*',
  tool: '#',
  waiting: '!',
  delegating: '>',
  idle: 'o',
  done: 'v',
  error: 'x'
}

/** One glyph per agent state (the state word is always shown beside it, so the glyph is never the only cue). */
export function stateGlyph(state: AgentState, env: TuiEnv): string {
  return (asciiOnly(env) ? STATE_ASCII : STATE_UNICODE)[state] ?? '?'
}

/** The tone for an agent state. */
export function stateTone(state: AgentState): Tone {
  switch (state) {
    case 'done':
      return 'ok'
    case 'error':
      return 'danger'
    case 'waiting':
      return 'warn'
    case 'idle':
      return 'dim'
    default:
      return 'running'
  }
}
