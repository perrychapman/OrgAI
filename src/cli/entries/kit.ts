/** `orgai kit` (cli-spec 6.3(4), Wave 5). Pure data: what help, routing and completions read. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'kit',
  summary: 'Export or import a practice kit (library skills, servers, presets, templates)',
  usage:
    'kit export <file> [--skills <id,...> | --all-skills] [--servers <id,...> | --all-servers] [--presets <id,...> | --all-presets] [--templates <id,...> | --all-templates] [--all] [--force] | kit import <file> [--action add|replace|copy|skip] [--item <key>=<action>]... [--yes]',
  subcommands: ['export', 'import'],
  flags: [
    { name: 'skills', takesValue: true, summary: 'export: these library skill ids (comma-separated)' },
    { name: 'all-skills', takesValue: false, summary: 'export: every library skill' },
    { name: 'servers', takesValue: true, summary: 'export: these MCP library server ids' },
    { name: 'all-servers', takesValue: false, summary: 'export: every MCP library server' },
    { name: 'presets', takesValue: true, summary: 'export: these custom connector preset ids' },
    { name: 'all-presets', takesValue: false, summary: 'export: every custom connector preset' },
    { name: 'templates', takesValue: true, summary: 'export: these team template ids' },
    { name: 'all-templates', takesValue: false, summary: 'export: every team template' },
    { name: 'all', takesValue: false, summary: 'export: everything' },
    { name: 'force', takesValue: false, summary: 'export: replace an existing file' },
    { name: 'action', takesValue: true, values: ['add', 'replace', 'copy', 'skip'], summary: 'import: the default action' },
    { name: 'item', takesValue: true, summary: 'import: <key-or-name>=<action> for one item (repeatable)' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'import: skip the confirmation (never the digest checks)' }
  ],
  available: true
}
