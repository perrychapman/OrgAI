/**
 * Run settings row (docs/design/ux-review-run-start-pre.md, "Where the model, effort and permission controls go"): the
 * pure rules behind the Model, Effort, Permission and Goal controls of the New run page and the live composer. The
 * contract is StartRunInput.modelSelection / effort / permissionMode, RunSummary.rootEffort / permissionMode /
 * permissionModeChosen and runs:setPermissionMode (src/shared/types.ts). Nothing here changes project settings.
 */
import type { ConnectionId, Effort, ModelTier, ModelRef, PermissionMode, Project, ProviderId, ProviderModel, RunSummary, StaffingGoal, StartRunInput } from '@shared/types'
import { EFFORTS, isPermissionMode, runPermissionModeChoices } from '@shared/types'
import { adapterOnConnection, effortOptionsFor, modelFamily, projectConnection, resolveModelSetting, staffingGoalOf } from '@shared/defaults'
import { showsGoalChoice } from './runGoal'
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
 *
 * The connection is always the project's, even when the root role carries a `connection`: Role.connection is ignored on
 * the root (defaults.ts roleConnection, src/shared/types.ts Role.connection, main's runManager and claude.ts), so a stale
 * value on the root must not move the chip or the "same as default" test in startChoicesToSend.
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

/**
 * The tone of a mode on a chip, an option or RunMeta: Bypass skips every prompt and is the danger tone; Unattended
 * (auto) and Auto-accept edits are warnings; the rest have none. Always paired with an icon and the mode's name.
 */
export function permissionTone(mode: PermissionMode): 'danger' | 'warning' | null {
  if (mode === 'bypassPermissions') return 'danger'
  return isPermissiveMode(mode) ? 'warning' : null
}

/** Short name for the chip ("Plan only"). */
export function permissionModeName(mode: PermissionMode): string {
  return PERMISSION_MODE_SHORT[mode]
}

/** One line on what the mode does (the settings select's trade-off line). */
export function permissionModeHelp(mode: PermissionMode): string {
  return PERMISSION_MODE_TRADEOFF[mode]
}

/** What stops asking under each wider mode (the confirmation bodies). */
const WIDENING_STOPS: Record<PermissionMode, string> = {
  auto: "Routine edits and commands no longer ask: the model's safety check approves them and asks only when unsure.",
  acceptEdits: 'File edits inside the project and its allowed folders no longer ask. Commands still ask.',
  default: 'Calls that no saved rule covers ask you instead of being refused.',
  dontAsk: '',
  plan: '',
  bypassPermissions: ''
}

/**
 * The ConfirmDialog options for a schedule whose mode asks less than its target's own (docs/design/schedules.md 5):
 * the mode is standing consent for every run the schedule starts, while the user is away. Bypass never reaches here.
 */
export function scheduleWideningConfirmOptions(from: PermissionMode, to: PermissionMode, team: boolean): { title: string; body: string; confirmLabel: string; danger: boolean; confirmTestId: string; cancelLabel: string } {
  const name = permissionModeName(to)
  return {
    title: `Let every run of this schedule use ${name}?`,
    body: `${WIDENING_STOPS[to] || permissionModeHelp(to)} Each run this schedule starts uses it, including while you are away (${team ? "the project's mode is" : 'Chat runs use'} ${permissionModeName(from)}). Steps that still need approval wait for you.`,
    confirmLabel: `Use ${name} for this schedule`,
    danger: false,
    confirmTestId: 'schedule-permission-confirm',
    cancelLabel: team ? "Keep the project's mode" : 'Keep the Chat default'
  }
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
  return {
    title: `Switch this run to ${name}?`,
    body: `${WIDENING_STOPS[to] || permissionModeHelp(to)} This applies to this run only (now ${permissionModeName(from)}). Open approval cards stay open.`,
    confirmLabel: `Use ${name} for this run`,
    danger: false
  }
}

/** The ConfirmDialog options for a widening: one wording for the start page, the live chip and "Interrupt and change". */
export function wideningConfirmOptions(from: PermissionMode, to: PermissionMode): { title: string; body: string; confirmLabel: string; danger: boolean; confirmTestId: string; cancelLabel: string } {
  return { ...wideningCopy(from, to), confirmTestId: 'run-permission-confirm', cancelLabel: 'Keep current mode' }
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

// ---------- The live composer's row ----------

/** Statuses of a session that is over; its next message continues it (RunSummary.permissionMode then says what that uses). */
export function permissionSessionEnded(status: RunSummary['status']): boolean {
  return status === 'finished' || status === 'error' || status === 'paused'
}

/**
 * The mode the live permission chip shows. A live run shows the mode in force. An ended or paused run shows the mode its
 * next continuation uses, so a carried wider mode is seen before Send: the user's per-run choice when there is one, else
 * the run's exec override, else the project's mode.
 */
export function livePermissionValue(
  run: Pick<RunSummary, 'status' | 'permissionMode' | 'permissionModeChosen' | 'overrides' | 'kind' | 'quick' | 'buildWorkspace'>,
  project: Pick<Project, 'permissionMode'>
): { mode: PermissionMode; next: boolean } {
  if (!permissionSessionEnded(run.status)) return { mode: effectiveRunMode(run, runPermissionMode(run, project)), next: false }
  if (run.permissionModeChosen && run.permissionMode) return { mode: run.permissionMode, next: true }
  return { mode: effectiveRunMode(run, run.overrides?.permissionMode ?? project.permissionMode), next: true }
}

/**
 * Chat and build sessions are trust-restricted: their adapters ask in place of a mode that asks less (see
 * runPermissionModeChoices), so a project mode of auto or bypass must not be shown as theirs. A mode the run accepts stays.
 */
function effectiveRunMode(run: Pick<RunSummary, 'kind' | 'quick' | 'buildWorkspace'>, mode: PermissionMode): PermissionMode {
  const accepted = runPermissionModeChoices(run)
  return accepted.length > 0 && !accepted.includes(mode) ? 'default' : mode
}

/**
 * Running reports that kept the earlier mode (SetRunPermissionModeResult.reportsUnchanged). Read defensively: a build
 * whose shared type does not carry the field yet answers 0.
 */
export function reportsUnchangedOf(result: object): number {
  const n = (result as { reportsUnchanged?: unknown }).reportsUnchanged
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** "2 running reports keep the earlier mode until they finish." (empty for none). */
export function reportsUnchangedText(count: number): string {
  if (!(count > 0)) return ''
  return count === 1 ? '1 running report keeps the earlier mode until it finishes.' : `${count} running reports keep the earlier mode until they finish.`
}

/** The visible and spoken outcome of a live mode change: permissionOutcomeText plus the reports that kept the old mode. */
export function livePermissionOutcome(
  result: { applied: boolean; reason?: string; run: Pick<RunSummary, 'status' | 'permissionMode'> },
  mode: PermissionMode
): { tone: 'ok' | 'saved' | 'refused'; text: string; reports: string; message: string } {
  const base = permissionOutcomeText(result, mode)
  // Main's reason is shown whenever present, applied or not (a refusal already is the text). The reports count may come
  // with either outcome; when main's reason does not already say it, it is added in our words.
  const reason = result.reason?.trim() ?? ''
  const extra = base.tone !== 'refused' && reason && reason !== base.text ? reason : ''
  const shown = `${base.text} ${extra}`
  const count = reportsUnchangedOf(result)
  const reports = count > 0 && !/keeps? the earlier mode/.test(shown) ? reportsUnchangedText(count) : ''
  const message = [base.text, extra, reports].filter(Boolean).join(' ')
  return { ...base, reports, message }
}

/**
 * The mode a live permission choice is measured against for widening: a live run's mode in force (a session accept-edits
 * grant counts), an ended or paused run's next-message mode.
 */
export function permissionBaseline(
  run: Pick<RunSummary, 'status' | 'permissionMode' | 'permissionModeChosen' | 'overrides' | 'kind' | 'quick' | 'buildWorkspace'>,
  project: Pick<Project, 'permissionMode'>
): PermissionMode {
  const { mode, next } = livePermissionValue(run, project)
  return next ? mode : modeInForce(run, mode)
}

/**
 * Whether "Interrupt and change" must ask again before it re-sends `target`. A confirmation (or the no-confirmation of a
 * narrowing) only covers the baseline it was given against (`covered`); when the run's mode moved since (a project change
 * narrowed it, a card granted edits) and `target` now asks less than the current baseline, the user decides again.
 */
export function retryNeedsConfirm(covered: PermissionMode, current: PermissionMode, target: PermissionMode): boolean {
  return current !== covered && isWideningMode(current, target)
}

/** Shown when main answered for another run of the conversation (it redirected a stale id to the newest one). */
export const PERMISSION_CONTINUED_ELSEWHERE = 'This conversation continued elsewhere. Open its latest session before changing the permission mode.'

/** True when a refusal leaves a way forward: the run is replying now, so an interrupt may open a boundary. */
export function offersInterruptToChange(outcome: { tone: string }, status: RunSummary['status']): boolean {
  return outcome.tone === 'refused' && status === 'running'
}

// ---------- Mode events and the session's accept-edits grant ----------

/** The three main-owned mode fields of a run summary, as the run.permissionMode event carries them. */
export interface PermissionModeFields {
  permissionMode?: PermissionMode
  permissionModeChosen?: true
  sessionPermissionMode?: 'acceptEdits'
}

/**
 * A run.permissionMode event (RunManager only; a snapshot of the three mode fields), read structurally so this file
 * compiles against shared types with or without that event. Null for any other event or a malformed one.
 */
export function permissionModeEventPatch(e: unknown): { runId: string; fields: PermissionModeFields } | null {
  if (!e || typeof e !== 'object') return null
  const ev = e as { type?: unknown; runId?: unknown; permissionMode?: unknown; permissionModeChosen?: unknown; sessionPermissionMode?: unknown }
  if (ev.type !== 'run.permissionMode' || typeof ev.runId !== 'string') return null
  const fields: PermissionModeFields = {}
  if (isPermissionMode(ev.permissionMode)) fields.permissionMode = ev.permissionMode
  if (ev.permissionModeChosen === true) fields.permissionModeChosen = true
  if (ev.sessionPermissionMode === 'acceptEdits') fields.sessionPermissionMode = 'acceptEdits'
  return { runId: ev.runId, fields }
}

/** Replace all three mode fields (a snapshot: an absent field is absent on the summary too). */
export function applyPermissionModePatch<T extends object>(summary: T, fields: PermissionModeFields): T {
  const { permissionMode: _m, permissionModeChosen: _c, sessionPermissionMode: _s, ...rest } = summary as T & PermissionModeFields
  return { ...rest, ...fields } as T
}

/** RunSummary.sessionPermissionMode, read structurally: an "always allow edits" grant in force over a narrower run mode. */
export function sessionEditsAccepted(run: object): boolean {
  return (run as { sessionPermissionMode?: unknown }).sessionPermissionMode === 'acceptEdits'
}

/** "edits accepted this session": the suffix on the chip and RunMeta while the grant is in force. */
export const SESSION_EDITS_SUFFIX = 'edits accepted this session'

/** The effort a live run shows: its own record, else the root role's for a team run, else none (the model's default). */
export function liveEffort(run: Pick<RunSummary, 'rootEffort' | 'kind' | 'quick' | 'team'>, project: Pick<Project, 'roles'>): Effort | undefined {
  if (run.rootEffort) return run.rootEffort
  if (run.kind !== 'work' || run.quick || run.team === 'single') return undefined
  return rootRole(project)?.effort
}

/** The goal a live team run shows (null when the run has none to show: Ask, Chat, assistants, a fixed-staffing project). */
export function liveGoal(run: Pick<RunSummary, 'kind' | 'quick' | 'team' | 'overrides'>, project: Pick<Project, 'staffing' | 'staffingGoal'>): StaffingGoal | null {
  if (run.kind !== 'work' || run.quick || run.team === 'single' || !showsGoalChoice(project, false)) return null
  return run.overrides?.goal ?? staffingGoalOf(project)
}

/**
 * The mode RunMeta names (null: nothing to show). Work runs only, Chat and Ask included; setup-like runs pin their mode.
 * A live session's accept-edits grant (sessionPermissionMode) counts: it is shown even over the plain default mode.
 */
export function metaPermissionMode(run: Pick<RunSummary, 'kind' | 'permissionMode' | 'quick' | 'buildWorkspace'>, project: Pick<Project, 'permissionMode'>): PermissionMode | null {
  if (run.kind !== 'work') return null
  const mode = effectiveRunMode(run, runPermissionMode(run, project))
  return showsModeInMeta(mode) || sessionEditsAccepted(run) ? mode : null
}

/**
 * What RunMeta shows, in the chip's terms. A live run: the mode in force (metaPermissionMode). An ended or paused run:
 * the mode its next message uses (livePermissionValue, the chip's value), so the two never disagree; `next` is set only
 * when that value is a pending choice of the user (permissionModeChosen), the same rule as the chip's "Next message:"
 * prefix. Null when there is nothing to show.
 */
export function metaPermission(
  run: Pick<RunSummary, 'status' | 'kind' | 'permissionMode' | 'permissionModeChosen' | 'overrides' | 'quick' | 'buildWorkspace'>,
  project: Pick<Project, 'permissionMode'>
): { mode: PermissionMode; next: boolean } | null {
  if (run.kind !== 'work') return null
  const value = livePermissionValue(run, project)
  if (!value.next) {
    const mode = metaPermissionMode(run, project)
    return mode ? { mode, next: false } : null
  }
  return showsModeInMeta(value.mode) ? { mode: value.mode, next: run.permissionModeChosen === true } : null
}

/** RunMeta's / the chip's visible mode text: the short name, plus the session's accept-edits grant while it is in force. */
export function modeInForceLabel(run: object, mode: PermissionMode): string {
  return sessionEditsAccepted(run) && mode !== 'acceptEdits' ? `${permissionModeName(mode)} · ${SESSION_EDITS_SUFFIX}` : permissionModeName(mode)
}

/** The mode a widening is measured from: Accept edits while the session grant is in force over a narrower mode. */
export function modeInForce(run: object, mode: PermissionMode): PermissionMode {
  return sessionEditsAccepted(run) && isNarrowingMode('acceptEdits', mode) ? 'acceptEdits' : mode
}

/** The reset link in the start pickers (effort, model), one wording: the chip itself says what the default is. */
export const RESET_TO_DEFAULT_LABEL = 'Use default'

/** The model chip's help line (start page title, live picker footer): which agents the choice reaches. */
export const MODEL_HELP_TEAM = 'Model for the lead agent. Roles set to inherit follow it; other team members keep the models set in the Team tab.'
export const MODEL_HELP_ASK = 'Model for the assistant.'
export const LIVE_MODEL_HELP_TEAM = 'Applies to this conversation’s lead agent. Roles set to inherit follow it; other team members keep the models set in the Team tab.'
export const LIVE_MODEL_HELP_ASSISTANT = 'Applies to this conversation’s lead agent.'

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
