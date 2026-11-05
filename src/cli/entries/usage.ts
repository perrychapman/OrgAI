/** `orgai usage` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'usage',
  summary: 'Usage and cost',
  usage: 'usage <subcommand> [options]',
  subcommands: ['show', 'csv', 'refresh'],
  flags: [],
  available: false
}
