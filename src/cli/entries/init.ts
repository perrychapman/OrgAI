/** `orgai init` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'init',
  summary: 'Set up a project in the current folder',
  usage: 'init [options]',
  flags: [],
  available: false
}
