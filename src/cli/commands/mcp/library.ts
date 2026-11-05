/** `orgai mcp library list | show | add | remove | set-secret | test` (cli-spec 6.3): the app-wide MCP library. */
import type { McpLibraryInfo, McpSecretKind, McpTestResult } from '../../../shared/types'
import { parseFlags } from '../../flags'
import { confirm, hostCall, readSecretValue, runSubcommands, withHost } from '../../manage'
import { emit, safeLine, styleFor, table, termWidth } from '../../output'
import { CliError, EXIT, type CliContext } from '../../types'
import { CONFIGURE, DEFINITION_FLAGS, OPERATE, READ, TEST_TIMEOUT_MS, authText, authWord, definitionLines, findLibrary, listLibrary, newLibraryEntry, noMore, notePlainValues, targetText, testLines } from './common'

const usage = (m: string): CliError => new CliError(m, EXIT.usage)

export const LIBRARY_USAGE = 'mcp library list | show <id-or-name> | add <name> (--command <cmd> | --url <url>) [--per-project-secrets] | remove <id-or-name> [--yes] | set-secret <id-or-name> <NAME> (--from-env <VAR> | --stdin | --clear) [--header] | test <id-or-name>'

export function libraryJson(l: McpLibraryInfo): Record<string, unknown> {
  return {
    id: l.entry.id,
    name: l.entry.name,
    transport: l.entry.transport,
    entry: l.entry,
    envSet: l.envSet,
    headersSet: l.headersSet,
    missingSecrets: l.missingSecrets,
    auth: l.auth,
    usedBy: l.usedBy,
    ...(l.projectSecrets ? { projectSecrets: l.projectSecrets } : {})
  }
}

async function libList(ctx: CliContext, args: string[]): Promise<number> {
  noMore(parseFlags(args, {}).positionals)
  return withHost(ctx, [...READ], async (client) => {
    const list = await listLibrary(client)
    emit(ctx, { entries: list.map(libraryJson) }, () => {
      if (list.length === 0) return ['Your MCP library is empty. Add a server with `orgai mcp library add` or a service with `orgai mcp connectors add`.']
      return table(
        [{ header: 'NAME', min: 6 }, { header: 'ID', min: 6 }, { header: 'TRANSPORT', min: 5 }, { header: 'AUTH', min: 4 }, { header: 'MISSING SECRETS', min: 6 }, { header: 'USED BY', min: 4 }, { header: 'TARGET', flex: true, min: 8, ellipsis: 'middle' }],
        list.map((l) => [
          safeLine(l.entry.name),
          safeLine(l.entry.id),
          safeLine(l.entry.transport),
          authWord(l.auth),
          l.missingSecrets.length ? l.missingSecrets.map(safeLine).join(', ') : '-',
          String(l.usedBy.length),
          targetText(l.entry)
        ]),
        termWidth(ctx),
        styleFor(ctx)
      )
    })
    return EXIT.ok
  })
}

async function libShow(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, {})
  if (!positionals[0]) throw usage('Usage: orgai mcp library show <id-or-name>')
  noMore(positionals, 1)
  return withHost(ctx, [...READ], async (client) => {
    const l = await findLibrary(client, positionals[0])
    emit(ctx, { entry: libraryJson(l) }, () => {
      const lines = [`${safeLine(l.entry.name)}  (${safeLine(l.entry.id)})`, ...definitionLines(l.entry, l), `Auth:         ${authText(l.auth)}`]
      if (l.entry.connectorId) lines.push(`Connector:    ${safeLine(l.entry.connectorId)}${l.entry.connectorVariant ? ` (${safeLine(l.entry.connectorVariant)})` : ''}`)
      if (l.entry.perProjectSecrets) lines.push('Secrets:      per project (each linking project sets its own values)')
      if (l.missingSecrets.length) lines.push(`Missing:      ${l.missingSecrets.map(safeLine).join(', ')}`)
      lines.push(`Used by:      ${l.usedBy.length ? l.usedBy.map((u) => safeLine(u.projectName)).join(', ') : 'no project'}`)
      for (const p of l.projectSecrets ?? []) if (p.missingSecrets.length) lines.push(`  ${safeLine(p.projectName)} still needs ${p.missingSecrets.map(safeLine).join(', ')}`)
      return lines
    })
    return EXIT.ok
  })
}

async function libAdd(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { ...DEFINITION_FLAGS, 'per-project-secrets': { type: 'boolean' } })
  if (!positionals[0]) throw usage('Usage: orgai mcp library add <name> (--command <cmd> [--arg <a>]... | --url <url>) [options]')
  noMore(positionals, 1)
  const entry = newLibraryEntry(positionals[0], values, !!values['per-project-secrets'])
  notePlainValues(ctx, values)
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const list = await hostCall<McpLibraryInfo[]>(client, 'mcpLibrary:upsert', [entry])
    const saved = (Array.isArray(list) ? list : []).find((l) => l.entry.id === entry.id)
    emit(ctx, { ...(saved ? { entry: libraryJson(saved) } : { id: entry.id }) }, () => {
      const lines = [`Added ${safeLine(entry.name)} to your MCP library (${safeLine(entry.id)}). Link it to a project with \`orgai mcp link ${safeLine(entry.name)}\`.`]
      if (saved?.missingSecrets.length) lines.push(`Set ${saved.missingSecrets.map(safeLine).join(', ')} with \`orgai mcp library set-secret ${safeLine(entry.name)} <NAME> --from-env <VAR>\` (or --stdin).`)
      return lines
    })
    return EXIT.ok
  })
}

async function libRemove(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  if (!positionals[0]) throw usage('Usage: orgai mcp library remove <id-or-name> [--yes]')
  noMore(positionals, 1)
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const l = await findLibrary(client, positionals[0])
    const used = l.usedBy.length ? ` It is unlinked from ${l.usedBy.length} project${l.usedBy.length === 1 ? '' : 's'}.` : ''
    if (!(await confirm(ctx, `Remove ${safeLine(l.entry.name)} and its stored secrets from your MCP library?${used}`, !!values.yes))) {
      emit(ctx, { removed: false }, () => 'Nothing removed.')
      return EXIT.failure
    }
    await hostCall(client, 'mcpLibrary:remove', [{ libraryId: l.entry.id }])
    emit(ctx, { removed: true, id: l.entry.id }, () => `Removed ${safeLine(l.entry.name)} from your MCP library.`)
    return EXIT.ok
  })
}

async function libSetSecret(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { 'from-env': { type: 'string' }, stdin: { type: 'boolean' }, clear: { type: 'boolean' }, header: { type: 'boolean' } })
  const [ref, name] = positionals
  if (!ref || !name) throw usage('Usage: orgai mcp library set-secret <id-or-name> <NAME> (--from-env <VAR> | --stdin | --clear) [--header]')
  noMore(positionals, 2)
  if (values.clear && (values['from-env'] !== undefined || values.stdin)) throw usage('--clear takes no value; drop --from-env / --stdin.')
  // Read (and taken out of the environment) before withHost may start a host, which would inherit it (review M13).
  const value = values.clear ? null : await readSecretValue(ctx, { fromEnv: values['from-env'], stdin: values.stdin, what: `the value of ${safeLine(name)}` })
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const l = await findLibrary(client, ref)
    const kind: McpSecretKind = values.header || (!(l.entry.secretEnv ?? []).includes(name) && (l.entry.secretHeaders ?? []).includes(name)) ? 'header' : 'env'
    await hostCall(client, 'mcpLibrary:setSecret', [{ libraryId: l.entry.id, kind, name, value }])
    emit(ctx, { id: l.entry.id, kind, name, set: value !== null }, () => (value === null ? `Cleared ${safeLine(name)} of ${safeLine(l.entry.name)}.` : `Saved ${safeLine(name)} for ${safeLine(l.entry.name)}.`))
    return EXIT.ok
  })
}

async function libTest(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, {})
  if (!positionals[0]) throw usage('Usage: orgai mcp library test <id-or-name>')
  noMore(positionals, 1)
  return withHost(ctx, [...OPERATE], async (client) => {
    const l = await findLibrary(client, positionals[0])
    const r = await hostCall<McpTestResult>(client, 'mcpLibrary:test', [{ libraryId: l.entry.id }], { timeoutMs: TEST_TIMEOUT_MS })
    const out = testLines(l.entry.name, r, `orgai mcp auth --library ${safeLine(l.entry.name)}`)
    emit(ctx, { id: l.entry.id, name: l.entry.name, result: r }, () => out.lines)
    return out.code
  })
}

export function mcpLibrary(ctx: CliContext, args: string[]): Promise<number> {
  return runSubcommands(ctx, args, { list: libList, show: libShow, add: libAdd, remove: libRemove, 'set-secret': libSetSecret, test: libTest }, LIBRARY_USAGE)
}
