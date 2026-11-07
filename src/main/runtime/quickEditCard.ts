import { isAbsolute, join } from 'node:path'
import type { PermissionSuggestion, RunSummary } from '@shared/types'
import { quickEditPreApproved, quickSessionEditSuggestion } from '../quick/sessionEdits'
import { suggestionLabels } from './permissionRules'

/**
 * Adapter-neutral helpers for Chat (quick) session edit grants, shared by the Claude, Codex and mock adapters. The
 * quick session edit suggestion (quick/sessionEdits.ts) only ever goes on the card: adapters keep the provider's own
 * suggestions apart and hand only those to applyAllowScope / the provider, so "Allow for session" never becomes a
 * provider mode change. RunManager.decide() sets the run's session edit flag.
 */

/** The card label of the quick session edit suggestion (suggestionLabels would call it a project-wide mode). */
export const QUICK_SESSION_EDIT_LABEL = "File edits in this chat's folder"

/**
 * The edit input with relative targets (`file_path`, `notebook_path`, Codex-style `changes[].path`) resolved against
 * the calling agent's cwd, so the quick folder check judges the file the tool will really write. Other fields and
 * absolute paths are kept as they are. Pure.
 */
export function editInputAt(input: unknown, cwd: string): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {}
  const o = { ...(input as Record<string, unknown>) }
  const abs = (p: unknown): unknown => (typeof p === 'string' && p && !isAbsolute(p) && cwd ? join(cwd, p) : p)
  if ('file_path' in o) o.file_path = abs(o.file_path)
  if ('notebook_path' in o) o.notebook_path = abs(o.notebook_path)
  if (Array.isArray(o.changes)) {
    o.changes = o.changes.map((c) => (c && typeof c === 'object' && 'path' in c ? { ...(c as Record<string, unknown>), path: abs((c as { path?: unknown }).path) } : c))
  }
  return o
}

/** True when a quick run's session edit grant covers this edit (relative targets resolved against `cwd`). */
export function quickEditFree(
  ctx: { run: Pick<RunSummary, 'quick'>; quickSessionEdits?: () => boolean },
  toolName: string,
  input: unknown,
  cwd: string
): boolean {
  return quickEditPreApproved(ctx, toolName, editInputAt(input, cwd))
}

/**
 * The card's suggestions and labels: the provider-side suggestions (already filtered for the run) plus, on a quick run
 * whose edit is covered, the quick session edit suggestion with QUICK_SESSION_EDIT_LABEL. `provider` is returned
 * untouched so the adapter can keep handing only it to applyAllowScope.
 */
export function quickEditCard(
  run: Pick<RunSummary, 'quick'>,
  toolName: string,
  input: unknown,
  cwd: string,
  provider: PermissionSuggestion[]
): { suggestions: PermissionSuggestion[]; ruleLabels: string[]; quick: boolean } {
  const offer = quickSessionEditSuggestion(run, toolName, editInputAt(input, cwd))
  const labels = suggestionLabels(provider)
  if (!offer) return { suggestions: provider, ruleLabels: labels, quick: false }
  return { suggestions: [...provider, offer], ruleLabels: [...labels, QUICK_SESSION_EDIT_LABEL], quick: true }
}
