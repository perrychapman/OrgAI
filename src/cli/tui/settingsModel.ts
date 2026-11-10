/**
 * The Settings view's rows (cli-parity 3.7): three groups, each row with its current value and how it is edited.
 *   Project: the `projects set` flags (validated by its setPatch) and the permission mode (`permissions mode`).
 *   Tiers:   the project's connection, one row per tier (`connections tier`: tierRows, planTierChange).
 *   App:     the closed key list of `orgai settings` (SETTING_KEYS, parseSettingValue).
 * Pure: everything comes from projects:get, connections:list, models:list and settings:get.
 */
import { effectiveSubagentLimits, isolateWritersOn, planGuardOf, projectConnection, reviewPolicyOf, staffingGoalOf, staffingModeOf } from '../../shared/defaults'
import {
  DEFAULT_KEEP_RUNS,
  DEFAULT_MAX_AUTO_CONTINUES,
  REVIEW_POLICIES,
  STAFFING_GOALS,
  STAFFING_MODES,
  type AppSettings,
  type ConnectionInfo,
  type ModelTier,
  type Project,
  type ProviderModel
} from '../../shared/types'
import { PERMISSION_MODE_SHORT } from '../../shared/view/settingsCopy'
import { connectionLabel, labelOfId, tierRows } from '../commands/connections'
import { contextText } from '../commands/models'
import { SETTING_KEYS, settingText, settingValue, type SettingKey } from '../commands/settings'
import { clean } from './configUi'

export interface SettingsData {
  project: Project
  connections: ConnectionInfo[]
  /** models:list (every connected connection). */
  catalog: ProviderModel[]
  settings: Partial<AppSettings>
}

/** A `projects set` flag the Project group edits (setPatch validates the raw value). */
export type ProjectFlag =
  | 'staffing'
  | 'staffing-goal'
  | 'review-policy'
  | 'review-merges'
  | 'max-window-share'
  | 'keep-runs'
  | 'isolate-writers'
  | 'auto-continue'
  | 'max-auto-continues'
  | 'max-budget'
  | 'plan-guard'
  | 'max-depth'
  | 'max-concurrent'

export type SettingEdit =
  | { kind: 'project'; flag: ProjectFlag; input: 'enum'; values: readonly string[] }
  | { kind: 'project'; flag: ProjectFlag; input: 'onoff' }
  | { kind: 'project'; flag: ProjectFlag; input: 'text'; hint: string; raw: string }
  | { kind: 'permissionMode' }
  | { kind: 'tier'; tier: ModelTier }
  | { kind: 'app'; spec: SettingKey }

export interface SettingRow {
  id: string
  group: 'project' | 'tiers' | 'app'
  label: string
  value: string
  /** Dim words after the value (a model's source and context, a key's description). */
  detail?: string
  /** Why the row cannot be edited here, and where it can. */
  readOnly?: string
  edit?: SettingEdit
}

const onOff = (b: boolean): string => (b ? 'on' : 'off')

/** The Project group, in the order of the spec. */
export function projectRows(p: Project): SettingRow[] {
  const limits = effectiveSubagentLimits(p)
  const lim = (n: number, explicit: boolean): string => (explicit ? String(n) : `auto (${n})`)
  const guard = planGuardOf(p)
  const share = typeof p.maxWindowShare === 'number' && p.maxWindowShare > 0 ? p.maxWindowShare : undefined
  const budget = typeof p.maxBudgetUsd === 'number' && p.maxBudgetUsd > 0 ? p.maxBudgetUsd : undefined
  const row = (id: ProjectFlag, label: string, value: string, edit: SettingEdit, detail?: string): SettingRow => ({ id: `project:${id}`, group: 'project', label, value, edit, ...(detail ? { detail } : {}) })
  return [
    row('staffing', 'Staffing mode', staffingModeOf(p) === 'auto' ? 'auto' : 'fixed', { kind: 'project', flag: 'staffing', input: 'enum', values: STAFFING_MODES }, 'auto lets the harness pick each report\'s tier and effort'),
    row('staffing-goal', 'Staffing goal', staffingGoalOf(p), { kind: 'project', flag: 'staffing-goal', input: 'enum', values: STAFFING_GOALS }),
    row('review-policy', 'Review policy', reviewPolicyOf(p), { kind: 'project', flag: 'review-policy', input: 'enum', values: REVIEW_POLICIES }),
    row('review-merges', 'Review merges', onOff(p.reviewMerges === true), { kind: 'project', flag: 'review-merges', input: 'onoff' }),
    row('max-window-share', 'Max window share', share ? `${share}%` : 'off', { kind: 'project', flag: 'max-window-share', input: 'text', hint: 'A percent of the five-hour plan window one run may use, 1 to 100, or auto (off).', raw: share ? String(share) : 'auto' }),
    row('keep-runs', 'Keep runs', p.keepRuns === undefined ? `auto (${DEFAULT_KEEP_RUNS})` : String(p.keepRuns), { kind: 'project', flag: 'keep-runs', input: 'text', hint: 'The run records to keep, 1 to 5000, or auto.', raw: p.keepRuns === undefined ? 'auto' : String(p.keepRuns) }),
    {
      id: 'project:permission-mode',
      group: 'project',
      label: 'Permission mode',
      value: p.permissionMode,
      detail: (PERMISSION_MODE_SHORT as Record<string, string>)[p.permissionMode] ?? '',
      edit: { kind: 'permissionMode' }
    },
    row('isolate-writers', 'Isolate writers', onOff(isolateWritersOn(p)), { kind: 'project', flag: 'isolate-writers', input: 'onoff' }),
    row('auto-continue', 'Auto-continue', onOff(p.autoContinue !== false), { kind: 'project', flag: 'auto-continue', input: 'onoff' }),
    row('max-auto-continues', 'Auto-continue limit', String(p.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES), { kind: 'project', flag: 'max-auto-continues', input: 'text', hint: 'Automatic continues per run, 0 to 1000.', raw: String(p.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES) }),
    row('max-budget', 'Budget cap', budget ? `$${budget.toFixed(2)} per run` : 'no cap', { kind: 'project', flag: 'max-budget', input: 'text', hint: 'An estimated cost cap in USD per run, above 0, or none.', raw: budget ? String(budget) : 'none' }),
    row('plan-guard', 'Plan guard', guard, { kind: 'project', flag: 'plan-guard', input: 'enum', values: ['auto', 'on', 'off'] }, 'move deep work to everyday near a plan limit'),
    row('max-depth', 'Subagent depth', lim(limits.depth, limits.explicit.depth), { kind: 'project', flag: 'max-depth', input: 'text', hint: 'Levels of reports that may spawn reports, 1 to 5, or auto.', raw: limits.explicit.depth ? String(limits.depth) : 'auto' }),
    row('max-concurrent', 'Subagent concurrency', lim(limits.concurrency, limits.explicit.concurrency), { kind: 'project', flag: 'max-concurrent', input: 'text', hint: 'Reports running at once, 1 to 32, or auto.', raw: limits.explicit.concurrency ? String(limits.concurrency) : 'auto' })
  ]
}

/** The Tiers group: the project's connection, one row per tier with its model id, catalog source and context window. */
export function tierSettingRows(d: Pick<SettingsData, 'project' | 'connections' | 'catalog'>): SettingRow[] {
  const id = projectConnection(d.project)
  const info = d.connections.find((i) => i.connection.id === id)
  const name = info ? connectionLabel(info.connection) : labelOfId(id)
  const head: SettingRow = { id: 'tiers:connection', group: 'tiers', label: 'Connection', value: clean(name, 80), detail: id, readOnly: 'Move the project with: orgai projects set --connection <id>' }
  if (!info) return [head, { id: 'tiers:none', group: 'tiers', label: 'Tiers', value: 'not listed', readOnly: `This computer does not list ${clean(id, 60)} (orgai connections list).` }]
  const catalog = d.catalog.filter((m) => m.connection === id)
  return [
    head,
    ...tierRows(info.connection, catalog).map((r): SettingRow => ({
      id: `tiers:${r.tier}`,
      group: 'tiers',
      label: r.tier,
      value: r.model ? clean(r.model, 120) : 'unmapped',
      ...(r.model ? { detail: r.inCatalog ? [r.source ?? '', `${contextText(r.contextWindow ?? undefined)} context`, r.automatic ? 'automatic' : ''].filter(Boolean).join(', ') : 'not in the catalog' } : {}),
      edit: { kind: 'tier', tier: r.tier }
    }))
  ]
}

/** The App group: `orgai settings`' closed key list. */
export function appRows(settings: Partial<AppSettings>): SettingRow[] {
  return SETTING_KEYS.map((spec) => ({ id: `app:${spec.key}`, group: 'app', label: spec.key, value: settingText(spec, settingValue(settings, spec)), detail: spec.description, edit: { kind: 'app', spec } }))
}

export const GROUP_TITLES: Record<SettingRow['group'], string> = { project: 'Project', tiers: 'Tiers', app: 'App (orgai settings)' }

export function settingRows(d: SettingsData): SettingRow[] {
  return [...projectRows(d.project), ...tierSettingRows(d), ...appRows(d.settings)]
}
