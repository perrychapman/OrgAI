/** `orgai worktrees` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'worktrees',
  summary: 'Agent worktrees',
  usage: 'worktrees <subcommand> [options]',
  subcommands: ['list', 'diff', 'merge', 'discard', 'uninstall'],
  flags: [],
  available: false
}
