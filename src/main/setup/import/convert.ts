import { createHash } from 'node:crypto'
import { ROLE_COLORS, adapterForProject, newId, slugify } from '@shared/defaults'
import type {
  AgentImportAction,
  AgentImportChoice,
  AgentImportItem,
  AgentImportMode,
  AgentImportPreview,
  Project,
  Role
} from '@shared/types'
import { AGENT_IMPORT_SOURCE_LABELS } from '@shared/types'
import { mapChosenModel, mapImportedModel, type MappedModel, type ModelContext } from './model'
import { importKey } from './scan'
import { mapTools } from './tools'
import type { ImportedAgent } from './types'

/** Characters of the imported prompt shown in a preview item. */
export const PROMPT_EXCERPT_CHARS = 600

const ROOT_NAME = /(orchestrat|coordinat|\blead\b|-lead$|^lead|manager|supervisor|planner|\bboss\b|\bhead\b|^main$|^primary$)/i
const HEX_COLOR = /^#[0-9a-f]{6}$/i

export interface ConvertInput {
  /** The project's current roles. */
  existing: Role[]
  /** Parsed agents, in scan order. */
  agents: ImportedAgent[]
  mode: AgentImportMode
  choices?: AgentImportChoice[]
  model: ModelContext
  /** Provider of the project, for the LiteLLM family check (adapterForProject). */
  provider: Project['provider']
  instructionFiles?: string[]
  scanWarnings?: string[]
}

interface Draft {
  key: string
  agent: ImportedAgent
  action: AgentImportAction
  role: Role
  mapped: MappedModel
  toolsDropped: string[]
  notes: string[]
  replacesRoleId?: string
  slugConflict: boolean
  /** Manager reference from the source (OrgAI export slug), before resolution. */
  sourceManager?: string | null
}

/** Give each agent a unique key: importKey, with "~2", "~3"... for repeats in one file. */
function keysFor(agents: ImportedAgent[]): string[] {
  const seen = new Map<string, number>()
  return agents.map((a) => {
    const base = importKey(a)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}~${n}`
  })
}

function uniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 44)}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

function describe(agent: ImportedAgent): string {
  if (agent.description.trim()) return agent.description.trim()
  const firstLine = agent.prompt.split('\n').map((l) => l.trim()).find(Boolean)
  return firstLine ? firstLine.slice(0, 200) : `Imported from ${AGENT_IMPORT_SOURCE_LABELS[agent.source]}.`
}

/** How strongly a role looks like an orchestrator (0 = not at all). */
function rootScore(r: { name: string; slug: string }): number {
  const text = `${r.name} ${r.slug}`
  if (/orchestrat/i.test(text)) return 3
  if (ROOT_NAME.test(r.name) || ROOT_NAME.test(r.slug)) return 2
  return 0
}

/** True when following reportsTo from any role loops. */
function findCycle(roles: Role[]): Role | undefined {
  const byId = new Map(roles.map((r) => [r.id, r]))
  for (const r of roles) {
    const seen = new Set<string>()
    let cur: Role | undefined = r
    while (cur && cur.reportsTo !== null) {
      if (seen.has(cur.id)) return r
      seen.add(cur.id)
      cur = byId.get(cur.reportsTo)
    }
  }
  return undefined
}

/**
 * Turn parsed agent definitions into the project's resulting org chart. Pure apart from newId. Throws a readable
 * error only for invalid choices (unknown manager, a cycle, a model the connection does not have).
 *
 * - 'replace' drops the existing chart; 'merge' keeps it and adds the imported roles under its root.
 * - OrgAI exports keep their hierarchy (reportsTo / spawnable by slug). Flat sources get a root: in replace mode
 *   the export's root, else the single opencode primary agent, else the role that looks most like an orchestrator,
 *   else the project's existing root (kept). In merge mode the existing root stays the root.
 * - Slug conflicts: 'add' renames, 'replace' takes the existing role's place (its id and reportsTo are kept).
 */
export function convertImport(input: ConvertInput): AgentImportPreview {
  const { existing, agents, mode, model: ctx } = input
  const warnings = [...(input.scanWarnings ?? [])]
  const choices = new Map((input.choices ?? []).filter((c) => c && typeof c.key === 'string').map((c) => [c.key, c]))
  const keys = keysFor(agents)
  for (const key of choices.keys()) if (!keys.includes(key)) warnings.push(`A choice refers to an agent that is no longer in the folder (${key.slice(0, 120)}); it was ignored.`)

  const existingRoot = existing.find((r) => r.reportsTo === null) ?? existing[0]
  const drafts: Draft[] = agents.map((agent, i) => {
    const key = keys[i]
    const choice = choices.get(key)
    let action: AgentImportAction = choice?.include === false ? 'skip' : choice?.action ?? 'add'
    if (action !== 'add' && action !== 'replace' && action !== 'skip') action = 'add'
    const notes = [...agent.notes]
    const mappedTools = mapTools(agent.tools, agent.deniedTools)
    const mapped = choice?.model !== undefined ? mapChosenModel(choice.model, ctx, agent.name) : mapImportedModel(agent.model, ctx, agent.tier)
    if (mapped.note) notes.push(mapped.note)
    if (mappedTools.dropped.length) notes.push(`Tools with no OrgAI equivalent were dropped: ${mappedTools.dropped.join(', ')}.`)
    if (agent.tools === undefined && agent.source !== 'orgai') notes.push(`No tool list given, so it gets ${mappedTools.tools.join(', ') || 'no tools'}.`)
    if (agent.prompt.length > PROMPT_EXCERPT_CHARS) notes.push(`The prompt is ${agent.prompt.length.toLocaleString('en-US')} characters; review all of it before applying.`)
    const prompt = agent.prompt.trim() || describe(agent)
    if (!agent.prompt.trim()) notes.push('The definition has no prompt; its description is used.')
    const role: Role = {
      id: newId('role'),
      slug: slugify(agent.slug || agent.name),
      name: agent.name.trim().slice(0, 80) || 'Imported role',
      description: describe(agent),
      responsibilities: (agent.responsibilities ?? []).filter((s) => typeof s === 'string' && s.trim()).slice(0, 20),
      prompt,
      tools: mappedTools.tools,
      model: mapped.model,
      ...(mapped.tier ? { tier: mapped.tier } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      canSpawn: agent.canSpawn ?? mappedTools.canSpawn,
      spawnable: [],
      reportsTo: null,
      position: { x: 0, y: 0 },
      color: agent.color && HEX_COLOR.test(agent.color) ? agent.color.toLowerCase() : ROLE_COLORS[(i + 1) % ROLE_COLORS.length]
    }
    return { key, agent, action, role, mapped, toolsDropped: mappedTools.dropped, notes, slugConflict: false, sourceManager: agent.reportsTo }
  })
  const included = drafts.filter((d) => d.action !== 'skip')

  if (!included.length) {
    if (!agents.length) warnings.push('No agent definitions were found in the project folder.')
    else warnings.push('Every imported agent is skipped, so the org chart stays as it is.')
    return finish(input, existing.map((r) => structuredClone(r)), drafts, [], warnings)
  }

  // ---------- base chart and root ----------
  let base: Role[] = mode === 'merge' ? existing.map((r) => structuredClone(r)) : []
  let root: Role | undefined
  if (mode === 'merge' && base.length) {
    root = base.find((r) => r.reportsTo === null) ?? base[0]
  } else {
    const exportRoot = included.find((d) => d.agent.source === 'orgai' && d.sourceManager === null)
    const primaries = included.filter((d) => d.agent.primary)
    const scored = included.map((d) => ({ d, s: rootScore(d.role) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
    const pick = exportRoot ?? (primaries.length === 1 ? primaries[0] : undefined) ?? scored[0]?.d
    if (pick) root = pick.role
    else if (existingRoot) {
      root = { ...structuredClone(existingRoot), spawnable: [] }
      base = [root]
      warnings.push(`No orchestrator was found among the imported agents, so they report to the existing ${existingRoot.name}.`)
    } else {
      root = included[0].role
      warnings.push(`No orchestrator was found among the imported agents; ${root.name} becomes the root.`)
    }
  }

  // ---------- slugs: conflicts with the base chart and among imports ----------
  const taken = new Set(base.map((r) => r.slug))
  const replaced = new Set<string>()
  for (const d of included) {
    const clash = base.find((r) => r.slug === d.role.slug && !replaced.has(r.id))
    const before = d.role.slug
    if (clash) {
      d.slugConflict = true
      if (d.action === 'replace') {
        d.replacesRoleId = clash.id
        replaced.add(clash.id)
        d.role.id = clash.id
        d.role.reportsTo = clash.reportsTo
        d.role.position = { ...clash.position }
        if (clash.mcpServers) d.role.mcpServers = [...clash.mcpServers]
        d.notes.push(`Replaces the existing ${clash.name}.`)
        if (clash === root) root = d.role
        continue
      }
      const renamed = uniqueSlug(d.role.slug, taken)
      warnings.push(`Duplicate slug "${d.role.slug}": ${d.role.name} was added as "${renamed}".`)
      d.notes.push(`Slug "${d.role.slug}" is taken; renamed to "${renamed}".`)
      d.role.slug = renamed
    } else if (taken.has(d.role.slug)) {
      const renamed = uniqueSlug(d.role.slug, taken)
      warnings.push(`Duplicate slug "${d.role.slug}" among the imported agents: ${d.role.name} became "${renamed}".`)
      d.notes.push(`Slug "${d.role.slug}" is used by another imported agent; renamed to "${renamed}".`)
      d.role.slug = renamed
    }
    if (d.action === 'replace' && !d.replacesRoleId && before === d.role.slug) d.notes.push('No existing role has this slug, so it is added.')
    taken.add(d.role.slug)
  }
  for (const d of included) if (d.action === 'replace' && !d.replacesRoleId) d.action = 'add'

  // ---------- hierarchy ----------
  const roles: Role[] = [...base.filter((r) => !replaced.has(r.id)), ...included.map((d) => d.role)]
  // Keep the base order for replaced roles: put the replacement where the old role was.
  for (const d of included) {
    if (!d.replacesRoleId) continue
    const at = base.findIndex((r) => r.id === d.replacesRoleId)
    const cur = roles.indexOf(d.role)
    roles.splice(cur, 1)
    roles.splice(Math.min(at, roles.length), 0, d.role)
  }
  const exportSlugs = new Map(included.filter((d) => d.agent.source === 'orgai' && d.agent.slug).map((d) => [slugify(d.agent.slug ?? ''), d.role]))
  for (const d of included) {
    if (d.role === root) {
      d.role.reportsTo = null
      continue
    }
    if (d.replacesRoleId) continue
    const manager = d.sourceManager ? exportSlugs.get(slugify(d.sourceManager)) : undefined
    d.role.reportsTo = manager && manager !== d.role ? manager.id : root?.id ?? null
  }
  if (root && root.reportsTo !== null) root.reportsTo = null

  // User choices: a new manager by slug or id.
  for (const d of included) {
    const want = choices.get(d.key)?.reportsTo
    if (want === undefined || want === null || want === '') continue
    const manager = roles.find((r) => r.id === want) ?? roles.find((r) => r.slug === want)
    if (!manager) throw new Error(`${d.role.name} cannot report to "${String(want).slice(0, 80)}": no such role in the org chart.`)
    if (manager === d.role) throw new Error(`${d.role.name} cannot report to itself.`)
    if (d.role === root) throw new Error(`${d.role.name} is the root and reports to nobody.`)
    d.role.reportsTo = manager.id
  }
  const cyclic = findCycle(roles)
  if (cyclic) throw new Error(`The reporting lines make a loop through ${cyclic.name}. Choose another manager.`)

  // Spawnable: export lists (by slug) plus every direct report; drop ids that left the chart.
  const ids = new Set(roles.map((r) => r.id))
  const slugToId = new Map(roles.map((r) => [r.slug, r.id]))
  for (const d of included) {
    const fromExport = (d.agent.spawnable ?? []).map((s) => exportSlugs.get(slugify(s))?.id ?? slugToId.get(s)).filter((x): x is string => !!x)
    // A replacement keeps the spawnable list of the role it replaces (cross-team grants included).
    const kept = d.replacesRoleId ? base.find((r) => r.id === d.replacesRoleId)?.spawnable ?? [] : []
    d.role.spawnable = [...kept, ...fromExport]
  }
  for (const r of roles) {
    const reports = roles.filter((x) => x.reportsTo === r.id).map((x) => x.id)
    const spawnable = [...new Set([...r.spawnable.filter((id) => ids.has(id) && id !== r.id), ...reports])]
    r.spawnable = spawnable
    if (reports.length) r.canSpawn = true
  }
  if (root) root.canSpawn = true

  layout(roles, new Set(included.filter((d) => !d.replacesRoleId).map((d) => d.role.id)), mode)
  const replacedRoleIds = mode === 'replace' ? existing.filter((r) => !ids.has(r.id) || replaced.has(r.id)).map((r) => r.id) : [...replaced]
  return finish(input, roles, drafts, replacedRoleIds, warnings)
}

/** Simple positions for new roles: rows by depth, 260 px apart, under the existing chart in merge mode. */
function layout(roles: Role[], fresh: Set<string>, mode: AgentImportMode): void {
  const byId = new Map(roles.map((r) => [r.id, r]))
  const depth = (r: Role): number => {
    let d = 0
    let cur: Role | undefined = r
    while (cur?.reportsTo && d < 50) {
      cur = byId.get(cur.reportsTo)
      d++
    }
    return d
  }
  const keptBottom = mode === 'merge' ? Math.max(0, ...roles.filter((r) => !fresh.has(r.id)).map((r) => r.position.y)) : 0
  const rows = new Map<number, Role[]>()
  for (const r of roles) {
    if (!fresh.has(r.id)) continue
    const d = depth(r)
    rows.set(d, [...(rows.get(d) ?? []), r])
  }
  for (const [d, row] of rows) {
    row.forEach((r, i) => {
      r.position = { x: (i - (row.length - 1) / 2) * 260, y: mode === 'merge' ? keptBottom + 200 * Math.max(1, d) : d * 200 }
    })
  }
}

function finish(input: ConvertInput, roles: Role[], drafts: Draft[], replacedRoleIds: string[], warnings: string[]): AgentImportPreview {
  const byId = new Map(roles.map((r) => [r.id, r]))
  const unknown = drafts.filter((d) => d.action !== 'skip' && d.mapped.unknown)
  for (const d of unknown) warnings.push(`${d.role.name}: model "${(d.agent.model ?? '').slice(0, 80)}" is not recognised; it uses the everyday tier (${d.role.model}).`)
  const instructionFiles = input.instructionFiles ?? []
  if (instructionFiles.length) warnings.push(`Instruction files are not turned into roles: ${instructionFiles.join(', ')}. The Architect reads them during setup.`)
  if (input.model.connection === 'litellm' && drafts.some((d) => d.action !== 'skip')) {
    const choice = adapterForProject({ provider: input.provider, roles }, input.model.catalog)
    if (choice.mismatched.length) {
      const names = choice.mismatched.map((id) => byId.get(id)?.name ?? id).join(', ')
      warnings.push(`On LiteLLM every role must use the root's model family; ${names} would need the other adapter. Change their models before running.`)
    }
  }
  const items: AgentImportItem[] = drafts.map((d) => {
    const manager = d.role.reportsTo ? byId.get(d.role.reportsTo) : undefined
    return {
      key: d.key,
      ...(d.action !== 'skip' ? { roleId: d.role.id } : {}),
      name: d.role.name,
      slug: d.role.slug,
      source: d.agent.source,
      file: d.agent.file,
      description: d.role.description,
      ...(d.agent.model ? { originalModel: d.agent.model } : {}),
      model: d.role.model,
      ...(d.role.tier ? { tier: d.role.tier } : {}),
      modelReason: d.mapped.reason,
      tools: [...d.role.tools],
      toolsDropped: [...d.toolsDropped],
      canSpawn: d.role.canSpawn,
      reportsTo: d.action === 'skip' ? null : manager ? manager.slug : null,
      promptExcerpt: d.agent.prompt.slice(0, PROMPT_EXCERPT_CHARS),
      promptLength: d.agent.prompt.length,
      action: d.action,
      ...(d.replacesRoleId ? { replacesRoleId: d.replacesRoleId } : {}),
      slugConflict: d.slugConflict,
      notes: d.notes
    }
  })
  return {
    mode: input.mode,
    roles,
    items,
    replacedRoleIds,
    warnings,
    connection: input.model.connection,
    instructionFiles: [...instructionFiles],
    digest: importDigest(input.agents)
  }
}

/** sha256 over what an import takes from each definition, so apply can refuse a folder that changed since the preview. */
export function importDigest(agents: readonly ImportedAgent[]): string {
  const h = createHash('sha256')
  for (const a of agents) {
    h.update(
      JSON.stringify([a.source, a.file, a.name, a.slug, a.description, a.prompt, a.model, a.effort, a.tools, a.deniedTools, a.canSpawn, a.reportsTo, a.spawnable, a.tier, a.primary])
    )
    h.update('\n')
  }
  return h.digest('hex')
}
