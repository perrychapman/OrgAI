import type { Schedule, ScheduleTarget, TodoItem } from '@shared/types'

/**
 * The pure model of the Dashboard's Today section (docs/design/dashboard-overhaul.md 7.5): which schedules matter today
 * and which open to-dos to draft from. No DOM, no store.
 */

export type TodaySchedule = {
  /** 'ran' = a run started today; 'upcoming' = due before the next local midnight. */
  state: 'ran' | 'upcoming'
  schedule: Schedule
  /** The clock instant the row shows: when the run started, or when it is due. */
  at: number
}

/** Local midnight that starts the day containing `ms` (DST-safe: the Date constructor resolves local time). */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** The next local midnight after `ms`. */
export function nextLocalMidnight(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/**
 * Ran today (lastEntry.at today, result 'started') first by time, then upcoming (enabled, active, nextRunAt from now to
 * the next local midnight) by time. A schedule that did both appears twice, once per state.
 */
export function scheduledToday(schedules: readonly Schedule[], now: number): TodaySchedule[] {
  const start = startOfLocalDay(now)
  const end = nextLocalMidnight(now)
  const ran: TodaySchedule[] = []
  const upcoming: TodaySchedule[] = []
  for (const s of schedules) {
    const last = s.lastEntry
    if (last && last.result === 'started' && last.at >= start && last.at < end) ran.push({ state: 'ran', schedule: s, at: last.at })
    if (s.enabled && s.state === 'active' && typeof s.nextRunAt === 'number' && s.nextRunAt >= now && s.nextRunAt < end) {
      upcoming.push({ state: 'upcoming', schedule: s, at: s.nextRunAt })
    }
  }
  const byTime = (a: TodaySchedule, b: TodaySchedule): number => a.at - b.at || a.schedule.id.localeCompare(b.schedule.id)
  return [...ran.sort(byTime), ...upcoming.sort(byTime)]
}

/** "Billing API" for a team target, "Chat" for a Chat run. */
export function scheduleTargetLabel(target: ScheduleTarget, projects: readonly { id: string; name: string }[]): string {
  if (target.kind === 'ask') return 'Chat'
  return projects.find((p) => p.id === target.projectId)?.name ?? 'A project that no longer exists'
}

export interface TodoRow {
  item: TodoItem
  /** The project name, or "Chat". */
  list: string
  agentAdded: boolean
}

/**
 * Open items (status not 'done') across every loaded list, newest `updatedAt` first. Items of a project that is no longer
 * stored are left out.
 */
export function openTodoRows(listsByScope: Readonly<Record<string, readonly TodoItem[] | undefined>>, projects: readonly { id: string; name: string }[]): TodoRow[] {
  const rows: TodoRow[] = []
  for (const list of Object.values(listsByScope)) {
    for (const item of list ?? []) {
      if (item.status === 'done') continue
      let name: string
      if (item.scope.kind === 'chat') name = 'Chat'
      else {
        const projectId = item.scope.projectId
        const p = projects.find((x) => x.id === projectId)
        if (!p) continue
        name = p.name
      }
      rows.push({ item, list: name, agentAdded: item.createdBy === 'agent' })
    }
  }
  return rows.sort((a, b) => b.item.updatedAt - a.item.updatedAt || a.item.id.localeCompare(b.item.id))
}
