/**
 * Mutation leases for every surface (Wave 7, cli-standalone.md 4.3 "Every mutation is leased"): the desktop's
 * HostDispatcher.invoke and the desktop-only ipcMain channels (ipc.ts) take the same inFlightRpcMutations lease as the
 * socket path and refuse new mutations with host_draining while the host drains, so the shutdown never releases the
 * data folder with a write in flight. Electron-free; relative imports only.
 */
import { HOST_METHODS, IPC } from '../../shared/types'
import { HostRpcFailure } from './registry'
import type { HostActivityTrackerApi } from './types'

/** How long a client should wait before retrying a mutation refused while the host drains. */
export const DRAINING_RETRY_MS = 1000

export const DRAINING_MESSAGE = 'OrgAI is shutting down; try again in a moment.'

/**
 * Mutating channels that hold no lease for the whole call, only for their final commit (round 6 item 9): an
 * mcp:authorize waits on the user's browser for minutes; that wait is the activeOAuthFlows activity source, and
 * McpService leases its commit itself. They are still refused while the host drains.
 */
export const COMMIT_LEASED_CHANNELS: ReadonlySet<string> = new Set<string>([IPC.mcpAuthorize])

/**
 * Lifecycle calls that are never refused while draining and hold no lease (a lease of its own would make every drain
 * without force refuse itself; requestDrain joins a drain under way).
 */
export const LIFECYCLE_CHANNELS: ReadonlySet<string> = new Set<string>([HOST_METHODS.hostStop])

/** The host_draining refusal (a HostRpcFailure: an Error with `code`, so the desktop sees its message). */
export function drainingFailure(): HostRpcFailure {
  return new HostRpcFailure('host_draining', DRAINING_MESSAGE, DRAINING_RETRY_MS)
}

/**
 * Run one mutating call under the lease rules: refused with host_draining while the host drains; otherwise an
 * inFlightRpcMutations lease (unless `lease` is false) held until a returned promise settles, or released on return
 * (a synchronous handler stays synchronous, and a synchronous throw stays a synchronous throw). The returned value is
 * the handler's own (a promise keeps its rejection for the caller).
 */
export function runLeased<T>(activity: HostActivityTrackerApi, label: string, fn: () => T, opts: { lease?: boolean } = {}): T {
  if (activity.state() === 'draining') throw drainingFailure()
  const release = opts.lease === false ? undefined : activity.acquire('inFlightRpcMutations', label)
  let result: T
  try {
    result = fn()
  } catch (e) {
    release?.()
    throw e
  }
  if (release) {
    if (isThenable(result)) {
      // Both handlers release, so this derived promise never rejects; the caller handles the original itself.
      Promise.resolve(result).then(release, release)
    } else {
      release()
    }
  }
  return result
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === 'object' || typeof v === 'function') && v !== null && typeof (v as { then?: unknown }).then === 'function'
}
