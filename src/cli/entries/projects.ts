/** `orgai projects` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'projects',
  summary: 'Projects',
  usage: 'projects <subcommand> [options]',
  subcommands: ['list', 'show', 'create', 'check', 'set', 'remove', 'save-chat'],
  flags: [],
  available: false
}
