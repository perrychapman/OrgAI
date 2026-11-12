/**
 * Pure logic behind /model, /effort, /mode and /goal and Shift+Tab: resolving what the user typed against the model
 * catalog, which permission modes a run offers, and when a live model switch must wait (CLAUDE.md live-switch rules:
 * an idle safe boundary, no open decisions, and a different connection needs the session ended first).
 */
import {
  EFFORTS,
  MODEL_TIERS,
  STAFFING_GOALS,
  runPermissionModeChoices,
  type ConnectionId,
  type Effort,
  type ModelTier,
  type PermissionMode,
  type ProviderModel,
  type RunSummary,
  type StaffingGoal
} from '../../shared/types'
import { sanitizeTty } from './sanitizeTty'
import type { TuiState } from './types'

export const EFFORT_WORDS: readonly Effort[] = EFFORTS
export const GOAL_WORDS: readonly StaffingGoal[] = STAFFING_GOALS
export const TIER_WORDS: readonly ModelTier[] = ['fast', 'everyday', 'deep', 'top'].filter((t): t is ModelTier => (MODEL_TIERS as readonly string[]).includes(t))
/** The modes /mode and Shift+Tab cycle through, safest first. dontAsk and bypassPermissions stay explicit-only. */
export const CYCLE_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto']

export const isTier = (w: string): w is ModelTier => (TIER_WORDS as readonly string[]).includes(w)

/** A model for a tier word or a model id / label, preferring `prefer`'s connection. */
export function pickModel(models: readonly ProviderModel[], arg: string, prefer?: ConnectionId): ProviderModel | { error: string } {
  const want = sanitizeTty(arg).replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!want) return { error: 'Name a model: /model fast|everyday|deep|top|<model id>.' }
  const lower = want.toLowerCase()
  const rank = (m: ProviderModel): number => (prefer !== undefined && m.connection === prefer ? 0 : 1) * 2 + (m.recommended ? 0 : 1)
  const best = (list: ProviderModel[]): ProviderModel | undefined => [...list].sort((a, b) => rank(a) - rank(b))[0]
  if (isTier(lower)) {
    const hit = best(models.filter((m) => m.tier === lower))
    return hit ?? { error: `No ${lower} model is available${prefer ? ' on this connection' : ''}. Try /model <model id>.` }
  }
  const exact = best(models.filter((m) => m.id === want))
  if (exact) return exact
  const loose = best(models.filter((m) => m.id.toLowerCase() === lower || m.label.toLowerCase() === lower))
  return loose ?? { error: `No model "${want}" in the catalog.` }
}

const activeSummary = (s: TuiState): RunSummary | undefined => (s.activeRunId ? s.runs[s.activeRunId]?.summary : undefined)

/** Why a live switch to `target` must wait, or undefined when the host may be asked (it enforces the rest). */
export function modelSwitchBlock(s: TuiState, target: Pick<ProviderModel, 'connection'>): string | undefined {
  const run = activeSummary(s)
  if (!run) return undefined
  const open = run.status === 'starting' || run.status === 'running' || run.status === 'idle' || run.status === 'stopping'
  if (run.status === 'starting' || run.status === 'running' || run.status === 'stopping') {
    return 'The run is working. Wait until it is idle (or /interrupt it), then switch models.'
  }
  const pending = s.runs[run.id]?.cards
  if (pending && Object.values(pending).some((l) => Array.isArray(l) && l.length > 0)) return 'Answer the open decisions first, then switch models.'
  const current = run.modelSelection?.connection
  if (open && current !== undefined && current !== target.connection) {
    return 'That model is on another connection. End the session (/stop), choose the model, then send a message to continue.'
  }
  return undefined
}

/** The modes the followed run accepts (the CYCLE_MODES subset); all of them when no run is followed. */
export function modeChoices(s: TuiState): PermissionMode[] {
  // A composer starting a new run (/new, /ask) follows no run: every mode can be staged for the new one.
  const run = s.composeTarget === 'new' ? undefined : activeSummary(s)
  if (!run) return [...CYCLE_MODES]
  const allowed = runPermissionModeChoices(run)
  return CYCLE_MODES.filter((m) => allowed.includes(m))
}

/** The mode in force for display: an accept-edits grant widens the run's own mode. */
export function modeInForce(run: RunSummary | undefined, staged?: PermissionMode): PermissionMode | undefined {
  return run ? (run.sessionPermissionMode ?? run.permissionMode) : staged
}

/** The mode after `current` in the cycle (the first when current is not in the list). */
export function nextMode(current: PermissionMode | undefined, choices: readonly PermissionMode[]): PermissionMode | undefined {
  if (choices.length === 0) return undefined
  const at = current === undefined ? -1 : choices.indexOf(current)
  return choices[(at + 1) % choices.length]
}

/** The sentence that lists what /mode accepts right now. */
export function modeSwitchHint(s: TuiState): string {
  const choices = modeChoices(s)
  return choices.length ? `Use /mode ${choices.join('|')}.` : 'This run pins its own mode.'
}
