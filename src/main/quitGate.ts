/**
 * The `before-quit` gate (index.ts). Live runs are cut by the app, not the user (RunSummary.endedBy 'app'): the
 * first quit is held (preventDefault) while RunManager.stopAll({ reason: 'quit' }) stops them, for at most
 * `deadlineMs`, then quit() is called again and goes through. On the deadline or a failed stopAll the synchronous
 * markQuit() writes every live run's summary and record before the app goes. Pure: Electron is passed in.
 */
export interface QuitGateDeps {
  /** Live runs right now (RunManager.liveRunCount). */
  liveCount: () => number
  /** RunManager.stopAll({ reason: 'quit' }); called at most once per gate. */
  stopAll: () => Promise<void>
  /** RunManager.markQuit: synchronous, safe to call more than once. */
  markQuit: () => void
  deadlineMs: number
  /** app.quit(); re-enters the gate, which then lets it through. */
  quit: () => void
  warn: (message: string) => void
  now?: () => number
}

export interface QuitEvent {
  preventDefault(): void
}

export function quitGate(deps: QuitGateDeps): (event: QuitEvent) => void {
  const now = deps.now ?? Date.now
  let phase: 'open' | 'waiting' | 'done' = 'open'
  let deadline = 0

  const markQuit = (): void => {
    try {
      deps.markQuit()
    } catch (e) {
      deps.warn(`Writing runs on quit failed: ${(e as Error)?.message ?? e}`)
    }
  }

  return (event) => {
    if (phase === 'done') {
      // The gate's own second quit, or any quit after it: nothing is held. markQuit is a no-op when all is written.
      markQuit()
      return
    }
    if (phase === 'waiting') {
      // A second quit while stopAll is still running waits for it, until the deadline. A quit after the deadline
      // (the timer has not fired yet, e.g. a busy event loop) is forced through: markQuit writes the runs now.
      if (now() < deadline) {
        event.preventDefault()
        return
      }
      phase = 'done'
      markQuit()
      return
    }
    if (deps.liveCount() === 0) {
      phase = 'done'
      markQuit()
      return
    }
    event.preventDefault()
    phase = 'waiting'
    deadline = now() + deps.deadlineMs
    let started: Promise<void>
    try {
      started = deps.stopAll()
    } catch (e) {
      started = Promise.reject(e)
    }
    // The one stopAll of this quit: a re-entrant quit waits on it (held above) and never calls stopAll again.
    const stopping = started.then(
      () => 'done' as const,
      (e: unknown) => {
        deps.warn(`Stopping runs on quit failed: ${(e as Error)?.message ?? e}`)
        return 'failed' as const
      }
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deps.deadlineMs)
    })
    void Promise.race([stopping, timeout]).then((result) => {
      clearTimeout(timer)
      if (result === 'timeout') deps.warn(`Live runs did not stop within ${deps.deadlineMs} ms; quitting anyway.`)
      // Runs stopAll could not write (timeout, failure) are written now, synchronously, before the app goes.
      if (result !== 'done') markQuit()
      phase = 'done'
      deps.quit()
    })
  }
}
