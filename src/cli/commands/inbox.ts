/** `orgai inbox` (Wave 2 contracts stub; W2-T5 implements it). */
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

export const runInbox: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  void ctx
  void args
  throw new CliError('not implemented', EXIT.failure)
}
