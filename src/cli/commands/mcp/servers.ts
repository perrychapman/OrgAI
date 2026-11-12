/**
 * `orgai mcp list | show | add | remove | enable | disable | set-secret | test | link | promote | copy | overrides`
 * (cli-spec 6.3): the current project's MCP servers. Secrets are names only on argv; values come from --from-env or
 * --stdin (readSecretValue) and are never printed or put in JSON.
 */
import { secretEnvClashes } from '../../../shared/mcpSecretClash'
import type { McpMutationResult, McpServerInfo, McpSecretKind, McpTestResult, Project } from '../../../shared/types'
import { parseFlags } from '../../flags'
import { confirm, hostCall, readSecretValue, requireProject, withHost } from '../../manage'
import { emit, safeLine, styleFor, table, termWidth } from '../../output'
import { CliError, EXIT, type CliContext } from '../../types'
import {
  CONFIGURE,
  DEFINITION_FLAGS,
  OPERATE,
  READ,
  TEST_TIMEOUT_MS,
  authText,
  authWord,
  definitionLines,
  findLibrary,
  findServer,
  listServers,
  newServerSpec,
  notePlainValues,
  noMore,
  parsePairs,
  refuseSecretValues,
  secretClashLine,
  targetText,
  testLines
} from './common'

const usage = (m: string): CliError => new CliError(m, EXIT.usage)

/** The JSON shape of one server (spec plus has-flags; never a secret value). */
export function serverJson(s: McpServerInfo): Record<string, unknown> {
  return {
    id: s.spec.id,
    name: s.spec.name,
    transport: s.spec.transport,
    enabled: s.spec.enabled,
    spec: s.spec,
    envSet: s.envSet,
    headersSet: s.headersSet,
    missingSecrets: s.missingSecrets,
    auth: s.auth,
    ...(s.spec.libraryId ? { libraryId: s.spec.libraryId } : {}),
    ...(s.libraryMissing ? { libraryMissing: true } : {}),
    ...(s.secretScope ? { secretScope: s.secretScope } : {}),
    ...(s.unreadableSecrets?.length ? { unreadableSecrets: s.unreadableSecrets } : {})
  }
}

function libraryCell(s: McpServerInfo): string {
  if (!s.spec.libraryId) return '-'
  return s.libraryMissing ? 'missing' : 'linked'
}

export async function mcpList(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, {})
  noMore(positionals)
  return withHost(ctx, [...READ], async (client) => {
    const project = await requireProject(ctx, client)
    const servers = await listServers(client, project.id)
    const clashes = secretEnvClashes(servers.map((s) => s.spec))
    emit(ctx, { project: { id: project.id, name: project.name }, servers: servers.map((s) => ({ ...serverJson(s), ...(clashes[s.spec.id] ? { secretClashes: clashes[s.spec.id] } : {}) })) }, () => {
      if (servers.length === 0) return [`No MCP servers in ${safeLine(project.name)}. Add one with \`orgai mcp add\` or \`orgai mcp link\`.`]
      const st = styleFor(ctx)
      const lines = table(
        [{ header: 'NAME', min: 6 }, { header: 'TRANSPORT', min: 5 }, { header: 'ENABLED', min: 3 }, { header: 'AUTH', min: 4 }, { header: 'MISSING SECRETS', min: 6 }, { header: 'LIBRARY', min: 4 }, { header: 'TARGET', flex: true, min: 8, ellipsis: 'middle' }],
        servers.map((s) => [
          safeLine(s.spec.name),
          safeLine(s.spec.transport),
          s.spec.enabled ? 'on' : 'off',
          authWord(s.auth),
          s.missingSecrets.length ? s.missingSecrets.map(safeLine).join(', ') : '-',
          libraryCell(s),
          targetText(s.spec)
        ]),
        termWidth(ctx),
        st
      )
      for (const s of servers) for (const c of clashes[s.spec.id] ?? []) lines.push(st.yellow(`${safeLine(s.spec.name)}: ${secretClashLine(c)}`))
      return lines
    })
    return EXIT.ok
  })
}

export async function mcpShow(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, {})
  if (!positionals[0]) throw usage('Usage: orgai mcp show <name-or-id>')
  noMore(positionals, 1)
  return withHost(ctx, [...READ], async (client) => {
    const project = await requireProject(ctx, client)
    const s = await findServer(client, project.id, positionals[0])
    const servers = await listServers(client, project.id)
    const clashes = secretEnvClashes(servers.map((x) => x.spec))[s.spec.id] ?? []
    emit(ctx, { project: { id: project.id, name: project.name }, server: { ...serverJson(s), ...(clashes.length ? { secretClashes: clashes } : {}) } }, () => {
      const lines = [`${safeLine(s.spec.name)}  (${safeLine(s.spec.id)})`, `Enabled:      ${s.spec.enabled ? 'yes' : 'no'}`]
      lines.push(...definitionLines(s.spec, s))
      lines.push(`Auth:         ${authText(s.auth)}`)
      if (s.missingSecrets.length) lines.push(`Missing:      ${s.missingSecrets.map(safeLine).join(', ')} (the server does not start until they are set)`)
      // Wave 7 (5.4): a value saved but unreadable on this host says why instead of "set it again".
      for (const u of s.unreadableSecrets ?? []) lines.push(`Unreadable:   ${safeLine(u.name)}: ${safeLine(u.reason)}`)
      if (s.spec.libraryId) lines.push(`Library:      ${safeLine(s.spec.libraryId)}${s.libraryMissing ? ' (the entry is gone; not passed to runs)' : ''}${s.secretScope ? `, secrets from the ${s.secretScope}` : ''}`)
      for (const [k, v] of Object.entries(s.spec.envOverrides ?? {})) lines.push(`Override:     ${safeLine(k)}=${safeLine(v)}`)
      for (const [k, v] of Object.entries(s.spec.headerOverrides ?? {})) lines.push(`Override:     ${safeLine(k)}: ${safeLine(v)}`)
      lines.push(`Roles:        ${s.spec.roles ? (s.spec.roles.length ? s.spec.roles.map(safeLine).join(', ') : 'none') : 'every role'}`)
      for (const c of clashes) lines.push(secretClashLine(c))
      return lines
    })
    return EXIT.ok
  })
}

/** Print a mutation's saved server (the one named) and return 0. */
function emitMutation(ctx: CliContext, project: Project, res: McpMutationResult, serverId: string | undefined, sentence: string): number {
  const s = serverId ? res.servers.find((x) => x.spec.id === serverId) : undefined
  emit(ctx, { project: { id: project.id, name: project.name }, ...(s ? { server: serverJson(s) } : {}), servers: res.servers.map(serverJson) }, () => {
    const lines = [sentence]
    if (s?.missingSecrets.length) lines.push(`Set ${s.missingSecrets.map(safeLine).join(', ')} with \`orgai mcp set-secret ${safeLine(s.spec.name)} <NAME> --from-env <VAR>\` (or --stdin).`)
    return lines
  })
  return EXIT.ok
}

export async function mcpAdd(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { ...DEFINITION_FLAGS, disabled: { type: 'boolean' } })
  if (!positionals[0]) throw usage('Usage: orgai mcp add <name> (--command <cmd> [--arg <a>]... | --url <url>) [options]')
  noMore(positionals, 1)
  const spec = newServerSpec(positionals[0], values, !values.disabled)
  notePlainValues(ctx, values)
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const project = await requireProject(ctx, client)
    const res = await hostCall<McpMutationResult>(client, 'mcp:upsert', [{ projectId: project.id, spec }])
    return emitMutation(ctx, project, res, spec.id, `Added ${safeLine(spec.name)} to ${safeLine(project.name)}${spec.enabled ? '' : ' (disabled)'}.`)
  })
}

export async function mcpRemove(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  if (!positionals[0]) throw usage('Usage: orgai mcp remove <server> [--yes]')
  noMore(positionals, 1)
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const project = await requireProject(ctx, client)
    const s = await findServer(client, project.id, positionals[0])
    const what = s.spec.libraryId ? 'Unlink' : 'Remove'
    if (!(await confirm(ctx, `${what} ${safeLine(s.spec.name)} from ${safeLine(project.name)}?`, !!values.yes))) {
      emit(ctx, { removed: false }, () => 'Nothing removed.')
      return EXIT.failure
    }
    const res = await hostCall<McpMutationResult>(client, 'mcp:remove', [{ projectId: project.id, serverId: s.spec.id }])
    emit(ctx, { removed: true, serverId: s.spec.id, servers: res.servers.map(serverJson) }, () => `${s.spec.libraryId ? 'Unlinked' : 'Removed'} ${safeLine(s.spec.name)}.`)
    return EXIT.ok
  })
}

function toggle(enabled: boolean) {
  return async (ctx: CliContext, args: string[]): Promise<number> => {
    const { positionals } = parseFlags(args, {})
    if (!positionals[0]) throw usage(`Usage: orgai mcp ${enabled ? 'enable' : 'disable'} <server>`)
    noMore(positionals, 1)
    return withHost(ctx, [...CONFIGURE], async (client) => {
      const project = await requireProject(ctx, client)
      const s = await findServer(client, project.id, positionals[0])
      const res = await hostCall<McpMutationResult>(client, 'mcp:upsert', [{ projectId: project.id, spec: { ...s.spec, enabled } }])
      return emitMutation(ctx, project, res, s.spec.id, `${enabled ? 'Enabled' : 'Disabled'} ${safeLine(s.spec.name)}.`)
    })
  }
}
export const mcpEnable = toggle(true)
export const mcpDisable = toggle(false)

export async function mcpSetSecret(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { 'from-env': { type: 'string' }, stdin: { type: 'boolean' }, clear: { type: 'boolean' }, header: { type: 'boolean' } })
  const [ref, name] = positionals
  if (!ref || !name) throw usage('Usage: orgai mcp set-secret <server> <NAME> (--from-env <VAR> | --stdin | --clear) [--header]')
  noMore(positionals, 2)
  if (values.clear && (values['from-env'] !== undefined || values.stdin)) throw usage('--clear takes no value; drop --from-env / --stdin.')
  // Read (and taken out of the environment) before withHost may start a host, which would inherit it (review M13).
  const value = values.clear ? null : await readSecretValue(ctx, { fromEnv: values['from-env'], stdin: values.stdin, what: `the value of ${safeLine(name)}` })
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const project = await requireProject(ctx, client)
    const s = await findServer(client, project.id, ref)
    const kind: McpSecretKind = values.header || (!(s.spec.secretEnv ?? []).includes(name) && (s.spec.secretHeaders ?? []).includes(name)) ? 'header' : 'env'
    await hostCall<McpMutationResult>(client, 'mcp:setSecret', [{ projectId: project.id, serverId: s.spec.id, kind, name, value }])
    emit(ctx, { serverId: s.spec.id, kind, name, set: value !== null }, () => (value === null ? `Cleared ${safeLine(name)} of ${safeLine(s.spec.name)}.` : `Saved ${safeLine(name)} for ${safeLine(s.spec.name)}.`))
    return EXIT.ok
  })
}

export async function mcpTest(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, {})
  if (!positionals[0]) throw usage('Usage: orgai mcp test <server>')
  noMore(positionals, 1)
  return withHost(ctx, [...OPERATE], async (client) => {
    const project = await requireProject(ctx, client)
    const s = await findServer(client, project.id, positionals[0])
    const r = await hostCall<McpTestResult>(client, 'mcp:test', [{ projectId: project.id, serverId: s.spec.id }], { timeoutMs: TEST_TIMEOUT_MS })
    const out = testLines(s.spec.name, r, `orgai mcp auth ${safeLine(s.spec.name)}`)
    emit(ctx, { serverId: s.spec.id, name: s.spec.name, result: r }, () => out.lines)
    return out.code
  })
}

export async function mcpLink(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { role: { type: 'string', multiple: true }, disabled: { type: 'boolean' } })
  if (!positionals[0]) throw usage('Usage: orgai mcp link <libraryId-or-name> [--role <slug>]... [--disabled]')
  noMore(positionals, 1)
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const project = await requireProject(ctx, client)
    const lib = await findLibrary(client, positionals[0])
    const before = new Set((await listServers(client, project.id)).map((s) => s.spec.id))
    const res = await hostCall<McpMutationResult>(client, 'mcp:linkLibrary', [
      { projectId: project.id, libraryId: lib.entry.id, ...(values.role?.length ? { roles: values.role } : {}), ...(values.disabled ? { enabled: false } : {}) }
    ])
    const added = res.servers.find((s) => !before.has(s.spec.id) && s.spec.libraryId === lib.entry.id)
    return emitMutation(ctx, project, res, added?.spec.id, `Linked ${safeLine(lib.entry.name)} from your MCP library to ${safeLine(project.name)}.`)
  })
}

/**
 * `mcp update <server> --role a,b | --no-roles | --all-roles` (cli-parity 3.3): which roles a server is available to
 * after creation (McpServerSpec.roles, as the desktop's role checklist sets it). --role takes slugs or names (comma list
 * or repeated) and must name roles of this project; --no-roles leaves it to no role (a role's own grant, Role.mcpServers,
 * still reaches it); --all-roles drops the list, so every role, present and future, may use it. Saved with mcp:upsert,
 * the call enable / disable use.
 */
export async function mcpUpdate(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { role: { type: 'string', multiple: true }, 'no-roles': { type: 'boolean' }, 'all-roles': { type: 'boolean' } })
  const use = 'Usage: orgai mcp update <server> (--role <slug>[,<slug>]... | --no-roles | --all-roles)'
  if (!positionals[0]) throw usage(use)
  noMore(positionals, 1)
  const refs = (values.role ?? []).flatMap((r) => r.split(',')).map((r) => r.trim()).filter(Boolean)
  const given = [values.role !== undefined, !!values['no-roles'], !!values['all-roles']].filter(Boolean).length
  if (given !== 1) throw usage(`Give exactly one of --role, --no-roles or --all-roles. ${use}`)
  if (values.role !== undefined && refs.length === 0) throw usage('--role needs at least one role slug; use --no-roles for none.')
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const project = await requireProject(ctx, client)
    const s = await findServer(client, project.id, positionals[0])
    let roles: string[] | undefined
    if (values['no-roles']) roles = []
    else if (values.role !== undefined) {
      roles = [
        ...new Set(
          refs.map((ref) => {
            const lower = ref.toLowerCase()
            const r = project.roles.find((x) => x.slug === ref) ?? project.roles.find((x) => x.id === ref) ?? project.roles.find((x) => x.name.trim().toLowerCase() === lower)
            if (!r) throw usage(`--role: no role "${safeLine(ref).slice(0, 60)}" in ${safeLine(project.name)}. List them with: orgai team roles`)
            return r.slug
          })
        )
      ]
    }
    const spec = { ...s.spec }
    if (roles) spec.roles = roles
    else delete spec.roles
    const res = await hostCall<McpMutationResult>(client, 'mcp:upsert', [{ projectId: project.id, spec }])
    const who = roles === undefined ? 'every role' : roles.length ? roles.map(safeLine).join(', ') : 'no role (only roles granted it directly)'
    const out = res.servers.find((x) => x.spec.id === s.spec.id)
    emit(ctx, { project: { id: project.id, name: project.name }, previousRoles: s.spec.roles ?? null, roles: out?.spec.roles ?? null, ...(out ? { server: serverJson(out) } : {}) }, () => `${safeLine(s.spec.name)} is now available to ${who}.`)
    return EXIT.ok
  })
}

export async function mcpPromote(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, {})
  if (!positionals[0]) throw usage('Usage: orgai mcp promote <server>')
  noMore(positionals, 1)
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const project = await requireProject(ctx, client)
    const s = await findServer(client, project.id, positionals[0])
    if (s.spec.libraryId) throw usage(`${safeLine(s.spec.name)} already comes from your MCP library.`)
    const res = await hostCall<McpMutationResult>(client, 'mcp:promote', [{ projectId: project.id, serverId: s.spec.id }])
    return emitMutation(ctx, project, res, s.spec.id, `Moved ${safeLine(s.spec.name)} to your MCP library; ${safeLine(project.name)} now links it.`)
  })
}

export async function mcpCopy(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { 'copy-secrets': { type: 'boolean' } })
  if (!positionals[0]) throw usage('Usage: orgai mcp copy <server> [--copy-secrets]')
  noMore(positionals, 1)
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const project = await requireProject(ctx, client)
    const s = await findServer(client, project.id, positionals[0])
    if (!s.spec.libraryId) throw usage(`${safeLine(s.spec.name)} is already a project-only server.`)
    const before = new Set((await listServers(client, project.id)).map((x) => x.spec.id))
    const res = await hostCall<McpMutationResult>(client, 'mcp:copyFromLibrary', [{ projectId: project.id, serverId: s.spec.id, copySecrets: !!values['copy-secrets'] }])
    const copy = res.servers.find((x) => !before.has(x.spec.id))
    return emitMutation(ctx, project, res, copy?.spec.id, `Replaced the link ${safeLine(s.spec.name)} with a project-only copy${values['copy-secrets'] ? ' (secrets copied)' : ''}.`)
  })
}

/**
 * `mcp overrides <server>`: show, change or clear a linked server's per-project env / header values. Given pairs are
 * merged onto the stored ones (`--unset NAME` removes one, `--clear` all), since mcp:setProjectOverrides replaces the
 * whole map. The host keeps only names the library entry lists in perProjectEnv and drops others without an error, so
 * the saved map is compared with what was sent and a dropped name is exit 1.
 */
export async function mcpOverrides(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { env: { type: 'string', multiple: true }, header: { type: 'string', multiple: true }, unset: { type: 'string', multiple: true }, clear: { type: 'boolean' } })
  if (!positionals[0]) throw usage('Usage: orgai mcp overrides <server> [--env NAME=VALUE]... [--header NAME=VALUE]... [--unset NAME]... [--clear]')
  noMore(positionals, 1)
  const env = parsePairs(values.env, 'env')
  refuseSecretValues(env, 'env')
  const headers = parsePairs(values.header, 'header')
  refuseSecretValues(headers, 'header')
  const unset = [...new Set(values.unset ?? [])]
  for (const n of unset) if (Object.hasOwn(env, n) || Object.hasOwn(headers, n)) throw usage(`${safeLine(n).slice(0, 60)} is both set and unset.`)
  const given = Object.keys(env).length + Object.keys(headers).length + unset.length > 0
  if (values.clear && given) throw usage('--clear takes no values; drop --env / --header / --unset.')
  return withHost(ctx, [...(given || values.clear ? CONFIGURE : READ)], async (client) => {
    const project = await requireProject(ctx, client)
    const s = await findServer(client, project.id, positionals[0])
    if (!s.spec.libraryId) throw usage(`${safeLine(s.spec.name)} is a project-only server; overrides are for linked library servers.`)
    const stdio = s.spec.transport === 'stdio'
    const current = stdio ? (s.spec.envOverrides ?? {}) : (s.spec.headerOverrides ?? {})
    if (!given && !values.clear) {
      emit(ctx, { serverId: s.spec.id, ...(stdio ? { env: current } : { headers: current }) }, () => {
        const entries = Object.entries(current)
        return entries.length ? entries.map(([k, v]) => `${safeLine(k)}${stdio ? '=' : ': '}${safeLine(v)}`) : [`${safeLine(s.spec.name)} has no overrides in ${safeLine(project.name)}.`]
      })
      return EXIT.ok
    }
    if (stdio && Object.keys(headers).length) throw usage(`${safeLine(s.spec.name)} is a stdio server; use --env.`)
    if (!stdio && Object.keys(env).length) throw usage(`${safeLine(s.spec.name)} is a remote server; use --header.`)
    const missing = unset.filter((n) => !Object.hasOwn(current, n))
    if (missing.length) throw usage(`${safeLine(s.spec.name)} has no override ${missing.map((n) => safeLine(n).slice(0, 60)).join(', ')} in ${safeLine(project.name)}.`)
    const sent: Record<string, string> = {}
    if (!values.clear) {
      for (const [k, v] of Object.entries(current)) if (!unset.includes(k)) sent[k] = v
      Object.assign(sent, stdio ? env : headers)
    }
    const input = { projectId: project.id, serverId: s.spec.id, ...(stdio ? { env: sent } : { headers: sent }) }
    const res = await hostCall<McpMutationResult>(client, 'mcp:setProjectOverrides', [input])
    const saved = res.servers.find((x) => x.spec.id === s.spec.id)?.spec
    const kept = (stdio ? saved?.envOverrides : saved?.headerOverrides) ?? {}
    // Only names given on this command line count: a stored name the entry no longer lists is dropped by the host too.
    const dropped = Object.keys(stdio ? env : headers).filter((k) => kept[k] !== sent[k])
    if (dropped.length) {
      throw new CliError(
        `${safeLine(s.spec.name)} does not take ${dropped.map(safeLine).join(', ')} per project (its library entry lists the names a project may override); ${dropped.length === 1 ? 'it was' : 'they were'} not saved. The other values were saved.`,
        EXIT.failure
      )
    }
    return emitMutation(ctx, project, res, s.spec.id, values.clear ? `Cleared the overrides of ${safeLine(s.spec.name)}.` : `Saved the overrides of ${safeLine(s.spec.name)}.`)
  })
}
