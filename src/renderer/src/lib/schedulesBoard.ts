/**
 * Pure view-models of the Schedules board (UI overhaul): the week strip, the header summary and the detail facts.
 * Everything is derived from the Schedule contract and its timing rules; nothing here is sample data. Times are the
 * computer's local time, like the rest of the page.
 */
import type { PermissionMode, Schedule, ScheduleCost, ScheduleCostReport, ScheduleHistoryEntry } from '@shared/types'
import { nextScheduleRun } from '@shared/schedule'
import { permissionModeName } from './runSettings'

const DAY_MS = 86_400_000
export const WEEK_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
/** Most chips drawn in one day cell; the rest read "+n more". */
export const WEEK_CHIPS_PER_DAY = 3
/** Slots walked per schedule per week (an every-15-minutes schedule would otherwise fill the strip). */
const SLOTS_PER_SCHEDULE = 200

/** Local midnight of the Monday of the week that holds `now`. */
export function weekStart(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  const back = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - back)
  return d.getTime()
}

function hhmm(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface WeekChip {
  scheduleId: string
  name: string
  at: number
  /** "06:00". */
  time: string
  /** A turned-off schedule: drawn faded, still shown so the week reads the same either way. */
  off: boolean
}

export interface WeekDay {
  index: number
  name: (typeof WEEK_DAY_NAMES)[number]
  /** Day of the month. */
  date: number
  today: boolean
  chips: WeekChip[]
  /** Chips beyond WEEK_CHIPS_PER_DAY. */
  more: number
  /** Whole-day sentence for the cell's accessible name. */
  label: string
}

/**
 * Seven days, Monday first. Each schedule's rule is walked across the week; a schedule that is off, paused, done or in
 * error (or held by the global pause) is still listed but flagged `off`. A one-off whose time passed has no slot.
 */
export function weekDays(list: readonly Schedule[], now: number, globalPaused = false): WeekDay[] {
  const start = weekStart(now)
  const end = start + 7 * DAY_MS
  const todayIndex = Math.min(6, Math.max(0, Math.floor((now - start) / DAY_MS)))
  const days: WeekDay[] = WEEK_DAY_NAMES.map((name, i) => {
    const d = new Date(start + i * DAY_MS + DAY_MS / 2)
    return { index: i, name, date: d.getDate(), today: i === todayIndex, chips: [], more: 0, label: '' }
  })
  const all: WeekChip[][] = days.map(() => [])
  for (const s of list) {
    const off = !s.enabled || s.state !== 'active' || globalPaused
    let cursor = start - 1
    for (let n = 0; n < SLOTS_PER_SCHEDULE; n++) {
      let at: number | null = null
      try {
        at = nextScheduleRun(s.timing, cursor)
      } catch {
        at = null
      }
      if (at === null || at >= end || at <= cursor) break
      const i = Math.min(6, Math.max(0, Math.floor((at - start) / DAY_MS)))
      all[i].push({ scheduleId: s.id, name: s.name, at, time: hhmm(at), off })
      cursor = at
    }
  }
  for (const day of days) {
    const chips = all[day.index].sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
    day.chips = chips.slice(0, WEEK_CHIPS_PER_DAY)
    day.more = Math.max(0, chips.length - day.chips.length)
    day.label = chips.length === 0 ? `${day.name} ${day.date}: nothing scheduled` : `${day.name} ${day.date}: ${chips.map((c) => `${c.name} at ${c.time}${c.off ? ' (off)' : ''}`).join(', ')}`
  }
  return days
}

export interface BoardSummary {
  total: number
  on: number
  /** The soonest next run among schedules that are on; null when nothing is due. */
  nextAt: number | null
  nextName: string | null
}

export function boardSummary(list: readonly Schedule[], globalPaused: boolean): BoardSummary {
  const on = list.filter((s) => s.enabled && s.state === 'active')
  let nextAt: number | null = null
  let nextName: string | null = null
  if (!globalPaused) {
    for (const s of on) {
      if (typeof s.nextRunAt === 'number' && Number.isFinite(s.nextRunAt) && (nextAt === null || s.nextRunAt < nextAt)) {
        nextAt = s.nextRunAt
        nextName = s.name
      }
    }
  }
  return { total: list.length, on: on.length, nextAt, nextName }
}

/** "Today 06:00", "Tomorrow 06:00", "Friday 16:00" within a week, else a date. */
export function dayTimeWords(at: number, now: number): string {
  const d = new Date(at)
  const startToday = new Date(now)
  startToday.setHours(0, 0, 0, 0)
  const diff = Math.floor((new Date(at).setHours(0, 0, 0, 0) - startToday.getTime()) / DAY_MS)
  const time = hhmm(at)
  if (diff === 0) return `today ${time}`
  if (diff === 1) return `tomorrow ${time}`
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${time}`
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

export function summaryText(s: BoardSummary, now: number, globalPaused: boolean): string {
  if (s.total === 0) return 'No schedules yet'
  if (globalPaused) return `${s.on} on · all paused`
  return s.nextAt === null ? `${s.on} on · nothing due` : `${s.on} on · next run ${dayTimeWords(s.nextAt, now)}`
}

export interface FactRow {
  label: string
  value: string
}

/** "May change files": plain words from the target and the mode the schedule pins (or the project's when absent). */
export function mayChangeFiles(s: Pick<Schedule, 'target' | 'permissionMode'>): string {
  if (s.target.kind === 'ask') return s.target.allowEdits ? 'Yes, in its folder' : 'No, it only reads'
  return modeFiles(s.permissionMode)
}

function modeFiles(mode: PermissionMode | undefined): string {
  switch (mode) {
    case undefined:
      return "As the project is set"
    case 'plan':
      return 'No, it only plans'
    case 'default':
      return 'Only after you approve'
    case 'dontAsk':
      return 'Only what is already allowed'
    case 'acceptEdits':
    case 'auto':
      return `Yes (${permissionModeName(mode)})`
    default:
      return permissionModeName(mode)
  }
}

export function spendingLimit(s: Pick<Schedule, 'budgetUsd'>): string {
  const b = s.budgetUsd
  return typeof b === 'number' && Number.isFinite(b) && b > 0 ? `$${b < 1 ? b.toFixed(2) : Number(b.toFixed(2)).toString()} a run` : "The project's own limit"
}

export function whoText(s: Pick<Schedule, 'target'>): string {
  if (s.target.kind === 'ask') return 'One assistant in Chat'
  return s.target.team === 'single' ? 'One assistant' : 'Whole team'
}

export function detailFacts(s: Schedule, timing: string): FactRow[] {
  return [
    { label: 'When', value: timing },
    { label: 'Who', value: whoText(s) },
    { label: 'If it needs you', value: 'The run waits for you' },
    { label: 'May change files', value: mayChangeFiles(s) },
    { label: 'Spending limit', value: spendingLimit(s) }
  ]
}

/** Last outcome as a dot tone for the list row: ok, failed, or none (no run to judge yet). */
export function lastTone(s: Pick<Schedule, 'lastEntry' | 'consecutiveFailures'>): 'ok' | 'bad' | 'none' {
  const e = s.lastEntry
  if (e) return e.result === 'failed' || e.outcome === 'error' ? 'bad' : e.result === 'started' && (e.outcome === 'finished' || !e.outcome) ? 'ok' : e.outcome === 'needs-you' || e.result === 'skipped' ? 'none' : 'ok'
  return s.consecutiveFailures > 0 ? 'bad' : 'none'
}

/** Colour slots for rows and chips, tokens only; the same schedule keeps its colour in the strip and the list. */
export const SCHEDULE_COLOURS = ['var(--chart-s2)', 'var(--chart-s1)', 'var(--chart-s6)', 'var(--chart-s4)', 'var(--chart-s3)', 'var(--chart-s5)'] as const
export function scheduleColour(list: readonly Pick<Schedule, 'id' | 'createdAt'>[], id: string): string {
  const order = [...list].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const i = order.findIndex((s) => s.id === id)
  return SCHEDULE_COLOURS[(i < 0 ? 0 : i) % SCHEDULE_COLOURS.length]
}

// ---- Cost and last-runs figures (runInsights.scheduleCosts / scheduleHistory). Unknown is never $0. ----

/** "$0.42", "$12", "<$0.01": the money words used on rows and in the header. */
export function usdText(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'unknown'
  if (n > 0 && n < 0.01) return '<$0.01'
  return `$${n < 10 ? n.toFixed(2) : Number(n.toFixed(n < 100 ? 1 : 0)).toString()}`
}

export interface CostFigure {
  /** Visible text: "$1.40 a week" or "Weekly cost unknown". */
  text: string
  /** Accessible description of the basis. */
  basis: string
  known: boolean
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** One schedule's weekly figure; absent or null fields are unknown, never $0. */
export function scheduleCostFigure(c: Partial<Pick<ScheduleCost, 'perRunUsd' | 'sampleRuns' | 'runsPerWeek' | 'weeklyUsd'>> | undefined): CostFigure {
  if (!c) return { text: 'Weekly cost unknown', basis: 'No cost figure is available for this schedule yet.', known: false }
  const n = isNum(c.sampleRuns) ? c.sampleRuns : 0
  if (isNum(c.weeklyUsd)) {
    const per = isNum(c.perRunUsd) ? ` at about ${usdText(c.perRunUsd)} a run` : ''
    const w = isNum(c.runsPerWeek) ? `, ${c.runsPerWeek} ${c.runsPerWeek === 1 ? 'run' : 'runs'} in the next 7 days` : ''
    return { text: `${usdText(c.weeklyUsd)} a week`, basis: `Estimated from the last ${n} ${n === 1 ? 'run' : 'runs'}${per}${w}.`, known: true }
  }
  if (!isNum(c.perRunUsd)) return { text: 'Weekly cost unknown', basis: 'It has no finished run with a known cost yet.', known: false }
  return { text: 'Weekly cost unknown', basis: 'Its timing cannot be counted into runs for the next 7 days.', known: false }
}

/** The header total; says how many schedules it leaves out. */
export function totalCostFigure(r: Partial<Pick<ScheduleCostReport, 'weeklyTotalUsd' | 'unknownCount'>> | undefined): CostFigure {
  if (!r || !isNum(r.weeklyTotalUsd)) return { text: 'Weekly cost unknown', basis: 'No schedule has a cost basis yet.', known: false }
  const k = isNum(r.unknownCount) ? r.unknownCount : 0
  const u = k > 0 ? ` The total excludes ${k} ${k === 1 ? 'schedule' : 'schedules'} with no history.` : ''
  return { text: `About ${usdText(r.weeklyTotalUsd)} a week${k > 0 ? ` (excl. ${k})` : ''}`, basis: `Sum of the schedules that are on, from their past runs.${u}`, known: true }
}

export type RunBarKind = 'finished' | 'error' | 'stopped' | 'needs-you' | 'running'
export interface RunBar {
  id: string
  at: number
  kind: RunBarKind
  costUsd: number | null
  /** Plain sentence for the text alternative and the readout. */
  label: string
}
export const RUN_BAR_COUNT = 7
const KIND_WORDS: Record<RunBarKind, string> = { finished: 'finished', error: 'failed', stopped: 'stopped', 'needs-you': 'needed you', running: 'still running' }

/** The newest RUN_BAR_COUNT started or failed entries, oldest first. Skipped slots are not runs. */
export function runBars(entries: readonly ScheduleHistoryEntry[] | undefined): RunBar[] {
  const runs = (entries ?? [])
    .filter((e) => e.result !== 'skipped')
    .sort((a, b) => b.at - a.at)
    .slice(0, RUN_BAR_COUNT)
    .reverse()
  return runs.map((e) => {
    const kind: RunBarKind = e.result === 'failed' ? 'error' : (e.outcome ?? 'running')
    const cost = isNum(e.costUsd) ? e.costUsd : null
    const when = new Date(e.at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    return { id: e.id, at: e.at, kind, costUsd: cost, label: `${when}: ${KIND_WORDS[kind]}, ${cost === null ? 'cost unknown' : usdText(cost)}` }
  })
}

export function runBarsSummary(bars: readonly RunBar[]): string {
  if (bars.length === 0) return 'No runs yet.'
  const failed = bars.filter((b) => b.kind === 'error').length
  return `Last ${bars.length} ${bars.length === 1 ? 'run' : 'runs'}${failed ? `, ${failed} failed` : ''}.`
}
