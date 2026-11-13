import type { PermissionMode, Schedule, ScheduleProposalItem, ScheduleSaveInput } from '@shared/types'
import { formatDateTime } from '@shared/view/dates'
import { PROPOSAL_ACTION_TEXT, budgetText, missedText, safeDescribe, targetText, type ProjectRef } from '@shared/view/schedules'
import { hasHidden } from './hiddenChars'
import { permissionModeName } from './runSettings'
import { folderName } from './paths'
import { connectionLabel } from './connectionLabel'

/** One label / value pair of a schedule block. Values are raw text: the component shows them through showHidden. */
export type ScheduleRowKey = 'prompt' | 'target' | 'folder' | 'timing' | 'next' | 'missed' | 'model' | 'permission' | 'budget'
export interface ScheduleRow {
  key: ScheduleRowKey
  label: string
  /** The prompt text, a plain value, or (key 'next') one formatted time per entry. */
  value: string | string[]
}

export interface ScheduleItemView {
  action: ScheduleProposalItem['action']
  /** "New schedule", "Pause schedule", ... */
  actionText: string
  /** The schedule's name, or null when an existing schedule is unknown. */
  name: string | null
  /** Main-written, shown as is. */
  summary: string
  rows: ScheduleRow[]
  /** True when any agent-supplied string holds hidden characters. */
  hidden: boolean
  /** The two plain sentences about unattended runs go under blocks that make a schedule fire. */
  unattended: boolean
}

/** The list the existing schedules are looked up in: undefined while loading or when it could not be read. */
export type ExistingSchedules = readonly Pick<Schedule, 'id' | 'name'>[] | undefined

function saveInputHidden(s: ScheduleSaveInput): boolean {
  const t = s.target
  const folder = t.kind === 'ask' ? t.folder : undefined
  const cron = s.timing.kind === 'cron' ? s.timing.expression : undefined
  return hasHidden(s.name) || hasHidden(s.prompt) || hasHidden(folder) || hasHidden(cron)
}

/** The existing schedule's name for a pause / resume / remove / update item, else null. */
export function existingName(item: ScheduleProposalItem, existing: ExistingSchedules): string | null {
  if (!item.scheduleId || !existing) return null
  return existing.find((s) => s.id === item.scheduleId)?.name ?? null
}

/** The block of one proposal item: create / update list the fields in words, the other actions name the schedule. */
export function scheduleItemView(item: ScheduleProposalItem, existing: ExistingSchedules, projects: readonly ProjectRef[]): ScheduleItemView {
  const s = item.schedule
  const name = s?.name?.trim() || existingName(item, existing)
  const rows: ScheduleRow[] = []
  const showFields = (item.action === 'create' || item.action === 'update') && !!s
  if (showFields && s) {
    rows.push({ key: 'prompt', label: 'What to do', value: s.prompt })
    rows.push({ key: 'target', label: 'Runs as', value: targetText(s.target, projects, folderName) })
    // The full folder of a Chat target: the user approves unattended work in a place they must be able to see.
    if (s.target.kind === 'ask' && s.target.folder) rows.push({ key: 'folder', label: 'Folder', value: s.target.folder })
    rows.push({ key: 'timing', label: 'When', value: safeDescribe(s.timing) })
  }
  if (showFields || item.action === 'resume') {
    const times = (Array.isArray(item.nextRuns) ? item.nextRuns : []).slice(0, 3).map((t) => formatDateTime(t)).filter(Boolean)
    rows.push({ key: 'next', label: 'Next runs', value: times })
  }
  if (showFields && s) {
    rows.push({ key: 'missed', label: 'If a run is missed', value: missedText(s.missed) })
    const team = s.target.kind === 'team'
    const model = s.modelSelection
    rows.push({ key: 'model', label: 'Model', value: model ? `${model.model} (${connectionLabel(model.connection)})` : team ? "The project's model" : 'The Chat model' })
    const mode: PermissionMode | null | undefined = s.permissionMode
    rows.push({ key: 'permission', label: 'Permission mode', value: mode ? permissionModeName(mode) : team ? "The project's mode" : 'Chat default' })
    rows.push({ key: 'budget', label: 'Spend cap', value: budgetText(s.budgetUsd, team) })
  }
  return {
    action: item.action,
    actionText: PROPOSAL_ACTION_TEXT[item.action] ?? 'Change schedule',
    name,
    summary: item.summary,
    rows,
    hidden: (s ? saveInputHidden(s) : false) || hasHidden(name),
    unattended: item.action === 'create' || item.action === 'update' || item.action === 'resume'
  }
}

/** True when any item makes a schedule fire on its own (the card then shows the unattended sentences). */
export function anyUnattended(items: readonly ScheduleProposalItem[]): boolean {
  return items.some((i) => i.action === 'create' || i.action === 'update' || i.action === 'resume')
}
