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

/**
 * Terminal equivalents of styles/tokens.css and docs/design/spec.md sections 4 and 9.
 * Use text tokens, never the lower-contrast status fills. Identity uses a saturated violet so agent names stand apart from prose
 * and state hues; message uses edge-message.
 */
const TERMINAL_PALETTES = {
  dark: {
    primary: '#e8ebf3', secondary: '#a3adc2', surface: '#181c27', brandBase: '#ffffff',
    accent: '#a592ff', running: '#4cb8ff', ok: '#34d399', warn: '#f5b73d', danger: '#ff7b7b',
    identity: '#b18aff', identityCyan: '#64d8e8', identityGreen: '#7dd3a8', identityAmber: '#edc46a', identityPink: '#ef9dc6', identityBlue: '#8bb8ff', message: '#5d8bd6', code: '#a3adc2'
  },
  light: {
    primary: '#12151f', secondary: '#4a5368', surface: '#f4f5f9', brandBase: '#12151f',
    accent: '#4f33d6', running: '#0a5fa2', ok: '#096a48', warn: '#7d4a00', danger: '#b3242f',
    identity: '#7136c8', identityCyan: '#096e80', identityGreen: '#236e48', identityAmber: '#805600', identityPink: '#a02e70', identityBlue: '#285db0', message: '#2f67b4', code: '#4a5368'
  }
} as const

export function terminalPalette(env: Pick<TuiEnv, 'terminalTheme'>) {
  return TERMINAL_PALETTES[env.terminalTheme === 'light' ? 'light' : 'dark']
}

/** Pair fill and text so the prompt stays readable even without terminal theme metadata. */
export function composerSurface(env: TuiEnv): { backgroundColor?: string; color?: string } {
  if (!env.color || env.screenReader || env.dumbTerminal) return {}
  const palette = terminalPalette(env)
  return { backgroundColor: palette.surface, color: palette.primary }
}

/** The Ink colour for a tone, or undefined when colour is off, no tone is given or the tone has no foreground ('dim'). */
export function toneColor(tone: Tone | undefined, env: TuiEnv): string | undefined {
  if (!env.color || env.screenReader || env.dumbTerminal || !tone || tone === 'dim') return undefined
  const palette = terminalPalette(env)
  return tone === 'muted' ? palette.secondary : palette[tone]
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
