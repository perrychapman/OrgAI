/** `orgai team` (cli-spec 6.3, Wave 5; role editing cli-parity 3.3): team templates, roles and plugins. Pure data. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'team',
  summary: 'Team templates, roles, plugins and team files',
  usage:
    'team files [status] | team templates [list] | templates save --name <name> [--description <text>] | templates apply <id> [--mode replace|merge] [--yes] | templates remove <id> [--yes] | roles | role [show] <name-or-slug> | role add <name> --reports-to <role> [role flags] | role set <role> [role flags] | role rm <role> [--reparent-to <role>] [--yes] | role move <role> --reports-to <role> [--yes] | plugins [list] | plugins add --path <dir> [--name <n>] [--id <id>] [--disabled] [--skip-mcp] | plugins remove <id> [--yes]',
  subcommands: ['templates', 'roles', 'role', 'plugins', 'files'],
  flags: [
    { name: 'name', takesValue: true, summary: 'templates save: the template name; plugins add: the plugin name; role set: rename the role (its slug follows)' },
    { name: 'description', takesValue: true, summary: 'templates save: a description; role add / set: when a manager should delegate to the role' },
    { name: 'mode', takesValue: true, values: ['replace', 'merge'], summary: 'templates apply: replace (default) the chart or merge under its root' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'Confirm without asking (role edits that may spend more, role rm)' },
    { name: 'path', takesValue: true, summary: 'plugins add: the plugin folder (holds .claude-plugin/plugin.json)' },
    { name: 'id', takesValue: true, summary: 'plugins add: replace the plugin with this id' },
    { name: 'disabled', takesValue: false, summary: 'plugins add: add it turned off' },
    { name: 'skip-mcp', takesValue: false, summary: 'plugins add: do not load the MCP servers it declares' },
    { name: 'reports-to', takesValue: true, summary: 'role add / move: the manager (slug or name)' },
    { name: 'reparent-to', takesValue: true, summary: 'role rm: the manager the removed role\'s reports move to' },
    { name: 'prompt', takesValue: true, summary: 'role add / set: the system prompt' },
    { name: 'prompt-file', takesValue: true, summary: 'role add / set: read the system prompt from this file' },
    { name: 'edit', takesValue: false, summary: 'role add / set: edit the prompt in $VISUAL / $EDITOR (interactive terminal only)' },
    { name: 'model', takesValue: true, summary: 'role add / set: a tier (top, deep, everyday, fast), inherit or a model id of the role\'s connection' },
    { name: 'force', takesValue: false, summary: 'role add / set: accept a model id that is not in the connection\'s catalog' },
    { name: 'effort', takesValue: true, values: ['low', 'medium', 'high', 'xhigh', 'max', 'none'], summary: 'role add / set: reasoning effort (none = the default)' },
    { name: 'staffing', takesValue: true, values: ['auto', 'fixed', 'inherit'], summary: 'role add / set: automatic, always as configured, or follow the project' },
    { name: 'min-tier', takesValue: true, values: ['top', 'deep', 'everyday', 'fast', 'none'], summary: 'role add / set: the lowest tier automatic staffing may pick' },
    { name: 'max-effort', takesValue: true, values: ['low', 'medium', 'high', 'xhigh', 'max', 'none'], summary: 'role add / set: the highest effort automatic staffing may pick' },
    { name: 'tools', takesValue: true, summary: 'role add / set: the whole tool list (a,b or none)' },
    { name: 'add-tool', takesValue: true, summary: 'role add / set: add a tool (repeatable)' },
    { name: 'rm-tool', takesValue: true, summary: 'role add / set: remove a tool (repeatable)' },
    { name: 'can-spawn', takesValue: true, values: ['on', 'off'], summary: 'role add / set: may the role create subagents' },
    { name: 'spawnable', takesValue: true, summary: 'role set: the reports it may spawn (a,b or none)' },
    { name: 'required-reports', takesValue: true, summary: 'role set: the reports it must delegate to (a,b or none; a subset of --spawnable)' },
    { name: 'connection', takesValue: true, summary: 'role add / set: the connection the role runs on (an id, or inherit = the project\'s)' },
    { name: 'mcp', takesValue: true, summary: 'role add / set: explicit MCP server grants (ids or names, or none)' }
  ],
  available: true,
  notes: [
    'team files [status]: the changes to .orgai/team.json and .orgai/agents/*.md that wait for approval, with what each would give the team. orgai does not approve, reject, undo or commit them: a terminal cannot yet prove that a person, not an agent, is answering, so this is done in the OrgAI desktop app for now. In the terminal UI, /approvals shows the same, read-only.',
    'Role edits go through the same save as the desktop editor. A change that may make a role spend more (a higher tier or effort, automatic staffing or a raised ceiling, another connection, spawning switched on) prints why and asks first; pass --yes without a terminal. Lowering never asks.'
  ]
}
