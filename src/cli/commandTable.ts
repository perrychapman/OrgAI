/**
 * The CLI's command table (cli-spec 6.1, 6.3): what `orgai --help`, routing (index.ts) and `orgai completions` read.
 * Entries with `available: false` belong to later waves; index.ts answers them with a "not available yet" usage error.
 */

export interface CommandFlag {
  /** Long name without the dashes. */
  name: string
  /** One-letter alias without the dash. */
  short?: string
  /** True when the flag takes a value. */
  takesValue: boolean
  /** Fixed values, for completion. */
  values?: readonly string[]
  summary: string
}

export interface CommandEntry {
  name: string
  summary: string
  /** One-line usage after `orgai `. */
  usage: string
  /** Subcommand words, for completion and help. */
  subcommands?: readonly string[]
  flags: readonly CommandFlag[]
  /** false: listed for help and completion, but not built yet (a later wave). */
  available: boolean
}

/** Flags valid anywhere before `--` (flags.ts splitGlobalFlags). */
export const GLOBAL_FLAGS: readonly CommandFlag[] = [
  { name: 'data-dir', takesValue: true, summary: 'OrgAI user data folder (default: ORGAI_DATA_DIR, else the platform default)' },
  { name: 'host', takesValue: true, values: ['auto', 'daemon', 'inproc'], summary: 'Which host to use' },
  { name: 'output-format', takesValue: true, values: ['text', 'json', 'stream-json'], summary: 'Output format' },
  { name: 'project', takesValue: true, summary: 'Project id or folder (default: the project containing the current folder)' },
  { name: 'no-color', takesValue: false, summary: 'Plain output without colour' },
  { name: 'secret-env', takesValue: true, summary: 'With --host inproc: <owner>:<kind>:<name>=<ENV_VAR> (repeatable)' },
  { name: 'help', short: 'h', takesValue: false, summary: 'Show help' },
  { name: 'version', short: 'V', takesValue: false, summary: 'Print the version' }
]

const later = (name: string, summary: string, usage: string, subcommands?: readonly string[]): CommandEntry => ({
  name,
  summary,
  usage,
  ...(subcommands ? { subcommands } : {}),
  flags: [],
  available: false
})

export const COMMANDS: readonly CommandEntry[] = [
  {
    name: 'status',
    summary: 'Show the host, the current project and what needs you',
    usage: 'status [--all-projects]',
    flags: [{ name: 'all-projects', takesValue: false, summary: 'Every project' }],
    available: true
  },
  {
    name: 'runs',
    summary: 'List runs or show one run',
    usage: 'runs list [--all-projects] [--status <status>] [--limit <n>] | runs show <runId-or-R#> [--transcript | --tail <n>]',
    subcommands: ['list', 'show'],
    flags: [
      { name: 'all-projects', takesValue: false, summary: 'Runs of every project' },
      { name: 'status', takesValue: true, values: ['running', 'needs you', 'idle', 'paused', 'finished', 'stopped', 'ended when orgai closed', 'failed'], summary: 'Only runs with this status' },
      { name: 'limit', short: 'n', takesValue: true, summary: 'At most this many runs' },
      { name: 'transcript', takesValue: false, summary: 'runs show: the whole transcript' },
      { name: 'tail', takesValue: true, summary: 'runs show: the last N transcript rows' }
    ],
    available: true
  },
  {
    name: 'watch',
    summary: 'Stream a run’s events to stdout (Ctrl+C detaches)',
    usage: 'watch <runId-or-R#> [--no-follow]',
    flags: [{ name: 'no-follow', takesValue: false, summary: 'Do not follow continuations' }],
    available: true
  },
  {
    name: 'inbox',
    summary: 'List pending decisions ("Needs you")',
    usage: 'inbox [--all-projects]',
    flags: [{ name: 'all-projects', takesValue: false, summary: 'Decisions of every project' }],
    available: true
  },
  {
    name: 'daemon',
    summary: 'Inspect or control the background host',
    usage: 'daemon status | start [--foreground] [--timeout <s>] | stop [--force] [--timeout <s>] | restart [--force] [--timeout <s>] | logs [-n <lines>] [-f]',
    subcommands: ['status', 'start', 'stop', 'restart', 'logs'],
    flags: [
      { name: 'force', takesValue: false, summary: 'Stop live runs instead of refusing' },
      { name: 'foreground', takesValue: false, summary: 'start: run the host in this terminal (inproc)' },
      { name: 'timeout', takesValue: true, summary: 'Seconds to wait' },
      { name: 'lines', short: 'n', takesValue: true, summary: 'logs: how many lines' },
      { name: 'follow', short: 'f', takesValue: false, summary: 'logs: keep printing new lines' }
    ],
    available: true
  },
  {
    name: 'app',
    summary: 'Open the OrgAI desktop app (optionally on a run)',
    usage: 'app [--run <runId-or-R#>]',
    flags: [{ name: 'run', takesValue: true, summary: 'Run to open' }],
    available: true
  },
  {
    name: 'doctor',
    summary: 'Check the install, data folder, host and connections',
    usage: 'doctor',
    flags: [],
    available: true
  },
  {
    name: 'completions',
    summary: 'Print a shell completion script',
    usage: 'completions bash | zsh | fish',
    subcommands: ['bash', 'zsh', 'fish'],
    flags: [],
    available: true
  },
  later('tui', 'Start the interactive terminal UI', 'tui [--run <runId-or-R#>]'),
  later('exec', 'Run headless, non-interactively', 'exec [options] [--] [prompt]'),
  later('resume', 'Continue a session chain', 'resume [runId-or-R#] [--prompt <text> | -]'),
  later('attach', 'Attach the terminal UI to a run', 'attach <runId-or-R#>'),
  later('decide', 'Resolve a pending decision card', 'decide <requestId> <action> [options]'),
  later('init', 'Set up a project in the current folder', 'init [options]'),
  later('org', 'Org chart and Team assistant', 'org <subcommand>'),
  later('team', 'Team templates and roles', 'team <subcommand>'),
  later('worktrees', 'Agent worktrees', 'worktrees <subcommand>'),
  later('permissions', 'Saved permission rules', 'permissions <subcommand>'),
  later('connections', 'Model connections', 'connections <subcommand>'),
  later('models', 'Models and prices', 'models <subcommand>'),
  later('mcp', 'MCP servers and connectors', 'mcp <subcommand>'),
  later('skills', 'Skills', 'skills <subcommand>'),
  later('knowledge', 'Engagement knowledge', 'knowledge <subcommand>'),
  later('notes', 'Engagement context notes', 'notes <subcommand>'),
  later('usage', 'Usage and cost', 'usage <subcommand>'),
  later('kit', 'Practice kits', 'kit <subcommand>'),
  later('projects', 'Projects', 'projects <subcommand>')
]

export function findCommand(name: string): CommandEntry | undefined {
  return COMMANDS.find((c) => c.name === name)
}
