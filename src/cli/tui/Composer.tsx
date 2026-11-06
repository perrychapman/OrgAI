/**
 * The Composer (W4-T4; cli-spec 5.3(1)). While it has focus every character key inserts literal text (y, s, a, n, m,
 * h, x, r, p, l and digits included: decision shortcuts only work in the focused Decision Tray), and a paste is
 * inserted literally at the cursor and never submits. Enter submits the trimmed text; Alt+Enter or Ctrl+J (on terminals
 * that report it) inserts a newline; '/' on an empty buffer opens the slash palette; Shift+Tab leaves for the tray.
 * Esc is not consumed (the shell interrupts a running turn) and Ctrl+C clears a non-empty buffer, else it is left to
 * the shell (quit). Input arrives through the InputBus only, never Ink's useInput.
 *
 * The buffer holds only the user's own text, already free of escapes and hidden characters (KeyParser sanitizes key
 * characters and pastes), so it is rendered as typed.
 */
import { Box, Text } from 'ink'
import { useRef, useState, type ReactNode } from 'react'
import { useFocusHandler, useTuiEnv } from './context'
import {
  backspace,
  deleteForward,
  EMPTY_BUFFER,
  graphemeWidth,
  insertText,
  killToLineEnd,
  killToLineStart,
  killWordBack,
  lineEnd,
  lineHome,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  wrapBuffer,
  type TextBuffer
} from './input/textBuffer'
import { sanitizeTty } from './sanitizeTty'
import { asciiOnly, toneColor } from './theme'
import type { ComposerMode, ComposerProps, InputEvent } from './types'

/** At most this many text rows are visible; the view scrolls to keep the cursor's row shown. */
export const COMPOSER_MAX_ROWS = 6

const PROMPT_UNICODE: Record<ComposerMode, string> = { start: '✚', send: '❯', continue: '↻', quick: '?', readOnly: '·' }
const PROMPT_ASCII: Record<ComposerMode, string> = { start: '+>', send: '>', continue: '>>', quick: '?>', readOnly: '--' }

export function promptGlyph(mode: ComposerMode, ascii: boolean): string {
  return (ascii ? PROMPT_ASCII : PROMPT_UNICODE)[mode] ?? '>'
}

/** Applies one input event; returns the new buffer and what happened, or null when the event is not the Composer's. */
export function composerReduce(
  b: TextBuffer,
  e: InputEvent,
  mode: ComposerMode
): { buffer: TextBuffer; action?: 'submit' | 'palette' | 'leave'; submitted?: string } | null {
  if (e.type === 'paste') return { buffer: insertText(b, e.text) }
  switch (e.name) {
    case 'char': {
      const ch = e.ch ?? ''
      if (e.alt) return null
      if (e.ctrl) {
        switch (ch) {
          case 'a':
            return { buffer: lineHome(b) }
          case 'e':
            return { buffer: lineEnd(b) }
          case 'u':
            return { buffer: killToLineStart(b) }
          case 'k':
            return { buffer: killToLineEnd(b) }
          case 'w':
            return { buffer: killWordBack(b) }
          case 'b':
            return { buffer: moveLeft(b) }
          case 'f':
            return { buffer: moveRight(b) }
          case 'h':
            return { buffer: backspace(b) }
          case 'j':
            return { buffer: insertText(b, '\n') }
          case 'c':
            return b.text === '' ? null : { buffer: EMPTY_BUFFER }
          case 'd':
            return b.text === '' ? null : { buffer: deleteForward(b) }
          default:
            return null
        }
      }
      if (!ch) return null
      if (ch === '/' && b.text === '') return { buffer: b, action: 'palette' }
      return { buffer: insertText(b, ch) }
    }
    case 'enter': {
      if (e.alt || e.shift) return { buffer: insertText(b, '\n') }
      const text = b.text.trim()
      if (text === '' || mode === 'readOnly') return { buffer: b }
      return { buffer: EMPTY_BUFFER, action: 'submit', submitted: text }
    }
    case 'backspace':
      return { buffer: e.alt || e.ctrl ? killWordBack(b) : backspace(b) }
    case 'delete':
      return { buffer: deleteForward(b) }
    case 'left':
      return { buffer: moveLeft(b) }
    case 'right':
      return { buffer: moveRight(b) }
    case 'home':
      return { buffer: lineHome(b) }
    case 'end':
      return { buffer: lineEnd(b) }
    case 'up': {
      const n = moveUp(b)
      return n ? { buffer: n } : null
    }
    case 'down': {
      const n = moveDown(b)
      return n ? { buffer: n } : null
    }
    case 'backtab':
      return { buffer: b, action: 'leave' }
    default:
      // escape (the shell interrupts), tab (pane cycling), pageup / pagedown, f2, unknown
      return null
  }
}

const spaces = (n: number): string => ' '.repeat(Math.max(0, n))

export function Composer(props: ComposerProps) {
  const env = useTuiEnv()
  const ascii = asciiOnly(env)
  const bufRef = useRef<TextBuffer>(EMPTY_BUFFER)
  const [buffer, setBuffer] = useState<TextBuffer>(EMPTY_BUFFER)
  const propsRef = useRef(props)
  propsRef.current = props

  useFocusHandler(
    'composer',
    (e) => {
      const p = propsRef.current
      const r = composerReduce(bufRef.current, e, p.mode)
      if (!r) return false
      if (r.buffer !== bufRef.current) {
        bufRef.current = r.buffer
        setBuffer(r.buffer)
      }
      if (r.action === 'submit' && r.submitted) p.onSubmit(r.submitted)
      else if (r.action === 'palette') p.onOpenPalette('/')
      else if (r.action === 'leave') p.onLeave()
      return true
    },
    props.focused
  )

  const glyph = promptGlyph(props.mode, ascii)
  const promptW = glyph.length + 1
  const textW = Math.max(1, props.width - promptW)
  const accent = toneColor(props.mode === 'readOnly' ? 'dim' : 'accent', env)
  const dim = toneColor('dim', env)
  const reason = props.mode === 'readOnly' && props.disabledReason ? sanitizeTty(props.disabledReason).replace(/\n/g, ' ') : ''

  if (buffer.text === '') {
    const placeholder = sanitizeTty(props.placeholder ?? '').replace(/\n/g, ' ')
    return (
      <Box flexDirection="column" width={props.width}>
        <Box>
          <Text color={accent}>{glyph} </Text>
          {props.focused ? <Text inverse> </Text> : null}
          <Text dimColor color={dim} wrap="truncate-end">
            {placeholder}
          </Text>
        </Box>
        {reason ? (
          <Text dimColor color={dim} wrap="truncate-end">
            {reason}
          </Text>
        ) : null}
      </Box>
    )
  }

  const rows = wrapBuffer(buffer, textW)
  let cursorRow = rows.findIndex((r) => r.cursorAt !== undefined)
  if (cursorRow < 0) cursorRow = rows.length - 1
  const first = Math.max(0, Math.min(cursorRow - COMPOSER_MAX_ROWS + 1, rows.length - COMPOSER_MAX_ROWS))
  const shown = rows.slice(first, first + COMPOSER_MAX_ROWS)

  return (
    <Box flexDirection="column" width={props.width}>
      {shown.map((row, i) => {
        const lead = first + i === 0 ? `${glyph} ` : spaces(promptW)
        const at = props.focused ? row.cursorAt : undefined
        let line: ReactNode
        if (at === undefined) {
          line = <Text wrap="truncate-end">{row.cells.join('')}</Text>
        } else {
          const before = row.cells.slice(0, at).join('')
          const under = row.cells[at] ?? ' '
          const after = row.cells.slice(at + 1).join('')
          line = (
            <Text wrap="truncate-end">
              {before}
              <Text inverse>{graphemeWidth(under) === 0 ? ' ' : under}</Text>
              {after}
            </Text>
          )
        }
        return (
          <Box key={first + i}>
            <Text color={first + i === 0 ? accent : undefined}>{lead}</Text>
            {line}
          </Box>
        )
      })}
      {reason ? (
        <Text dimColor color={dim} wrap="truncate-end">
          {reason}
        </Text>
      ) : null}
    </Box>
  )
}
