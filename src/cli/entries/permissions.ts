/** `orgai permissions` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'permissions',
  summary: 'Saved permission rules',
  usage: 'permissions <subcommand> [options]',
  subcommands: ['list', 'add', 'remove', 'mode', 'folders', 'reference'],
  flags: [],
  available: false
}
