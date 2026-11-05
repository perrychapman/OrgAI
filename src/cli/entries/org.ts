/** `orgai org` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'org',
  summary: 'Org chart and Team assistant',
  usage: 'org <subcommand> [options]',
  subcommands: ['show', 'import', 'export', 'retro', 'draft', 'discover', 'recommend', 'review', 'apply', 'undo', 'dismiss', 'restore'],
  flags: [],
  available: false
}
