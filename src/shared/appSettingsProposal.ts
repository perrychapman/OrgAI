/**
 * Pure helpers for appSettings proposals (types.ts "Self-knowledge and self-configuration"): the human label of each
 * proposable field, its current value, the per-field value check, and the settings after a set of changes. Used by
 * the propose_app_settings tool (main), the apply path (host/bootstrap.ts, then settings:set semantics) and the
 * renderer card. No I/O.
 */
import {
  APP_SETTINGS_PROPOSABLE_FIELDS,
  CANVAS_EDGE_STYLES,
  CANVAS_LAYOUTS,
  CANVAS_NODE_STYLES,
  CANVAS_PATTERNS,
  PERMISSION_MODES,
  THEME_MODES,
  isAppSettingsProposableField,
  type AppSettingChange,
  type AppSettingValue,
  type AppSettings,
  type AppSettingsProposableField
} from './types'
import { MAX_AUTO_CONTINUES_LIMIT } from './defaults'

/** The name each proposable field has in App settings (card rows and the tool's answers). */
export const APP_SETTING_FIELD_LABELS: Readonly<Record<AppSettingsProposableField, string>> = {
  'appearance.theme': 'Theme',
  'appearance.accent': 'Accent colour',
  'appearance.reduceMotion': 'Reduce motion',
  'appearance.canvas.pattern': 'Canvas backdrop',
  'appearance.canvas.tint': 'Tint the canvas with the accent',
  'appearance.canvas.edges': 'Canvas lines',
  'appearance.canvas.layout': 'Canvas layout',
  'appearance.canvas.nodeStyle': 'Agents drawn as',
  'appearance.canvas.minimap': 'Canvas minimap',
  notifications: 'Notifications',
  defaultPermissionMode: 'Permission mode for new projects',
  defaultMaxBudgetUsd: 'Spend cap per run for new projects (USD)',
  defaultKeepRuns: 'Runs kept per project for new projects',
  defaultIsolateWriters: 'Isolate writers in worktrees for new projects',
  defaultRootModel: 'Orchestrator model for new projects',
  defaultReportModel: 'Report model for new projects',
  setupModel: 'Architect model',
  mcpAssistModel: 'MCP assistant model',
  skillAssistModel: 'Skill assistant model',
  quickRunModel: 'Chat model',
  opusGuardThreshold: 'Plan guard threshold (weekly window %)',
  communityPrices: 'Community model prices',
  defaultAutoContinue: 'Keep going until the plan is complete, for new projects',
  defaultMaxAutoContinues: 'Automatic continues per run for new projects'
}

type Kind =
  | { type: 'enum'; values: readonly string[] }
  | { type: 'boolean' }
  | { type: 'accent' }
  | { type: 'model' }
  | { type: 'int'; min: number; max: number }
  | { type: 'number'; min: number; max: number; nullable?: true; exclusiveMin?: true }

const MODEL: Kind = { type: 'model' }
const BOOL: Kind = { type: 'boolean' }

/** Proposable permission modes: never 'bypassPermissions' (only the user turns that on, in Settings). */
const PROPOSABLE_PERMISSION_MODES = PERMISSION_MODES.filter((m) => m !== 'bypassPermissions')

const FIELD_KIND: Readonly<Record<AppSettingsProposableField, Kind>> = {
  'appearance.theme': { type: 'enum', values: THEME_MODES },
  'appearance.accent': { type: 'accent' },
  'appearance.reduceMotion': { type: 'enum', values: ['system', 'on'] },
  'appearance.canvas.pattern': { type: 'enum', values: CANVAS_PATTERNS },
  'appearance.canvas.tint': BOOL,
  'appearance.canvas.edges': { type: 'enum', values: CANVAS_EDGE_STYLES },
  'appearance.canvas.layout': { type: 'enum', values: CANVAS_LAYOUTS },
  'appearance.canvas.nodeStyle': { type: 'enum', values: CANVAS_NODE_STYLES },
  'appearance.canvas.minimap': BOOL,
  notifications: BOOL,
  defaultPermissionMode: { type: 'enum', values: PROPOSABLE_PERMISSION_MODES },
  defaultMaxBudgetUsd: { type: 'number', min: 0, max: 100_000, nullable: true, exclusiveMin: true },
  defaultKeepRuns: { type: 'int', min: 1, max: 10_000 },
  defaultIsolateWriters: BOOL,
  defaultRootModel: MODEL,
  defaultReportModel: MODEL,
  setupModel: MODEL,
  mcpAssistModel: MODEL,
  skillAssistModel: MODEL,
  quickRunModel: MODEL,
  opusGuardThreshold: { type: 'int', min: 1, max: 100 },
  communityPrices: BOOL,
  defaultAutoContinue: BOOL,
  defaultMaxAutoContinues: { type: 'int', min: 0, max: MAX_AUTO_CONTINUES_LIMIT }
}

/** The allowed values of an enum field (for tool schemas and hints); undefined for other fields. */
export function appSettingEnumValues(field: AppSettingsProposableField): readonly string[] | undefined {
  const k = FIELD_KIND[field]
  return k.type === 'enum' ? k.values : undefined
}

/**
 * Why `value` cannot be proposed for `field`, or null when it can. Models follow the settings store's rules (a tier
 * name or a model id: printable, no spaces, at most 200 characters, not 'inherit'); numbers must be finite.
 */
export function appSettingValueProblem(field: unknown, value: unknown): string | null {
  if (!isAppSettingsProposableField(field)) return `${typeof field === 'string' ? `"${field.slice(0, 80)}"` : 'That field'} is not a setting an agent can propose.`
  const k = FIELD_KIND[field]
  const label = APP_SETTING_FIELD_LABELS[field]
  switch (k.type) {
    case 'enum':
      return typeof value === 'string' && k.values.includes(value) ? null : `${label} must be one of: ${k.values.join(', ')}.`
    case 'boolean':
      return typeof value === 'boolean' ? null : `${label} must be true or false.`
    case 'accent':
      return typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value) ? null : `${label} must be a colour like #7c5cff (lower-case hex).`
    case 'model':
      return typeof value === 'string' && value !== 'inherit' && value.length <= 200 && /^[!-~]+$/.test(value)
        ? null
        : `${label} must be a tier (top, deep, everyday, fast) or a model id without spaces.`
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= k.min && value <= k.max ? null : `${label} must be a whole number from ${k.min} to ${k.max}.`
    case 'number':
      if (value === null && k.nullable) return null
      if (typeof value !== 'number' || !Number.isFinite(value) || value > k.max || (k.exclusiveMin ? value <= k.min : value < k.min)) {
        return `${label} must be a number above ${k.min} and at most ${k.max}${k.nullable ? ', or null for none' : ''}.`
      }
      return null
  }
}

/** The stored value of a proposable field (undefined reads as null). */
export function appSettingValue(settings: AppSettings, field: AppSettingsProposableField): AppSettingValue {
  let cur: unknown = settings
  for (const part of field.split('.')) {
    cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined
  }
  return typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean' ? cur : null
}

/**
 * The settings with `changes` applied (a fresh object; `settings` is not changed). Throws a readable sentence for an
 * unknown field or a value appSettingValueProblem refuses, so nothing is half-applied. null clears an optional field.
 * The result still goes through settings:set semantics (settingsSetArgs, SettingsStore normalization) when saved.
 */
export function withAppSettingChanges(settings: AppSettings, changes: readonly Pick<AppSettingChange, 'field' | 'to'>[]): AppSettings {
  for (const c of changes) {
    const problem = appSettingValueProblem(c.field, c.to)
    if (problem) throw new Error(problem)
  }
  const next: AppSettings = { ...settings, appearance: { ...settings.appearance, canvas: { ...settings.appearance.canvas } } }
  for (const c of changes) {
    const parts = c.field.split('.')
    let target = next as unknown as Record<string, unknown>
    for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>
    const key = parts[parts.length - 1]
    if (c.to === null) delete target[key]
    else target[key] = c.to
  }
  return next
}

/** Every proposable field, in App settings order (re-exported for tool schemas). */
export const PROPOSABLE_APP_SETTING_FIELDS = APP_SETTINGS_PROPOSABLE_FIELDS
