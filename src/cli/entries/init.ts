/** `orgai init` (cli-spec 6.3(1), Wave 5). Pure data (help and completions read it). */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'init',
  summary: 'Set up a project in the current folder',
  usage: 'init [<folder>] [options]',
  flags: [
    { name: 'name', takesValue: true, summary: 'The project name (default: the folder name)' },
    { name: 'kind', takesValue: true, values: ['code', 'engagement'], summary: 'What the project is for (default code)' },
    { name: 'brief', takesValue: true, summary: 'A short description of the project' },
    { name: 'client', takesValue: true, summary: 'Engagements: who the work is for' },
    { name: 'skip-architect', takesValue: false, summary: 'Create the project without the setup interview and exit' },
    { name: 'template', takesValue: true, summary: 'Start from this team template id' },
    { name: 'import-agents', takesValue: false, summary: 'Start with the agent definitions found in the folder' },
    { name: 'inline', takesValue: false, summary: 'Draw in the normal scrollback instead of the full screen' },
    { name: 'ax-screen-reader', takesValue: false, summary: 'Screen reader mode: inline, plain text, no animation' }
  ],
  available: true
}
