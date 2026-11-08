/**
 * `orgai skills` (cli-spec 6.3, Wave 5): project skills, the repo import, the skill evaluation, the global skill
 * library (with `library add <folder>` through the host-validated skillLibrary:addFromBundle, cli-spec 3.6 item 1) and
 * the Skill assistant (`skills assist`, cli-spec 6.3(2), through runInteractiveRun).
 *
 * Every untrusted string (skill names, descriptions, SKILL.md text, file paths, host messages) is sanitized before it
 * reaches the terminal; JSON goes through emit. Scopes: reads 'read'; evaluate 'read' + 'operate'; changes 'read' +
 * 'configure'. Exit codes: 2 usage, 1 failures / refusals / a stale import preview / a declined confirmation.
 */
import { readFile } from 'node:fs/promises'
import {
  SKILL_BODY_MAX_CHARS,
  type HostScope,
  type Project,
  type Role,
  type SkillAssistInput,
  type SkillContent,
  type SkillCreateInput,
  type SkillDraft,
  type SkillEvaluationReport,
  type SkillImportApplyResult,
  type SkillImportChoice,
  type SkillImportItem,
  type SkillImportPreview,
  type SkillInfo,
  type SkillLibraryInfo,
  type SkillMutationResult,
  type SkillUpdateInput
} from '../../shared/types'
import { readSkillFolder } from '../bundle'
import { parseFlags } from '../flags'
import { confirm, hostCall, hostError, readStdinText, requireProject, runSubcommands, withHost, type SubcommandFn } from '../manage'
import { emit, plural, printText, safe, safeLine, styleFor, table, termWidth, type Json } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type HostClient } from '../types'
import { runInteractiveRun } from './interactive'

export const SKILLS_USAGE =
  'skills list | show <skill> | create --name <n> --description <d> (--file <path|-> | --text <body>) [--role <slug>]... | update <skill> [...] | remove <skill> [--yes] | link <libraryId> [--role <slug>]... | promote <skill> | import [--skill <name>]... [--yes] | undo-import <undoId> | evaluate | evaluation | apply-suggestion <id> [--role <slug>]... | library list|show|add|create|update|remove | assist ["<goal>"] [--library]'

const LIBRARY_USAGE =
  'skills library list | show <id> | add <folder> [--name <n>] | create --name <n> --description <d> (--file <path|-> | --text <body>) | update <id> [--name] [--description] [--file|--text] | remove <id> [--yes]'

/** Replaceable in tests. */
export const skillsDeps = { runInteractiveRun }

const READ: HostScope[] = ['read']
const CONFIGURE: HostScope[] = ['read', 'configure']
const OPERATE: HostScope[] = ['read', 'operate']
/** skills:evaluate may run a model step. */
const EVALUATE_TIMEOUT_MS = 10 * 60_000
/** skillLibrary:addFromBundle carries up to 1 MB of base64 plus framing. */
const BUNDLE_TIMEOUT_MS = 5 * 60_000
/** Largest --file body read (the host caps the body at SKILL_BODY_MAX_CHARS characters). */
const BODY_FILE_MAX_BYTES = SKILL_BODY_MAX_CHARS * 4

const usage = (m: string): CliError => new CliError(m, EXIT.usage)

/**
 * hostError for a change the host refused. The socket server answers every service refusal (a duplicate name, a
 * shell-injection SKILL.md, a stale import preview, "Only the user can change that") as 'bad_request', which hostError
 * maps to exit 2; for a change that is a refusal, so exit 1 with the host's message. Everything else as hostError.
 */
export function changeError(e: unknown): CliError {
  const err = hostError(e)
  const code = (e as { data?: { code?: string } } | undefined)?.data?.code
  return code === 'bad_request' ? new CliError(err.message, EXIT.failure) : err
}

/** hostCall for a change: a refusal is exit 1 (changeError). */
export async function hostChange<T>(client: HostClient, method: string, params: unknown[], opts?: { timeoutMs?: number }): Promise<T> {
  try {
    return await client.call<T>(method, params, opts)
  } catch (e) {
    throw changeError(e)
  }
}

/** Paths that look like scripts (a scripts/ folder or a runnable extension): the skill may ask agents to run them. */
export function skillScripts(files: readonly { path: string }[] | undefined): string[] {
  return (files ?? []).map((f) => f.path).filter((p) => /(^|\/)scripts\//i.test(p) || /\.(sh|bash|zsh|ps1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|exe)$/i.test(p))
}

/** True when no run can load the skill: no role holds a grant, it is off, or its library entry is gone. */
export function loadableByNoRole(info: SkillInfo): boolean {
  return info.grantedTo.length === 0 || !info.spec.enabled || !!info.libraryMissing
}

function roleNames(project: Project, ids: readonly string[]): string[] {
  return ids.map((id) => project.roles.find((r) => r.id === id)?.name ?? id)
}

/** --role <slug|id|name> values as Role ids; an unknown role is exit 2. */
export function roleIdsFor(project: Project, refs: readonly string[] | undefined): string[] | undefined {
  if (refs === undefined) return undefined
  return refs.map((ref) => {
    const want = ref.trim().toLowerCase()
    const role = project.roles.find((r: Role) => r.id === ref || r.slug.toLowerCase() === want || r.name.toLowerCase() === want)
    if (!role) throw usage(`No role "${safeLine(ref).slice(0, 64)}" in ${safeLine(project.name)}. Roles: ${project.roles.map((r) => r.slug).join(', ') || 'none'}.`)
    return role.id
  })
}

/** A project skill by id or name (case-insensitive). None is exit 2. */
function findSkill(list: SkillInfo[], ref: string): SkillInfo {
  const hit = list.find((s) => s.spec.id === ref) ?? list.find((s) => s.spec.name.toLowerCase() === ref.toLowerCase())
  if (!hit) throw usage(`No skill "${safeLine(ref).slice(0, 64)}" in this project. See \`orgai skills list\`.`)
  return hit
}

/** A library entry by id or name (case-insensitive). None is exit 2. */
function findEntry(list: SkillLibraryInfo[], ref: string): SkillLibraryInfo {
  const hit = list.find((s) => s.entry.id === ref) ?? list.find((s) => s.entry.name.toLowerCase() === ref.toLowerCase())
  if (!hit) throw usage(`No skill "${safeLine(ref).slice(0, 64)}" in the skill library. See \`orgai skills library list\`.`)
  return hit
}

/** The body from --file <path|-> or --text; at most one of them. undefined when neither. */
async function bodyFrom(values: { file?: string; text?: string }): Promise<string | undefined> {
  if (values.file !== undefined && values.text !== undefined) throw usage('Give the instructions with --file or --text, not both.')
  if (values.text !== undefined) return values.text
  if (values.file === undefined) return undefined
  if (values.file === '-') return readStdinText(BODY_FILE_MAX_BYTES, 'The skill instructions on stdin')
  try {
    const buf = await readFile(values.file)
    if (buf.length > BODY_FILE_MAX_BYTES) throw usage(`${safeLine(values.file)} is larger than ${Math.round(BODY_FILE_MAX_BYTES / 1024)} KB.`)
    return buf.toString('utf8')
  } catch (e) {
    if (e instanceof CliError) throw e
    throw usage(`Cannot read ${safeLine(values.file)}.`)
  }
}

const noPositionals = (p: string[]): void => {
  if (p.length) throw usage(`Unexpected argument "${safeLine(p[0]).slice(0, 64)}".`)
}

function one(p: string[], what: string): string {
  if (p.length === 0) throw usage(`Missing ${what}.`)
  if (p.length > 1) throw usage(`Unexpected argument "${safeLine(p[1]).slice(0, 64)}".`)
  return p[0]
}

const skillJson = (s: SkillInfo, project: Project): Json => ({
  id: s.spec.id,
  name: s.spec.name,
  description: s.spec.description,
  enabled: s.spec.enabled,
  source: s.spec.source,
  ...(s.spec.libraryId ? { libraryId: s.spec.libraryId } : {}),
  ...(s.libraryMissing ? { libraryMissing: true } : {}),
  grantedTo: s.grantedTo.map((id) => ({ roleId: id, roleName: roleNames(project, [id])[0] })),
  loadableByNoRole: loadableByNoRole(s),
  files: s.spec.files,
  scripts: skillScripts(s.spec.files)
})

const entryJson = (e: SkillLibraryInfo): Json => ({
  id: e.entry.id,
  name: e.entry.name,
  description: e.entry.description,
  source: e.entry.source,
  files: e.entry.files,
  scripts: skillScripts(e.entry.files),
  usedBy: e.usedBy
})

function mutationLine(ctx: CliContext, verb: string, r: SkillMutationResult, extra: Json = {}): void {
  emit(ctx, { project: { id: r.project.id, name: r.project.name }, skills: r.skills.map((s) => skillJson(s, r.project)), ...(r.rolesUpdated ? { rolesUpdated: r.rolesUpdated } : {}), ...extra }, () => {
    const lines = [verb]
    if (r.rolesUpdated?.length) lines.push(`Roles that lost the grant: ${r.rolesUpdated.map((x) => safeLine(x.roleName)).join(', ')}.`)
    return lines
  })
}

// ---------- project skills ----------

const list: SubcommandFn = async (ctx, args) => {
  noPositionals(parseFlags(args, {}).positionals)
  return withHost(ctx, READ, async (client) => {
    const project = await requireProject(ctx, client)
    const skills = await hostCall<SkillInfo[]>(client, 'skills:list', [project.id])
    emit(ctx, { project: { id: project.id, name: project.name }, skills: skills.map((s) => skillJson(s, project)) }, () => {
      if (skills.length === 0) return [`No skills in ${safeLine(project.name)}. Add one with \`orgai skills create\`, \`orgai skills link\` or \`orgai skills import\`.`]
      const st = styleFor(ctx)
      const rows = skills.map((s) => {
        const flags: string[] = []
        if (!s.spec.enabled) flags.push('off')
        if (s.libraryMissing) flags.push('library entry gone')
        if (loadableByNoRole(s)) flags.push('No role can load this')
        if (skillScripts(s.spec.files).length) flags.push('Includes scripts')
        return [
          safeLine(s.spec.name),
          safeLine(s.spec.description),
          roleNames(project, s.grantedTo).map(safeLine).join(', ') || '-',
          s.spec.libraryId ? `library ${safeLine(s.spec.libraryId)}` : safeLine(s.spec.source),
          flags.join(', '),
          safeLine(s.spec.id)
        ]
      })
      return table(
        [{ header: 'NAME', min: 8 }, { header: 'DESCRIPTION', flex: true, min: 10 }, { header: 'ROLES', min: 6 }, { header: 'SOURCE', min: 6 }, { header: 'NOTES', min: 5, style: (c) => st.yellow(c) }, { header: 'ID', min: 6 }],
        rows,
        termWidth(ctx),
        st
      )
    })
    return EXIT.ok
  })
}

function contentLines(ctx: CliContext, heading: string[], content: SkillContent): string[] {
  const scripts = skillScripts(content.files)
  return [
    ...heading,
    `Files: ${content.files.map((f) => `${safeLine(f.path)} (${f.bytes} B)`).join(', ')}`,
    ...(scripts.length ? [styleFor(ctx).yellow(`Includes scripts; may run shell commands: ${scripts.map(safeLine).join(', ')}`)] : []),
    '',
    safe(content.skillMd).replace(/\s+$/, '')
  ]
}

const show: SubcommandFn = async (ctx, args) => {
  const ref = one(parseFlags(args, {}).positionals, 'the skill name or id')
  return withHost(ctx, READ, async (client) => {
    const project = await requireProject(ctx, client)
    const info = findSkill(await hostCall<SkillInfo[]>(client, 'skills:list', [project.id]), ref)
    const content = await hostCall<SkillContent>(client, 'skills:read', [{ projectId: project.id, skillId: info.spec.id }])
    emit(ctx, { skill: skillJson(info, project), skillMd: content.skillMd, files: content.files }, () =>
      contentLines(
        ctx,
        [
          `${safeLine(info.spec.name)} (${safeLine(info.spec.id)})`,
          `Roles: ${roleNames(project, info.grantedTo).map(safeLine).join(', ') || 'none'}${loadableByNoRole(info) ? ' (No role can load this)' : ''}`,
          ...(info.spec.libraryId ? [`Linked to library entry ${safeLine(info.spec.libraryId)}${info.libraryMissing ? ' (gone)' : ''}`] : [])
        ],
        content
      )
    )
    return EXIT.ok
  })
}

const DRAFT_FLAGS = {
  name: { type: 'string' },
  description: { type: 'string' },
  file: { type: 'string' },
  text: { type: 'string' }
} as const

const create: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { ...DRAFT_FLAGS, role: { type: 'string', multiple: true } })
  noPositionals(positionals)
  if (!values.name) throw usage('skills create needs --name.')
  if (!values.description) throw usage('skills create needs --description.')
  const body = await bodyFrom(values)
  if (body === undefined) throw usage('skills create needs the instructions with --file <path|-> or --text <body>.')
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await requireProject(ctx, client)
    const roleIds = roleIdsFor(project, values.role)
    const input: SkillCreateInput = { projectId: project.id, draft: { name: values.name!, description: values.description!, body }, ...(roleIds ? { roleIds } : {}) }
    const r = await hostChange<SkillMutationResult>(client, 'skills:create', [input])
    mutationLine(ctx, `Created the skill ${safeLine(values.name)}.`, r)
    return EXIT.ok
  })
}

const update: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, {
    ...DRAFT_FLAGS,
    role: { type: 'string', multiple: true },
    'no-roles': { type: 'boolean' },
    enable: { type: 'boolean' },
    disable: { type: 'boolean' }
  })
  const ref = one(positionals, 'the skill name or id')
  if (values.enable && values.disable) throw usage('Give --enable or --disable, not both.')
  if (values.role && values['no-roles']) throw usage('Give --role or --no-roles, not both.')
  const body = await bodyFrom(values)
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await requireProject(ctx, client)
    const info = findSkill(await hostCall<SkillInfo[]>(client, 'skills:list', [project.id]), ref)
    const input: SkillUpdateInput = { projectId: project.id, skillId: info.spec.id }
    const draftChange = values.name !== undefined || values.description !== undefined || body !== undefined
    if (draftChange) {
      if (info.spec.libraryId) throw usage('This skill is a link to the skill library; change it with `orgai skills library update`. A link takes only --enable / --disable and roles.')
      const current = body === undefined ? await hostCall<SkillContent>(client, 'skills:read', [{ projectId: project.id, skillId: info.spec.id }]) : undefined
      const draft: SkillDraft = { name: values.name ?? info.spec.name, description: values.description ?? info.spec.description, body: body ?? current!.body }
      input.draft = draft
    }
    if (values.enable) input.enabled = true
    if (values.disable) input.enabled = false
    if (values['no-roles']) input.roleIds = []
    else {
      const ids = roleIdsFor(project, values.role)
      if (ids) input.roleIds = ids
    }
    if (input.draft === undefined && input.enabled === undefined && input.roleIds === undefined) throw usage('Nothing to change. Give --name, --description, --file / --text, --enable / --disable, --role or --no-roles.')
    const r = await hostChange<SkillMutationResult>(client, 'skills:update', [input])
    mutationLine(ctx, `Updated the skill ${safeLine(input.draft?.name ?? info.spec.name)}.`, r)
    return EXIT.ok
  })
}

const remove: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  const ref = one(positionals, 'the skill name or id')
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await requireProject(ctx, client)
    const info = findSkill(await hostCall<SkillInfo[]>(client, 'skills:list', [project.id]), ref)
    const roles = roleNames(project, info.grantedTo).map(safeLine)
    const verb = info.spec.libraryId ? 'Unlink' : 'Remove'
    const q = `${verb} the skill ${safeLine(info.spec.name)}${roles.length ? ` (${roles.join(', ')} will lose it)` : ''}?`
    if (!(await confirm(ctx, q, !!values.yes))) return declined(ctx)
    const r = await hostChange<SkillMutationResult>(client, 'skills:remove', [{ projectId: project.id, skillId: info.spec.id }])
    mutationLine(ctx, `${info.spec.libraryId ? 'Unlinked' : 'Removed'} the skill ${safeLine(info.spec.name)}.`, r)
    return EXIT.ok
  })
}

function declined(ctx: CliContext): number {
  emit(ctx, { cancelled: true }, () => 'Cancelled.')
  return EXIT.failure
}

const link: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { role: { type: 'string', multiple: true } })
  const ref = one(positionals, 'the library skill id or name')
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await requireProject(ctx, client)
    const entry = findEntry(await hostCall<SkillLibraryInfo[]>(client, 'skillLibrary:list', []), ref)
    const roleIds = roleIdsFor(project, values.role)
    const r = await hostChange<SkillMutationResult>(client, 'skills:linkLibrary', [{ projectId: project.id, libraryId: entry.entry.id, ...(roleIds ? { roleIds } : {}) }])
    mutationLine(ctx, `Linked ${safeLine(entry.entry.name)} from the skill library.`, r)
    return EXIT.ok
  })
}

const promote: SubcommandFn = async (ctx, args) => {
  const ref = one(parseFlags(args, {}).positionals, 'the skill name or id')
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await requireProject(ctx, client)
    const info = findSkill(await hostCall<SkillInfo[]>(client, 'skills:list', [project.id]), ref)
    const r = await hostChange<SkillMutationResult>(client, 'skills:promote', [{ projectId: project.id, skillId: info.spec.id }])
    mutationLine(ctx, `Copied ${safeLine(info.spec.name)} to the skill library; the project now links it.`, r)
    return EXIT.ok
  })
}

// ---------- repo import ----------

/** Initial inclusion: everything that would add or update, unless its name conflicts. */
export function defaultIncluded(item: Pick<SkillImportItem, 'action' | 'nameConflict'>): boolean {
  return (item.action === 'add' || item.action === 'update') && !item.nameConflict
}

/** Choices for every item: the named ones (by name, key or repoPath) when --skill was given, else the defaults. */
export function importChoices(preview: SkillImportPreview, only: readonly string[] | undefined): SkillImportChoice[] {
  if (only) {
    for (const want of only) {
      const w = want.toLowerCase()
      if (!preview.items.some((i) => i.key === want || i.repoPath === want || i.name.toLowerCase() === w)) {
        throw usage(`No importable skill "${safeLine(want).slice(0, 64)}" in this project's folder.`)
      }
    }
  }
  return preview.items.map((i) => ({
    key: i.key,
    include: only ? only.some((w) => w === i.key || w === i.repoPath || w.toLowerCase() === i.name.toLowerCase()) && i.action !== 'unchanged' : defaultIncluded(i)
  }))
}

const importCmd: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' }, skill: { type: 'string', multiple: true } })
  noPositionals(positionals)
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await requireProject(ctx, client)
    const preview = await hostCall<SkillImportPreview>(client, 'skills:previewImport', [{ projectId: project.id }])
    const choices = importChoices(preview, values.skill)
    const chosen = preview.items.filter((i) => choices.find((c) => c.key === i.key)?.include)
    const st = styleFor(ctx)
    const previewLines = (): string[] => {
      const lines: string[] = []
      if (preview.items.length === 0 && preview.invalid.length === 0) lines.push(`No skill folders found (${preview.roots.length ? preview.roots.join(', ') : 'none of .claude/skills, .agents/skills, .github/skills, .opencode/skills exist'}).`)
      for (const i of preview.items) {
        const on = chosen.includes(i)
        const tag = i.action === 'unchanged' ? 'unchanged' : i.nameConflict ? 'name conflict' : i.duplicateOf ? `duplicate of ${safeLine(i.duplicateOf)}` : i.action
        lines.push(`${on ? '[x]' : '[ ]'} ${safeLine(i.name)}  ${st.dim(safeLine(i.repoPath))}  ${tag}`)
        lines.push(`    ${safeLine(i.description)}`)
        if (i.scripts.length) lines.push(`    ${st.yellow(`Includes scripts; may run shell commands: ${i.scripts.map(safeLine).join(', ')}`)}`)
        for (const n of i.notes) lines.push(`    ${safeLine(n)}`)
      }
      for (const bad of preview.invalid) lines.push(`${st.red('refused')} ${safeLine(bad.repoPath)}: ${safeLine(bad.reason)}`)
      for (const w of preview.warnings) lines.push(st.yellow(safeLine(w)))
      return lines
    }
    const previewJson: Json = { digest: preview.digest, items: preview.items, invalid: preview.invalid, warnings: preview.warnings, choices }
    if (chosen.length === 0) {
      emit(ctx, { preview: previewJson, applied: false }, () => [...previewLines(), 'Nothing to import.'])
      return EXIT.ok
    }
    printText(ctx, previewLines())
    if (!(await confirm(ctx, `Import ${plural(chosen.length, 'skill')} into ${safeLine(project.name)}?`, !!values.yes))) return declined(ctx)
    const r = await hostChange<SkillImportApplyResult>(client, 'skills:applyImport', [{ projectId: project.id, choices, digest: preview.digest }])
    emit(ctx, { preview: previewJson, applied: true, added: r.added, updated: r.updated, undoId: r.undoId }, () => [
      `Imported ${plural(r.added.length + r.updated.length, 'skill')}${r.updated.length ? ` (${r.updated.length} updated)` : ''}.`,
      `Undo with \`orgai skills undo-import ${safeLine(r.undoId)}\`.`
    ])
    return EXIT.ok
  })
}

const undoImport: SubcommandFn = async (ctx, args) => {
  const undoId = one(parseFlags(args, {}).positionals, 'the undo id')
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await requireProject(ctx, client)
    const r = await hostChange<SkillMutationResult>(client, 'skills:undoImport', [{ projectId: project.id, undoId }])
    mutationLine(ctx, 'Undid the skill import.', r)
    return EXIT.ok
  })
}

// ---------- evaluation ----------

function reportLines(ctx: CliContext, r: SkillEvaluationReport): string[] {
  const st = styleFor(ctx)
  const lines = [`Skill evaluation of ${new Date(r.at).toISOString()}: ${plural(r.findings.length, 'finding')}, ${plural(r.suggestions.length, 'suggestion')} over ${plural(r.runsConsidered, 'run')}.`]
  for (const f of r.findings) lines.push(`${f.severity === 'warning' ? st.yellow('warning') : 'info'}  ${safeLine(f.title)}`)
  for (const s of r.suggestions) lines.push(`suggestion ${safeLine(s.id)}: ${safeLine(s.draft.name)} - ${safeLine(s.rationale)}${s.appliedSkillId ? ' (applied)' : ''}`)
  if (r.modelAssisted) lines.push(`The model step used ${r.tokensUsed}${r.tokensEstimated ? ' (estimated)' : ''} of ${r.tokenBudget} tokens.`)
  else {
    const why = r.skippedReason === 'disabled' ? 'it is off for this project' : r.skippedReason === 'no-gaps' ? 'no gaps were found' : r.skippedReason === 'budget' ? `the estimate exceeded the token budget (${r.tokenBudget})` : r.skippedReason === 'error' ? `it failed: ${safeLine(r.error)}` : 'it did not run'
    lines.push(`The model step did not run: ${why}.`)
  }
  if (r.suggestions.some((s) => !s.appliedSkillId)) lines.push('Apply a suggestion with `orgai skills apply-suggestion <id>`.')
  return lines
}

const evaluate: SubcommandFn = async (ctx, args) => {
  noPositionals(parseFlags(args, {}).positionals)
  return withHost(ctx, OPERATE, async (client) => {
    const project = await requireProject(ctx, client)
    const r = await hostChange<SkillEvaluationReport>(client, 'skills:evaluate', [project.id], { timeoutMs: EVALUATE_TIMEOUT_MS })
    emit(ctx, { report: r as unknown as Json }, () => reportLines(ctx, r))
    return EXIT.ok
  })
}

const evaluation: SubcommandFn = async (ctx, args) => {
  noPositionals(parseFlags(args, {}).positionals)
  return withHost(ctx, READ, async (client) => {
    const project = await requireProject(ctx, client)
    const r = await hostCall<SkillEvaluationReport | null>(client, 'skills:lastEvaluation', [project.id])
    emit(ctx, { report: (r ?? null) as unknown as Json }, () => (r ? reportLines(ctx, r) : ['No skill evaluation yet. Run `orgai skills evaluate`.']))
    return EXIT.ok
  })
}

const applySuggestion: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { role: { type: 'string', multiple: true } })
  const suggestionId = one(positionals, 'the suggestion id')
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await requireProject(ctx, client)
    const roleIds = roleIdsFor(project, values.role)
    const r = await hostChange<SkillMutationResult>(client, 'skills:applySuggestion', [{ projectId: project.id, suggestionId, ...(roleIds ? { roleIds } : {}) }])
    mutationLine(ctx, 'Created the suggested skill.', r)
    return EXIT.ok
  })
}

// ---------- library ----------

const libList: SubcommandFn = async (ctx, args) => {
  noPositionals(parseFlags(args, {}).positionals)
  return withHost(ctx, READ, async (client) => {
    const entries = await hostCall<SkillLibraryInfo[]>(client, 'skillLibrary:list', [])
    emit(ctx, { entries: entries.map(entryJson) }, () => {
      if (entries.length === 0) return ['The skill library is empty. Add a folder with `orgai skills library add <folder>`.']
      const st = styleFor(ctx)
      return table(
        [{ header: 'NAME', min: 8 }, { header: 'DESCRIPTION', flex: true, min: 10 }, { header: 'USED BY', min: 7 }, { header: 'ID', min: 6 }],
        entries.map((e) => [safeLine(e.entry.name), safeLine(e.entry.description), e.usedBy.map((u) => safeLine(u.projectName)).join(', ') || '-', safeLine(e.entry.id)]),
        termWidth(ctx),
        st
      )
    })
    return EXIT.ok
  })
}

const libShow: SubcommandFn = async (ctx, args) => {
  const ref = one(parseFlags(args, {}).positionals, 'the library skill id or name')
  return withHost(ctx, READ, async (client) => {
    const e = findEntry(await hostCall<SkillLibraryInfo[]>(client, 'skillLibrary:list', []), ref)
    const content = await hostCall<SkillContent>(client, 'skillLibrary:read', [{ libraryId: e.entry.id }])
    emit(ctx, { entry: entryJson(e), skillMd: content.skillMd, files: content.files }, () =>
      contentLines(ctx, [`${safeLine(e.entry.name)} (${safeLine(e.entry.id)})`, `Used by: ${e.usedBy.map((u) => `${safeLine(u.projectName)}${u.roleNames.length ? ` (${u.roleNames.map(safeLine).join(', ')})` : ''}`).join(', ') || 'no project'}`], content)
    )
    return EXIT.ok
  })
}

const libAdd: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { name: { type: 'string' } })
  const folder = one(positionals, 'the skill folder')
  const notes: string[] = []
  const bundle = await readSkillFolder(folder, { notes, ...(values.name !== undefined ? { name: values.name } : {}) })
  return withHost(ctx, CONFIGURE, async (client) => {
    const before = new Set((await hostCall<SkillLibraryInfo[]>(client, 'skillLibrary:list', [])).map((e) => e.entry.id))
    const after = await hostChange<SkillLibraryInfo[]>(client, 'skillLibrary:addFromBundle', [bundle], { timeoutMs: BUNDLE_TIMEOUT_MS })
    const added = after.find((e) => !before.has(e.entry.id))
    emit(ctx, { entry: added ? entryJson(added) : null, files: bundle.files.map((f) => f.relPath), notes }, () => [
      ...notes.map((n) => styleFor(ctx).dim(n)),
      added ? `Added ${safeLine(added.entry.name)} (${safeLine(added.entry.id)}) to the skill library: ${plural(added.entry.files.length, 'file')}.` : 'Added the skill to the library.',
      ...(added && skillScripts(added.entry.files).length ? [styleFor(ctx).yellow(`Includes scripts; may run shell commands: ${skillScripts(added.entry.files).map(safeLine).join(', ')}`)] : [])
    ])
    return EXIT.ok
  })
}

const libCreate: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, DRAFT_FLAGS)
  noPositionals(positionals)
  if (!values.name) throw usage('skills library create needs --name.')
  if (!values.description) throw usage('skills library create needs --description.')
  const body = await bodyFrom(values)
  if (body === undefined) throw usage('skills library create needs the instructions with --file <path|-> or --text <body>.')
  return withHost(ctx, CONFIGURE, async (client) => {
    const entries = await hostChange<SkillLibraryInfo[]>(client, 'skillLibrary:create', [{ name: values.name, description: values.description, body }])
    const e = entries.find((x) => x.entry.name === values.name)
    emit(ctx, { entry: e ? entryJson(e) : null }, () => `Created ${safeLine(values.name)} in the skill library.`)
    return EXIT.ok
  })
}

const libUpdate: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, DRAFT_FLAGS)
  const ref = one(positionals, 'the library skill id or name')
  const body = await bodyFrom(values)
  if (values.name === undefined && values.description === undefined && body === undefined) throw usage('Nothing to change. Give --name, --description or --file / --text.')
  return withHost(ctx, CONFIGURE, async (client) => {
    const e = findEntry(await hostCall<SkillLibraryInfo[]>(client, 'skillLibrary:list', []), ref)
    const current = body === undefined ? await hostCall<SkillContent>(client, 'skillLibrary:read', [{ libraryId: e.entry.id }]) : undefined
    const draft: SkillDraft = { name: values.name ?? e.entry.name, description: values.description ?? e.entry.description, body: body ?? current!.body }
    const entries = await hostChange<SkillLibraryInfo[]>(client, 'skillLibrary:update', [{ libraryId: e.entry.id, draft }])
    const now = entries.find((x) => x.entry.id === e.entry.id)
    emit(ctx, { entry: now ? entryJson(now) : null }, () => `Updated ${safeLine(draft.name)} in the skill library${e.usedBy.length ? `; ${plural(e.usedBy.length, 'project')} linking it see the change` : ''}.`)
    return EXIT.ok
  })
}

const libRemove: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  const ref = one(positionals, 'the library skill id or name')
  return withHost(ctx, CONFIGURE, async (client) => {
    const e = findEntry(await hostCall<SkillLibraryInfo[]>(client, 'skillLibrary:list', []), ref)
    const users = e.usedBy.map((u) => `${safeLine(u.projectName)}${u.roleNames.length ? ` (${u.roleNames.map(safeLine).join(', ')})` : ''}`)
    const q = `Delete ${safeLine(e.entry.name)} from the skill library${users.length ? ` and unlink it from ${users.join('; ')}` : ''}?`
    if (!(await confirm(ctx, q, !!values.yes))) return declined(ctx)
    await hostChange<SkillLibraryInfo[]>(client, 'skillLibrary:remove', [{ libraryId: e.entry.id }])
    emit(ctx, { removed: e.entry.id, unlinkedFrom: e.usedBy }, () => `Deleted ${safeLine(e.entry.name)} from the skill library.`)
    return EXIT.ok
  })
}

const library: SubcommandFn = (ctx, args) =>
  runSubcommands(ctx, args, { list: libList, show: libShow, add: libAdd, create: libCreate, update: libUpdate, remove: libRemove }, LIBRARY_USAGE)

// ---------- assist ----------

const assist: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { library: { type: 'boolean' }, inline: { type: 'boolean' }, 'ax-screen-reader': { type: 'boolean' } })
  if (positionals.length > 1) throw usage('Give the goal as one quoted argument.')
  const instruction = positionals[0]?.trim() || undefined
  if (values.library && ctx.globals.project) throw usage('Give --library or --project, not both.')
  let input: SkillAssistInput
  // scope 'library' runs on the virtual project SKILLS_PROJECT_ID (the host picks it from the scope).
  if (values.library) input = { scope: 'library', ...(instruction ? { instruction } : {}) }
  else {
    const project = await withHost(ctx, READ, (client) => requireProject(ctx, client)).catch((e: unknown) => {
      if (e instanceof CliError && e.exitCode === EXIT.usage) throw usage(`${e.message} Pass --library to work on the global skill library.`)
      throw e
    })
    input = { projectId: project.id, scope: 'project', ...(instruction ? { instruction } : {}) }
  }
  return skillsDeps.runInteractiveRun(
    ctx,
    {
      channel: 'skills:startAssist',
      input,
      label: 'Skill assistant',
      noTtyMessage: 'The Skill assistant needs a terminal. Use `orgai skills create` or `orgai skills library add` instead.'
    },
    { inline: !!values.inline, screenReader: !!values['ax-screen-reader'] }
  )
}

export const runSkills: CommandFn = (ctx, args) =>
  runSubcommands(
    ctx,
    args,
    {
      list,
      show,
      create,
      update,
      remove,
      link,
      promote,
      import: importCmd,
      'undo-import': undoImport,
      evaluate,
      evaluation,
      'apply-suggestion': applySuggestion,
      library,
      assist
    },
    SKILLS_USAGE
  )
