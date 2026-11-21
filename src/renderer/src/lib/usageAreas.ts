/**
 * Pure geometry and text for the Usage page's stacked-area spend chart (dashboard-usage-redesign usage.md, SpendChart).
 * No DOM and no React: SpendPanel draws what these functions decide and the tests pin the decisions.
 *
 * One point per bucket slot, spread edge to edge, joined by straight lines. The largest series stacks at the bottom.
 * Unknown is never zero: a slot whose usage has no price keeps a height of nothing for that series, and the chart marks
 * the slot (a hatched band and a lane cell) so a gap reads as "not priced", not as "$0".
 */
import { barHeight, type Metric, type Segment } from './usageCharts'
import { barValueLabel, segmentFigure } from './usageSpend'

// ---------- x geometry and the crosshair index ----------

/** The x of each slot's point: edge to edge over `width`, or the middle for a single slot. */
export function pointXs(n: number, left: number, width: number): number[] {
  if (n <= 0) return []
  if (n === 1) return [left + width / 2]
  const step = width / (n - 1)
  return Array.from({ length: n }, (_, i) => left + i * step)
}

/** The distance between neighbouring points (the whole width for a single slot). */
export const pointStep = (n: number, width: number): number => (n > 1 ? width / (n - 1) : width)

/**
 * The slot whose point is nearest x (svg px), or null when x is more than half a step outside the plot or there are no
 * slots. The pointer anywhere over the plot picks a slot; there is no thin target to hit.
 */
export function nearestIndex(x: number, left: number, width: number, n: number): number | null {
  if (n <= 0) return null
  if (n === 1) return x >= left && x <= left + width ? 0 : null
  const step = width / (n - 1)
  const rel = x - left
  if (rel < -step / 2 || rel > width + step / 2) return null
  return Math.max(0, Math.min(n - 1, Math.round(rel / step)))
}

/** The slot a key moves the crosshair to, or null when the key is not a crosshair key. */
export function moveIndex(current: number, key: string, n: number): number | null {
  if (n <= 0) return null
  const at = Math.max(0, Math.min(n - 1, current))
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, at - 1)
    case 'ArrowRight':
      return Math.min(n - 1, at + 1)
    case 'Home':
      return 0
    case 'End':
      return n - 1
    default:
      return null
  }
}

// ---------- stacking ----------

/** One series' total over the chart, for ordering. `series` is the colour index, -1 for Other. */
export interface SeriesTotal {
  key: string
  series: number
  total: number
}

/** Stack order, bottom first: the largest total first, ties by colour index, Other last among equals. Series with nothing drawn are left out. */
export function stackOrder(totals: readonly SeriesTotal[]): string[] {
  const rank = (s: number): number => (s < 0 ? 99 : s)
  return totals
    .filter((t) => t.total > 0)
    .sort((a, b) => b.total - a.total || rank(a.series) - rank(b.series))
    .map((t) => t.key)
}

/** Each series' total over the visible slots (a slot's segments, keyed). */
export function seriesTotals(slots: readonly (readonly Segment[])[]): SeriesTotal[] {
  const out = new Map<string, SeriesTotal>()
  for (const segs of slots) {
    for (const s of segs) {
      const cur = out.get(s.key)
      if (cur) cur.total += s.value
      else out.set(s.key, { key: s.key, series: s.series, total: s.value })
    }
  }
  return [...out.values()]
}

export interface AreaBand {
  /** y of the band's upper edge at each slot, svg px. */
  top: number[]
  /** y of its lower edge at each slot. */
  bottom: number[]
}

/**
 * The y of every series' edges at every slot. `values[i]` maps a series key to its value in slot i (missing = 0). A value
 * above zero is at least `minPx` tall so a small day never reads as empty (the stack stays below the plot top by at most that).
 */
export function stackAreas(order: readonly string[], values: readonly ReadonlyMap<string, number>[], axisMax: number, plotH: number, baseY: number, minPx = 1.5): Map<string, AreaBand> {
  const bands = new Map<string, AreaBand>(order.map((k) => [k, { top: [], bottom: [] }]))
  for (const slot of values) {
    let cum = 0
    for (const key of order) {
      const h = barHeight(slot.get(key) ?? 0, axisMax, plotH, minPx)
      const band = bands.get(key)!
      band.bottom.push(baseY - cum)
      cum += h
      band.top.push(baseY - cum)
    }
  }
  return bands
}

const r2 = (n: number): string => String(Math.round(n * 100) / 100)

/**
 * The closed outline of one band: along the top edge left to right, back along the bottom edge. A single slot has no
 * width, so it is drawn `half` px either side of its point.
 */
export function areaPath(xs: readonly number[], band: AreaBand, half = 0): string {
  if (xs.length === 0) return ''
  let px = xs
  let top = band.top
  let bottom = band.bottom
  if (xs.length === 1) {
    px = [xs[0]! - half, xs[0]! + half]
    top = [top[0]!, top[0]!]
    bottom = [bottom[0]!, bottom[0]!]
  }
  const up = px.map((x, i) => `${i === 0 ? 'M' : 'L'}${r2(x)} ${r2(top[i]!)}`)
  const down = px.map((x, i) => `L${r2(x)} ${r2(bottom[i]!)}`).reverse()
  return `${up.join('')}${down.join('')}Z`
}

/** The open top edge of a band (for the highlight outline). */
export function edgePath(xs: readonly number[], band: AreaBand, half = 0): string {
  if (xs.length === 0) return ''
  let px = xs
  let top = band.top
  if (xs.length === 1) {
    px = [xs[0]! - half, xs[0]! + half]
    top = [top[0]!, top[0]!]
  }
  return px.map((x, i) => `${i === 0 ? 'M' : 'L'}${r2(x)} ${r2(top[i]!)}`).join('')
}

/**
 * Polylines through the points, broken wherever a y is null (a gap is a gap, never a dip to zero). A single point between
 * gaps is a zero-length segment, which a round line cap draws as a dot.
 */
export function linePaths(xs: readonly number[], ys: readonly (number | null)[]): string[] {
  const out: string[] = []
  let cur: string[] = []
  const flush = (): void => {
    if (cur.length === 1) cur.push(cur[0]!.replace('M', 'L'))
    if (cur.length > 0) out.push(cur.join(''))
    cur = []
  }
  ys.forEach((y, i) => {
    if (y === null || xs[i] === undefined) {
      flush()
      return
    }
    cur.push(`${cur.length === 0 ? 'M' : 'L'}${r2(xs[i]!)} ${r2(y)}`)
  })
  flush()
  return out
}

// ---------- gaps ----------

export interface KindRun<K extends string> {
  from: number
  to: number
  kind: K
}

/** Consecutive slots of the same kind as runs (null kinds are skipped), so a band is one rect, not one per slot. */
export function kindRuns<K extends string>(kinds: readonly (K | null)[]): KindRun<K>[] {
  const out: KindRun<K>[] = []
  kinds.forEach((kind, i) => {
    if (kind === null) return
    const last = out[out.length - 1]
    if (last && last.kind === kind && last.to === i - 1) last.to = i
    else out.push({ from: i, to: i, kind })
  })
  return out
}

/** The x extent of a run: half a step either side of its first and last points, kept inside the plot. */
export function runExtent(run: { from: number; to: number }, xs: readonly number[], step: number, left: number, right: number): { x: number; w: number } {
  const a = Math.max(left, (xs[run.from] ?? left) - step / 2)
  const b = Math.min(right, (xs[run.to] ?? right) + step / 2)
  return { x: a, w: Math.max(0, b - a) }
}

// ---------- crosshair text ----------

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`

export interface CrosshairRow {
  key: string
  /** The series colour index, -1 for Other. */
  series: number
  /** The (clipped) name for the tooltip. */
  name: string
  /** The figure: "$6.10", "$0.42+", "12k", "3", or "Not priced". */
  value: string
  state: Segment['state']
}

export interface CrosshairModel {
  label: string
  /** The stack's figure for the header ("$9.80", "$4.20+", "Not priced"), or null when there is nothing to total. */
  total: string | null
  /** Top of the stack first, matching what the eye sees. */
  rows: CrosshairRow[]
  previous: string | null
  runs: string | null
  note: string | null
  /** The same facts as one sentence: the focused plot's value text for assistive tech. */
  text: string
}

export interface CrosshairInput {
  label: string
  metric: Metric
  /** Not loaded (older than the oldest run main sent). */
  notLoaded: boolean
  /** The slot has a trend point. */
  hasPoint: boolean
  /** Runs in the series shown (0 = nothing to read). */
  runs: number
  /** "N runs, M unpriced". */
  runsLine: string | null
  hiddenSeries: boolean
  /** The shown segments in colour order. */
  segments: readonly Segment[]
  /** Stack order, bottom first (usageAreas.stackOrder). */
  order: readonly string[]
  /** Full name of a series (the tooltip clips it). */
  name: (key: string, seg: Segment) => string
  clip: (name: string) => string
  /** "Previous: ..." text for the overlay, or null. */
  previous: string | null
}

const tipFigure = (metric: Metric, seg: Segment): string => (metric === 'cost' && seg.state === 'unknown' ? 'Not priced' : segmentFigure(metric, seg))

/** The words a figure reads as in the value text: "$6.10", "12k tokens", "3 runs", "Not priced". */
function spokenFigure(metric: Metric, seg: Segment): string {
  const v = tipFigure(metric, seg)
  if (metric === 'tokens') return `${v} tokens`
  if (metric === 'runs') return plural(seg.value, 'run')
  return v
}

/** What the crosshair shows and says for one slot: the tooltip's rows and the value text, from one place. */
export function crosshairModel(i: CrosshairInput): CrosshairModel {
  const previous = i.previous
  const prevText = previous ? ` Previous: ${previous}.` : ''
  if (i.notLoaded) return { label: i.label, total: null, rows: [], previous, runs: null, note: 'Not loaded', text: `${i.label}: not loaded.${prevText}` }
  if (!i.hasPoint || i.runs === 0) {
    const note = i.hiddenSeries && i.hasPoint ? 'Nothing in the series shown' : 'No runs'
    return { label: i.label, total: null, rows: [], previous, runs: null, note, text: `${i.label}: ${note.toLowerCase()}.${prevText}` }
  }
  const at = (key: string): number => i.order.indexOf(key)
  const rows = [...i.segments]
    .sort((a, b) => {
      const pa = at(a.key)
      const pb = at(b.key)
      if (pa < 0 || pb < 0) return pa < 0 && pb < 0 ? 0 : pa < 0 ? 1 : -1
      return pb - pa
    })
    .map<CrosshairRow>((s) => ({ key: s.key, series: s.series, name: i.clip(i.name(s.key, s)), value: tipFigure(i.metric, s), state: s.state }))
  const rawTotal = barValueLabel(i.metric, i.segments)
  const total = rawTotal || null
  const spoken = [...i.segments].sort((a, b) => at(b.key) - at(a.key)).map((s) => `${i.name(s.key, s)} ${spokenFigure(i.metric, s)}`)
  const head =
    i.metric === 'runs'
      ? (i.runsLine ?? '')
      : `${total ?? ''}${i.metric === 'tokens' && total ? ' tokens' : ''}${i.runsLine ? `${total ? ', ' : ''}${i.runsLine}` : ''}`
  const text = `${i.label}: ${head}.${spoken.length > 0 ? ` ${spoken.join(', ')}.` : ''}${prevText}`
  return { label: i.label, total, rows, previous, runs: i.runsLine, note: null, text }
}
