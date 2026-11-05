/** `orgai connections` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'connections',
  summary: 'Model connections',
  usage: 'connections <subcommand> [options]',
  subcommands: ['list', 'show', 'test', 'connect', 'login', 'logout', 'set-default', 'set-secret', 'update'],
  flags: [],
  available: false
}
