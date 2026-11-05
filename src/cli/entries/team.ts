/** `orgai team` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'team',
  summary: 'Team templates and roles',
  usage: 'team <subcommand> [options]',
  subcommands: ['templates', 'roles', 'role', 'plugins'],
  flags: [],
  available: false
}
