/** `orgai projects` (cli-spec 6.3, Wave 5). Pure data (help and completions read it). */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'projects',
  summary: 'Projects',
  usage: 'projects <list|show|check|create|set|remove|save-chat> [options]',
  subcommands: ['list', 'show', 'create', 'check', 'set', 'remove', 'save-chat'],
  flags: [
    { name: 'name', takesValue: true, summary: 'create / set / save-chat: the project name' },
    { name: 'kind', takesValue: true, values: ['code', 'engagement'], summary: 'create: what the project is for (default code)' },
    { name: 'brief', takesValue: true, summary: 'create / set: a short description of the project' },
    { name: 'client', takesValue: true, summary: 'create / set (engagements): who the work is for; set --client "" clears it' },
    { name: 'template', takesValue: true, summary: 'create: start from this team template id' },
    { name: 'import-agents', takesValue: false, summary: 'create: start with the agent definitions found in the folder' },
    { name: 'max-budget', takesValue: true, summary: 'set: estimated cost cap per run in USD, or none' },
    { name: 'max-depth', takesValue: true, summary: 'set: levels of reports that may spawn reports (1-5), or auto' },
    { name: 'max-concurrent', takesValue: true, summary: 'set: reports running at once (1-32), or auto' },
    { name: 'plan-guard', takesValue: true, values: ['auto', 'on', 'off'], summary: 'set: move deep work to the everyday tier near a plan limit' },
    { name: 'auto-continue', takesValue: true, values: ['on', 'off'], summary: 'set: continue automatically until the plan is done' },
    { name: 'max-auto-continues', takesValue: true, summary: 'set: at most this many automatic continues' },
    { name: 'run-messaging', takesValue: true, values: ['on', 'off'], summary: 'set: let runs message each other' },
    { name: 'isolate-writers', takesValue: true, values: ['on', 'off'], summary: 'set: give each writing report its own worktree' },
    { name: 'keep-runs', takesValue: false, summary: 'remove: keep the run records (code projects only)' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'remove: do not ask for confirmation' }
  ],
  available: true
}
