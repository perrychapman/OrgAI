/**
 * `orgai mcp` (cli-spec 6.3, Wave 5): the router. Project servers (mcp/servers.ts), OAuth sign-in (mcp/auth.ts), the
 * app-wide library (mcp/library.ts), connectors, presets and the registry (mcp/connectors.ts), and `mcp assist`, which
 * hands the terminal to an MCP assistant session (cli-spec 6.3(2), runInteractiveRun).
 */
import type { McpAssistInput } from '../../shared/types'
import { parseFlags } from '../flags'
import { runSubcommands } from '../manage'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'
import { runInteractiveRun } from './interactive'
import { mcpAuth, mcpRevoke } from './mcp/auth'
import { mcpConnectors, mcpPresets, mcpSearch } from './mcp/connectors'
import { mcpLibrary } from './mcp/library'
import { mcpAdd, mcpCopy, mcpDisable, mcpEnable, mcpLink, mcpList, mcpOverrides, mcpPromote, mcpRemove, mcpSetSecret, mcpShow, mcpTest } from './mcp/servers'

/** Swappable in tests. */
export const mcpDeps = { runInteractiveRun }

export const MCP_USAGE = 'mcp list | show | add | remove | enable | disable | set-secret | test | link | promote | copy | overrides | auth | revoke | search | library | connectors | presets | assist'

export const ASSIST_NO_TTY =
  '`orgai mcp assist` needs a terminal. Without one, add servers with `orgai mcp add`, `orgai mcp connectors add` or `orgai mcp search`, or use the MCP assistant in the OrgAI app.'

/**
 * The McpAssistInput of `mcp assist`: library scope (app-wide, may build with --build) unless --project is given or the
 * current folder is a project and neither --library nor --build asks for the library; --build with --project is exit 2.
 */
export async function assistInput(ctx: CliContext, goal: string | undefined, opts: { build: boolean; library: boolean }): Promise<McpAssistInput> {
  const instruction = goal && goal.trim() ? { instruction: goal } : {}
  if (opts.library && ctx.globals.project) throw new CliError('Give --library or --project, not both.', EXIT.usage)
  if (opts.build && ctx.globals.project) throw new CliError('--build works in the app-wide MCP assistant only (a scratch workspace in OrgAI\'s data folder); drop --project.', EXIT.usage)
  if (opts.library || opts.build) return { scope: 'library', ...instruction, ...(opts.build ? { allowBuild: true } : {}) }
  // The project from --project or the current folder, read without a host (the session opens its own connection).
  const snap = await ctx.readStore()
  const res = ctx.resolveProject(snap.projects)
  if (ctx.globals.project && (res.error || !res.project)) throw new CliError(res.error ?? `No project matches --project ${ctx.globals.project}.`, EXIT.usage)
  if (res.project) return { scope: 'project', projectId: res.project.id, ...instruction }
  return { scope: 'library', ...instruction }
}

async function mcpAssist(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    build: { type: 'boolean' },
    library: { type: 'boolean' },
    inline: { type: 'boolean' },
    'ax-screen-reader': { type: 'boolean' }
  })
  const goal = positionals.length ? positionals.join(' ') : undefined
  const input = await assistInput(ctx, goal, { build: !!values.build, library: !!values.library })
  return mcpDeps.runInteractiveRun(
    ctx,
    { channel: 'mcp:startAssist', input, label: 'MCP assistant', noTtyMessage: ASSIST_NO_TTY },
    { ...(values.inline ? { inline: true } : {}), ...(values['ax-screen-reader'] ? { screenReader: true } : {}) }
  )
}

export const runMcp: CommandFn = async (ctx, args) =>
  runSubcommands(
    ctx,
    args,
    {
      list: mcpList,
      show: mcpShow,
      add: mcpAdd,
      remove: mcpRemove,
      enable: mcpEnable,
      disable: mcpDisable,
      'set-secret': mcpSetSecret,
      test: mcpTest,
      link: mcpLink,
      promote: mcpPromote,
      copy: mcpCopy,
      overrides: mcpOverrides,
      auth: mcpAuth,
      revoke: mcpRevoke,
      search: mcpSearch,
      library: mcpLibrary,
      connectors: mcpConnectors,
      presets: mcpPresets,
      assist: mcpAssist
    },
    MCP_USAGE
  )
