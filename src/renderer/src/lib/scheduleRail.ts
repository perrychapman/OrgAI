import { nextLocalMidnight, startOfLocalDay } from './todayModel'

/**
 * The Today time rail (docs/design/dashboard-overhaul.md "Visual pass"). Pure: no DOM, no store.
 *
 * The rail is a horizontal line from the start of its domain to the next local midnight. The domain starts at the whole
 * local hour of the earliest of now and the earliest schedule shown, and is never shorter than MIN_SPAN_MS (it grows
 * back toward 00:00 late in the day), so a schedule at 23:00 is not squeezed into a stub. A schedule is a dot at its
 * time; dots keep DOT_GAP_PX between centres (they are nudged apart, order kept), and the time labels under them take
 * one of two lanes, a label that fits neither folds into the nearest label on its left as "+N".
 */

export const MIN_SPAN_MS = 6 * 3_600_000
/** Smallest distance between two dot centres: a 16 px dot plus air. */
export const DOT_GAP_PX = 24
/** Room kept left and right of the line for the first and last label. */
export const RAIL_PAD_PX = 36
/** Gap between two labels in one lane. */
const LABEL_GAP_PX = 6
/** One mono caption character, and the label's own padding, for the label width estimate. */
const CHAR_PX = 7.4

export interface RailDomain {
  start: number
  end: number
}

/** The domain for the instants `ats` seen at `now`. */
export function railDomain(ats: readonly number[], now: number): RailDomain {
  const end = nextLocalMidnight(now)
  const first = Math.min(now, ...ats)
  const d = new Date(first)
  d.setMinutes(0, 0, 0)
  let start = d.getTime()
  if (end - start < MIN_SPAN_MS) start = Math.max(end - MIN_SPAN_MS, startOfLocalDay(now))
  return { start, end }
}

/** Whole local hours strictly inside the domain (the faint ticks under the line). */
export function railTicks(domain: RailDomain): number[] {
  const out: number[] = []
  const d = new Date(domain.start)
  d.setMinutes(0, 0, 0)
  if (d.getTime() <= domain.start) d.setHours(d.getHours() + 1)
  for (let guard = 0; d.getTime() < domain.end && guard < 30; guard++) {
    out.push(d.getTime())
    d.setHours(d.getHours() + 1)
  }
  return out
}

/** Horizontal position of an instant in a rail `width` px wide, clamped to the line. */
export function railX(at: number, domain: RailDomain, width: number, pad = RAIL_PAD_PX): number {
  const span = Math.max(1, domain.end - domain.start)
  const inner = Math.max(0, width - 2 * pad)
  const f = Math.min(1, Math.max(0, (at - domain.start) / span))
  return pad + f * inner
}

export interface RailInput {
  key: string
  at: number
  /** Characters of the visible label (e.g. "02:30 PM" = 8). */
  labelChars: number
}

export interface RailPlaced {
  key: string
  /** Dot centre, px from the rail's left edge. */
  x: number
  /** 0 or 1: the lane of the time label; null when it folded into a neighbour's label. */
  lane: 0 | 1 | null
  /** Labels folded into this one (shown "+N"). */
  extra: number
}

/** Dot centres: true positions, pushed apart to `gap`, order kept, kept inside [lo, hi] when they fit there. */
export function spreadDots(xs: readonly number[], lo: number, hi: number, gap = DOT_GAP_PX): number[] {
  const out = [...xs]
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(out[i], i === 0 ? lo : out[i - 1] + gap)
  }
  if (out.length > 0 && out[out.length - 1] > hi) {
    out[out.length - 1] = hi
    for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap)
  }
  // Too many to fit at `gap`: never past the left end (they may then overlap, which the cap keeps rare).
  for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], lo)
  return out
}

/** Place `items` (any order) on a rail `width` px wide; the result is in time order. */
export function layoutRail(items: readonly RailInput[], domain: RailDomain, width: number): RailPlaced[] {
  const sorted = [...items].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
  const lo = RAIL_PAD_PX
  const hi = Math.max(lo, width - RAIL_PAD_PX)
  const xs = spreadDots(
    sorted.map((i) => railX(i.at, domain, width)),
    lo,
    hi
  )
  const laneEnd = [-Infinity, -Infinity]
  const placed: RailPlaced[] = []
  let lastLabelled = -1
  sorted.forEach((item, i) => {
    const w = item.labelChars * CHAR_PX + 4
    const left = xs[i] - w / 2
    let lane: 0 | 1 | null = null
    if (left >= laneEnd[0] + LABEL_GAP_PX) lane = 0
    else if (left >= laneEnd[1] + LABEL_GAP_PX) lane = 1
    const entry: RailPlaced = { key: item.key, x: xs[i], lane, extra: 0 }
    if (lane !== null) {
      laneEnd[lane] = xs[i] + w / 2
      lastLabelled = i
    } else if (lastLabelled >= 0) {
      placed[lastLabelled].extra += 1
    }
    placed.push(entry)
  })
  // A label with nothing to fold into (cannot happen: the first label always fits) keeps lane 0.
  return placed.map((p) => (p.lane === null && lastLabelled < 0 ? { ...p, lane: 0 } : p))
}

/**
 * Which rows to draw when only `cap` fit: the next upcoming one always, then the other upcoming in time order, then the
 * most recent ones that already ran. The result is in time order. At or under the cap everything stays.
 */
export function pickRailRows<T extends { state: 'ran' | 'upcoming'; at: number }>(rows: readonly T[], cap: number): T[] {
  if (rows.length <= cap) return [...rows]
  const upcoming = rows.filter((r) => r.state === 'upcoming').sort((a, b) => a.at - b.at)
  const ran = rows.filter((r) => r.state === 'ran').sort((a, b) => b.at - a.at)
  const chosen = new Set<T>([...upcoming, ...ran].slice(0, Math.max(1, cap)))
  return rows.filter((r) => chosen.has(r))
}

/** The tone of a ran dot's ring from the schedule's last outcome (`neutral` while the run has no outcome yet). */
export function outcomeTone(outcome: 'finished' | 'error' | 'stopped' | 'needs-you' | undefined): 'ok' | 'danger' | 'stopped' | 'warn' | 'neutral' {
  switch (outcome) {
    case 'finished':
      return 'ok'
    case 'error':
      return 'danger'
    case 'stopped':
      return 'stopped'
    case 'needs-you':
      return 'warn'
    default:
      return 'neutral'
  }
}

/** The accessible name of a schedule's dot: "09:00 AM Daily digest, Billing API. Open schedule". */
export function railItemName(p: { time: string; name: string; target: string; outcome?: string; opens: 'schedule' | 'run' }): string {
  const tail = p.outcome ? `${p.target}, ${p.outcome}` : p.target
  return `${p.time} ${p.name}, ${tail}. ${p.opens === 'run' ? 'Open run' : 'Open schedule'}`
}
