/**
 * Run settings row (docs/design/ux-review-run-start-pre.md, "Where the model, effort and permission controls go"): the
 * pure rules behind the Model, Effort, Permission and Goal controls of the New run page and the live composer. The
 * contract is StartRunInput.modelSelection / effort / permissionMode, RunSummary.rootEffort / permissionMode /
 * permissionModeChosen and runs:setPermissionMode (src/shared/types.ts). Nothing here changes project settings.
 */
import type { ConnectionId, Effort, ModelTier, ModelRef, PermissionMode, Project, ProviderId, ProviderModel, RunSummary, StartRunInput } from '@shared/types'
import { EFFORTS, runPermissionModeChoices } from '@shared/types'
import { adapterOnConnection, effortOptionsFor, modelFamily, projectConnection, resolveModelSetting } from '@shared/defaults'
import { PERMISSION_MODE_SHORT } from '@shared/view/settingsCopy'
import { PERMISSION_MODE_TRADEOFF } from '@shared/view/permissionCopy'

// ---------- Effort ----------

/** Friendly effort names, least first (EFFORTS order). One vocabulary for the start page and the live composer. */
export const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

/** The effort control's help line. */
export const EFFORT_HELP = 'How hard the lead agent thinks. Higher is slower and costs more. Team members keep their own effort.'

/** "Model default" when no effort is set: the adapter decides. */
export const EFFORT_UNSET_LABEL = 'Model default'

/** The levels a model's adapter takes (effortOptionsFor), least first. */
export function effortChoices(adapter: ProviderId | null | undefined): Effort[] {
  return effortOptionsFor(adapter)
}

/**
 * Fit an effort to an adapter. A level the adapter takes stays; otherwise the highest offered level below it is used
 * (Codex: Extra high and Max become High). `fellBack` names the level that was replaced so the UI can say so; it is
 * null when nothing changed. Undefined stays undefined (the model's own default).
 */
export function fitEffort(effort: Effort | undefined, adapter: ProviderId | null | undefined): { effort: Effort | undefined; fellBack: Effort | null } {
  if (!effort) return { effort: undefined, fellBack: null }
  const offered = effortChoices(adapter)
  if (offered.includes(effort)) return { effort, fellBack: null }
  const rank = EFFORTS.indexOf(effort)
  const below = [...offered].reverse().find((e) => EFFORTS.indexOf(e) < rank)
  return { effort: below ?? offered[0], fellBack: effort }
}

/** "Codex models take Low to High, so Extra high became High." Shown beside the effort control after a fallback. */
export function effortFallbackNote(from: Effort, to: Effort | undefined): string {
  return `This model does not take ${EFFORT_LABEL[from]}; effort is now ${to ? EFFORT_LABEL[to] : EFFORT_UNSET_LABEL}.`
}

// ---------- Model ----------

export interface RunModel {
  model: string
  connection: ConnectionId
  adapter: ProviderId
  /** The catalog's friendly label, else the id. */
  label: string
}

/** The project's root role (reportsTo null), else its first role. */
function rootRole(project: Pick<Project, 'roles'>): Project['roles'][number] | undefined {
  return project.roles.find((r) => r.reportsTo === null) ?? project.roles[0]
}

/** The adapter that runs `model` on `connection`: the catalog entry's, the mock adapter on a mock project, else by family. */
export function adapterOfModel(model: string, connection: ConnectionId, catalog: readonly ProviderModel[] | undefined, mockProject: boolean): ProviderId {
  if (mockProject) return 'mock'
  const entry = catalog?.find((m) => m.id === model && m.connection === connection)
  return entry?.adapter ?? adapterOnConnection(connection, entry?.family ?? modelFamily(model as ModelRef))
}

/**
 * The model a new run would use with no choice (what main does): Team = the root role's model on the project's
 * connection; Ask = the single assistant's AppSettings.quickRunModel ('everyday' when blank). Tier names and aliases
 * resolve through the connection's tier mapping. Null when it cannot be named (an 'inherit' root, an unmapped tier).
 */
export function defaultRunModel(
  project: Pick<Project, 'roles' | 'provider'>,
  opts: { ask: boolean; quickRunModel?: string; tierModels?: Partial<Record<ModelTier, ModelRef>>; catalog?: readonly ProviderModel[] }
): RunModel | null {
  const connection = projectConnection(project)
  const setting = opts.ask ? opts.quickRunModel?.trim() || 'everyday' : rootRole(project)?.model
  if (!setting || setting === 'inherit') return null
  const resolved = resolveModelSetting(setting, { connection, tierModels: opts.tierModels ?? {}, catalog: opts.catalog })
  if (!resolved || resolved.model === 'inherit') return null
  const model = resolved.model
  const label = opts.catalog?.find((m) => m.id === model && m.connection === connection)?.label || model
  return { model, connection, adapter: adapterOfModel(model, connection, opts.catalog, project.provider.id === 'mock'), label }
}

/** The effort a new run would use with no choice: Team = the root role's effort; Ask = none (the model's default). */
export function defaultRunEffort(project: Pick<Project, 'roles'>, ask: boolean): Effort | undefined {
  return ask ? undefined : rootRole(project)?.effort
}

// ---------- Permission mode ----------

/** The modes a new run of a saved project accepts: Team and Ask are both plain work runs (main: checkStartChoice). */
export function newRunPermissionChoices(): PermissionMode[] {
  return runPermissionModeChoices({ kind: 'work' })
}

/** The modes a live or ended run accepts (empty: hide the control). */
export function livePermissionChoices(run: Pick<RunSummary, 'kind' | 'quick' | 'buildWorkspace'>): PermissionMode[] {
  return runPermissionModeChoices(run)
}

/**
 * Which modes each mode is no wider than, besides itself (the same matrix as main's runOverrides.ts
 * canNarrowPermissionMode; runSettings.test.ts checks they agree). 'plan' is narrower than every mode.
 */
const NARROWS_FROM: Record<PermissionMode, readonly PermissionMode[] | 'any'> = {
  plan: 'any',
  dontAsk: ['default', 'acceptEdits', 'auto', 'bypassPermissions'],
  default: ['acceptEdits', 'auto', 'bypassPermissions'],
  acceptEdits: ['auto', 'bypassPermissions'],
  auto: ['bypassPermissions'],
  bypassPermissions: []
}

/** True when `to` is no more permissive than `from`. */
export function isNarrowingMode(from: PermissionMode, to: PermissionMode): boolean {
  if (from === to) return true
  const list = NARROWS_FROM[to]
  return list === 'any' || list.includes(from)
}

/** A move to `to` that asks less than `from` (anything not narrowing): needs a confirmation. */
export function isWideningMode(from: PermissionMode, to: PermissionMode): boolean {
  return !isNarrowingMode(from, to)
}

/** Modes that skip prompts the default asks for: shown with a warning tone and an icon. */
export function isPermissiveMode(mode: PermissionMode): boolean {
  return mode === 'auto' || mode === 'acceptEdits' || mode === 'bypassPermissions'
}

/** Short name for the chip ("Plan only"). */
export function permissionModeName(mode: PermissionMode): string {
  return PERMISSION_MODE_SHORT[mode]
}

/** One line on what the mode does (the settings select's trade-off line). */
export function permissionModeHelp(mode: PermissionMode): string {
  return PERMISSION_MODE_TRADEOFF[mode]
}

/** What stops asking when moving from `from` to `to` (the confirmation body). */
export function wideningCopy(from: PermissionMode, to: PermissionMode): { title: string; body: string; confirmLabel: string; danger: boolean } {
  const name = permissionModeName(to)
  if (to === 'bypassPermissions') {
    return {
      title: 'Let this run act without asking?',
      body: 'Bypass skips every permission prompt, including shell commands and edits outside the project. Nothing is checked. Use it only on a folder you can restore. Open approval cards stay open.',
      confirmLabel: 'Use bypass for this run',
      danger: true
    }
  }
  const stops: Record<PermissionMode, string> = {
    auto: "Routine edits and commands no longer ask: the model's safety check approves them and asks only when unsure.",
    acceptEdits: 'File edits inside the project and its allowed folders no longer ask. Commands still ask.',
    default: 'Calls that no saved rule covers ask you instead of being refused.',
    dontAsk: '',
    plan: '',
    bypassPermissions: ''
  }
  return {
    title: `Switch this run to ${name}?`,
    body: `${stops[to] || permissionModeHelp(to)} This applies to this run only (now ${permissionModeName(from)}). Open approval cards stay open.`,
    confirmLabel: `Use ${name} for this run`,
    danger: false
  }
}

/** The mode a live or ended run shows: its own record, else the project's (runs saved before the field existed). */
export function runPermissionMode(run: Pick<RunSummary, 'permissionMode'>, project: Pick<Project, 'permissionMode'>): PermissionMode {
  return run.permissionMode ?? project.permissionMode
}

/** RunMeta shows the mode whenever it is not the plain "Ask for everything risky" one. */
export function showsModeInMeta(mode: PermissionMode): boolean {
  return mode !== 'default'
}

/** The sr-only / visible outcome of runs:setPermissionMode. */
export function permissionOutcomeText(result: { applied: boolean; reason?: string; run: Pick<RunSummary, 'status' | 'permissionMode'> }, mode: PermissionMode): { tone: 'ok' | 'saved' | 'refused'; text: string } {
  if (result.applied) return { tone: 'ok', text: `Permission mode is now ${permissionModeName(mode)}.` }
  if (result.run.permissionMode === mode && ['finished', 'error', 'paused'].includes(result.run.status)) {
    return { tone: 'saved', text: `${permissionModeName(mode)} applies from your next message.` }
  }
  return { tone: 'refused', text: result.reason || 'The permission mode was not changed.' }
}

// ---------- What a start sends ----------

export interface RunSettingsDraft {
  /** The user's model pick; null = the default. */
  model: { model: string; connection: ConnectionId } | null
  /** The user's effort pick; null = the default. */
  effort: Effort | null
  /** The user's mode pick; null = the project's mode. */
  permissionMode: PermissionMode | null
}

export const EMPTY_RUN_SETTINGS: RunSettingsDraft = { model: null, effort: null, permissionMode: null }

/**
 * The start-time fields for runs:start: only what differs from what the run would do anyway. `adapter` is the adapter
 * of the model that will run (the pick's, else the default's). An effort the adapter does not take is never sent: it is
 * fitted (fitEffort) first; a default effort that does not fit the picked model's adapter is sent fitted.
 */
export function startChoicesToSend(
  draft: RunSettingsDraft,
  defaults: { model: RunModel | null; effort: Effort | undefined; permissionMode: PermissionMode },
  adapter: ProviderId | null | undefined
): Pick<StartRunInput, 'modelSelection' | 'effort' | 'permissionMode'> {
  const out: Pick<StartRunInput, 'modelSelection' | 'effort' | 'permissionMode'> = {}
  if (draft.model && !(defaults.model && draft.model.model === defaults.model.model && draft.model.connection === defaults.model.connection)) {
    out.modelSelection = { model: draft.model.model, connection: draft.model.connection }
  }
  const wanted = draft.effort ?? defaults.effort
  const fitted = fitEffort(wanted, adapter)
  if (fitted.effort && (draft.effort !== null || fitted.fellBack)) out.effort = fitted.effort
  if (draft.permissionMode && draft.permissionMode !== defaults.permissionMode) out.permissionMode = draft.permissionMode
  return out
}
