/** `orgai team` (cli-spec 6.3, Wave 5): team templates, roles and plugins. Pure data. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'team',
  summary: 'Team templates, roles and plugins',
  usage:
    'team templates [list] | templates save --name <name> [--description <text>] | templates apply <id> [--mode replace|merge] [--yes] | templates remove <id> [--yes] | roles | role <name-or-slug> | plugins [list] | plugins add --path <dir> [--name <n>] [--id <id>] [--disabled] [--skip-mcp] | plugins remove <id> [--yes]',
  subcommands: ['templates', 'roles', 'role', 'plugins'],
  flags: [
    { name: 'name', takesValue: true, summary: 'templates save: the template name; plugins add: the plugin name' },
    { name: 'description', takesValue: true, summary: 'templates save: a description' },
    { name: 'mode', takesValue: true, values: ['replace', 'merge'], summary: 'templates apply: replace (default) the chart or merge under its root' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'Confirm without asking' },
    { name: 'path', takesValue: true, summary: 'plugins add: the plugin folder (holds .claude-plugin/plugin.json)' },
    { name: 'id', takesValue: true, summary: 'plugins add: replace the plugin with this id' },
    { name: 'disabled', takesValue: false, summary: 'plugins add: add it turned off' },
    { name: 'skip-mcp', takesValue: false, summary: 'plugins add: do not load the MCP servers it declares' }
  ],
  available: true
}
