import { barHeight, dayLedger, dayName, LEDGER_DAYS, MIN_BAR_PX, type LedgerRun } from './activityStrip'

/**
 * The 7-day runs sparkline on a Dashboard project tile (docs/design/dashboard-overhaul.md "Visual pass"). A small ledger,
 * not a trend line: seven columns, oldest left, today right, one bar per day with runs, scaled linearly from zero to the
 * project's own busiest day (so the figure beside it, not the bar, carries the size). Pure: the project's run summaries in,
 * plain geometry and the text alternative out; the tile only draws it.
 */

/** Bar area height in px (above the baseline). Declared so e2e can measure it. */
export const SPARK_TRACK_PX = 24
/** Column pitch and bar width in px; the drawing is `SPARK_DAYS * SPARK_PITCH_PX` wide. */
export const SPARK_PITCH_PX = 12
export const SPARK_BAR_PX = 8
/** Room under the baseline for today's marker. */
export const SPARK_MARK_PX = 5
export const SPARK_DAYS = LEDGER_DAYS

export interface SparkDay {
  /** Local calendar day, YYYY-MM-DD. */
  key: string
  today: boolean
  runs: number
  /** Left edge of the bar in px. */
  x: number
  /** Bar height in px: 0 for no runs, otherwise at least `MIN_BAR_PX`. */
  height: number
}

export interface Spark {
  days: SparkDay[]
  /** Runs started in the 7 days. */
  total: number
  /** Drawing width and height in px (track plus the marker row). */
  width: number
  height: number
  /** The accessible name: "Runs in the last 7 days: 5, most on Tue 18 Nov" or "No runs this week". */
  label: string
}

/**
 * The sparkline of one project. `summaries` are that project's runs (each id counts once, a run counts on the local day it
 * started, as in Your week). Ties for the busiest day drop the "most on" part rather than naming one arbitrarily.
 */
export function projectSpark(summaries: readonly LedgerRun[], now: number): Spark {
  const ledger = dayLedger(summaries, now, SPARK_DAYS)
  const max = ledger.reduce((m, d) => Math.max(m, d.runs), 0)
  const total = ledger.reduce((a, d) => a + d.runs, 0)
  const offset = (SPARK_PITCH_PX - SPARK_BAR_PX) / 2
  const days: SparkDay[] = ledger.map((d, i) => ({
    key: d.key,
    today: d.today,
    runs: d.runs,
    x: i * SPARK_PITCH_PX + offset,
    height: barHeight(d.runs, max, SPARK_TRACK_PX, MIN_BAR_PX)
  }))
  return { days, total, width: SPARK_DAYS * SPARK_PITCH_PX, height: SPARK_TRACK_PX + SPARK_MARK_PX, label: sparkLabel(ledger, total, max) }
}

function sparkLabel(ledger: ReturnType<typeof dayLedger>, total: number, max: number): string {
  if (total === 0) return 'No runs this week'
  const busiest = ledger.filter((d) => d.runs === max)
  const head = `Runs in the last 7 days: ${total}`
  if (busiest.length !== 1) return head
  const busy = busiest[0]
  const when = busy.today ? `Today, ${dayName(busy.start)}` : dayName(busy.start)
  return ledger.filter((d) => d.runs > 0).length === 1 ? `${head}, all on ${when}` : `${head}, most on ${when}`
}
