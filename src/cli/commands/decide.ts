/**
 * `orgai decide <requestId> <verb> [options]` (cli-spec 6.1, 6.3): resolve a pending decision card through the host's
 * runs:findDecision lookup and the decision channels. Stub until Wave 3 T5 builds it.
 */
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

export const runDecide: CommandFn = async (_ctx: CliContext, _args: string[]): Promise<number> => {
  throw new CliError('`orgai decide` is not built yet.', EXIT.failure)
}
