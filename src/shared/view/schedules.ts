/**
 * View-models of the Schedules page, its editor and the schedules proposal card (docs/design/schedules.md section 5).
 * Pure: no React, DOM or renderer imports, so a CLI could reuse the wording. Times are the system's local time.
 *
 * - Row: target, timing, next run (relative + absolute), state chip, last result and the unread mark.
 * - History: every ScheduleRunResult, ScheduleSkipReason, trigger and outcome in words; cost unknown is never $0.
 * - Editor: ScheduleForm <-> ScheduleSaveInput, with presets (Daily / Weekdays / Weekly -> 'daily' with days,
 *   Every -> 'interval', Once -> 'once', Custom -> 'cron'), field problems and the final cleanScheduleInput check.
 */
import type {
  ConnectionId,
  PermissionMode,
  Schedule,
  ScheduleHistoryEntry,
  ScheduleMissedPolicy,
  ScheduleProposalItem,
  ScheduleRunResult,
  ScheduleSaveInput,
  ScheduleSkipReason,
  ScheduleTarget,
  ScheduleTiming
} from '../types'
import { SCHEDULE_BUDGET_MAX_USD, SCHEDULE_FAILURES_TO_PAUSE, SCHEDULE_MAX_CONCURRENT_RUNS, SCHEDULE_PERMISSION_MODES, runPermissionModeChoices } from '../types'
import { cleanScheduleInput, describeScheduleTiming, scheduleTimingProblem, upcomingScheduleRuns } from '../schedule'
import { formatDateTime, formatFullDateTime } from './dates'
import type { CostInput } from './cost'

// ---------- plain sentences (spec section 5) ----------

export const SCHEDULE_UNATTENDED_NOTE = 'Runs only while OrgAI is open. Each run uses tokens.'
export const SCHEDULE_APPROVAL_NOTE = 'If a step needs your approval the run waits for you.'
export const SCHEDULES_EMPTY_HINT = "Ask in Chat, for example: 'Review new pull requests every night at midnight'"
export const SCHEDULES_PAUSED_BANNER = 'All schedules are paused. Nothing runs until you turn this off; due times are recorded as skipped.'

// ---------- time words ----------

const MINUTE = 60_000

/** "in under a minute", "in 5 min", "in 3 h", "in 2 d"; a time already due reads "due now". */
export function relativeUntil(at: number, now: number): string {
  const ms = at - now
  if (ms <= 0) return 'due now'
  if (ms < MINUTE) return 'in under a minute'
  const m = Math.round(ms / MINUTE)
  if (m < 60) return `in ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `in ${h} h`
  return `in ${Math.round(h / 24)} d`
}

export interface NextRunView {
  /** "in 3 h", or the reason nothing is due ("Paused", "Not scheduled"). */
  relative: string
  /** "14 Nov 2026 08:00", '' when nothing is due. */
  absolute: string
  /** The full local date and time, for a title. */
  title: string
  /** True when a time is shown. */
  due: boolean
}

/** The next run of a row. `globalPaused` (AppSettings.schedulesPaused) holds every schedule. */
export function nextRunView(s: Pick<Schedule, 'nextRunAt' | 'enabled' | 'state'>, now: number, globalPaused = false): NextRunView {
  if (s.state === 'done') return { relative: 'No more runs', absolute: '', title: '', due: false }
  if (!s.enabled || s.state === 'paused' || s.state === 'error') return { relative: 'Not scheduled while paused', absolute: '', title: '', due: false }
  if (typeof s.nextRunAt !== 'number' || !Number.isFinite(s.nextRunAt)) return { relative: 'Not scheduled', absolute: '', title: '', due: false }
  const absolute = formatDateTime(s.nextRunAt)
  if (globalPaused) return { relative: 'Held: all schedules paused', absolute, title: formatFullDateTime(s.nextRunAt), due: false }
  return { relative: relativeUntil(s.nextRunAt, now), absolute, title: formatFullDateTime(s.nextRunAt), due: true }
}

// ---------- state chip ----------

export type ScheduleChipTone = 'success' | 'neutral' | 'warning' | 'info'
export interface ScheduleChip {
  label: 'Active' | 'Paused' | 'Needs attention' | 'Done'
  tone: ScheduleChipTone
  /** One plain sentence (stateReason or a default), for 'Needs attention' and 'Done'. */
  reason?: string
}

export function scheduleChip(s: Pick<Schedule, 'state' | 'enabled' | 'stateReason'>): ScheduleChip {
  const reason = typeof s.stateReason === 'string' && s.stateReason.trim() ? s.stateReason.trim() : undefined
  switch (s.state) {
    case 'error':
      return { label: 'Needs attention', tone: 'warning', reason: reason ?? `Paused after ${SCHEDULE_FAILURES_TO_PAUSE} failed runs in a row. Check it, then resume.` }
    case 'done':
      return { label: 'Done', tone: 'neutral', reason: reason ?? 'This schedule has no more runs.' }
    case 'paused':
      return { label: 'Paused', tone: 'neutral' }
    default:
      return s.enabled ? { label: 'Active', tone: 'success' } : { label: 'Paused', tone: 'neutral' }
  }
}

/** Pause / Resume label of the row action; Done schedules resume only after an edit (no next run), so they offer none. */
export function toggleAction(s: Pick<Schedule, 'state' | 'enabled'>): 'Pause' | 'Resume' | null {
  if (s.state === 'done') return null
  return s.enabled && s.state === 'active' ? 'Pause' : 'Resume'
}

// ---------- target ----------

export interface ProjectRef {
  id: string
  name: string
}

/** "Team run on Notes API", "One assistant on Notes API", "Chat in reports", "Chat (scratch folder)". */
export function targetText(target: ScheduleTarget, projects: readonly ProjectRef[], folderName: (p: string) => string = baseName): string {
  if (target.kind === 'team') {
    const name = projects.find((p) => p.id === target.projectId)?.name
    const where = name ? name : 'a project that no longer exists'
    return target.team === 'single' ? `One assistant on ${where}` : `Team run on ${where}`
  }
  const edits = target.allowEdits ? ', can change files' : ''
  return target.folder ? `Chat in ${folderName(target.folder)}${edits}` : `Chat (scratch folder${edits})`
}

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || p
}

// ---------- history wording ----------

export const SKIP_REASON_TEXT: Readonly<Record<ScheduleSkipReason, string>> = {
  'previous-running': 'Skipped: the previous run was still going.',
  'too-many-running': `Skipped: ${SCHEDULE_MAX_CONCURRENT_RUNS} scheduled runs were already going.`,
  'app-closed': 'Skipped: OrgAI was closed or the computer was asleep.',
  'paused-globally': 'Skipped: all schedules were paused.',
  'project-missing': 'Skipped: the project no longer exists.',
  'usage-limited': 'Skipped: a usage limit was reached.',
  'start-refused': 'Skipped: OrgAI could not start the run.'
}

export const TRIGGER_TEXT: Readonly<Record<ScheduleHistoryEntry['trigger'], string>> = {
  timer: 'On schedule',
  'catch-up': 'Missed run, caught up',
  manual: 'Run now'
}

/** Run status words of lib/runStatus (Finished / Failed / Stopped / Needs you). */
export const OUTCOME_TEXT: Readonly<Record<NonNullable<ScheduleHistoryEntry['outcome']>, string>> = {
  finished: 'Finished',
  error: 'Failed',
  stopped: 'Stopped',
  'needs-you': 'Needs you'
}

/** The result of one entry in words; a detail (OrgAI-written) follows a refusal or a failure. */
export function resultText(e: Pick<ScheduleHistoryEntry, 'result' | 'reason' | 'detail'>): string {
  const detail = typeof e.detail === 'string' && e.detail.trim() ? ` ${e.detail.trim()}` : ''
  switch (e.result as ScheduleRunResult) {
    case 'started':
      return 'Started'
    case 'skipped':
      return (e.reason ? SKIP_REASON_TEXT[e.reason] ?? 'Skipped.' : 'Skipped.') + (e.reason === 'start-refused' ? detail : '')
    case 'failed':
      return `Could not start.${detail}`
    default:
      return 'Unknown result'
  }
}

/** The short result word for a badge. */
export function resultWord(r: ScheduleRunResult): 'Started' | 'Skipped' | 'Failed' {
  return r === 'started' ? 'Started' : r === 'skipped' ? 'Skipped' : 'Failed'
}

/** Why a slot did not start, without the leading word (it sits beside resultWord): '' for a started entry. */
export function resultWhy(e: Pick<ScheduleHistoryEntry, 'result' | 'reason' | 'detail'>): string {
  if (e.result === 'started') return ''
  const full = resultText(e)
  const rest = full.replace(/^(Skipped:|Could not start\.)\s*/, '')
  if (!rest) return e.result === 'failed' ? 'OrgAI could not start the run.' : ''
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

/** The outcome of a started run: its end word, "Running" before it ends, '' for entries without a run. */
export function outcomeText(e: Pick<ScheduleHistoryEntry, 'result' | 'outcome' | 'runId'>): string {
  if (e.outcome) return OUTCOME_TEXT[e.outcome] ?? ''
  return e.result === 'started' && e.runId ? 'Running' : ''
}

/** The cost of an entry for ui/Cost: null = unknown (never $0); absent = not ended or no run (no figure). */
export function historyCost(e: Pick<ScheduleHistoryEntry, 'costUsd' | 'outcome'>): CostInput | null {
  if (e.costUsd === undefined) return null
  if (e.costUsd === null || !Number.isFinite(e.costUsd)) return { costUsd: null, costSource: 'unknown' }
  // The entry does not say who priced it: 'provider' + sourceMixed reads "reported by the provider or computed by OrgAI".
  return { costUsd: e.costUsd, costSource: 'provider', sourceMixed: true }
}

export interface HistoryRowView {
  id: string
  when: string
  whenTitle: string
  trigger: string
  result: string
  tone: 'success' | 'neutral' | 'warning' | 'danger'
  outcome: string
  cost: CostInput | null
  runId?: string
  projectId?: string
}

export function historyRow(e: ScheduleHistoryEntry): HistoryRowView {
  const tone = e.result === 'failed' || e.outcome === 'error' ? 'danger' : e.result === 'skipped' || e.outcome === 'needs-you' ? 'warning' : e.result === 'started' ? 'success' : 'neutral'
  return {
    id: e.id,
    when: formatDateTime(e.at),
    whenTitle: e.slotAt !== e.at && e.slotAt > 0 ? `Due ${formatFullDateTime(e.slotAt)}; handled ${formatFullDateTime(e.at)}` : formatFullDateTime(e.at),
    trigger: TRIGGER_TEXT[e.trigger] ?? '',
    result: resultText(e),
    tone,
    outcome: outcomeText(e),
    cost: historyCost(e),
    ...(e.runId ? { runId: e.runId } : {}),
    ...(e.projectId ? { projectId: e.projectId } : {})
  }
}

/** Newest first (the IPC already sorts; this keeps a merged or pushed list right). */
export function sortHistory(entries: readonly ScheduleHistoryEntry[]): ScheduleHistoryEntry[] {
  return [...entries].sort((a, b) => b.at - a.at)
}

/** The row's "Last result" line: the newest entry when main sends it, else what the schedule itself knows. */
export function lastResultText(s: Pick<Schedule, 'lastEntry' | 'lastSlotAt' | 'consecutiveFailures'>): string {
  const e = s.lastEntry
  if (e) {
    const out = outcomeText(e)
    const res = e.result === 'started' ? (out ? `${out}` : 'Started') : resultText(e)
    return `${res} · ${formatDateTime(e.at)}`
  }
  if (s.consecutiveFailures > 0) return `${s.consecutiveFailures} failed in a row`
  if (typeof s.lastSlotAt === 'number' && s.lastSlotAt > 0) return `Last due ${formatDateTime(s.lastSlotAt)}`
  return 'Not run yet'
}

// ---------- row ----------

export interface ScheduleRowView {
  id: string
  name: string
  target: string
  timing: string
  next: NextRunView
  chip: ScheduleChip
  lastResult: string
  unread: number
  toggle: 'Pause' | 'Resume' | null
  /** Main-written name of the creator, for a quiet "Added from a chat" mark. */
  fromAgent: boolean
}

export function scheduleRow(s: Schedule, ctx: { now: number; projects: readonly ProjectRef[]; globalPaused?: boolean; folderName?: (p: string) => string }): ScheduleRowView {
  return {
    id: s.id,
    name: s.name,
    target: targetText(s.target, ctx.projects, ctx.folderName),
    timing: safeDescribe(s.timing),
    next: nextRunView(s, ctx.now, !!ctx.globalPaused),
    chip: scheduleChip(s),
    lastResult: lastResultText(s),
    unread: Math.max(0, Math.floor(s.unread || 0)),
    toggle: toggleAction(s),
    fromAgent: s.createdBy === 'agent'
  }
}

/** describeScheduleTiming that never throws on a malformed stored timing. */
export function safeDescribe(t: ScheduleTiming): string {
  try {
    return scheduleTimingProblem(t) === null || t.kind === 'once' ? describeScheduleTiming(t) : 'Timing not valid'
  } catch {
    return 'Timing not valid'
  }
}

/** Rows in name order (the IPC order), case-insensitive. */
export function scheduleRows(list: readonly Schedule[], ctx: Parameters<typeof scheduleRow>[1]): ScheduleRowView[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map((s) => scheduleRow(s, ctx))
}

// ---------- editor ----------

export type TimingPreset = 'daily' | 'weekdays' | 'weekly' | 'every' | 'once' | 'custom'
export const TIMING_PRESETS: readonly { value: TimingPreset; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'every', label: 'Every few hours' },
  { value: 'once', label: 'Once' },
  { value: 'custom', label: 'Custom (cron)' }
]
export type EveryUnit = 'minutes' | 'hours'

export interface ScheduleForm {
  /** Set when editing. */
  id?: string
  /** The stored schedule's updatedAt when the form loaded it (expectedUpdatedAt). */
  loadedUpdatedAt?: number
  name: string
  prompt: string
  targetKind: 'team' | 'ask'
  projectId: string
  /** Team target: one assistant instead of the org chart. */
  single: boolean
  /** Ask target: '' = a scratch folder per run. */
  folder: string
  allowEdits: boolean
  preset: TimingPreset
  /** 'HH:MM' for daily / weekdays / weekly. */
  time: string
  /** Weekly: the chosen weekdays (0 = Sunday). */
  days: number[]
  everyCount: string
  everyUnit: EveryUnit
  /** Once: 'YYYY-MM-DD' and 'HH:MM' local. */
  onceDate: string
  onceTime: string
  cron: string
  missed: ScheduleMissedPolicy
  /** null = the project's / Chat's default. */
  model: { model: string; connection: ConnectionId } | null
  /** '' = the project's mode. */
  permissionMode: PermissionMode | ''
  /** '' = no cap of its own. */
  budget: string
  /** Kept from the stored schedule (the form does not edit it). */
  enabled: boolean
  /** The stored interval anchor, kept while the interval is unchanged. */
  anchor?: { everyMinutes: number; anchor: number }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')
export const localDateValue = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
export const localTimeValue = (ms: number): string => {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
/** 'YYYY-MM-DD' + 'HH:MM' local -> epoch ms, or null. */
export function localInstant(date: string, time: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const tm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
  if (!dm || !tm) return null
  const t = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]), 0, 0)
  if (t.getMonth() !== Number(dm[2]) - 1) return null
  return t.getTime()
}

/** A blank form: Daily at 09:00, a team run on the first project (else Chat), missed runs caught up once. */
export function newScheduleForm(opts: { projectId?: string; now: number }): ScheduleForm {
  const tomorrow = opts.now + 24 * 60 * MINUTE
  return {
    name: '',
    prompt: '',
    targetKind: opts.projectId ? 'team' : 'ask',
    projectId: opts.projectId ?? '',
    single: false,
    folder: '',
    allowEdits: false,
    preset: 'daily',
    time: '09:00',
    days: [1],
    everyCount: '4',
    everyUnit: 'hours',
    onceDate: localDateValue(tomorrow),
    onceTime: '09:00',
    cron: '0 9 * * 1-5',
    missed: 'run-once',
    model: null,
    permissionMode: '',
    budget: '',
    enabled: true
  }
}

const sameDays = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i])

/** The form for a stored schedule (Edit). */
export function scheduleToForm(s: Schedule, now: number): ScheduleForm {
  const base = newScheduleForm({ now })
  const f: ScheduleForm = {
    ...base,
    id: s.id,
    loadedUpdatedAt: s.updatedAt,
    name: s.name,
    prompt: s.prompt,
    targetKind: s.target.kind,
    projectId: s.target.kind === 'team' ? s.target.projectId : '',
    single: s.target.kind === 'team' && s.target.team === 'single',
    folder: s.target.kind === 'ask' ? (s.target.folder ?? '') : '',
    allowEdits: s.target.kind === 'ask' && !!s.target.allowEdits,
    missed: s.missed === 'skip' ? 'skip' : 'run-once',
    model: s.modelSelection ? { model: s.modelSelection.model, connection: s.modelSelection.connection } : null,
    permissionMode: s.permissionMode && (SCHEDULE_PERMISSION_MODES as readonly string[]).includes(s.permissionMode) ? s.permissionMode : '',
    budget: typeof s.budgetUsd === 'number' ? String(s.budgetUsd) : '',
    enabled: s.enabled
  }
  const t = s.timing
  switch (t.kind) {
    case 'daily': {
      const days = [...new Set(t.days ?? [])].sort((a, b) => a - b)
      f.time = t.time
      if (days.length === 0 || days.length === 7) f.preset = 'daily'
      else if (sameDays(days, [1, 2, 3, 4, 5])) f.preset = 'weekdays'
      else {
        f.preset = 'weekly'
        f.days = days
      }
      break
    }
    case 'interval':
      f.preset = 'every'
      if (t.everyMinutes % 60 === 0) {
        f.everyCount = String(t.everyMinutes / 60)
        f.everyUnit = 'hours'
      } else {
        f.everyCount = String(t.everyMinutes)
        f.everyUnit = 'minutes'
      }
      if (typeof t.anchor === 'number') f.anchor = { everyMinutes: t.everyMinutes, anchor: t.anchor }
      break
    case 'once':
      f.preset = 'once'
      f.onceDate = localDateValue(t.at)
      f.onceTime = localTimeValue(t.at)
      break
    case 'cron':
      f.preset = 'custom'
      f.cron = t.expression
      break
  }
  return f
}

/** The timing the form describes, or a sentence saying what is missing. */
export function formTiming(f: ScheduleForm): ScheduleTiming | string {
  switch (f.preset) {
    case 'daily':
      return { kind: 'daily', time: f.time }
    case 'weekdays':
      return { kind: 'daily', time: f.time, days: [1, 2, 3, 4, 5] }
    case 'weekly': {
      const days = [...new Set(f.days)].sort((a, b) => a - b)
      if (days.length === 0) return 'Choose at least one day.'
      return days.length === 7 ? { kind: 'daily', time: f.time } : { kind: 'daily', time: f.time, days }
    }
    case 'every': {
      const n = Number(f.everyCount.trim())
      if (!f.everyCount.trim() || !Number.isFinite(n) || n <= 0) return 'Enter how often, as a number.'
      const minutes = f.everyUnit === 'hours' ? Math.round(n * 60) : n
      if (!Number.isInteger(minutes)) return 'Enter a whole number of minutes.'
      return f.anchor && f.anchor.everyMinutes === minutes ? { kind: 'interval', everyMinutes: minutes, anchor: f.anchor.anchor } : { kind: 'interval', everyMinutes: minutes }
    }
    case 'once': {
      const at = localInstant(f.onceDate, f.onceTime)
      return at === null ? 'Choose a date and time for the single run.' : { kind: 'once', at }
    }
    case 'custom':
      return { kind: 'cron', expression: f.cron.trim().replace(/[ \t]+/g, ' ') }
  }
}

/**
 * The permission modes a schedule may choose for its target: a team run takes every work-run mode, a Chat run only the
 * modes Chat runs accept (runPermissionModeChoices: default, dontAsk, plan); never bypass.
 */
export function schedulePermissionChoices(targetKind: ScheduleTarget['kind']): PermissionMode[] {
  const allowed = runPermissionModeChoices(targetKind === 'ask' ? { kind: 'work', quick: { scratch: true } as never } : { kind: 'work' })
  return allowed.filter((m) => (SCHEDULE_PERMISSION_MODES as readonly string[]).includes(m))
}

export type FormField = 'name' | 'prompt' | 'project' | 'folder' | 'timing' | 'permission' | 'budget'
export type FormProblems = Partial<Record<FormField, string>>

/** Per-field problems, live. `now` is used only for a single run in the past (main checks it again). */
export function formProblems(f: ScheduleForm, now: number): FormProblems {
  const out: FormProblems = {}
  if (!f.name.trim()) out.name = 'Give the schedule a name.'
  if (!f.prompt.trim()) out.prompt = 'Say what the schedule should do.'
  if (f.targetKind === 'team' && !f.projectId) out.project = 'Choose a project for the team run.'
  const timing = formTiming(f)
  if (typeof timing === 'string') out.timing = timing
  else {
    const p = scheduleTimingProblem(timing)
    if (p) out.timing = p
    else if (timing.kind === 'once' && timing.at <= now) out.timing = 'Choose a time in the future.'
  }
  if (f.permissionMode && !schedulePermissionChoices(f.targetKind).includes(f.permissionMode)) {
    out.permission = f.targetKind === 'ask' ? 'Chat runs cannot use that permission mode. Choose another.' : 'Choose a valid permission mode.'
  }
  const b = f.budget.trim()
  if (b) {
    const n = Number(b.replace(/^\$/, ''))
    if (!Number.isFinite(n) || n <= 0) out.budget = 'The spend cap must be more than $0.'
    else if (n > SCHEDULE_BUDGET_MAX_USD) out.budget = `The spend cap can be at most $${SCHEDULE_BUDGET_MAX_USD.toLocaleString('en-US')} per run.`
  }
  return out
}

export type FormResult = { ok: true; value: ScheduleSaveInput } | { ok: false; problem: string; field?: FormField }

/**
 * The save input of a form. Create omits empty optional fields; edit sends `null` to clear a field the stored schedule
 * had, and `expectedUpdatedAt`. Every value goes through cleanScheduleInput last (the same check main runs).
 */
export function formToSaveInput(f: ScheduleForm, now: number, original?: Pick<Schedule, 'modelSelection' | 'permissionMode' | 'budgetUsd'>): FormResult {
  const problems = formProblems(f, now)
  const first = (Object.keys(problems) as FormField[])[0]
  if (first) return { ok: false, problem: problems[first] as string, field: first }
  const timing = formTiming(f) as ScheduleTiming
  const target: ScheduleTarget =
    f.targetKind === 'team'
      ? f.single
        ? { kind: 'team', projectId: f.projectId, team: 'single' }
        : { kind: 'team', projectId: f.projectId }
      : { kind: 'ask', ...(f.folder.trim() ? { folder: f.folder.trim() } : {}), ...(f.allowEdits ? { allowEdits: true } : {}) }
  const editing = !!f.id
  const input: ScheduleSaveInput = { name: f.name, prompt: f.prompt, target, timing, missed: f.missed }
  if (editing) {
    input.id = f.id
    if (typeof f.loadedUpdatedAt === 'number') input.expectedUpdatedAt = f.loadedUpdatedAt
  } else input.enabled = true
  if (f.model) input.modelSelection = { model: f.model.model, connection: f.model.connection }
  else if (editing && original?.modelSelection) input.modelSelection = null
  if (f.permissionMode) input.permissionMode = f.permissionMode
  else if (editing && original?.permissionMode) input.permissionMode = null
  const b = f.budget.trim()
  if (b) input.budgetUsd = Number(b.replace(/^\$/, ''))
  else if (editing && typeof original?.budgetUsd === 'number') input.budgetUsd = null
  const cleaned = cleanScheduleInput(input)
  return cleaned.ok ? { ok: true, value: cleaned.value } : { ok: false, problem: cleaned.problem }
}

/** The next three run times of the form, or [] while the timing has a problem. */
export function formNextRuns(f: ScheduleForm, now: number): number[] {
  const t = formTiming(f)
  if (typeof t === 'string' || scheduleTimingProblem(t) !== null) return []
  return upcomingScheduleRuns(t, now, 3)
}

// ---------- proposal card ----------

export const PROPOSAL_ACTION_TEXT: Readonly<Record<ScheduleProposalItem['action'], string>> = {
  create: 'New schedule',
  update: 'Change schedule',
  remove: 'Delete schedule',
  pause: 'Pause schedule',
  resume: 'Resume schedule'
}

/** The fold summary of a schedules proposal: "new Nightly PR review, pause Docs sync". */
export function schedulesFoldVerbs(items: readonly ScheduleProposalItem[], names: (id: string) => string | undefined): string[] {
  return items.map((i) => {
    const name = i.schedule?.name?.trim() || (i.scheduleId ? names(i.scheduleId) : undefined) || 'a schedule'
    const verb = i.action === 'create' ? 'new' : i.action === 'update' ? 'change' : i.action === 'remove' ? 'delete' : i.action
    return `${verb} ${name}`
  })
}

/** The spend cap in words: "$5.00 per run", or the default. */
export function budgetText(budgetUsd: number | null | undefined, team = true): string {
  if (typeof budgetUsd === 'number' && Number.isFinite(budgetUsd)) return `$${budgetUsd.toFixed(2)} per run`
  return team ? "The project's own cap, if any" : 'No cap of its own'
}

/** "Run once when OrgAI is next open" / "Skip". */
export function missedText(m: ScheduleMissedPolicy | undefined): string {
  return m === 'skip' ? 'Skip missed runs' : 'Run once when OrgAI is next open'
}
