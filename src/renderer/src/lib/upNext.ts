import type { Schedule, ScheduleTarget } from '@shared/types'

/**
 * Up next (docs/design/dashboard-usage-redesign components/UpNext): the next schedule firings, soonest first. Pure: no
 * DOM, no store. Only enabled, active schedules with a next time are listed; a paused, finished or errored schedule is
 * not "next". How far away a firing is reads as a badge, and the next one within the hour takes the accent tone.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The next firing within this long takes the accent tone. */
export const SOON_MS = HOUR

export interface UpNextRow {
  schedule: Schedule
  at: number
  /** "Today", "Tomorrow", "Tue" within a week, else "24 Nov". */
  day: string
  /** The firing's local clock time as the Dashboard writes it ("02:30 PM"). */
  clock: string
  /** "In 40 min", "In 3 h", "In 2 days", "Due now". */
  away: string
  /** Within an hour (or due): the badge takes the accent tone. */
  soon: boolean
  /** The project name, or "Chat". */
  project: string
  /** "Team run", "One assistant" or "Chat run". */
  kind: string
}

/** "Billing API" for a team target, "Chat" for a Chat run. */
export function scheduleTargetLabel(target: ScheduleTarget, projects: readonly { id: string; name: string }[]): string {
  if (target.kind === 'ask') return 'Chat'
  return projects.find((p) => p.id === target.projectId)?.name ?? 'A project that no longer exists'
}

export function scheduleKindLabel(target: ScheduleTarget): string {
  if (target.kind === 'ask') return 'Chat run'
  return target.team === 'single' ? 'One assistant' : 'Team run'
}

const startOfLocalDay = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** How far away `at` is: whole minutes under an hour, whole hours under a day, else whole days ("In 2 days"). */
export function awayText(at: number, now: number): string {
  const ms = at - now
  if (ms <= 0) return 'Due now'
  if (ms < MINUTE) return 'In under a minute'
  const m = Math.round(ms / MINUTE)
  if (m < 60) return `In ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `In ${h} h`
  const d = Math.round(h / 24)
  return `In ${d} ${d === 1 ? 'day' : 'days'}`
}

/** The calendar day of a firing in local terms (the local day difference, never `ms / 24 h`, so a DST change cannot shift it). */
export function dayWord(at: number, now: number, locale = 'en-GB'): string {
  const days = Math.round((startOfLocalDay(at) - startOfLocalDay(now)) / DAY)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  const d = new Date(at)
  if (days < 7) return d.toLocaleDateString(locale, { weekday: 'short' })
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

/** The rows, soonest first, at most as many as exist; `clock` formats a time (the Dashboard's `clockLabel`). */
export function upNextRows(list: readonly Schedule[], now: number, projects: readonly { id: string; name: string }[], clock: (ms: number) => string): UpNextRow[] {
  const rows: UpNextRow[] = []
  for (const s of list) {
    if (!s.enabled || s.state !== 'active' || typeof s.nextRunAt !== 'number' || !Number.isFinite(s.nextRunAt)) continue
    const at = s.nextRunAt
    rows.push({
      schedule: s,
      at,
      day: dayWord(at, now),
      clock: clock(at),
      away: awayText(at, now),
      soon: at - now <= SOON_MS,
      project: scheduleTargetLabel(s.target, projects),
      kind: scheduleKindLabel(s.target)
    })
  }
  return rows.sort((a, b) => a.at - b.at || a.schedule.id.localeCompare(b.schedule.id))
}

/** The accessible name of a row's open button: "Weekly review, Tomorrow 09:00 AM, Billing API, Team run. In 17 h. Open schedule". */
export function upNextName(r: Pick<UpNextRow, 'schedule' | 'day' | 'clock' | 'project' | 'kind' | 'away'>): string {
  return `${r.schedule.name}, ${r.day} ${r.clock}, ${r.project}, ${r.kind}. ${r.away}. Open schedule`
}
