/**
 * The CLI's command table (cli-spec 6.1, 6.3): what `orgai --help`, routing (index.ts) and `orgai completions` read.
 * Entries with `available: false` belong to later waves; index.ts answers them with a "not available yet" usage error.
 * The Wave 5 management commands each live in their own file under ./entries (one per domain, so parallel work never
 * collides here).
 */
import { PERMISSION_MODES, STAFFING_GOALS } from '../shared/types'
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
import { ENTRY as SECRETS_ENTRY } from './entries/secrets'

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
  /** Extra paragraphs `orgai help <command>` prints after the options. */
  notes?: readonly string[]
}

/** Flags valid anywhere before `--` (flags.ts splitGlobalFlags). */
export const GLOBAL_FLAGS: readonly CommandFlag[] = [
  { name: 'data-dir', takesValue: true, summary: 'orgai CLI data folder (default: ORGAI_CLI_DATA_DIR, else the platform default)' },
  { name: 'output-format', takesValue: true, values: ['text', 'json', 'stream-json'], summary: 'Output format' },
  { name: 'project', takesValue: true, summary: 'Project id or folder (default: the project containing the current folder)' },
  { name: 'no-color', takesValue: false, summary: 'Plain output without colour' },
  { name: 'secret-env', takesValue: true, summary: 'Use an environment variable as a secret: <owner>:<kind>:<name>=<ENV_VAR> (repeatable)' },
  { name: 'help', short: 'h', takesValue: false, summary: 'Show help' },
  { name: 'version', short: 'V', takesValue: false, summary: 'Print the version' }
]

/** Terminal UI flags (bare `orgai`, `tui`, `resume` without --exec). */
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
  { name: 'strict-delegation', takesValue: false, summary: 'Every role that can spawn must delegate to all of its spawnable roles' },
  { name: 'goal', takesValue: true, values: STAFFING_GOALS, summary: 'What staffing favors for this run: balanced (default), speed or cost' },
  { name: 'allow-peer-messages', takesValue: false, summary: 'Accept messages from other runs (message_run)' },
  { name: 'wait-for-reset', takesValue: false, summary: 'On a usage limit, wait for the reset instead of ending' },
  { name: 'stall-timeout', takesValue: true, summary: 'Seconds without progress before the run ends as stalled' },
  { name: 'on-permission', takesValue: true, values: ['deny', 'fail'], summary: 'Permission cards: deny (default), fail' },
  { name: 'on-rules', takesValue: true, values: ['deny', 'fail'], summary: 'Permission rule requests: deny (default), fail' },
  { name: 'on-mcp-install', takesValue: true, values: ['deny', 'fail'], summary: 'MCP install requests: deny (default), fail' },
  { name: 'on-question', takesValue: true, values: ['fail', 'conservative'], summary: 'Questions: fail (default), conservative (no option picked; the agent is told to take the most cautious path)' },
  { name: 'on-proposal', takesValue: true, values: ['decline', 'fail'], summary: 'Proposals: decline (default), fail' },
  { name: 'on-merge', takesValue: true, values: ['hold', 'fail'], summary: 'Merge reviews: hold (default), fail' },
  { name: 'max-auto-denials', takesValue: true, summary: 'Automatic denials before the run ends as needs-decision (default 5)' }
]

/**
 * `--prompt-file`, on `orgai exec` / `-p` and `orgai resume --exec`. Untrusted text belongs in a file or on stdin: on
 * Windows the `orgai` command is a .cmd file, so cmd.exe re-reads every argument and a quote the caller did not escape
 * (PowerShell 5.1, a CI step building the prompt from an issue title) can end it and run `&` / `|` (review M12).
 */
const PROMPT_FILE_FLAG: CommandFlag = { name: 'prompt-file', takesValue: true, summary: 'Read the prompt from this file ("-" reads stdin); use it for text you did not write' }

/** The Windows argument note of `orgai help exec` / `orgai help resume` (review M12). */
export const UNTRUSTED_PROMPT_NOTE =
  'Text you did not write (an issue title, a web page, agent output) goes in a file or on stdin, never on the command line: --prompt-file <path>, or - with the text piped in. On Windows orgai is a .cmd file, so cmd.exe re-reads its arguments and a quote that was not escaped can end the prompt and run & or | as a command.'

/** Flags only `orgai exec` takes (how the run starts). */
const EXEC_START_FLAGS: readonly CommandFlag[] = [
  { name: 'team', takesValue: true, values: ['default', 'single'], summary: 'The org chart (default) or one assistant (single)' },
  { name: 'quick', takesValue: false, summary: 'A Chat run outside any project' },
  { name: 'allow-edits', takesValue: false, summary: 'With --quick: allow edits in the folder (each still asks); without it the chat starts read-only and an edit or command asks' },
  { name: 'create-project', takesValue: false, summary: 'Make the current folder a project when it is not one' }
]

export const COMMANDS: readonly CommandEntry[] = [
  {
    name: 'status',
    summary: 'Show the data folder, the current project and your runs',
    usage: 'status [--all-projects]',
    flags: [{ name: 'all-projects', takesValue: false, summary: 'Every project' }],
    available: true
  },
  {
    name: 'runs',
    summary: 'List or show saved runs (open one with `orgai tui <run>`)',
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
    name: 'doctor',
    summary: 'Check the install, data folder, vault and runtimes',
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
    usage: 'tui [<run> | --run <run>] [--inline] [--ax-screen-reader]',
    flags: [{ name: 'run', takesValue: true, summary: 'Run to open' }, ...TUI_FLAGS],
    available: true
  },
  {
    name: 'exec',
    summary: 'Run headless, non-interactively (alias: orgai -p <prompt>)',
    usage: 'exec [options] [--prompt-file <path|->] [--] [prompt|-]',
    flags: [PROMPT_FILE_FLAG, ...EXEC_RUN_FLAGS, ...EXEC_START_FLAGS],
    available: true,
    notes: [UNTRUSTED_PROMPT_NOTE]
  },
  {
    name: 'resume',
    summary: 'Continue a session chain in the terminal UI, or headless with --exec',
    usage: 'resume [runId-or-R#] [--prompt <text> | --prompt-file <path|-> | -] [--exec [exec options]]',
    flags: [
      { name: 'prompt', takesValue: true, summary: 'The message to continue with ("-" reads stdin, --exec only)' },
      { ...PROMPT_FILE_FLAG, summary: 'Read the message from this file ("-" reads stdin, --exec only); use it for text you did not write' },
      { name: 'exec', takesValue: false, summary: 'Continue headless, keeping the chain\'s exec settings' },
      ...TUI_FLAGS,
      ...EXEC_RUN_FLAGS
    ],
    available: true,
    notes: [UNTRUSTED_PROMPT_NOTE]
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
  PROJECTS_ENTRY,
  SECRETS_ENTRY
]

export function findCommand(name: string): CommandEntry | undefined {
  return COMMANDS.find((c) => c.name === name)
}
