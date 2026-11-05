/**
 * The interactive-run helper of the Wave 5 commands that hand the terminal to a run (cli-spec 6.3(1)-(2)): `orgai
 * init` (setup:start), `orgai org retro` (setup:retro), `orgai mcp assist` (mcp:startAssist) and `orgai skills assist`
 * (skills:startAssist). Never statically imports the TUI: it goes through commands/tui.ts launchTui, which loads
 * ../tui/index lazily (lazyTui.test.ts).
 */
import { isVirtualProjectId, type Project, type RunSummary } from '../../shared/types'
import { hostError } from '../manage'
import { safeLine } from '../output'
import type { TuiHostConnection, TuiLaunch } from '../tui/types'
import { CliError, EXIT, type CliContext } from '../types'
import { hasTty, launchTui, managedOf, worktreeRefusal } from './tui'

export interface InteractiveRunSpec {
  /** The host channel that starts the run. */
  channel: 'setup:start' | 'setup:retro' | 'mcp:startAssist' | 'skills:startAssist'
  /** Its single argument. */
  input: unknown
  /** What the session is, for the TUI heading (TuiLaunch.title). */
  label: string
  /** The exit-2 message when there is no terminal (it should name the non-interactive alternative, if any). */
  noTtyMessage: string
}

/** Swappable in tests: the TUI launch (commands/tui.ts launchTui). */
export const interactiveDeps = {
  launchTui: (ctx: CliContext, flags: { inline: boolean; screenReader: boolean }, prepare: (conn: TuiHostConnection) => Promise<TuiLaunch>): Promise<number> => launchTui(ctx, flags, prepare)
}

/**
 * What the TUI opens for `spec` once connected: the run started by `spec.channel` on the TUI's own connection (read,
 * operate, decide; every channel here is 'operate'), its stored project when it has one (virtual 'harness' / 'skills'
 * runs open without one), exitWhenEnded, stopOnQuit and the title.
 */
export async function prepareInteractive(conn: TuiHostConnection, spec: InteractiveRunSpec): Promise<TuiLaunch> {
  let run: RunSummary
  try {
    run = await conn.client.call<RunSummary>(spec.channel, [spec.input])
  } catch (e) {
    throw hostError(e)
  }
  if (!run || typeof run !== 'object' || typeof run.id !== 'string') throw new CliError(`${safeLine(spec.label)}: the OrgAI host did not start a run.`, EXIT.failure)
  let project: Project | undefined
  if (typeof run.projectId === 'string' && !isVirtualProjectId(run.projectId)) {
    const list = await conn.projects().catch((e: unknown) => {
      throw hostError(e)
    })
    project = (Array.isArray(list) ? list : []).find((p) => p.id === run.projectId)
  }
  return { runId: run.id, ...(project ? { project } : {}), exitWhenEnded: true, stopOnQuit: true, title: spec.label }
}

/**
 * Start a setup or assist run and attach the terminal UI to it until it ends.
 * - Requires a TTY (stdin and stdout); without one, exit 2 with `spec.noTtyMessage`.
 * - Refuses inside an OrgAI-managed agent worktree (exit 2, naming the main checkout).
 * - Starts the run on the TUI's own host connection (spec.channel with [spec.input]) and attaches the TUI with
 *   TuiLaunch `exitWhenEnded` and `stopOnQuit` (`flags.inline` / `flags.screenReader` as `--inline` /
 *   `--ax-screen-reader`).
 * - Resolves 0 when the run's chain ends finished, 1 when it ends in error, and 130 when the user quits with Ctrl+C
 *   (after runs:stop on the open run).
 */
export async function runInteractiveRun(ctx: CliContext, spec: InteractiveRunSpec, flags?: { inline?: boolean; screenReader?: boolean }): Promise<number> {
  if (!hasTty(ctx)) throw new CliError(spec.noTtyMessage, EXIT.usage)
  const managed = managedOf(ctx)
  if (managed) throw new CliError(worktreeRefusal(managed.mainCheckout), EXIT.usage)
  return interactiveDeps.launchTui(ctx, { inline: flags?.inline === true, screenReader: flags?.screenReader === true }, (conn) => prepareInteractive(conn, spec))
}
