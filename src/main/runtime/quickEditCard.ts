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
    o.changes = o.changes.map((c) => {
      if (!c || typeof c !== 'object') return c
      const r = { ...(c as Record<string, unknown>) }
      if ('path' in r) r.path = abs(r.path)
      // A move destination resolves like a path (quickEditFree / quickEditCard still refuse any change carrying one).
      if (typeof r.movePath === 'string') r.movePath = abs(r.movePath)
      return r
    })
  }
  return o
}

/**
 * True when any `changes[]` entry moves its file: a `movePath` / `move_path` key at the change or in its `kind` object,
 * whatever its value except undefined / null (Codex 0.166 `kind: { type: 'update', move_path: <dest> }`, review H1). The
 * quick grant judges source paths only, so such an edit is never covered and never offered the grant. Pure.
 */
export function editHasMove(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const changes = (input as { changes?: unknown }).changes
  if (!Array.isArray(changes)) return false
  const moves = (o: unknown): boolean =>
    !!o && typeof o === 'object' && ['movePath', 'move_path'].some((k) => k in o && (o as Record<string, unknown>)[k] != null)
  return changes.some((c) => moves(c) || (!!c && typeof c === 'object' && moves((c as { kind?: unknown }).kind)))
}

/**
 * True when a raw path string has a segment made only of dots (`.`, `..`, and `...` too, which Win32 strips to nothing),
 * split on both `/` and `\`. Lexical resolution (path.join / resolve) collapses `..` before any symlink walk, while a
 * writer that hands the raw string to the kernel follows a link first: `<folder>/vendor/../.bashrc` with `vendor` a
 * link to `$HOME/sub` lands in `$HOME` (review NH1). Callers treat such a path as one they cannot clear. Pure.
 */
export function hasDotSegment(p: string): boolean {
  return p.split(/[\\/]/).some((s) => s.length > 0 && /^\.+$/.test(s))
}

/**
 * True when any path the edit input names (`file_path`, `notebook_path`, each `changes[].path` and each move
 * destination: `movePath` / `move_path` at the change or in its `kind`) is a string with a dot segment (hasDotSegment).
 * Checked on the raw text, before editInputAt joins anything. Pure.
 */
export function editHasDotSegment(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const o = input as Record<string, unknown>
  const bad = (p: unknown): boolean => typeof p === 'string' && hasDotSegment(p)
  if (bad(o.file_path) || bad(o.notebook_path)) return true
  if (!Array.isArray(o.changes)) return false
  return o.changes.some((c) => {
    if (!c || typeof c !== 'object') return false
    const r = c as Record<string, unknown>
    const kind = r.kind && typeof r.kind === 'object' ? (r.kind as Record<string, unknown>) : undefined
    return [r.path, r.movePath, r.move_path, kind?.movePath, kind?.move_path].some(bad)
  })
}

/**
 * True when a quick run's session edit grant covers this edit (relative targets resolved against `cwd`). An edit that
 * moves a file (editHasMove) or names a path with a `.` / `..` segment (editHasDotSegment, review NH1) is never
 * covered, whatever quick/sessionEdits.ts decides.
 */
export function quickEditFree(
  ctx: { run: Pick<RunSummary, 'quick'>; quickSessionEdits?: () => boolean },
  toolName: string,
  input: unknown,
  cwd: string
): boolean {
  if (editHasMove(input) || editHasDotSegment(input)) return false
  return quickEditPreApproved(ctx, toolName, editInputAt(input, cwd))
}

/**
 * The card's suggestions and labels: the provider-side suggestions (already filtered for the run) plus, on a quick run
 * whose edit is covered (no move, no dot segment), the quick session edit suggestion with QUICK_SESSION_EDIT_LABEL. `provider` is returned
 * untouched so the adapter can keep handing only it to applyAllowScope.
 */
export function quickEditCard(
  run: Pick<RunSummary, 'quick'>,
  toolName: string,
  input: unknown,
  cwd: string,
  provider: PermissionSuggestion[]
): { suggestions: PermissionSuggestion[]; ruleLabels: string[]; quick: boolean } {
  const offer = editHasMove(input) || editHasDotSegment(input) ? null : quickSessionEditSuggestion(run, toolName, editInputAt(input, cwd))
  const labels = suggestionLabels(provider)
  if (!offer) return { suggestions: provider, ruleLabels: labels, quick: false }
  return { suggestions: [...provider, offer], ruleLabels: [...labels, QUICK_SESSION_EDIT_LABEL], quick: true }
}
