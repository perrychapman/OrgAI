/**
 * Shared pane rendering (W4-T3): a pane is a fixed list of pre-cut lines inside a Box of its exact size, so Ink never
 * wraps or overflows a pane into its neighbour. Styling goes only through theme.ts; with colour off no SGR attribute
 * (colour, dim, inverse, bold) is ever set.
 */
import { Box, Text } from 'ink'
import { Shimmer } from '../Motion'
import { asciiOnly, glyphs, toneColor } from '../theme'
import type { InputEvent, Tone, TuiEnv } from '../types'
import { graphemes, padToWidth, textWidth, truncateEnd } from './text'

export interface Seg {
  text: string
  tone?: Tone
  dim?: boolean
  bold?: boolean
  inverse?: boolean
  shimmer?: boolean
}

/** One pane line: segments laid out left to right, already cut to the pane width by the caller. */
export interface PaneLine {
  key: string
  segs: Seg[]
}

/** A consistent pane heading with a focus cue that survives NO_COLOR. */
export function paneHeading(title: string, width: number, focused: boolean, env: TuiEnv): Seg[] {
  const prefix = focused ? (env.screenReader ? 'Focused: ' : asciiOnly(env) ? '> ' : '› ') : ''
  const label = `${prefix}${title}`
  const rule = env.screenReader ? '' : ` ${glyphs(env).h.repeat(Math.max(0, width - textWidth(label) - 1))}`
  return cutSegs([{ text: label, bold: true, tone: focused ? 'accent' : undefined }, { text: rule, dim: true }], width, env)
}

export interface StyleProps {
  color?: string
  dimColor?: boolean
  bold?: boolean
  inverse?: boolean
}

/** Ink Text props for a segment; nothing at all when colour is off. */
export function styleFor(seg: Omit<Seg, 'text'>, env: TuiEnv): StyleProps {
  if (!env.color || env.screenReader || env.dumbTerminal) return {}
  const out: StyleProps = {}
  const color = toneColor(seg.tone === 'dim' ? undefined : seg.tone, env)
  if (color) out.color = color
  // An explicit semantic foreground already carries its hierarchy; don't dim it a second time.
  if (!color && (seg.dim || seg.tone === 'dim')) out.dimColor = true
  if (seg.bold) out.bold = true
  if (seg.inverse) out.inverse = true
  return out
}

/** The ellipsis glyph for this env. */
export function ellipsisFor(env: TuiEnv): string {
  return glyphs(env).ellipsis
}

/** Cuts a run of segments to `width` columns (the last visible segment ends with the ellipsis). */
export function cutSegs(segs: Seg[], width: number, env: TuiEnv, pad = false): Seg[] {
  const ell = ellipsisFor(env)
  const whole = segs.map((s) => s.text).join('')
  const cut = pad ? padToWidth(whole, width, ell) : truncateEnd(whole, width, ell)
  if (cut === whole) return segs
  // Re-split the cut text over the segments (the cut keeps a grapheme-aligned prefix of `whole`, plus maybe the ellipsis).
  const out: Seg[] = []
  let pos = 0
  const keep = cut.startsWith(whole) ? whole.length : commonPrefix(whole, cut)
  for (const s of segs) {
    if (pos >= keep) break
    const take = s.text.slice(0, Math.max(0, keep - pos))
    if (take) out.push({ ...s, text: take })
    pos += s.text.length
  }
  const tail = cut.slice(keep)
  if (tail) {
    const last = out[out.length - 1] ?? segs[0] ?? { text: '' }
    out.push({ ...last, text: tail })
  }
  return out
}

/** Joined text of segments. */
export function segText(segs: readonly Seg[]): string {
  return segs.map((s) => s.text).join('')
}

/**
 * `left` cut to make room and `right` flush right on one line of `width` columns (one space at least between). When
 * `right` does not fit, only `left` is shown, cut to the width. `fill` styles the padding (e.g. a selection highlight).
 */
export function alignSegs(left: Seg[], right: Seg | undefined, width: number, env: TuiEnv, fill: Omit<Seg, 'text'> = {}): Seg[] {
  const w = Math.max(0, Math.floor(width))
  const rw = right ? textWidth(right.text) : 0
  if (!right || !right.text || rw + 2 > w) {
    const l = cutSegs(left, w, env)
    const pad = w - textWidth(segText(l))
    return pad > 0 && (fill.inverse || fill.tone) ? [...l, { ...fill, text: ' '.repeat(pad) }] : l
  }
  const l = cutSegs(left, w - rw - 1, env)
  const pad = w - textWidth(segText(l)) - rw
  return [...l, { ...fill, text: ' '.repeat(pad) }, right]
}

/** Length (UTF-16 units of `a`) of the grapheme clusters `a` and `b` share from the start, so a cut never lands inside one. */
function commonPrefix(a: string, b: string): number {
  const ga = graphemes(a)
  const gb = graphemes(b)
  let n = 0
  for (let i = 0; i < ga.length && i < gb.length && ga[i] === gb[i]; i++) n += ga[i]!.length
  return n
}

/** Renders lines into a Box of exactly width x height (never more lines than height). */
export function PaneLines(props: { width: number; height: number; lines: PaneLine[]; env: TuiEnv; phase?: number; align?: 'top' | 'bottom' }) {
  const width = Math.max(0, Math.floor(props.width))
  const height = Math.max(0, Math.floor(props.height))
  if (width === 0 || height === 0) return <Box width={width} height={height} />
  const lines = props.lines.slice(0, height)
  return (
    <Box flexDirection="column" justifyContent={props.align === 'bottom' ? 'flex-end' : 'flex-start'} width={width} height={height} overflow="hidden">
      {lines.map((l) => (
        <Text key={l.key} wrap="truncate-end">
          {l.segs.length === 0
            ? ' '
            : l.segs.map((s, i) => (
                <Text key={i} {...styleFor(s, props.env)}>
                  {s.shimmer && !s.inverse ? <Shimmer text={s.text} active={false} phase={props.phase ?? 0} /> : s.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  )
}

/** Scroll navigation keys shared by the panes; undefined for any other event. */
export type NavKey = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end'

export function navKey(e: InputEvent): NavKey | undefined {
  if (e.type !== 'key' || e.ctrl || e.alt) return undefined
  switch (e.name) {
    case 'up':
    case 'down':
    case 'pageup':
    case 'pagedown':
    case 'home':
    case 'end':
      return e.name
    default:
      return undefined
  }
}

/** The new index after a navigation key in a list of `count` items with `page` visible. */
export function moveIndex(index: number, key: NavKey, count: number, page: number): number {
  if (count <= 0) return 0
  const p = Math.max(1, page)
  let next = index
  switch (key) {
    case 'up':
      next = index - 1
      break
    case 'down':
      next = index + 1
      break
    case 'pageup':
      next = index - p
      break
    case 'pagedown':
      next = index + p
      break
    case 'home':
      next = 0
      break
    case 'end':
      next = count - 1
      break
  }
  return Math.max(0, Math.min(count - 1, next))
}

/** The first visible line so that lines [from, to] stay in a window of `height` starting near `top`. */
export function keepVisible(top: number, from: number, to: number, height: number, total: number): number {
  const h = Math.max(1, height)
  let t = top
  if (to >= t + h) t = to - h + 1
  if (from < t) t = from
  return Math.max(0, Math.min(t, Math.max(0, total - h)))
}
