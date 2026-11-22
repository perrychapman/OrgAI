/**
 * The host's check before a request that changes something, on a data folder several orgai sessions share
 * (docs/design/cli-sessions.md): the projects and runs the request names must be this session's to change.
 *
 * - A run that another running session hosts can be read here, never changed: RunBusyError.
 * - A stored project the request names (directly, or through one of its runs) is claimed for this session; when another
 *   session holds it: ProjectBusyError. One session per project keeps the project's own files (team, worktrees, notes,
 *   outputs, staffing profile) with one writer, which is what every project service assumes.
 *
 * Both reach the client as `session_busy` (exit 6 in the CLI). Read requests are never checked: every session sees every
 * project and run. A request that names no stored project or run (settings, connections, the libraries) passes: the
 * files behind those are written under the data folder's write lock (store/shared/storeSync.ts).
 *
 * The ids are found by looking at the request's own values, not by a per-channel table: every string in the arguments
 * (a few levels deep, long text skipped) that is the id of a stored project or run counts. A new channel is therefore
 * covered without anybody remembering to list it; the cost of a coincidence (a short text equal to an id) is a claim
 * this session did not strictly need.
 *
 * Electron-free; relative imports only.
 */
import { isVirtualProjectId } from '../../shared/types'
import type { Project, RunSummary } from '../../shared/types'
import { RunBusyError } from './sessions'
import type { StoreSync } from '../store/shared/storeSync'

/** Strings longer than this are text (a prompt, a file), never an id. */
const ID_MAX_CHARS = 200
/** How deep into the arguments ids are looked for, and how many values are looked at. */
const MAX_DEPTH = 5
const MAX_VALUES = 4000

/** Every short string in `args` (object values and array items, bounded). */
export function shortStringsIn(args: readonly unknown[]): Set<string> {
  const out = new Set<string>()
  let seen = 0
  const walk = (v: unknown, depth: number): void => {
    if (seen >= MAX_VALUES) return
    seen += 1
    if (typeof v === 'string') {
      if (v.length > 0 && v.length <= ID_MAX_CHARS) out.add(v)
      return
    }
    if (v === null || typeof v !== 'object' || depth >= MAX_DEPTH) return
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1)
      return
    }
    // Typed arrays and buffers (image bytes) hold no ids.
    if (ArrayBuffer.isView(v)) return
    for (const item of Object.values(v as Record<string, unknown>)) walk(item, depth + 1)
  }
  for (const a of args) walk(a, 0)
  return out
}

export interface SessionGuardDeps {
  sync: StoreSync
  /** A stored project by id (ProjectStore.get). */
  project(id: string): Pick<Project, 'id' | 'name'> | null | undefined
  /** A run's summary by id, stored or live (RunStore.get). */
  run(id: string): Pick<RunSummary, 'id' | 'projectId'> | null | undefined
  /** The id of another running session hosting this run, or null (RunStore.hostedElsewhere). */
  hostedElsewhere(runId: string): string | null
}

/** The check for one mutating request; throws RunBusyError or ProjectBusyError. A no-op when the folder is not shared. */
export function createSessionGuard(deps: SessionGuardDeps): (channel: string, args: readonly unknown[]) => void {
  return (_channel, args) => {
    if (!deps.sync.shared) return
    const projects = new Map<string, string>()
    for (const text of shortStringsIn(args)) {
      const run = deps.run(text)
      if (run) {
        const owner = deps.hostedElsewhere(run.id)
        if (owner) throw new RunBusyError(run.id, deps.sync.session?.others().find((s) => s.hostInstanceId === owner))
        if (!isVirtualProjectId(run.projectId)) {
          const p = deps.project(run.projectId)
          if (p) projects.set(p.id, p.name)
        }
        continue
      }
      if (isVirtualProjectId(text)) continue
      const p = deps.project(text)
      if (p) projects.set(p.id, p.name)
    }
    for (const [id, name] of projects) deps.sync.requireProject(id, name ? `The project ${name}` : undefined)
  }
}
