/**
 * The desktop's `before-quit` and `will-quit` handlers (Wave 7, docs/design/cli-standalone.md 4.3), Electron-free so
 * the real handlers run in unit tests with a fake app (desktopQuit.test.ts); index.ts installs them on `app`.
 *
 * - `before-quit`: the terminal-clients prompt first (a cancelled or kept quit never reaches the shutdown, never marks
 *   the app quitting and never disposes the host); then the quit is held (preventDefault) while the shutdown
 *   coordinator runs its forced sequence (runs end through stopAll({ reason: 'quit' }) or markQuit, the writers settle,
 *   the terminal connections close gracefully, ownership is released); the coordinator's exit step then quits again
 *   and this handler lets that quit through, disposing the host. Nothing booted (a quit while waiting for a handoff, a
 *   failed boot) goes at once: the process exit hook releases whatever it holds.
 * - `will-quit`: closes the socket server only. It never releases ownership: the coordinator did, after the writers.
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
  /** Attached terminal clients (HostSocketServer.attachedClientCount). */
  terminalClients(): number
  /** quitPromptNeeded (hostLifecycle.ts). */
  promptNeeded(input: { terminalClients: number; drainQuit: boolean; alreadyAnswered: boolean }): boolean
  /** The quit comes from the shutdown itself (idle exit, host.stop): never prompt. */
  drainQuit(): boolean
  /** A prompt was answered "stop and quit" (the next quit goes through without asking). */
  quitAnswered(): boolean
  quitting(): boolean
  markQuitting(): void
  promptOpen(): boolean
  /** Show the terminal-clients prompt (index.ts askQuit). */
  askQuit(terminalClients: number): void
  /** Why this quit happens (the coordinator's reason): 'window-closed' after the last window on Windows / Linux. */
  reason(): ShutdownReason
  /** Stop a macOS certificate read still running (systemCerts.ts). */
  stopCertRead(): void
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
    const terminalClients = deps.terminalClients()
    if (deps.promptNeeded({ terminalClients, drainQuit: deps.drainQuit(), alreadyAnswered: deps.quitAnswered() || deps.quitting() })) {
      event.preventDefault()
      if (!deps.promptOpen()) deps.askQuit(terminalClients)
      return
    }
    // Held until the coordinator released ownership; its exit step quits again and the branch above lets that through.
    event.preventDefault()
    if (deps.quitting() && h.shutdown.phase() !== 'running') return
    deps.markQuitting()
    // A macOS certificate read still running is killed once the quit goes ahead (a kept quit leaves it alone).
    deps.stopCertRead()
    void h.shutdown.shutdown(deps.reason(), { force: true }).catch((e: unknown) => {
      deps.warn(`Quitting failed: ${e instanceof Error ? e.message : String(e)}`)
      deps.exit(0)
    })
  }
}

/** The `will-quit` handler: close the socket server; ownership was released by the shutdown, never here. */
export function willQuitHandler(deps: { closeServer(): void }): () => void {
  return () => deps.closeServer()
}
