/** `orgai terminal-access` (Wave 7, cli-standalone.md 4.2.1). Pure data. Not built yet: WP-E flips `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'terminal-access',
  summary: 'Show or change Terminal access when no host is running (on a machine without the app)',
  usage: 'terminal-access [on|off] [--level full|operate]',
  subcommands: ['on', 'off'],
  flags: [{ name: 'level', takesValue: true, values: ['full', 'operate'], summary: 'full: terminals may also decide and configure; operate: watch and run only' }],
  available: false
}
