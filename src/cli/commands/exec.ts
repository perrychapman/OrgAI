/**
 * `orgai exec [options] [--] [prompt|-]` (alias `orgai -p`) and `orgai resume [runId-or-R#] --exec` (cli-spec 6.2).
 * Stubs until Wave 3 T4 builds them.
 */
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

export const runExec: CommandFn = async (_ctx: CliContext, _args: string[]): Promise<number> => {
  throw new CliError('`orgai exec` is not built yet.', EXIT.failure)
}

export const runResume: CommandFn = async (_ctx: CliContext, _args: string[]): Promise<number> => {
  throw new CliError('`orgai resume` is not built yet.', EXIT.failure)
}
