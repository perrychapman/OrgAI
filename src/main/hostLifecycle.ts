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

export type WindowAllClosedAction = 'quit' | 'background' | 'stay'

/**
 * The last window closed. busy = the host's activity is not idle (live runs, paused auto-resumes, OAuth flows,
 * worktree ops, attached terminal clients...): keep serving in the background. A host launched with --headless-host
 * (launchedHeadless: the background daemon, cli-spec 3.2(1) "background daemon mode") also goes back to the
 * background when idle and leaves only through its ORGAI_DAEMON_IDLE_MINUTES idle exit (or host.stop). Otherwise,
 * idle: a desktop host that already went to the background once (startedHeadless) quits, and so does a desktop host
 * off macOS; a desktop host on macOS stays (Dock behaviour).
 */
export function windowAllClosedAction(input: {
  platform: NodeJS.Platform | string
  busy: boolean
  startedHeadless: boolean
  launchedHeadless?: boolean
  quitting: boolean
}): WindowAllClosedAction {
  if (input.quitting) return 'quit'
  if (input.busy || input.launchedHeadless) return 'background'
  if (input.startedHeadless || input.platform !== 'darwin') return 'quit'
  return 'stay'
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
