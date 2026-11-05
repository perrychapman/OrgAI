/** `orgai knowledge` (cli-spec 6.3, Wave 5). Pure data: what help, routing and completions read. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'knowledge',
  summary: "An engagement's knowledge graph: list, search, record, link, retire",
  usage:
    'knowledge list [--kind <k>] [--retired] [--origin user|agent] | search <query> [--limit <n>] | show <item> | upsert --kind <k> --name <n> [--alias <a>]... [--summary <s>] [--fact <text>]... [--if-updated-at <ms>] | link <a> <relation> <b> [--note <text>] | unlink <edge-id | a relation b> | retire <item> | restore <item> | remove <item> [--yes] | clear [--yes]',
  subcommands: ['list', 'search', 'show', 'upsert', 'link', 'unlink', 'retire', 'restore', 'remove', 'clear'],
  flags: [
    { name: 'kind', takesValue: true, summary: 'The item kind (person, organisation, system, decision, ...)' },
    { name: 'retired', takesValue: false, summary: 'list / search: include retired items' },
    { name: 'origin', takesValue: true, values: ['user', 'agent'], summary: 'list: only items you or agents recorded' },
    { name: 'limit', short: 'n', takesValue: true, summary: 'search: at most this many hits' },
    { name: 'name', takesValue: true, summary: 'upsert: the item name' },
    { name: 'alias', takesValue: true, summary: 'upsert: another name (repeatable)' },
    { name: 'summary', takesValue: true, summary: 'upsert: the summary' },
    { name: 'fact', takesValue: true, summary: 'upsert: a fact to append (repeatable)' },
    { name: 'if-updated-at', takesValue: true, summary: 'upsert: only if the item is still at this revision' },
    { name: 'note', takesValue: true, summary: 'link: a note on the relation' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'Confirm without asking' }
  ],
  available: true
}
