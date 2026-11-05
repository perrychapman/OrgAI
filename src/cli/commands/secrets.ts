/**
 * `orgai secrets status | init [--key-file <path> [--import]] | reset --yes | undelete <key>` (Wave 7,
 * cli-standalone.md 5.7) over the secrets:* host channels. No subcommand ever prints a value.
 *
 * Contracts only: the entry is `available: false`, so index.ts refuses the command before routing here. WP-H builds it.
 */
import { CliError, EXIT, type CommandFn } from '../types'

export const runSecrets: CommandFn = async () => {
  throw new CliError('`orgai secrets` is not available in this build yet.', EXIT.usage)
}
