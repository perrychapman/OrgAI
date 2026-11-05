/** `orgai notes` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'notes',
  summary: 'Engagement context notes',
  usage: 'notes <subcommand> [options]',
  subcommands: ['list', 'show', 'add', 'edit', 'remove', 'plan'],
  flags: [],
  available: false
}
