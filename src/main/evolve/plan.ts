import { createHash } from 'node:crypto'
import { MAX_CONCURRENT_SUBAGENTS_LIMIT, DEFAULT_MAX_CONCURRENT_SUBAGENTS, effectiveRoleStaffing, settingTier, tierForModel } from '../../shared/defaults'
import type { EvolutionPlan, EvolutionRolePatch, EvolutionSkillPatch, Project, Role, Effort, ModelTier, ToolName } from '../../shared/types'
import { EFFORTS, MODEL_TIERS } from '../../shared/types'

/**
 * Pure helpers shared by the synthesizer, the safety gate and the service: constants, the stable fingerprint of a
 * mutation and `applyPlan`. No I/O.
 */

/** Most skills one generation may add or remove. */
export const MAX_PLAN_SKILLS = 3
/** Longest new role prompt a patch may carry. */
export const MAX_PATCH_PROMPT_CHARS = 20_000
/** Longest body of a skill the engine writes (the store allows far more; an evolved skill stays short). */
export const MAX_EVOLVED_SKILL_BODY = 6_000
/** The per-role prompt allowance the anti-bloat bound uses. */
export const PROMPT_BUDGET_PER_ROLE = 900
/** Most a plan may raise the project's concurrency limit by. */
export const MAX_CONCURRENCY_RAISE = 4
export const MIN_WASTE_DEFAULT = 15

/** Tools that write files or run commands. Never added by a plan. */
export const WRITE_EXEC_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'Bash', 'PowerShell', 'NotebookEdit'])
/** The only tools a plan may add: read-only or bookkeeping tools. */
export const SAFE_ADD_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(['Read', 'Glob', 'Grep', 'TodoWrite', 'ListAgents'])

export const effectiveConcurrency = (p: Pick<Project, 'maxConcurrentSubagents'>): number => {
  const n = p.maxConcurrentSubagents
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_CONCURRENT_SUBAGENTS_LIMIT) : DEFAULT_MAX_CONCURRENT_SUBAGENTS
}

export function isReviewRole(r: Pick<Role, 'slug' | 'name'>): boolean {
  return /review/i.test(r.slug) || /review/i.test(r.name)
}

const GUARD_NAME = /review|verif|qa\b|audit|secur|complian|test/i

/**
 * A role whose job is to check others (by name) or that another role must hand work to (`requiredReports`): its prompt, tools
 * and skill grants are never changed by an evolution. The root is protected separately (it only takes the fixed scope block).
 */
export function isGuardRole(r: Pick<Role, 'id' | 'slug' | 'name'>, roles: readonly Pick<Role, 'requiredReports'>[]): boolean {
  return GUARD_NAME.test(r.slug) || GUARD_NAME.test(r.name) || roles.some((o) => o.requiredReports?.includes(r.id))
}

/** One tier step toward more (+1) or less (-1) capable; undefined at the end of the scale. MODEL_TIERS runs top -> fast. */
export function stepTier(t: ModelTier, dir: 1 | -1): ModelTier | undefined {
  return MODEL_TIERS[MODEL_TIERS.indexOf(t) - dir]
}
export function stepEffort(e: Effort, dir: 1 | -1): Effort | undefined {
  return EFFORTS[EFFORTS.indexOf(e) + dir]
}

const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .filter((k) => o[k] !== undefined)
        .map((k) => [k, sortKeys(o[k])])
    )
  }
  return v
}

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(sortKeys(v))).digest('hex').slice(0, 16)

const normPatch = (p: EvolutionRolePatch): Record<string, unknown> => ({
  slug: p.slug,
  tier: p.tier,
  effort: p.effort,
  staffing: p.staffing,
  prompt: p.prompt,
  addTools: p.addTools ? [...p.addTools].sort() : undefined,
  removeTools: p.removeTools ? [...p.removeTools].sort() : undefined,
  removeSkills: p.removeSkills ? [...p.removeSkills].sort() : undefined
})

/** Stable hash of one role patch (the reason text is not part of it). */
export function patchFingerprint(p: EvolutionRolePatch): string {
  return hash(normPatch(p))
}

const normSkill = (s: EvolutionSkillPatch): Record<string, unknown> => ({ name: s.name, description: s.description, body: s.body, grantTo: [...s.grantTo].sort() })

/** Stable hash of the whole mutation (patches by slug, skills by name, prunes, limit). Rationale and reasons are not part of it. */
export function planFingerprint(p: Pick<EvolutionPlan, 'rolePatches' | 'newSkills' | 'pruneSkillIds' | 'maxConcurrentSubagents'>): string {
  return hash({
    patches: [...p.rolePatches].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)).map(normPatch),
    skills: [...p.newSkills].sort((a, b) => (a.name < b.name ? -1 : 1)).map(normSkill),
    prune: [...p.pruneSkillIds].sort(),
    max: p.maxConcurrentSubagents
  })
}

export function isPlanEmpty(p: Pick<EvolutionPlan, 'rolePatches' | 'newSkills' | 'pruneSkillIds' | 'maxConcurrentSubagents'>): boolean {
  return !p.rolePatches.length && !p.newSkills.length && !p.pruneSkillIds.length && p.maxConcurrentSubagents === undefined
}

/** The Role fields a patch can change, as the keys of Role (for snapshots and rollback). */
export type PatchedField = 'tier' | 'model' | 'effort' | 'staffing' | 'prompt' | 'tools' | 'skills'

/** Which Role fields a patch changes (model follows tier when the model names a tier). */
export function touchedFields(p: EvolutionRolePatch, role: Role): PatchedField[] {
  const out: PatchedField[] = []
  if (p.tier !== undefined) {
    out.push('tier')
    if (nextModelFor(role, p.tier) !== undefined) out.push('model')
  }
  if (p.effort !== undefined) out.push('effort')
  if (p.staffing !== undefined) out.push('staffing')
  if (p.prompt !== undefined) out.push('prompt')
  if (p.addTools?.length || p.removeTools?.length) out.push('tools')
  if (p.removeSkills?.length) out.push('skills')
  return out
}

const TIER_NAMES: readonly string[] = MODEL_TIERS
const CLAUDE_ALIAS_FOR_TIER: Record<ModelTier, string> = {
  top: 'fable',
  deep: 'opus',
  everyday: 'sonnet',
  fast: 'haiku'
}

/**
 * The model a role should hold after a tier change, or undefined to leave it. A bare tier name stays a tier name; a
 * Claude tier alias (fable, opus, sonnet, haiku, opusplan) maps to the target tier's Claude alias so `adapterForProject`
 * keeps the role in the Claude model family and the Claude SDK receives a valid alias. Concrete model ids stay untouched.
 */
export function nextModelFor(role: Pick<Role, 'model'>, tier: ModelTier): string | undefined {
  const m = typeof role.model === 'string' ? role.model.trim().toLowerCase() : ''
  if (TIER_NAMES.includes(m)) return m !== tier ? tier : undefined
  const aliasTier = settingTier(m)
  return aliasTier !== undefined && aliasTier !== tier ? CLAUDE_ALIAS_FOR_TIER[tier] : undefined
}

/**
 * The tier a role really runs on, read as automatic staffing reads it (staffing.ts roleModelTier, resolveStaffing): a
 * tier name or Claude alias in `model` wins over `tier` (`{ model: 'haiku', tier: 'top' }` runs on fast), then `tier`,
 * then the family of a concrete model id; an 'inherit' role's own tier is its ceiling. Undefined when nothing says.
 * Every before / after comparison of the gate and the synthesizer uses this, so a raise is never read as a cut.
 */
export function effectiveTier(r: Pick<Role, 'model' | 'tier'>): ModelTier | undefined {
  const model = typeof r.model === 'string' ? r.model.trim() : ''
  const tier = typeof r.tier === 'string' && (MODEL_TIERS as readonly string[]).includes(r.tier) ? r.tier : undefined
  if (!model || model === 'inherit') return tier
  return settingTier(model) ?? tier ?? tierForModel(model)
}

const staffingText = (s: Role['staffing']): string =>
  s ? [s.mode, s.minTier ? `floor ${s.minTier}` : '', s.maxEffort ? `max effort ${s.maxEffort}` : ''].filter(Boolean).join(', ') : 'none'

/**
 * What one role patch changes, one `field before → after` item per field, for the text an apply prints. `role` is the
 * role as it was before the patch; without it only the new values are shown. Plain text: callers sanitize it for their
 * terminal (slugs, tool and skill ids come from the project).
 */
export function patchChanges(role: Pick<Role, 'tier' | 'model' | 'effort' | 'staffing' | 'prompt'> | undefined, p: EvolutionRolePatch): string[] {
  const from = (v: string | undefined): string => (role ? `${v ?? 'unset'} → ` : '')
  const out: string[] = []
  if (p.tier !== undefined) {
    const model = role ? nextModelFor(role, p.tier) : undefined
    out.push(`tier ${from(role ? effectiveTier(role) : undefined)}${p.tier}${model ? ` (model ${role?.model ?? 'unset'} → ${model})` : ''}`)
  }
  if (p.effort !== undefined) out.push(`effort ${from(role?.effort)}${p.effort}`)
  if (p.staffing) out.push(`staffing ${role ? `${staffingText(role.staffing)} → ` : ''}${staffingText(p.staffing)}`)
  if (p.prompt !== undefined) out.push(`prompt ${role ? `${Array.from(role.prompt ?? '').length} → ` : ''}${Array.from(p.prompt).length} characters`)
  if (p.addTools?.length) out.push(`+tools ${p.addTools.join(', ')}`)
  if (p.removeTools?.length) out.push(`-tools ${p.removeTools.join(', ')}`)
  if (p.removeSkills?.length) out.push(`-skills ${p.removeSkills.join(', ')}`)
  return out
}

/**
 * A role that runs as configured (effectiveRoleStaffing mode 'fixed'): the project runs `staffing: 'fixed'`, the role
 * carries `staffing.mode: 'fixed'`, or it is on a concrete model with no tier (an explicit pick of the user's). An
 * evolution never changes its tier, effort or staffing bounds: the gate trims such a patch and the synthesizer does not
 * propose one.
 */
export function isFixedRole(project: Pick<Project, 'staffing'>, role: Pick<Role, 'model' | 'tier' | 'effort' | 'staffing'>): boolean {
  return effectiveRoleStaffing(role, project).mode === 'fixed'
}

/** Whether a tier change on this role changes what it runs on (auto staffing reads the tier; a tier-named model follows it). */
export function tierMoves(project: Pick<Project, 'staffing'>, role: Pick<Role, 'model' | 'tier' | 'effort' | 'staffing'>): boolean {
  return effectiveRoleStaffing(role, project).mode === 'auto' || nextModelFor(role, 'fast') !== undefined || nextModelFor(role, 'deep') !== undefined
}

/**
 * Apply a plan's role patches and limit to a project. Pure; never mutates its input. A small purpose-built merge rather
 * than mergeOrgChart (setup/orgMerge.ts): that function replaces a role's prompt, tools, model and graph edges from a
 * whole proposed chart and does not carry tier, effort or staffing, so it cannot express a surgical patch; this keeps
 * every id, position, edge, grant and unrelated field exactly as it was. Skills (new / pruned) are applied through the
 * skills service by the caller, not here. A patch naming no role is ignored.
 */
export function applyPlan(project: Project, plan: Pick<EvolutionPlan, 'rolePatches' | 'maxConcurrentSubagents'>): Project {
  const bySlug = new Map(plan.rolePatches.map((p) => [p.slug, p]))
  const roles = project.roles.map((r): Role => {
    const p = bySlug.get(r.slug)
    if (!p) return r
    const next: Role = { ...r }
    if (p.tier !== undefined) {
      const m = nextModelFor(r, p.tier)
      next.tier = p.tier
      if (m !== undefined) next.model = m
    }
    if (p.effort !== undefined) next.effort = p.effort
    if (p.staffing !== undefined) next.staffing = { ...p.staffing }
    if (p.prompt !== undefined) next.prompt = p.prompt
    if (p.addTools?.length || p.removeTools?.length) {
      const drop = new Set<string>(p.removeTools ?? [])
      const tools = r.tools.filter((t) => !drop.has(t))
      for (const t of p.addTools ?? []) if (!tools.includes(t)) tools.push(t)
      next.tools = tools
    }
    if (p.removeSkills?.length && r.skills) {
      const drop = new Set(p.removeSkills)
      next.skills = r.skills.filter((s) => !drop.has(s))
    }
    return next
  })
  const out: Project = { ...project, roles }
  if (plan.maxConcurrentSubagents !== undefined) out.maxConcurrentSubagents = plan.maxConcurrentSubagents
  return out
}

/** Total prompt characters of a chart. */
export const totalPromptChars = (roles: readonly Pick<Role, 'prompt'>[]): number => roles.reduce((n, r) => n + (r.prompt?.length ?? 0), 0)

/** A one-line description of a plan for ledgers and rejection records, at most 200 characters. */
export function planSummary(p: Pick<EvolutionPlan, 'rolePatches' | 'newSkills' | 'pruneSkillIds' | 'maxConcurrentSubagents'>): string {
  const parts: string[] = []
  for (const r of p.rolePatches) {
    const f = [r.tier && `tier ${r.tier}`, r.effort && `effort ${r.effort}`, r.staffing && 'staffing', r.prompt !== undefined && 'prompt', (r.addTools?.length || r.removeTools?.length) && 'tools', r.removeSkills?.length && 'grants'].filter(Boolean)
    parts.push(`${r.slug}: ${f.join(', ') || 'no change'}`)
  }
  if (p.newSkills.length) parts.push(`+${p.newSkills.length} skill${p.newSkills.length === 1 ? '' : 's'}`)
  if (p.pruneSkillIds.length) parts.push(`-${p.pruneSkillIds.length} skill${p.pruneSkillIds.length === 1 ? '' : 's'}`)
  if (p.maxConcurrentSubagents !== undefined) parts.push(`concurrency ${p.maxConcurrentSubagents}`)
  const s = parts.join('; ') || 'no change'
  return s.length > 200 ? `${s.slice(0, 199)}…` : s
}

// ---------- managed file-scope block (fixed wording only) ---------------------------------------------------------------

export const SCOPE_OPEN = '<!-- evolve:file-scope -->'
export const SCOPE_CLOSE = '<!-- /evolve:file-scope -->'
export const SCOPE_TEXT = 'File scope: give each parallel report its own disjoint files or folders, and never assign one path to two reports at the same time.'
const SCOPE_LINES = [SCOPE_OPEN, SCOPE_TEXT, SCOPE_CLOSE]

const norm = (l: string): string => l.replace(/\r$/, '').trimEnd()
const linesOf = (text: string): string[] => text.replace(/\r\n/g, '\n').split('\n').map(norm)

/** The managed block's line range when the text holds exactly one opening and one closing marker line, in order. */
function blockRange(lines: string[]): [number, number] | null {
  const opens = lines.map((l, i) => (l.trim() === SCOPE_OPEN ? i : -1)).filter((i) => i >= 0)
  const closes = lines.map((l, i) => (l.trim() === SCOPE_CLOSE ? i : -1)).filter((i) => i >= 0)
  return opens.length === 1 && closes.length === 1 && closes[0] > opens[0] ? [opens[0], closes[0]] : null
}

const trimTail = (lines: string[]): string[] => {
  const out = [...lines]
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}

/**
 * Put the file-scope rule block in a prompt. FIXED wording only: nothing derived from a run or a repository ever enters a
 * prompt. A well-formed managed block is REPLACED; with malformed markers (missing, repeated or closing before opening)
 * every marker line and stray copy of the rule line is removed and one clean block is added.
 */
export function upsertScopeBlock(prompt: string): string {
  const lines = linesOf(prompt)
  const r = blockRange(lines)
  if (r) return [...lines.slice(0, r[0]), ...SCOPE_LINES, ...lines.slice(r[1] + 1)].join('\n')
  const kept = lines.filter((l) => l.trim() !== SCOPE_OPEN && l.trim() !== SCOPE_CLOSE && l.trim() !== SCOPE_TEXT)
  return `${trimTail(kept).join('\n')}\n\n${SCOPE_LINES.join('\n')}`
}

/** True when the prompt holds a well-formed managed block whose content is not the fixed wording (a person wrote in it): never patched. */
export function managedBlockEdited(prompt: string): boolean {
  const lines = linesOf(prompt)
  const r = blockRange(lines)
  return !!r && lines.slice(r[0], r[1] + 1).join('\n') !== SCOPE_LINES.join('\n')
}

/** A prompt split into its text and the managed block (null when it has none or the markers are malformed). */
export function splitScopeBlock(prompt: string): { rest: string[]; block: string[] | null; malformed: boolean } {
  const lines = linesOf(prompt)
  const r = blockRange(lines)
  const hasMarker = lines.some((l) => l.trim() === SCOPE_OPEN || l.trim() === SCOPE_CLOSE)
  if (r) return { rest: trimTail([...lines.slice(0, r[0]), ...lines.slice(r[1] + 1)]), block: lines.slice(r[0], r[1] + 1), malformed: false }
  return { rest: trimTail(lines), block: null, malformed: hasMarker }
}

/** True when every line of `next` is a line of `prev`, in the same order (pure deletion), apart from the managed block, which must be the fixed one. */
export function isPromptSubset(prev: string, next: string): boolean {
  const n = splitScopeBlock(next)
  if (n.malformed) return false
  if (n.block && n.block.join('\n') !== SCOPE_LINES.join('\n')) return false
  const o = splitScopeBlock(prev)
  let at = 0
  for (const line of n.rest) {
    while (at < o.rest.length && o.rest[at] !== line) at++
    if (at >= o.rest.length) return false
    at++
  }
  return true
}

/** True when `next` differs from `prev` only in the managed block (same other lines, same order). */
export function onlyScopeBlockChanged(prev: string, next: string): boolean {
  const n = splitScopeBlock(next)
  const o = splitScopeBlock(prev)
  return !n.malformed && (!n.block || n.block.join('\n') === SCOPE_LINES.join('\n')) && n.rest.join('\n') === o.rest.join('\n')
}

// ---------- deterministic compression ----------------------------------------------------------------------------------

const TERMINAL = /[.!?]\s*$/

/**
 * Shorten a prompt by removing ONLY exact duplicate lines and blank-line runs. A line is dropped as a duplicate (outside code
 * fences, case and spacing folded, 12+ characters, never a heading) only when it ends with terminal punctuation AND the line
 * kept before it is blank, absent or ends with terminal punctuation too, so removing it can never join or alter a sentence.
 * Every other line, unique or not, stays exactly as written. `changed` is false when nothing was removed. The safety gate
 * recomputes this function itself and accepts a prompt patch only when it equals its result.
 */
export function compressPrompt(prompt: string): { prompt: string; changed: boolean } {
  const out: string[] = []
  const seen = new Set<string>()
  let fence = false
  for (const line of prompt.split('\n')) {
    const t = line.trim()
    if (/^\s*(?:```|~~~)/.test(line)) {
      fence = !fence
      out.push(line)
      continue
    }
    if (fence) {
      out.push(line)
      continue
    }
    if (!t) {
      if (out.length && out[out.length - 1].trim() !== '') out.push(line)
      continue
    }
    const key = t.toLowerCase().replace(/\s+/g, ' ')
    const prev = [...out].reverse().find((l) => l.trim() !== '')
    const prevLast = out.length ? out[out.length - 1] : undefined
    const joinsSafe = prevLast === undefined || prevLast.trim() === '' || (prev !== undefined && TERMINAL.test(prev))
    if (t.length >= 12 && !t.startsWith('#') && seen.has(key) && TERMINAL.test(t) && joinsSafe) continue
    seen.add(key)
    out.push(line)
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  const next = out.join('\n')
  const changed = next.length < prompt.length && next.trim().length > 0
  return { prompt: changed ? next : prompt, changed }
}

