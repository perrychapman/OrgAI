/**
 * `orgai settings` (cli-parity 3.2): the app settings that matter in a terminal, over settings:get / settings:set.
 *
 *   [list]               read: every key with its value, type and one-line description
 *   get <key>            read: one key
 *   set <key> <value>    configure: one key, validated here; settings:set receives `{ <key>: <value> }` only
 *
 * The keys are a closed list (SETTING_KEYS). Anything else (appearance, connections, proxies, the default connection,
 * price overrides, legacy mirrors) is refused with the list; `set` never forwards JSON or a second field. The host
 * merges the one field onto the stored settings (host/args.ts settingsSetArgs) and normalizes it (store/settings.ts).
 */
import { MODEL_TIERS, PERMISSION_MODES, isModelTier, type AppSettings, type ModelTier, type ProviderModel } from '../../shared/types'
import { MAX_AUTO_CONTINUES_LIMIT } from '../../shared/defaults'
import { parseFlags } from '../flags'
import { hostCall, runSubcommands, withHost } from '../manage'
import { emit, safeLine, styleFor, table, termWidth, type Json } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type HostClient } from '../types'
import { CONFIGURE, READ } from './connections'

const USAGE = 'settings <list|get|set> [<key>] [<value>]'

export type SettingKind = 'enum' | 'number' | 'integer' | 'boolean' | 'model'

/** A settable value: what settings:set receives for the key (null clears an optional number). */
export type SettingValue = string | number | boolean | null

export interface SettingKey {
  key: keyof AppSettings
  kind: SettingKind
  description: string
  /** enum: the allowed values. */
  values?: readonly string[]
  /** number / integer: inclusive bounds; `min` exclusive when minExclusive. */
  min?: number
  max?: number
  minExclusive?: boolean
  /** number: 'none' clears the setting (no cap). */
  clearable?: boolean
}

const MODEL_HELP = `a tier (${MODEL_TIERS.join(', ')}) or a model id from \`orgai models list\``

/**
 * The closed list. Order is the list's order. `defaultPreferEverydayNearLimit` is left out on purpose: it is
 * deprecated (new projects decide automatically, planGuardOf) and setting it changes nothing a user can see.
 */
export const SETTING_KEYS: readonly SettingKey[] = [
  { key: 'defaultPermissionMode', kind: 'enum', values: PERMISSION_MODES, description: 'Permission mode of new projects' },
  { key: 'defaultMaxBudgetUsd', kind: 'number', min: 0, minExclusive: true, clearable: true, description: 'Estimated cost cap in USD per run of new projects (none = no cap)' },
  { key: 'defaultKeepRuns', kind: 'integer', min: 1, max: 100_000, description: 'Saved runs new projects keep' },
  { key: 'defaultIsolateWriters', kind: 'boolean', description: 'New projects give writing agents their own worktree' },
  { key: 'defaultAutoContinue', kind: 'boolean', description: 'New projects continue automatically until the plan is done' },
  { key: 'defaultMaxAutoContinues', kind: 'integer', min: 0, max: MAX_AUTO_CONTINUES_LIMIT, description: 'Automatic continues new projects allow per run' },
  { key: 'defaultRootModel', kind: 'model', description: "Model of a new project's root role" },
  { key: 'defaultReportModel', kind: 'model', description: "Model of a new project's other roles" },
  { key: 'setupModel', kind: 'model', description: 'Model of setup, revision and retrospective runs' },
  { key: 'mcpAssistModel', kind: 'model', description: 'Model of the MCP assistant' },
  { key: 'skillAssistModel', kind: 'model', description: 'Model of the Skill assistant' },
  { key: 'quickRunModel', kind: 'model', description: "Model of the Chat's single assistant" },
  { key: 'opusGuardThreshold', kind: 'number', min: 1, max: 100, description: 'Weekly usage percent at which near-limit projects spawn deep and top roles on everyday' },
  { key: 'communityPrices', kind: 'boolean', description: 'Use the community price list as the last price fallback' },
  { key: 'notifications', kind: 'boolean', description: 'OS attention notifications (read by the desktop app; the CLI host does not notify)' }
]

export function findSettingKey(raw: string | undefined): SettingKey {
  const list = SETTING_KEYS.map((k) => k.key).join(', ')
  if (raw === undefined) throw new CliError(`Name a setting: ${list}.`, EXIT.usage)
  const hit = SETTING_KEYS.find((k) => k.key === raw) ?? SETTING_KEYS.find((k) => k.key.toLowerCase() === raw.toLowerCase())
  if (!hit) throw new CliError(`Unknown setting "${safeLine(raw).slice(0, 60)}". The settings are: ${list}.`, EXIT.usage)
  return hit
}

const TRUE_WORDS = new Set(['true', 'on', 'yes', '1'])
const FALSE_WORDS = new Set(['false', 'off', 'no', '0'])

/** A model id: one printable line without spaces, at most 200 characters (store/settings.ts modelRef). */
const MODEL_ID_RE = /^[!-~]{1,200}$/

/**
 * The value `raw` stands for, validated. `catalog` is every listed model id (models:list); only model keys use it.
 * Pure; exported for tests.
 */
export function parseSettingValue(spec: SettingKey, raw: string, catalog: ReadonlySet<string> = new Set()): SettingValue {
  const v = raw.trim()
  const bad = (why: string): CliError => new CliError(`${spec.key}: ${why}`, EXIT.usage)
  switch (spec.kind) {
    case 'enum': {
      const values = spec.values ?? []
      if (!values.includes(v)) throw bad(`use one of ${values.join(', ')}.`)
      return v
    }
    case 'boolean': {
      const l = v.toLowerCase()
      if (TRUE_WORDS.has(l)) return true
      if (FALSE_WORDS.has(l)) return false
      throw bad('use on or off (true / false).')
    }
    case 'number':
    case 'integer': {
      if (spec.clearable && (v.toLowerCase() === 'none' || v.toLowerCase() === 'off')) return null
      const range = `${spec.minExclusive ? 'over' : 'from'} ${spec.min ?? '-'}${spec.max !== undefined ? ` ${spec.minExclusive ? 'up ' : ''}to ${spec.max}` : ''}`
      const n = /^[+]?(\d+(\.\d+)?|\.\d+)$/.test(v) ? Number(v) : NaN
      const ok =
        Number.isFinite(n) &&
        (spec.kind !== 'integer' || Number.isInteger(n)) &&
        (spec.min === undefined || (spec.minExclusive ? n > spec.min : n >= spec.min)) &&
        (spec.max === undefined || n <= spec.max)
      if (!ok) throw bad(`use ${spec.kind === 'integer' ? 'a whole number' : 'a number'} ${range}${spec.clearable ? ', or none' : ''}.`)
      return n
    }
    case 'model': {
      if (isModelTier(v)) return v
      if (!MODEL_ID_RE.test(v) || v === 'inherit') throw bad(`use ${MODEL_HELP}.`)
      if (!catalog.has(v)) throw bad(`${safeLine(v)} is not a tier or a model any enabled connection lists. Use ${MODEL_HELP}.`)
      return v
    }
  }
}

/** The stored value of a key as JSON (an unset optional is null). */
export function settingValue(settings: Partial<AppSettings>, spec: SettingKey): SettingValue {
  const v = (settings as Record<string, unknown>)[spec.key]
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null
}

/** The value as text: booleans on / off, an unset budget none. */
export function settingText(spec: SettingKey, value: SettingValue): string {
  if (value === null) return spec.clearable ? 'none' : '(not set)'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return safeLine(String(value))
}

const typeText = (spec: SettingKey): string => {
  switch (spec.kind) {
    case 'enum':
      return (spec.values ?? []).join('|')
    case 'boolean':
      return 'on | off'
    case 'model':
      return 'tier | model id'
    default: {
      const word = spec.kind === 'integer' ? 'integer' : 'number'
      const range = spec.max === undefined ? `${spec.minExclusive ? '>' : '>='} ${spec.min ?? 0}` : `${spec.min ?? 0}..${spec.max}`
      return `${word} ${range}${spec.clearable ? ' | none' : ''}`
    }
  }
}

const keyJson = (spec: SettingKey, settings: Partial<AppSettings>): Json => ({
  key: spec.key,
  value: settingValue(settings, spec),
  type: spec.kind,
  ...(spec.values ? { values: [...spec.values] } : {}),
  ...(spec.min !== undefined ? { min: spec.min } : {}),
  ...(spec.max !== undefined ? { max: spec.max } : {}),
  ...(spec.minExclusive ? { minExclusive: true } : {}),
  ...(spec.kind === 'model' ? { tiers: [...MODEL_TIERS] } : {}),
  description: spec.description
})

async function readSettings(client: HostClient): Promise<Partial<AppSettings>> {
  const s = await hostCall<Partial<AppSettings>>(client, 'settings:get', [])
  return s && typeof s === 'object' ? s : {}
}

function noMore(positionals: string[], from: number): void {
  if (positionals.length > from) throw new CliError(`Unexpected argument "${safeLine(positionals[from]).slice(0, 40)}".`, EXIT.usage)
}

const runList = async (ctx: CliContext, args: string[]): Promise<number> => {
  noMore(parseFlags(args, {}).positionals, 0)
  return withHost(ctx, READ, async (client) => {
    const s = await readSettings(client)
    emit(ctx, { settings: SETTING_KEYS.map((k) => keyJson(k, s)) }, () =>
      table(
        [{ header: 'KEY', min: 10 }, { header: 'VALUE', min: 5, ellipsis: 'middle' }, { header: 'TYPE', min: 6 }, { header: 'DESCRIPTION', flex: true, min: 10 }],
        SETTING_KEYS.map((k) => [k.key, settingText(k, settingValue(s, k)), typeText(k), k.description]),
        termWidth(ctx),
        styleFor(ctx)
      )
    )
    return EXIT.ok
  })
}

const runGet = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { positionals } = parseFlags(args, {})
  noMore(positionals, 1)
  const spec = findSettingKey(positionals[0])
  return withHost(ctx, READ, async (client) => {
    const s = await readSettings(client)
    emit(ctx, keyJson(spec, s), () => settingText(spec, settingValue(s, spec)))
    return EXIT.ok
  })
}

const runSet = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { positionals } = parseFlags(args, {})
  const spec = findSettingKey(positionals[0])
  if (positionals[1] === undefined) throw new CliError(`Give the value: settings set ${spec.key} <${typeText(spec)}>.`, EXIT.usage)
  noMore(positionals, 2)
  const raw = positionals[1]
  // Everything but a model id is checked before the host starts.
  if (spec.kind !== 'model') parseSettingValue(spec, raw)
  return withHost(ctx, CONFIGURE, async (client) => {
    let catalog = new Set<string>()
    if (spec.kind === 'model' && !isModelTier(raw.trim())) {
      const models = await hostCall<ProviderModel[]>(client, 'models:list', [])
      catalog = new Set((Array.isArray(models) ? models : []).map((m) => m.id))
    }
    const value = parseSettingValue(spec, raw, catalog)
    const before = await readSettings(client)
    const previous = settingValue(before, spec)
    // One field, built here; null clears an optional field (host/jsonCodec.ts SETTINGS_CLEARABLE).
    const after = await hostCall<Partial<AppSettings>>(client, 'settings:set', [{ [spec.key]: value }])
    const saved = settingValue(after && typeof after === 'object' ? after : {}, spec)
    const tierWord = spec.kind === 'model' && typeof saved === 'string' && isModelTier(saved as ModelTier) ? ' (tier)' : ''
    emit(ctx, { key: spec.key, value: saved, previous, changed: saved !== previous }, () =>
      saved === previous ? `${spec.key} is already ${settingText(spec, saved)}.` : `${spec.key}: ${settingText(spec, previous)} -> ${settingText(spec, saved)}${tierWord}`
    )
    return EXIT.ok
  })
}

/** Bare `orgai settings` lists. */
export const runSettings: CommandFn = (ctx, args) => (args.length === 0 ? runList(ctx, []) : runSubcommands(ctx, args, { list: runList, get: runGet, set: runSet }, USAGE))

