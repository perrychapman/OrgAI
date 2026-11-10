/**
 * `orgai team` (cli-spec 6.3, Wave 5): team templates, the role list, one role in full, and Claude Code plugins.
 *
 * - `team templates [list]` (read), `team templates save --name <n> [--description <d>]`, `team templates apply <id>
 *   [--mode replace|merge] [--yes]`, `team templates remove <id> [--yes]` (configure). An apply cannot be undone (the
 *   Desktop's Undo covers only its own applies); --json carries the previous chart as `previousRoles`.
 * - `team roles`, `team role [show] <name-or-slug>` (read): the prompt is shown with every hidden character made visible
 *   (shared/view/hiddenChars showHidden), then sanitized; the text names effort, staffing and the connection it runs on.
 * - `team role add | set | rm | move` (configure, cli-parity 3.3): role editing over projects:get + projects:save with the
 *   desktop's cleaning and the team files gate's spend rule (teamRoleEdit.ts).
 * - `team plugins [list]`, `team plugins add --path <dir> [--name] [--id] [--disabled] [--skip-mcp]`, `team plugins
 *   remove <id> [--yes]` (configure).
 * - `team files [status]` (read, cli-parity 3.4): pending team-file changes; approving is done in the desktop app for now.
 */
import { isAbsolute, resolve } from 'node:path'
import { newId } from '../../shared/defaults'
import { hasHidden, showHidden } from '../../shared/view/hiddenChars'
import type { AgentImportApplyResult, OrgTemplateInfo, PluginSpec, Project, Role, TeamFilesStatus } from '../../shared/types'
import { APPROVE_WHERE, NO_APPROVE_COMMAND, teamFilesStatusLines } from '../approvalText'
import { formatDate } from '../../shared/view/dates'
import { parseFlags } from '../flags'
import { confirm, hostCall, requireProject, runSubcommands, withHost, type SubcommandFn } from '../manage'
import { emit, note, safe, safeLine } from '../output'
import { CliError, EXIT, type CommandFn } from '../types'
import { checkArg, findRole, NO_UNDO, NO_UNDO_AFTER, onlyPositionals, projectJson, roleTierWord } from './org'
import { connectionLabels, roleAdd, roleMove, roleRemove, roleSet, roleSummaryLines } from './teamRoleEdit'

const USAGE =
  'team files [status] | team templates [list] | templates save --name <name> [--description <text>] | templates apply <id> [--mode replace|merge] [--yes] | templates remove <id> [--yes] | roles | role <name-or-slug> | role add <name> --reports-to <role> [flags] | role set <role> [flags] | role rm <role> [--reparent-to <role>] | role move <role> --reports-to <role> | plugins [list] | plugins add --path <dir> [--name <n>] [--id <id>] [--disabled] [--skip-mcp] | plugins remove <id> [--yes]'

export const runTeam: CommandFn = (ctx, args) => runSubcommands(ctx, args, { templates: teamTemplates, roles: teamRoles, role: teamRoleRouter, plugins: teamPlugins, files: teamFilesRouter }, USAGE)

// ---------- team files (cli-parity 3.4) ----------

/**
 * `team files [status]` lists the pending team-file changes (teamFiles:listAttention, read scope) with the gate's
 * summary of each. `team files approve | reject | undo | commit | enable` never decide anything: they say where a
 * person decides (the desktop app for now: a terminal cannot yet prove a person is answering) and exit 2 without starting a host,
 * whatever flags follow (--yes included).
 */
const teamFilesRouter: SubcommandFn = (ctx, args) => {
  const sub = args[0]
  if (sub === undefined || sub.startsWith('-') || sub === 'status') return teamFilesStatus(ctx, sub === 'status' ? args.slice(1) : args)
  if (['approve', 'reject', 'undo', 'commit', 'enable'].includes(sub)) throw new CliError(NO_APPROVE_COMMAND, EXIT.usage)
  throw new CliError(`Unknown subcommand 'files ${safeLine(sub).slice(0, 64)}'. Usage: orgai team files [status]`, EXIT.usage)
}

const teamFilesStatus: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 0, 'team files status')
  return withHost(ctx, ['read'], async (client) => {
    let list = await hostCall<TeamFilesStatus[]>(client, 'teamFiles:listAttention', [])
    list = Array.isArray(list) ? list : []
    let scope = ''
    if (ctx.globals.project !== undefined) {
      const project = await requireProject(ctx, client)
      list = list.filter((s) => s.projectId === project.id)
      scope = ` in ${safeLine(project.name)}`
    }
    emit(ctx, { teamFiles: list, approve: APPROVE_WHERE }, () =>
      list.length ? [...list.flatMap((s, i) => [...(i ? [''] : []), ...teamFilesStatusLines(s)]), '', APPROVE_WHERE] : `No team-file changes wait for approval${scope}.`
    )
    return EXIT.ok
  })
}

/** `team role <x>` shows a role; `team role add|set|rm|move|show` edit or show (a role named "set" is `team role show set`). */
const ROLE_ACTIONS: Record<string, SubcommandFn> = { add: roleAdd, set: roleSet, rm: roleRemove, remove: roleRemove, move: roleMove, show: (ctx, args) => teamRole(ctx, args) }
const teamRoleRouter: SubcommandFn = (ctx, args) => {
  const action = args[0] !== undefined && Object.hasOwn(ROLE_ACTIONS, args[0]) ? ROLE_ACTIONS[args[0]] : undefined
  return action ? action(ctx, args.slice(1)) : teamRole(ctx, args)
}

/** A safe one-line string with hidden characters shown as \uXXXX escapes. */
const visible = (s: unknown): string => safeLine(showHidden(String(s ?? '')))

// ---------- templates ----------

const teamTemplates: SubcommandFn = (ctx, args) => {
  if (args.length === 0 || args[0].startsWith('-')) return templatesList(ctx, args)
  return runSubcommands(ctx, args, { list: templatesList, save: templatesSave, apply: templatesApply, remove: templatesRemove }, 'team templates [list] | save | apply <id> | remove <id>')
}

function templateLine(t: OrgTemplateInfo): string {
  const desc = t.description ? ` · ${safeLine(t.description)}` : ''
  return `  ${t.id}  ${safeLine(t.name)} (${t.kind}, ${t.roleCount} role${t.roleCount === 1 ? '' : 's'}, ${formatDate(t.updatedAt)})${desc}`
}

const templatesList: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 0, 'team templates list')
  return withHost(ctx, ['read'], async (client) => {
    const list = await hostCall<OrgTemplateInfo[]>(client, 'templates:list', [])
    emit(ctx, { templates: list }, () => (list.length ? [`${list.length} template${list.length === 1 ? '' : 's'}:`, ...list.map(templateLine)] : 'No team templates yet. Save one with: orgai team templates save --name <name>'))
    return EXIT.ok
  })
}

const templatesSave: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { name: { type: 'string' }, description: { type: 'string' } })
  onlyPositionals(positionals, 0, 'team templates save --name <name> [--description <text>]')
  const name = checkArg('template name (--name)', values.name).trim()
  const description = values.description?.trim()
  if (description !== undefined && description.length > 1000) throw new CliError('The description is longer than 1000 characters.', EXIT.usage)
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const t = await hostCall<OrgTemplateInfo>(client, 'templates:saveFromProject', [{ projectId: project.id, name, ...(description ? { description } : {}) }])
    emit(ctx, { project: projectJson(project), template: t }, () => `Saved template ${safeLine(t.name)} (${t.id}) with ${t.roleCount} role${t.roleCount === 1 ? '' : 's'}.`)
    return EXIT.ok
  })
}

const templatesApply: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { mode: { type: 'string' }, yes: { type: 'boolean', short: 'y' } })
  onlyPositionals(positionals, 1, 'team templates apply <id> [--mode replace|merge] [--yes]')
  const templateId = checkArg('template id', positionals[0])
  const mode = values.mode ?? 'replace'
  if (mode !== 'replace' && mode !== 'merge') throw new CliError('--mode must be replace or merge.', EXIT.usage)
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const list = await hostCall<OrgTemplateInfo[]>(client, 'templates:list', [])
    const t = list.find((x) => x.id === templateId)
    if (!t) throw new CliError(`No template ${safeLine(templateId)}. List them with: orgai team templates`, EXIT.usage)
    const question =
      mode === 'replace'
        ? `Replace the ${project.roles.length} role(s) of ${safeLine(project.name)} with template ${safeLine(t.name)} (${t.roleCount} role(s))? ${NO_UNDO}`
        : `Add the ${t.roleCount} role(s) of template ${safeLine(t.name)} under the root of ${safeLine(project.name)}?`
    if (!(await confirm(ctx, question, !!values.yes))) {
      note(ctx, 'Nothing changed.')
      return EXIT.failure
    }
    const res = await hostCall<AgentImportApplyResult>(client, 'templates:apply', [{ projectId: project.id, templateId, mode }])
    const previousRoles = Array.isArray(res.previousRoles) ? res.previousRoles : []
    emit(ctx, { project: projectJson(res.project), template: t, mode, roles: res.project.roles.length, previousRoles }, () => [
      `Applied template ${safeLine(t.name)} (${mode}); the chart now has ${res.project.roles.length} role${res.project.roles.length === 1 ? '' : 's'}.`,
      `${NO_UNDO_AFTER} The previous chart had ${previousRoles.length} role${previousRoles.length === 1 ? '' : 's'}.`
    ])
    return EXIT.ok
  })
}

const templatesRemove: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  onlyPositionals(positionals, 1, 'team templates remove <id> [--yes]')
  const templateId = checkArg('template id', positionals[0])
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const list = await hostCall<OrgTemplateInfo[]>(client, 'templates:list', [])
    const t = list.find((x) => x.id === templateId)
    if (!t) throw new CliError(`No template ${safeLine(templateId)}.`, EXIT.usage)
    if (!(await confirm(ctx, `Remove template ${safeLine(t.name)}?`, !!values.yes))) {
      note(ctx, 'Nothing removed.')
      return EXIT.failure
    }
    const rest = await hostCall<OrgTemplateInfo[]>(client, 'templates:remove', [templateId])
    emit(ctx, { removed: templateId, templates: rest }, () => `Removed template ${safeLine(t.name)}.`)
    return EXIT.ok
  })
}

// ---------- roles ----------

const grantCount = (r: Role): number => (r.mcpServers?.length ?? 0) + (r.skills?.length ?? 0)

const teamRoles: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 0, 'team roles')
  return withHost(ctx, ['read'], async (client) => {
    const project = await requireProject(ctx, client)
    const nameOf = new Map(project.roles.map((r) => [r.id, r.name]))
    emit(
      ctx,
      {
        project: projectJson(project),
        roles: project.roles.map((r) => ({ id: r.id, slug: r.slug, name: r.name, model: r.model, tier: r.tier ?? null, reportsTo: r.reportsTo, grants: grantCount(r) }))
      },
      () => [
        `${project.roles.length} role${project.roles.length === 1 ? '' : 's'} in ${safeLine(project.name)}:`,
        ...project.roles.map((r) => {
          const boss = r.reportsTo ? `reports to ${safeLine(nameOf.get(r.reportsTo) ?? r.reportsTo)}` : 'root'
          const g = grantCount(r)
          return `  ${safeLine(r.name)} [${safeLine(r.slug)}] · ${safeLine(roleTierWord(r))} · ${boss} · ${g} grant${g === 1 ? '' : 's'}`
        })
      ]
    )
    return EXIT.ok
  })
}

const teamRole: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 1, 'team role <name-or-slug>')
  const ref = checkArg('role name or slug', positionals[0])
  return withHost(ctx, ['read'], async (client) => {
    const project = await requireProject(ctx, client)
    const role = findRole(project.roles, ref)
    if (!role) throw new CliError(`No role "${safeLine(ref)}" in ${safeLine(project.name)}. List them with: orgai team roles`, EXIT.usage)
    const skills = new Map((project.skills ?? []).map((s) => [s.id, s.name]))
    const label = await connectionLabels(client)
    emit(ctx, { project: projectJson(project), role, promptHasHiddenCharacters: hasHidden(role.prompt) }, () => {
      const lines = [
        `${visible(role.name)} [${visible(role.slug)}]`,
        `  id: ${role.id}`,
        // model, effort, staffing (in words), runs on, reports to, spawning, required reports, tools, MCP grants.
        ...roleSummaryLines(role, project, label, visible),
        `  skills: ${role.skills?.length ? role.skills.map((id) => visible(skills.get(id) ?? id)).join(', ') : 'none'}`
      ]
      if (role.description) lines.push(`  description: ${visible(role.description)}`)
      if (role.responsibilities.length) {
        lines.push('  responsibilities:')
        for (const r of role.responsibilities) lines.push(`    - ${visible(r)}`)
      }
      if (hasHidden(role.prompt)) lines.push('  ! The prompt holds hidden characters, shown below as \\uXXXX.')
      lines.push('  prompt:')
      for (const l of safe(showHidden(role.prompt)).split('\n')) lines.push(`    ${l}`)
      return lines
    })
    return EXIT.ok
  })
}

// ---------- plugins ----------

const teamPlugins: SubcommandFn = (ctx, args) => {
  if (args.length === 0 || args[0].startsWith('-')) return pluginsList(ctx, args)
  return runSubcommands(ctx, args, { list: pluginsList, add: pluginsAdd, remove: pluginsRemove }, 'team plugins [list] | add --path <dir> | remove <id>')
}

const pluginLine = (p: PluginSpec): string =>
  `  ${p.id}  ${safeLine(p.name)} · ${safeLine(p.path)}${p.enabled ? '' : ' · disabled'}${p.skipMcpDiscovery ? ' · MCP servers not loaded' : ''}`

const pluginsList: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 0, 'team plugins list')
  return withHost(ctx, ['read'], async (client) => {
    const project = await requireProject(ctx, client)
    const list = project.plugins ?? []
    emit(ctx, { project: projectJson(project), plugins: list }, () => (list.length ? [`${list.length} plugin${list.length === 1 ? '' : 's'}:`, ...list.map(pluginLine)] : 'No plugins.'))
    return EXIT.ok
  })
}

const pluginsAdd: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, {
    path: { type: 'string' },
    name: { type: 'string' },
    id: { type: 'string' },
    disabled: { type: 'boolean' },
    'skip-mcp': { type: 'boolean' }
  })
  onlyPositionals(positionals, 1, 'team plugins add --path <dir> [--name <n>] [--id <id>] [--disabled] [--skip-mcp]')
  const raw = values.path ?? positionals[0]
  if (values.path !== undefined && positionals[0] !== undefined) throw new CliError('Give the plugin folder once (--path or as the argument).', EXIT.usage)
  const dir = checkArg('plugin folder (--path)', raw)
  const path = isAbsolute(dir) ? dir : resolve(ctx.cwd, dir)
  const id = values.id !== undefined ? checkArg('plugin id', values.id) : undefined
  if (id !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new CliError('A plugin id is letters, digits, - and _ (at most 64).', EXIT.usage)
  const name = values.name !== undefined ? checkArg('plugin name', values.name).trim() : ''
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const existing = id ? (project.plugins ?? []).find((p) => p.id === id) : undefined
    const plugin: PluginSpec = {
      id: id ?? newId('plugin'),
      name: name || existing?.name || '',
      path,
      enabled: !values.disabled,
      ...(values['skip-mcp'] ? { skipMcpDiscovery: true } : {})
    }
    const saved = await hostCall<Project>(client, 'plugins:upsert', [{ projectId: project.id, plugin }])
    const stored = (saved.plugins ?? []).find((p) => p.id === plugin.id) ?? plugin
    emit(ctx, { project: projectJson(saved), plugin: stored }, () => `${existing ? 'Updated' : 'Added'} plugin ${safeLine(stored.name)} (${stored.id}).`)
    return EXIT.ok
  })
}

const pluginsRemove: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  onlyPositionals(positionals, 1, 'team plugins remove <id> [--yes]')
  const pluginId = checkArg('plugin id', positionals[0])
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const p = (project.plugins ?? []).find((x) => x.id === pluginId)
    if (!p) throw new CliError(`No plugin ${safeLine(pluginId)} in this project.`, EXIT.usage)
    if (!(await confirm(ctx, `Remove plugin ${safeLine(p.name)}?`, !!values.yes))) {
      note(ctx, 'Nothing removed.')
      return EXIT.failure
    }
    const saved = await hostCall<Project>(client, 'plugins:remove', [{ projectId: project.id, pluginId }])
    emit(ctx, { project: projectJson(saved), removed: pluginId }, () => `Removed plugin ${safeLine(p.name)}.`)
    return EXIT.ok
  })
}
