/** `orgai outputs` (cli-parity 3.6). Pure data; the command lives in commands/outputs.ts. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'outputs',
  summary: 'The files runs produced: list, show a preview, ask for a revision, add a note',
  usage: 'outputs [list [--run <run>]] | outputs show <output> | outputs revise <output> "<instruction>" [--run <run> | --new] | outputs note <output> "<text>" [--version <n>]',
  subcommands: ['list', 'show', 'revise', 'note'],
  flags: [
    { name: 'run', takesValue: true, summary: 'list: only this run\'s outputs; revise: send the request to this run (id or R#)' },
    { name: 'new', takesValue: false, summary: 'revise: start a new run for the request' },
    { name: 'version', takesValue: true, summary: 'note: the version the note is on (default: the current one)' }
  ],
  available: true,
  notes: [
    'Outputs belong to the current project (the folder you are in, or --project <id-or-path>). <output> is an id (or the first 6 or more characters of one), a file name, a path relative to the project, or a title. `outputs show` prints metadata and, for text-like files (text, markdown, documents, sheets, slide titles, SVG source), a preview of the first lines; for other kinds it gives the path.',
    '`outputs revise` sends the request for the whole current version to the run that made it when that run is live or continuable, else to a new run. `outputs note` adds a note on the whole version. Opening, saving, forgetting and deleting outputs are done in the desktop app.'
  ]
}
