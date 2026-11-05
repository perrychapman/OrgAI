/** `orgai mcp` (cli-spec 6.3, Wave 5). Pure data; the owning Wave 5 task fills in flags and sets `available`. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'mcp',
  summary: 'MCP servers and connectors',
  usage: 'mcp <subcommand> [options]',
  subcommands: ['list', 'show', 'add', 'remove', 'enable', 'disable', 'set-secret', 'test', 'link', 'promote', 'copy', 'overrides', 'auth', 'revoke', 'search', 'library', 'connectors', 'presets', 'assist'],
  flags: [],
  available: false
}
