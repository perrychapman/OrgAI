/**
 * Shutdown contracts (Wave 7, docs/design/cli-standalone.md 4.3): one coordinator for every exit path, ownership
 * released only once the owner's writes are done, and a process-wide registry of the child processes a host must kill
 * when it gives up at the hard limit (git under the repo lock, custodian helpers, agent CLIs).
 *
 * Contracts only, except the child registry, which is complete and tiny so spawners (WP-C, WP-F, WP-G) can register
 * their children today. The coordinator itself (ShutdownCoordinatorApi) is WP-F's: it replaces runDrain's
 * `ownership.release()` (activity.ts) and the desktop `will-quit` release. Electron-free; relative imports only.
 */

/** After this long a shutdown kills the tracked children and exits; the exit hooks then release ownership. */
export const SHUTDOWN_HARD_LIMIT_MS = 60_000
/** HostSocketServer.closeGracefully: how long queued frames (the host.stop reply) may take to flush. */
export const SOCKET_CLOSE_GRACE_MS = 2_000
/** The app's handoff (4.4): no waiting window unless the Node host takes longer than this to exit. */
export const HANDOFF_WINDOW_DELAY_MS = 1_000
/** The app's handoff: "Open when they finish" retries the stop this often. */
export const HANDOFF_RETRY_MS = 5_000
/** The app's handoff: no answer within this long (or an owner older than Wave 7) shows the busy-folder message. */
export const HANDOFF_ANSWER_TIMEOUT_MS = 5_000

/** Every exit path the coordinator serves (4.3 "One shutdown coordinator"). */
export type ShutdownReason =
  | 'host.stop'
  | 'desktop-quit'
  | 'window-closed'
  | 'idle-exit'
  | 'signal'
  | 'inproc-cleanup'
  | 'handoff'

/** Where a shutdown is. 'released' is final: ownership is gone and the process may exit. */
export type ShutdownPhase = 'running' | 'draining' | 'settling' | 'closing' | 'released'

/**
 * The order (4.3): drain (mutations refused with host_draining, runs stopped when forced); the host.stop reply is
 * queued; writers settle (non-forced drains too); HostSocketServer.closeGracefully(SOCKET_CLOSE_GRACE_MS); release;
 * exit. While writers are in flight the host stays 'draining' and daemon.json stays. At SHUTDOWN_HARD_LIMIT_MS it
 * kills the tracked children (killTrackedChildren) and exits. onDrained runs from setImmediate, never inside
 * requestDrain.
 */
export interface ShutdownCoordinatorApi {
  /** Start the shutdown, or join the one in progress (a forced request upgrades a running non-forced one). */
  shutdown(reason: ShutdownReason, opts?: { force?: boolean }): Promise<void>
  phase(): ShutdownPhase
}

// ---------- Tracked child processes ----------

/** What the registry needs of a child (a ChildProcess fits). */
export interface TrackableChild {
  readonly pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
  once?(event: 'exit', listener: (...args: unknown[]) => void): unknown
}

interface Tracked {
  child: TrackableChild
  label: string
}

const tracked = new Set<Tracked>()

/**
 * Register a child the host must kill when it exits at the hard limit. Untracked automatically on 'exit' when the
 * child supports `once`; the returned function untracks it too (idempotent).
 */
export function trackChildProcess(child: TrackableChild, label: string): () => void {
  const entry: Tracked = { child, label }
  tracked.add(entry)
  const untrack = (): void => {
    tracked.delete(entry)
  }
  try {
    child.once?.('exit', untrack)
  } catch {
    // A child without a usable 'exit' event stays tracked until the caller untracks it.
  }
  return untrack
}

/** Kill every tracked child (SIGKILL by default) and forget them; returns how many were signalled. Never throws. */
export function killTrackedChildren(signal: NodeJS.Signals | number = 'SIGKILL'): number {
  let n = 0
  for (const entry of [...tracked]) {
    tracked.delete(entry)
    try {
      if (entry.child.kill(signal)) n++
    } catch {
      // Already gone.
    }
  }
  return n
}

/** How many children are tracked now (by label prefix when given; tests and logs). */
export function trackedChildCount(labelPrefix?: string): number {
  if (labelPrefix === undefined) return tracked.size
  let n = 0
  for (const e of tracked) if (e.label.startsWith(labelPrefix)) n++
  return n
}
