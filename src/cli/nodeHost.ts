/**
 * Starting the detached Node host (Wave 7, docs/design/cli-standalone.md 4.2, 4.2.1): the checks every starter runs
 * first (`orgai daemon start --runtime node`, `daemon restart`, and `--host daemon` with no app). Plain Node; relative
 * imports only.
 *
 * - `install.json` says 'app' (the CLI inside the app, where process.execPath is the Electron binary), or this CLI runs
 *   on Electron anyway (ORGAI_ELECTRON_PATH or dev setups without install.json): refused, "The Node background host
 *   comes with the npm package: npm i -g orgai-cli". Checked before the level question, so nothing is asked or stored.
 * - Terminal access stored off (the user chose off): refused, since nothing could reach that host (neither `daemon
 *   stop` nor `terminal-access` could talk to it).
 */
import type { InstallInfo } from '../shared/types'
import { NODE_HOST_NEEDS_NODE } from './client/launcher'
import { readInstallInfo } from './installInfo'
import { readStoredTerminalAccess, type StoredTerminalAccess } from './terminalAccessSettings'
import { CliError, EXIT, type CliContext } from './types'

export const NODE_HOST_TERMINAL_OFF = 'Terminal access is off, so terminals could not use that host. Turn it on with `orgai terminal-access on`'

/** Swappable in tests. */
export const nodeHostDeps = {
  installInfo: (): InstallInfo => readInstallInfo(),
  /** Whether this CLI runs on Electron (ELECTRON_RUN_AS_NODE), where a Node host cannot be spawned. */
  onElectron: (): boolean => !!process.versions.electron,
  terminalAccess: (dataDir: string): StoredTerminalAccess => readStoredTerminalAccess(dataDir)
}

/** Why a Node host must not be started here, or undefined. Exit 1 either way. */
export function nodeHostRefusal(ctx: CliContext): CliError | undefined {
  if (nodeHostDeps.installInfo().channel === 'app' || nodeHostDeps.onElectron()) return new CliError(NODE_HOST_NEEDS_NODE, EXIT.failure)
  if (!nodeHostDeps.terminalAccess(ctx.paths.dataDir).enabledForBackground) return new CliError(NODE_HOST_TERMINAL_OFF, EXIT.failure)
  return undefined
}
