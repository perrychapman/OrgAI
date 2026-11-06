/** `orgai secrets` (Wave 7, cli-standalone.md 5.7). Pure data. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'secrets',
  summary: 'The secret vault shared by the app and the orgai command (never prints a value)',
  usage: 'secrets status [--probe] | init [--key-file <path> [--import]] | reset --yes | undelete <key>',
  subcommands: ['status', 'init', 'reset', 'undelete'],
  flags: [
    { name: 'probe', takesValue: false, summary: 'status: also check that the OS key store (or key file) can be reached now' },
    { name: 'key-file', takesValue: true, summary: 'init: keep the vault key in this file (created new) instead of the OS store' },
    { name: 'import', takesValue: false, summary: 'init: use an existing key file given with --key-file' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'reset: do not ask for confirmation' }
  ],
  available: true
}
