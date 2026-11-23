/**
 * Pure data for the New run page's side panels: the project's team groups and the earlier runs offered under
 * "Or pick up from". No store, no IPC; everything comes from records the renderer already holds.
 */
import type { Role, RunSummary } from '@shared/types'
import { chainGroups, isOpenStatus, lastActivityAt } from '../../lib/runChains'
import { isOrgChangeRun } from '../../lib/orgChange'

/** One group of the team: a direct report of the orchestrator and everyone below it. */
export interface TeamGroup {
  id: string
  name: string
  color: string
  /** The role names in the group, the group's lead first. */
  roleNames: string[]
  /** How many roles the group holds (roles, not agents: a role may run more than once). */
  count: number
}

/** The orchestrator's direct reports as groups, in the org chart's saved order. Empty when there is no root or no report. */
export function teamGroups(roles: readonly Pick<Role, 'id' | 'name' | 'color' | 'reportsTo'>[]): TeamGroup[] {
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
    return { id: lead.id, name: lead.name, color: lead.color, roleNames: [lead.name, ...below.map((r) => r.name)], count: 1 + below.length }
  })
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
