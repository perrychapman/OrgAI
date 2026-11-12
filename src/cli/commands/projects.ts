/**
 * `orgai projects <list|show|check|create|set|remove|save-chat|trust>` (cli-spec 6.3, Wave 5; trust cli-parity 3.4).
 *
 * Reads take ['read']; create, set, remove and save-chat take ['read', 'configure']. Every project name, path, client
 * and host message is untrusted text and goes through safe / safeLine before any styling. projects:save has no
 * compare-and-set: `set` reads the project, changes the asked fields and saves the whole object, so a Desktop edit made
 * in between is overwritten (a known limit). Cleared fields are sent as null (the JSON codec's clearable Project
 * fields, jsonCodec PROJECT_CLEARABLE), which the host decodes to an own undefined.
 */
import { basename, resolve as resolvePath } from 'node:path'
import {
  MAX_CONCURRENT_SUBAGENTS_LIMIT,
  MAX_SUBAGENT_DEPTH_LIMIT,
  effectiveSubagentLimits,
  isolateWritersOn,
  planGuardOf,
  projectConnection,
  projectKindLabel,
  projectKindOf,
  reviewPolicyOf,
  runMessagingOn,
  staffingGoalOf,
  staffingModeOf
} from '../../shared/defaults'
import {
  DEFAULT_KEEP_RUNS,
  DEFAULT_MAX_AUTO_CONTINUES,
  REVIEW_POLICIES,
  STAFFING_GOALS,
  STAFFING_MODES,
  isReviewPolicy,
  isStaffingGoal,
  isStaffingMode,
  isVirtualProjectId,
  type AgentImportSource,
  type FolderConfigReview,
  type OrgTemplateInfo,
  type Project,
  type ProjectCreateInput,
  type ProjectKind,
  type ProjectPathCheck,
  type ProjectRemoveResult,
  type QuickRunPromoteResult,
  type RemapModelsInput,
  type RemapModelsOutput,
  type RemapResult,
  type RunSummary
} from '../../shared/types'
import { resolveProject } from '../client/resolveProject'
import { folderTrustLines, NO_APPROVE_COMMAND, TRUST_WHERE } from '../approvalText'
import { connectionArg, labelOfId } from './connections'
import { parseFlags } from '../flags'
import { confirm, hostCall, requireProject, runSubcommands, withHost } from '../manage'
import { emit, isJsonOutput, plural, safe, safeLine, styleFor, table, termWidth, type Json } from '../output'
import { checkProjectResolution, liveSource, openReadSource, resolveRunFromSource } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn, type HostClient } from '../types'

const READ = ['read'] as const
const CONFIGURE = ['read', 'configure'] as const

const usage = (message: string): CliError => new CliError(message, EXIT.usage)
const USAGE = 'projects <list|show|check|create|set|remove|save-chat|trust> [options]'

// ---------- Shared helpers (also used by commands/init.ts) ----------

/** --kind: code | engagement; anything else is exit 2. */
export function parseKind(v: string | undefined): ProjectKind | undefined {
  if (v === undefined) return undefined
  if (v === 'code' || v === 'engagement') return v
  throw usage('--kind must be one of code, engagement.')
}

/** The folder argument as an absolute path (default: the current folder). */
export function folderArg(ctx: CliContext, folder: string | undefined): string {
  if (folder !== undefined && !folder.trim()) throw usage('Give a folder path.')
  return resolvePath(ctx.cwd, folder ?? '.')
}

/** The host's projects:list without virtual projects. */
async function listProjects(client: HostClient): Promise<Project[]> {
  const list = await hostCall<Project[]>(client, 'projects:list', [])
  return (Array.isArray(list) ? list : []).filter((p) => p && typeof p.id === 'string' && !isVirtualProjectId(p.id))
}

/** A positional <id-or-path>, else --project / the cwd project (exit 2 when none matches). */
async function projectFromArg(ctx: CliContext, client: HostClient, arg: string | undefined): Promise<Project> {
  if (arg === undefined) return requireProject(ctx, client)
  const list = await listProjects(client)
  const res = resolveProject(list, { flag: arg, cwd: ctx.cwd, platform: ctx.platform })
  if (!res.project) throw usage(safeLine(res.error ?? `No OrgAI project matches ${arg}.`))
  return res.project
}

/** projects:get (a fresh copy); a missing project is exit 1. */
async function getProject(client: HostClient, id: string): Promise<Project> {
  const p = await hostCall<Project | null>(client, 'projects:get', [id])
  if (!p || typeof p !== 'object') throw new CliError('That project is gone.', EXIT.failure)
  return p
}

export interface CreateOptions {
  name?: string
  kind?: ProjectKind
  brief?: string
  client?: string
  template?: string
  importAgents?: boolean
}

/** Flag combinations refused before any host starts (exit 2). */
export function checkCreateOptions(o: CreateOptions): void {
  if (o.importAgents && o.template !== undefined) throw usage('Use --import-agents or --template, not both.')
  if (o.client !== undefined && o.kind !== 'engagement') throw usage('--client applies to engagements: add --kind engagement.')
  if (o.name !== undefined && !o.name.trim()) throw usage('--name needs a project name.')
  if (o.template !== undefined && !o.template.trim()) throw usage('--template needs a template id (orgai team templates list).')
}

/** The CREATE_FLAGS shared by `projects create` and `orgai init`. */
export const CREATE_FLAGS = {
  name: { type: 'string' },
  kind: { type: 'string' },
  brief: { type: 'string' },
  client: { type: 'string' },
  template: { type: 'string' },
  'import-agents': { type: 'boolean' }
} as const

export function createOptionsOf(v: { name?: string; kind?: string; brief?: string; client?: string; template?: string; 'import-agents'?: boolean }): CreateOptions {
  const o: CreateOptions = {
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.kind !== undefined ? { kind: parseKind(v.kind) } : {}),
    ...(v.brief !== undefined ? { brief: v.brief } : {}),
    ...(v.client !== undefined ? { client: v.client } : {}),
    ...(v.template !== undefined ? { template: v.template } : {}),
    ...(v['import-agents'] ? { importAgents: true } : {})
  }
  checkCreateOptions(o)
  return o
}

/** projects:checkPath for an absolute folder. */
export async function checkFolder(client: HostClient, folder: string): Promise<ProjectPathCheck> {
  return hostCall<ProjectPathCheck>(client, 'projects:checkPath', [folder])
}

/**
 * Create the project in `folder` (checked already): exit 2 for a missing folder, --import-agents with nothing found
 * or an unknown --template; exit 1 when the folder is already a project. mock only with ORGAI_MOCK=1 (as exec.ts).
 * --client is applied with a follow-up projects:get + projects:save.
 */
export async function createProjectIn(ctx: CliContext, client: HostClient, folder: string, check: ProjectPathCheck, o: CreateOptions): Promise<Project> {
  if (check.existingProjectId) {
    throw new CliError(`This folder is already the OrgAI project "${safeLine(check.existingProjectName ?? check.existingProjectId)}" (${safeLine(check.existingProjectId)}).`, EXIT.failure)
  }
  if (!check.exists) throw usage(`No folder at ${safeLine(folder)}.`)
  if (!check.isDirectory) throw usage(`${safeLine(folder)} is not a folder.`)
  let importAgents: AgentImportSource[] | undefined
  if (o.importAgents) {
    importAgents = [...new Set((check.agentSources ?? []).map((s) => s.source))]
    if (importAgents.length === 0) throw usage('No agent definitions were found in this folder to import (orgai projects check shows what was found).')
  }
  if (o.template !== undefined) {
    const templates = await hostCall<OrgTemplateInfo[]>(client, 'templates:list', [])
    if (!(Array.isArray(templates) ? templates : []).some((t) => t.id === o.template)) {
      throw usage(`No team template "${safeLine(o.template)}". List them with: orgai team templates list`)
    }
  }
  const name = (o.name ?? '').trim() || check.suggestedName || basename(folder) || 'Project'
  const input: ProjectCreateInput = {
    name,
    path: folder,
    brief: o.brief ?? '',
    kind: o.kind ?? 'code',
    ...(ctx.env.ORGAI_MOCK === '1' ? { mock: true } : {}),
    ...(importAgents ? { importAgents } : {}),
    ...(o.template !== undefined ? { templateId: o.template } : {})
  }
  let project = await hostCall<Project>(client, 'projects:create', [input])
  if (o.client !== undefined && o.client.trim()) {
    const fresh = await getProject(client, project.id)
    project = await hostCall<Project>(client, 'projects:save', [{ ...fresh, client: o.client.trim() }])
  }
  return project
}

// ---------- Rendering ----------

const onOff = (b: boolean): string => (b ? 'on' : 'off')
const usd = (n: number): string => `$${n.toFixed(2)}`

/** The JSON shape of a project's settings that `show` and `set` print (effective values plus what is explicit). */
export function projectFacts(p: Project): Json {
  const limits = effectiveSubagentLimits(p)
  return {
    id: p.id,
    name: p.name,
    kind: projectKindOf(p),
    path: p.path,
    ...(p.client ? { client: p.client } : {}),
    connection: projectConnection(p),
    permissionMode: p.permissionMode,
    maxBudgetUsd: typeof p.maxBudgetUsd === 'number' && p.maxBudgetUsd > 0 ? p.maxBudgetUsd : null,
    limits: { depth: limits.depth, concurrency: limits.concurrency, explicit: limits.explicit },
    planGuard: planGuardOf(p),
    autoContinue: p.autoContinue !== false,
    maxAutoContinues: p.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES,
    runMessaging: runMessagingOn(p),
    isolateWriters: isolateWritersOn(p),
    staffing: staffingModeOf(p),
    staffingGoal: staffingGoalOf(p),
    reviewPolicy: reviewPolicyOf(p),
    reviewMerges: p.reviewMerges === true,
    maxWindowShare: typeof p.maxWindowShare === 'number' && p.maxWindowShare > 0 ? p.maxWindowShare : null,
    keepRuns: p.keepRuns ?? DEFAULT_KEEP_RUNS,
    brief: p.brief ?? '',
    roles: Array.isArray(p.roles) ? p.roles.length : 0,
    mcpServers: p.mcpServers?.length ?? 0,
    skills: p.skills?.length ?? 0,
    allowedDirectories: p.allowedDirectories ?? [],
    referenceDirectories: p.referenceDirectories ?? []
  }
}

/** Text lines of a project's settings (every string sanitized). */
export function projectLines(ctx: CliContext, p: Project): string[] {
  const st = styleFor(ctx)
  const kind = projectKindOf(p)
  const limits = effectiveSubagentLimits(p)
  const lim = (n: number, explicit: boolean): string => (explicit ? String(n) : `Automatic (${n})`)
  const lines = [
    `${st.bold(safeLine(p.name))}  ${st.dim(projectKindLabel(kind))}`,
    `  Folder:          ${safeLine(p.path)}`,
    `  Id:              ${safeLine(p.id)}`
  ]
  if (kind === 'engagement') lines.push(`  Client:          ${p.client ? safeLine(p.client) : st.dim('not set')}`)
  const guard = planGuardOf(p)
  lines.push(
    `  Connection:      ${safeLine(projectConnection(p))}${p.provider?.label ? ` (${safeLine(p.provider.label)})` : ''}`,
    `  Permission mode: ${safeLine(p.permissionMode)}`,
    `  Budget per run:  ${typeof p.maxBudgetUsd === 'number' && p.maxBudgetUsd > 0 ? usd(p.maxBudgetUsd) : 'no cap'}`,
    `  Subagent depth:  ${lim(limits.depth, limits.explicit.depth)}`,
    `  Concurrent:      ${lim(limits.concurrency, limits.explicit.concurrency)}`,
    `  Plan guard:      ${guard === 'auto' ? 'Automatic' : guard === 'on' ? 'On' : 'Off'}`,
    `  Auto-continue:   ${onOff(p.autoContinue !== false)} (at most ${p.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES})`,
    `  Run messaging:   ${onOff(runMessagingOn(p))}`,
    `  Isolate writers: ${onOff(isolateWritersOn(p))}`,
    `  Review merges:   ${onOff(p.reviewMerges === true)}`,
    `  Staffing:        ${staffingModeOf(p) === 'auto' ? 'Automatic' : 'Fixed'}`,
    `  Staffing goal:   ${staffingGoalOf(p)}`,
    `  Review policy:   ${reviewPolicyOf(p)}`,
    `  Window share:    ${typeof p.maxWindowShare === 'number' && p.maxWindowShare > 0 ? `${p.maxWindowShare}% of the five-hour window per run` : 'off'}`,
    `  Runs kept:       ${p.keepRuns === undefined ? `Automatic (${DEFAULT_KEEP_RUNS})` : String(p.keepRuns)}`,
    `  Team:            ${plural(Array.isArray(p.roles) ? p.roles.length : 0, 'role')}, ${plural(p.mcpServers?.length ?? 0, 'MCP server')}, ${plural(p.skills?.length ?? 0, 'skill')}`
  )
  const brief = (p.brief ?? '').trim()
  lines.push(`  Brief:           ${brief ? '' : st.dim('not set')}`.trimEnd())
  if (brief) for (const l of safe(brief.length > 1000 ? `${brief.slice(0, 1000)}...` : brief).split('\n')) lines.push(`    ${l}`)
  const folders = (label: string, list: string[] | undefined): void => {
    if (!list?.length) return
    lines.push(`  ${label}`)
    for (const d of list) lines.push(`    ${safeLine(d)}`)
  }
  folders('Allowed folders:', p.allowedDirectories)
  folders('Reference folders (read only):', p.referenceDirectories)
  return lines
}

// ---------- list / show / check ----------

const runList: CommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  if (positionals.length) throw usage('Use: orgai projects list')
  {
    // Read from the saved files: no host, no write (cli-standalone-default.md 4.3).
    const src = await openReadSource(ctx)
    const list = (await src.projects()).filter((p) => !isVirtualProjectId(p.id))
    const rows = list.map((p) => ({ id: p.id, name: p.name, kind: projectKindOf(p), ...(p.client ? { client: p.client } : {}), path: p.path }))
    emit(ctx, { projects: rows }, () => {
      if (!list.length) return 'No projects yet. Create one with: orgai init'
      const st = styleFor(ctx)
      return table(
        [{ header: 'NAME' }, { header: 'KIND' }, { header: 'CLIENT' }, { header: 'FOLDER', flex: true, ellipsis: 'middle' }, { header: 'ID', min: 8 }],
        list.map((p) => [safeLine(p.name), projectKindLabel(projectKindOf(p)), safeLine(p.client ?? ''), safeLine(p.path), safeLine(p.id)]),
        termWidth(ctx),
        st
      )
    })
    return EXIT.ok
  }
}

const runShow: CommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  if (positionals.length > 1) throw usage('Use: orgai projects show [<id-or-path>]')
  const src = await openReadSource(ctx)
  const list = (await src.projects()).filter((p) => !isVirtualProjectId(p.id))
  let p: Project
  if (positionals[0] === undefined) {
    const res = ctx.resolveProject(list)
    checkProjectResolution(res)
    if (!res.project) throw usage('No OrgAI project here. Run this inside a project folder or pass --project <id-or-path>.')
    p = res.project
  } else {
    const res = resolveProject(list, { flag: positionals[0], cwd: ctx.cwd, platform: ctx.platform })
    if (!res.project) throw usage(safeLine(res.error ?? `No OrgAI project matches ${positionals[0]}.`))
    p = res.project
  }
  emit(ctx, { project: projectFacts(p) }, () => projectLines(ctx, p))
  return EXIT.ok
}

/** Text lines of a projects:checkPath answer. */
export function checkLines(ctx: CliContext, folder: string, c: ProjectPathCheck): string[] {
  const st = styleFor(ctx)
  const lines = [`${st.bold(safeLine(folder))}`]
  lines.push(`  Exists:          ${c.exists ? (c.isDirectory ? 'yes (a folder)' : 'yes (not a folder)') : 'no'}`)
  if (c.exists && c.isDirectory) lines.push(`  Git repository:  ${c.isGitRepo ? 'yes' : 'no'}${c.empty ? ' (empty folder)' : ''}`)
  if (c.suggestedName) lines.push(`  Suggested name:  ${safeLine(c.suggestedName)}`)
  if (c.existingProjectId) lines.push(`  Already a project: ${safeLine(c.existingProjectName ?? '')} (${safeLine(c.existingProjectId)})`)
  if (c.agentSources?.length) {
    lines.push('  Agent definitions:')
    for (const s of c.agentSources) lines.push(`    ${safeLine(s.label)}: ${plural(s.agentCount, 'agent')} (${safeLine(s.source)})`)
  }
  if (c.instructionFiles?.length) lines.push(`  Instruction files: ${c.instructionFiles.map((f) => safeLine(f)).join(', ')}`)
  return lines
}

const runCheck: CommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  if (positionals.length > 1) throw usage('Use: orgai projects check [<folder>]')
  const folder = folderArg(ctx, positionals[0])
  return withHost(ctx, [...READ], async (client) => {
    const c = await checkFolder(client, folder)
    emit(ctx, { folder, check: c as unknown as Json }, () => checkLines(ctx, folder, c))
    return EXIT.ok
  })
}

// ---------- create ----------

const runCreate: CommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, CREATE_FLAGS)
  if (positionals.length > 1) throw usage('Use: orgai projects create [<folder>] [--name <name>] [--kind code|engagement] [--brief <text>] [--client <name>] [--template <id> | --import-agents]')
  const opts = createOptionsOf(values)
  const folder = folderArg(ctx, positionals[0])
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const check = await checkFolder(client, folder)
    const p = await createProjectIn(ctx, client, folder, check, opts)
    emit(ctx, { project: projectFacts(p) }, () => [`Created ${projectKindLabel(projectKindOf(p)).toLowerCase()} ${safeLine(p.name)} (${safeLine(p.id)}).`, ...projectLines(ctx, p).slice(1)])
    return EXIT.ok
  })
}

// ---------- set ----------

const SET_FLAGS = {
  name: { type: 'string' },
  client: { type: 'string' },
  brief: { type: 'string' },
  'max-budget': { type: 'string' },
  'max-depth': { type: 'string' },
  'max-concurrent': { type: 'string' },
  'plan-guard': { type: 'string' },
  'auto-continue': { type: 'string' },
  'max-auto-continues': { type: 'string' },
  'run-messaging': { type: 'string' },
  'isolate-writers': { type: 'string' },
  staffing: { type: 'string' },
  'staffing-goal': { type: 'string' },
  'review-policy': { type: 'string' },
  'review-merges': { type: 'string' },
  'max-window-share': { type: 'string' },
  'keep-runs': { type: 'string' },
  connection: { type: 'string' },
  yes: { type: 'boolean', short: 'y' }
} as const

type SetValues = Partial<Record<Exclude<keyof typeof SET_FLAGS, 'yes'>, string>>

/** A clearable field's "clear" value on the wire: null (the host decodes it to an own undefined). */
const CLEAR = null

function onOffArg(flag: string, v: string): boolean {
  if (v === 'on') return true
  if (v === 'off') return false
  throw usage(`--${flag} must be on or off.`)
}

function intArg(flag: string, v: string, min: number, max: number, auto = false): number {
  const n = /^\d+$/.test(v.trim()) ? Number(v) : NaN
  if (!(n >= min && n <= max)) throw usage(`--${flag} must be a whole number from ${min} to ${max}${auto ? ', or auto' : ''}.`)
  return n
}

/**
 * The fields `projects set` changes, as sent to projects:save (null = clear). Pure: the flags are checked against the
 * project's kind (--client on a code project is exit 2). Exported for tests.
 */
export function setPatch(project: Project, v: SetValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (v.name !== undefined) {
    const name = v.name.trim()
    if (!name || name.length > 200) throw usage('--name needs a project name of 1 to 200 characters.')
    patch.name = name
  }
  if (v.client !== undefined) {
    if (projectKindOf(project) !== 'engagement') throw usage('--client applies to engagements; this is a code project.')
    patch.client = v.client.trim() ? v.client.trim() : CLEAR
  }
  if (v.brief !== undefined) patch.brief = v.brief
  if (v['max-budget'] !== undefined) {
    const raw = v['max-budget'].trim()
    if (raw === 'none') patch.maxBudgetUsd = CLEAR
    else {
      const n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN
      if (!Number.isFinite(n) || n <= 0) throw usage('--max-budget must be an amount in USD above 0, or none.')
      patch.maxBudgetUsd = n
    }
  }
  if (v['max-depth'] !== undefined) patch.maxSubagentDepth = v['max-depth'].trim() === 'auto' ? CLEAR : intArg('max-depth', v['max-depth'], 1, MAX_SUBAGENT_DEPTH_LIMIT, true)
  if (v['max-concurrent'] !== undefined) {
    patch.maxConcurrentSubagents = v['max-concurrent'].trim() === 'auto' ? CLEAR : intArg('max-concurrent', v['max-concurrent'], 1, MAX_CONCURRENT_SUBAGENTS_LIMIT, true)
  }
  if (v['plan-guard'] !== undefined) {
    const g = v['plan-guard']
    if (g !== 'auto' && g !== 'on' && g !== 'off') throw usage('--plan-guard must be one of auto, on, off.')
    // As Settings > Limits: the setting and its legacy mirror move together; Automatic clears both.
    const value = g === 'auto' ? CLEAR : g === 'on'
    patch.preferEverydayNearLimit = value
    patch.preferSonnetNearLimit = value
  }
  if (v['auto-continue'] !== undefined) patch.autoContinue = onOffArg('auto-continue', v['auto-continue'])
  if (v['max-auto-continues'] !== undefined) patch.maxAutoContinues = intArg('max-auto-continues', v['max-auto-continues'], 0, 1000)
  if (v['run-messaging'] !== undefined) patch.runMessaging = onOffArg('run-messaging', v['run-messaging'])
  if (v['isolate-writers'] !== undefined) patch.isolateWriters = onOffArg('isolate-writers', v['isolate-writers'])
  // Run staffing, as Settings > Limits > Run staffing: the default value clears the field (an own undefined, which the
  // JSON wire drops; these three are not in the codec's null list).
  if (v.staffing !== undefined) {
    if (!isStaffingMode(v.staffing)) throw usage(`--staffing must be one of ${STAFFING_MODES.join(', ')}.`)
    patch.staffing = v.staffing === 'auto' ? undefined : v.staffing
  }
  if (v['staffing-goal'] !== undefined) {
    if (!isStaffingGoal(v['staffing-goal'])) throw usage(`--staffing-goal must be one of ${STAFFING_GOALS.join(', ')}.`)
    patch.staffingGoal = v['staffing-goal'] === 'balanced' ? undefined : v['staffing-goal']
  }
  if (v['review-policy'] !== undefined) {
    if (!isReviewPolicy(v['review-policy'])) throw usage(`--review-policy must be one of ${REVIEW_POLICIES.join(', ')}.`)
    patch.reviewPolicy = v['review-policy'] === 'risk' ? undefined : v['review-policy']
  }
  if (v['review-merges'] !== undefined) patch.reviewMerges = onOffArg('review-merges', v['review-merges'])
  if (v['max-window-share'] !== undefined) {
    // Stored as a percent of the five-hour window (1 to 100), as the desktop Limits field; auto = off.
    const raw = v['max-window-share'].trim().replace(/%$/, '')
    if (raw === 'auto') patch.maxWindowShare = CLEAR
    else {
      const n = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN
      if (!(n >= 1 && n <= 100)) throw usage('--max-window-share must be a percent of the five-hour window from 1 to 100 (not a fraction), or auto.')
      patch.maxWindowShare = n
    }
  }
  if (v['keep-runs'] !== undefined) patch.keepRuns = v['keep-runs'].trim() === 'auto' ? CLEAR : intArg('keep-runs', v['keep-runs'], 1, 5000, true)
  return patch
}

/** One sentence when the patch moves staffing from fixed to automatic (it can raise spend); null otherwise. */
export function staffingSpendSentence(project: Project, patch: Record<string, unknown>): string | null {
  if (!('staffing' in patch) || patch.staffing !== undefined) return null
  if (staffingModeOf(project) !== 'fixed') return null
  return 'Automatic staffing lets each report run at a higher tier or effort than its role is set to, which may spend more.'
}

function connectionPatchArg(project: Project, raw: string): RemapModelsInput | null {
  const to = connectionArg(raw)
  return to === projectConnection(project) ? null : { projectId: project.id, connection: to }
}

const runSet: CommandFn = async (ctx, args) => {
  const { values: all, positionals } = parseFlags(args, SET_FLAGS)
  const { yes, ...values } = all
  if (positionals.length > 1) throw usage('Use: orgai projects set [<id-or-path>] [--name ...] [--max-budget <usd|none>] [--max-depth <n|auto>] ...')
  if (Object.keys(values).length === 0) throw usage(`Nothing to change. Flags: ${Object.keys(SET_FLAGS).filter((f) => f !== 'yes').map((f) => `--${f}`).join(', ')}.`)
  const { connection: connectionFlag, ...fields } = values
  if (connectionFlag !== undefined) connectionArg(connectionFlag) // exit 2 before any host starts
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const found = await projectFromArg(ctx, client, positionals[0])
    const fresh = await getProject(client, found.id)
    const patch = setPatch(fresh, fields)
    const spend = staffingSpendSentence(fresh, patch)
    if (spend && !(await confirm(ctx, `${spend} Switch ${safeLine(fresh.name)} to automatic staffing?`, yes === true))) {
      emit(ctx, { saved: false }, () => 'Nothing changed.')
      return EXIT.failure
    }
    // --connection goes through the preview and remap `orgai models remap --to <id> --apply` uses, never a raw write.
    const remap = connectionFlag !== undefined ? connectionPatchArg(fresh, connectionFlag) : null
    if (remap) {
      const preview = await hostCall<RemapResult>(client, 'projects:previewRemap', [remap])
      if (!isJsonOutput(ctx)) {
        const n = preview.changes.length
        ctx.io.stderr.write(
          `${[
            `${n} role model${n === 1 ? '' : 's'} in ${safeLine(fresh.name)} on ${labelOfId(preview.connection)}:`,
            ...preview.changes.map((c) => `  ${safeLine(fresh.roles.find((r) => r.id === c.roleId)?.name ?? c.roleId)}: ${safeLine(c.from)} -> ${safeLine(c.to)}`)
          ].join('\n')}\n`
        )
      }
      if (!(await confirm(ctx, `Move ${safeLine(fresh.name)} to ${labelOfId(remap.connection!)} and save these models?`, yes === true))) {
        emit(ctx, { saved: false }, () => 'Nothing changed.')
        return EXIT.failure
      }
    }
    let saved = fresh
    if (Object.keys(patch).length) saved = await hostCall<Project>(client, 'projects:save', [{ ...fresh, ...patch }])
    if (remap) saved = (await hostCall<RemapModelsOutput>(client, 'projects:remapModels', [remap])).project
    emit(ctx, { project: projectFacts(saved) }, () => [`Saved ${safeLine(saved.name)}.`, ...projectLines(ctx, saved).slice(1)])
    return EXIT.ok
  })
}

// ---------- remove ----------

/** The lines of what removing a project deletes. */
export function removalLines(p: Project, r: ProjectRemoveResult): string[] {
  const lines = [`Removing ${projectKindLabel(r.kind).toLowerCase()} "${safeLine(p.name)}" (${safeLine(p.id)}) deletes:`]
  const add = (n: number, one: string): void => {
    if (n > 0) lines.push(`  ${plural(n, one)}`)
  }
  add(r.runsRemoved, 'run record')
  add(r.notesRemoved, 'context note')
  add(r.skillsRemoved, 'project skill')
  add(r.knowledgeRemoved, 'recorded knowledge item')
  if (r.documentRemoved) lines.push('  the engagement document')
  if (r.rulesRemoved) lines.push('  the saved permission rules')
  if (r.teamReviewRemoved) lines.push('  the Team review')
  if (r.skillEvaluationRemoved) lines.push('  the skill evaluation')
  if (lines.length === 1) lines.push('  only the project entry')
  if (r.runsKept > 0) lines.push(`Kept: ${plural(r.runsKept, 'run record')} (--keep-runs).`)
  lines.push('The folder and its files are not touched.')
  return lines
}

const runRemove: CommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { 'keep-runs': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } })
  if (positionals.length > 1) throw usage('Use: orgai projects remove [<id-or-path>] [--keep-runs] [--yes]')
  const keepRuns = values['keep-runs'] === true
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const p = await projectFromArg(ctx, client, positionals[0])
    const input = { projectId: p.id, removeRuns: !keepRuns }
    const preview = await hostCall<ProjectRemoveResult>(client, 'projects:removePreview', [input])
    const engagement = preview.kind === 'engagement'
    if (!isJsonOutput(ctx)) {
      const lines = removalLines(p, preview)
      if (engagement && keepRuns) lines.push('Engagements always forget their runs; --keep-runs does not apply.')
      ctx.io.stderr.write(`${lines.join('\n')}\n`)
    }
    const yes = await confirm(ctx, `Remove "${safeLine(p.name)}" from OrgAI?`, values.yes === true)
    if (!yes) {
      emit(ctx, { removed: false, preview: preview as unknown as Json }, () => 'Nothing was removed.')
      return EXIT.failure
    }
    const result = await hostCall<ProjectRemoveResult>(client, 'projects:remove', [input])
    emit(ctx, { removed: true, result: result as unknown as Json }, () => {
      const out = [`Removed ${safeLine(p.name)}.`]
      if (result.runsRemoved) out.push(`Deleted ${plural(result.runsRemoved, 'run record')}.`)
      if (result.runsKept) out.push(`Kept ${plural(result.runsKept, 'run record')}.`)
      if (engagement) out.push('Engagements always forget their runs.')
      return out
    })
    return EXIT.ok
  })
}

// ---------- save-chat ----------

const runSaveChat: CommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { name: { type: 'string' } })
  if (positionals.length !== 1) throw usage('Use: orgai projects save-chat <runId-or-R#> [--name <name>]')
  const ref = positionals[0]
  return withHost(ctx, [...CONFIGURE], async (client) => {
    const r = await resolveRunFromSource(ctx, liveSource(client), ref).catch((e: unknown) => {
      throw e instanceof CliError ? e : new CliError(safeLine(e instanceof Error ? e.message : String(e)), EXIT.usage)
    })
    const run: RunSummary | undefined = r.runs.find((x) => x.id === r.runId)
    if (!run?.quick) throw usage('That run is not a Chat; only Chat runs can be saved as a project.')
    if (run.quick.scratch) throw usage('That Chat ran in a scratch folder OrgAI made; it cannot become a project.')
    const name = (values.name ?? '').trim() || basename(run.quick.folder) || 'Project'
    const res = await hostCall<QuickRunPromoteResult>(client, 'runs:promoteQuick', [{ runId: run.id, name }])
    if (res.kind === 'existing') {
      emit(ctx, { saved: false, existing: { projectId: res.projectId, name: res.name } }, () => `That folder is already the project "${safeLine(res.name)}" (${safeLine(res.projectId)}); nothing moved.`)
      return EXIT.failure
    }
    emit(ctx, { saved: true, project: projectFacts(res.project), run: { id: res.run.id, projectId: res.run.projectId } }, () => [
      `Saved the Chat as ${safeLine(res.project.name)} (${safeLine(res.project.id)}).`,
      `  Folder: ${safe(res.project.path).replace(/\s+/g, ' ')}`
    ])
    return EXIT.ok
  })
}

// ---------- trust (cli-parity 3.4) ----------

/**
 * `projects trust [show]` (read): the folder's own agent config as the host reviews it (projects:folderConfig) and
 * whether agents load it. `projects trust allow | deny` decide nothing: allowing is done in the desktop app for now (a
 * terminal cannot yet prove a person is answering); they exit 2 without starting a host, whatever flags follow.
 */
const runTrust = async (ctx: CliContext, args: string[]): Promise<number> => {
  const sub = args[0]
  if (sub === 'allow' || sub === 'deny') throw new CliError(NO_APPROVE_COMMAND, EXIT.usage)
  if (sub !== undefined && !sub.startsWith('-') && sub !== 'show') throw usage(`Unknown subcommand 'trust ${safeLine(sub).slice(0, 64)}'. Usage: orgai projects trust [show]`)
  const { positionals } = parseFlags(sub === 'show' ? args.slice(1) : args, {})
  if (positionals.length) throw usage('Usage: orgai projects trust [show] (pick the project with --project)')
  return withHost(ctx, [...READ], async (client) => {
    const project = await requireProject(ctx, client)
    const review = await hostCall<FolderConfigReview>(client, 'projects:folderConfig', [project.id])
    const decide = review.state === 'none' ? [] : ['', TRUST_WHERE]
    emit(ctx, { project: { id: project.id, name: project.name, path: project.path }, folderConfig: review }, () => [...folderTrustLines(review, project.name), ...decide])
    return EXIT.ok
  })
}

export const PROJECT_SUBCOMMANDS = {
  trust: runTrust,
  list: runList,
  show: runShow,
  check: runCheck,
  create: runCreate,
  set: runSet,
  remove: runRemove,
  'save-chat': runSaveChat
} as const

export const runProjects: CommandFn = async (ctx, args) => runSubcommands(ctx, args, PROJECT_SUBCOMMANDS, USAGE)
