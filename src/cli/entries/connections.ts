/** `orgai connections` (cli-spec 6.3, Wave 5). Pure data. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'connections',
  summary: 'Model connections',
  usage: 'connections <list|show|test|connect|login|logout|set-default|set-secret|update|proxy|tier> [<id>] [options] | connections tier <id> [<tier>=<model> ...] [--reset <tier>] [--force] [--dry-run]',
  subcommands: ['list', 'show', 'test', 'connect', 'login', 'logout', 'set-default', 'set-secret', 'update', 'proxy', 'tier'],
  flags: [
    { name: 'device-code', takesValue: false, summary: 'login: sign in with a one-time code (default over SSH)' },
    { name: 'browser', takesValue: false, summary: 'login: sign in through the browser on the host machine' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'logout: do not ask for confirmation' },
    { name: 'from-env', takesValue: true, summary: 'set-secret: read the key from this environment variable' },
    { name: 'stdin', takesValue: false, summary: 'set-secret: read the key from stdin' },
    { name: 'clear', takesValue: false, summary: 'set-secret: remove the stored key' },
    { name: 'base-url', takesValue: true, summary: "update: a proxy's Anthropic URL (none clears it)" },
    { name: 'name', takesValue: true, summary: 'proxy add, proxy edit: the display name' },
    { name: 'anthropic-url', takesValue: true, summary: 'proxy add, proxy edit: the Anthropic-style base URL' },
    { name: 'openai-url', takesValue: true, summary: 'proxy add, proxy edit: the OpenAI-style base URL (none clears it)' },
    { name: 'models-url', takesValue: true, summary: 'proxy add, proxy edit: the model list URL (none clears it)' },
    { name: 'kind', takesValue: true, values: ['litellm', 'openai-compatible'], summary: 'proxy add: the proxy kind' },
    { name: 'key-env', takesValue: true, summary: 'proxy add: read the key from this environment variable' },
    { name: 'key-stdin', takesValue: false, summary: 'proxy add: read the key from stdin' },
    { name: 'connect', takesValue: false, summary: 'proxy add: connect after adding' },
    { name: 'enable', takesValue: false, summary: 'update: turn the connection on' },
    { name: 'disable', takesValue: false, summary: 'update: turn the connection off' },
    { name: 'reset', takesValue: true, values: ['top', 'deep', 'everyday', 'fast'], summary: "tier: put this tier back on discovery's choice (repeatable)" },
    { name: 'force', takesValue: false, summary: "tier: send a model id that is not in the connection's catalog" },
    { name: 'dry-run', takesValue: false, summary: 'tier: show the change and the roles it touches without saving' }
  ],
  available: true
}
