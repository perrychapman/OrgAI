/**
 * The interactive-run helper of the Wave 5 commands that hand the terminal to a run (cli-spec 6.3(1)-(2)): `orgai
 * init` (setup:start), `orgai org retro` (setup:retro), `orgai mcp assist` (mcp:startAssist) and `orgai skills assist`
 * (skills:startAssist). A stub until task W5-T1 implements it.
 */
import { CliError, EXIT, type CliContext } from '../types'

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
  void ctx
  void flags
  throw new CliError(`${spec.label}: the interactive session is not available in this build yet.`, EXIT.usage)
}
