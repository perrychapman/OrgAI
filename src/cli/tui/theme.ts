/**
 * TUI colours and glyphs. Colours are Ink/chalk names or hex values, none when colour is off (--no-color, NO_COLOR, a
 * non-TTY). Glyphs fall back to ASCII without Unicode, for screen readers and on TERM=dumb.
 */
import type { AgentState } from '../../shared/types'
import type { Tone, TuiEnv } from './types'

/** Prefer an explicit override, then the terminal's advertised ANSI background. */
export function terminalThemeFor(env: Record<string, string | undefined>): 'dark' | 'light' {
  if (env.ORGAI_THEME === 'dark' || env.ORGAI_THEME === 'light') return env.ORGAI_THEME
  const value = env.COLORFGBG?.split(';').at(-1)
  if (value && /^\d+$/.test(value)) {
    const background = Number(value)
    if (background === 7 || (background >= 9 && background <= 15)) return 'light'
  }
  return 'dark'
}

/** Pair fill and text so the prompt stays readable even without terminal theme metadata. */
export function composerSurface(env: TuiEnv): { backgroundColor?: string; color?: string } {
  if (!env.color || env.screenReader || env.dumbTerminal) return {}
  return env.terminalTheme === 'light'
    ? { backgroundColor: '#f5f5f5', color: '#202124' }
    : { backgroundColor: '#2d2e34', color: '#e4e7ef' }
}

const TONE_COLORS: Record<Tone, string | undefined> = {
  ok: 'green',
  // Middle tones retain contrast on both light Terminal.app profiles and dark terminals.
  warn: '#a87422',
  danger: 'red',
  dim: undefined,
  accent: '#287fc0',
  running: '#287fc0'
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
