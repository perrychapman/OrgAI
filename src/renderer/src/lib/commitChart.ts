import { dayKey, dayName, weekdayInitial } from './activityStrip'
import { projectHue } from './projectIdentity'

/**
 * Commits this week by project (docs/design/dashboard-overhaul.md "Visual pass", the Commits tile). Pure: the read-only
 * `projects.commitActivity()` answer, the stored code projects and the clock in; one stacked bar per local day out, the
 * legend, the day names, the readouts and the text alternative, all from this one function so the drawing, the names
 * and the sentence can never disagree. Nothing here reads the DOM or the store.
 *
 * Rules: an unavailable project (no repo, untrusted or missing folder, git error) is left out, so is a project the
 * renderer does not know, and so is one whose `days` is not 7 entries long. The 5 projects with most commits are named,
 * the rest fold into one neutral "Other". The scale is linear from zero. The days are the last 7 local calendar days
 * ending today, built from calendar parts (never 24 h steps); input days are matched by date, so a cached answer that is
 * a midnight old loses its oldest day instead of shifting every bar.
 */

/** Structurally identical to `ProjectCommitActivity` (src/shared/types.ts, landed on dev); declared here so this file never depends on it. */
export interface CommitActivityInput {
  projectId: string
  available: boolean
  days: { date: string; commits: number }[]
  total: number
}

export interface CommitProjectIn {
  id: string
  name: string
}

/** Days in the chart: the last 7 local days including today. */
export const COMMIT_DAYS = 7
/** Named projects before "Other". */
export const COMMIT_MAX_NAMED = 5
/** Track heights in px (the bar area above the baseline), declared so e2e can measure them (the container query in dashboard-commits.css applies them). */
export const COMMIT_TRACK_NARROW_PX = 72
export const COMMIT_TRACK_WIDE_PX = 96
/** A segment is never shorter than this, and neighbours are this far apart (a surface-coloured gap). */
export const COMMIT_MIN_SEGMENT_PX = 2
export const COMMIT_SEGMENT_GAP_PX = 2
/** Weekday initials need columns at least this wide (container query in dashboard-commits.css). */
export const COMMIT_MIN_INITIAL_COLUMN_PX = 24

export type CommitSegmentKind = 'project' | 'other'

export interface CommitSegment {
  /** The project id, or 'other'. */
  id: string
  kind: CommitSegmentKind
  name: string
  /** Identity hue 1..8 for a project; 0 (neutral) for Other. */
  hue: number
  commits: number
}

export interface CommitColumn {
  /** Local calendar day, YYYY-MM-DD. */
  date: string
  today: boolean
  total: number
  /** The bar's height as a share of the busiest day, 0..100 (linear from zero); 0 for an empty day. */
  pct: number
  /** Segments with commits only, in legend order (the first is drawn at the bottom). */
  segments: CommitSegment[]
  /** Weekday initial under the column. */
  initial: string
  /** The day button's accessible name: "Thu 19 Nov: 7 commits, Billing API 4, Website 3". */
  name: string
  /** The readout line when the day is shown. */
  readout: string
}

export interface CommitLegendItem {
  id: string
  kind: CommitSegmentKind
  name: string
  hue: number
  total: number
  /** The tooltip: "Billing API: 8 commits". */
  title: string
}

export interface CommitChart {
  columns: CommitColumn[]
  legend: CommitLegendItem[]
  /** Commits over the 7 days, available known projects only. */
  total: number
  /** The busiest day's commits (the top of the scale). */
  max: number
  /** True when there is nothing to draw (no commits at all). */
  empty: boolean
  /** The readout line for the whole week. */
  weekReadout: string
  /** The sentence a screen reader gets in place of the drawn chart. */
  text: string
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Count of commits as a word group: "7 commits". */
export const commitsWord = (n: number): string => plural(n, 'commit', 'commits')

/** The last `days` local calendar days ending at `now`, oldest first. Calendar parts, so a daylight saving change cannot repeat or skip a day. */
export function weekDays(now: number, days = COMMIT_DAYS): { key: string; start: number; today: boolean }[] {
  const n = new Date(now)
  const todayKey = dayKey(now)
  const out: { key: string; start: number; today: boolean }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - i)
    const key = dayKey(d.getTime())
    out.push({ key, start: d.getTime(), today: key === todayKey })
  }
  return out
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/** "Billing API 4, Website 3" (zero parts are left out by the caller). */
const parts = (segments: readonly Pick<CommitSegment, 'name' | 'commits'>[]): string => segments.map((s) => `${s.name} ${s.commits}`).join(', ')

/** Height of a bar in px for a track: a linear share of the busiest day, at least one minimum segment for any day with commits; 0 for none. */
export function barHeightPx(total: number, max: number, trackPx: number): number {
  if (total <= 0 || max <= 0) return 0
  return Math.min(trackPx, Math.max(COMMIT_MIN_SEGMENT_PX, (total / max) * trackPx))
}

/** The least a bar of `segments` stacked segments can be: every segment its minimum plus the gaps between (CSS mirrors it as min-height). */
export function minBarPx(segments: number): number {
  if (segments <= 0) return 0
  return segments * COMMIT_MIN_SEGMENT_PX + (segments - 1) * COMMIT_SEGMENT_GAP_PX
}

export function commitChart(
  input: readonly CommitActivityInput[] | null | undefined,
  projects: readonly CommitProjectIn[],
  now: number,
  maxNamed = COMMIT_MAX_NAMED
): CommitChart {
  const names = new Map(projects.map((p) => [p.id, p.name]))
  const week = weekDays(now)
  const index = new Map(week.map((d, i) => [d.key, i]))

  // Per known, available project: commits per chart day.
  const perProject = new Map<string, { id: string; name: string; days: number[]; total: number }>()
  for (const a of Array.isArray(input) ? input : []) {
    if (!a || typeof a.projectId !== 'string' || a.available !== true) continue
    const name = names.get(a.projectId)
    if (name === undefined || perProject.has(a.projectId)) continue
    if (!Array.isArray(a.days) || a.days.length !== COMMIT_DAYS) continue
    const days = new Array<number>(COMMIT_DAYS).fill(0)
    for (const d of a.days) {
      const at = d && typeof d.date === 'string' ? index.get(d.date) : undefined
      if (at !== undefined) days[at] += count(d.commits)
    }
    const total = days.reduce((x, y) => x + y, 0)
    if (total > 0) perProject.set(a.projectId, { id: a.projectId, name, days, total })
  }

  const ranked = [...perProject.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const named = ranked.slice(0, Math.max(0, maxNamed))
  const folded = ranked.slice(named.length)
  const other = folded.length > 0 ? { days: week.map((_, i) => folded.reduce((s, p) => s + p.days[i], 0)), total: folded.reduce((s, p) => s + p.total, 0) } : null

  const legend: CommitLegendItem[] = named.map((p) => ({ id: p.id, kind: 'project', name: p.name, hue: projectHue(p.id), total: p.total, title: `${p.name}: ${commitsWord(p.total)}` }))
  if (other) legend.push({ id: 'other', kind: 'other', name: 'Other', hue: 0, total: other.total, title: `Other: ${commitsWord(other.total)}` })

  const dayTotals = week.map((_, i) => named.reduce((s, p) => s + p.days[i], 0) + (other ? other.days[i] : 0))
  const max = dayTotals.reduce((m, n) => (n > m ? n : m), 0)
  const total = dayTotals.reduce((s, n) => s + n, 0)

  const columns: CommitColumn[] = week.map((d, i) => {
    const segments: CommitSegment[] = []
    for (const p of named) if (p.days[i] > 0) segments.push({ id: p.id, kind: 'project', name: p.name, hue: projectHue(p.id), commits: p.days[i] })
    if (other && other.days[i] > 0) segments.push({ id: 'other', kind: 'other', name: 'Other', hue: 0, commits: other.days[i] })
    const dayTotal = dayTotals[i]
    const long = dayName(d.start)
    const tail = parts(segments)
    return {
      date: d.key,
      today: d.today,
      total: dayTotal,
      pct: max > 0 ? (dayTotal / max) * 100 : 0,
      segments,
      initial: weekdayInitial(d.start),
      name: dayTotal === 0 ? `${d.today ? `Today, ${long}` : long}: no commits` : `${d.today ? `Today, ${long}` : long}: ${commitsWord(dayTotal)}, ${tail}`,
      readout: dayTotal === 0 ? `${d.today ? 'Today' : long}: no commits` : `${d.today ? 'Today' : long}: ${commitsWord(dayTotal)} · ${segments.map((s) => `${s.name} ${s.commits}`).join(' · ')}`
    }
  })

  const weekReadout = total === 0 ? 'No commits in the last 7 days' : `Last 7 days: ${commitsWord(total)} · ${legend.map((l) => `${l.name} ${l.total}`).join(' · ')}`
  const byDay = columns.map((c, i) => `${c.today ? 'Today' : dayName(week[i].start)} ${c.total === 0 ? 'none' : `${c.total}${c.segments.length > 1 ? ` (${parts(c.segments)})` : ''}`}`).join('; ')
  const text =
    total === 0
      ? 'No commits in the last 7 days.'
      : `Commits by project, last 7 days: ${commitsWord(total)}. ${parts(legend.map((l) => ({ name: l.name, commits: l.total })))}. By day: ${byDay}.`

  return { columns, legend, total, max, empty: total === 0, weekReadout, text }
}
