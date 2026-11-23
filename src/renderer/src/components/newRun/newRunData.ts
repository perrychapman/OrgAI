/**
 * Pure data for the New run page's side panels: the project's team groups and the earlier runs offered under
 * "Or pick up from". No store, no IPC; everything comes from records the renderer already holds.
 */
import type { Role, RunSummary } from '@shared/types'
import { chainGroups, isOpenStatus, lastActivityAt } from '../../lib/runChains'
import { isOrgChangeRun } from '../../lib/orgChange'

/** The role fields the page reads. */
export type TeamRole = Pick<Role, 'id' | 'name' | 'color' | 'reportsTo'> & { maxConcurrent?: number }

/** One group of the team: a direct report of the orchestrator and everyone below it. */
export interface TeamGroup {
  id: string
  name: string
  color: string
  /** The role names in the group, the group's lead first. */
  roleNames: string[]
  /** Every role id in the group, the group's lead first (excluding the lead excludes all of them). */
  roleIds: string[]
  /** How many roles the group holds (roles, not agents: a role may run more than once). */
  count: number
  /** Most agents the group can have at once, when every role in it has its own cap; null when that is not known. */
  agents: number | null
}

/** The orchestrator's direct reports as groups, in the org chart's saved order. Empty when there is no root or no report. */
export function teamGroups(roles: readonly TeamRole[]): TeamGroup[] {
  const root = roles.find((r) => r.reportsTo === null)
  if (!root) return []
  const children = new Map<string, typeof roles[number][]>()
  for (const r of roles) {
    if (r.reportsTo === null) continue
    const list = children.get(r.reportsTo) ?? []
    list.push(r)
    children.set(r.reportsTo, list)
  }
  return (children.get(root.id) ?? []).map((lead) => {
    const below: typeof roles[number][] = []
    const seen = new Set<string>([root.id, lead.id])
    const walk = (id: string): void => {
      for (const c of children.get(id) ?? []) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        below.push(c)
        walk(c.id)
      }
    }
    walk(lead.id)
    const members = [lead, ...below]
    return {
      id: lead.id,
      name: lead.name,
      color: lead.color,
      roleNames: members.map((r) => r.name),
      roleIds: members.map((r) => r.id),
      count: members.length,
      agents: capSum(members)
    }
  })
}

/** Sum of each role's own cap (maxConcurrent); null when any role has none (it may run more than once). */
function capSum(roles: readonly Pick<TeamRole, 'maxConcurrent'>[]): number | null {
  let n = 0
  for (const r of roles) {
    if (typeof r.maxConcurrent !== 'number' || !Number.isFinite(r.maxConcurrent) || r.maxConcurrent < 1) return null
    n += Math.floor(r.maxConcurrent)
  }
  return n
}

/** Group ids that are real groups of `roles`, in the groups' order (a stale id from a deleted role is dropped). */
export function validExcluded(groups: readonly TeamGroup[], off: readonly string[]): string[] {
  const set = new Set(off)
  return groups.filter((g) => set.has(g.id)).map((g) => g.id)
}

/**
 * What the aside says about the size of the team with `excluded` groups left out: "up to N agents" only when that is a
 * real ceiling (every included role has its own cap, or the project caps agents per run), otherwise "N roles".
 */
export function whoCountText(roles: readonly TeamRole[], excluded: readonly string[], maxAgentsPerRun?: number): string {
  const root = roles.find((r) => r.reportsTo === null)
  if (!root) return `${roles.length} ${roles.length === 1 ? 'role' : 'roles'}`
  const groups = teamGroups(roles).filter((g) => !excluded.includes(g.id))
  const roleCount = 1 + groups.reduce((n, g) => n + g.count, 0)
  const allCapped = groups.every((g) => g.agents !== null)
  const bound = typeof maxAgentsPerRun === 'number' && maxAgentsPerRun >= 1 ? Math.floor(maxAgentsPerRun) + 1 : null
  // The orchestrator is one agent; every other agent is a report counted against the caps.
  let ceiling: number | null = allCapped ? 1 + groups.reduce((n, g) => n + (g.agents ?? 0), 0) : null
  if (bound !== null) ceiling = ceiling === null ? bound : Math.min(ceiling, bound)
  if (ceiling !== null) return `up to ${ceiling} ${ceiling === 1 ? 'agent' : 'agents'}`
  return `${roleCount} ${roleCount === 1 ? 'role' : 'roles'}`
}

/**
 * The per-run spending limit the user typed: '' = none (the project default applies). Returns the USD figure, or a
 * problem sentence. It can only be lower than the project's limit (`projectCap`), never higher.
 */
export function parseRunLimit(text: string, projectCap?: number): { ok: true; usd: number | null } | { ok: false; problem: string } {
  const t = text.trim().replace(/^\$/, '')
  if (t === '') return { ok: true, usd: null }
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0) return { ok: false, problem: 'Enter an amount above $0, or leave it empty.' }
  if (typeof projectCap === 'number' && projectCap > 0 && n > projectCap) return { ok: false, problem: `The project’s limit is $${projectCap}. A run’s limit can only be lower.` }
  const usd = Math.round(n * 100) / 100
  if (usd <= 0) return { ok: false, problem: 'Enter an amount of at least $0.01, or leave it empty.' }
  return { ok: true, usd: typeof projectCap === 'number' && projectCap > 0 ? Math.min(usd, projectCap) : usd }
}

/** "Lead, Writer, Editor" for a group's roles, capped so a big group stays one line ("and 4 more"). */
export function roleNamesLine(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`
}

export interface PickUpRun {
  id: string
  summary: RunSummary
  at: number
}

/**
 * Earlier work runs of the project for "Or pick up from": one row per conversation (its newest run), newest first,
 * only runs that are no longer open (open ones are listed as "Other runs" already).
 */
export function pickUpRuns(summaries: readonly RunSummary[], limit = 3): PickUpRun[] {
  const out: PickUpRun[] = []
  for (const g of chainGroups(summaries)) {
    if (out.length >= limit) break
    if (g.first.kind !== 'work' || isOrgChangeRun(g.first) || g.members.some((m) => isOpenStatus(m.status))) continue
    out.push({ id: g.newest.id, summary: g.first, at: lastActivityAt(g.newest) })
  }
  return out
}
