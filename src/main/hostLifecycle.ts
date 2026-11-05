/**
 * Lifecycle decisions of the unified Electron host (cli-spec 3.2(1)): argv parsing, second-instance launches, closing
 * the last window and an explicit quit while terminal clients are attached. Pure: no electron import; index.ts wires
 * Electron to these functions.
 */

/** A run id passed with --run: the shape RunStore ids have. */
export const HOST_RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

export interface HostArgs {
  /** --headless-host: no window, no Dock icon (macOS); the host serves terminal clients. */
  headless: boolean
  /** --run <id> / --run=<id>: open that run's window once booted (ignored by a headless launch). */
  run?: string
}

/** Read --headless-host and --run from a process argv. A malformed run id is dropped. */
export function parseHostArgs(argv: readonly string[]): HostArgs {
  let headless = false
  let run: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (typeof a !== 'string') continue
    if (a === '--headless-host') headless = true
    else if (a === '--run') {
      const next = argv[i + 1]
      if (typeof next === 'string' && !next.startsWith('--')) {
        i++
        if (HOST_RUN_ID_RE.test(next)) run = next
      }
    } else if (a.startsWith('--run=')) {
      const v = a.slice('--run='.length)
      if (HOST_RUN_ID_RE.test(v)) run = v
    }
  }
  return run !== undefined ? { headless, run } : { headless }
}

/** What a second launch hands the incumbent through requestSingleInstanceLock's additionalData. */
export interface SecondInstanceData {
  headless?: boolean
  run?: string
}

/** Read additionalData defensively: it crosses a process boundary and may be anything (or an older launcher's shape). */
function readAdditionalData(data: unknown): HostArgs | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const d = data as Record<string, unknown>
  if (typeof d.headless !== 'boolean') return undefined
  const run = typeof d.run === 'string' && HOST_RUN_ID_RE.test(d.run) ? d.run : undefined
  return run !== undefined ? { headless: d.headless, run } : { headless: d.headless }
}

export type SecondInstanceAction = { kind: 'ignore' } | { kind: 'headless' } | { kind: 'window'; run?: string }

/**
 * The incumbent's answer to a second launch. additionalData wins over argv (Chromium may reorder argv on some
 * platforms). 'headless' never opens or focuses a window; before boot or while quitting the launch is ignored.
 */
export function secondInstanceAction(input: { argv: readonly string[]; additionalData: unknown; booted: boolean; quitting: boolean }): SecondInstanceAction {
  if (!input.booted || input.quitting) return { kind: 'ignore' }
  const args = readAdditionalData(input.additionalData) ?? parseHostArgs(input.argv)
  if (args.headless) return { kind: 'headless' }
  return args.run !== undefined ? { kind: 'window', run: args.run } : { kind: 'window' }
}

export type WindowAllClosedAction = 'quit' | 'background' | 'stay' | 'ask'

/**
 * The last window closed (review H3).
 * - A host launched with --headless-host (launchedHeadless: the background daemon, cli-spec 3.2(1)) goes back to the
 *   background and leaves through its ORGAI_DAEMON_IDLE_MINUTES idle exit (or host.stop) while no run is working.
 *   Such a host also owns the windows of later desktop launches (an `orgai` command started it, then the user opened
 *   OrgAI from the Start menu: secondInstanceAction 'window'), so with runs working it treats that window like a
 *   desktop one (review follow-up): macOS 'stay' (Dock icon visible), Windows / Linux 'ask'. The last window closing
 *   means one was shown, so no extra flag is needed.
 * - macOS keeps the app running (Dock behaviour): 'stay', whatever its runs do; the Dock icon stays visible.
 * - Windows and Linux quit (through quitGate, which stops the runs), as before the host work. Only while runs are
 *   working without the user (workingRuns: RunManager.workingRunCount, so idle runs, runs with an open card and paused
 *   runs waiting for an auto-resume do not count) the user is asked first ('ask'): keep working in the background or
 *   stop and quit. A desktop-launched host never goes to the background without that answer.
 */
export function windowAllClosedAction(input: {
  platform: NodeJS.Platform | string
  launchedHeadless: boolean
  quitting: boolean
  workingRuns: number
}): WindowAllClosedAction {
  if (input.quitting) return 'quit'
  if (input.launchedHeadless && input.workingRuns <= 0) return 'background'
  if (input.platform === 'darwin') return 'stay'
  return input.workingRuns > 0 ? 'ask' : 'quit'
}

export type ClosePromptChoice = 'background' | 'quit' | 'cancel'

/** The close prompt's buttons, in order (index.ts maps the response index back through closePromptChoice). */
export const CLOSE_PROMPT_BUTTONS: readonly [background: string, quit: string, cancel: string] = ['Keep working in the background', 'Stop and quit', 'Cancel']

/** The close prompt's cancel index (Esc, closing the dialog): a window comes back; never quit or go to the background. */
export const CLOSE_PROMPT_CANCEL_ID = 2

/** The close prompt's text for `workingRuns` runs that are still working. */
export function closePromptText(workingRuns: number): { message: string; detail: string } {
  const n = Math.max(1, Math.floor(Number.isFinite(workingRuns) ? workingRuns : 1))
  return {
    message: n === 1 ? 'A run is still working.' : `${n} runs are still working.`,
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

/**
 * An explicit quit asks first when terminal clients are attached, unless the quit came from the activity drain or the
 * user already answered.
 */
export function quitPromptNeeded(input: { terminalClients: number; drainQuit: boolean; alreadyAnswered: boolean }): boolean {
  return input.terminalClients > 0 && !input.drainQuit && !input.alreadyAnswered
}

/** The quit dialog's buttons, in order (index.ts maps the response index back through this). */
export function quitPromptButtons(terminalClients: number): [keep: string, stop: string, cancel: string] {
  const n = Math.max(0, Math.floor(terminalClients))
  return [`Keep background host running for ${n} terminal client${n === 1 ? '' : 's'}`, 'Stop all runs and quit', 'Cancel']
}
