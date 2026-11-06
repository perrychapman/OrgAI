/**
 * The transcript pane (W4-T3, cli-spec 5.1). Rows and partials arrive sanitized (cli-spec 5.2).
 *
 * Full-screen: a window over the rows wrapped to the width, pinned to the bottom unless the user scrolled up (then the
 * view stays on the same row while new rows arrive, and the last line says how many are below). Streaming partials
 * show dim after the rows. Inline: every committed row is written once into the terminal's scrollback through Ink's
 * <Static>, keyed by row.key: a row whose key was already written is never written again (a resync that sends the
 * same rows again writes nothing), and partials are not shown at all.
 */
import { Box, Static, Text } from 'ink'
import { useMemo, useRef, useState } from 'react'
import { omittedLabel } from '../../shared/view/transcriptRows'
import { useFocusHandler, useTuiEnv } from './context'
import { glyphs } from './theme'
import type { BufferMode, PartialRow, Tone, TranscriptPaneProps, TranscriptRow, TuiEnv } from './types'
import { PaneLines, cutSegs, navKey, segText, styleFor, type PaneLine } from './panes/lines'
import { textWidth, wrapText } from './panes/text'

interface RowStyle {
  prefix: string
  tone?: Tone
  dim?: boolean
}

/** Prefix and tone per row kind. */
export function rowStyle(row: TranscriptRow, env: TuiEnv): RowStyle {
  const g = glyphs(env)
  const label = row.agentLabel ? `${row.agentLabel}: ` : ''
  let s: RowStyle
  switch (row.kind) {
    case 'user':
      s = { prefix: 'you: ', tone: 'accent' }
      break
    case 'text':
      s = { prefix: label }
      break
    case 'thinking':
      s = { prefix: row.agentLabel ? `${row.agentLabel} (thinking): ` : '(thinking) ', dim: true }
      break
    case 'tool':
      s = { prefix: env.screenReader ? `${label}tool: ` : `${g.arrow} ${label}`, dim: true }
      break
    case 'result':
      s = { prefix: env.screenReader ? 'result: ' : '  ', dim: true }
      break
    case 'error':
      s = { prefix: env.screenReader ? `${label}error: ` : `${g.cross} ${label}`, tone: 'danger' }
      break
    case 'divider':
      s = { prefix: '', dim: true }
      break
    case 'system':
    case 'harness':
    case 'log':
    default:
      s = { prefix: '', dim: true }
      break
  }
  if (row.tone) {
    s.tone = row.tone
    if (row.tone !== 'dim') s.dim = false
  }
  return s
}

/** A divider row as a full-width rule with its text ("── Continued 3 min later ─────"). */
export function dividerLine(text: string, width: number, env: TuiEnv): string {
  const h = glyphs(env).h
  if (width <= 0) return ''
  const label = text ? ` ${text} ` : ''
  const lead = h.repeat(2)
  const used = textWidth(lead) + textWidth(label)
  if (used >= width) return segText(cutSegs([{ text: `${lead}${label}` }], width, env))
  return lead + label + h.repeat(width - used)
}

/** The display lines of one row at `width`: the prefix on the first line, each logical line wrapped. */
export function rowLines(row: TranscriptRow, width: number, env: TuiEnv): { text: string; style: RowStyle }[] {
  const style = rowStyle(row, env)
  if (row.kind === 'divider') return [{ text: dividerLine(row.text, width, env), style }]
  return wrapText(`${style.prefix}${row.text}`, width).map((text) => ({ text, style }))
}

function partialLines(p: PartialRow, width: number): string[] {
  return wrapText(`${p.agentLabel}: ${p.text}`, width)
}

interface Built {
  lines: PaneLine[]
  /** First line index of each row key. */
  starts: Map<string, number>
  /** Row key per line (for keeping the scroll anchor). */
  rowOfLine: string[]
}

function build(rows: readonly TranscriptRow[], omitted: number, width: number, env: TuiEnv): Built {
  const lines: PaneLine[] = []
  const starts = new Map<string, number>()
  const rowOfLine: string[] = []
  if (omitted > 0) {
    lines.push({ key: 'omitted', segs: cutSegs([{ text: omittedLabel(omitted), dim: true }], width, env) })
    rowOfLine.push('')
  }
  for (const row of rows) {
    starts.set(row.key, lines.length)
    rowLines(row, width, env).forEach((l, i) => {
      lines.push({ key: `${row.key}:${i}`, segs: [{ text: l.text, tone: l.style.tone, dim: l.style.dim }] })
      rowOfLine.push(row.key)
    })
  }
  return { lines, starts, rowOfLine }
}

interface Anchor {
  /** The row at the top of the view and the line within it. */
  key: string
  offset: number
  /** The newest row key when the user scrolled up, for "N new rows below". */
  lastSeen: string | undefined
}

export function TranscriptPane(props: TranscriptPaneProps & { mode: BufferMode }) {
  if (props.mode === 'inline') return <InlineTranscript rows={props.rows} width={props.width} />
  return <FullTranscript {...props} />
}

function FullTranscript(props: TranscriptPaneProps) {
  const env = useTuiEnv()
  const width = Math.max(0, Math.floor(props.width))
  const height = Math.max(0, Math.floor(props.height))
  const [anchor, setAnchor] = useState<Anchor | undefined>(undefined)

  const built = useMemo(() => build(props.rows, props.omitted ?? 0, width, env), [props.rows, props.omitted, width, env])
  const partial: PaneLine[] = []
  for (const p of props.partials) {
    partialLines(p, width).forEach((text, i) => partial.push({ key: `partial:${p.key}:${i}`, segs: [{ text, dim: true }] }))
  }
  const lines = [...built.lines, ...partial]
  const total = lines.length

  const lastKey = props.rows[props.rows.length - 1]?.key
  const newBelow = (() => {
    if (!anchor) return 0
    if (anchor.lastSeen === undefined) return props.rows.length
    const i = props.rows.findIndex((r) => r.key === anchor.lastSeen)
    return i < 0 ? props.rows.length : props.rows.length - 1 - i
  })()

  // Scrolled up: one line is taken by the "below" notice.
  const viewH = anchor ? Math.max(0, height - 1) : height
  const maxTop = Math.max(0, total - viewH)
  const anchoredTop = anchor ? (built.starts.get(anchor.key) ?? 0) + anchor.offset : maxTop
  const top = Math.max(0, Math.min(anchoredTop, maxTop))

  // Several keys can arrive before the next render: the handler works on refs and renders from state.
  const topRef = useRef(top)
  topRef.current = top
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor

  const anchorAt = (t: number): Anchor | undefined => {
    const h = Math.max(0, height - 1)
    if (t >= Math.max(0, total - h)) return undefined
    const key = built.rowOfLine[t] ?? ''
    const start = key ? (built.starts.get(key) ?? 0) : 0
    return { key, offset: t - start, lastSeen: anchorRef.current ? anchorRef.current.lastSeen : lastKey }
  }

  useFocusHandler(
    props.focusTarget ?? 'transcript',
    (e) => {
      if (props.extraKeys?.(e)) return true
      const k = navKey(e)
      if (!k) return false
      const cur = topRef.current
      const page = Math.max(1, height - 2)
      let next: number | undefined
      switch (k) {
        case 'up':
          next = Math.max(0, cur - 1)
          break
        case 'down':
          next = cur + 1
          break
        case 'pageup':
          next = Math.max(0, cur - page)
          break
        case 'pagedown':
          next = cur + page
          break
        case 'home':
          next = 0
          break
        case 'end':
          next = undefined
          break
      }
      const a = next === undefined ? undefined : anchorAt(next)
      anchorRef.current = a
      topRef.current = a && next !== undefined ? next : Math.max(0, total - height)
      setAnchor(a)
      return true
    },
    props.focused
  )

  const view = lines.slice(top, top + viewH)
  if (anchor && height > 0) {
    const text = newBelow > 0 ? `${newBelow} new ${newBelow === 1 ? 'row' : 'rows'} below; End to jump` : 'More below; End to jump'
    view.push({ key: 'below', segs: cutSegs([{ text, tone: 'warn' }], width, env) })
  }
  return <PaneLines width={width} height={height} lines={view} env={env} />
}

function InlineTranscript(props: { rows: TranscriptRow[]; width: number }) {
  const env = useTuiEnv()
  const written = useRef<{ keys: Set<string>; items: TranscriptRow[] }>({ keys: new Set(), items: [] })
  const w = written.current
  for (const row of props.rows) {
    if (w.keys.has(row.key)) continue
    w.keys.add(row.key)
    w.items.push(row)
  }
  // Static writes items from the last index it saw, so it must get a list that only ever grows.
  const items = w.items.slice()
  const width = Math.max(0, Math.floor(props.width))
  return (
    <Static items={items}>
      {(row) => (
        <Box key={row.key} flexDirection="column">
          {(width > 0 ? rowLines(row, width, env) : [{ text: `${rowStyle(row, env).prefix}${row.text}`, style: rowStyle(row, env) }]).map(
            (l, i) => (
              <Text key={i} {...styleFor({ tone: l.style.tone, dim: l.style.dim }, env)}>
                {l.text || ' '}
              </Text>
            )
          )}
        </Box>
      )}
    </Static>
  )
}

