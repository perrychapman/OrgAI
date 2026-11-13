/**
 * `orgai org` (cli-spec 6.3, Wave 5): the org chart and the Team assistant.
 *
 * - `org show`: the roles as a reporting tree (reportsTo), with model tier, spawning, tools, MCP and skill grants and
 *   the effective subagent limits. Read scope.
 * - `org export`: projects:exportOrg (configure); prints the written `.orgai/org.json`.
 * - `org import [--source <id>...] [--mode merge|replace] [--yes]`: projects:scanAgents, projects:previewImport, a
 *   confirmation, then projects:applyImport with the preview's digest (configure). There is no undo: the confirmation
 *   says so and --json carries the previous chart (`previousRoles`) for a script to keep.
 * - `org retro <runRef>`: an Org retrospective (setup:retro) of a  finished work run; follows it in the terminal UI
 *   (it needs a terminal: the run lives only inside this orgai).
 * - `org draft "<description>"`: draft:orgChart (operate); prints the drafted roles. With --apply (or --from <file>
 *   --apply, a draft printed earlier) it saves them through projects:save after a preview and confirmation.
 * - `org revise "<instruction>"`: the Architect on the existing project with the instruction (setup:start), in the terminal UI.
 * - Team assistant: `org discover`, `recommend`, `review`, `apply`, `undo`, `dismiss`, `restore` (capabilities:*).
 *
 * Every untrusted string (role names, prompts, Team assistant text, paths) goes through safe / safeLine.
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  AGENT_IMPORT_SOURCES,
  isAgentImportSource,
  isModelTier,
  isVirtualProjectId,
  TEAM_FILES_MAX_ROLES,
  type AgentImportApplyResult,
  type AgentImportItem,
  type AgentImportMode,
  type AgentImportPreview,
  type AgentImportScan,
  type AgentImportSource,
  type CapabilityApplyInput,
  type CapabilityApplyResult,
  type CapabilityDiscovery,
  type CapabilityItem,
  type CapabilityProgressEvent,
  type CapabilityRecommendation,
  type DraftResult,
  type HostScope,
  type ModelTier,
  type OrgExportResult,
  type Project,
  type Role,
  type RunSummary,
  type TeamRecommendations,
  type TeamReview
} from '../../shared/types'
import { compareTier, effectiveSubagentLimits, staffingModeOf, tierForModel } from '../../shared/defaults'
import { servicesForRole } from '../../shared/view/roleServices'
import { isOpenStatus } from '../../shared/view/runChains'
import { parseFlags } from '../flags'
import { confirm, hostCall, hostError, requireProject, runSubcommands, subscribeTopics, withHost, type SubcommandFn } from '../manage'
import { quietInproc } from '../context'
import { emit, emitLine, isJsonOutput, note, printText, safe, safeLine, type Json } from '../output'
import { liveSource, resolveRunFromSource } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn, type HostClient } from '../types'
import { effortWord, runsOnWords, staffingWords } from '../roleText'
import { connectionLabels } from './teamRoleEdit'
import { runInteractiveRun } from './interactive'
import { hasTty, managedOf, worktreeRefusal } from './tui'
import { orgEvolve, retroUnattended } from './orgEvolve'

/** Long-running Team assistant and drafting calls (discover, recommend, review, draft) wait at least this long. */
export const LONG_CALL_TIMEOUT_MS = 10 * 60_000

/** Longest id, branch or rule argument accepted. */
export const ARG_MAX_CHARS = 200

const USAGE =
  'org show | export | import [--source <id>...] [--mode merge|replace] [--yes] | retro <runRef> [--unattended [--apply]] | evolve [...] | draft "<description>" [--mode replace|revise|merge] [--apply [--yes]] | draft --from <file.json> --apply [--mode replace|merge] [--yes] | revise "<instruction>" | discover [--outside] | recommend [--outside] [--role <role>] | review [--recheck [--outside] [--model]] | apply <recommendationId> [--candidate <id>] [--role <role>...] [--access read|full] | undo <undoId> | dismiss <id> [--candidate] | restore <candidateId>'

// ---------- Shared argument checks (team, worktrees and permissions import these) ----------

/** A non-empty id / branch / rule argument of at most ARG_MAX_CHARS without control characters; else exit 2. */
export function checkArg(what: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') throw new CliError(`Missing ${what}.`, EXIT.usage)
  if (value.length > ARG_MAX_CHARS) throw new CliError(`The ${what} is longer than ${ARG_MAX_CHARS} characters.`, EXIT.usage)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new CliError(`The ${what} holds control characters.`, EXIT.usage)
  return value
}

/** Exactly `n` positionals (the rest is a usage error). */
export function onlyPositionals(positionals: string[], max: number, usage: string): void {
  if (positionals.length > max) throw new CliError(`Unexpected argument "${safeLine(positionals[max]).slice(0, 64)}". Usage: orgai ${usage}`, EXIT.usage)
}

/** A short project object for JSON output. */
export const projectJson = (p: Project): Json => ({ id: p.id, name: p.name, path: p.path })

/** The tier word of a role ('inherit' for inherit, else the stored tier or the one its model implies, else the id). */
export function roleTierWord(role: Pick<Role, 'model' | 'tier'>): string {
  if (role.model === 'inherit') return 'inherit'
  return role.tier ?? tierForModel(role.model) ?? String(role.model)
}

/** A role named by id, slug or name (case-insensitive name), else undefined. */
export function findRole(roles: readonly Role[], ref: string): Role | undefined {
  const lower = ref.trim().toLowerCase()
  return roles.find((r) => r.id === ref) ?? roles.find((r) => r.slug === ref) ?? roles.find((r) => r.name.trim().toLowerCase() === lower)
}

const newRequestId = (): string => `cli-${randomBytes(6).toString('hex')}`

// ---------- Entry ----------

export const runOrg: CommandFn = (ctx, args) =>
  runSubcommands(
    ctx,
    args,
    {
      show: orgShow,
      export: orgExport,
      import: orgImport,
      retro: orgRetro,
      evolve: orgEvolve,
      draft: orgDraft,
      revise: orgRevise,
      discover: orgDiscover,
      recommend: orgRecommend,
      review: orgReview,
      apply: orgApply,
      undo: orgUndo,
      dismiss: orgDismiss,
      restore: orgRestore
    },
    USAGE
  )

// ---------- org show ----------

export interface RoleTreeRow {
  role: Role
  depth: number
}

/** Roles in reporting order: roots first (reportsTo null or unknown), each followed by its reports. Cycle-safe. */
export function roleTree(roles: readonly Role[]): RoleTreeRow[] {
  const ids = new Set(roles.map((r) => r.id))
  const children = new Map<string | null, Role[]>()
  for (const r of roles) {
    const parent = r.reportsTo && ids.has(r.reportsTo) && r.reportsTo !== r.id ? r.reportsTo : null
    const list = children.get(parent) ?? []
    list.push(r)
    children.set(parent, list)
  }
  const out: RoleTreeRow[] = []
  const seen = new Set<string>()
  const visit = (r: Role, depth: number): void => {
    if (seen.has(r.id)) return
    seen.add(r.id)
    out.push({ role: r, depth })
    for (const c of children.get(r.id) ?? []) visit(c, depth + 1)
  }
  for (const r of children.get(null) ?? []) visit(r, 0)
  // A cycle with no root: still list every role once.
  for (const r of roles) visit(r, 0)
  return out
}

function roleGrants(project: Project, role: Role): { mcp: { id: string; label: string }[]; skills: { id: string; name: string }[] } {
  const mcp = servicesForRole(project, role).map((s) => ({ id: s.id, label: s.label }))
  const byId = new Map((project.skills ?? []).map((s) => [s.id, s.name]))
  const skills = (role.skills ?? []).filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id) as string }))
  return { mcp, skills }
}

const orgShow: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 0, 'org show')
  return withHost(ctx, ['read'], async (client) => {
    const project = await requireProject(ctx, client)
    const roles = project.roles ?? []
    const rows = roleTree(roles)
    const limits = effectiveSubagentLimits(project)
    const nameOf = new Map(roles.map((r) => [r.id, r.name]))
    const label = await connectionLabels(client)
    emit(
      ctx,
      {
        project: projectJson(project),
        limits: { depth: limits.depth, concurrency: limits.concurrency, explicit: limits.explicit },
        roles: rows.map(({ role, depth }) => {
          const g = roleGrants(project, role)
          return {
            id: role.id,
            slug: role.slug,
            name: role.name,
            depth,
            reportsTo: role.reportsTo,
            model: role.model,
            tier: role.model === 'inherit' ? null : (role.tier ?? tierForModel(role.model) ?? null),
            canSpawn: role.canSpawn,
            spawnable: role.spawnable,
            requiredReports: role.requiredReports ?? [],
            effort: role.effort ?? null,
            staffing: staffingWords(role, project),
            runsOn: runsOnWords(role, project, label),
            tools: role.tools,
            mcpServers: g.mcp.map((m) => m.id),
            skills: g.skills.map((s) => s.id)
          }
        })
      },
      () => {
        const lines = [`${safeLine(project.name)}: ${roles.length} role${roles.length === 1 ? '' : 's'}`]
        if (roles.length === 0) lines.push('  No roles yet.')
        for (const { role, depth } of rows) {
          const pad = '  '.repeat(depth + 1)
          const g = roleGrants(project, role)
          lines.push(`${pad}${safeLine(role.name)} [${safeLine(role.slug)}] · ${safeLine(roleTierWord(role))}`)
          lines.push(`${pad}    effort ${safeLine(effortWord(role))} · ${safeLine(staffingWords(role, project))} · runs on ${safeLine(runsOnWords(role, project, label))}`)
          const spawn = role.canSpawn
            ? `spawns: ${role.spawnable.length ? role.spawnable.map((id) => safeLine(nameOf.get(id) ?? id)).join(', ') : 'none listed'}`
            : 'cannot spawn'
          const required = role.requiredReports?.length ? ` · must delegate to: ${role.requiredReports.map((id) => safeLine(nameOf.get(id) ?? id)).join(', ')}` : ''
          lines.push(`${pad}    ${spawn}${required} · tools: ${role.tools.length ? role.tools.map(safeLine).join(', ') : 'none'}`)
          if (g.mcp.length || g.skills.length) {
            const parts: string[] = []
            if (g.mcp.length) parts.push(`MCP: ${g.mcp.map((m) => safeLine(m.label)).join(', ')}`)
            if (g.skills.length) parts.push(`skills: ${g.skills.map((s) => safeLine(s.name)).join(', ')}`)
            lines.push(`${pad}    ${parts.join(' · ')}`)
          }
        }
        const auto = (b: boolean): string => (b ? '' : ' (automatic)')
        lines.push(`Subagent limits: depth ${limits.depth}${auto(limits.explicit.depth)}, ${limits.concurrency} at once${auto(limits.explicit.concurrency)}`)
        return lines
      }
    )
    return EXIT.ok
  })
}

// ---------- org export ----------

const orgExport: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 0, 'org export')
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const res = await hostCall<OrgExportResult>(client, 'projects:exportOrg', [project.id])
    emit(ctx, { project: projectJson(project), path: res.path }, () => `Wrote ${safeLine(res.path)}`)
    return EXIT.ok
  })
}

// ---------- org import ----------

const STALE_IMPORT = 'The folder changed since the preview; run it again.'
/**
 * The CLI cannot undo an import, so the confirmation says so. Shared with `team templates apply`.
 */
export const NO_UNDO = 'This cannot be undone.'
export const NO_UNDO_AFTER = 'This cannot be undone from the CLI (--json output carries the previous chart as previousRoles).'

function importItemLines(item: AgentImportItem): string[] {
  const flag = item.elevatedTools.length ? `  ! elevated: ${item.elevatedTools.map(safeLine).join(', ')}` : ''
  const replaces = item.action === 'replace' ? ' (replaces the role with this slug)' : ''
  const lines = [`  ${item.action.padEnd(7)} ${safeLine(item.name)} [${safeLine(item.slug)}] from ${safeLine(item.file)}${replaces}`]
  lines.push(`          model ${safeLine(item.model)} (${item.modelReason}) · tools: ${item.tools.length ? item.tools.map(safeLine).join(', ') : 'none'}`)
  if (flag) lines.push(`        ${flag.trim()}`)
  if (item.toolsDropped.length) lines.push(`          not available in OrgAI: ${item.toolsDropped.map(safeLine).join(', ')}`)
  const excerpt = safeLine(item.promptExcerpt)
  if (excerpt) lines.push(`          prompt: ${excerpt.slice(0, 200)}${item.promptLength > 200 ? '…' : ''}`)
  for (const n of item.notes) lines.push(`          note: ${safeLine(n)}`)
  return lines
}

const orgImport: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, {
    source: { type: 'string', multiple: true },
    mode: { type: 'string' },
    yes: { type: 'boolean', short: 'y' }
  })
  onlyPositionals(positionals, 0, 'org import [--source <id>...] [--mode merge|replace] [--yes]')
  const mode: AgentImportMode = (values.mode ?? 'merge') as AgentImportMode
  if (mode !== 'merge' && mode !== 'replace') throw new CliError('--mode must be merge or replace.', EXIT.usage)
  const chosen = values.source
  if (chosen) {
    for (const s of chosen) {
      if (!isAgentImportSource(s)) throw new CliError(`Unknown source "${safeLine(s).slice(0, 40)}". Sources: ${AGENT_IMPORT_SOURCES.join(', ')}.`, EXIT.usage)
    }
  }
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const scan = await hostCall<AgentImportScan>(client, 'projects:scanAgents', [project.path])
    const found = scan.sources.filter((s) => s.agentCount > 0)
    if (chosen) {
      const missing = chosen.filter((s) => !found.some((f) => f.source === s))
      if (missing.length) throw new CliError(`No agent definitions from ${missing.join(', ')} in ${safeLine(project.path)}.`, EXIT.usage)
    }
    if (found.length === 0) {
      emit(ctx, { project: projectJson(project), scan, applied: false }, () => [
        `No agent definitions found in ${safeLine(project.path)}.`,
        ...scan.warnings.map((w) => `  warning: ${safeLine(w)}`)
      ])
      return EXIT.ok
    }
    const sources = (chosen ? [...new Set(chosen)] : undefined) as AgentImportSource[] | undefined
    const preview = await hostCall<AgentImportPreview>(client, 'projects:previewImport', [{ projectId: project.id, mode, ...(sources ? { sources } : {}) }])
    const importing = preview.items.filter((i) => i.action !== 'skip')
    const nameOf = new Map(project.roles.map((r) => [r.id, r.name]))
    printText(ctx, [
      `Import into ${safeLine(project.name)} (${mode}): ${importing.length} role${importing.length === 1 ? '' : 's'}`,
      ...preview.items.flatMap(importItemLines),
      ...(preview.replacedRoleIds.length ? [`Drops or replaces: ${preview.replacedRoleIds.map((id) => safeLine(nameOf.get(id) ?? id)).join(', ')}`] : []),
      ...preview.warnings.map((w) => `warning: ${safeLine(w)}`)
    ])
    if (importing.length === 0) {
      emit(ctx, { project: projectJson(project), preview, applied: false }, () => 'Nothing to import.')
      return EXIT.ok
    }
    const question =
      preview.replacedRoleIds.length > 0
        ? `Import ${importing.length} role(s) and drop or replace ${preview.replacedRoleIds.length} existing role(s)? ${NO_UNDO}`
        : `Import ${importing.length} role(s) into ${safeLine(project.name)}?`
    if (!(await confirm(ctx, question, !!values.yes))) {
      note(ctx, 'Nothing imported.')
      return EXIT.failure
    }
    let res: AgentImportApplyResult
    try {
      res = await client.call<AgentImportApplyResult>('projects:applyImport', [{ projectId: project.id, mode, ...(sources ? { sources } : {}), digest: preview.digest }])
    } catch (e) {
      const err = hostError(e)
      if (/changed since the preview|preview the import/i.test(err.message) || /stale/i.test(String((e as { data?: { code?: string } })?.data?.code ?? ''))) {
        throw new CliError(STALE_IMPORT, EXIT.failure)
      }
      throw err
    }
    const previousRoles = Array.isArray(res.previousRoles) ? res.previousRoles : []
    emit(
      ctx,
      { project: projectJson(res.project), imported: importing.length, digest: preview.digest, replacedRoleIds: preview.replacedRoleIds, roles: res.project.roles.length, previousRoles },
      () => [
        `Imported ${importing.length} role${importing.length === 1 ? '' : 's'}; the chart now has ${res.project.roles.length}.`,
        ...(preview.replacedRoleIds.length > 0 ? [`${NO_UNDO_AFTER} The previous chart had ${previousRoles.length} role${previousRoles.length === 1 ? '' : 's'}.`] : [])
      ]
    )
    return EXIT.ok
  })
}

// ---------- org retro ----------

const orgRetro: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, {
    inline: { type: 'boolean' },
    'ax-screen-reader': { type: 'boolean' },
    unattended: { type: 'boolean' },
    apply: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    strategy: { type: 'string' },
    goal: { type: 'string' },
    runs: { type: 'string' },
    'min-waste': { type: 'string' }
  })
  onlyPositionals(positionals, 1, 'org retro <runRef> [--unattended [--apply]]')
  const ref = checkArg('run (an id or R#)', positionals[0])
  if (values.apply === true && values.unattended !== true) throw new CliError('--apply belongs to the unattended retrospective: orgai org retro <runRef> --unattended --apply.', EXIT.usage)
  // No terminal needed: the unattended form reads the project's recent work runs through the team-evolution analysis (orgEvolve.ts).
  if (values.unattended === true) {
    return retroUnattended(ctx, ref, { apply: values.apply === true, ...(values.yes === true ? { yes: true } : {}),...(values.strategy ? { strategy: values.strategy } : {}), ...(values.goal ? { goal: values.goal } : {}), ...(values.runs ? { runs: values.runs } : {}), ...(values['min-waste'] ? { 'min-waste': values['min-waste'] } : {}) })
  }
  // The run lives only inside the orgai that starts it, so it needs a terminal to follow it in.
  if (!(ctx.io.stdinIsTTY && ctx.io.stdout.isTTY === true) || isJsonOutput(ctx)) {
    throw new CliError('An Org retrospective needs a terminal: the run lives inside this orgai, and ends with it. In a script or CI, use: orgai org retro <runRef> --unattended [--apply]', EXIT.usage)
  }

  // The retrospective's terminal UI follows on this same host, so it starts quiet.
  quietInproc(ctx)
  const target = await withHost(ctx, ['read'], async (client) => {
    const src = liveSource(client)
    const { runId, projects } = await resolveRunFromSource(ctx, src, ref)
    const rec = await src.record(runId)
    if (!rec) throw new CliError(`Run ${safeLine(ref)} was not found.`, EXIT.usage)
    const s = rec.summary
    if (isVirtualProjectId(s.projectId)) throw new CliError('An Org retrospective needs a run of a real project, not an assistant session.', EXIT.usage)
    if (s.kind !== 'work' || s.quick) throw new CliError('An Org retrospective looks back at a work run; this run is not one.', EXIT.usage)
    if (isOpenStatus(s.status)) throw new CliError('That run is still open. End it first, then run the retrospective.', EXIT.usage)
    const project = projects.find((p) => p.id === s.projectId)
    if (!project) throw new CliError('The run’s project was not found.', EXIT.usage)
    return { projectId: s.projectId, runId: s.id, project }
    // The retrospective's terminal session follows on this same host (one boot, not two).
  }, { keepHost: true })

  return runInteractiveRun(
    ctx,
    {
      channel: 'setup:retro',
      input: { projectId: target.projectId, runId: target.runId },
      label: 'Org retrospective',
      noTtyMessage: 'An Org retrospective needs a terminal.'
    },
    { inline: !!values.inline, screenReader: !!values['ax-screen-reader'] }
  )
}

// ---------- org draft ----------

const DRAFT_USAGE = 'org draft "<description>" [--mode replace|revise|merge] [--apply [--yes]] | org draft --from <file.json> [--mode replace|merge] --apply [--yes]'
/** Largest --from file read (a drafted chart is a few tens of KB). */
export const DRAFT_FILE_MAX_BYTES = 2 * 1024 * 1024
/** Most roles a --from chart may hold (the same bound the team files use). */
export const DRAFT_FILE_MAX_ROLES = TEAM_FILES_MAX_ROLES

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/**
 * The roles of a previously printed draft (`org draft --output-format json`, or just its `draft` / `roles`), checked as
 * untrusted input: a size and count bound, the fields a role cannot work without, unique ids and slugs, and no control
 * characters in ids, slugs or names. The host cleans the rest when the chart is saved (projects:save). Pure.
 */
export function parseDraftFile(text: string): { roles: Role[]; rationale: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new CliError('The draft file is not valid JSON.', EXIT.usage)
  }
  const draft = isObj(raw) && isObj(raw.draft) ? raw.draft : raw
  const list = Array.isArray(draft) ? draft : isObj(draft) ? draft.roles : undefined
  if (!Array.isArray(list)) throw new CliError('The draft file holds no roles: expected the JSON that "orgai org draft --output-format json" printed.', EXIT.usage)
  if (list.length === 0) throw new CliError('The draft file holds no roles.', EXIT.usage)
  if (list.length > DRAFT_FILE_MAX_ROLES) throw new CliError(`The draft file holds more than ${DRAFT_FILE_MAX_ROLES} roles.`, EXIT.usage)
  const ids = new Set<string>()
  const slugs = new Set<string>()
  list.forEach((r, i) => {
    const at = `Role ${i + 1} of the draft file`
    if (!isObj(r)) throw new CliError(`${at} is not an object.`, EXIT.usage)
    for (const k of ['id', 'slug', 'name'] as const) {
      const v = r[k]
      if (typeof v !== 'string' || v.trim() === '' || v.length > ARG_MAX_CHARS || CONTROL.test(v)) throw new CliError(`${at} has no valid ${k}.`, EXIT.usage)
    }
    if (typeof r.prompt !== 'string') throw new CliError(`${at} has no prompt.`, EXIT.usage)
    if (!Array.isArray(r.tools) || r.tools.some((t) => typeof t !== 'string')) throw new CliError(`${at} has no valid tools list.`, EXIT.usage)
    if (typeof r.model !== 'string') throw new CliError(`${at} has no model.`, EXIT.usage)
    if (r.reportsTo !== null && r.reportsTo !== undefined && typeof r.reportsTo !== 'string') throw new CliError(`${at} has an invalid reportsTo.`, EXIT.usage)
    if (ids.has(r.id as string) || slugs.has(r.slug as string)) throw new CliError(`${at} repeats an id or slug.`, EXIT.usage)
    ids.add(r.id as string)
    slugs.add(r.slug as string)
  })
  const rationale = isObj(draft) && typeof draft.rationale === 'string' ? draft.rationale : ''
  return { roles: list as Role[], rationale }
}

/** The chart that results from applying `drafted` over `current`: replace = the draft, merge = drafted roles replace the ones with their slug and the rest are kept. Pure. */
export function applyDraftRoles(current: readonly Role[], drafted: readonly Role[], mode: 'replace' | 'merge'): Role[] {
  if (mode === 'replace') return drafted.map((r) => ({ ...r }))
  const bySlug = new Map(current.map((r) => [r.slug, r]))
  const usedIds = new Set(current.map((r) => r.id))
  const remap = new Map<string, string>()
  const incoming = drafted.map((r) => {
    const match = bySlug.get(r.slug)
    if (match) {
      remap.set(r.id, match.id)
      return { ...r, id: match.id }
    }
    if (usedIds.has(r.id)) {
      let n = 2
      while (usedIds.has(`${r.id}-${n}`)) n++
      remap.set(r.id, `${r.id}-${n}`)
      return { ...r, id: `${r.id}-${n}` }
    }
    usedIds.add(r.id)
    return { ...r }
  })
  const fixed = incoming.map((r) => ({
    ...r,
    reportsTo: r.reportsTo ? (remap.get(r.reportsTo) ?? r.reportsTo) : r.reportsTo,
    spawnable: Array.isArray(r.spawnable) ? r.spawnable.map((id) => remap.get(id) ?? id) : r.spawnable
  }))
  const replaced = new Set(fixed.map((r) => r.id))
  const kept = current.filter((r) => !replaced.has(r.id))
  return [...kept, ...fixed]
}

/** One factual sentence when the new chart can spend more than the current one (a role above the current highest tier, or staffing newly switched on), else undefined. Pure. */
export function spendNote(current: readonly Role[], next: readonly Role[], project: Pick<Project, 'staffing'>): string | undefined {
  const tiers = (roles: readonly Role[]): ModelTier[] => roles.map(roleTierWord).filter((t): t is ModelTier => isModelTier(t))
  const have = tiers(current)
  const top = have.reduce<ModelTier | undefined>((best, t) => (best === undefined || compareTier(t, best) > 0 ? t : best), undefined)
  const above = tiers(next).some((t) => top === undefined || compareTier(t, top) > 0)
  const wasAuto = new Set(current.filter((r) => r.staffing?.mode === 'auto').map((r) => r.slug))
  const staffingOn = staffingModeOf(project) !== 'fixed' && next.some((r) => r.staffing?.mode === 'auto' && !wasAuto.has(r.slug))
  if (!above && !staffingOn) return undefined
  return 'The new chart may spend more than the current one: it adds roles above the current highest tier or switches staffing on.'
}

function draftLines(roles: readonly Role[]): string[] {
  return roleTree(roles).map(({ role, depth }) => `${'  '.repeat(depth + 1)}${safeLine(role.name)} [${safeLine(role.slug)}] · ${safeLine(roleTierWord(role))} · ${safeLine(role.description)}`)
}

const orgDraft: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, {
    mode: { type: 'string' },
    apply: { type: 'boolean' },
    from: { type: 'string' },
    yes: { type: 'boolean', short: 'y' }
  })
  const apply = values.apply === true
  const instruction = positionals.join(' ').trim()
  const from = values.from
  if (from !== undefined) {
    if (instruction) throw new CliError(`Use either a description or --from. Usage: orgai ${DRAFT_USAGE}`, EXIT.usage)
    if (!apply) throw new CliError('--from only makes sense with --apply: it saves a chart drafted earlier.', EXIT.usage)
  } else if (!instruction) throw new CliError('Describe the team to draft: orgai org draft "<description>".', EXIT.usage)
  if (instruction.length > 4000) throw new CliError('The description is longer than 4000 characters.', EXIT.usage)
  const mode = values.mode
  if (mode !== undefined && mode !== 'replace' && mode !== 'revise' && !(apply && mode === 'merge')) {
    throw new CliError(apply ? '--mode must be replace or merge.' : '--mode must be replace or revise.', EXIT.usage)
  }
  if (values.yes && !apply) throw new CliError('--yes confirms --apply; there is nothing to confirm without it.', EXIT.usage)
  // With --apply, --mode picks how the chart is saved: merge, else replace (the default). A drafted chart revises the
  // current one unless --mode replace asks for a fresh team.
  const applyMode: 'replace' | 'merge' = mode === 'merge' ? 'merge' : 'replace'
  const draftMode: 'replace' | 'revise' = mode === 'replace' ? 'replace' : 'revise'

  let fromDraft: { roles: Role[]; rationale: string } | undefined
  if (from !== undefined) {
    const file = path.resolve(ctx.cwd, checkArg('--from file', from))
    let text: string
    try {
      const st = fs.statSync(file)
      if (!st.isFile()) throw new CliError(`${safeLine(file)} is not a file.`, EXIT.usage)
      if (st.size > DRAFT_FILE_MAX_BYTES) throw new CliError('The draft file is larger than 2 MB.', EXIT.usage)
      text = fs.readFileSync(file, 'utf8')
    } catch (e) {
      if (e instanceof CliError) throw e
      throw new CliError(`Cannot read ${safeLine(file)}.`, EXIT.usage)
    }
    fromDraft = parseDraftFile(text)
  }

  const scopes: HostScope[] = fromDraft ? ['read', 'configure'] : apply ? ['read', 'operate', 'configure'] : ['read', 'operate']
  return withHost(ctx, scopes, async (client) => {
    const project = await requireProject(ctx, client)
    const draft = fromDraft ?? (await hostCall<DraftResult>(client, 'draft:orgChart', [{ projectId: project.id, instruction, mode: draftMode }], { timeoutMs: LONG_CALL_TIMEOUT_MS }))
    const header = (saved: boolean): string => `Drafted ${draft.roles.length} role${draft.roles.length === 1 ? '' : 's'}${saved ? '' : ' (not saved)'}:`
    if (!apply) {
      emit(ctx, { project: projectJson(project), draft }, () => {
        const lines = [header(false), ...draftLines(draft.roles)]
        if (draft.rationale) lines.push('', safe(draft.rationale))
        return lines
      })
      return EXIT.ok
    }

    const fresh = (await hostCall<Project | null>(client, 'projects:get', [project.id])) ?? project
    const next = applyDraftRoles(fresh.roles, draft.roles, applyMode)
    const dropped = fresh.roles.filter((r) => !next.some((n) => n.id === r.id))
    const spend = spendNote(fresh.roles, next, fresh)
    printText(ctx, [
      `${fromDraft ? 'Draft file' : 'Draft'} for ${safeLine(project.name)} (${applyMode}): ${draft.roles.length} role${draft.roles.length === 1 ? '' : 's'}; the chart would have ${next.length}.`,
      ...draftLines(draft.roles),
      ...(dropped.length ? [`Drops: ${dropped.map((r) => safeLine(r.name)).join(', ')}`] : []),
      ...(draft.rationale ? ['', safe(draft.rationale)] : []),
      ...(spend ? ['', spend] : [])
    ])
    const question = dropped.length
      ? `Save the drafted chart and drop ${dropped.length} current role(s)? ${NO_UNDO}`
      : `Save the drafted chart as the chart of ${safeLine(project.name)}?`
    if (!(await confirm(ctx, question, !!values.yes))) {
      note(ctx, 'Nothing saved.')
      return EXIT.failure
    }
    const saved = await hostCall<Project>(client, 'projects:save', [{ ...fresh, roles: next }])
    const previousRoles = fresh.roles
    emit(
      ctx,
      { project: projectJson(saved), applied: true, mode: applyMode, roles: saved.roles.length, dropped: dropped.map((r) => r.id), previousRoles, ...(spend ? { spendNote: spend } : {}) },
      () => [
        `Saved the drafted chart; the chart now has ${saved.roles.length} role${saved.roles.length === 1 ? '' : 's'}.`,
        `${NO_UNDO_AFTER} The previous chart had ${previousRoles.length} role${previousRoles.length === 1 ? '' : 's'}.`
      ]
    )
    return EXIT.ok
  })
}

// ---------- org revise ----------

export const REVISE_NO_TTY_MESSAGE =
  'orgai org revise needs a terminal: the Architect session lives inside this orgai and ends with it. From a script, use orgai org draft "<description>" --apply --yes, or revise with the Architect in the desktop app.'

const orgRevise: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { inline: { type: 'boolean' }, 'ax-screen-reader': { type: 'boolean' } })
  const instruction = positionals.join(' ').trim()
  if (!instruction) throw new CliError('Say what to change: orgai org revise "<instruction>".', EXIT.usage)
  if (instruction.length > 4000) throw new CliError('The instruction is longer than 4000 characters.', EXIT.usage)
  if (CONTROL.test(instruction.replace(/[\n\t]/g, ' '))) throw new CliError('The instruction holds control characters.', EXIT.usage)
  const managed = managedOf(ctx)
  if (managed) throw new CliError(worktreeRefusal(managed.mainCheckout), EXIT.usage)
  if (!hasTty(ctx) || isJsonOutput(ctx)) throw new CliError(REVISE_NO_TTY_MESSAGE, EXIT.usage)
  const project = await withHost(ctx, ['read'], (client) => requireProject(ctx, client))
  return runInteractiveRun(
    ctx,
    {
      channel: 'setup:start',
      input: { projectId: project.id, instruction },
      label: 'Architect revision',
      noTtyMessage: REVISE_NO_TTY_MESSAGE
    },
    { inline: !!values.inline, screenReader: !!values['ax-screen-reader'] }
  )
}

// ---------- Team assistant ----------

function progressLine(p: CapabilityProgressEvent): string {
  const count = typeof p.count === 'number' ? ` (${p.count})` : ''
  const msg = p.message ? `: ${safeLine(p.message)}` : ''
  return `${safeLine(p.phase)} ${safeLine(p.state)}${count}${msg}`
}

/**
 * Run one long capabilities call while printing its capabilities:progress events (stderr in text mode, one record per
 * line in stream-json). SIGINT / SIGTERM sends capabilities:cancel for the request id and resolves 'interrupted'.
 */
export async function withCapabilityProgress<T>(
  ctx: CliContext,
  client: HostClient,
  requestId: string,
  call: () => Promise<T>
): Promise<T | 'interrupted'> {
  const off = await subscribeTopics(client, ['capabilities'], (channel, payload) => {
    if (channel !== 'capabilities:progress') return
    const p = (Array.isArray(payload) ? payload[0] : payload) as CapabilityProgressEvent | undefined
    if (!p || typeof p !== 'object' || p.requestId !== requestId) return
    if (ctx.globals.outputFormat === 'stream-json') emitLine(ctx, { type: 'progress', phase: p.phase, state: p.state, count: p.count, message: p.message })
    else note(ctx, progressLine(p))
  })
  let offSignal: () => void = () => {}
  const interrupted = new Promise<'interrupted'>((resolve) => {
    offSignal = ctx.signals.onInterrupt(() => resolve('interrupted'))
  })
  try {
    const pending = call()
    pending.catch(() => {})
    const r = await Promise.race([pending, interrupted])
    if (r === 'interrupted') {
      await client.call('capabilities:cancel', [{ requestId }]).catch(() => undefined)
      note(ctx, 'Cancelled.')
    }
    return r
  } finally {
    off()
    offSignal()
  }
}

function itemLine(item: CapabilityItem): string {
  const target = item.target ? ` · ${safeLine(item.target)}` : ''
  const where = item.inProject ? ' · already in this project' : ''
  const blocked = item.blockedReason ? ` · blocked: ${safeLine(item.blockedReason)}` : ''
  return `  ${item.kind.padEnd(9)} ${safeLine(item.name)} (${safeLine(item.sourceLabel)})${target}${where}${blocked}  [${item.id}]`
}

function recommendationLines(recs: readonly CapabilityRecommendation[], discovery: CapabilityDiscovery, roles: readonly Role[]): string[] {
  const items = new Map(discovery.items.map((i) => [i.id, i]))
  const roleName = (id: string): string => safeLine(roles.find((r) => r.id === id)?.name ?? id)
  const out: string[] = []
  for (const r of recs) {
    const item = items.get(r.candidateId)
    out.push(`  ${r.id}  ${r.kind} ${safeLine(item?.name ?? r.candidateId)} -> ${r.roleIds.map(roleName).join(', ') || 'no role'} (${r.access} access)`)
    if (item?.target) out.push(`      target: ${safeLine(item.target)}`)
    if (item?.blockedReason) out.push(`      blocked: ${safeLine(item.blockedReason)}`)
    if (item?.needsSecrets.length) out.push(`      needs: ${item.needsSecrets.map(safeLine).join(', ')}`)
    if (r.reason) out.push(`      why: ${safeLine(r.reason)}`)
    out.push(`      candidate: ${r.candidateId}`)
  }
  return out
}

const orgDiscover: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { outside: { type: 'boolean' }, query: { type: 'string' } })
  onlyPositionals(positionals, 0, 'org discover [--outside]')
  return withHost(ctx, ['read', 'operate'], async (client) => {
    const project = await requireProject(ctx, client)
    const requestId = newRequestId()
    const input = { projectId: project.id, includeOutside: !!values.outside, requestId, ...(values.query ? { query: values.query.slice(0, 100) } : {}) }
    const r = await withCapabilityProgress(ctx, client, requestId, () => hostCall<CapabilityDiscovery>(client, 'capabilities:discover', [input], { timeoutMs: LONG_CALL_TIMEOUT_MS }))
    if (r === 'interrupted') return EXIT.sigint
    emit(ctx, { project: projectJson(project), discovery: r }, () => [
      `Found ${r.items.length} candidate${r.items.length === 1 ? '' : 's'}${r.partial ? ' (cut short)' : ''}:`,
      ...r.items.map(itemLine),
      ...r.sources.filter((s) => s.message).map((s) => `  ${safeLine(s.label)}: ${safeLine(s.message)}`),
      ...r.warnings.map((w) => `  warning: ${safeLine(w.message)}${w.location ? ` (${safeLine(w.location)})` : ''}`)
    ])
    return EXIT.ok
  })
}

const orgRecommend: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { outside: { type: 'boolean' }, role: { type: 'string' } })
  onlyPositionals(positionals, 0, 'org recommend [--outside] [--role <role>]')
  return withHost(ctx, ['read', 'operate'], async (client) => {
    const project = await requireProject(ctx, client)
    let scope = {}
    if (values.role !== undefined) {
      const role = findRole(project.roles, checkArg('role', values.role))
      if (!role) throw new CliError(`No role "${safeLine(values.role)}" in this project.`, EXIT.usage)
      scope = { roleId: role.id }
    }
    const requestId = newRequestId()
    const input = { projectId: project.id, includeOutside: !!values.outside, requestId, scope }
    const r = await withCapabilityProgress(ctx, client, requestId, () => hostCall<TeamRecommendations>(client, 'capabilities:recommend', [input], { timeoutMs: LONG_CALL_TIMEOUT_MS }))
    if (r === 'interrupted') return EXIT.sigint
    emit(ctx, { project: projectJson(project), recommendations: r }, () => {
      const how = r.mode === 'model' ? `by ${safeLine(r.model ?? 'the model')}` : `by keyword matching${r.fallbackReason ? ` (${r.fallbackReason})` : ''}`
      const lines = [`${r.recommendations.length} recommendation${r.recommendations.length === 1 ? '' : 's'} ${how}${r.partial ? ', cut short' : ''}:`]
      lines.push(...recommendationLines(r.recommendations, r.discovery, project.roles))
      for (const g of r.gaps) lines.push(`  gap: ${safeLine(project.roles.find((x) => x.id === g.roleId)?.name ?? g.roleId)}: ${safeLine(g.need)}`)
      if (r.recommendations.length) lines.push('Apply one with: orgai org apply <recommendationId>')
      return lines
    })
    return EXIT.ok
  })
}

function reviewLines(review: TeamReview, roles: readonly Role[]): string[] {
  const lines = [
    `Checked ${safeLine(review.checkedAt)} (${review.trigger}, ${review.mode === 'model' ? 'with the model' : 'token-free'}${review.modelSkipped ? `; model step skipped: ${review.modelSkipped}` : ''})`,
    `${review.pendingCount} pending recommendation${review.pendingCount === 1 ? '' : 's'}:`,
    ...recommendationLines(review.recommendations, review.discovery, roles)
  ]
  for (const g of review.gaps) lines.push(`  gap: ${safeLine(roles.find((x) => x.id === g.roleId)?.name ?? g.roleId)}: ${safeLine(g.need)}`)
  if (review.evidence.length) {
    lines.push('Evidence from runs:')
    for (const e of review.evidence) lines.push(`  ${e.kind} x${e.count}: ${safeLine(e.summary)}`)
  }
  if (review.dismissed.length) {
    lines.push(`Dismissed (${review.dismissed.length}):`)
    for (const d of review.dismissed) lines.push(`  ${safeLine(d.name ?? d.candidateId)}  [${d.candidateId}]`)
  }
  if (typeof review.tokensUsed === 'number') lines.push(`Tokens used by the last model step: ${review.tokensUsed}`)
  return lines
}

const orgReview: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { recheck: { type: 'boolean' }, outside: { type: 'boolean' }, model: { type: 'boolean' } })
  onlyPositionals(positionals, 0, 'org review [--recheck [--outside] [--model]]')
  if (!values.recheck && (values.outside || values.model)) throw new CliError('--outside and --model go with --recheck.', EXIT.usage)
  return withHost(ctx, values.recheck ? ['read', 'operate'] : ['read'], async (client) => {
    const project = await requireProject(ctx, client)
    let review: TeamReview | null
    if (values.recheck) {
      const requestId = newRequestId()
      const input = { projectId: project.id, trigger: 'manual', requestId, includeOutside: !!values.outside, useModel: !!values.model }
      const r = await withCapabilityProgress(ctx, client, requestId, () => hostCall<TeamReview>(client, 'capabilities:review', [input], { timeoutMs: LONG_CALL_TIMEOUT_MS }))
      if (r === 'interrupted') return EXIT.sigint
      review = r
    } else {
      review = await hostCall<TeamReview | null>(client, 'capabilities:lastReview', [project.id])
    }
    emit(ctx, { project: projectJson(project), review }, () =>
      review ? reviewLines(review, project.roles) : 'No Team review yet. Run `orgai org review --recheck` or `orgai org recommend`.'
    )
    return EXIT.ok
  })
}

const STALE_CAPABILITY = /out of date|run (them|the recommendations) again|cut short/i

const orgApply: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, {
    candidate: { type: 'string' },
    role: { type: 'string', multiple: true },
    access: { type: 'string' }
  })
  onlyPositionals(positionals, 1, 'org apply <recommendationId> [--candidate <id>] [--role <role>...] [--access read|full]')
  const recommendationId = positionals[0] !== undefined ? checkArg('recommendation id', positionals[0]) : undefined
  const candidateId = values.candidate !== undefined ? checkArg('candidate id', values.candidate) : undefined
  if (!recommendationId && !candidateId) throw new CliError('Name a recommendation: orgai org apply <recommendationId> (or --candidate <id> with --role).', EXIT.usage)
  const access = values.access
  if (access !== undefined && access !== 'read' && access !== 'full') throw new CliError('--access must be read or full.', EXIT.usage)
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const review = await hostCall<TeamReview | null>(client, 'capabilities:lastReview', [project.id])
    if (!review) throw new CliError('No recommendations to apply yet. Run `orgai org recommend` first.', EXIT.usage)
    const rec = recommendationId ? review.recommendations.find((r) => r.id === recommendationId) : undefined
    if (recommendationId && !rec && !candidateId) throw new CliError(`Recommendation ${safeLine(recommendationId)} is not pending. Run \`orgai org recommend\` again.`, EXIT.failure)
    let roleIds: string[]
    if (values.role?.length) {
      roleIds = values.role.map((ref) => {
        const role = findRole(project.roles, checkArg('role', ref))
        if (!role) throw new CliError(`No role "${safeLine(ref)}" in this project.`, EXIT.usage)
        return role.id
      })
    } else if (rec) roleIds = rec.roleIds
    else throw new CliError('Name the roles that get it with --role <role>.', EXIT.usage)
    const input: CapabilityApplyInput = {
      projectId: project.id,
      digest: review.digest,
      roleIds: [...new Set(roleIds)],
      ...(recommendationId ? { recommendationId } : {}),
      ...((candidateId ?? rec?.candidateId) ? { candidateId: candidateId ?? rec?.candidateId } : {}),
      ...(access ? { access } : {})
    }
    let res: CapabilityApplyResult
    try {
      res = await client.call<CapabilityApplyResult>('capabilities:apply', [input])
    } catch (e) {
      const err = hostError(e)
      if (STALE_CAPABILITY.test(err.message)) throw new CliError(err.message, EXIT.failure)
      throw err
    }
    emit(ctx, { project: projectJson(project), applied: res.applied, undoId: res.undoId, needsSetup: res.needsSetup ?? null, notes: res.notes }, () => {
      const a = res.applied
      const lines = [`${a.action === 'added' ? 'Added' : a.action === 'linked' ? 'Linked' : 'Granted'} ${a.kind} ${safeLine(a.name)} (${a.access} access).`]
      if (res.needsSetup) {
        const s = res.needsSetup
        if (s.secrets.length) lines.push(`It needs values before runs get it: ${s.secrets.map(safeLine).join(', ')}.`)
        if (s.signIn) lines.push('It needs a sign-in before runs get it (orgai mcp auth).')
      }
      for (const n of res.notes) lines.push(`note: ${safeLine(n)}`)
      lines.push(`Undo with: orgai org undo ${res.undoId}`)
      return lines
    })
    return EXIT.ok
  })
}

const orgUndo: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 1, 'org undo <undoId>')
  const undoId = checkArg('undo id (printed by orgai org apply)', positionals[0])
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    await hostCall(client, 'capabilities:undo', [{ projectId: project.id, undoId }])
    emit(ctx, { project: projectJson(project), undone: undoId }, () => 'Undone.')
    return EXIT.ok
  })
}

const orgDismiss: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { candidate: { type: 'boolean' } })
  onlyPositionals(positionals, 1, 'org dismiss <id> [--candidate]')
  const id = checkArg(values.candidate ? 'candidate id' : 'recommendation id', positionals[0])
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const input = { projectId: project.id, ...(values.candidate ? { candidateId: id } : { recommendationId: id }) }
    const review = await hostCall<TeamReview>(client, 'capabilities:dismiss', [input])
    emit(ctx, { project: projectJson(project), dismissed: id, pendingCount: review.pendingCount }, () => `Dismissed. ${review.pendingCount} pending.`)
    return EXIT.ok
  })
}

const orgRestore: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 1, 'org restore <candidateId>')
  const candidateId = checkArg('candidate id', positionals[0])
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const review = await hostCall<TeamReview>(client, 'capabilities:restore', [{ projectId: project.id, candidateId }])
    emit(ctx, { project: projectJson(project), restored: candidateId, pendingCount: review.pendingCount }, () => `Restored. ${review.pendingCount} pending.`)
    return EXIT.ok
  })
}
