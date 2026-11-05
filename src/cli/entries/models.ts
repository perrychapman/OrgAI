/** `orgai models` (cli-spec 6.3, Wave 5). Pure data. */
import type { CommandEntry } from '../commandTable'

const CONNECTIONS = ['anthropic', 'openai', 'litellm'] as const

export const ENTRY: CommandEntry = {
  name: 'models',
  summary: 'Models and prices',
  usage: 'models <list|refresh|prices|remap> [options]',
  subcommands: ['list', 'refresh', 'prices', 'remap'],
  flags: [
    { name: 'connection', takesValue: true, values: CONNECTIONS, summary: 'list, refresh, prices: only this connection' },
    { name: 'model', takesValue: true, summary: 'prices: only this model id' },
    { name: 'to', takesValue: true, values: CONNECTIONS, summary: 'remap: move the project to this connection' },
    { name: 'apply', takesValue: false, summary: 'remap: save the changes (asks first)' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'remap --apply: do not ask for confirmation' }
  ],
  available: true
}
