/** `orgai mcp` (cli-spec 6.3, Wave 5). Pure data: help, routing and completion read it. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'mcp',
  summary: 'MCP servers and connectors',
  usage:
    'mcp list | show <server> | add <name> (--command <cmd> [--arg <a>]... | --url <url>) | remove <server> | enable <server> | disable <server> | set-secret <server> <NAME> (--from-env <VAR> | --stdin | --clear) | test <server> | link <library-entry> | promote <server> | copy <server> | overrides <server> [--env|--header NAME=VALUE]... [--unset NAME]... [--clear] | auth <server> | --library <id> | revoke <server> | search <query> | library <list|show|add|remove|set-secret|test> | connectors <list|add|set-token> | presets <list|add|remove> | assist ["<goal>"] [--build] [--library]',
  subcommands: ['list', 'show', 'add', 'remove', 'enable', 'disable', 'set-secret', 'test', 'link', 'promote', 'copy', 'overrides', 'auth', 'revoke', 'search', 'library', 'connectors', 'presets', 'assist'],
  flags: [
    { name: 'command', takesValue: true, summary: 'add: the program a stdio server runs' },
    { name: 'arg', takesValue: true, summary: 'add: one argument of --command (repeatable)' },
    { name: 'url', takesValue: true, summary: 'add: the URL of a remote server' },
    { name: 'transport', takesValue: true, values: ['stdio', 'http', 'sse'], summary: 'add: http (default with --url) or sse' },
    { name: 'env', takesValue: true, summary: 'add / overrides: a non-secret NAME=VALUE environment variable (repeatable)' },
    { name: 'secret-var', takesValue: true, summary: 'add: the NAME of a secret environment variable; set its value with set-secret (repeatable)' },
    { name: 'header', takesValue: true, summary: 'add / overrides: a non-secret NAME=VALUE header (repeatable); set-secret: the name is a header' },
    { name: 'secret-header', takesValue: true, summary: 'add: the NAME of a secret header; set its value with set-secret (repeatable)' },
    { name: 'description', takesValue: true, summary: 'add: a one-line description' },
    { name: 'disabled', takesValue: false, summary: 'add / link: keep it off until enabled' },
    { name: 'per-project-secrets', takesValue: false, summary: 'library add: each linking project keeps its own secret values' },
    { name: 'from-env', takesValue: true, summary: 'set-secret / set-token: read the value from this environment variable' },
    { name: 'stdin', takesValue: false, summary: 'set-secret / set-token: read the value from stdin' },
    { name: 'clear', takesValue: false, summary: 'set-secret / set-token / overrides: delete the stored value' },
    { name: 'unset', takesValue: true, summary: 'overrides: remove this one per-project value (repeatable)' },
    { name: 'yes', short: 'y', takesValue: false, summary: 'remove / revoke: do not ask for confirmation' },
    { name: 'role', takesValue: true, summary: 'link: a role slug allowed to use it (repeatable; default every role)' },
    { name: 'copy-secrets', takesValue: false, summary: "copy: also copy the library entry's secret values" },
    { name: 'library', takesValue: true, summary: 'auth / revoke: a library entry instead of a project server; assist: the app-wide assistant' },
    { name: 'client-id', takesValue: true, summary: 'auth: your own OAuth client id' },
    { name: 'client-secret-from-env', takesValue: true, summary: 'auth: read the OAuth client secret from this environment variable' },
    { name: 'client-secret-stdin', takesValue: false, summary: 'auth: read the OAuth client secret from stdin' },
    { name: 'no-browser', takesValue: false, summary: 'auth: print the sign-in URL instead of opening a browser (default over SSH)' },
    { name: 'browser', takesValue: false, summary: 'auth: open a browser even in an SSH session' },
    { name: 'limit', short: 'n', takesValue: true, summary: 'search: at most this many results' },
    { name: 'cursor', takesValue: true, summary: 'search: the next page (from an earlier search)' },
    { name: 'filter', takesValue: true, summary: 'connectors list: only services matching this word' },
    { name: 'variant', takesValue: true, summary: 'connectors add: the access variant (e.g. readonly)' },
    { name: 'file', takesValue: true, summary: 'presets add: the preset JSON file, or - for stdin' },
    { name: 'build', takesValue: false, summary: 'assist: let the assistant build a local server in its workspace' },
    { name: 'inline', takesValue: false, summary: 'assist: draw in the normal scrollback' },
    { name: 'ax-screen-reader', takesValue: false, summary: 'assist: screen reader mode' }
  ],
  available: true
}
