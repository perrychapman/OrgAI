/** `orgai kit` (cli-spec 6.3, Wave 5): a stub until its Wave 5 task lands (commandTable marks it unavailable). */
import { CliError, EXIT, type CommandFn } from '../types'

export const runKit: CommandFn = async () => {
  throw new CliError('`orgai kit` is not available in this build yet.', EXIT.usage)
}
