/**
 * Pure helpers of Schedules (docs/design/schedules.md section 3): cron parsing, timing validation, next-run search,
 * descriptions and input cleaning. No Node, DOM or renderer imports; local time comes from `Date` (the system zone).
 *
 * Semantics worth knowing:
 * - A slot is strictly after `after` (and after `lastSlotAt`, so a handled slot never fires twice).
 * - `interval` slots are anchor + k * everyMinutes for k >= 1 (the anchor is the save time, not a slot). Without an
 *   anchor the first slot is `after` + everyMinutes. Intervals are absolute durations, not wall-clock times.
 * - DST: a wall-clock time that does not exist that day (spring forward) fires at the first valid minute after the
 *   gap; a wall-clock time that occurs twice (fall back) fires once, at the first occurrence.
 * - Every search is bounded (SEARCH_DAYS, about five years) and returns null when nothing is found.
 */
import { hasHidden } from './view/hiddenChars'
import {
  SCHEDULE_BUDGET_MAX_USD,
  SCHEDULE_CRON_MAX_CHARS,
  SCHEDULE_MAX_INTERVAL_MINUTES,
  SCHEDULE_MIN_INTERVAL_MINUTES,
  SCHEDULE_NAME_MAX_CHARS,
  SCHEDULE_PERMISSION_MODES,
  SCHEDULE_PROMPT_MAX_CHARS
} from './types'
import type { PermissionMode, ScheduleMissedPolicy, ScheduleSaveInput, ScheduleTarget, ScheduleTiming } from './types'

const MINUTE_MS = 60_000
/** The search window for the next fire: five years of days. */
const SEARCH_DAYS = 5 * 366 + 2
/** The two closest fires of a cron are compared over four calendar years (2024 is a leap year). */
const GAP_SCAN_DAYS = 4 * 366 + 1
const GAP_SCAN_START = Date.UTC(2024, 0, 1)

// ---------- cron ----------

/** A parsed 5-field cron. Every list is sorted and unique; day of week 7 is folded into 0 (Sunday). */
export interface ParsedCron {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  /** The day-of-month field starts with '*' (Vixie: unrestricted). */
  domAny: boolean
  /** The day-of-week field starts with '*'. */
  dowAny: boolean
}

export type CronParseResult = { ok: true; cron: ParsedCron } | { ok: false; problem: string }

const FIELD_NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week'] as const
const FIELD_BOUNDS: readonly (readonly [number, number])[] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

function parseCronField(text: string, name: string, lo: number, hi: number): number[] | string {
  const out = new Set<number>()
  for (const item of text.split(',')) {
    if (item === '') return `The ${name} field has an empty entry.`
    const [rangePart, stepPart, ...extra] = item.split('/')
    if (extra.length > 0) return `The ${name} field has a bad step "${item}".`
    let step = 1
    if (stepPart !== undefined) {
      if (!/^\d{1,3}$/.test(stepPart) || Number(stepPart) < 1) return `The ${name} field has a bad step "${item}".`
      step = Number(stepPart)
    }
    let from: number
    let to: number
    if (rangePart === '*') {
      from = lo
      to = hi
    } else {
      const m = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(rangePart)
      if (!m) return `The ${name} field has "${item}", which is not a number, range or *. Names are not supported.`
      from = Number(m[1])
      to = m[2] === undefined ? from : Number(m[2])
      if (stepPart !== undefined && m[2] === undefined) return `The ${name} field has a step without a range: "${item}".`
      if (from < lo || to > hi) return `The ${name} field must be between ${lo} and ${hi}.`
      if (from > to) return `The ${name} field has a backwards range "${item}".`
    }
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Hand-written 5-field cron parser (minute hour day-of-month month day-of-week): `*`, lists, ranges and steps; names
 * are not supported. Day of week accepts 0-7 (0 and 7 are Sunday). Whether the expression fires often is not checked
 * here (see scheduleTimingProblem).
 */
export function parseCron(expression: string): CronParseResult {
  if (typeof expression !== 'string') return { ok: false, problem: 'The cron expression must be text.' }
  const text = expression.trim()
  if (text.length === 0) return { ok: false, problem: 'The cron expression is empty.' }
  if (text.length > SCHEDULE_CRON_MAX_CHARS) return { ok: false, problem: `The cron expression is longer than ${SCHEDULE_CRON_MAX_CHARS} characters.` }
  const fields = text.split(/[ \t]+/)
  if (fields.length !== 5) return { ok: false, problem: 'A cron expression has 5 fields: minute hour day-of-month month day-of-week.' }
  const lists: number[][] = []
  for (let i = 0; i < 5; i++) {
    const parsed = parseCronField(fields[i], FIELD_NAMES[i], FIELD_BOUNDS[i][0], FIELD_BOUNDS[i][1])
    if (typeof parsed === 'string') return { ok: false, problem: parsed }
    lists.push(parsed)
  }
  const dow = [...new Set(lists[4].map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b)
  return {
    ok: true,
    cron: {
      minutes: lists[0],
      hours: lists[1],
      daysOfMonth: lists[2],
      months: lists[3],
      daysOfWeek: dow,
      domAny: fields[2].startsWith('*'),
      dowAny: fields[4].startsWith('*')
    }
  }
}

/** Does the calendar day match? Vixie rule: when both day fields are restricted either matches, else both must. */
function cronDayMatches(c: ParsedCron, month1: number, dom: number, dow: number): boolean {
  if (!c.months.includes(month1)) return false
  const domOk = c.daysOfMonth.includes(dom)
  const dowOk = c.daysOfWeek.includes(dow)
  if (c.domAny && c.dowAny) return true
  if (c.domAny) return dowOk
  if (c.dowAny) return domOk
  return domOk || dowOk
}

// ---------- validation ----------

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function isFiniteTime(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15
}

/** The smallest gap in minutes between two fires of a cron over a fixed four-year calendar; null = never fires. */
function cronMinGapMinutes(c: ParsedCron): number | null {
  let min = Infinity
  let prev = -Infinity
  let any = false
  for (let day = 0; day < GAP_SCAN_DAYS; day++) {
    const d = new Date(GAP_SCAN_START + day * 86_400_000)
    if (!cronDayMatches(c, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) continue
    for (const h of c.hours) {
      for (const m of c.minutes) {
        const abs = day * 1440 + h * 60 + m
        any = true
        if (abs - prev < min) min = abs - prev
        if (min < SCHEDULE_MIN_INTERVAL_MINUTES) return min
        prev = abs
      }
    }
  }
  return any ? min : null
}

/** A readable sentence saying why the timing is not allowed, or null when it is. Does not look at the clock. */
export function scheduleTimingProblem(timing: ScheduleTiming): string | null {
  if (!timing || typeof timing !== 'object') return 'Choose when the schedule runs.'
  switch (timing.kind) {
    case 'once':
      return isFiniteTime(timing.at) ? null : 'Choose a date and time for the single run.'
    case 'interval': {
      const n = timing.everyMinutes
      if (typeof n !== 'number' || !Number.isInteger(n)) return 'The interval must be a whole number of minutes.'
      if (n < SCHEDULE_MIN_INTERVAL_MINUTES) return `The shortest interval is ${SCHEDULE_MIN_INTERVAL_MINUTES} minutes.`
      if (n > SCHEDULE_MAX_INTERVAL_MINUTES) return `The longest interval is ${SCHEDULE_MAX_INTERVAL_MINUTES / 1440} days.`
      if (timing.anchor !== undefined && !isFiniteTime(timing.anchor)) return 'The interval start time is not valid.'
      return null
    }
    case 'daily': {
      if (typeof timing.time !== 'string' || !TIME_RE.test(timing.time)) return 'The time of day must look like 09:30 (24-hour).'
      const days = timing.days
      if (days !== undefined) {
        if (!Array.isArray(days) || days.length > 7) return 'Choose weekdays from Sunday to Saturday.'
        if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Choose weekdays from Sunday to Saturday.'
        if (new Set(days).size !== days.length) return 'A weekday is listed twice.'
      }
      return null
    }
    case 'cron': {
      const parsed = parseCron(timing.expression)
      if (!parsed.ok) return parsed.problem
      const gap = cronMinGapMinutes(parsed.cron)
      if (gap === null) return 'That cron expression never matches a real date.'
      if (gap < SCHEDULE_MIN_INTERVAL_MINUTES) return `That cron expression can fire ${gap === 0 ? 'more than once a minute' : `${gap} minute${gap === 1 ? '' : 's'} apart`}; the shortest allowed gap is ${SCHEDULE_MIN_INTERVAL_MINUTES} minutes.`
      return null
    }
    default:
      return 'Choose when the schedule runs.'
  }
}

// ---------- next run ----------

/** The instant of a local wall-clock time; a time inside a spring-forward gap resolves to the first valid minute after it. */
function resolveLocal(y: number, mo: number, d: number, h: number, mi: number): number {
  const c = new Date(y, mo, d, h, mi, 0, 0)
  const target = Date.UTC(y, mo, d, h, mi)
  const wall = (t: number): number => {
    const x = new Date(t)
    return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate(), x.getHours(), x.getMinutes())
  }
  let t = c.getTime()
  // A normal or repeated time already reads back as the target. Only a gap time reads back later: step back to the gap's end.
  if (wall(t) > target) {
    for (let i = 0; i < 24 * 60 && wall(t - MINUTE_MS) >= target; i++) t -= MINUTE_MS
  }
  return t
}

/** The first slot after `after` over a bounded run of local calendar days; `times` are [hour, minute] pairs, ascending. */
function searchDays(
  after: number,
  matchDay: (month1: number, dom: number, dow: number) => boolean,
  times: readonly (readonly [number, number])[]
): number | null {
  const start = new Date(after)
  const y = start.getFullYear()
  const mo = start.getMonth()
  const d0 = start.getDate()
  for (let off = 0; off < SEARCH_DAYS; off++) {
    // Midnight may not exist in some zones; only the date fields are read, so any instant of that day will do.
    const day = new Date(y, mo, d0 + off, 12, 0, 0, 0)
    if (!matchDay(day.getMonth() + 1, day.getDate(), day.getDay())) continue
    let best: number | null = null
    for (const [h, m] of times) {
      const t = resolveLocal(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
      if (t > after && (best === null || t < best)) best = t
    }
    if (best !== null) return best
  }
  return null
}

/**
 * The first slot strictly after `after` (epoch ms), in local time, or null when there is none (a past `once`, an
 * invalid timing, or nothing within about five years). `lastSlotAt` pushes the search past a slot already handled.
 */
export function nextScheduleRun(timing: ScheduleTiming, after: number, lastSlotAt?: number): number | null {
  if (!Number.isFinite(after) || scheduleTimingProblem(timing) !== null) return null
  const from = typeof lastSlotAt === 'number' && Number.isFinite(lastSlotAt) ? Math.max(after, lastSlotAt) : after
  switch (timing.kind) {
    case 'once':
      return timing.at > from ? timing.at : null
    case 'interval': {
      const step = timing.everyMinutes * MINUTE_MS
      const anchor = timing.anchor ?? from
      if (from < anchor) return anchor + step
      return anchor + (Math.floor((from - anchor) / step) + 1) * step
    }
    case 'daily': {
      const m = TIME_RE.exec(timing.time)
      if (!m) return null
      const days = timing.days && timing.days.length > 0 ? timing.days : null
      return searchDays(from, (_mo, _dom, dow) => days === null || days.includes(dow), [[Number(m[1]), Number(m[2])]])
    }
    case 'cron': {
      const parsed = parseCron(timing.expression)
      if (!parsed.ok) return null
      const c = parsed.cron
      const times: [number, number][] = []
      for (const h of c.hours) for (const mi of c.minutes) times.push([h, mi])
      return searchDays(from, (mo, dom, dow) => cronDayMatches(c, mo, dom, dow), times)
    }
  }
}

/** The next `count` (at most 5) slots after `after`. Fewer when the timing runs out. */
export function upcomingScheduleRuns(timing: ScheduleTiming, after: number, count: number): number[] {
  const n = Math.max(0, Math.min(5, Math.floor(Number.isFinite(count) ? count : 0)))
  const out: number[] = []
  let cursor = after
  for (let i = 0; i < n; i++) {
    const next = nextScheduleRun(timing, cursor)
    if (next === null) break
    out.push(next)
    cursor = next
  }
  return out
}

// ---------- description ----------

const pad2 = (n: number): string => String(n).padStart(2, '0')

function weekdayName(dow: number, style: 'long' | 'short', locale: string): string {
  // 2024-01-07 was a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + dow)))
}

/** A plain description of a timing: "Every day at 00:00", "Weekdays at 09:30", "Every 2 hours", "Cron: 0 0 * * 1". */
export function describeScheduleTiming(timing: ScheduleTiming, locale?: string): string {
  const loc = locale || 'en-GB'
  switch (timing.kind) {
    case 'once': {
      const d = new Date(timing.at)
      const date = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
      return `Once on ${date} at ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }
    case 'interval': {
      const n = timing.everyMinutes
      if (n % 1440 === 0) return n === 1440 ? 'Every day' : `Every ${n / 1440} days`
      if (n % 60 === 0) return n === 60 ? 'Every hour' : `Every ${n / 60} hours`
      return `Every ${n} minutes`
    }
    case 'daily': {
      const days = [...new Set(timing.days ?? [])].sort((a, b) => a - b)
      const key = days.join(',')
      if (days.length === 0 || days.length === 7) return `Every day at ${timing.time}`
      if (key === '1,2,3,4,5') return `Weekdays at ${timing.time}`
      if (key === '0,6') return `Weekends at ${timing.time}`
      if (days.length === 1) return `Every ${weekdayName(days[0], 'long', loc)} at ${timing.time}`
      // Monday first, Sunday last, like a work week.
      const ordered = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => weekdayName(d, 'short', loc))
      const list = ordered.length > 1 ? `${ordered.slice(0, -1).join(', ')} and ${ordered[ordered.length - 1]}` : ordered[0]
      return `${list} at ${timing.time}`
    }
    case 'cron':
      return `Cron: ${timing.expression.trim().replace(/\s+/g, ' ')}`
  }
}

// ---------- input cleaning ----------

export type CleanScheduleResult = { ok: true; value: ScheduleSaveInput } | { ok: false; problem: string }

const fail = (problem: string): CleanScheduleResult => ({ ok: false, problem })
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/
const SCHEDULE_ID_RE = /^sch_[0-9a-f]{4,64}$/
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const SCHEDULE_FOLDER_MAX_CHARS = 1024
const SCHEDULE_MODEL_MAX_CHARS = 200

function cleanTarget(raw: unknown): ScheduleTarget | string {
  if (!isRecord(raw)) return 'Choose what the schedule runs.'
  if (raw.kind === 'team') {
    if (typeof raw.projectId !== 'string' || !PROJECT_ID_RE.test(raw.projectId)) return 'Choose a project for the team run.'
    if (raw.team !== undefined && raw.team !== 'single') return 'The team option can only be a single assistant.'
    return raw.team === 'single' ? { kind: 'team', projectId: raw.projectId, team: 'single' } : { kind: 'team', projectId: raw.projectId }
  }
  if (raw.kind === 'ask') {
    const out: { kind: 'ask'; folder?: string; allowEdits?: boolean } = { kind: 'ask' }
    if (raw.folder !== undefined && raw.folder !== null && raw.folder !== '') {
      if (typeof raw.folder !== 'string' || raw.folder.length > SCHEDULE_FOLDER_MAX_CHARS) return 'The folder path is not valid.'
      if (CONTROL.test(raw.folder) || hasHidden(raw.folder)) return 'The folder path has characters that cannot be shown.'
      out.folder = raw.folder
    }
    if (raw.allowEdits !== undefined) {
      if (typeof raw.allowEdits !== 'boolean') return 'Allow edits must be on or off.'
      out.allowEdits = raw.allowEdits
    }
    return out
  }
  return 'Choose what the schedule runs.'
}

function cleanTiming(raw: unknown): ScheduleTiming | string {
  if (!isRecord(raw)) return 'Choose when the schedule runs.'
  let timing: ScheduleTiming
  switch (raw.kind) {
    case 'once':
      timing = { kind: 'once', at: raw.at as number }
      break
    case 'interval':
      timing = raw.anchor === undefined || raw.anchor === null
        ? { kind: 'interval', everyMinutes: raw.everyMinutes as number }
        : { kind: 'interval', everyMinutes: raw.everyMinutes as number, anchor: raw.anchor as number }
      break
    case 'daily': {
      const days = raw.days
      if (days !== undefined && days !== null && !Array.isArray(days)) return 'Choose weekdays from Sunday to Saturday.'
      timing = Array.isArray(days) && days.length > 0
        ? { kind: 'daily', time: raw.time as string, days: [...(days as number[])].sort((a, b) => a - b) }
        : { kind: 'daily', time: raw.time as string }
      break
    }
    case 'cron':
      timing = { kind: 'cron', expression: typeof raw.expression === 'string' ? raw.expression.trim().replace(/[ \t]+/g, ' ') : (raw.expression as string) }
      break
    default:
      return 'Choose when the schedule runs.'
  }
  return scheduleTimingProblem(timing) ?? timing
}

/**
 * Shape and limit checks shared by IPC and the proposal tool. Rebuilds the input from known fields only (anything else
 * is dropped), trims the name and prompt, and returns the first problem as a sentence or the cleaned value. `null` on
 * modelSelection, permissionMode, budgetUsd and expiresAt is kept (it clears the field on update). Does not know
 * projects, folders on disk, models or the clock: main checks those.
 */
export function cleanScheduleInput(input: unknown): CleanScheduleResult {
  if (!isRecord(input)) return fail('The schedule is missing.')
  const out: Partial<ScheduleSaveInput> = {}

  if (input.id !== undefined && input.id !== null) {
    if (typeof input.id !== 'string' || !SCHEDULE_ID_RE.test(input.id)) return fail('That schedule id is not valid.')
    out.id = input.id
  }

  if (typeof input.name !== 'string') return fail('Give the schedule a name.')
  const name = input.name.trim()
  if (name.length === 0) return fail('Give the schedule a name.')
  if (name.length > SCHEDULE_NAME_MAX_CHARS) return fail(`The name can be at most ${SCHEDULE_NAME_MAX_CHARS} characters.`)
  if (hasHidden(name) || CONTROL.test(name)) return fail('The name has characters that cannot be shown. Use plain text on one line.')
  out.name = name

  if (typeof input.prompt !== 'string') return fail('Say what the schedule should do.')
  const prompt = input.prompt.trim()
  if (prompt.length === 0) return fail('Say what the schedule should do.')
  if (prompt.length > SCHEDULE_PROMPT_MAX_CHARS) return fail(`The instructions can be at most ${SCHEDULE_PROMPT_MAX_CHARS} characters.`)
  if (hasHidden(prompt)) return fail('The instructions have characters that cannot be shown. Remove them and try again.')
  out.prompt = prompt

  const target = cleanTarget(input.target)
  if (typeof target === 'string') return fail(target)
  out.target = target

  const timing = cleanTiming(input.timing)
  if (typeof timing === 'string') return fail(timing)
  out.timing = timing

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return fail('Enabled must be on or off.')
    out.enabled = input.enabled
  }
  if (input.missed !== undefined) {
    const missed: unknown = input.missed
    if (missed !== 'run-once' && missed !== 'skip') return fail('Choose what to do with a missed run: run once or skip.')
    out.missed = missed as ScheduleMissedPolicy
  }

  if (input.modelSelection !== undefined) {
    if (input.modelSelection === null) out.modelSelection = null
    else {
      const m = input.modelSelection
      const ok = isRecord(m) && typeof m.model === 'string' && typeof m.connection === 'string'
      if (!ok) return fail('The model choice is not valid.')
      const model = (m.model as string).trim()
      const connection = (m.connection as string).trim()
      if (!model || !connection || model.length > SCHEDULE_MODEL_MAX_CHARS || connection.length > SCHEDULE_MODEL_MAX_CHARS) return fail('The model choice is not valid.')
      if (hasHidden(model) || hasHidden(connection) || CONTROL.test(model) || CONTROL.test(connection)) return fail('The model choice has characters that cannot be shown.')
      out.modelSelection = { model, connection }
    }
  }

  if (input.permissionMode !== undefined) {
    if (input.permissionMode === null) out.permissionMode = null
    else if (input.permissionMode === 'bypassPermissions') return fail('A schedule cannot run with bypass permissions. Choose another permission mode.')
    else if (typeof input.permissionMode !== 'string' || !(SCHEDULE_PERMISSION_MODES as readonly string[]).includes(input.permissionMode)) return fail('Choose a valid permission mode.')
    else out.permissionMode = input.permissionMode as PermissionMode
  }

  if (input.budgetUsd !== undefined) {
    if (input.budgetUsd === null) out.budgetUsd = null
    else if (typeof input.budgetUsd !== 'number' || !Number.isFinite(input.budgetUsd) || input.budgetUsd <= 0) return fail('The spend cap must be more than $0.')
    else if (input.budgetUsd > SCHEDULE_BUDGET_MAX_USD) return fail(`The spend cap can be at most $${SCHEDULE_BUDGET_MAX_USD.toLocaleString('en-US')} per run.`)
    else out.budgetUsd = input.budgetUsd
  }

  if (input.expiresAt !== undefined) {
    if (input.expiresAt === null) out.expiresAt = null
    else if (!isFiniteTime(input.expiresAt)) return fail('The end date is not valid.')
    else out.expiresAt = input.expiresAt
  }

  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== null) {
    if (typeof input.expectedUpdatedAt !== 'number' || !Number.isFinite(input.expectedUpdatedAt)) return fail('The expected update time is not valid.')
    out.expectedUpdatedAt = input.expectedUpdatedAt
  }

  return { ok: true, value: out as ScheduleSaveInput }
}
