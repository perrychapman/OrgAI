/**
 * Which in-process hosts other terminals may use (cli-standalone.md 4.1, 4.2.1; WP-B review round 2).
 *
 * An in-process host belongs to one command: `orgai --host inproc exec`, or the `--host auto` fallback a management
 * command, exec or the terminal UI starts when no app is found. It ends with that command, and its cleanup drains with
 * force, so a run another terminal started on it would be stopped. Only `orgai daemon start --host inproc` (also
 * `--foreground`) runs one meant to serve other terminals until Ctrl+C. That host writes a marker file
 * `<dataDir>/run/inproc-shared-<hostInstanceId>` once it owns the data folder and before it is ready, and removes it when
 * it ends; ensureHost attaches to an 'inproc' host only when the marker names it (or the host is the command's own).
 * Any other 'inproc' host is waited out (HostLauncher.waitForGone) instead of used. A marker a crashed host left behind
 * names an id no live host carries, so it is harmless, and the next shared host removes it (only the owner of the data
 * folder ever writes a marker, so every other one is stale then). Plain Node, no electron.
 */
import { chmodSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_INSTANCE_ID_RE } from '../../main/host/identity'

export const SHARED_HOST_MARKER_PREFIX = 'inproc-shared-'

/** `<dataDir>/run/inproc-shared-<id>`, or undefined for an id that is not a host instance id. */
export function sharedHostMarkerPath(dataDir: string, hostInstanceId: string): string | undefined {
  if (typeof hostInstanceId !== 'string' || !HOST_INSTANCE_ID_RE.test(hostInstanceId)) return undefined
  return join(dataDir, 'run', `${SHARED_HOST_MARKER_PREFIX}${hostInstanceId}`)
}

/**
 * Mark this host as shared (call once it owns the data folder, so `run/` exists, and before it is ready). Returns the
 * remover (idempotent, never throws). Throws when the marker cannot be written; the caller logs and goes on, and other
 * terminals then treat the host as a command's own (they wait, never attach), which is the safe side.
 */
export function markSharedHost(dataDir: string, hostInstanceId: string, pid = process.pid): () => void {
  const path = sharedHostMarkerPath(dataDir, hostInstanceId)
  if (!path) throw new Error(`Invalid host instance id: ${String(hostInstanceId)}`)
  // This host owns the data folder: any other marker was left by a host that crashed.
  try {
    for (const name of readdirSync(join(dataDir, 'run'))) {
      if (name.startsWith(SHARED_HOST_MARKER_PREFIX) && name !== `${SHARED_HOST_MARKER_PREFIX}${hostInstanceId}`) rmSync(join(dataDir, 'run', name), { force: true })
    }
  } catch {
    // best effort
  }
  writeFileSync(path, `${pid}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // best effort (Windows)
  }
  return () => {
    try {
      rmSync(path, { force: true })
    } catch {
      // gone already, or the run dir was removed by hand
    }
  }
}

/** True when the host with this id was started to serve other terminals (`daemon start --host inproc`). */
export function isSharedInprocHost(dataDir: string, hostInstanceId: string, exists: (p: string) => boolean = existsSync): boolean {
  const path = sharedHostMarkerPath(dataDir, hostInstanceId)
  return path !== undefined && exists(path)
}
