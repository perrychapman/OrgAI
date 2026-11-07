import { lstatSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { hiddenCharIn } from '../capabilities/sanitize'
import type { PermissionDecision, PermissionRequest, PermissionSuggestion, RunSummary } from '@shared/types'
import { QUICK_WRITE_TOOLS } from '@shared/types'
import { canonicalDeep, isInside, isNetworkPath, pathKey } from './scratch'

/**
 * Session edit grants on Chat (quick) runs. A quick run stays in the asking permission mode on every provider (never
 * acceptEdits), so "Allow for session" on an edit cannot be a provider setMode. Instead:
 *
 * - The adapter adds `quickSessionEditSuggestion(...)` (a `setMode acceptEdits` suggestion with destination
 *   'session') to the card of an edit whose every target `quickFolderEditCovered` accepts, so the card offers
 *   "Allow for session". The suggestion is never handed to the provider (no updatedPermissions, no CLI mode change).
 * - RunManager.decide() re-checks the card with `isQuickSessionEditGrant` and, on a session allow, sets the run's
 *   flag behind `RuntimeContext.quickSessionEdits`.
 * - From then on the adapter answers allow without a card for an edit `quickEditPreApproved` accepts. Anything else
 *   (outside the folder, a protected folder or file, a folder-wide grant request, a command) still asks.
 *
 * Pure apart from realpath reads (canonicalDeep); never touches a network path.
 */

/** Tools a quick session edit grant covers (file edits only; commands never). */
export const QUICK_SESSION_EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Folder names (any depth, case-insensitive) whose contents always ask, even after a session edit grant. */
export const QUICK_SESSION_ASK_DIRS: readonly string[] = ['.git', '.claude', '.codex', '.agents', '.orgai', '.vscode', '.idea', '.github']

/** File names (any depth, case-insensitive) that always ask: config or instructions another tool or a later run loads. */
export const QUICK_SESSION_ASK_FILES: readonly string[] = [
  '.mcp.json',
  'claude.md',
  'claude.local.md',
  'agents.md',
  'agents.override.md',
  '.envrc',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.gitattributes',
  '.gitmodules'
]

const ASK_DIRS = new Set(QUICK_SESSION_ASK_DIRS)
const ASK_FILES = new Set(QUICK_SESSION_ASK_FILES)
const WRITE_TOOLS = new Set(QUICK_WRITE_TOOLS)

/** True for a tool whose call counts as an edit or a command on a quick run (PermissionRequest.quickReadOnly). */
export function isQuickWriteTool(toolName: unknown): boolean {
  return typeof toolName === 'string' && WRITE_TOOLS.has(toolName)
}

/**
 * The files an edit call writes: Codex-style `changes[].path` when a non-empty `changes` array is present, else
 * `file_path` / `notebook_path`. Null for another tool, a folder-wide request (`grantRoot`), or a malformed input.
 */
export function editTargets(toolName: string, input: unknown): string[] | null {
  if (!QUICK_SESSION_EDIT_TOOLS.has(toolName)) return null
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (o.grantRoot !== undefined && o.grantRoot !== null && o.grantRoot !== '') return null
  if (Array.isArray(o.changes) && o.changes.length) {
    // A change that moves the file carries a destination the grant would have to judge too: fail closed.
    for (const c of o.changes) {
      if (c && typeof c === 'object') {
        const r = c as Record<string, unknown>
        if ((typeof r.movePath === 'string' && r.movePath !== '') || (typeof r.move_path === 'string' && r.move_path !== '')) return null
      }
    }
    const paths = o.changes.map((c) => (c && typeof c === 'object' ? (c as { path?: unknown }).path : undefined))
    return paths.every((p): p is string => typeof p === 'string' && p !== '') ? paths : null
  }
  const p = typeof o.file_path === 'string' && o.file_path ? o.file_path : typeof o.notebook_path === 'string' && o.notebook_path ? o.notebook_path : undefined
  return p ? [p] : null
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

function relInside(parent: string, child: string): string | null {
  if (!isInside(parent, child)) return null
  return relative(pathKey(parent), pathKey(child))
}

function segmentsOk(rel: string, platform: NodeJS.Platform): boolean {
  let segs = rel.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase())
  if (!segs.length) return false
  // An agent worktree of this folder (<folder>/.claude/worktrees/<name>/...): judge the path inside the worktree.
  if (segs[0] === '.claude' && segs[1] === 'worktrees' && segs.length > 3) segs = segs.slice(3)
  for (const s of segs) {
    if (s === '.' || s === '..' || ASK_DIRS.has(s)) return false
    // Windows alternate spellings of a protected name: trailing dot or space, streams (`:`), 8.3 short names (`GIT~1`).
    if (platform === 'win32' && (/[. ]$/.test(s) || s.includes(':') || /~\d/.test(s))) return false
  }
  return !ASK_FILES.has(segs[segs.length - 1])
}

/**
 * True when a session edit grant may cover writing `target` on a quick run working in `folder`: the target (absolute,
 * or relative to `folder`) is strictly inside the folder both lexically (against either spelling of the folder) and by
 * the real path of its nearest existing ancestor, and no component below the folder (leaf included) is a symlink or
 * junction, dangling or not (lstat; any link inside the folder is refused, so a link can never carry a write out), and no
 * part of the path inside the folder is a QUICK_SESSION_ASK_DIRS folder or a QUICK_SESSION_ASK_FILES file (an agent
 * worktree under `.claude/worktrees/<name>` is judged from inside the worktree). Never true for a network path, a
 * path with control characters, or the folder itself.
 */
export function quickFolderEditCovered(folder: string, target: unknown, platform: NodeJS.Platform = process.platform): boolean {
  if (typeof folder !== 'string' || !folder || !isAbsolute(folder)) return false
  if (typeof target !== 'string' || !target || CONTROL.test(target) || hiddenCharIn(target) !== null) return false
  const abs = isAbsolute(target) ? target : join(folder, target)
  if (isNetworkPath(abs) || isNetworkPath(folder)) return false
  let realFolder: string
  let realTarget: string
  try {
    realFolder = canonicalDeep(folder)
    realTarget = canonicalDeep(abs)
  } catch {
    return false
  }
  const lexical = resolve(abs)
  const lexBase = relInside(resolve(folder), lexical) !== null ? resolve(folder) : realFolder
  const lexRel = relInside(lexBase, lexical)
  const realRel = relInside(realFolder, realTarget)
  if (lexRel === null || realRel === null) return false
  if (!noLinkBelow(lexBase, lexRel)) return false
  return segmentsOk(lexRel, platform) && segmentsOk(realRel, platform)
}

/**
 * True when no existing component from `base` down through `rel` (leaf included) is a symlink or junction. lstat, so a
 * dangling link counts: the real-path check walks up while existsSync is false and existsSync follows links, which
 * would read `<folder>/docs/out.md -> elsewhere` as a plain missing file. A missing component ends the walk (nothing
 * below it exists); any other error fails closed.
 */
function noLinkBelow(base: string, rel: string): boolean {
  let cur = base
  for (const seg of rel.split(/[\\/]+/).filter(Boolean)) {
    cur = join(cur, seg)
    try {
      if (lstatSync(cur).isSymbolicLink()) return false
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return true
      return false
    }
  }
  return true
}

/** True when every file an edit call writes is covered (`editTargets` + `quickFolderEditCovered`). */
export function quickEditCovered(folder: string, toolName: string, input: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const targets = editTargets(toolName, input)
  return !!targets && targets.length > 0 && targets.every((t) => quickFolderEditCovered(folder, t, platform))
}

/** The card suggestion that offers a quick session edit grant. Never handed to a provider. */
export const QUICK_SESSION_EDIT_SUGGESTION: PermissionSuggestion = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }

/**
 * The suggestion an adapter adds to the card of a quick run's edit (a fresh object each call), or null when the run
 * is not a quick run or the edit is not covered. Adapters still drop every other setMode suggestion on
 * trust-restricted runs.
 */
export function quickSessionEditSuggestion(run: Pick<RunSummary, 'quick'> | undefined | null, toolName: string, input: unknown): PermissionSuggestion | null {
  const folder = run?.quick?.folder
  if (!folder || !quickEditCovered(folder, toolName, input)) return null
  return { ...QUICK_SESSION_EDIT_SUGGESTION }
}

/** True for the quick session edit suggestion (adapters filter it out of anything they pass to a provider). */
export function isQuickSessionEditSuggestion(s: PermissionSuggestion | undefined | null): boolean {
  return !!s && s.type === 'setMode' && s.mode === 'acceptEdits' && s.destination === 'session'
}

/**
 * RunManager.decide(): true when this answer turns on the run's session edit grant: a quick run, an allow with scope
 * 'session' (after any narrowing), a card that offered the quick session edit suggestion, and the card's own tool and
 * input re-checked here (never trusting the adapter's suggestion alone).
 */
export function isQuickSessionEditGrant(
  summary: Pick<RunSummary, 'quick'>,
  request: Pick<PermissionRequest, 'toolName' | 'input' | 'suggestions' | 'referenceFolder'>,
  decision: PermissionDecision | undefined | null
): boolean {
  if (!summary.quick || request.referenceFolder) return false
  if (decision?.behavior !== 'allow' || decision.scope !== 'session') return false
  if (!(request.suggestions ?? []).some(isQuickSessionEditSuggestion)) return false
  return quickEditCovered(summary.quick.folder, request.toolName, request.input)
}

/**
 * Adapters: true when an edit call needs no card because the user granted session edits on this quick run and every
 * file it writes is covered. False on any other run.
 */
export function quickEditPreApproved(
  ctx: { run: Pick<RunSummary, 'quick'>; quickSessionEdits?: () => boolean },
  toolName: string,
  input: unknown
): boolean {
  const folder = ctx.run.quick?.folder
  if (!folder || ctx.quickSessionEdits?.() !== true) return false
  return quickEditCovered(folder, toolName, input)
}
