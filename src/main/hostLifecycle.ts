/**
 * Lifecycle decisions of the desktop app: closing the last window and the close prompt. Pure: no electron import;
 * index.ts wires Electron to these functions. The app has no terminal clients, no headless mode and no handoff (the
 * orgai CLI is its own product, standalone spec 5.1).
 */

export type WindowAllClosedAction = 'quit' | 'stay' | 'ask'

/**
 * The last window closed (review H3).
 * - macOS keeps the app running (Dock behaviour): 'stay', whatever its runs do; the Dock icon stays visible.
 * - Windows and Linux quit (through the shutdown coordinator's forced drain, which stops the runs), as before the host work. Only while runs are
 *   working without the user (workingRuns: RunManager.workingRunCount, so idle runs, runs with an open card and paused
 *   runs waiting for an auto-resume do not count) the user is asked first ('ask'): keep working in the background or
 *   stop and quit. The app never goes to the background without that answer.
 */
export function windowAllClosedAction(input: {
  platform: NodeJS.Platform | string
  quitting: boolean
  workingRuns: number
  /** Enabled schedules with a next run (Schedules; 0 while they are paused globally). They are asked about like working runs. */
  pendingSchedules?: number
}): WindowAllClosedAction {
  if (input.quitting) return 'quit'
  if (input.platform === 'darwin') return 'stay'
  return input.workingRuns > 0 || (input.pendingSchedules ?? 0) > 0 ? 'ask' : 'quit'
}

export type ClosePromptChoice = 'background' | 'quit' | 'cancel'

/** The close prompt's buttons, in order (index.ts maps the response index back through closePromptChoice). */
export const CLOSE_PROMPT_BUTTONS: readonly [background: string, quit: string, cancel: string] = ['Keep working in the background', 'Stop and quit', 'Cancel']

/** The close prompt's cancel index (Esc, closing the dialog): a window comes back; never quit or go to the background. */
export const CLOSE_PROMPT_CANCEL_ID = 2

/** The close prompt's text for `workingRuns` runs that are still working. */
export function closePromptText(workingRuns: number, pendingSchedules = 0): { message: string; detail: string } {
  const runs = Math.max(0, Math.floor(Number.isFinite(workingRuns) ? workingRuns : 0))
  const due = Math.max(0, Math.floor(Number.isFinite(pendingSchedules) ? pendingSchedules : 0))
  const n = Math.max(1, runs)
  const runsLine = n === 1 ? 'A run is still working.' : `${n} runs are still working.`
  const message =
    runs === 0 && due > 0 ? (due === 1 ? 'A scheduled run is due later.' : `${due} schedules have runs due later.`)
    : due > 0 ? `${runsLine.slice(0, -1)}, or scheduled runs are due.`
    : runsLine
  return {
    message,
    detail:
      'OrgAI can keep working in the background without a window; start OrgAI again to see it. Once nothing is working and ' +
      'nothing has happened for a while, it quits by itself. Stop and quit ends every run; you can continue them later.'
  }
}

/** The close prompt's response index as a choice; anything unexpected is 'cancel'. */
export function closePromptChoice(response: number): ClosePromptChoice {
  if (response === 0) return 'background'
  if (response === 1) return 'quit'
  return 'cancel'
}

/**
 * A quit the user cancelled from a prompt while no window is open: off macOS a window comes back, so the app is
 * never left running with nothing on screen. macOS keeps its Dock icon.
 */
export function reopenAfterCancel(input: { platform: NodeJS.Platform | string; liveWindows: number; quitting: boolean }): boolean {
  return !input.quitting && input.platform !== 'darwin' && input.liveWindows === 0
}
