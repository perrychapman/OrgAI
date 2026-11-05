/** `orgai skills` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'skills',
  summary: 'Skills',
  usage: 'skills <subcommand> [options]',
  subcommands: ['list', 'show', 'create', 'update', 'remove', 'link', 'promote', 'import', 'undo-import', 'evaluate', 'evaluation', 'apply-suggestion', 'library', 'assist'],
  flags: [],
  available: false
}
