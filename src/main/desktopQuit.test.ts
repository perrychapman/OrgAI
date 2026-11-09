/**
 * The desktop's real before-quit / will-quit handlers (desktopQuit.ts, as index.ts installs them) against a fake app
 * that dispatches quit() the way Electron does (before-quit, then will-quit unless prevented, then exit), with the real
 * ShutdownCoordinator and HostActivityTracker (cli-standalone.md 4.3: Quit is held until the writers settled and
 * ownership was released; will-quit never releases). The app has no socket, so nothing is closed there.
 */
import { describe, expect, it, vi } from 'vitest'
import { beforeQuitHandler, type QuitEventLike, type QuitHost } from './desktopQuit'
import { HostActivityTracker } from './host/activity'
import { ShutdownCoordinator, type ShutdownReason } from './host/shutdown'

class FakeApp {
  readonly order: string[] = []
  exited = false
  private readonly before: ((e: QuitEventLike) => void)[] = []
  private readonly will: (() => void)[] = []
  on(event: 'before-quit', fn: (e: QuitEventLike) => void): void
  on(event: 'will-quit', fn: () => void): void
  on(event: string, fn: (e: QuitEventLike) => void): void {
    if (event === 'before-quit') this.before.push(fn)
    else this.will.push(fn as () => void)
  }
  /** Electron's order: before-quit (preventable), will-quit, then the process ends. */
  quit(): void {
    let prevented = false
    for (const fn of this.before) fn({ preventDefault: () => (prevented = true) })
    if (prevented) {
      this.order.push('before-quit held')
      return
    }
    this.order.push('before-quit through')
    for (const fn of this.will) fn()
    this.exited = true
    this.order.push('exited')
  }
}

/** index.ts in miniature: its module state, the coordinator wired as bootOrgAIHost wires it, the two handlers. */
function desktop(opts: { host?: boolean; shutdownFails?: boolean } = {}) {
  const app = new FakeApp()
  const state = { quitting: false, drainQuit: false, reason: 'desktop-quit' as ShutdownReason }
  const releases: string[] = []
  const exits: number[] = []
  const warnings: string[] = []
  const forceStop = vi.fn(async () => void app.order.push('runs stopped'))
  const shutdown = new ShutdownCoordinator({
    release: () => {
      releases.push('release')
      app.order.push('release')
    },
    // index.ts onDrained: the quit that follows comes from the shutdown itself.
    onReleased: () => {
      state.drainQuit = true
      state.quitting = true
      app.quit()
    }
  })
  const activity = new HostActivityTracker({ forceStop, settlePollMs: 5, ...shutdown.activityHooks() })
  shutdown.attachActivity(activity)
  const installStops: string[] = []
  const dispose = vi.fn(() => app.order.push('host disposed'))
  const host: QuitHost = {
    shutdown: opts.shutdownFails ? { phase: () => 'running', shutdown: () => Promise.reject(new Error('stuck')) } : shutdown,
    dispose
  }
  app.on(
    'before-quit',
    beforeQuitHandler({
      host: () => (opts.host === false ? undefined : host),
      quitting: () => state.quitting,
      markQuitting: () => void (state.quitting = true),
      reason: () => state.reason,
      stopCertRead: () => app.order.push('cert read stopped'),
      stopCliInstall: () => void installStops.push('cancel'),
      exit: (code) => void exits.push(code),
      warn: (m) => void warnings.push(m)
    })
  )
  return { app, state, shutdown, activity, releases, exits, warnings, forceStop, dispose, installStops }
}

const waitFor = async (fn: () => boolean, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('desktop Quit through the real before-quit / will-quit handlers (cli-standalone.md 4.3)', () => {
  it('holds the quit while a writer is in flight; releases only after it, then lets the quit through; will-quit never releases', async () => {
    const d = desktop()
    // A real asynchronous desktop handler that started before the Quit (an MCP authorize's token write, leased).
    const endWrite = d.activity.acquire('inFlightRpcMutations', 'mcp:authorize token write')
    d.app.quit()
    // The forced drain starts inside the held quit: the runs are stopped at once.
    expect(d.app.order).toEqual(['cert read stopped', 'runs stopped', 'before-quit held'])
    expect(d.state.quitting).toBe(true)
    await waitFor(() => d.shutdown.phase() === 'settling')
    await new Promise((r) => setTimeout(r, 50))
    // Still owned: nothing released, nothing quit, the window of the app stays up.
    expect(d.releases).toEqual([])
    expect(d.app.exited).toBe(false)
    expect(d.forceStop).toHaveBeenCalledTimes(1)
    d.app.order.push('write landed')
    endWrite()
    await waitFor(() => d.app.exited)
    expect(d.app.order).toEqual([
      'cert read stopped',
      'runs stopped',
      'before-quit held',
      'write landed',
      'release',
      // The coordinator's exit step quits again; the handler lets it through and disposes the host.
      'cert read stopped',
      'host disposed',
      'before-quit through',
      'exited'
    ])
    expect(d.releases).toEqual(['release'])
    expect(d.shutdown.phase()).toBe('released')
  })

  it('cancels a running orgai command install as the quit starts, before the drain', async () => {
    const d = desktop()
    const endInstall = d.activity.acquire('inFlightRpcMutations', 'app:installCliCommand')
    d.app.quit()
    expect(d.installStops).toEqual(['cancel'])
    endInstall()
    await waitFor(() => d.app.exited)
  })

  it('a second Quit while the shutdown runs is held too and starts nothing new', async () => {
    const d = desktop()
    const endWrite = d.activity.acquire('backgroundTasks', 'vault write-back')
    d.app.quit()
    d.app.quit()
    expect(d.app.order.filter((o) => o === 'before-quit held')).toHaveLength(2)
    expect(d.forceStop).toHaveBeenCalledTimes(1)
    endWrite()
    await waitFor(() => d.app.exited)
    expect(d.releases).toEqual(['release'])
  })

  it('the last window closing on Windows / Linux quits with reason window-closed through the same sequence', async () => {
    const d = desktop()
    d.state.reason = 'window-closed'
    const released = vi.fn()
    void d.shutdown.released().then(released)
    d.app.quit()
    await waitFor(() => d.app.exited)
    expect(released).toHaveBeenCalled()
    expect(d.forceStop).toHaveBeenCalledTimes(1)
  })

  it('nothing booted (a refused data folder): the quit goes through at once', () => {
    const d = desktop({ host: false })
    d.app.quit()
    expect(d.app.order).toEqual(['cert read stopped', 'before-quit through', 'exited'])
    expect(d.state.quitting).toBe(true)
    expect(d.dispose).not.toHaveBeenCalled()
  })

  it('a shutdown that fails is logged and the app exits anyway (the process exit hook releases)', async () => {
    const d = desktop({ shutdownFails: true })
    d.app.quit()
    await waitFor(() => d.exits.length > 0)
    expect(d.exits).toEqual([0])
    expect(d.warnings[0]).toContain('stuck')
  })
})
