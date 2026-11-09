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
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { styleFor } from './panes/lines'
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
import { textWidth, truncateEnd } from './panes/text'
import { sanitizeTty } from './sanitizeTty'
import { asciiOnly, composerSurface, toneColor } from './theme'
import type { ComposerMode, ComposerProps, InputEvent } from './types'

/** At most this many text rows are visible; the view scrolls to keep the cursor's row shown. */
export const COMPOSER_MAX_ROWS = 6
/** The cursor when colour is off (an inverse cell would be invisible); ASCII-safe. */
export const CURSOR_GLYPH = '|'

const PROMPT_UNICODE: Record<ComposerMode, string> = { start: '›', send: '›', continue: '›', quick: '›', readOnly: '·' }
const PROMPT_ASCII: Record<ComposerMode, string> = { start: '>', send: '>', continue: '>', quick: '>', readOnly: '--' }

/** Optional view-only affordances used by the full-screen composer. Kept local so the input contract stays stable. */
export type ComposerViewProps = ComposerProps & { height?: number; maxHeight?: number; hints?: string; animated?: boolean; working?: boolean; cursorVisible?: boolean; showFooter?: boolean; onDraftChange?(text: string): void }

export function promptGlyph(mode: ComposerMode, ascii: boolean): string {
  return (ascii ? PROMPT_ASCII : PROMPT_UNICODE)[mode] ?? '>'
}

function defaultHints(mode: ComposerMode): string {
  return mode === 'readOnly' ? 'Read only · Esc interrupts' : 'Enter sends · Alt+Enter newline · / commands'
}

/** Applies one input event; returns the new buffer and what happened, or null when the event is not the Composer's. */
export function composerReduce(
  b: TextBuffer,
  e: InputEvent,
  mode: ComposerMode,
  canHelp = false
): { buffer: TextBuffer; action?: 'submit' | 'palette' | 'leave' | 'help'; submitted?: string } | null {
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
      // A lone `?` on an empty composer shows the composer's keys (when the shell can); with text it is a character.
      if (ch === '?' && b.text === '' && canHelp) return { buffer: b, action: 'help' }
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

export function Composer(props: ComposerViewProps) {
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
      const r = composerReduce(bufRef.current, e, p.mode, p.onHelp !== undefined)
      if (!r) return false
      if (r.buffer !== bufRef.current) {
        bufRef.current = r.buffer
        p.onDraftChange?.(r.buffer.text)
        setBuffer(r.buffer)
      }
      if (r.action === 'submit' && r.submitted) p.onSubmit(r.submitted)
      else if (r.action === 'palette') p.onOpenPalette('/')
      else if (r.action === 'help') p.onHelp?.()
      else if (r.action === 'leave') p.onLeave()
      return true
    },
    props.focused
  )

  const showFooter = props.showFooter !== false
  const width = Math.max(0, Math.floor(props.width))
  const requestedHeight = props.height === undefined ? undefined : Math.max(0, Math.floor(props.height))
  const maxHeight = props.maxHeight === undefined ? undefined : Math.max(0, Math.floor(props.maxHeight))
  const glyph = promptGlyph(props.mode, ascii)
  const autoFullscreen = requestedHeight === undefined && env.bufferMode === 'fullscreen'
  const autoBand = autoFullscreen && (maxHeight === undefined || maxHeight >= 3)
  const explicitBand = requestedHeight !== undefined && requestedHeight >= 3 && (maxHeight === undefined || maxHeight >= 3)
  const inline = requestedHeight === 1
  const inset = explicitBand || autoBand ? (width >= 20 ? 2 : width >= 8 ? 1 : 0) : 0
  const contentWidth = Math.max(1, width - inset * 2)
  const promptW = Math.min(textWidth(glyph) + 1, Math.max(0, contentWidth - 1))
  // With colour off an inverse cell would be invisible, so the cursor is a glyph and one column is kept for it.
  const cursorFocused = props.focused && props.cursorVisible !== false
  const markCursor = !env.color && cursorFocused
  const textW = Math.max(1, contentWidth - promptW - (markCursor ? 1 : 0))
  const dim = styleFor({ tone: 'dim' }, env)
  const reason = props.mode === 'readOnly' && props.disabledReason ? sanitizeTty(props.disabledReason).replace(/\n/g, ' ') : ''
  const placeholder = (inline && reason ? reason : sanitizeTty(props.placeholder ?? '')).replace(/\n/g, ' ')
  const rows = buffer.text === '' ? [] : wrapBuffer(buffer, textW)
  const autoHeight = autoFullscreen ? (showFooter ? 4 : 2) + Math.min(COMPOSER_MAX_ROWS, Math.max(1, rows.length)) : undefined
  const unclampedHeight = requestedHeight ?? autoHeight
  const layoutHeight = unclampedHeight === undefined || maxHeight === undefined ? unclampedHeight : Math.min(unclampedHeight, maxHeight)
  const band = layoutHeight !== undefined && layoutHeight >= 3 && width >= 3 && (explicitBand || autoBand)
  const surface = band ? composerSurface(env) : {}
  const footerGap = showFooter && band && layoutHeight !== undefined && layoutHeight >= 5 ? 1 : 0
  const surfaceHeight = band && layoutHeight !== undefined ? Math.max(1, layoutHeight - (showFooter ? 1 : 0) - footerGap) : 0
  const bodyViewport = band
    ? Math.max(1, Math.min(COMPOSER_MAX_ROWS, surfaceHeight, Math.max(1, rows.length)))
    : Math.max(1, Math.min(COMPOSER_MAX_ROWS, (layoutHeight ?? COMPOSER_MAX_ROWS) - (!inline && reason && layoutHeight !== undefined ? 1 : 0)))
  const paddingTop = band && surfaceHeight > bodyViewport ? 1 : 0
  const paddingBottom = Math.max(0, surfaceHeight - bodyViewport - paddingTop)
  let cursorRow = rows.findIndex((r) => r.cursorAt !== undefined)
  if (cursorRow < 0) cursorRow = rows.length > 0 ? rows.length - 1 : 0
  const first = Math.max(0, Math.min(cursorRow - bodyViewport + 1, rows.length - bodyViewport))
  const shown = rows.slice(first, first + bodyViewport)
  // A fixed-height band is part of the layout contract, while bare/inline composition reports only the rows it draws.
  const drawnRows = layoutHeight !== undefined ? layoutHeight : (buffer.text === '' ? 1 : shown.length) + (reason ? 1 : 0)
  const reported = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (reported.current === drawnRows) return
    reported.current = drawnRows
    propsRef.current.onRows?.(drawnRows)
  })

  // The slash palette has its own query line: keep the composer draft and its reserved rows, but draw no second input.
  if (props.hidden) return <Box width={width} height={drawnRows} />
  if (width === 0 || layoutHeight === 0) return <Box width={0} height={layoutHeight === 0 ? 0 : undefined} />

  const surfaceText = surface.color ? { color: surface.color } : {}
  const hintStyle = styleFor({ tone: 'muted' }, env)
  const promptStyle = styleFor({ tone: props.focused && props.mode !== 'readOnly' ? 'accent' : 'muted', bold: true }, env)
  const rowView = (row: (typeof rows)[number] | undefined, absoluteRow: number): ReactNode => {
    const lead = absoluteRow === 0 ? `${glyph} `.slice(0, promptW) : spaces(promptW)
    const at = cursorFocused ? row?.cursorAt : undefined
    const prompt = <Text {...promptStyle}>{lead}</Text>
    if (!row) {
      const hint = truncateEnd(placeholder, Math.max(0, textW), ascii ? '...' : '…')
      return (
        <Box key={absoluteRow} width={contentWidth} height={1} flexShrink={0} overflow="hidden">
          {prompt}
          {absoluteRow === 0 && cursorFocused ? (
            markCursor ? <Text {...surfaceText}>{CURSOR_GLYPH}</Text> : <Text {...surfaceText} backgroundColor={surface.backgroundColor} inverse={env.color}> </Text>
          ) : null}
          {absoluteRow === 0 ? <Text {...hintStyle} wrap="truncate-end">{hint}</Text> : null}
        </Box>
      )
    }
    let line: ReactNode
    if (at === undefined) {
      line = <Text {...surfaceText} wrap="truncate-end">{row.cells.join('')}</Text>
    } else {
      const before = row.cells.slice(0, at).join('')
      const under = row.cells[at] ?? ' '
      const after = row.cells.slice(at + 1).join('')
      line = markCursor ? (
        <Text {...surfaceText} wrap="truncate-end">
          {before}
          {CURSOR_GLYPH}
          {row.cells[at] === undefined ? '' : under}
          {after}
        </Text>
      ) : (
        <Text {...surfaceText} wrap="truncate-end">
          {before}
          <Text {...surfaceText} backgroundColor={surface.backgroundColor} inverse={env.color}>{graphemeWidth(under) === 0 ? ' ' : under}</Text>
          {after}
        </Text>
      )
    }
    return (
      <Box key={absoluteRow} width={contentWidth} height={1} flexShrink={0} overflow="hidden">
        {prompt}
        {line}
      </Box>
    )
  }

  const bodyRows = band
    ? Array.from({ length: bodyViewport }, (_, i) => rowView(shown[i], first + i))
    : rows.length > 0
      ? shown.map((row, i) => rowView(row, first + i))
      : [rowView(undefined, 0)]
  if (inline) return <Box flexDirection="column" width={width}>{bodyRows[0]}</Box>

  if (!band) {
    return (
      <Box flexDirection="column" width={width} height={layoutHeight} overflow="hidden" flexShrink={0}>
        {bodyRows}
        {reason && showFooter ? <Text {...dim} wrap="truncate-end">{reason}</Text> : null}
      </Box>
    )
  }

  const rawFooter = reason || sanitizeTty(props.hints ?? defaultHints(props.mode)).replace(/\n/g, ' ')
  const footer = env.screenReader ? rawFooter.replace(/·/g, ', ') : ascii ? rawFooter.replace(/·/g, ' | ') : rawFooter
  return (
    <Box flexDirection="column" width={width} height={layoutHeight} overflow="hidden">
      <Box flexDirection="column" width={width} height={surfaceHeight} paddingX={inset} paddingTop={paddingTop} paddingBottom={paddingBottom} backgroundColor={surface.backgroundColor} flexShrink={0} overflow="hidden">
        {bodyRows}
      </Box>
      {footerGap ? <Box height={footerGap} flexShrink={0} /> : null}
      {showFooter ? <Box width={width} height={1} paddingX={inset} flexShrink={0} overflow="hidden">
        <Text color={toneColor('muted', env)} wrap="truncate-end">{truncateEnd(footer, contentWidth, ascii ? '...' : '…')}</Text>
      </Box> : null}
    </Box>
  )
}
