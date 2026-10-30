import type { ConnectionId, DraftRequest, DraftResult, ModelRef, ModelTier, Project, Role, ToolName } from '@shared/types'
import { TOOL_CATALOG } from '@shared/types'
import { ROLE_COLORS, modelForTier, newId, settingTier, slugify, tierForModel, type TierContext } from '@shared/defaults'
import type { RuntimeAdapter } from '../runtime/types'

export interface DraftRole {
  name: string
  description: string
  responsibilities: string[]
  prompt: string
  tools: string[]
  model: string
  canSpawn: boolean
  spawnable: string[]
  reportsTo: string | null
}

export interface DraftPayload {
  rationale: string
  roles: DraftRole[]
}

const SYSTEM = `You design org charts of AI coding agents for OrgAI, a harness that runs a hierarchy of agents on a software project.

An org chart is a tree of roles. Exactly one role is the root orchestrator (reportsTo = null). Every other role reports to exactly one manager. A role with canSpawn=true may delegate to the roles listed in its spawnable array, which should normally be its direct reports. Roles with canSpawn=false do their own work and report back.

Design principles:
- Purpose-built roles: each role has a tight set of responsibilities and only the tools it needs. Reviewers and researchers get read-only tools.
- Right-size the model to the task by tier: "deep" for orchestration, architecture and hard debugging; "everyday" for implementation, testing and review; "fast" for lookups, summaries and mechanical chores. Use "top" only for the single hardest reasoning role if the project truly needs it.
- Keep it as small as the work allows. Three to seven roles is typical. Add a middle layer (a lead with its own reports) only when the project has clearly separate domains, such as frontend and backend, or app and infrastructure.
- Prompts are system prompts: second person, concrete, 60 to 160 words, describing how the role works and how it reports back.
- The description is one sentence telling a manager when to delegate to this role.

Available tools: ${TOOL_CATALOG.join(', ')}. (The Agent tool is granted automatically to roles with canSpawn=true; do not list it.)
Available model tiers: top, deep, everyday, fast (each maps to a concrete model on the project's connection), or inherit. Never name a vendor model.

Respond with a single JSON object and nothing else, no code fences, matching:
{
  "rationale": "two or three sentences on why this structure fits the project",
  "roles": [
    {
      "name": "Human-readable role name",
      "description": "When a manager should delegate to this role.",
      "responsibilities": ["..."],
      "prompt": "System prompt text.",
      "tools": ["Read", "Grep"],
      "model": "everyday",
      "canSpawn": false,
      "spawnable": ["Name of a direct report", "..."],
      "reportsTo": "Name of manager role or null"
    }
  ]
}`

function extractJson(text: string): DraftPayload {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('The drafter did not return JSON.')
  const parsed = JSON.parse(text.slice(start, end + 1)) as DraftPayload
  if (!Array.isArray(parsed.roles) || parsed.roles.length === 0) throw new Error('The drafter returned no roles.')
  return parsed
}

/** Assign canvas positions by tree depth so the chart lands in a readable layout. */
function layout(roles: Role[]): void {
  const byId = new Map(roles.map((r) => [r.id, r]))
  const depth = (r: Role): number => {
    let d = 0
    let cur: Role | undefined = r
    const seen = new Set<string>()
    while (cur?.reportsTo && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.reportsTo)
      d++
    }
    return d
  }
  const levels = new Map<number, Role[]>()
  for (const r of roles) {
    const d = depth(r)
    levels.set(d, [...(levels.get(d) ?? []), r])
  }
  for (const [d, group] of levels) {
    const width = (group.length - 1) * 300
    group.forEach((r, i) => {
      r.position = { x: i * 300 - width / 2, y: d * 210 }
    })
  }
}

/** The connection a proposed chart is mapped onto. Without one, tiers map through the anthropic builtins. */
export interface DraftModelContext {
  connection: ConnectionId
  tierModels: Partial<Record<ModelTier, ModelRef>>
  /** Exact model ids the connection lists as available; a proposed id in this list is kept. */
  models?: string[]
}

/**
 * A proposed role model onto a connection: a tier name or legacy Claude alias maps through modelForTier (nearest
 * mapped tier; nothing mapped = 'inherit'); a listed id is kept; anything else becomes the everyday tier.
 */
function mapModel(raw: unknown, ctx: DraftModelContext | undefined): { model: ModelRef; tier?: ModelTier } {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === 'inherit') return { model: 'inherit' }
  const tc: TierContext = ctx ? { connection: ctx.connection, tierModels: ctx.tierModels } : { connection: 'anthropic', tierModels: {} }
  const viaTier = (tier: ModelTier): { model: ModelRef; tier?: ModelTier } => modelForTier(tier, tc) ?? { model: 'inherit' }
  const asTier = settingTier(value)
  if (asTier) return viaTier(asTier)
  if (ctx?.models?.includes(value)) {
    const tier = tierForModel(value)
    return { model: value, ...(tier ? { tier } : {}) }
  }
  return viaTier('everyday')
}

export function toRoles(payload: DraftPayload, models?: DraftModelContext): Role[] {
  const validTools = new Set<string>(TOOL_CATALOG)
  const drafts = payload.roles

  const roles: Role[] = drafts.map((d, i) => ({
    id: newId('role'),
    slug: slugify(d.name),
    name: d.name?.trim() || `Role ${i + 1}`,
    description: d.description?.trim() || '',
    responsibilities: Array.isArray(d.responsibilities) ? d.responsibilities.map(String) : [],
    prompt: d.prompt?.trim() || '',
    tools: (Array.isArray(d.tools) ? d.tools : []).filter((t): t is ToolName => validTools.has(t)),
    ...mapModel(d.model, models),
    canSpawn: !!d.canSpawn,
    spawnable: [],
    reportsTo: null,
    position: { x: 0, y: 0 },
    color: ROLE_COLORS[i % ROLE_COLORS.length]
  }))

  // De-duplicate slugs.
  const seen = new Map<string, number>()
  for (const r of roles) {
    const n = seen.get(r.slug) ?? 0
    seen.set(r.slug, n + 1)
    if (n > 0) r.slug = `${r.slug}-${n + 1}`
  }

  const byName = new Map(drafts.map((d, i) => [d.name?.trim().toLowerCase(), roles[i]]))
  drafts.forEach((d, i) => {
    const role = roles[i]
    const manager = d.reportsTo ? byName.get(d.reportsTo.trim().toLowerCase()) : undefined
    role.reportsTo = manager && manager.id !== role.id ? manager.id : null
    role.spawnable = (Array.isArray(d.spawnable) ? d.spawnable : [])
      .map((n) => byName.get(String(n).trim().toLowerCase()))
      .filter((r): r is Role => !!r && r.id !== role.id)
      .map((r) => r.id)
    if (role.spawnable.length && !role.canSpawn) role.canSpawn = true
  })

  // Guarantee exactly one root: the first role without a manager keeps it, the rest report to it.
  const roots = roles.filter((r) => r.reportsTo === null)
  const root = roots[0] ?? roles[0]
  root.reportsTo = null
  for (const r of roles) if (r !== root && (r.reportsTo === null || !roles.some((x) => x.id === r.reportsTo))) r.reportsTo = root.id

  // Any manager implicitly may spawn its direct reports.
  for (const r of roles) {
    const reports = roles.filter((x) => x.reportsTo === r.id).map((x) => x.id)
    if (reports.length) {
      r.canSpawn = true
      r.spawnable = [...new Set([...r.spawnable, ...reports])]
    }
  }

  layout(roles)
  return roles
}

export async function draftOrgChart(
  adapter: RuntimeAdapter,
  project: Project,
  req: DraftRequest,
  /** The project's connection (ConnectionService.importModelContext): its deep tier drafts, its tiers map the result. */
  tiers?: TierContext
): Promise<DraftResult> {
  const existing =
    req.mode === 'revise'
      ? `\n\nCurrent org chart (revise this; keep what still fits):\n${JSON.stringify(
          project.roles.map((r) => ({
            name: r.name,
            description: r.description,
            responsibilities: r.responsibilities,
            prompt: r.prompt,
            tools: r.tools,
            model: r.model,
            canSpawn: r.canSpawn,
            spawnable: r.spawnable.map((id) => project.roles.find((x) => x.id === id)?.name).filter(Boolean),
            reportsTo: r.reportsTo ? project.roles.find((x) => x.id === r.reportsTo)?.name ?? null : null
          })),
          null,
          2
        )}`
      : ''

  const prompt = `Project: ${project.name}
Working directory: ${project.path}
Project brief: ${project.brief || '(none provided)'}

Instruction from the user:
${req.instruction}${existing}

Design the org chart now. Return only the JSON object.`

  const text = await adapter.complete({ system: SYSTEM, prompt, cwd: project.path, model: tiers ? modelForTier('deep', tiers)?.model : undefined })
  const payload = extractJson(text)
  const context: DraftModelContext | undefined = tiers
    ? { connection: tiers.connection, tierModels: tiers.tierModels, ...(tiers.catalog ? { models: tiers.catalog.map((m) => m.id) } : {}) }
    : undefined
  return { roles: toRoles(payload, context), rationale: payload.rationale ?? '' }
}
