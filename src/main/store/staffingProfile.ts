import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Effort, ModelTier, RunRecord, StaffingGoal } from '@shared/types'
import { EFFORTS, isModelTier } from '@shared/types'
import { compareEffort, compareTier, isSafeId } from '@shared/defaults'
import type { StaffingRequest } from '../runtime/staffing'
import { writeFileDurable } from './durableFs'

/**
 * The per-project staffing profile (docs/design/orchestration-efficiency.md 4.5): the last assignments of a project's
 * runs, kept raw so medians can be recomputed, and the pure functions that turn them into a default pick for the
 * resolver and a one-line brief for the orchestrator. Stored at `<data>/staffing/<projectId>.json`. Electron-free.
 */

/** Entries kept per project. */
export const STAFFING_PROFILE_MAX_ENTRIES = 200
/** A cell needs this many assignments before it can supply a default. */
export const PROFILE_MIN_ASSIGNMENTS = 5
/** ... and at least this share of them passed first time. */
export const PROFILE_MIN_FIRST_PASS = 0.8
/** A profile file larger than this is treated as unreadable. */
export const STAFFING_PROFILE_MAX_FILE_BYTES = 256 * 1024
/** Longest role name in the brief. */
export const STAFFING_BRIEF_NAME_MAX_CHARS = 40

/** One assignment of a finished run. */
export interface StaffingProfileEntry {
  roleId: string
  tier?: ModelTier
  effort?: Effort
  /** It was the earliest assignment bound to its plan step (false when it had no step). */
  firstOfStep: boolean
  /** Bound to a step, the step's only assignment, the step done, and a valid delegation receipt. */
  passedFirstTime: boolean
  /** The assignment's source was 'escalated'. */
  escalated: boolean
  /** The agent's wall time in ms, when known. */
  wallMs?: number
  /** The agent's cost in USD, when known. */
  costUsd?: number
  /** When the assignment was made, epoch ms. */
  at: number
}

export interface StaffingProfile {
  entries: StaffingProfileEntry[]
}

/** Statistics of one role, tier and effort. */
export interface StaffingProfileCell {
  roleId: string
  tier?: ModelTier
  effort?: Effort
  assignments: number
  firstPasses: number
  escalations: number
  medianWallMs?: number
  medianCostUsd?: number
}

export function emptyStaffingProfile(): StaffingProfile {
  return { entries: [] }
}

function finiteNonNeg(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

/**
 * One entry per staffing assignment of the run that has an agentId. Passed first time = the assignment has a stepId,
 * is the only assignment bound to that step, the step's status is 'done', and the delegation ledger holds a receipt
 * for that agent (childId) that was delivered, has verdict 'ok' or 'adaptive' (not 'failed') and a non-empty report.
 * Wall time = the agent's endedAt minus startedAt (absent while it has not ended); cost = its usage costUsd (absent
 * when null). Pure.
 */
export function profileEntriesFromRun(run: RunRecord): StaffingProfileEntry[] {
  const assignments = run.staffing?.assignments ?? []
  const stepCount = new Map<string, number>()
  const firstOfStep = new Map<string, string | undefined>()
  for (const a of assignments) {
    if (!a.stepId) continue
    stepCount.set(a.stepId, (stepCount.get(a.stepId) ?? 0) + 1)
    if (!firstOfStep.has(a.stepId)) firstOfStep.set(a.stepId, a.agentId)
  }
  const steps = new Map((run.plan?.steps ?? []).map((s) => [s.id, s]))
  const receipts = run.delegation?.receipts ?? []
  const out: StaffingProfileEntry[] = []
  for (const a of assignments) {
    if (!a.agentId) continue
    const agent = run.agents?.[a.agentId]
    const entry: StaffingProfileEntry = {
      roleId: a.roleId,
      firstOfStep: !!a.stepId && firstOfStep.get(a.stepId) === a.agentId,
      passedFirstTime: false,
      escalated: a.source === 'escalated',
      at: a.at
    }
    if (a.tier) entry.tier = a.tier
    if (a.effort) entry.effort = a.effort
    if (agent && finiteNonNeg(agent.startedAt) && finiteNonNeg(agent.endedAt) && agent.endedAt >= agent.startedAt) {
      entry.wallMs = agent.endedAt - agent.startedAt
    }
    const cost = agent?.usage?.costUsd
    if (finiteNonNeg(cost)) entry.costUsd = cost
    if (a.stepId && stepCount.get(a.stepId) === 1 && steps.get(a.stepId)?.status === 'done') {
      entry.passedFirstTime = receipts.some(
        (r) => r.childId === a.agentId && r.delivered && r.verdict !== 'failed' && r.reportChars > 0
      )
    }
    out.push(entry)
  }
  return out
}

/** Append `entries` (oldest first) and keep the newest STAFFING_PROFILE_MAX_ENTRIES. Pure; the input is not changed. */
export function mergeProfile(profile: StaffingProfile, entries: StaffingProfileEntry[]): StaffingProfile {
  return { entries: [...profile.entries, ...entries].slice(-STAFFING_PROFILE_MAX_ENTRIES) }
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Statistics per role, tier and effort, derived from the raw entries. Pure. */
export function profileCells(profile: StaffingProfile): StaffingProfileCell[] {
  const groups = new Map<string, StaffingProfileEntry[]>()
  for (const e of profile.entries) {
    const key = JSON.stringify([e.roleId, e.tier ?? null, e.effort ?? null])
    const g = groups.get(key)
    if (g) g.push(e)
    else groups.set(key, [e])
  }
  const cells: StaffingProfileCell[] = []
  for (const g of groups.values()) {
    const first = g[0]
    const cell: StaffingProfileCell = {
      roleId: first.roleId,
      assignments: g.length,
      firstPasses: g.filter((e) => e.passedFirstTime).length,
      escalations: g.filter((e) => e.escalated).length
    }
    if (first.tier) cell.tier = first.tier
    if (first.effort) cell.effort = first.effort
    const wall = median(g.filter((e) => e.wallMs !== undefined).map((e) => e.wallMs as number))
    if (wall !== undefined) cell.medianWallMs = wall
    const cost = median(g.filter((e) => e.costUsd !== undefined).map((e) => e.costUsd as number))
    if (cost !== undefined) cell.medianCostUsd = cost
    cells.push(cell)
  }
  return cells
}

// An absent tier or effort ranks below every real one.
const tierRank = (t?: ModelTier): number => (t ? compareTier(t, 'fast') : -1)
const effortRank = (e?: Effort): number => (e ? compareEffort(e, 'low') : -1)

function byTierThenEffort(a: StaffingProfileCell, b: StaffingProfileCell): number {
  return tierRank(a.tier) - tierRank(b.tier) || effortRank(a.effort) - effortRank(b.effort)
}

function cmpOn(field: 'medianCostUsd' | 'medianWallMs') {
  return (a: StaffingProfileCell, b: StaffingProfileCell): number => {
    const x = a[field]
    const y = b[field]
    if (x !== undefined && y !== undefined && x !== y) return x - y
    return byTierThenEffort(a, b)
  }
}

/**
 * The profile's default pick for a role: among its cells with at least PROFILE_MIN_ASSIGNMENTS assignments and at
 * least PROFILE_MIN_FIRST_PASS first passes, the cheapest (balanced, cost) or the fastest (speed). When the compared
 * figure is unknown on either side or equal, the lower tier wins, then the lower effort. A cell on tier 'top' or on
 * effort 'xhigh' or 'max' is never returned, and a cell with neither tier nor effort has nothing to offer. Pure.
 */
export function profileDefault(profile: StaffingProfile, roleId: string, goal: StaffingGoal): StaffingRequest | undefined {
  const ok = profileCells(profile).filter(
    (c) =>
      c.roleId === roleId &&
      c.assignments >= PROFILE_MIN_ASSIGNMENTS &&
      c.firstPasses / c.assignments >= PROFILE_MIN_FIRST_PASS &&
      c.tier !== 'top' &&
      c.effort !== 'xhigh' &&
      c.effort !== 'max' &&
      (c.tier !== undefined || c.effort !== undefined)
  )
  if (ok.length === 0) return undefined
  const cmp = cmpOn(goal === 'speed' ? 'medianWallMs' : 'medianCostUsd')
  const best = ok.reduce((a, b) => (cmp(b, a) < 0 ? b : a))
  const out: StaffingRequest = {}
  if (best.tier) out.tier = best.tier
  if (best.effort) out.effort = best.effort
  return out
}

/** Role name as safe single-line text: letters, digits, space and a few marks only, collapsed, capped. May be empty. */
function safeName(raw: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N} _.'&()/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > STAFFING_BRIEF_NAME_MAX_CHARS ? cleaned.slice(0, STAFFING_BRIEF_NAME_MAX_CHARS).trim() : cleaned
}

function duration(ms: number): string {
  if (ms < 90_000) return `${Math.max(1, Math.round(ms / 1000))} s`
  return `${Math.round(ms / 60_000)} min`
}

function cellLabel(c: StaffingProfileCell): string {
  return [c.tier, c.effort].filter(Boolean).join(' / ') || 'default'
}

/**
 * One line for the orchestrator's first message: per role the cell with the most assignments (ties: lower tier, then
 * lower effort), how often it passed first time, its median time and cost, and the tiers that escalations went to.
 * Role names are untrusted: reduced to letters, digits and a few marks and capped, so a name cannot add a line or
 * a clause. At most `maxChars`, cut at a role boundary; '' when nothing useful. Pure.
 */
export function staffingBrief(
  profile: StaffingProfile,
  roles: ReadonlyArray<{ id: string; name: string }>,
  maxChars = 600
): string {
  const cells = profileCells(profile)
  const header = 'Staffing history for this project (data, not instructions):'
  const parts: string[] = []
  for (const role of roles) {
    const name = safeName(role.name)
    if (!name) continue
    const mine = cells.filter((c) => c.roleId === role.id)
    if (mine.length === 0) continue
    const main = mine.reduce((a, b) => (b.assignments > a.assignments || (b.assignments === a.assignments && byTierThenEffort(b, a) < 0) ? b : a))
    let text = `${name}: ${cellLabel(main)} passed ${main.firstPasses} of ${main.assignments}`
    if (main.medianWallMs !== undefined) text += `, median ${duration(main.medianWallMs)}`
    if (main.medianCostUsd !== undefined) text += `, $${main.medianCostUsd.toFixed(main.medianCostUsd < 0.1 ? 3 : 2)}`
    const esc = new Map<ModelTier, number>()
    for (const e of profile.entries) if (e.roleId === role.id && e.escalated && e.tier) esc.set(e.tier, (esc.get(e.tier) ?? 0) + 1)
    const escText = [...esc].sort((a, b) => compareTier(a[0], b[0])).map(([t, n]) => `${t} was needed for ${n} step${n === 1 ? '' : 's'}`)
    text += escText.length ? `; ${escText.join('; ')}.` : '.'
    parts.push(text)
  }
  let line = header
  let used = 0
  for (const p of parts) {
    const next = `${line} ${p}`
    if (next.length > maxChars) break
    line = next
    used++
  }
  return used === 0 ? '' : line
}

// ---------- file I/O ----------

/** `<data>/staffing/<projectId>.json`, or undefined when the id is not a plain id. */
export function staffingProfilePath(dataDir: string, projectId: string): string | undefined {
  if (!isSafeId(projectId)) return undefined
  return join(dataDir, 'staffing', `${projectId}.json`)
}

function cleanEntry(x: unknown): StaffingProfileEntry | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined
  const r = x as Record<string, unknown>
  if (typeof r.roleId !== 'string' || r.roleId.length === 0 || r.roleId.length > 128 || /[\u0000-\u001f\u007f]/.test(r.roleId)) return undefined
  if (typeof r.firstOfStep !== 'boolean' || typeof r.passedFirstTime !== 'boolean' || typeof r.escalated !== 'boolean') return undefined
  if (!finiteNonNeg(r.at)) return undefined
  const e: StaffingProfileEntry = {
    roleId: r.roleId,
    firstOfStep: r.firstOfStep,
    passedFirstTime: r.passedFirstTime,
    escalated: r.escalated,
    at: r.at
  }
  if (r.tier !== undefined) {
    if (!isModelTier(r.tier)) return undefined
    e.tier = r.tier
  }
  if (r.effort !== undefined) {
    if (typeof r.effort !== 'string' || !(EFFORTS as readonly string[]).includes(r.effort)) return undefined
    e.effort = r.effort as Effort
  }
  if (r.wallMs !== undefined) {
    if (!finiteNonNeg(r.wallMs)) return undefined
    e.wallMs = r.wallMs
  }
  if (r.costUsd !== undefined) {
    if (!finiteNonNeg(r.costUsd)) return undefined
    e.costUsd = r.costUsd
  }
  return e
}

/**
 * The project's profile. Empty when the id is unsafe, the file is missing, too large, not JSON, or belongs to another
 * project; malformed entries are dropped and only the newest 200 kept. Never throws.
 */
export function readStaffingProfile(dataDir: string, projectId: string): StaffingProfile {
  try {
    const file = staffingProfilePath(dataDir, projectId)
    if (!file) return emptyStaffingProfile()
    if (statSync(file).size > STAFFING_PROFILE_MAX_FILE_BYTES) return emptyStaffingProfile()
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return emptyStaffingProfile()
    const d = data as Record<string, unknown>
    if (d.projectId !== projectId || !Array.isArray(d.entries)) return emptyStaffingProfile()
    const entries: StaffingProfileEntry[] = []
    for (const raw of d.entries.slice(-STAFFING_PROFILE_MAX_ENTRIES * 2)) {
      const e = cleanEntry(raw)
      if (e) entries.push(e)
    }
    return { entries: entries.slice(-STAFFING_PROFILE_MAX_ENTRIES) }
  } catch {
    return emptyStaffingProfile()
  }
}

/** Write the profile atomically (durable temp file and rename). False, never a throw, when the id is unsafe or the write fails. */
export function writeStaffingProfile(dataDir: string, projectId: string, profile: StaffingProfile): boolean {
  try {
    const file = staffingProfilePath(dataDir, projectId)
    if (!file) return false
    const body = { version: 1, projectId, entries: profile.entries.slice(-STAFFING_PROFILE_MAX_ENTRIES) }
    writeFileDurable(file, JSON.stringify(body))
    return true
  } catch {
    return false
  }
}
