/** `orgai kit` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'kit',
  summary: 'Practice kits',
  usage: 'kit <subcommand> [options]',
  subcommands: ['export', 'import'],
  flags: [],
  available: false
}
