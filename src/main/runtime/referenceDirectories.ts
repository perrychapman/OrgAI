import { isAbsolute, join } from 'node:path'
import { canonicalDeep, isInside } from '../quick/scratch'

/**
 * Reference folders (Project.referenceDirectories, RuntimeContext.referenceDirectories): agents may read them, never
 * change them. Provider-neutral helpers every adapter calls from its edit gate (Claude PreToolUse, Codex file
 * approvals, the mock). Bash writes are not covered (see RuntimeContext.referenceDirectories).
 */

/** The edit tools refused under a reference folder. */
export const REFERENCE_EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** The one refusal text: "<folder> is a reference folder: agents may read it, not change it". */
export function referenceFolderMessage(folder: string): string {
  return `${folder} is a reference folder: agents may read it, not change it`
}

/**
 * The reference folder that contains `target`, or null. A relative target resolves against `cwd` (the agent's
 * working folder; without one a relative target is checked as given). Compared lexically and through the real path of
 * the nearest existing ancestor (scratch.ts canonicalDeep), against each folder as given and as its own real path, so
 * a link or junction into a reference folder is caught. A non-string or empty target returns null: callers that must
 * fail closed use referenceEditDenial.
 */
export function referenceFolderOf(target: unknown, refs: readonly string[], cwd?: string): string | null {
  if (typeof target !== 'string' || !target || target.includes('\0')) return null
  const usable = refs.filter((r) => typeof r === 'string' && r !== '' && isAbsolute(r))
  if (!usable.length) return null
  const abs = isAbsolute(target) ? target : cwd ? join(cwd, target) : target
  let real = abs
  try {
    real = canonicalDeep(abs)
  } catch {
    // Unresolvable: the lexical check alone.
  }
  for (const ref of usable) {
    let refReal = ref
    try {
      refReal = canonicalDeep(ref)
    } catch {
      // Keep the given spelling.
    }
    if ([ref, refReal].some((r) => isInside(r, abs) || isInside(r, real))) return ref
  }
  return null
}

/** The path an edit tool's input names: NotebookEdit's notebook_path, else file_path (either key as a fallback). */
export function editTargetOf(toolName: string, input: unknown): unknown {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return toolName === 'NotebookEdit' ? (i.notebook_path ?? i.file_path) : (i.file_path ?? i.notebook_path)
}

/**
 * Why this tool call must be refused, or null. Only the REFERENCE_EDIT_TOOLS and only when `refs` is non-empty:
 * a path under a reference folder is refused with referenceFolderMessage(folder); a missing, empty or non-string path
 * is refused too (fails closed) with a message naming the first reference folder.
 */
export function referenceEditDenial(toolName: string, input: unknown, refs: readonly string[] | undefined, cwd?: string): string | null {
  if (!REFERENCE_EDIT_TOOLS.has(toolName) || !refs?.length) return null
  const target = editTargetOf(toolName, input)
  if (typeof target !== 'string' || !target) return `${referenceFolderMessage(refs[0])}; this ${toolName} call names no file path, so it was refused`
  const hit = referenceFolderOf(target, refs, cwd)
  return hit ? referenceFolderMessage(hit) : null
}
