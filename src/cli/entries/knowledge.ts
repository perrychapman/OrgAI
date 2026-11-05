/** `orgai knowledge` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'knowledge',
  summary: 'Engagement knowledge',
  usage: 'knowledge <subcommand> [options]',
  subcommands: ['list', 'search', 'show', 'upsert', 'link', 'unlink', 'retire', 'restore', 'remove', 'clear'],
  flags: [],
  available: false
}
