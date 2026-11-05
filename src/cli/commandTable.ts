/**
 * The CLI's command table (cli-spec 6.1, 6.3): what `orgai --help`, routing (index.ts) and `orgai completions` read.
 * Entries with `available: false` belong to later waves; index.ts answers them with a "not available yet" usage error.
 * The Wave 5 management commands each live in their own file under ./entries (one per domain, so parallel work never
 * collides here).
 */
import { PERMISSION_MODES } from '../shared/types'
import { ENTRY as INIT_ENTRY } from './entries/init'
import { ENTRY as ORG_ENTRY } from './entries/org'
import { ENTRY as TEAM_ENTRY } from './entries/team'
import { ENTRY as WORKTREES_ENTRY } from './entries/worktrees'
import { ENTRY as PERMISSIONS_ENTRY } from './entries/permissions'
import { ENTRY as CONNECTIONS_ENTRY } from './entries/connections'
import { ENTRY as MODELS_ENTRY } from './entries/models'
import { ENTRY as MCP_ENTRY } from './entries/mcp'
import { ENTRY as SKILLS_ENTRY } from './entries/skills'
import { ENTRY as KNOWLEDGE_ENTRY } from './entries/knowledge'
import { ENTRY as NOTES_ENTRY } from './entries/notes'
import { ENTRY as USAGE_ENTRY } from './entries/usage'
import { ENTRY as KIT_ENTRY } from './entries/kit'
import { ENTRY as PROJECTS_ENTRY } from './entries/projects'

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

/** Terminal UI flags (bare `orgai`, `tui`, `attach`, `resume` without --exec). */
export const TUI_FLAGS: readonly CommandFlag[] = [
  { name: 'inline', takesValue: false, summary: 'Draw in the normal scrollback instead of the full screen' },
  { name: 'ax-screen-reader', takesValue: false, summary: 'Screen reader mode: inline, plain text, no animation' }
]

/** Flags of bare `orgai [options] [--] <prompt>` (index.ts routes them to the terminal UI; shown in --help). */
export const DEFAULT_TUI_FLAGS: readonly CommandFlag[] = [
  ...TUI_FLAGS,
  { name: 'team', takesValue: true, values: ['default', 'single'], summary: 'With a prompt: the org chart (default) or one assistant (single)' }
]

/** Exec flags shared by `orgai exec` and `orgai resume --exec` (cli-spec 6.2). */
const EXEC_RUN_FLAGS: readonly CommandFlag[] = [
  { name: 'permission-mode', takesValue: true, values: PERMISSION_MODES, summary: 'Permission mode for this run (narrowing needs no extra access)' },
  { name: 'no-auto-continue', takesValue: false, summary: 'Do not continue automatically until the plan is done' },
  { name: 'max-auto-continues', takesValue: true, summary: 'At most this many automatic continues' },
  { name: 'max-budget', takesValue: true, summary: 'Estimated cost cap in USD across the exec chain (0 allowed)' },
  { name: 'max-cost', takesValue: true, summary: 'Alias of --max-budget' },
  { name: 'allow-unpriced-budget', takesValue: false, summary: 'Allow a budget even when a model has no known price' },
  { name: 'allow-unmerged', takesValue: false, summary: 'Count unmerged conflict branches as completed' },
  { name: 'allow-peer-messages', takesValue: false, summary: 'Accept messages from other runs (message_run)' },
  { name: 'wait-for-reset', takesValue: false, summary: 'On a usage limit, wait for the reset instead of ending' },
  { name: 'stall-timeout', takesValue: true, summary: 'Seconds without progress before the run ends as stalled' },
  { name: 'on-permission', takesValue: true, values: ['deny', 'fail', 'wait'], summary: 'Permission cards: deny (default), fail or wait' },
  { name: 'on-rules', takesValue: true, values: ['deny', 'fail', 'wait'], summary: 'Permission rule requests: deny (default), fail or wait' },
  { name: 'on-mcp-install', takesValue: true, values: ['deny', 'fail', 'wait'], summary: 'MCP install requests: deny (default), fail or wait' },
  { name: 'on-question', takesValue: true, values: ['fail', 'conservative', 'wait'], summary: 'Questions: fail (default), conservative (no option picked; the agent is told to take the most cautious path) or wait' },
  { name: 'on-proposal', takesValue: true, values: ['decline', 'fail', 'wait'], summary: 'Proposals: decline (default), fail or wait' },
  { name: 'on-merge', takesValue: true, values: ['hold', 'fail', 'wait'], summary: 'Merge reviews: hold (default), fail or wait' },
  { name: 'max-auto-denials', takesValue: true, summary: 'Automatic denials before the run ends as needs-decision (default 5)' },
  { name: 'wait-timeout', takesValue: true, summary: 'Seconds a "wait" policy waits for a person (default 900)' },
  { name: 'human-grace', takesValue: true, summary: 'Seconds to leave a card to an open app or terminal UI first (default 60)' }
]

/** Flags only `orgai exec` takes (how the run starts). */
const EXEC_START_FLAGS: readonly CommandFlag[] = [
  { name: 'team', takesValue: true, values: ['default', 'single'], summary: 'The org chart (default) or one assistant (single)' },
  { name: 'quick', takesValue: false, summary: 'A Chat run outside any project' },
  { name: 'allow-edits', takesValue: false, summary: 'With --quick: allow edits in the folder (each still asks)' },
  { name: 'create-project', takesValue: false, summary: 'Make the current folder a project when it is not one' }
]

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
    summary: 'List, show, message, interrupt or stop runs',
    usage:
      'runs list [--all-projects] [--status <status>] [--limit <n>] | runs show <runId-or-R#> [--transcript | --tail <n>] | runs send <runId-or-R#> <text|-> | runs interrupt <runId-or-R#> | runs stop <runId-or-R#>',
    subcommands: ['list', 'show', 'send', 'interrupt', 'stop'],
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
  {
    name: 'tui',
    summary: 'Start the interactive terminal UI (optionally on a run)',
    usage: 'tui [--run <runId-or-R#>] [--inline] [--ax-screen-reader]',
    flags: [{ name: 'run', takesValue: true, summary: 'Run to open' }, ...TUI_FLAGS],
    available: true
  },
  {
    name: 'exec',
    summary: 'Run headless, non-interactively (alias: orgai -p <prompt>)',
    usage: 'exec [options] [--] [prompt|-]',
    flags: [...EXEC_RUN_FLAGS, ...EXEC_START_FLAGS],
    available: true
  },
  {
    name: 'resume',
    summary: 'Continue a session chain in the terminal UI, or headless with --exec',
    usage: 'resume [runId-or-R#] [--prompt <text> | -] [--exec [exec options]]',
    flags: [
      { name: 'prompt', takesValue: true, summary: 'The message to continue with ("-" reads stdin, --exec only)' },
      { name: 'exec', takesValue: false, summary: 'Continue headless, keeping the chain\'s exec settings' },
      ...TUI_FLAGS,
      ...EXEC_RUN_FLAGS
    ],
    available: true
  },
  {
    name: 'attach',
    summary: 'Attach the terminal UI to a live or ended run',
    usage: 'attach <runId-or-R#> [--inline] [--ax-screen-reader]',
    flags: [...TUI_FLAGS],
    available: true
  },
  {
    name: 'decide',
    summary:
      'Resolve a pending decision card. Verbs: permission allow | allow-session | allow-project | deny; rules grant | grant-project | deny; proposal approve | revise | decline; question answer; merge merge | hold | discard; mcpInstall allow | save-project | save-library | deny',
    usage: 'decide <requestId> <verb> [options]',
    flags: [
      { name: 'revision', takesValue: true, summary: 'Refuse when the card changed since this revision' },
      { name: 'yes', short: 'y', takesValue: false, summary: 'Do not ask for confirmation' },
      { name: 'message', takesValue: true, summary: 'deny: the reason the agent sees' },
      { name: 'note', takesValue: true, summary: 'proposal revise / decline, mcpInstall: a note for the agent' },
      { name: 'secret', takesValue: true, summary: 'proposal approve / mcpInstall: NAME=ENV_VAR, read from the environment (repeatable)' },
      { name: 'option', takesValue: true, summary: 'question answer: an option label (repeatable)' },
      { name: 'pick', takesValue: true, summary: 'question answer: an option number, 1-based (repeatable)' },
      { name: 'text', takesValue: true, summary: 'question answer: free text' }
    ],
    available: true
  },
  INIT_ENTRY,
  ORG_ENTRY,
  TEAM_ENTRY,
  WORKTREES_ENTRY,
  PERMISSIONS_ENTRY,
  CONNECTIONS_ENTRY,
  MODELS_ENTRY,
  MCP_ENTRY,
  SKILLS_ENTRY,
  KNOWLEDGE_ENTRY,
  NOTES_ENTRY,
  USAGE_ENTRY,
  KIT_ENTRY,
  PROJECTS_ENTRY
]

export function findCommand(name: string): CommandEntry | undefined {
  return COMMANDS.find((c) => c.name === name)
}
