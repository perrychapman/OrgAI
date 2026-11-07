/**
 * Pure helpers for the app-settings proposal card and the Setting / Now / New table of a Chat-proposed project
 * settings change (docs/design/ux-review-self-help-pre.md H3, L1). Value words, pane grouping, project "Now" values.
 * No I/O, no React.
 */
import type { AppSettingChange, AppSettingValue, AppSettingsProposableField, PermissionMode, Project, ProjectKind, SettingsProposalPayload } from '@shared/types'
import { MODEL_TIER_OPTIONS, PERMISSION_MODE_OPTIONS } from '@shared/types'
import { APP_SETTING_DOCS, atlasPath, type AtlasSurfaceId } from '@shared/view/atlas'
import { oneLine } from './decisionTitle'
import { showHidden } from './hiddenChars'

// The canvas option words are the ones App settings > Canvas shows (components/settings/CanvasSection.tsx keeps its
// tables private; keep these in step with it).
const WORDS: Record<string, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'Match system',
  on: 'On',
  dots: 'Dots',
  grid: 'Grid',
  none: 'None',
  blueprint: 'Blueprint',
  paper: 'Paper',
  isometric: 'Isometric',
  circuit: 'Circuit',
  terminal: 'Terminal',
  starfield: 'Starfield',
  'top-down': 'Top down',
  'left-right': 'Left to right',
  radial: 'Radial',
  curved: 'Curved',
  orthogonal: 'Right angle',
  straight: 'Straight',
  card: 'Cards',
  compact: 'Name tags',
  station: 'Stations',
  hex: 'Honeycomb'
}

const NO_CAP_FIELDS: ReadonlySet<string> = new Set(['defaultMaxBudgetUsd'])
const MODEL_FIELDS: ReadonlySet<string> = new Set(['defaultRootModel', 'defaultReportModel', 'setupModel', 'mcpAssistModel', 'skillAssistModel', 'quickRunModel'])

export const dollars = (n: number): string => `$${n}`

/** The words a value reads as in its row. Untrusted strings go through showHidden. */
export function formatAppSettingValue(field: AppSettingsProposableField, value: AppSettingValue): string {
  if (value === null) return NO_CAP_FIELDS.has(field) ? 'No cap' : 'Not set'
  if (typeof value === 'boolean') return value ? 'On' : 'Off'
  if (field === 'defaultMaxBudgetUsd' && typeof value === 'number') return dollars(value)
  if (field === 'opusGuardThreshold' && typeof value === 'number') return `${value}%`
  if (field === 'defaultPermissionMode' && typeof value === 'string') return permissionModeWord(value)
  if (MODEL_FIELDS.has(field) || field === 'defaultRootModel') {
    if (typeof value === 'string') {
      const tier = MODEL_TIER_OPTIONS.find((o) => o.value === value)
      return tier ? `${tier.label.replace(/ tier$/i, '')} tier` : showHidden(oneLine(value, 80))
    }
  }
  if (field.startsWith('appearance.') && field !== 'appearance.accent' && typeof value === 'string') return WORDS[value] ?? showHidden(oneLine(value, 60))
  return showHidden(oneLine(String(value), 80))
}

export function permissionModeWord(mode: string): string {
  return PERMISSION_MODE_OPTIONS.find((o) => o.value === (mode as PermissionMode))?.label ?? showHidden(oneLine(mode, 60))
}

/** A value that is a hex colour (the swatch next to the accent), else null. */
export function swatchOf(field: AppSettingsProposableField, value: AppSettingValue): string | null {
  return field === 'appearance.accent' && typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : null
}

const NOT_SHOWN = 'App settings › General › New projects (not shown on a screen yet)'

/** The surface a field's row lives under: canvas and motion split out of Appearance. */
export function surfaceForField(field: AppSettingsProposableField): AtlasSurfaceId | 'none' {
  if (field.startsWith('appearance.canvas.')) return 'app-settings-general-canvas'
  if (field === 'appearance.reduceMotion') return 'app-settings-general-motion'
  const top = field.split('.')[0] as keyof typeof APP_SETTING_DOCS
  return APP_SETTING_DOCS[top]?.surface ?? 'none'
}

export interface AppSettingGroup {
  key: string
  /** "App settings › General › Appearance" */
  path: string
  changes: AppSettingChange[]
}

/** Rows grouped by pane, in the order each pane first appears. */
export function groupAppSettingChanges(changes: readonly AppSettingChange[]): AppSettingGroup[] {
  const groups = new Map<string, AppSettingGroup>()
  for (const c of changes) {
    const surface = surfaceForField(c.field)
    const key = surface
    let g = groups.get(key)
    if (!g) {
      g = { key, path: surface === 'none' ? NOT_SHOWN : atlasPath(surface), changes: [] }
      groups.set(key, g)
    }
    g.changes.push(c)
  }
  return [...groups.values()]
}

/** "2 app settings · App settings" (the folded card's line: count and target; the title carries the list, the table the detail). */
export function appSettingsSummary(changes: readonly AppSettingChange[]): string | undefined {
  if (changes.length === 0) return undefined
  return `${changes.length} ${changes.length === 1 ? 'app setting' : 'app settings'} · App settings`
}

export interface ProjectSettingRow {
  field: string
  label: string
  now: string
  next: string
}

const onOff = (v: boolean | undefined): string => (v === undefined ? 'Not set' : v ? 'On' : 'Off')

/**
 * The scalar rows of a project settings proposal, with the stored project's current value when it is loaded ("Unknown"
 * when not). The brief and allow rules are their own sections.
 */
export function projectSettingRows(payload: SettingsProposalPayload, kind: ProjectKind, project: Project | undefined): ProjectSettingRow[] {
  const rows: ProjectSettingRow[] = []
  const engagement = kind === 'engagement'
  const unknown = 'Unknown'
  const add = (field: string, label: string, now: string | undefined, next: string): void => {
    rows.push({ field, label, now: project ? (now ?? unknown) : unknown, next })
  }
  // Every field the payload sets is listed, whatever kind the card guessed (a target project not loaded reads as code;
  // main sends client only for engagements). Review M2: nothing the user approves may be hidden.
  if (payload.client !== undefined) add('client', 'Client or case', project?.client?.trim() ? showHidden(oneLine(project.client, 120)) : 'Not set', payload.client.trim() ? showHidden(oneLine(payload.client, 120)) : 'Cleared')
  if (payload.permissionMode) add('permissionMode', 'Permission mode', project && permissionModeWord(project.permissionMode), permissionModeWord(payload.permissionMode))
  if (payload.maxBudgetUsd !== undefined) add('maxBudgetUsd', 'Estimated-cost cap per run', project && (project.maxBudgetUsd === undefined ? 'No cap' : dollars(project.maxBudgetUsd)), payload.maxBudgetUsd === null ? 'No cap' : dollars(payload.maxBudgetUsd))
  if (payload.maxSubagentDepth !== undefined) add('maxSubagentDepth', 'Max subagent depth', project && (project.maxSubagentDepth === undefined ? 'Automatic' : String(project.maxSubagentDepth)), String(payload.maxSubagentDepth))
  if (payload.maxConcurrentSubagents !== undefined) {
    add('maxConcurrentSubagents', 'Max concurrent subagents', project && (project.maxConcurrentSubagents === undefined ? 'Automatic' : String(project.maxConcurrentSubagents)), String(payload.maxConcurrentSubagents))
  }
  if (payload.isolateWriters !== undefined) add('isolateWriters', engagement ? 'Give each writer its own copy (git worktrees)' : 'Isolate writers in worktrees', project && onOff(project.isolateWriters), onOff(payload.isolateWriters))
  if (payload.reviewMerges !== undefined) add('reviewMerges', 'Review changes before merging', project && onOff(project.reviewMerges), onOff(payload.reviewMerges))
  if (payload.autoContinue !== undefined) add('autoContinue', 'Keep going until the plan is complete', project && onOff(project.autoContinue), onOff(payload.autoContinue))
  if (payload.maxAutoContinues !== undefined) add('maxAutoContinues', 'Max automatic continues per run', project && (project.maxAutoContinues === undefined ? 'Not set' : String(project.maxAutoContinues)), String(payload.maxAutoContinues))
  return rows
}

/** "1 setting · Notes API" for a target project settings proposal (brief counts as one). */
export function projectSettingsSummary(rows: readonly ProjectSettingRow[], hasBrief: boolean, projectName: string): string | undefined {
  const n = rows.length + (hasBrief ? 1 : 0)
  if (n === 0) return undefined
  return `${n} ${n === 1 ? 'setting' : 'settings'} · ${showHidden(oneLine(projectName, 60)) || 'a project'}`
}
