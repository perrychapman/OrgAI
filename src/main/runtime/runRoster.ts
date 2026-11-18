import { isVirtualProjectId, type Role, type RunRosterChange, type RunRosterRole, type RunSummary } from '@shared/types'

/**
 * Whether an approved org chart reaches this run's roles: a team work run of a stored project (never setup-like,
 * assistant, quick / Chat or single-agent runs) whose session declares RuntimeSession.liveRoster. Pure.
 */
export function liveRosterApplies(summary: Pick<RunSummary, 'kind' | 'projectId' | 'quick' | 'team'>, session: { liveRoster?: boolean } | undefined): boolean {
  return summary.kind === 'work' && !summary.quick && summary.team !== 'single' && !isVirtualProjectId(summary.projectId) && session?.liveRoster === true
}

/**
 * Mid-run org changes (propose_org_change approved in a work run whose session sets RuntimeSession.liveRoster): what
 * RunManager applies to the running run's own roles (ctx.roles). Pure apart from the in-place update of `running`.
 */

/** Fields that never move with an org change: identity and grants (an org change never grants, review H1). */
const NEVER_MOVES = ['id', 'mcpServers', 'skills'] as const
/**
 * The root additionally keeps what live model switching owns (run.model, the root's effort choice), its connection and
 * whether it may delegate at all (canSpawn: a flip would change the root's own tool list, which an adapter may refuse
 * mid-run after ctx.roles already moved; review M1).
 */
const ROOT_KEEPS = ['model', 'tier', 'effort', 'connection', 'canSpawn'] as const
/** Not a change of the role (canvas only). Copied anyway. */
const IGNORED_IN_DIFF = ['position'] as const

export interface RosterApplyInput {
  /** The run's own roles (ctx.roles). Changed IN PLACE: objects keep their identity. */
  running: Role[]
  /** The project's roles as saved after the approved proposal (they may include a team-file pull of the same save). */
  saved: readonly Role[]
  /**
   * The roles the approved card showed (OrgChartProposalPayload.roles, the complete chart): only these move into the
   * run, and of a changed role only the fields the card changed (see applyRosterChange).
   */
  proposed: readonly Role[]
  /** The run's required-delegation obligations (ledger: role id -> required report ids); {} or undefined = none. */
  obligations?: Readonly<Record<string, readonly string[]>>
  /**
   * Why a new (`before` undefined) or changed role cannot join this run, or undefined when it can. RunManager checks the
   * connection / adapter placement and an unpriced model under a budget. Never called for the root.
   */
  refuse?: (role: Role, before: Role | undefined) => string | undefined
  /**
   * Slugs of roles removed earlier in this run (RuntimeContext.retiredRoles). A new role reusing one, or the slug of a
   * role this same change removes, is deferred: an agent still running on the old role would be confused with it by
   * slug (review M2).
   */
  retiredSlugs?: readonly string[]
}

export interface RosterApplyResult {
  change: RunRosterChange
  /** Copies of the roles removed from `running` by this change, as they were. */
  retired: Role[]
}

export const ROSTER_REASONS = {
  root: 'The approved chart has a different root role; it applies from the next run.',
  delegation: 'A required delegation this run already enforces depends on this role; the change applies from the next run.',
  rootCanSpawn: 'The root keeps whether it may delegate for this run; that part applies from the next run. The rest of its change is in effect.',
  slug: 'A role removed earlier in this run used this slug; it applies from the next run.'
} as const

type Loose = Record<string, unknown>

function differs(before: Role, next: Role, skip: ReadonlySet<string>): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(next)])
  for (const k of keys) {
    if (skip.has(k)) continue
    if (JSON.stringify((before as unknown as Loose)[k]) !== JSON.stringify((next as unknown as Loose)[k])) return true
  }
  return false
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * A running role's next definition, field by field: the saved value where it agrees with the card; the running value
 * where the card left the field as it was (only a same-save team-file pull changed it, which never reaches a live run);
 * the saved value where the card changed the field and the save normalised it (or a pull changed it too: the stored
 * value wins).
 */
function merged(before: Role, card: Role, saved: Role): Role {
  const out: Loose = {}
  const b = before as unknown as Loose
  const c = card as unknown as Loose
  const s = saved as unknown as Loose
  for (const k of new Set([...Object.keys(b), ...Object.keys(s), ...Object.keys(c)])) {
    const v = same(s[k], c[k]) ? s[k] : same(c[k], b[k]) ? b[k] : s[k]
    if (v !== undefined) out[k] = v
  }
  return structuredClone(out) as unknown as Role
}

/** Rewrite `role` in place from `next`, keeping the fields in `keep`. */
function rewrite(role: Role, next: Role, keep: ReadonlySet<string>): void {
  const target = role as unknown as Loose
  const source = structuredClone(next) as unknown as Loose
  for (const k of Object.keys(target)) if (!keep.has(k) && !(k in source)) delete target[k]
  for (const [k, v] of Object.entries(source)) if (!keep.has(k)) target[k] = v
}

function obligated(obligations: Readonly<Record<string, readonly string[]>>, roleId: string): boolean {
  if (obligations[roleId]?.length) return true
  return Object.values(obligations).some((list) => list.includes(roleId))
}

/**
 * Apply the approved chart's own roles to the running roles, in place:
 * - a role of the chart that the run has (by id) and that differs in anything but grants and position is rewritten in
 *   its own object with the fields the card changed (`merged`); it keeps the run's grants. The root keeps its model,
 *   tier, effort, connection and canSpawn (a card that changes canSpawn gets a `rootCanSpawn` deferral; the rest of the
 *   root's change applies);
 * - a role of the chart the run does not have is appended as saved, with no MCP / skill grants;
 * - a running role that is neither in the chart (id or name) nor in the saved project leaves the array;
 * - roles of the saved project that are not the chart's, and fields of the chart's roles the card did not change (a
 *   team-file pull of the same save), never move.
 * Deferred (left as the run started, applied from the next run): everything when the chart's root is not the run's
 * root; a role `refuse` names a reason for; a new role reusing the slug of a role removed earlier in the run or in this
 * change; a removal or a spawn change that would break a required delegation the run already enforces.
 */
export function applyRosterChange(input: RosterApplyInput): RosterApplyResult {
  const { running, saved, proposed } = input
  const obligations = input.obligations ?? {}
  const ids = new Set(proposed.map((r) => r.id))
  const names = new Set(proposed.map((r) => r.name))
  const isOwn = (r: Role): boolean => ids.has(r.id) || names.has(r.name)
  const cardById = new Map(proposed.map((r) => [r.id, r]))
  const cardByName = new Map(proposed.map((r) => [r.name, r]))
  const mine = saved.filter(isOwn)
  const change: RunRosterChange = { added: [], changed: [], removed: [], deferred: [] }
  const retired: Role[] = []
  const root = running.find((r) => r.reportsTo === null) ?? running[0]
  const proposedRoot = mine.find((r) => r.reportsTo === null)
  if (!root || !proposedRoot || proposedRoot.id !== root.id) {
    for (const r of mine) change.deferred.push({ id: r.id, name: r.name, reason: ROSTER_REASONS.root })
    return { change, retired }
  }
  const savedIds = new Set(saved.map((r) => r.id))
  const byId = new Map(running.map((r) => [r.id, r]))
  // Removals are decided first so a new role cannot take the slug of one leaving in this same change.
  const leaving = new Set(running.filter((r) => r !== root && !isOwn(r) && !savedIds.has(r.id) && !obligated(obligations, r.id)).map((r) => r.id))
  const takenSlugs = new Set([...(input.retiredSlugs ?? []), ...running.filter((r) => leaving.has(r.id)).map((r) => r.slug)])
  const added: Role[] = []
  for (const stored of mine) {
    const before = byId.get(stored.id)
    const isRoot = before === root
    const keep = new Set<string>([...NEVER_MOVES, ...(isRoot ? ROOT_KEEPS : [])])
    if (before) {
      const card = cardById.get(stored.id) ?? cardByName.get(stored.name) ?? stored
      const next = merged(before, card, stored)
      if (isRoot && next.canSpawn !== before.canSpawn) change.deferred.push({ id: before.id, name: before.name, reason: ROSTER_REASONS.rootCanSpawn })
      if (!differs(before, next, new Set([...keep, ...IGNORED_IN_DIFF]))) continue
      if (!isRoot) {
        const reason = input.refuse?.(next, before)
        if (reason) {
          change.deferred.push({ id: next.id, name: next.name, reason })
          continue
        }
      }
      const owed = obligations[before.id] ?? []
      if (owed.length && (!next.canSpawn || !owed.every((id) => next.spawnable.includes(id)))) {
        change.deferred.push({ id: next.id, name: next.name, reason: ROSTER_REASONS.delegation })
        continue
      }
      rewrite(before, next, keep)
      change.changed.push(before.id)
      continue
    }
    const reason = takenSlugs.has(stored.slug) ? ROSTER_REASONS.slug : input.refuse?.(stored, undefined)
    if (reason) {
      change.deferred.push({ id: stored.id, name: stored.name, reason })
      continue
    }
    const fresh = structuredClone(stored)
    delete fresh.mcpServers
    delete fresh.skills
    added.push(fresh)
  }
  // Removals: never the root, never a role the chart names, never one the saved project still has.
  for (let i = running.length - 1; i >= 0; i--) {
    const r = running[i]
    if (r === root || isOwn(r) || savedIds.has(r.id)) continue
    if (!leaving.has(r.id)) {
      change.deferred.push({ id: r.id, name: r.name, reason: ROSTER_REASONS.delegation })
      continue
    }
    running.splice(i, 1)
    retired.unshift(structuredClone(r))
    change.removed.unshift(r.id)
  }
  for (const r of added) {
    running.push(r)
    change.added.push(r.id)
  }
  return { change, retired }
}

/** True when the change applied anything (a `run.roster` event and the configChanged call follow). */
export function rosterChanged(change: RunRosterChange): boolean {
  return change.added.length + change.changed.length + change.removed.length > 0
}

/**
 * The display roster (RunRecord.roster): the running roles in order, `added` on roles that joined mid-run, then the
 * retired roles (not running again) with `removed`.
 */
export function rosterOf(running: readonly Role[], retired: readonly Role[], addedIds: ReadonlySet<string>): RunRosterRole[] {
  const entry = (r: Role): RunRosterRole => ({ id: r.id, slug: r.slug, name: r.name, color: r.color, reportsTo: r.reportsTo })
  const live = new Set(running.map((r) => r.id))
  return [
    ...running.map((r) => ({ ...entry(r), ...(addedIds.has(r.id) ? { added: true as const } : {}) })),
    ...retired.filter((r) => !live.has(r.id)).map((r) => ({ ...entry(r), removed: true as const }))
  ]
}
