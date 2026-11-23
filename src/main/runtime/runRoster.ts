import { isVirtualProjectId, type Role, type RunRosterChange, type RunRosterRole, type RunSummary } from '@shared/types'

/**
 * Whether an approved org chart reaches this run's roles: only on a host whose approval surface renders the org chart
 * diff against runBaseline with every field that can move (`host.liveRosterCards`, RunManagerOptions; the desktop app
 * sets it, the CLI / TUI / exec host does not: fail closed, a host is off until it opts in), and only for a team work
 * run of a stored project (never setup-like, assistant, quick / Chat or single-agent runs) whose session declares
 * RuntimeSession.liveRoster. Pure.
 */
export function liveRosterApplies(
  summary: Pick<RunSummary, 'kind' | 'projectId' | 'quick' | 'team'>,
  session: { liveRoster?: boolean } | undefined,
  host: { liveRosterCards?: boolean }
): boolean {
  return host.liveRosterCards === true && summary.kind === 'work' && !summary.quick && summary.team !== 'single' && !isVirtualProjectId(summary.projectId) && session?.liveRoster === true
}

/**
 * Whether a role edit the user saved themselves (projects:save on the user's own surface, hostChange.ts) reaches this
 * run's roles: the same runs and sessions as liveRosterApplies, on a host that passes the user's saves to live runs
 * (`host.liveHostChanges`). No card is involved, so what the card surface can show (liveRosterCards) does not decide
 * it: the user typed the edit. Pure.
 */
export function liveRosterTakesSave(
  summary: Pick<RunSummary, 'kind' | 'projectId' | 'quick' | 'team'>,
  session: { liveRoster?: boolean } | undefined,
  host: { liveRosterCards?: boolean; liveHostChanges?: boolean }
): boolean {
  return liveRosterApplies(summary, session, { liveRosterCards: host.liveRosterCards === true || host.liveHostChanges === true })
}

/**
 * Mid-run org changes (propose_org_change approved in a work run whose session sets RuntimeSession.liveRoster): what
 * RunManager applies to the running run's own roles (ctx.roles). Pure apart from the in-place update of `running`.
 *
 * THE INVARIANT (review, third round): the card the user approves is diffed against `OrgChartProposalPayload.runBaseline`
 * (the run's own view of its roles when the card was created), and a field moves in ctx.roles only if the card's value
 * differs from the baseline's value for that role. Running roles: the baseline must equal the running role (grants and
 * position aside), else the role is deferred (`stale`). Pending (deferred new) roles: compared with their baseline
 * entry. A role absent from the baseline is shown whole as added, so every field it brings was on the card. The save
 * never adds anything: only model / tier where the CARD changed them take the value the save resolved.
 */

/** Fields that never move with an org change: identity and grants (an org change never grants, review H1). */
const NEVER_MOVES = ['id', 'mcpServers', 'skills'] as const
/**
 * The root additionally keeps what live model switching owns (run.model, the root's effort choice), its connection and
 * whether it may delegate at all (canSpawn: a flip would change the root's own tool list, which an adapter may refuse
 * mid-run after ctx.roles already moved; review M1).
 */
const ROOT_KEEPS = ['model', 'tier', 'effort', 'connection', 'canSpawn'] as const
/** Not a change of the role (canvas only). Never moves. */
const IGNORED_IN_DIFF = ['position'] as const
/** Not compared between the baseline and the running role: grants follow approved grant changes on both sides. */
const NOT_COMPARED: ReadonlySet<string> = new Set(['mcpServers', 'skills', ...IGNORED_IN_DIFF])

export interface RosterApplyInput {
  /** The run's own roles (ctx.roles). Changed IN PLACE: objects keep their identity. */
  running: Role[]
  /** The project's roles as saved after the approved proposal (they may include a team-file pull of the same save). */
  saved: readonly Role[]
  /** The roles the approved card showed (OrgChartProposalPayload.roles, the complete chart). */
  proposed: readonly Role[]
  /**
   * OrgChartProposalPayload.runBaseline: what the card was diffed against (the run's view of its roles when the card was
   * created, set by RunManager only). Every move is a card-vs-baseline difference (see the invariant above). RunManager
   * always passes it; omitted (pure callers, adapter tests) = the running roles as they are now, with no pending roles.
   */
  baseline?: readonly Role[]
  /**
   * Grants the run's CURRENT view holds on a pending (deferred new) role, by id: approved on their own MCP / skill card
   * while the role waited (review L2). A role joining takes these and nothing else as grants; never the save's.
   */
  pendingGrants?: ReadonlyMap<string, Pick<Role, 'mcpServers' | 'skills'>>
  /**
   * The run's view entries NOW for roles that are not running (waiting roles), by id. A waiting role whose baseline entry
   * differs from its current entry (another card changed or removed it after this card was created), or that appeared
   * in the view after this card was created, is deferred `stale` and keeps its current entry. RunManager always passes
   * it; omitted (pure callers) = not checked.
   */
  currentView?: ReadonlyMap<string, Role>
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
  /**
   * New roles of the card that were deferred, as they would join (the card's fields under the invariant). The run's
   * view of its roles (ctx.project.roles) holds these, never the saved roles, so the next card is built from what the
   * user approved.
   */
  pending: Role[]
}

/**
 * Why a role waits for the next run. Users read these on screen (LiveRunChange.deferred, the run log, the card's
 * outcome): plain language about what the user did, accurate to the rule that deferred it.
 */
export const ROSTER_REASONS = {
  root: 'The new chart has a different top role than this run; the change applies from the next run.',
  delegation: 'This run must keep handing work to this role the way it did when it started; the change applies from the next run.',
  rootCanSpawn: 'The top role keeps whether it can hand out work until the next run. The rest of its change is in effect.',
  slug: 'A role removed earlier in this run had the same slug; this role joins from the next run.',
  stale: 'This role changed in this run after the change was proposed; the change applies from the next run.',
  unmatched: 'OrgAI could not match this role to the one that was shown; the change applies from the next run.',
  identity: 'The saved chart holds this new role under a different identity than the one shown; it joins from the next run.',
  slugTaken: 'A role in this run already uses this slug; this role joins from the next run.',
  slugChange: 'This run keeps the role under its current slug, and the change would give it another one; the change applies from the next run.',
  reporting: 'Applying this alone would leave a role with no manager to report to in this run; the change applies from the next run.'
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
 * Fields whose value, where the CARD changed them, is the one the save resolved (sanitizeRoleModels maps a tier or an
 * unknown id onto the connection's catalog). Every other changed field takes the card's value; an unchanged field
 * keeps the baseline's. A save-resolved model still passes `refuse` (placement, price).
 */
const SAVE_RESOLVES: ReadonlySet<string> = new Set(['model', 'tier'])

/**
 * A role's next definition under the invariant: per field, the baseline value where the card equals it; else the card's
 * value (model / tier: the save's). `base` is the running role for running roles (checked equal to the baseline first),
 * the baseline's pending entry for a waiting role, undefined for a role the card shows whole as added.
 */
function underInvariant(base: Role | undefined, card: Role, saved: Role | undefined): Role {
  const out: Loose = {}
  const b = (base ?? {}) as Loose
  const c = card as unknown as Loose
  const s = (saved ?? card) as unknown as Loose
  for (const k of new Set([...Object.keys(b), ...Object.keys(c)])) {
    const v = base && same(c[k], b[k]) ? b[k] : SAVE_RESOLVES.has(k) && s[k] !== undefined ? s[k] : c[k]
    if (v !== undefined) out[k] = v
  }
  return structuredClone(out) as unknown as Role
}

/**
 * A role joining the run (or waiting to) when the card showed it whole (no baseline entry): every field from the card
 * (model / tier as the save resolved them), no grants (an org change never grants). Never the saved role.
 */
export function joiningRole(card: Role, saved: Role): Role {
  const out = underInvariant(undefined, card, saved) as unknown as Loose
  delete out.mcpServers
  delete out.skills
  return out as unknown as Role
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

/** Ids of roles with no path to `rootId` (a missing manager, a cycle, or a second root). Pure. */
function unreachable(roles: readonly Role[], rootId: string): Set<string> {
  const byId = new Map(roles.map((r) => [r.id, r]))
  const bad = new Set<string>()
  for (const r of roles) {
    const seen = new Set<string>()
    let cur: Role | undefined = r
    while (cur && cur.reportsTo !== null && !seen.has(cur.id)) {
      seen.add(cur.id)
      cur = byId.get(cur.reportsTo)
    }
    if (!cur || cur.reportsTo !== null || cur.id !== rootId) bad.add(r.id)
  }
  return bad
}

/**
 * Apply the approved chart to the running roles, in place, under the invariant (see the top of this file):
 * - a running role the card names (by id) is rewritten in its own object with exactly the fields where the card
 *   differs from the baseline; it keeps the run's grants. The root keeps its model, tier, effort, connection and
 *   canSpawn (a card that changes canSpawn gets a `rootCanSpawn` deferral; the rest of the root's change applies);
 * - a role the run does not have joins: compared with its pending baseline entry if it waited, shown whole otherwise;
 *   grants only from the view's pending entry (`pendingGrants`);
 * - a running role that is neither in the chart (id or name) nor in the saved project leaves the array;
 * - roles of the saved project that are not the chart's never move, and no saved field ever does.
 * Deferred (as the run has it, applied from the next run), each with an OrgAI-written reason: everything when the
 * card's root is not the run's root; a running role whose baseline differs from it (`stale`); a role the save holds
 * under another identity (`unmatched`, `identity`); a role `refuse` names a reason for; a new role reusing the slug of
 * a role removed earlier or in this change; a removal or spawn change that would break a required delegation; any
 * change whose partial application would cut a role off from the root (`reporting`).
 */
export function applyRosterChange(input: RosterApplyInput): RosterApplyResult {
  const { running, saved, proposed } = input
  const baseline = input.baseline ?? running.map((r) => structuredClone(r))
  const obligations = input.obligations ?? {}
  const ids = new Set(proposed.map((r) => r.id))
  const names = new Set(proposed.map((r) => r.name))
  const isOwn = (r: Role): boolean => ids.has(r.id) || names.has(r.name)
  const cardById = new Map(proposed.map((r) => [r.id, r]))
  const cardByName = new Map(proposed.map((r) => [r.name, r]))
  const baseById = new Map(baseline.map((r) => [r.id, r]))
  const savedIdSet = new Set(saved.map((r) => r.id))
  /**
   * The card entry a saved role was approved as: by id; by name only for a card entry whose id the save does not have
   * (the save gave it another id), so a role a pull renamed to another card role's name never takes that role's fields.
   */
  const cardFor = (r: Role): Role | undefined => {
    const byId = cardById.get(r.id)
    if (byId) return byId
    const byName = cardByName.get(r.name)
    return byName && !savedIdSet.has(byName.id) ? byName : undefined
  }
  const mine = saved.filter(isOwn)
  const change: RunRosterChange = { added: [], changed: [], removed: [], deferred: [] }
  const defer = (id: string, name: string, reason: string): void => void change.deferred.push({ id, name, reason })
  const retired: Role[] = []
  const pending: Role[] = []
  const pendingGrants = (id: string): Pick<Role, 'mcpServers' | 'skills'> => {
    const g = input.pendingGrants?.get(id)
    return { ...(g?.mcpServers ? { mcpServers: [...g.mcpServers] } : {}), ...(g?.skills ? { skills: [...g.skills] } : {}) }
  }
  /** A role that is not running, as it would join under the invariant (grants only from the view's pending entry). */
  const waiting = (card: Role, stored: Role | undefined): Role => {
    const role = underInvariant(baseById.get(card.id), card, stored)
    delete role.mcpServers
    delete role.skills
    return { ...role, ...pendingGrants(card.id) }
  }
  /**
   * Review M3: a waiting role's baseline entry must still be its entry in the run's view (another card may have changed,
   * removed or added it since this card was created). Stale = undefined when it is current; else the entry to keep
   * (the CURRENT view entry, or null when the view no longer has it). Not checked without `currentView`.
   */
  const waitingStale = (id: string): Role | null | undefined => {
    const view = input.currentView
    if (!view) return undefined
    const base = baseById.get(id)
    const now = view.get(id)
    if (!base && !now) return undefined
    if (base && now && !differs(base, now, NOT_COMPARED)) return undefined
    return now ? structuredClone(now) : null
  }
  /** Defer a waiting role as stale, keeping its current view entry in pending. True when it was stale. */
  const deferIfStaleWaiting = (card: Role): boolean => {
    const keep = waitingStale(card.id)
    if (keep === undefined) return false
    defer(card.id, card.name, ROSTER_REASONS.stale)
    if (keep) pending.push(keep)
    return true
  }
  const root = running.find((r) => r.reportsTo === null) ?? running[0]
  // The card's root decides (a pull may move a parent; only the card was approved).
  const proposedRoot = proposed.find((r) => r.reportsTo === null)
  if (!root || !proposedRoot || proposedRoot.id !== root.id) {
    for (const r of mine) {
      const card = cardFor(r)
      if (card && !running.some((x) => x.id === r.id)) {
        const keep = waitingStale(card.id)
        if (keep !== undefined) {
          defer(r.id, r.name, ROSTER_REASONS.stale)
          if (keep) pending.push(keep)
          continue
        }
        pending.push(waiting(card, card.id === r.id ? r : undefined))
      }
      defer(r.id, r.name, ROSTER_REASONS.root)
    }
    return { change, retired, pending }
  }
  const byId = new Map(running.map((r) => [r.id, r]))
  // Removals are decided first so a new role cannot take the slug of one leaving in this same change. Review M2: a
  // running role this card's baseline does not have (it joined after the card was created) is never removed by it.
  const leaving = new Set(running.filter((r) => r !== root && !isOwn(r) && !savedIdSet.has(r.id) && baseById.has(r.id) && !obligated(obligations, r.id)).map((r) => r.id))
  const takenSlugs = new Set([...(input.retiredSlugs ?? []), ...running.filter((r) => leaving.has(r.id)).map((r) => r.slug)])
  const runningSlugs = new Map(running.map((r) => [r.slug, r.id]))
  /** Planned rewrites of running roles: applied only after the reporting check. */
  const plans = new Map<string, { before: Role; next: Role; keep: ReadonlySet<string> }>()
  const added: Role[] = []
  for (const stored of mine) {
    const card = cardFor(stored)
    const before = byId.get(stored.id)
    if (!card) {
      // L3: never dropped silently. A running one stays as it is; a new one has no approved value to show.
      defer(stored.id, stored.name, ROSTER_REASONS.unmatched)
      continue
    }
    if (before) {
      const isRoot = before === root
      const keep = new Set<string>([...NEVER_MOVES, ...(isRoot ? ROOT_KEEPS : [])])
      const base = baseById.get(before.id)
      // The card was diffed against `base`; it must still be the running role, or nothing of it moves.
      if (!base || differs(base, before, NOT_COMPARED)) {
        if (!same(card, base)) defer(before.id, before.name, ROSTER_REASONS.stale)
        continue
      }
      // Review L4: a running role's slug is its identity (spawn name, MCP grants by slug): a card never changes it.
      // The host route (a desktop rename, hostChange.ts keepRunSlugs) takes the slug out first; the run's own card keeps
      // this rule.
      if (card.slug !== before.slug) {
        defer(before.id, before.name, ROSTER_REASONS.slugChange)
        continue
      }
      const next = underInvariant(before, card, stored)
      if (isRoot && next.canSpawn !== before.canSpawn) defer(before.id, before.name, ROSTER_REASONS.rootCanSpawn)
      if (!differs(before, next, new Set([...keep, ...IGNORED_IN_DIFF]))) continue
      if (!isRoot) {
        const reason = input.refuse?.(next, before)
        if (reason) {
          defer(next.id, next.name, reason)
          continue
        }
      }
      const owed = obligations[before.id] ?? []
      if (owed.length && (!next.canSpawn || !owed.every((id) => next.spawnable.includes(id)))) {
        defer(next.id, next.name, ROSTER_REASONS.delegation)
        continue
      }
      // Position never moves (canvas only); grants and the kept fields stay as the run has them.
      plans.set(before.id, { before, next, keep: new Set([...keep, ...IGNORED_IN_DIFF]) })
      continue
    }
    // A role that is not in the run (M1): it must be the card's own role, under the card's id and slug, and its slug
    // must be free in this run; otherwise the save matched it to some other stored role the user never saw.
    if (deferIfStaleWaiting(card)) continue
    const clash = runningSlugs.get(card.slug)
    if (takenSlugs.has(card.slug)) {
      defer(card.id, card.name, ROSTER_REASONS.slug)
      pending.push(waiting(card, stored.id === card.id ? stored : undefined))
      continue
    }
    if (stored.id !== card.id || stored.slug !== card.slug || (clash !== undefined && clash !== card.id)) {
      defer(card.id, card.name, clash !== undefined && clash !== card.id ? ROSTER_REASONS.slugTaken : ROSTER_REASONS.identity)
      pending.push(waiting(card, undefined))
      continue
    }
    const fresh = waiting(card, stored)
    const reason = input.refuse?.(fresh, undefined)
    if (reason) {
      defer(fresh.id, fresh.name, reason)
      pending.push(fresh)
      continue
    }
    added.push(fresh)
  }
  // Removals the plan cannot make: never the root, never a role the chart names, never one the saved project has.
  for (const r of running) {
    if (r === root || isOwn(r) || savedIdSet.has(r.id) || leaving.has(r.id)) continue
    defer(r.id, r.name, baseById.has(r.id) ? ROSTER_REASONS.delegation : ROSTER_REASONS.stale)
  }
  // L1: the run's roles after a PARTIAL application must still all reach the root. Undo the parts that cut a role off.
  const simulate = (): Role[] => {
    const out: Role[] = []
    for (const r of running) {
      if (leaving.has(r.id)) continue
      const plan = plans.get(r.id)
      if (!plan) out.push(r)
      else {
        const copy = structuredClone(r)
        rewrite(copy, plan.next, plan.keep)
        out.push(copy)
      }
    }
    return [...out, ...added]
  }
  for (let pass = 0; pass <= running.length + added.length + 1; pass++) {
    const bad = unreachable(simulate(), root.id)
    if (!bad.size) break
    let progressed = false
    for (const id of bad) {
      const i = added.findIndex((r) => r.id === id)
      if (i >= 0) {
        const [r] = added.splice(i, 1)
        defer(r.id, r.name, ROSTER_REASONS.reporting)
        pending.push(r)
        progressed = true
      } else if (plans.get(id) && plans.get(id)!.next.reportsTo !== plans.get(id)!.before.reportsTo) {
        const { before } = plans.get(id)!
        plans.delete(id)
        defer(before.id, before.name, ROSTER_REASONS.reporting)
        progressed = true
      }
    }
    if (progressed) continue
    // An unchanged role lost its manager (a removal, or its manager's own parent change): keep every removal and every
    // parent change for the next run.
    for (const id of [...leaving]) {
      const r = byId.get(id)!
      leaving.delete(id)
      defer(r.id, r.name, ROSTER_REASONS.reporting)
      progressed = true
    }
    for (const [id, plan] of [...plans]) {
      if (plan.next.reportsTo === plan.before.reportsTo) continue
      plans.delete(id)
      defer(plan.before.id, plan.before.name, ROSTER_REASONS.reporting)
      progressed = true
    }
    if (!progressed) {
      // Nothing left to undo but still broken: apply nothing of this card.
      for (const [, plan] of plans) defer(plan.before.id, plan.before.name, ROSTER_REASONS.reporting)
      for (const r of added) {
        defer(r.id, r.name, ROSTER_REASONS.reporting)
        pending.push(r)
      }
      plans.clear()
      added.length = 0
      break
    }
  }
  for (const [, plan] of plans) {
    rewrite(plan.before, plan.next, plan.keep)
    change.changed.push(plan.before.id)
  }
  for (let i = running.length - 1; i >= 0; i--) {
    const r = running[i]
    if (!leaving.has(r.id)) continue
    running.splice(i, 1)
    retired.unshift(structuredClone(r))
    change.removed.unshift(r.id)
  }
  for (const r of added) {
    running.push(r)
    change.added.push(r.id)
  }
  return { change, retired, pending }
}

/**
 * OrgChartProposalPayload.runBaseline for a card created now: the running roles (ctx.roles, which own model, effort and
 * grants), then the roles the run's view holds that are not running and not retired (deferred new roles as they would
 * join). Copies. Pure.
 */
export function runBaselineOf(ctx: { roles: readonly Role[]; project: { roles: readonly Role[] } }, retired: readonly Role[]): Role[] {
  const run = new Set(ctx.roles.map((r) => r.id))
  const gone = new Set(retired.map((r) => r.id))
  return [...ctx.roles, ...ctx.project.roles.filter((r) => !run.has(r.id) && !gone.has(r.id))].map((r) => structuredClone(r))
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
