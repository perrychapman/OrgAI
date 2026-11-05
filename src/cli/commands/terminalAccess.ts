/**
 * `orgai terminal-access [on|off] [--level full|operate]` (Wave 7, cli-standalone.md 4.2.1): changes the stored
 * Terminal access on a machine without the app. Runs only when no host owns the data folder (it takes ownership
 * in-process, writes the settings, releases); refuses otherwise.
 *
 * Contracts only: the entry is `available: false`, so index.ts refuses the command before routing here. WP-E builds it.
 */
import { CliError, EXIT, type CommandFn } from '../types'

export const runTerminalAccess: CommandFn = async () => {
  throw new CliError('`orgai terminal-access` is not available in this build yet.', EXIT.usage)
}
