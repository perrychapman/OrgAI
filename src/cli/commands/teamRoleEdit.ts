/**
 * `orgai team role add | set | rm | move` (cli-parity 3.3): edit one role of the current project from a terminal.
 *
 * Every command reads the project with projects:get, changes its `roles` the way the desktop editor does (TeamView addRole,
 * RoleInspector, RoleModelPicker, RoleStaffingControls, lib/roleOps) and writes the whole project back with projects:save,
 * so the host applies the same cleaning as a desktop save (ProjectStore.saveFromRenderer: Role.connection kept only as a
 * connection id, requiredReports kept within spawnable, staffing rebuilt by cleanRoleStaffing, an invalid model replaced,
 * skill grants kept only when the skill exists, the team files hook). What the host does not check is checked here first,
 * and each error names the flag: an unknown role, a cycle in reportsTo, removing or moving the root, a duplicate slug, a
 * model id outside the connection's catalog (unless --force), spawnable or required reports that are not reports of the
 * role, unknown tools, MCP servers or connections.
 *
 * Spend gate: a change that raises what a role may spend (shared/roleSpend settleSpend, the rule the team files gate holds
 * "May spend more" changes by: a higher tier or effort, automatic staffing switched on or its ceiling raised), a new
 * connection, or spawning switched on, prints those sentences and needs a confirmation at a terminal or --yes. Lowering
 * never asks. projects:save has no compare-and-set: a desktop edit made between the read and the save is overwritten.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  cleanRequiredReports,
  cleanRoleStaffing,
  compareTier,
  effectiveRoleStaffing,
  modelForTier,
  newId,
  projectConnection,
  roleConnection,
  ROLE_COLORS,
  settingTier,
  slugify,
  type TierContext
} from '../../shared/defaults'
import { settleSpend } from '../../shared/roleSpend'
import {
  isEffort,
  isModelTier,
  MODEL_TIERS,
  TOOL_CATALOG,
  type ConnectionId,
  type ConnectionInfo,
  type Effort,
  type ModelTier,
  type Project,
  type ProviderModel,
  type Role,
  type RoleStaffing,
  type ToolName
} from '../../shared/types'
import { parseFlags } from '../flags'
import { confirm, hostCall, requireProject, withHost, type SubcommandFn } from '../manage'
import { emit, safeLine, type Json } from '../output'
import { effortWord, runsOnWords, staffingWords } from '../roleText'
import { CliError, EXIT, type CliContext, type HostClient } from '../types'
import { connectionArg, labelOfId } from './connections'
import { checkArg, findRole, onlyPositionals, projectJson, roleTierWord } from './org'

const usage = (m: string): CliError => new CliError(m, EXIT.usage)

/** Prompt text cap (the team files gate's PROMPT_TEXT_MAX). */
export const PROMPT_MAX_CHARS = 200_000
const NAME_MAX = 200
const DESCRIPTION_MAX = 10_000
/** The host's model id shape (main/connections/codexAccount validModelId): printable ASCII, no leading dash. */
const MODEL_ID_RE = /^[!-~]{1,200}$/

/** Swappable in tests: opens $VISUAL / $EDITOR on `initial` and resolves with the saved text. */
export const roleEditDeps = { editText: (ctx: CliContext, initial: string): Promise<string> => editInEditor(ctx, initial) }

async function editInEditor(ctx: CliContext, initial: string): Promise<string> {
  const editor = (ctx.env.VISUAL || ctx.env.EDITOR || (ctx.platform === 'win32' ? 'notepad' : 'vi')).trim()
  const dir = mkdtempSync(join(tmpdir(), 'orgai-prompt-'))
  const file = join(dir, 'prompt.md')
  try {
    writeFileSync(file, initial, { encoding: 'utf8', mode: 0o600 })
    // EDITOR may carry arguments ("code -w"), so it runs through the shell; the file path is quoted.
    const r = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true, env: ctx.env })
    if (r.error || r.status !== 0) throw new CliError(`The editor (${safeLine(editor)}) did not exit cleanly; nothing changed.`, EXIT.failure)
    return readFileSync(file, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------- Flags ----------

export const EDIT_FLAGS = {
  name: { type: 'string' },
  description: { type: 'string' },
  prompt: { type: 'string' },
  'prompt-file': { type: 'string' },
  edit: { type: 'boolean' },
  model: { type: 'string' },
  effort: { type: 'string' },
  staffing: { type: 'string' },
  'min-tier': { type: 'string' },
  'max-effort': { type: 'string' },
  tools: { type: 'string' },
  'add-tool': { type: 'string', multiple: true },
  'rm-tool': { type: 'string', multiple: true },
  'can-spawn': { type: 'string' },
  spawnable: { type: 'string' },
  'required-reports': { type: 'string' },
  connection: { type: 'string' },
  mcp: { type: 'string' },
  force: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' }
} as const

/** The values `applyRoleEdits` reads (the prompt already resolved from --prompt, --prompt-file or --edit). */
export interface RoleEdits {
  name?: string
  description?: string
  prompt?: string
  model?: string
  effort?: string
  staffing?: string
  minTier?: string
  maxEffort?: string
  tools?: string
  addTool?: string[]
  rmTool?: string[]
  canSpawn?: string
  spawnable?: string
  requiredReports?: string
  connection?: string
  mcp?: string
  force?: boolean
}

/** What the model and connection checks read: connections:list and models:list. */
export interface ModelEnv {
  connections: readonly ConnectionInfo[]
  catalog: readonly ProviderModel[]
}

type ParsedEdit = ReturnType<typeof parseFlags<typeof EDIT_FLAGS>>['values']

/** RoleEdits from parsed flags; the prompt comes separately. */
function editsOf(v: ParsedEdit): RoleEdits {
  return {
    name: v.name,
    description: v.description,
    model: v.model,
    effort: v.effort,
    staffing: v.staffing,
    minTier: v['min-tier'],
    maxEffort: v['max-effort'],
    tools: v.tools,
    addTool: v['add-tool'],
    rmTool: v['rm-tool'],
    canSpawn: v['can-spawn'],
    spawnable: v.spawnable,
    requiredReports: v['required-reports'],
    connection: v.connection,
    mcp: v.mcp,
    force: v.force
  }
}

const EDIT_KEYS: (keyof ParsedEdit)[] = Object.keys(EDIT_FLAGS).filter((k) => k !== 'yes' && k !== 'force') as (keyof ParsedEdit)[]
const hasEdits = (v: ParsedEdit): boolean => EDIT_KEYS.some((k) => v[k] !== undefined)

/** A comma list ("a, b,,c" -> ["a","b","c"]); 'none' or '' = []. */
export function listArg(raw: string): string[] {
  const t = raw.trim()
  if (t === '' || t.toLowerCase() === 'none') return []
  return t.split(',').map((s) => s.trim()).filter(Boolean)
}

function onOff(flag: string, v: string): boolean {
  if (v === 'on') return true
  if (v === 'off') return false
  throw usage(`--${flag} must be on or off.`)
}

/** The text of --prompt / --prompt-file / --edit (at most one), or undefined. --edit needs an interactive terminal. */
export async function promptFrom(ctx: CliContext, v: ParsedEdit, current: string): Promise<string | undefined> {
  const given = [v.prompt !== undefined, v['prompt-file'] !== undefined, !!v.edit].filter(Boolean).length
  if (given > 1) throw usage('Give the prompt one way: --prompt, --prompt-file or --edit.')
  let text: string | undefined
  if (v.prompt !== undefined) text = v.prompt
  else if (v['prompt-file'] !== undefined) {
    const p = checkArg('prompt file (--prompt-file)', v['prompt-file'])
    const file = isAbsolute(p) ? p : resolve(ctx.cwd, p)
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      throw usage(`--prompt-file: cannot read ${safeLine(file)} (${(e as NodeJS.ErrnoException).code ?? 'error'}).`)
    }
  } else if (v.edit) {
    if (!ctx.io.stdinIsTTY || !ctx.io.stdout.isTTY) throw usage('--edit opens your editor and needs an interactive terminal; use --prompt-file <path> instead.')
    text = await roleEditDeps.editText(ctx, current)
  }
  if (text !== undefined && text.length > PROMPT_MAX_CHARS) throw usage(`--prompt: the prompt is longer than ${PROMPT_MAX_CHARS} characters.`)
  return text
}

// ---------- Model and connection ----------

const tierModelsOf = (env: ModelEnv, c: ConnectionId): Partial<Record<ModelTier, string>> =>
  ({ ...(env.connections.find((i) => i.connection.id === c)?.connection.tierModels ?? {}) }) as Partial<Record<ModelTier, string>>
const catalogOf = (env: ModelEnv, c: ConnectionId): ProviderModel[] => env.catalog.filter((m) => m.connection === c)
const tierCtx = (env: ModelEnv, c: ConnectionId): TierContext => {
  const catalog = catalogOf(env, c)
  return { connection: c, tierModels: tierModelsOf(env, c), ...(catalog.length ? { catalog } : {}) }
}
/** The model a tier maps to on `c` (the tier itself, never a neighbour). */
function exactTierModel(env: ModelEnv, c: ConnectionId, tier: ModelTier): string | undefined {
  const hit = modelForTier(tier, tierCtx(env, c))
  return hit && hit.tier === tier ? hit.model : undefined
}
/** The tier whose model on `c` is `model`, if any (RoleModelPicker applyExactModel). */
const tierOfModel = (env: ModelEnv, c: ConnectionId, model: string): ModelTier | undefined => MODEL_TIERS.find((t) => exactTierModel(env, c, t) === model)

/** The tier a role's model stands for on `c`: its tier when that tier's model is still its model, else any tier mapping it. */
function tierChoice(role: Role, env: ModelEnv, c: ConnectionId): ModelTier | undefined {
  if (role.tier && exactTierModel(env, c, role.tier) === role.model) return role.tier
  return tierOfModel(env, c, role.model)
}

/** --model: a tier name (or legacy alias), 'inherit', or a model id in the connection's catalog (--force for any id). */
function modelArg(raw: string, env: ModelEnv, c: ConnectionId, force: boolean): { model: string; tier?: ModelTier } {
  const v = raw.trim()
  if (v === 'inherit') return { model: 'inherit' }
  const tier = settingTier(v)
  if (tier) {
    const model = exactTierModel(env, c, tier)
    if (!model) throw usage(`--model: ${labelOfId(c)} maps no model to the ${tier} tier. Set one with \`orgai connections tier ${c} ${tier} <model>\` or give a model id.`)
    return { model, tier }
  }
  if (!MODEL_ID_RE.test(v) || v.startsWith('-')) throw usage('--model: give a tier (top, deep, everyday, fast), inherit or a model id (printable characters, no spaces).')
  if (!force && !catalogOf(env, c).some((m) => m.id === v)) {
    throw usage(`--model: ${safeLine(v)} is not in the model catalog of ${labelOfId(c)} (see \`orgai models list\`). Pass --force to save it anyway.`)
  }
  const t = tierOfModel(env, c, v)
  return { model: v, ...(t ? { tier: t } : {}) }
}

/**
 * The role's model after its connection moves to `to` (RoleModelPicker's Runs on change): an inherit role keeps it; a
 * custom id the new catalog serves (or a catalog not known) is kept; else its tier there, else everyday, else the first
 * mapped tier, else inherit. Returns the note to print, or null.
 */
function followConnection(role: Role, from: ConnectionId, to: ConnectionId, env: ModelEnv): { model: string; tier?: ModelTier; note: string | null } {
  if (role.model === 'inherit') return { model: 'inherit', note: null }
  const choice = tierChoice(role, env, from)
  if (!choice) {
    const cat = catalogOf(env, to)
    if (cat.length === 0 || cat.some((m) => m.id === role.model)) return { model: role.model, ...(role.tier ? { tier: role.tier } : {}), note: null }
  }
  const order = [choice, role.tier, 'everyday' as ModelTier, ...MODEL_TIERS].filter((t): t is ModelTier => !!t)
  for (const t of order) {
    const m = exactTierModel(env, to, t)
    if (m) return { model: m, tier: t, note: m === role.model ? null : `Model set to ${t} (${m}) on ${labelOfId(to)}.` }
  }
  return { model: 'inherit', note: `Model set to inherit: ${labelOfId(to)} maps no tier yet.` }
}

/** True when the role names an exact model and no tier (desktop: automatic staffing is not offered). */
const isExact = (r: Pick<Role, 'model' | 'tier' | 'effort'>): boolean => effectiveRoleStaffing({ ...r, staffing: undefined }, null).mode === 'fixed'

// ---------- Role edits ----------

/** The role named by `ref` (id, slug or name) or a usage error naming `flag`. */
function roleRef(roles: readonly Role[], ref: string, flag: string): Role {
  const r = findRole(roles, ref)
  if (!r) throw usage(`${flag}: no role "${safeLine(ref).slice(0, 80)}". List them with: orgai team roles`)
  return r
}

/**
 * Apply the edits to `role` (a copy) within `roles` (the chart as it will stand, `role` in it by id). Pure apart from the
 * catalog it is given. Throws a usage error naming the flag. Returns the new role and any notes.
 */
export function applyRoleEdits(project: Project, roles: readonly Role[], role: Role, e: RoleEdits, env: ModelEnv | null): { role: Role; notes: string[] } {
  const r: Role = structuredClone(role)
  const notes: string[] = []
  const isRoot = r.reportsTo === null
  const others = roles.filter((x) => x.id !== r.id)
  const needEnv = (): ModelEnv => {
    if (!env) throw new Error('model catalog not loaded')
    return env
  }

  if (e.name !== undefined) {
    const name = e.name.trim()
    if (!name || name.length > NAME_MAX) throw usage(`--name needs a role name of 1 to ${NAME_MAX} characters.`)
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw usage('--name holds control characters.')
    r.name = name
    r.slug = slugify(name)
  }
  const clash = e.name !== undefined && others.find((x) => x.slug === r.slug)
  if (clash) throw usage(`--name: the slug "${safeLine(r.slug)}" is taken by ${safeLine(clash.name)}; pick another name.`)
  if (e.description !== undefined) {
    if (e.description.length > DESCRIPTION_MAX) throw usage(`--description is longer than ${DESCRIPTION_MAX} characters.`)
    r.description = e.description
  }
  if (e.prompt !== undefined) r.prompt = e.prompt

  // Connection first: the model resolves against it.
  const fromConn = roleConnection(r, project)
  if (e.connection !== undefined) {
    if (isRoot) throw usage(`--connection: ${safeLine(r.name)} is the top of the chart and always runs on the project's connection; change that with \`orgai projects set --connection <id>\`.`)
    if (e.connection === 'inherit') delete r.connection
    else {
      const id = connectionArg(e.connection, 'a connection for --connection')
      if (!needEnv().connections.some((i) => i.connection.id === id)) throw usage(`--connection: ${safeLine(id)} is not a connection on this computer (see \`orgai connections list\`).`)
      r.connection = id
    }
  }
  const toConn = roleConnection(r, project)
  if (e.model !== undefined) {
    const m = modelArg(e.model, needEnv(), toConn, !!e.force)
    r.model = m.model
    if (m.tier) r.tier = m.tier
    else delete r.tier
  } else if (toConn !== fromConn) {
    const m = followConnection(r, fromConn, toConn, needEnv())
    r.model = m.model
    if (m.tier) r.tier = m.tier
    else delete r.tier
    if (m.note) notes.push(m.note)
  }

  if (e.effort !== undefined) {
    if (e.effort === 'none') delete r.effort
    else if (isEffort(e.effort)) r.effort = e.effort
    else throw usage('--effort must be low, medium, high, xhigh, max or none.')
  }

  // Staffing (RoleStaffingControls / lib/roleStaffing): the root always runs as configured; bounds make a role automatic.
  const bounds = e.minTier !== undefined || e.maxEffort !== undefined
  if (e.staffing !== undefined || bounds) {
    const flag = e.staffing !== undefined ? '--staffing' : e.minTier !== undefined ? '--min-tier' : '--max-effort'
    if (isRoot) throw usage(`${flag}: ${safeLine(r.name)} is the top of the chart, which always runs as configured.`)
    let staffing: RoleStaffing | undefined = cleanRoleStaffing(r.staffing)
    if (e.staffing !== undefined) {
      if (e.staffing === 'inherit') staffing = undefined
      else if (e.staffing === 'fixed') staffing = { mode: 'fixed' }
      else if (e.staffing === 'auto') staffing = { mode: 'auto', ...(staffing?.minTier ? { minTier: staffing.minTier } : {}), ...(staffing?.maxEffort ? { maxEffort: staffing.maxEffort } : {}) }
      else throw usage('--staffing must be auto, fixed or inherit (follow the project).')
      if (bounds && e.staffing !== 'auto') throw usage(`--min-tier and --max-effort apply to automatic staffing; drop them or use --staffing auto.`)
    }
    if (e.minTier !== undefined) {
      const own = r.model === 'inherit' ? undefined : (r.tier ?? undefined)
      let minTier: ModelTier | undefined
      if (e.minTier !== 'none') {
        if (!isModelTier(e.minTier)) throw usage('--min-tier must be top, deep, everyday, fast or none.')
        if (own && compareTier(e.minTier, own) > 0) throw usage(`--min-tier: ${e.minTier} is above ${safeLine(r.name)}'s own tier (${own}).`)
        minTier = e.minTier
      }
      staffing = { mode: 'auto', ...(minTier ? { minTier } : {}), ...(staffing?.maxEffort ? { maxEffort: staffing.maxEffort } : {}) }
    }
    if (e.maxEffort !== undefined) {
      let maxEffort: Effort | undefined
      if (e.maxEffort !== 'none') {
        if (!isEffort(e.maxEffort)) throw usage('--max-effort must be low, medium, high, xhigh, max or none.')
        maxEffort = e.maxEffort
      }
      staffing = { mode: 'auto', ...(staffing?.minTier ? { minTier: staffing.minTier } : {}), ...(maxEffort ? { maxEffort } : {}) }
    }
    if (staffing?.mode === 'auto' && isExact(r)) {
      throw usage(`${flag}: ${safeLine(r.name)} runs on an exact model (${safeLine(r.model)}), so it always runs on it. Give it a tier with --model <tier> first.`)
    }
    if (staffing) r.staffing = staffing
    else delete r.staffing
  }

  // Tools (the desktop offers TOOL_CATALOG).
  const toolName = (raw: string, flag: string): ToolName => {
    const hit = TOOL_CATALOG.find((t) => t.toLowerCase() === raw.trim().toLowerCase())
    if (!hit) throw usage(`${flag}: unknown tool "${safeLine(raw).slice(0, 60)}". Tools: ${TOOL_CATALOG.join(', ')}.`)
    return hit
  }
  if (e.tools !== undefined) r.tools = [...new Set(listArg(e.tools).map((t) => toolName(t, '--tools')))]
  for (const raw of (e.addTool ?? []).flatMap(listArg)) {
    const t = toolName(raw, '--add-tool')
    if (!r.tools.includes(t)) r.tools = [...r.tools, t]
  }
  for (const raw of (e.rmTool ?? []).flatMap(listArg)) {
    const t = r.tools.find((x) => x.toLowerCase() === raw.trim().toLowerCase())
    if (!t) throw usage(`--rm-tool: ${safeLine(r.name)} does not have ${safeLine(raw).slice(0, 60)}.`)
    r.tools = r.tools.filter((x) => x !== t)
  }

  // Spawning: spawnable and required reports must be the role's own reports.
  const reportsOf = new Set(roles.filter((x) => x.reportsTo === r.id).map((x) => x.id))
  const reportIds = (raw: string, flag: string): string[] =>
    [
      ...new Set(
        listArg(raw).map((ref) => {
          const x = roleRef(roles, ref, flag)
          if (!reportsOf.has(x.id)) throw usage(`${flag}: ${safeLine(x.name)} does not report to ${safeLine(r.name)}.`)
          return x.id
        })
      )
    ]
  if (e.canSpawn !== undefined) r.canSpawn = onOff('can-spawn', e.canSpawn)
  if (e.spawnable !== undefined) {
    r.spawnable = reportIds(e.spawnable, '--spawnable')
    if (r.spawnable.length) {
      if (e.canSpawn === 'off') throw usage('--spawnable lists reports but --can-spawn is off.')
      r.canSpawn = true
    }
  }
  if (e.requiredReports !== undefined) {
    const ids = reportIds(e.requiredReports, '--required-reports')
    const outside = ids.filter((id) => !r.spawnable.includes(id))
    if (outside.length) throw usage(`--required-reports: ${outside.map((id) => safeLine(roles.find((x) => x.id === id)?.name ?? id)).join(', ')} not in ${safeLine(r.name)}'s spawnable list; add with --spawnable.`)
    if (ids.length && !r.canSpawn) throw usage(`--required-reports: ${safeLine(r.name)} cannot create subagents; add --can-spawn on.`)
    if (ids.length) r.requiredReports = ids
    else delete r.requiredReports
  }
  const required = cleanRequiredReports(r)
  if (required) r.requiredReports = required
  else delete r.requiredReports

  // Explicit MCP grants (Role.mcpServers): server ids or names of this project.
  if (e.mcp !== undefined) {
    const servers = project.mcpServers ?? []
    const ids = listArg(e.mcp).map((ref) => {
      const s = servers.find((x) => x.id === ref) ?? servers.find((x) => x.name.toLowerCase() === ref.toLowerCase())
      if (!s) throw usage(`--mcp: no MCP server "${safeLine(ref).slice(0, 60)}" in this project (see \`orgai mcp list\`).`)
      return s.id
    })
    if (ids.length) r.mcpServers = [...new Set(ids)]
    else delete r.mcpServers
  }
  return { role: r, notes }
}

/** The chart's own rules, the host does not enforce: one root, no cycle, unique slugs, known managers. `flag` names the cause. */
export function chartProblem(roles: readonly Role[], flag: string, touched?: ReadonlySet<string>): string | null {
  const roots = roles.filter((r) => r.reportsTo === null)
  if (roots.length !== 1) return `${flag}: the chart must keep exactly one top role (it would have ${roots.length}).`
  const ids = new Set(roles.map((r) => r.id))
  for (const r of roles) if (r.reportsTo !== null && !ids.has(r.reportsTo)) return `${flag}: ${safeLine(r.name)} would report to a role that is not in the chart.`
  const slugs = new Map<string, string>()
  for (const r of roles) {
    const prev = slugs.get(r.slug)
    if (prev !== undefined && (!touched || touched.has(r.id) || roles.some((x) => x.slug === r.slug && touched.has(x.id)))) return `${flag}: ${safeLine(prev)} and ${safeLine(r.name)} would share the slug "${safeLine(r.slug)}".`
    slugs.set(r.slug, r.name)
  }
  for (const r of roles) {
    const seen = new Set<string>()
    let cur: string | null = r.id
    while (cur) {
      if (seen.has(cur)) return `${flag}: that would make a loop in who reports to whom (through ${safeLine(r.name)}).`
      seen.add(cur)
      cur = roles.find((x) => x.id === cur)?.reportsTo ?? null
    }
  }
  return null
}

/** Make `parentId` the manager of `childId` (lib/roleOps setReportsTo): the new manager may spawn it, the others may not. */
export function setReportsTo(roles: readonly Role[], childId: string, parentId: string): Role[] {
  return roles.map((r) => {
    if (r.id === childId) return { ...r, reportsTo: parentId }
    if (r.id === parentId) return { ...r, canSpawn: true, spawnable: [...new Set([...r.spawnable, childId])] }
    if (!r.spawnable.includes(childId) && !r.requiredReports?.includes(childId)) return r
    const next: Role = { ...r, spawnable: r.spawnable.filter((id) => id !== childId) }
    const required = cleanRequiredReports(next)
    if (required) next.requiredReports = required
    else delete next.requiredReports
    return next
  })
}

/** Is `id` the role `of` or one of its descendants? */
function isUnder(roles: readonly Role[], id: string, of: string): boolean {
  const seen = new Set<string>()
  let cur: string | null = id
  while (cur && !seen.has(cur)) {
    if (cur === of) return true
    seen.add(cur)
    cur = roles.find((r) => r.id === cur)?.reportsTo ?? null
  }
  return false
}

// ---------- Spend gate ----------

/**
 * The "May spend more" sentences of moving the chart from `before` to `after` (by role id; a role only in `after` is
 * judged against `baseline`, the role as `add` would make it with no flags). settleSpend under the project's staffing
 * mode gives the team files gate's sentences for model, effort and staffing; a role moved onto another connection and a
 * role that may now create subagents add their own. Lowering anything yields nothing.
 */
export function spendSentences(project: Project, before: readonly Role[], after: readonly Role[], baseline?: ReadonlyMap<string, Role>, label: (id: string) => string = (id) => labelOfId(id)): string[] {
  const prev = new Map(before.map((r) => [r.id, r]))
  const out: string[] = []
  for (const next of after) {
    const was = prev.get(next.id) ?? baseline?.get(next.id)
    if (!was) continue
    const who = safeLine(next.name)
    for (const h of settleSpend(was, next, [project.staffing], who).held) out.push(h.summary)
    const from = roleConnection(was, project)
    const to = roleConnection(next, project)
    if (from !== to && next.connection !== undefined) out.push(`${who} runs on ${label(to)} instead of ${label(from)}, with its models and prices. This may spend more.`)
    if (!was.canSpawn && next.canSpawn) out.push(`${who} may create subagents, which may spend more.`)
  }
  return out
}

// ---------- Text ----------

const listWords = (ids: readonly string[] | undefined, nameOf: (id: string) => string): string => (ids?.length ? ids.map(nameOf).join(', ') : 'none')

/** The lines that describe a role's model, effort, staffing, connection and spawning. */
export function roleSummaryLines(role: Role, project: Project, label: (id: string) => string, text: (s: string) => string = safeLine): string[] {
  const nameOf = (id: string): string => text(project.roles.find((r) => r.id === id)?.name ?? id)
  const servers = new Map((project.mcpServers ?? []).map((s) => [s.id, s.name]))
  return [
    `  model: ${safeLine(role.model)} (${safeLine(roleTierWord(role))})`,
    `  effort: ${effortWord(role)}`,
    `  staffing: ${safeLine(staffingWords(role, project))}`,
    `  runs on: ${safeLine(runsOnWords(role, project, label))}`,
    `  reports to: ${role.reportsTo ? nameOf(role.reportsTo) : 'nobody (root)'}`,
    `  spawning: ${role.canSpawn ? (role.spawnable.length ? role.spawnable.map(nameOf).join(', ') : 'allowed, none listed') : 'no'}`,
    ...(role.requiredReports?.length ? [`  must delegate to: ${role.requiredReports.map(nameOf).join(', ')}`] : []),
    `  tools: ${role.tools.length ? role.tools.map((t) => text(t)).join(', ') : 'none'}`,
    `  MCP grants: ${listWords(role.mcpServers, (id) => text(servers.get(id) ?? id))}`
  ]
}

/** One "field: before -> after" line per field that changed. */
export function changeLines(before: Role, after: Role, project: Project, label: (id: string) => string): string[] {
  const nameOf = (id: string): string => safeLine(project.roles.find((r) => r.id === id)?.name ?? id)
  const servers = new Map((project.mcpServers ?? []).map((s) => [s.id, s.name]))
  const rows: [string, string, string][] = [
    ['name', safeLine(before.name), safeLine(after.name)],
    ['slug', safeLine(before.slug), safeLine(after.slug)],
    ['description', safeLine(before.description).slice(0, 80), safeLine(after.description).slice(0, 80)],
    ['prompt', `${before.prompt.length} characters`, `${after.prompt.length} characters`],
    ['model', `${safeLine(before.model)} (${safeLine(roleTierWord(before))})`, `${safeLine(after.model)} (${safeLine(roleTierWord(after))})`],
    ['effort', effortWord(before), effortWord(after)],
    ['staffing', safeLine(staffingWords(before, project)), safeLine(staffingWords(after, project))],
    ['runs on', safeLine(runsOnWords(before, project, label)), safeLine(runsOnWords(after, project, label))],
    ['reports to', before.reportsTo ? nameOf(before.reportsTo) : 'nobody', after.reportsTo ? nameOf(after.reportsTo) : 'nobody'],
    ['can spawn', before.canSpawn ? 'yes' : 'no', after.canSpawn ? 'yes' : 'no'],
    ['spawnable', listWords(before.spawnable, nameOf), listWords(after.spawnable, nameOf)],
    ['required reports', listWords(before.requiredReports, nameOf), listWords(after.requiredReports, nameOf)],
    ['tools', listWords(before.tools, (t) => safeLine(t)), listWords(after.tools, (t) => safeLine(t))],
    ['MCP grants', listWords(before.mcpServers, (id) => safeLine(servers.get(id) ?? id)), listWords(after.mcpServers, (id) => safeLine(servers.get(id) ?? id))]
  ]
  const out = rows.filter(([field, a, b]) => a !== b || (field === 'prompt' && before.prompt !== after.prompt)).map(([field, a, b]) => (field === 'prompt' && a === b ? '  prompt: changed' : `  ${field}: ${a} -> ${b}`))
  return out
}

// ---------- Host plumbing ----------

async function freshProject(ctx: CliContext, client: HostClient): Promise<Project> {
  const found = await requireProject(ctx, client)
  const p = await hostCall<Project | null>(client, 'projects:get', [found.id])
  if (!p || typeof p !== 'object') throw new CliError('That project is gone.', EXIT.failure)
  return p
}

async function modelEnv(client: HostClient): Promise<ModelEnv> {
  const connections = await hostCall<ConnectionInfo[]>(client, 'connections:list', [])
  const catalog = await hostCall<ProviderModel[]>(client, 'models:list', [])
  return { connections: Array.isArray(connections) ? connections : [], catalog: Array.isArray(catalog) ? catalog : [] }
}

/** Connection names (proxies by their own name) from connections:list; built-in labels otherwise. */
export function labelFrom(env: ModelEnv | null): (id: string) => string {
  const names: Record<string, string> = {}
  for (const i of env?.connections ?? []) {
    const c = i.connection as { id: string; name?: unknown }
    if (typeof c.name === 'string' && c.name.trim()) names[c.id] = safeLine(c.name)
  }
  return (id) => labelOfId(id, names)
}

/** Ask before a change that may spend more (and before `extra`, a question that always asks). False = do not save. */
async function gate(ctx: CliContext, sentences: string[], yes: boolean, extra?: string): Promise<boolean> {
  if (!sentences.length && !extra) return true
  const spend = sentences.length ? `May spend more: ${sentences.join(' ')}` : ''
  const question = [extra, spend, extra ? '' : 'Save anyway?'].filter(Boolean).join(' ')
  return confirm(ctx, question, yes)
}

const roleJson = (r: Role): Json => structuredClone(r) as unknown as Json

function saved(project: Project, id: string): Role {
  const r = project.roles.find((x) => x.id === id)
  if (!r) throw new CliError('The host did not keep the role; nothing to show.', EXIT.failure)
  return r
}

// ---------- Commands ----------

const ADD_USAGE = 'team role add <name> --reports-to <role> [--description <text>] [--prompt <text> | --prompt-file <path> | --edit] [--model <tier|id|inherit>] [--effort <level|none>] [--staffing auto|fixed|inherit] [--min-tier <tier|none>] [--max-effort <level|none>] [--tools a,b] [--add-tool x] [--rm-tool x] [--can-spawn on|off] [--connection <id|inherit>] [--mcp a,b|none] [--force] [--yes]'
const SET_USAGE = 'team role set <role> [--name <n>] [--description <text>] [--prompt <text> | --prompt-file <path> | --edit] [--model <tier|id|inherit>] [--effort <level|none>] [--staffing auto|fixed|inherit] [--min-tier <tier|none>] [--max-effort <level|none>] [--tools a,b] [--add-tool x] [--rm-tool x] [--can-spawn on|off] [--spawnable a,b|none] [--required-reports a,b|none] [--connection <id|inherit>] [--mcp a,b|none] [--force] [--yes]'

/** Whether edits need connections:list / models:list. */
const needsModelEnv = (v: ParsedEdit): boolean => v.model !== undefined || v.connection !== undefined

export const roleAdd: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { ...EDIT_FLAGS, 'reports-to': { type: 'string' } })
  onlyPositionals(positionals, 1, ADD_USAGE)
  if (values.name !== undefined && positionals[0] !== undefined) throw usage('Give the role name once (as the argument or --name).')
  const name = checkArg('role name', values.name ?? positionals[0])
  const managerRef = checkArg('manager (--reports-to <role>)', values['reports-to'])
  if (values.spawnable !== undefined || values['required-reports'] !== undefined) throw usage('A new role has no reports yet: --spawnable and --required-reports apply to `team role set`.')
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const fresh = await freshProject(ctx, client)
    const env = await modelEnv(client)
    const label = labelFrom(env)
    const manager = roleRef(fresh.roles, managerRef, '--reports-to')
    const conn = projectConnection(fresh)
    const everyday = modelForTier('everyday', tierCtx(env, conn))
    // TeamView addRole's new role, under the manager.
    const base: Role = {
      id: newId('role'),
      slug: slugify(name),
      name: name.trim(),
      description: 'Describe when a manager should delegate to this role.',
      responsibilities: [],
      prompt: 'You are a specialist. Complete the assigned task and report back concisely.',
      tools: ['Read', 'Glob', 'Grep'],
      model: everyday?.model ?? 'inherit',
      ...(everyday ? { tier: everyday.tier } : {}),
      canSpawn: false,
      spawnable: [],
      reportsTo: manager.id,
      position: { x: manager.position.x + 120, y: manager.position.y + 210 },
      color: ROLE_COLORS[fresh.roles.length % ROLE_COLORS.length]
    }
    const withManager = [...fresh.roles.map((r) => (r.id === manager.id ? { ...r, canSpawn: true, spawnable: [...new Set([...r.spawnable, base.id])] } : r)), base]
    const prompt = await promptFrom(ctx, values, base.prompt)
    const edited = applyRoleEdits(fresh, withManager, base, { ...editsOf(values), name: values.name ?? name, prompt }, env)
    const roles = withManager.map((r) => (r.id === base.id ? edited.role : r))
    const problem = chartProblem(roles, '--name', new Set([base.id]))
    if (problem) throw usage(problem)
    const sentences = spendSentences(fresh, fresh.roles, roles, new Map([[base.id, base]]), label)
    if (!(await gate(ctx, sentences, !!values.yes))) {
      emit(ctx, { saved: false }, () => 'Nothing changed.')
      return EXIT.failure
    }
    const project = await hostCall<Project>(client, 'projects:save', [{ ...fresh, roles }])
    const after = saved(project, base.id)
    const managerNote = !manager.canSpawn ? [`${safeLine(manager.name)} can now create subagents, because ${safeLine(after.name)} reports to it.`] : []
    emit(ctx, { project: projectJson(project), role: { before: null, after: roleJson(after) }, spend: sentences, notes: [...edited.notes, ...managerNote] }, () => [
      `Added ${safeLine(after.name)} [${safeLine(after.slug)}] under ${safeLine(manager.name)}.`,
      ...roleSummaryLines(after, project, label),
      ...edited.notes.map((n) => safeLine(n)),
      ...managerNote
    ])
    return EXIT.ok
  })
}

export const roleSet: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, EDIT_FLAGS)
  onlyPositionals(positionals, 1, SET_USAGE)
  const ref = checkArg('role (team role set <role>)', positionals[0])
  if (!hasEdits(values)) throw usage(`Nothing to change. Usage: orgai ${SET_USAGE}`)
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const fresh = await freshProject(ctx, client)
    const before = roleRef(fresh.roles, ref, 'team role set')
    const env = needsModelEnv(values) ? await modelEnv(client) : null
    const label = labelFrom(env)
    const prompt = await promptFrom(ctx, values, before.prompt)
    const edited = applyRoleEdits(fresh, fresh.roles, before, { ...editsOf(values), prompt }, env)
    const roles = fresh.roles.map((r) => (r.id === before.id ? edited.role : r))
    const problem = chartProblem(roles, '--name', new Set([before.id]))
    if (problem) throw usage(problem)
    const sentences = spendSentences(fresh, fresh.roles, roles, undefined, label)
    if (!(await gate(ctx, sentences, !!values.yes))) {
      emit(ctx, { saved: false }, () => 'Nothing changed.')
      return EXIT.failure
    }
    const project = await hostCall<Project>(client, 'projects:save', [{ ...fresh, roles }])
    const after = saved(project, before.id)
    const changes = changeLines(before, after, project, label)
    emit(ctx, { project: projectJson(project), role: { before: roleJson(before), after: roleJson(after) }, spend: sentences, notes: edited.notes }, () => [
      `Saved ${safeLine(after.name)} [${safeLine(after.slug)}].`,
      ...(changes.length ? changes : ['  Nothing changed.']),
      ...edited.notes.map((n) => safeLine(n))
    ])
    return EXIT.ok
  })
}

export const roleMove: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { 'reports-to': { type: 'string' }, yes: { type: 'boolean', short: 'y' } })
  onlyPositionals(positionals, 1, 'team role move <role> --reports-to <role> [--yes]')
  const ref = checkArg('role (team role move <role>)', positionals[0])
  const to = checkArg('new manager (--reports-to <role>)', values['reports-to'])
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const fresh = await freshProject(ctx, client)
    const before = roleRef(fresh.roles, ref, 'team role move')
    const manager = roleRef(fresh.roles, to, '--reports-to')
    if (before.reportsTo === null) throw usage(`--reports-to: ${safeLine(before.name)} is the top of the chart; a chart keeps its top role.`)
    if (isUnder(fresh.roles, manager.id, before.id)) throw usage(`--reports-to: ${safeLine(manager.name)} reports (directly or not) to ${safeLine(before.name)}; that would make a loop.`)
    if (before.reportsTo === manager.id) {
      emit(ctx, { project: projectJson(fresh), role: { before: roleJson(before), after: roleJson(before) }, spend: [] }, () => `${safeLine(before.name)} already reports to ${safeLine(manager.name)}.`)
      return EXIT.ok
    }
    const roles = setReportsTo(fresh.roles, before.id, manager.id)
    const problem = chartProblem(roles, '--reports-to', new Set())
    if (problem) throw usage(problem)
    const sentences = spendSentences(fresh, fresh.roles, roles)
    if (!(await gate(ctx, sentences, !!values.yes))) {
      emit(ctx, { saved: false }, () => 'Nothing changed.')
      return EXIT.failure
    }
    const project = await hostCall<Project>(client, 'projects:save', [{ ...fresh, roles }])
    const after = saved(project, before.id)
    emit(ctx, { project: projectJson(project), role: { before: roleJson(before), after: roleJson(after) }, spend: sentences }, () => [
      `${safeLine(after.name)} now reports to ${safeLine(manager.name)}.`,
      ...(!manager.canSpawn ? [`${safeLine(manager.name)} can now create subagents, because ${safeLine(after.name)} reports to it.`] : [])
    ])
    return EXIT.ok
  })
}

export const roleRemove: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { 'reparent-to': { type: 'string' }, yes: { type: 'boolean', short: 'y' } })
  onlyPositionals(positionals, 1, 'team role rm <role> [--reparent-to <role>] [--yes]')
  const ref = checkArg('role (team role rm <role>)', positionals[0])
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const fresh = await freshProject(ctx, client)
    const gone = roleRef(fresh.roles, ref, 'team role rm')
    if (gone.reportsTo === null) throw usage(`team role rm: ${safeLine(gone.name)} is the top of the chart and cannot be removed.`)
    const children = fresh.roles.filter((r) => r.reportsTo === gone.id)
    let target: Role | undefined
    if (values['reparent-to'] !== undefined) {
      target = roleRef(fresh.roles, checkArg('new manager (--reparent-to)', values['reparent-to']), '--reparent-to')
      if (isUnder(fresh.roles, target.id, gone.id)) throw usage(`--reparent-to: ${safeLine(target.name)} is ${safeLine(gone.name)} or one of its reports.`)
    } else if (children.length) {
      throw usage(`team role rm: ${children.map((c) => safeLine(c.name)).join(', ')} report${children.length === 1 ? 's' : ''} to ${safeLine(gone.name)}; give --reparent-to <role> to move ${children.length === 1 ? 'it' : 'them'}.`)
    }
    // lib/roleOps removeRole, with the reports handed to the named manager: references to the role are cleaned everywhere.
    let roles: Role[] = fresh.roles
    for (const c of children) roles = setReportsTo(roles, c.id, target!.id)
    roles = roles
      .filter((r) => r.id !== gone.id)
      .map((r) => {
        if (!r.spawnable.includes(gone.id) && !r.requiredReports?.includes(gone.id)) return r
        const next: Role = { ...r, spawnable: r.spawnable.filter((id) => id !== gone.id) }
        const required = cleanRequiredReports({ ...next, requiredReports: next.requiredReports?.filter((id) => id !== gone.id) })
        if (required) next.requiredReports = required
        else delete next.requiredReports
        return next
      })
    const problem = chartProblem(roles, '--reparent-to', new Set())
    if (problem) throw usage(problem)
    const sentences = spendSentences(fresh, fresh.roles, roles)
    const moved = children.length ? ` Its report${children.length === 1 ? '' : 's'} (${children.map((c) => safeLine(c.name)).join(', ')}) move${children.length === 1 ? 's' : ''} to ${safeLine(target!.name)}.` : ''
    if (!(await gate(ctx, sentences, !!values.yes, `Remove ${safeLine(gone.name)} from ${safeLine(fresh.name)}?${moved}`))) {
      emit(ctx, { saved: false }, () => 'Nothing removed.')
      return EXIT.failure
    }
    const project = await hostCall<Project>(client, 'projects:save', [{ ...fresh, roles }])
    emit(
      ctx,
      { project: projectJson(project), removed: roleJson(gone), reparentedTo: target?.id ?? null, moved: children.map((c) => c.id), spend: sentences, previousRoles: fresh.roles as unknown as Json, roles: project.roles.length },
      () => [`Removed ${safeLine(gone.name)}.${moved}`, `The chart now has ${project.roles.length} role${project.roles.length === 1 ? '' : 's'}. JSON output carries the previous chart as previousRoles.`]
    )
    return EXIT.ok
  })
}

/** For `team role <x>` text: a label function from connections:list when the host answers it, else built-in labels. */
export async function connectionLabels(client: HostClient): Promise<(id: string) => string> {
  try {
    const connections = await hostCall<ConnectionInfo[]>(client, 'connections:list', [])
    return labelFrom({ connections: Array.isArray(connections) ? connections : [], catalog: [] })
  } catch {
    return labelFrom(null)
  }
}

/** Exported for tests. */
export const __test = { isExact, followConnection, modelArg, isUnder }
