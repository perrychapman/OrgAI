/** `orgai org` (cli-spec 6.3, Wave 5): the org chart and the Team assistant. Pure data. */
import { AGENT_IMPORT_SOURCES } from '../../shared/types'
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'org',
  summary: 'Org chart and Team assistant',
  usage:
    'org show | export | import [--source <id>...] [--mode merge|replace] [--yes] | retro <runRef> | draft "<description>" [--mode replace|revise] | discover [--outside] | recommend [--outside] [--role <role>] | review [--recheck [--outside] [--model]] | apply <recommendationId> [--candidate <id>] [--role <role>...] [--access read|full] | undo <undoId> | dismiss <id> [--candidate] | restore <candidateId>',
  subcommands: ['show', 'import', 'export', 'retro', 'draft', 'discover', 'recommend', 'review', 'apply', 'undo', 'dismiss', 'restore'],
  flags: [
    { name: 'source', takesValue: true, values: AGENT_IMPORT_SOURCES, summary: 'import: only this source (repeatable; default every source found)' },
    { name: 'mode', takesValue: true, values: ['merge', 'replace', 'revise'], summary: 'import: merge (default) or replace the chart; draft: revise (default) or replace' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'Confirm without asking' },
    { name: 'inline', takesValue: false, summary: 'retro: draw the terminal UI in the normal scrollback' },
    { name: 'ax-screen-reader', takesValue: false, summary: 'retro: screen reader mode' },
    { name: 'outside', takesValue: false, summary: 'discover / recommend / review --recheck: also search outside sources (network)' },
    { name: 'query', takesValue: true, summary: 'discover: extra registry search words' },
    { name: 'role', takesValue: true, summary: 'recommend: one role; apply: the roles that get it (repeatable)' },
    { name: 'recheck', takesValue: false, summary: 'review: run a manual re-check now' },
    { name: 'model', takesValue: false, summary: 'review --recheck: also run the recommendation model step' },
    { name: 'candidate', takesValue: true, summary: 'apply: the candidate id; dismiss: the id is a candidate id (no value)' },
    { name: 'access', takesValue: true, values: ['read', 'full'], summary: 'apply: read or full access (default: the recommendation’s)' }
  ],
  available: true
}
