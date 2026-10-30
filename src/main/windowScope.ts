import type { FocusRunTarget } from '@shared/types'

/**
 * Multi-window helpers, pure so they are unit-testable without Electron. A window is either the main (unscoped)
 * window or scoped to one run; a run-scoped window loads the renderer at `#/run/<projectId>/<runId>`
 * (runWindowHash in src/shared/types.ts). index.ts keeps the Map<BrowserWindow, FocusRunTarget | undefined>.
 */

/** Ids from the renderer: newId() output (and older hand-made ids) never exceed this or contain other characters. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** Validate a window:openRun target against the stores. Throws on anything malformed, unknown or mismatched. */
export function checkRunTarget(
  input: unknown,
  lookup: { project(id: string): unknown; runProject(runId: string): string | undefined }
): FocusRunTarget {
  const t = (input && typeof input === 'object' ? input : {}) as Partial<FocusRunTarget>
  const projectId = typeof t.projectId === 'string' ? t.projectId : ''
  const runId = typeof t.runId === 'string' ? t.runId : ''
  if (!ID_PATTERN.test(projectId) || !ID_PATTERN.test(runId)) throw new Error('Invalid run target')
  if (!lookup.project(projectId)) throw new Error('Project not found')
  const owner = lookup.runProject(runId)
  if (!owner) throw new Error('Run not found')
  if (owner !== projectId) throw new Error('Run belongs to another project')
  return { projectId, runId }
}

/** The window already scoped to this run, if any. */
export function scopedWindow<W>(windows: Iterable<[W, FocusRunTarget | undefined]>, runId: string): W | undefined {
  for (const [w, scope] of windows) if (scope?.runId === runId) return w
  return undefined
}

/**
 * The window a notification click for `target` should focus: one scoped to that run, else the main (unscoped)
 * window, else any window. `windows` holds only live windows.
 */
export function pickFocusWindow<W>(windows: Iterable<[W, FocusRunTarget | undefined]>, target: FocusRunTarget): W | undefined {
  const list = [...windows]
  return scopedWindow(list, target.runId) ?? list.find(([, scope]) => !scope)?.[0] ?? list[0]?.[0]
}
