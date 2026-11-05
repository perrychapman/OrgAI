/** `orgai connections` (cli-spec 6.3, Wave 5). Pure data. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'connections',
  summary: 'Model connections',
  usage: 'connections <list|show|test|connect|login|logout|set-default|set-secret|update> [<id>] [options]',
  subcommands: ['list', 'show', 'test', 'connect', 'login', 'logout', 'set-default', 'set-secret', 'update'],
  flags: [
    { name: 'device-code', takesValue: false, summary: 'login: sign in with a one-time code (default over SSH)' },
    { name: 'browser', takesValue: false, summary: 'login: sign in through the browser on the host machine' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'logout: do not ask for confirmation' },
    { name: 'from-env', takesValue: true, summary: 'set-secret: read the key from this environment variable' },
    { name: 'stdin', takesValue: false, summary: 'set-secret: read the key from stdin' },
    { name: 'clear', takesValue: false, summary: 'set-secret: remove the stored key' },
    { name: 'base-url', takesValue: true, summary: 'update: the LiteLLM proxy URL (none clears it)' },
    { name: 'enable', takesValue: false, summary: 'update: turn the connection on' },
    { name: 'disable', takesValue: false, summary: 'update: turn the connection off' }
  ],
  available: true
}
