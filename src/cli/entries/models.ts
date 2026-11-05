/** `orgai models` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'models',
  summary: 'Models and prices',
  usage: 'models <subcommand> [options]',
  subcommands: ['list', 'refresh', 'prices', 'remap'],
  flags: [],
  available: false
}
