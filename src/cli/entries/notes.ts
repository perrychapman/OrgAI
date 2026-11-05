/** `orgai notes` (cli-spec 6.3, Wave 5). Pure data. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'notes',
  summary: 'Engagement context notes and plan',
  usage: 'notes <list|show|add|edit|remove|plan> [<id-or-title>] [options]',
  subcommands: ['list', 'show', 'add', 'edit', 'remove', 'plan'],
  flags: [
    { name: 'retired', takesValue: false, summary: 'list: include retired notes' },
    { name: 'title', takesValue: true, summary: 'add, edit: the note title' },
    { name: 'text', takesValue: true, summary: 'add, edit, plan set: the text' },
    { name: 'file', takesValue: true, summary: 'add, edit, plan set: read the text from a file (- for stdin)' },
    { name: 'retire', takesValue: false, summary: 'edit: mark the note retired' },
    { name: 'restore', takesValue: false, summary: 'edit: clear the retired mark' },
    { name: 'expected-updated-at', takesValue: true, summary: 'edit, plan set: refuse the save unless this is still the revision (epoch ms)' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'remove: do not ask for confirmation' }
  ],
  available: true
}
