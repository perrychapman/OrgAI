/** `orgai terminal-access` (Wave 7, cli-standalone.md 4.2.1). Pure data. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'terminal-access',
  summary: 'Show or change Terminal access (changes only while no host is running; for machines without the app)',
  usage: 'terminal-access [on|off] [--level full|operate]',
  subcommands: ['on', 'off'],
  flags: [{ name: 'level', takesValue: true, values: ['full', 'operate'], summary: 'full: terminals may also decide and configure; operate: watch and run only' }],
  notes: [
    'Without arguments it prints the stored choice. on, off and --level change it only while no OrgAI host owns the data folder (stop a background host first with orgai daemon stop; with the app open, change it in App settings > General > Advanced settings > Terminal access).'
  ],
  available: true
}
