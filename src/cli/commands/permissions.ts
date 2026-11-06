/**
 * `orgai permissions` (cli-spec 6.3, Wave 5): saved allow rules, the permission mode and the project's extra folders.
 *
 * - `permissions list` (read): permissions:list with ruleLabel, plus where the rules live (projectRulesLocation).
 * - `permissions add <rule>` / `remove <rule>` (configure): the host refuses too broad, invalid or blanket rules; its
 *   sentence comes back (bad_request = exit 2, other refusals exit 1).
 * - `permissions mode [<mode>]`: show, or set Project.permissionMode (projects:get + projects:save, configure).
 * - `permissions folders [list|add <dir>|remove <dir>]` (allowedDirectories) and `permissions reference [...]`
 *   (referenceDirectories): projects:save; relative folders resolve against cwd, the cleaned list is printed and
 *   every folder main dropped is named. A folder in both lists is refused here (exit 2).
 */
import { isAbsolute, resolve } from 'node:path'
import { projectRulesLocation } from '../../shared/defaults'
import { PERMISSION_MODES, PERMISSION_MODE_OPTIONS, isPermissionMode, type Project } from '../../shared/types'
import { droppedFolderNotice, droppedFolders, pathKey } from '../../shared/view/permissionCopy'
import { PERMISSION_MODE_SHORT } from '../../shared/view/settingsCopy'
import { ruleLabel } from '../../main/runtime/permissionRules'
import { parseFlags } from '../flags'
import { hostCall, requireProject, runSubcommands, withHost, type SubcommandFn } from '../manage'
import { emit, note, safeLine } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'
import { checkArg, onlyPositionals, projectJson } from './org'

/** Longest rule accepted (the host's PERMISSION_RULE_MAX_CHARS). */
export const RULE_MAX_CHARS = 1000

const USAGE =
  'permissions list | add <rule> | remove <rule> | mode [<mode>] | folders [list|add <dir>|remove <dir>] | reference [list|add <dir>|remove <dir>]'

export const runPermissions: CommandFn = (ctx, args) =>
  runSubcommands(ctx, args, { list: permList, add: permAdd, remove: permRemove, mode: permMode, folders: folderCmd('allowed'), reference: folderCmd('reference') }, USAGE)

/** A rule argument: non-empty, at most RULE_MAX_CHARS, no control characters. */
export function checkRule(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') throw new CliError('Missing rule, e.g. orgai permissions add "Bash(npm test:*)".', EXIT.usage)
  if (raw.length > RULE_MAX_CHARS) throw new CliError(`The rule is longer than ${RULE_MAX_CHARS} characters.`, EXIT.usage)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) throw new CliError('The rule holds control characters.', EXIT.usage)
  return raw.trim()
}

function whereRules(project: Project): { location: 'folder' | 'app'; text: string } {
  const location = projectRulesLocation(project)
  return {
    location,
    text:
      location === 'folder'
        ? `Rules are saved in ${safeLine(project.path)}/.claude/settings.local.json.`
        : project.folderConfigTrust !== undefined
          ? "Rules are saved in OrgAI's data folder (this project's folder configuration is gated, so OrgAI writes nothing into the folder)."
          : "Rules are saved in OrgAI's data folder (engagements write nothing into their folder)."
  }
}

const ruleRow = (r: string): string => {
  const label = ruleLabel(r)
  return label === r ? `  ${safeLine(r)}` : `  ${safeLine(r)}  (${safeLine(label)})`
}

const permList: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 0, 'permissions list')
  return withHost(ctx, ['read'], async (client) => {
    const project = await requireProject(ctx, client)
    const rules = await hostCall<string[]>(client, 'permissions:list', [project.id])
    const where = whereRules(project)
    emit(ctx, { project: projectJson(project), location: where.location, rules: rules.map((r) => ({ rule: r, label: ruleLabel(r) })) }, () => [
      rules.length ? `${rules.length} saved rule${rules.length === 1 ? '' : 's'}:` : 'No saved rules.',
      ...rules.map(ruleRow),
      where.text
    ])
    return EXIT.ok
  })
}

function ruleChange(verb: 'add' | 'remove'): SubcommandFn {
  return async (ctx, args) => {
    const { positionals } = parseFlags(args, {})
    onlyPositionals(positionals, 1, `permissions ${verb} <rule>`)
    const rule = checkRule(positionals[0])
    return withHost(ctx, ['read', 'configure'], async (client) => {
      const project = await requireProject(ctx, client)
      if (verb === 'remove') {
        const current = await hostCall<string[]>(client, 'permissions:list', [project.id])
        if (!current.includes(rule)) throw new CliError(`No saved rule ${safeLine(rule)}. List them with: orgai permissions list`, EXIT.usage)
      }
      const rules = await hostCall<string[]>(client, verb === 'add' ? 'permissions:add' : 'permissions:remove', [{ projectId: project.id, rule }])
      emit(ctx, { project: projectJson(project), [verb === 'add' ? 'added' : 'removed']: rule, rules }, () => [
        `${verb === 'add' ? 'Saved' : 'Removed'} ${safeLine(rule)}${ruleLabel(rule) !== rule ? ` (${safeLine(ruleLabel(rule))})` : ''}.`,
        whereRules(project).text
      ])
      return EXIT.ok
    })
  }
}

const permAdd = ruleChange('add')
const permRemove = ruleChange('remove')

const modeLine = (m: string): string => {
  const short = isPermissionMode(m) ? PERMISSION_MODE_SHORT[m] : m
  return `${m} (${short})`
}

const permMode: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 1, 'permissions mode [<mode>]')
  const wanted = positionals[0]
  if (wanted !== undefined && !isPermissionMode(wanted)) {
    throw new CliError(`Unknown permission mode "${safeLine(wanted).slice(0, 40)}". Modes: ${PERMISSION_MODES.join(', ')}.`, EXIT.usage)
  }
  return withHost(ctx, wanted === undefined ? ['read'] : ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    if (wanted === undefined) {
      emit(ctx, { project: projectJson(project), mode: project.permissionMode, modes: PERMISSION_MODES }, () => [
        `Permission mode: ${modeLine(project.permissionMode)}`,
        'Modes:',
        ...PERMISSION_MODE_OPTIONS.map((o) => `  ${o.value.padEnd(18)} ${o.label}`)
      ])
      return EXIT.ok
    }
    const fresh = (await hostCall<Project | null>(client, 'projects:get', [project.id])) ?? project
    const saved = await hostCall<Project>(client, 'projects:save', [{ ...fresh, permissionMode: wanted }])
    emit(ctx, { project: projectJson(saved), mode: saved.permissionMode, previous: fresh.permissionMode }, () => `Permission mode: ${modeLine(saved.permissionMode)}`)
    return EXIT.ok
  })
}

// ---------- folders ----------

type FolderKind = 'allowed' | 'reference'
const FIELD = { allowed: 'allowedDirectories', reference: 'referenceDirectories' } as const
const TITLE = { allowed: 'Allowed folders (agents may read and edit)', reference: 'Reference folders (read only)' }

function resolveDir(ctx: CliContext, raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') throw new CliError('Missing folder.', EXIT.usage)
  if (raw.length > 1024) throw new CliError('The folder path is longer than 1024 characters.', EXIT.usage)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) throw new CliError('The folder path holds control characters.', EXIT.usage)
  const dir = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw)
  return dir.length > 1 ? dir.replace(/[\\/]+$/, '') || dir : dir
}

function folderCmd(kind: FolderKind): SubcommandFn {
  const field = FIELD[kind]
  const other = FIELD[kind === 'allowed' ? 'reference' : 'allowed']
  const name = kind === 'allowed' ? 'folders' : 'reference'
  return async (ctx, args) => {
    const { positionals } = parseFlags(args, {})
    const [verb = 'list', target] = positionals
    if (verb !== 'list' && verb !== 'add' && verb !== 'remove') throw new CliError(`Unknown subcommand '${safeLine(verb).slice(0, 40)}'. Usage: orgai permissions ${name} [list|add <dir>|remove <dir>]`, EXIT.usage)
    onlyPositionals(positionals, verb === 'list' ? 1 : 2, `permissions ${name} [list|add <dir>|remove <dir>]`)
    const dir = verb === 'list' ? undefined : resolveDir(ctx, checkArgLoose(target))
    return withHost(ctx, verb === 'list' ? ['read'] : ['read', 'configure'], async (client) => {
      const project = await requireProject(ctx, client)
      const current = project[field] ?? []
      if (verb === 'list' || dir === undefined) {
        emit(ctx, { project: projectJson(project), kind, folders: current }, () => [`${TITLE[kind]}:`, ...(current.length ? current.map((d) => `  ${safeLine(d)}`) : ['  none'])])
        return EXIT.ok
      }
      const key = pathKey(dir)
      let next: string[]
      if (verb === 'add') {
        if ((project[other] ?? []).some((d) => pathKey(d) === key)) {
          throw new CliError(`${safeLine(dir)} is already a${kind === 'allowed' ? ' reference' : 'n allowed'} folder; a folder can be in only one list. Remove it there first.`, EXIT.usage)
        }
        if (current.some((d) => pathKey(d) === key)) {
          note(ctx, `${safeLine(dir)} is already listed.`)
          next = current
        } else next = [...current, dir]
      } else {
        if (!current.some((d) => pathKey(d) === key)) throw new CliError(`${safeLine(dir)} is not in the list.`, EXIT.usage)
        next = current.filter((d) => pathKey(d) !== key)
      }
      const fresh = (await hostCall<Project | null>(client, 'projects:get', [project.id])) ?? project
      const saved = await hostCall<Project>(client, 'projects:save', [{ ...fresh, [field]: next }])
      const list = saved[field] ?? []
      const dropped = droppedFolders(next, list)
      emit(ctx, { project: projectJson(saved), kind, folders: list, dropped }, () => [
        `${TITLE[kind]}:`,
        ...(list.length ? list.map((d) => `  ${safeLine(d)}`) : ['  none']),
        ...dropped.map((d) => droppedFolderNotice(safeLine(d)))
      ])
      return dropped.includes(dir) ? EXIT.failure : EXIT.ok
    })
  }
}

/** checkArg without its 200-character limit (folders may be up to 1024). */
function checkArgLoose(v: string | undefined): string {
  if (v !== undefined && v.length > 200) return v
  return checkArg('folder', v)
}
