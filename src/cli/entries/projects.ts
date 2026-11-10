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
    { name: 'staffing', takesValue: true, values: ['auto', 'fixed'], summary: 'set: let the harness pick each report\'s tier and effort (auto) or not (fixed)' },
    { name: 'staffing-goal', takesValue: true, values: ['balanced', 'speed', 'cost'], summary: 'set: what automatic staffing optimizes for' },
    { name: 'review-policy', takesValue: true, values: ['always', 'risk', 'never'], summary: 'set: when a report is reviewed' },
    { name: 'review-merges', takesValue: true, values: ['on', 'off'], summary: 'set: pause to review each report\'s branch before it merges' },
    { name: 'max-window-share', takesValue: true, summary: 'set: percent (1-100) of the five-hour plan window one run may use, or auto (off)' },
    { name: 'connection', takesValue: true, summary: 'set: move the project to this connection and remap its role models' },
    { name: 'keep-runs', takesValue: false, summary: 'remove: keep the run records (code projects only); set: takes <n|auto>, the run records to keep' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'remove / set: do not ask for confirmation' }
  ],
  available: true
}
