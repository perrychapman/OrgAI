/**
 * The host's check before a request that changes something, on a data folder several orgai sessions share
 * (docs/design/cli-sessions.md).
 *
 * - A run that another running session hosts can be read here, never changed: RunBusyError.
 * - A stored project the request names (directly, or through one of its runs) is opened for this session
 *   (sessions.ts): any number of sessions can have a project open, and its files are changed under the data folder's
 *   write lock on their newest content. Opening fails only while another session is removing or moving the project.
 * - Removing a project, moving it to another folder, or taking OrgAI out of its repository needs it alone: refused
 *   (ProjectBusyError) while another session has it open, and held alone until the request is done.
 * - Merging or discarding report branches is refused (WorktreesBusyError) while another session hosts a run that is
 *   working in that project: those branches may be that run's work in progress.
 *
 * All of these reach the client as `session_busy` (exit 6 in the CLI). Read requests are never checked: every session
 * sees every project and run. A request that names no stored project or run (settings, connections, the libraries)
 * passes: the files behind those are written under the write lock (store/shared/storeSync.ts).
 *
 * The ids are found by looking at the request's own values, not by a per-channel table: every string in the arguments
 * (a few levels deep, long text skipped) that is the id of a stored project or run counts. A new channel is therefore
 * covered without anybody remembering to list it; the cost of a coincidence (a short text equal to an id) is a project
 * this session has open without strictly needing it.
 *
 * Electron-free; relative imports only.
 */
import { IPC, isVirtualProjectId } from '../../shared/types'
import type { Project, RunSummary } from '../../shared/types'
import { ProjectBusyError, RunBusyError, SessionBusyError, sessionWords, type SessionRecord } from './sessions'
import type { StoreSync } from '../store/shared/storeSync'

/** Strings longer than this are text (a prompt, a file), never an id. */
const ID_MAX_CHARS = 200
/** How deep into the arguments ids are looked for, and how many values are looked at. */
const MAX_DEPTH = 5
const MAX_VALUES = 4000

/**
 * Every short string in `args` (object values and array items), bounded in depth and count. The walk is breadth
 * first: the ids of a request sit near its top (`projectId`, `runId`, a project's own `id`), so they are reached before
 * the count limit even when a large object (a project with many roles and long prompts) hangs below them.
 */
export function shortStringsIn(args: readonly unknown[]): Set<string> {
  const out = new Set<string>()
  let seen = 0
  let level: unknown[] = [...args]
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && seen < MAX_VALUES; depth++) {
    const next: unknown[] = []
    for (const v of level) {
      if (seen >= MAX_VALUES) break
      seen += 1
      if (typeof v === 'string') {
        if (v.length > 0 && v.length <= ID_MAX_CHARS) out.add(v)
        continue
      }
      // Typed arrays and buffers (image bytes) hold no ids.
      if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v)) continue
      if (Array.isArray(v)) for (const item of v) next.push(item)
      else for (const item of Object.values(v as Record<string, unknown>)) next.push(item)
    }
    level = next
  }
  return out
}

export interface SessionGuardDeps {
  sync: StoreSync
  /** A stored project by id (ProjectStore.get). */
  project(id: string): Pick<Project, 'id' | 'name' | 'path'> | null | undefined
  /** A run's summary by id, stored or live (RunStore.get). */
  run(id: string): Pick<RunSummary, 'id' | 'projectId'> | null | undefined
  /** The id of another running session hosting this run, or null (RunStore.hostedElsewhere). */
  hostedElsewhere(runId: string): string | null
  /** The other running sessions hosting a run of this project that is working right now (RunStore.workingElsewhereIn). */
  workingElsewhereIn(projectId: string): string[]
}

/** Channels that end a project here: nobody else may have it open, and this session does not keep it open afterwards. */
const REMOVES_PROJECT: ReadonlySet<string> = new Set([IPC.projectsRemove])
/**
 * Channels that need the project alone and leave it this session's: taking OrgAI out of its repository removes the
 * `.orgai/` files, the worktrees and the setup of a project that stays.
 */
const NEEDS_ALONE: ReadonlySet<string> = new Set([IPC.maintUninstall])
/** Channels that act on a repository's report branches, whoever made them. */
const TOUCHES_WORKTREES: ReadonlySet<string> = new Set([IPC.maintIntegrate, IPC.maintDiscard])

/** Report branches of a project cannot be merged or discarded here while another session's run is working in it. */
export class WorktreesBusyError extends SessionBusyError {
  constructor(readonly projectId: string, readonly holder: SessionRecord | undefined, what = 'This project') {
    super(`${what} has a run working in another orgai session${sessionWords(holder)}: its report branches may be that run's work in progress. Merge or discard them there, or once it is idle.`)
    this.name = 'WorktreesBusyError'
  }
}

/**
 * The check for one mutating request. Throws RunBusyError, ProjectBusyError or WorktreesBusyError. May return a
 * function the caller runs once the request is done (it gives back a project held alone). A no-op when the folder is
 * not shared.
 */
export function createSessionGuard(deps: SessionGuardDeps): (channel: string, args: readonly unknown[]) => void | (() => void) {
  const sessionOf = (id: string | undefined): SessionRecord | undefined => (id ? deps.sync.session?.others().find((s) => s.hostInstanceId === id) : undefined)
  return (channel, args) => {
    const session = deps.sync.session
    if (!deps.sync.shared || !session) return
    const projects = new Map<string, Pick<Project, 'id' | 'name' | 'path'>>()
    for (const text of shortStringsIn(args)) {
      const run = deps.run(text)
      if (run) {
        const owner = deps.hostedElsewhere(run.id)
        if (owner) throw new RunBusyError(run.id, sessionOf(owner))
        if (!isVirtualProjectId(run.projectId)) {
          const p = deps.project(run.projectId)
          if (p) projects.set(p.id, p)
        }
        continue
      }
      if (isVirtualProjectId(text)) continue
      const p = deps.project(text)
      if (p) projects.set(p.id, p)
    }
    const what = (p: Pick<Project, 'name'>): string | undefined => (p.name ? `The project ${p.name}` : undefined)
    if (TOUCHES_WORKTREES.has(channel)) {
      for (const p of projects.values()) {
        const elsewhere = deps.workingElsewhereIn(p.id)
        if (elsewhere.length) throw new WorktreesBusyError(p.id, sessionOf(elsewhere[0]), what(p))
      }
    }
    // Alone: a removal, an uninstall, or a save that moves the project to another folder.
    const alone = [...projects.values()].filter((p) => REMOVES_PROJECT.has(channel) || NEEDS_ALONE.has(channel) || (channel === IPC.projectsSave && movesProject(args, p)))
    const held: Array<{ release(reopen: boolean): void; reopen: boolean }> = []
    try {
      for (const p of alone) {
        const r = session.exclusiveProject(p.id)
        if (!r.ok) throw new ProjectBusyError(p.id, r.holders[0], what(p))
        // After a removal there is nothing to keep open; a moved project stays this session's.
        held.push({ release: (reopen) => r.held.release(reopen), reopen: !REMOVES_PROJECT.has(channel) })
      }
      for (const p of projects.values()) if (!alone.includes(p)) deps.sync.requireProject(p.id, what(p))
    } catch (e) {
      for (const h of held) h.release(true)
      throw e
    }
    if (!held.length) return
    return () => {
      for (const h of held) h.release(h.reopen)
    }
  }
}

/** A projects:save whose project (the first argument) carries another folder than the stored one. */
function movesProject(args: readonly unknown[], stored: Pick<Project, 'id' | 'path'>): boolean {
  const next = args[0]
  if (next === null || typeof next !== 'object') return false
  const { id, path } = next as { id?: unknown; path?: unknown }
  return id === stored.id && typeof path === 'string' && path !== stored.path
}
