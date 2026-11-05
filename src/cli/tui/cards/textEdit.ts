/**
 * The tray's small inline editor (W4-T2): typed characters and bracketed pastes append, Backspace removes one code
 * point, Enter submits, Esc cancels. Pure. A paste never submits; its line breaks become spaces (notes are one line).
 */
import type { InputEvent } from '../types'

/** At most this many characters in a tray note or secret (PROPOSAL_NOTE_MAX_CHARS is 4000 in main). */
export const TRAY_TEXT_MAX = 4000

export type EditResult = { kind: 'edit'; value: string } | { kind: 'submit'; value: string } | { kind: 'cancel' } | { kind: 'ignored' }

function clip(s: string): string {
  const chars = Array.from(s)
  return chars.length > TRAY_TEXT_MAX ? chars.slice(0, TRAY_TEXT_MAX).join('') : s
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

export function applyEdit(value: string, e: InputEvent): EditResult {
  if (e.type === 'paste') return { kind: 'edit', value: clip(value + e.text.replace(/\r\n?|\n/g, ' ')) }
  switch (e.name) {
    case 'enter':
      return { kind: 'submit', value }
    case 'escape':
      return { kind: 'cancel' }
    case 'backspace': {
      const chars = Array.from(value)
      chars.pop()
      return { kind: 'edit', value: chars.join('') }
    }
    case 'char':
      if (e.ctrl || e.alt || typeof e.ch !== 'string' || e.ch === '' || CONTROL.test(e.ch)) return { kind: 'ignored' }
      return { kind: 'edit', value: clip(value + e.ch) }
    default:
      return { kind: 'ignored' }
  }
}

/** What the tray shows for a value: the tail of the text, or a mask that never carries the value. */
export function shownValue(value: string, masked: boolean, width: number): string {
  const chars = Array.from(value)
  if (masked) return chars.length === 0 ? '' : `${'*'.repeat(Math.min(chars.length, 24))}${chars.length > 24 ? '+' : ''}`
  const w = Math.max(4, width)
  return chars.length > w ? `…${chars.slice(chars.length - w + 1).join('')}` : value
}
