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
import { PaneLines, cutSegs, navKey, segText, styleFor, type PaneLine, type Seg } from './panes/lines'
import { sliceToWidth, textWidth, wrapText } from './panes/text'

interface RowStyle {
  prefix: string
  continuation: string
  tone?: Tone
  /** A status/marker tone for the leading glyph, separate from prose. */
  prefixTone?: Tone
  prefixSegs?: Seg[]
  continuationSegs?: Seg[]
  /** null deliberately keeps the body on the neutral foreground. */
  bodyTone?: Tone | null
  /** Explicit non-dim row tones are status text for system rows, not prose decoration. */
  bodyStatus?: boolean
  bodyDim?: boolean
  bodyBold?: boolean
  dim?: boolean
  bold?: boolean
}

function hanging(prefix: string): string {
  return ' '.repeat(textWidth(prefix))
}

function promptMark(env: TuiEnv): string {
  return env.unicode && !env.screenReader && !env.dumbTerminal ? '›' : '>'
}

function style(prefix: string, over: Omit<RowStyle, 'prefix' | 'continuation'> = {}, continuation = hanging(prefix)): RowStyle {
  return { prefix, continuation, ...over }
}

function prefixParts(row: RowStyle, first: boolean, raw: string, width: number, env: TuiEnv): Seg[] {
  if (!raw) return []
  const parts = first ? row.prefixSegs : row.continuationSegs
  if (parts) return fitSegments(parts, Math.min(width, textWidth(raw)))
  return [{ text: raw, tone: row.prefixTone ?? row.tone, dim: row.dim, bold: row.bold }]
}

/** Prefixes are structural markers: preserve their visible glyph before adding an ellipsis. */
function fitSegments(parts: Seg[], width: number): Seg[] {
  let remaining = Math.max(0, Math.floor(width))
  const out: Seg[] = []
  for (const part of parts) {
    if (remaining <= 0) break
    const text = sliceToWidth(part.text, remaining)
    if (text) out.push({ ...part, text })
    remaining -= textWidth(text)
  }
  return out
}

function bodyPart(row: RowStyle, text: string): Seg {
  const statusTone = row.bodyStatus && row.tone && row.tone !== 'dim' ? row.tone : undefined
  return {
    text,
    tone: statusTone ?? (row.bodyTone === null ? undefined : row.bodyTone ?? row.tone),
    dim: row.bodyDim ?? row.dim,
    bold: row.bodyBold ?? row.bold
  }
}

function prefixWithLabel(marker: string, agent: string, suffix = ''): Seg[] {
  const out: Seg[] = []
  if (marker) out.push({ text: marker })
  if (agent) out.push({ text: agent, tone: 'identity', bold: true })
  if (suffix) out.push({ text: suffix })
  return out
}

/** Prefix and tone per row kind. */
export function rowStyle(row: TranscriptRow, env: TuiEnv): RowStyle {
  const g = glyphs(env)
  const label = row.agentLabel ? `${row.agentLabel}: ` : ''
  let s: RowStyle
  switch (row.kind) {
    case 'user':
      s = style(env.screenReader ? 'you: ' : `${promptMark(env)} `, {
        prefixSegs: [{ text: env.screenReader ? 'you: ' : `${promptMark(env)} `, tone: 'accent', bold: true }],
        bodyTone: null
      })
      break
    case 'text':
      s = style(env.screenReader ? label || 'assistant: ' : `${g.bullet} ${label}`, {
        prefixSegs: env.screenReader
          ? prefixWithLabel('', label || 'assistant: ')
          : prefixWithLabel(`${g.bullet} `, label),
        continuationSegs: [{ text: '  ' }],
        bodyTone: null
      }, '  ')
      break
    case 'thinking':
      s = style(row.agentLabel ? `${row.agentLabel} (thinking): ` : '(thinking) ', {
        prefixSegs: row.agentLabel
          ? [{ text: row.agentLabel, tone: 'identity', bold: true }, { text: ' (thinking): ', dim: true }]
          : [{ text: '(thinking) ', dim: true }],
        continuationSegs: [{ text: '  ', dim: true }],
        bodyTone: null,
        bodyDim: true,
        dim: true
      })
      break
    case 'tool':
      s = style(env.screenReader ? `${label}tool: ` : `${g.arrow} ${label}`, {
        prefixSegs: env.screenReader
          ? [...prefixWithLabel('', label), { text: 'tool: ', tone: 'code' }]
          : [...prefixWithLabel(`${g.arrow} `, label),],
        continuationSegs: [{ text: '  ' }],
        bodyTone: 'code'
      }, '  ')
      if (!env.screenReader) s.prefixSegs = s.prefixSegs?.map((seg, i) => i === 0 ? { ...seg, tone: 'code' } : seg)
      break
    case 'result':
      s = style(env.screenReader ? 'result: ' : `${g.lastBranch} `, {
        prefixSegs: [{ text: env.screenReader ? 'result: ' : `${g.lastBranch} `, tone: 'muted' }],
        bodyTone: 'muted'
      })
      break
    case 'error':
      s = style(env.screenReader ? `${label}error: ` : `${g.cross} ${label}`, {
        prefixSegs: env.screenReader
          ? [...prefixWithLabel('', label), { text: 'error: ', tone: 'danger' }]
          : [{ text: `${g.cross} `, tone: 'danger' }, ...prefixWithLabel('', label)],
        bodyTone: null
      })
      break
    case 'divider':
      s = style('', { bodyTone: 'muted', dim: true })
      break
    case 'system':
    case 'harness':
    case 'log':
    default:
      s = style('', { bodyTone: 'muted', bodyStatus: true, dim: true })
      break
  }
  if (row.tone) {
    s.tone = row.tone
    if (row.tone !== 'dim') s.dim = false
  }
  return s
}

interface DisplayLine {
  text: string
  style: RowStyle
  segs?: Seg[]
}

/** A small terminal-safe Markdown subset. Unmatched markup stays literal. */
function inlineMarkup(text: string): Seg[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map(part =>
    part.startsWith('`') && part.endsWith('`') ? { text: part.slice(1, -1), tone: 'code' as const }
      : part.startsWith('**') && part.endsWith('**') ? { text: part.slice(2, -2), bold: true }
        : { text: part })
}

function markdownLines(text: string, base: RowStyle, width: number, env: TuiEnv): DisplayLine[] {
  if (text.split('\n').filter(line => /^\s*```/.test(line)).length % 2 !== 0) return hangingLines(text, base, width, env)
  const out: DisplayLine[] = []
  let code = false
  let first = true
  for (const raw of text.split('\n')) {
    const fence = /^\s*```(.*)$/.exec(raw)
    if (fence) {
      code = !code
      if (code) out.push(...hangingLines(fence[1].trim() || 'code', style(first ? base.prefix : '  ', { tone: 'code', bodyTone: 'code' }), width, env))
      first = false
      continue
    }
    if (code) {
      out.push(...hangingLines(raw, style(env.screenReader ? '  ' : `  ${glyphs(env).v} `, { tone: 'code', bodyTone: 'code' }, '    '), width, env))
      first = false
      continue
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(raw)
    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(raw)
    const line = heading?.[1] ?? (bullet ? `${bullet[1]}${env.screenReader ? '-' : glyphs(env).bullet} ${bullet[2]}` : raw)
    const prefix = first ? base.prefix : '  '
    const spans = inlineMarkup(line)
    const visible = spans.map(s => s.text).join('')
    const formatted = hangingLines(visible, style(prefix, {
      tone: base.tone,
      dim: base.dim,
      bold: !!heading,
      prefixSegs: prefix === base.prefix ? base.prefixSegs : undefined,
      continuationSegs: base.continuationSegs,
      bodyTone: base.bodyTone,
      bodyDim: base.bodyDim,
      bodyBold: !!heading
    }, '  '), width, env)
    let offset = 0
    for (const l of formatted) {
      const lead = l.text.startsWith(prefix) ? prefix : '  '
      const body = l.text.slice(lead.length)
      const found = visible.indexOf(body, offset)
      const start = found < 0 ? offset : found
      let pos = 0
      const leadParts = lead === base.prefix && prefix === base.prefix
        ? base.prefixSegs ?? [{ text: lead, tone: base.prefixTone ?? base.tone, dim: base.dim }]
        : base.continuationSegs ?? [{ text: lead }]
      const segs: Seg[] = [...fitSegments(leadParts, textWidth(lead))]
      for (const span of spans) {
        const end = pos + span.text.length
        const from = Math.max(start, pos), to = Math.min(start + body.length, end)
        if (to > from) segs.push({ ...span, text: span.text.slice(from - pos, to - pos), bold: !!heading || span.bold })
        pos = end
      }
      out.push({ ...l, segs })
      offset = start + body.length
    }
    first = false
  }
  return out
}

/** Prefix each wrapped line while keeping the body aligned below the first line's text. */
function hangingLines(text: string, row: RowStyle, width: number, env: TuiEnv): DisplayLine[] {
  const w = Math.floor(width)
  if (w <= 0) return []
  const out: DisplayLine[] = []
  let first = true
  for (const logical of text.split('\n')) {
    const prefix = first ? row.prefix : row.continuation
    const available = w - textWidth(prefix)
    if (available <= 0) {
      const clipped = sliceToWidth(prefix, w)
      out.push({ text: clipped, style: row, segs: prefixParts(row, first, clipped, w, env) })
      first = false
      // A long label may not fit at all in a narrow pane. Keep its marker, then emit the body with the
      // continuation prefix (or no prefix when even that is wider than the pane) instead of dropping it.
      const bodyPrefix = textWidth(row.continuation) < w ? row.continuation : ''
      const bodyWidth = Math.max(1, w - textWidth(bodyPrefix))
      for (const part of wrapText(logical, bodyWidth)) {
        out.push({ text: bodyPrefix + part, style: row, segs: [...prefixParts(row, false, bodyPrefix, w, env), bodyPart(row, part)] })
      }
      continue
    }
    for (const part of wrapText(logical, available)) {
      const currentPrefix = first ? row.prefix : row.continuation
      out.push({ text: currentPrefix + part, style: row, segs: [...prefixParts(row, first, currentPrefix, w, env), bodyPart(row, part)] })
      first = false
    }
  }
  return out
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
export function rowLines(row: TranscriptRow, width: number, env: TuiEnv): DisplayLine[] {
  const style = rowStyle(row, env)
  if (row.kind === 'divider') return [{ text: dividerLine(row.text, width, env), style }]
  if (row.kind === 'text' && /^#{1,6}\s|```|`[^`]+`|\*\*[^*]+\*\*|^\s*[-*+]\s/m.test(row.text)) return markdownLines(row.text, style, width, env)
  return hangingLines(row.text, style, width, env)
}

function partialLines(p: PartialRow, width: number, env: TuiEnv): DisplayLine[] {
  const g = glyphs(env)
  const prefix = env.screenReader ? `${p.agentLabel}: ` : `${g.bullet} ${p.agentLabel}: `
  const prefixSegs = env.screenReader
    ? [{ text: `${p.agentLabel}: `, tone: 'identity' as const, bold: true }]
    : [{ text: `${g.bullet} ` }, { text: `${p.agentLabel}: `, tone: 'identity' as const, bold: true }]
  return hangingLines(p.text, style(prefix, { prefixSegs, continuationSegs: [{ text: '  ' }], bodyTone: 'muted' }, '  '), width, env)
}

export interface Built {
  lines: PaneLine[]
  /** First line index of each row key. */
  starts: Map<string, number>
  /** Row key per line (for keeping the scroll anchor). */
  rowOfLine: string[]
}

/** Wrapped lines per row key, kept while width and env stay the same (issue #35 M1: an appended row re-wraps nothing else). */
export interface RowCache {
  width: number
  env: TuiEnv
  rows: Map<string, { row: TranscriptRow; lines: DisplayLine[] }>
}

const sameRow = (a: TranscriptRow, b: TranscriptRow): boolean =>
  a.kind === b.kind && a.text === b.text && a.tone === b.tone && a.agentLabel === b.agentLabel

export function build(rows: readonly TranscriptRow[], omitted: number, width: number, env: TuiEnv, cache?: RowCache): Built {
  if (cache && (cache.width !== width || cache.env !== env)) {
    cache.width = width
    cache.env = env
    cache.rows.clear()
  }
  const seen = new Set<string>()
  const lines: PaneLine[] = []
  const starts = new Map<string, number>()
  const rowOfLine: string[] = []
  if (omitted > 0) {
    lines.push({ key: 'omitted', segs: cutSegs([{ text: omittedLabel(omitted), dim: true }], width, env) })
    rowOfLine.push('')
  }
  let previous: TranscriptRow | undefined
  for (const row of rows) {
    starts.set(row.key, lines.length)
    if (previous && row.kind === 'user' && previous.kind !== 'divider') {
      lines.push({ key: `${row.key}:gap`, segs: [] })
      rowOfLine.push(row.key)
    }
    let wrapped = cache?.rows.get(row.key)
    if (!wrapped || !sameRow(wrapped.row, row)) {
      wrapped = { row, lines: rowLines(row, width, env) }
      cache?.rows.set(row.key, wrapped)
    }
    seen.add(row.key)
    wrapped.lines.forEach((l, i) => {
      lines.push({ key: `${row.key}:${i}`, segs: l.segs ?? [{ text: l.text, tone: l.style.tone, dim: l.style.dim, bold: l.style.bold }] })
      rowOfLine.push(row.key)
    })
    previous = row
  }
  if (cache) for (const k of [...cache.rows.keys()]) if (!seen.has(k)) cache.rows.delete(k)
  return { lines, starts, rowOfLine }
}

interface Anchor {
  /** The row at the top of the view and the line within it. */
  key: string
  offset: number
  /** The newest row key when the user scrolled up, for "N new rows below". */
  lastSeen: string | undefined
}

/** Only contiguous completed tool activity is folded; failures and unfinished work stay visible. */
export function groupToolRows(rows: TranscriptRow[], expanded = false): TranscriptRow[] {
  if (expanded) return rows
  const out: TranscriptRow[] = []
  for (let i = 0; i < rows.length;) {
    const start = i
    const row = rows[i]!
    if (row.kind !== 'tool' && row.kind !== 'result') { out.push(row); i++; continue }
    while (i < rows.length && (rows[i].kind === 'tool' || rows[i].kind === 'result') && rows[i].agentId === row.agentId && rows[i].runId === row.runId) i++
    const group = rows.slice(start, i)
    const calls = group.filter(r => r.kind === 'tool')
    const results = group.filter(r => r.kind === 'result')
    const paired = calls.every(call => call.toolUseId)
      ? calls.every(call => results.some(result => result.toolUseId === call.toolUseId))
      : group.every((item, at) => item.kind === (at % 2 === 0 ? 'tool' : 'result'))
    if (group.length >= 3 && group.at(-1)?.kind === 'result' && calls.length === results.length && paired) {
      out.push({ ...row, text: `${calls.length} tool calls completed · Enter expands`, kind: 'tool' })
    } else out.push(...group)
  }
  return out
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
  const [toolsExpanded, setToolsExpanded] = useState(false)
  const grouped = useMemo(() => groupToolRows(props.rows, toolsExpanded), [props.rows, toolsExpanded])

  const rowCache = useRef<RowCache>({ width, env, rows: new Map() })
  const built = useMemo(() => build(grouped, props.omitted ?? 0, width, env, rowCache.current), [grouped, props.omitted, width, env])
  const partial: PaneLine[] = []
  for (const p of props.partials) {
    partialLines(p, width, env).forEach((line, i) => partial.push({
      key: `partial:${p.key}:${i}`,
      segs: line.segs ?? [{ text: line.text, tone: line.style.tone, dim: line.style.dim, bold: line.style.bold }]
    }))
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
      if (e.type === 'key' && e.name === 'enter' && !e.ctrl && !e.alt && props.rows.some(r => r.kind === 'tool')) {
        setToolsExpanded(v => !v)
        setAnchor(undefined)
        anchorRef.current = undefined
        return true
      }
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
    if (w.items.length && row.kind === 'user' && w.items.at(-1)?.kind !== 'divider') {
      w.items.push({ key: `${row.key}:gap`, runId: row.runId, kind: 'system', text: '' })
    }
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
              <Text key={i} {...styleFor({ tone: l.style.tone, dim: l.style.dim, bold: l.style.bold }, env)}>
                {l.segs ? l.segs.map((s, j) => <Text key={j} {...styleFor(s, env)}>{s.text}</Text>) : l.text || ' '}
              </Text>
            )
          )}
        </Box>
      )}
    </Static>
  )
}

