import { dayKey, dayName } from './activityStrip'

/**
 * The activity map of Your week (docs/design/dashboard-usage-redesign components/ActivityMap): when runs started, 14 local
 * days across and six four-hour blocks down. Pure: run start times in, counts out. A run counts in the local day and the
 * four-hour block (00-04, 04-08, ...) of its start; each id once; work runs only (the caller filters). Days are built
 * from calendar parts, never by subtracting 24 hours, and the block comes from the local hour, so a daylight saving
 * change cannot repeat or skip a day or put a run in a block it did not start in.
 *
 * Unknown versus zero: a block of today that has not started yet is `future` (nothing could have happened: drawn as an
 * outline, not as a zero); a block that has started and had no run is `zero` (a flat surface). A run stamped after `now`
 * (a clock that went backwards) is left out rather than drawn in a block that has not happened.
 */

export const MAP_DAYS = 14
export const MAP_BLOCKS = 6
export const BLOCK_HOURS = 4

export type CellState = 'zero' | 'some' | 'future'

export interface MapCell {
  runs: number
  state: CellState
  /** The share of the busiest block, 0..1; a block with runs never reads below `MIN_STRENGTH`. */
  strength: number
}

export interface MapDay {
  /** Local calendar day, YYYY-MM-DD. */
  key: string
  start: number
  today: boolean
  /** "Wed 4 Nov". */
  name: string
  /** Blocks oldest first (00:00 to 04:00 first). */
  cells: MapCell[]
  total: number
}

export interface ActivityMap {
  days: MapDay[]
  /** Runs in the whole map. */
  total: number
  /** The most runs in one cell (the top of the scale). */
  max: number
  /** Runs started today. */
  today: number
  /** Totals per time block over every day, in block order, for the text alternative. */
  byBlock: number[]
}

/** A block with runs reads at least this strong, so 1 run beside a busy block is not an empty cell. */
export const MIN_STRENGTH = 0.12

export const pad2 = (n: number): string => String(n).padStart(2, '0')

/** The row labels: "00", "04", ... "20" (the hour each block starts). */
export const BLOCK_LABELS: readonly string[] = Array.from({ length: MAP_BLOCKS }, (_, b) => pad2(b * BLOCK_HOURS))

/** "12:00 to 16:00". */
export function blockRange(block: number): string {
  const from = block * BLOCK_HOURS
  return `${pad2(from)}:00 to ${pad2((from + BLOCK_HOURS) % 24)}:00`
}

export function activityMap(runs: readonly { id: string; startedAt: number }[], now: number): ActivityMap {
  const n = new Date(now)
  const todayKey = dayKey(now)
  const nowBlock = Math.floor(n.getHours() / BLOCK_HOURS)
  const counts: number[][] = []
  const days: MapDay[] = []
  const slot = new Map<string, number>()
  for (let i = MAP_DAYS - 1; i >= 0; i--) {
    const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - i)
    const key = dayKey(d.getTime())
    slot.set(key, days.length)
    counts.push(Array.from({ length: MAP_BLOCKS }, () => 0))
    days.push({ key, start: d.getTime(), today: key === todayKey, name: dayName(d.getTime()), cells: [], total: 0 })
  }
  const seen = new Set<string>()
  for (const r of runs) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (!Number.isFinite(r.startedAt) || r.startedAt > now) continue
    const at = slot.get(dayKey(r.startedAt))
    if (at === undefined) continue
    const block = Math.min(MAP_BLOCKS - 1, Math.floor(new Date(r.startedAt).getHours() / BLOCK_HOURS))
    counts[at][block] += 1
  }
  let max = 0
  let total = 0
  const byBlock = Array.from({ length: MAP_BLOCKS }, () => 0)
  counts.forEach((row, di) => {
    row.forEach((c, b) => {
      max = Math.max(max, c)
      total += c
      byBlock[b] += c
      days[di].total += c
    })
  })
  days.forEach((day, di) => {
    day.cells = counts[di].map((runs, b) => {
      const future = day.today && b > nowBlock
      if (runs > 0) return { runs, state: 'some' as const, strength: Math.min(1, Math.max(MIN_STRENGTH, runs / max)) }
      return { runs: 0, state: future ? ('future' as const) : ('zero' as const), strength: 0 }
    })
  })
  return { days, total, max, today: days[days.length - 1]?.total ?? 0, byBlock }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The text alternative: the scale and the busiest blocks of the day (at most two), by total over the 14 days. */
export function mapText(map: ActivityMap): string {
  if (map.total === 0) return 'No runs started in the last 14 days.'
  const ranked = map.byBlock
    .map((runs, block) => ({ runs, block }))
    .filter((b) => b.runs > 0)
    .sort((a, b) => b.runs - a.runs || a.block - b.block)
    .slice(0, 2)
  const busiest = ranked.map((b, i) => `${blockRange(b.block)}${i === 0 ? ` with ${plural(b.runs, 'run', 'runs')}` : ` with ${b.runs}`}`).join(', then ')
  return `Runs started per four-hour block over the last 14 days. ${plural(map.total, 'run', 'runs')} in all. Busiest: ${busiest}.`
}

/** The footer sentence: today's count in words. */
export function todayText(map: ActivityMap): string {
  if (map.today === 0) return 'No runs started today yet.'
  return `${plural(map.today, 'run', 'runs')} started today.`
}

/** "8 Nov": the label under the oldest column. */
export function firstDayLabel(map: ActivityMap): string {
  const first = map.days[0]
  return first ? new Date(first.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''
}

/**
 * The clock the map and the week recap read: the 60-second tick, or the wall clock when that is later. A run that
 * started after the last tick would otherwise be stamped "after now" and left out of the map until the next tick.
 */
export function freshNow(tick: number, wall: number): number {
  return Math.max(tick, wall)
}
