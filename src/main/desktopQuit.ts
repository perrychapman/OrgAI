/**
 * The desktop's `before-quit` handler (Wave 7, docs/design/cli-standalone.md 4.3), Electron-free so the real handler
 * runs in unit tests with a fake app (desktopQuit.test.ts); index.ts installs it on `app`.
 *
 * - `before-quit`: the quit is held (preventDefault) while the shutdown coordinator runs its forced sequence (runs end
 *   through stopAll({ reason: 'quit' }) or markQuit, the writers settle, ownership is released); the coordinator's
 *   exit step then quits again and this handler lets that quit through, disposing the host. Nothing booted (a refused
 *   data folder, a failed boot) goes at once: the process exit hook releases whatever it holds.
 * There is no socket and no terminal client in the app, so there is no prompt and no `will-quit` work.
 */
import type { ShutdownCoordinatorApi, ShutdownReason } from './host/shutdown'

export interface QuitEventLike {
  preventDefault(): void
}

/** The booted host as the quit handlers need it. */
export interface QuitHost {
  shutdown: Pick<ShutdownCoordinatorApi, 'phase' | 'shutdown'>
  dispose(): void
}

export interface BeforeQuitDeps {
  /** The booted host, or undefined before boot (and after a failed one). */
  host(): QuitHost | undefined
  quitting(): boolean
  markQuitting(): void
  /** Why this quit happens (the coordinator's reason): 'window-closed' after the last window on Windows / Linux. */
  reason(): ShutdownReason
  /** Stop a macOS certificate read still running (systemCerts.ts). */
  stopCertRead(): void
  /** Cancel an orgai command install still running (its mutation lease would hold the drain). */
  stopCliInstall(): void
  /** app.exit: never strand the app when the shutdown failed (the process exit hook releases ownership). */
  exit(code: number): void
  warn(message: string): void
}

/** The `before-quit` handler. */
export function beforeQuitHandler(deps: BeforeQuitDeps): (event: QuitEventLike) => void {
  return (event) => {
    const h = deps.host()
    if (!h || h.shutdown.phase() === 'released') {
      // Nothing booted, or the shutdown already released ownership: let this quit go.
      deps.markQuitting()
      deps.stopCertRead()
      h?.dispose()
      return
    }
    // Held until the coordinator released ownership; its exit step quits again and the branch above lets that through.
    event.preventDefault()
    if (deps.quitting() && h.shutdown.phase() !== 'running') return
    deps.markQuitting()
    deps.stopCliInstall()
    // A macOS certificate read still running is killed once the quit goes ahead (a kept quit leaves it alone).
    deps.stopCertRead()
    void h.shutdown.shutdown(deps.reason(), { force: true }).catch((e: unknown) => {
      deps.warn(`Quitting failed: ${e instanceof Error ? e.message : String(e)}`)
      deps.exit(0)
    })
  }
}
