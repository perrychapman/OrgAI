import { createHash } from 'node:crypto'
import { agentProducedNothing } from '../../shared/defaults'
import { pathOverlaps, type GraphStepLike } from '../../shared/planGraph'
import type { AgentInstance, ExecOutcome, RunEndedBy, RunRecord, RunSummary } from '../../shared/types'
import { clampText, HIDDEN_CHARS, HIDDEN_RUN, redactCredentialWords } from '../capabilities/sanitize'
import { redactEvidence } from '../skills/suggest'
import { tokenSet } from '../skills/tokens'

/**
 * One finished run, reduced once to what the self-healing loops read (Team evolution's telemetry, the Team review's
 * evidence, the skill evaluation's gaps). Pure (no I/O, no clock). RunStore.getDigest caches the record part in a
 * sidecar beside the record so a pass parses no full record twice.
 *
 * Run text is kept only in a few short, redacted places; the rest is counts, keys and hashes. What is kept: counts and
 * timings; role slugs, role ids, tool names and skill ids as KEYS (kept as written when they are plain identifiers, else
 * a hash, see digestKey); path prefixes and missing tool names through the same sanitizers telemetry used (home folders
 * hidden); hashes for anything compared only for equality (error repeat keys, plan step roles, correction words, hashed
 * from the redacted text); and, for the Team review and skill evaluation, short EXCERPTS OF RUN TEXT: the permission
 * rules a role asked for, the connection it searched for and the user's correction messages, each through the
 * redaction those consumers apply (redactRunText: credential words, then redactEvidence; home folders hidden, hidden and
 * control characters removed, bounded; corrections also lose angle brackets). A secret neither recognises would be kept.
 *
 * Two parts: the BODY (from agents, transcript, plan, staffing, delegation: cached) and the SUMMARY part (status,
 * project, timings, usage: always taken from the run index as it is now, because a summary changes without the record:
 * a move to another project, legacy usage normalization, a crash normalized at load).
 */

/**
 * Bump when the body's shape or meaning changes: every cached sidecar is then recomputed. 3: run text also loses
 * credential words (URL userinfo, the value after --password / -u / --header ...) and home folders with spaces.
 */
export const DIGEST_VERSION = 3

/** Transcript entries read per run (the record keeps at most this many: RunStore MAX_TRANSCRIPT_ENTRIES). */
export const DIGEST_TRANSCRIPT_LIMIT = 5000
/** Bounds no real run reaches; a digest never holds more. */
export const DIGEST_MAX_AGENTS = 2000
export const DIGEST_MAX_STEPS = 1000
const MAX_EVIDENCE = 200
const MAX_MCP_ENTRIES = 200
const MAX_CORRECTIONS_PER_RUN = 50
const MAX_TOOL_NAMES = 1000
const CORRECTION_TEXT_CHARS = 500
/** skills/evaluate.ts EXCERPT_CHARS: the longest correction excerpt a finding quotes. */
export const CORRECTION_EXCERPT_CHARS = 160
const EVIDENCE_TEXT_MAX = 200
const EVIDENCE_LINE_MAX = 120

export const POLL_TOOLS: ReadonlySet<string> = new Set(['ListAgents', 'list_team', 'list_agents'])

// ---- sanitizers (shared with evolve/telemetry.ts) ---------------------------------------------------------------------

/** One safe line of evidence: control characters, angle brackets and secrets removed, bounded. */
export function safeLine(s: string, max = EVIDENCE_LINE_MAX): string {
  const t = redactRunText(String(s))
    .replace(HIDDEN_RUN, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export const safeName = (s: unknown, max = 40): string => String(s ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max)

/** Short hex hash of a string (equality comparisons only; never shown). */
export function digestHash(s: string, hex = 16): string {
  return createHash('sha256').update(s).digest('hex').slice(0, hex)
}

const KEY_PLAIN = /^[A-Za-z0-9_.:-]{1,128}$/
/**
 * A role slug, role id, tool name or skill id as a digest holds it: as written when it is a plain identifier (letters,
 * digits, `_ . : -`, at most 128), '' for '', else `#` and a hash. Consumers compare their own values through the same
 * function, so equality is kept for every value while odd text never lands on disk.
 */
export function digestKey(s: unknown): string {
  const v = typeof s === 'string' ? s : String(s ?? '')
  if (v === '') return ''
  return KEY_PLAIN.test(v) ? v : `#${digestHash(v)}`
}

// The folder name after Users\ or home/: the first word, plus up to two more words (no colon) when a path separator
// follows them, so "John Smith" goes whole ("C:\Users\John Smith\x" -> "~\x"). A name with spaces and no separator after
// it ("C:\Users\John Smith" at the end of a text) cannot be told from a word that follows, so only its first word goes.
const HOME_NAME = String.raw`(?:[^\\/\s"')]+(?: +[^\\/\s"'):]+){0,2}(?=[\\/])|[^\\/\s"')]+)`
const HOME_UNC = new RegExp(String.raw`(?<![:\w])(?:\\\\|\/\/)[^\\/\s"')]+[\\/]+[^\\/\s"')]+[\\/]+(?:Users|home)[\\/]+${HOME_NAME}`, 'gi')
const HOME_DRIVE = new RegExp(String.raw`[A-Za-z]:[\\/]+Users[\\/]+${HOME_NAME}`, 'gi')
const HOME_ROOTED = new RegExp(String.raw`[\\/]+(?:Users|home)[\\/]+${HOME_NAME}`, 'gi')

/**
 * Home directories name the user: C:\Users\x, \\server\share\Users\x (UNC, either slash), /Users/x and /home/x become ~
 * (the Team review's rule, which capabilities/evidence.ts uses through this function).
 */
export function hideHome(text: string): string {
  return text
    .replace(HOME_UNC, '~')
    .replace(HOME_DRIVE, '~')
    .replace(HOME_ROOTED, '~')
}

/** Secrets in run text: credential words (flags, URL userinfo, headers), then key-like tokens. One function for the digest and the Team review. */
export function redactRunText(text: string): string {
  return redactEvidence(redactCredentialWords(String(text ?? '')))
}

/** The Team review's redaction (capabilities/evidence.ts summary()), bounded. */
export function evidenceText(text: string, max = EVIDENCE_TEXT_MAX): string {
  return clampText(hideHome(redactRunText(String(text))), max)
}

export type ErrorCategory = 'missing_tool' | 'bad_flag' | 'missing_path' | 'other'
const MISSING_TOOL_RE = /no such tool|unknown tool|tool\b.{0,60}\b(?:is )?not (?:available|allowed|found|permitted)|isn'?t available|not in (?:the )?(?:allowed )?tools/i
const BAD_FLAG_RE = /unknown (?:option|flag|argument)|unrecognized (?:option|argument|arguments)|invalid (?:option|flag)|illegal option|unexpected argument|usage:/i
const MISSING_PATH_RE = /ENOENT|no such file or directory|does not exist|cannot find (?:the )?(?:path|file)|file not found|not a directory/i

export function classifyError(text: string): ErrorCategory {
  const t = text.slice(0, 600)
  if (MISSING_TOOL_RE.test(t)) return 'missing_tool'
  if (BAD_FLAG_RE.test(t)) return 'bad_flag'
  if (MISSING_PATH_RE.test(t)) return 'missing_path'
  return 'other'
}

/** The first two directory levels of a changed file, sanitized (merge conflict evidence). */
export function dirPrefix(file: string): string {
  // A home folder never lands on disk (an absolute changed path would keep `home/alice`): it becomes `~`, then nothing.
  const parts = hideHome(file.replace(/\\/g, '/')).split('/').filter((x) => x && x !== '.' && x !== '~')
  const dirs = parts.length > 1 ? parts.slice(0, -1) : parts
  return safeLine(dirs.slice(0, 2).join('/').replace(/[^A-Za-z0-9._/-]/g, ''), 40)
}

// ---- plan graph shape -------------------------------------------------------------------------------------------------

export interface Shape {
  reports: number
  maxParallel: number
  busyMs: number
  sumMs: number
}

const isRoot = (a: AgentInstance): boolean => a.id === 'root' || a.parentId === null
const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

/** Timing of the root's direct reports from the agents' own timestamps. */
export function spawnShape(r: Pick<RunRecord, 'agents' | 'summary'>): Shape {
  const agents = Object.values(r.agents ?? {})
  const rootIds = new Set(agents.filter(isRoot).map((a) => a.id))
  const end = r.summary.endedAt ?? 0
  const iv = agents
    .filter((a) => a.parentId !== null && rootIds.has(a.parentId))
    .map((a) => [a.startedAt, Math.max(a.startedAt, a.endedAt ?? end)] as const)
    .sort((a, b) => a[0] - b[0])
  let busy = 0
  let sum = 0
  let curEnd = -Infinity
  let curStart = 0
  const edges: [number, number][] = []
  for (const [s, e] of iv) {
    sum += e - s
    edges.push([s, 1], [e, -1])
    if (s > curEnd) {
      if (curEnd > -Infinity) busy += curEnd - curStart
      curStart = s
      curEnd = e
    } else curEnd = Math.max(curEnd, e)
  }
  if (curEnd > -Infinity) busy += curEnd - curStart
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let live = 0
  let max = 0
  for (const [, d] of edges) {
    live += d
    max = Math.max(max, live)
  }
  return { reports: iv.length, maxParallel: max, busyMs: busy, sumMs: sum }
}

/**
 * Widest set of steps that can run together (longest-path levels, path overlaps as extra waits), from the steps' ids,
 * `after` lists and the path overlap pairs (planGraph.pathOverlaps over all-pending steps). 1 without a graph.
 */
export function planLevels(
  steps: readonly { id: string; after?: readonly string[] }[],
  overlaps: readonly { first: string; second: string }[],
  countIds?: ReadonlySet<string>
): { width: number; depth: number } {
  if (steps.length < 2) {
    if (!steps.length) return { width: 0, depth: 0 }
    if (countIds && !countIds.has(steps[0].id)) return { width: 0, depth: 1 }
    return { width: 1, depth: 1 }
  }
  const deps = new Map<string, Set<string>>(steps.map((s) => [s.id, new Set((s.after ?? []).filter((x) => x !== s.id))]))
  for (const o of overlaps) deps.get(o.second)?.add(o.first)
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 1 // a cycle: the steps in it never separate, count it as one level
    visiting.add(id)
    let d = 1
    for (const dep of deps.get(id) ?? []) if (deps.has(dep)) d = Math.max(d, 1 + depthOf(dep))
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  const levels = new Map<number, number>()
  let deepest = 1
  for (const s of steps) {
    const d = depthOf(s.id)
    deepest = Math.max(deepest, d)
    if (!countIds || countIds.has(s.id)) levels.set(d, (levels.get(d) ?? 0) + 1)
  }
  return { width: levels.size ? Math.max(...levels.values()) : 0, depth: deepest }
}

/** Path overlap pairs of a plan's steps, all treated as pending (what planWidth measures). */
export function pendingOverlaps(steps: readonly GraphStepLike[]): { first: string; second: string }[] {
  return pathOverlaps({ steps: steps.map((s) => ({ ...s, status: 'pending' as const })) })
}

// ---- the digest -------------------------------------------------------------------------------------------------------

/** One non-root agent, in the record's agent order. Numbers as telemetry summed them. */
export interface DigestAgent {
  /** digestKey(roleSlug). */
  slug: string
  /** digestKey(roleId); absent when the agent has none. */
  roleId?: string
  /** Done, produced something, receipt not failed, not escalated, no merge conflict (telemetry's first pass). */
  firstPass: boolean
  error: boolean
  conflict: boolean
  turns: number
  outTokens: number
  inTokens: number
  costUsd: number
  wallMs: number
  /** Direct children it spawned. */
  kids: number
}

export interface DigestAssignment {
  /** digestKey of the assignment's role id. */
  roleId: string
  /** digestKey of the assigned agent's role slug, when the agent is in the record. */
  agentSlug?: string
  escalated: boolean
  tier?: string
}

export interface DigestPlan {
  /** Step ids replaced by opaque ids (`s1`, `s2`, ... equal ids stay equal); `role` = digestHash of the lowercased trimmed staff role. */
  steps: { id: string; after: string[]; role?: string }[]
  /** pathOverlaps of the steps (as pending), in opaque ids. */
  overlaps: { first: string; second: string }[]
}

export interface DigestFriction {
  /** digestKey of the role slug of the agent whose tool call failed ('unknown' when the agent is not in the record). */
  slug: string
  /** Error counts by category, in order of first appearance. */
  cats: [ErrorCategory, number][]
  /** Names of tools reported unavailable (safeName), in order of first appearance. */
  missingTools: string[]
  /** Repeat counts of identical errors: [digestHash of telemetry's repeat key, count]. */
  repeats: [string, number][]
}

export interface DigestPoll {
  /** digestKey of the spawner's role slug. */
  slug: string
  polls: number
  costUsd: number
  inTokens: number
}

/**
 * A Team review signal (capabilities/evidence.ts), one entry per (kind, role, key) in order of first appearance, with
 * how often it came up in this run and when last. Text through evidenceText.
 */
export type DigestEvidence = { roleId?: string; count: number; lastAt: number } & (
  | { kind: 'ruleRequest'; rules: string[] }
  | { kind: 'missingConnection'; tool: 'request_mcp_install' | 'search_mcp_registry'; what: string }
  | { kind: 'missingTool' | 'permissionDenied'; tool?: string }
)

export interface DigestCorrection {
  /** digestHash(…, 12) of each word of tokenSet(text) (skills/evaluate.ts), for Jaccard grouping. */
  tokens: string[]
  /** safeLine of the message with home folders hidden, at most CORRECTION_EXCERPT_CHARS. */
  excerpt: string
}

export interface DigestMcpUse {
  slug: string
  roleId?: string
  /** digestKey of the full tool name (`mcp__<server>__<tool>`). */
  tool: string
  count: number
}

/** The cached part: derived from the record's agents, transcript, plan, staffing and delegation. */
export interface RunDigestBody {
  agents: DigestAgent[]
  /** digestHash of each root agent's lowercased role slug and name (plan width when the project names no root). */
  rootNameKeys: string[]
  assignments: DigestAssignment[]
  /** digestKey of the role id of each failed delegation receipt. */
  failedReceiptRoleIds: string[]
  /** Only for a plan of at least two steps. */
  plan?: DigestPlan
  shape: Shape
  /** Only when an agent's merge conflicted: the spawners of the conflicting agents and the shared path prefixes. */
  conflict?: { leads: string[]; overlap: string[] }
  friction: DigestFriction[]
  /** Spawners that polled for status at least 3 times while they had reports. */
  polls: DigestPoll[]
  evidence: DigestEvidence[]
  /** Distinct tool names (digestKey), indexed by toolSequences. */
  toolNames: string[]
  /** Each agent's tool calls in order, as indexes into toolNames (agents in order of their first call). */
  toolSequences: number[][]
  /** User corrections (non-harness user messages after the first that read as a correction), in order. */
  corrections: DigestCorrection[]
  /** MCP tool calls per role and tool. */
  mcpToolUses: DigestMcpUse[]
}

/** From the run index, never cached. */
export interface RunDigestSummary {
  id: string
  projectId: string
  kind: RunSummary['kind']
  /** As the index holds it (never written to disk: the summary part is not cached). */
  quick?: RunSummary['quick']
  team?: RunSummary['team']
  status: RunSummary['status']
  endedBy?: RunEndedBy
  execOutcome?: ExecOutcome
  pausedUntil?: number
  startedAt: number
  endedAt?: number
}

export interface RunDigest extends RunDigestBody {
  digestVersion: typeof DIGEST_VERSION
  summary: RunDigestSummary
  /** usage.costUsd (or totalCostUsd), 0 unknown. */
  costUsd: number
  /** Active wall time: wall minus idle, waiting and limit-hold time (or end minus start). */
  wallMs: number
  /** Input tokens including cache reads and writes, 0 unknown. */
  inputTokens: number
  /** Skills loaded in the run (summary.usage.skills): digestKey(skillId) and load count. */
  skillLoads: { skillId: string; loads: number }[]
}

export function isRunDigest(x: unknown): x is RunDigest {
  return !!x && typeof x === 'object' && (x as { digestVersion?: unknown }).digestVersion === DIGEST_VERSION
}

/** The summary part of a digest, from a summary as the index holds it now. */
export function digestSummaryPart(s: RunSummary): Pick<RunDigest, 'summary' | 'costUsd' | 'wallMs' | 'inputTokens' | 'skillLoads'> {
  const u = s.usage
  const wall = u ? finite(u.wallMs) - finite(u.idleMs) - finite(u.waitingMs) - finite(u.limitHoldMs) : finite((s.endedAt ?? s.startedAt) - s.startedAt)
  const t = u?.tokens
  const summary: RunDigestSummary = { id: s.id, projectId: s.projectId, kind: s.kind, status: s.status, startedAt: s.startedAt }
  if (s.quick !== undefined) summary.quick = s.quick
  if (s.team !== undefined) summary.team = s.team
  if (s.endedBy !== undefined) summary.endedBy = s.endedBy
  if (s.execOutcome !== undefined) summary.execOutcome = s.execOutcome
  if (s.pausedUntil !== undefined) summary.pausedUntil = s.pausedUntil
  if (s.endedAt !== undefined) summary.endedAt = s.endedAt
  const skillLoads: { skillId: string; loads: number }[] = []
  for (const k of Array.isArray(u?.skills) ? u.skills : []) {
    if (skillLoads.length >= MAX_TOOL_NAMES) break
    if (k && typeof k.skillId === 'string') skillLoads.push({ skillId: digestKey(k.skillId), loads: finite(k.loads) })
  }
  return {
    summary,
    costUsd: finite(u?.costUsd ?? s.totalCostUsd),
    wallMs: Math.max(0, wall),
    inputTokens: t ? finite(t.input) + finite(t.cacheRead) + finite(t.cacheWrite) : 0,
    skillLoads
  }
}

const agentInTokens = (a: AgentInstance): number =>
  finite(a.usage?.tokens?.input) + finite(a.usage?.tokens?.cacheRead) + finite(a.usage?.tokens?.cacheWrite) || finite(a.inputTokens)

const CORRECTION =
  /(?:^|[\s,.;!(])(?:no[,.!]|nope|don'?t|do not|doesn'?t|didn'?t|instead|wrong|not what|again|stop|i said|as i said|remember to|always|never)(?=$|[\s,.;!?)])/i
const oneLine = (s: string): string => s.replace(HIDDEN_RUN, ' ').replace(/\s+/g, ' ').trim()
const toolBase = (name: string): string => name.replace(/^mcp__orgai__/, '')

/** The cached part of a run's digest. Pure; reads at most DIGEST_TRANSCRIPT_LIMIT transcript entries. */
export function digestBody(r: RunRecord): RunDigestBody {
  const all = Object.values(r.agents ?? {}).filter((a): a is AgentInstance => !!a && typeof a === 'object')
  const byId = new Map(all.map((a) => [a.id, a]))
  const childCount = new Map<string, number>()
  for (const a of all) if (a.parentId) childCount.set(a.parentId, (childCount.get(a.parentId) ?? 0) + 1)
  const assignmentsRaw = Array.isArray(r.staffing?.assignments) ? r.staffing.assignments : []
  const escalated = new Set(assignmentsRaw.filter((x) => x?.source === 'escalated' && x.agentId).map((x) => x.agentId as string))

  const agents: DigestAgent[] = []
  const rootNameKeys: string[] = []
  for (const a of all) {
    if (isRoot(a)) {
      if (a.roleSlug) rootNameKeys.push(digestHash(String(a.roleSlug).toLowerCase()))
      if (a.name) rootNameKeys.push(digestHash(String(a.name).toLowerCase()))
      continue
    }
    if (agents.length >= DIGEST_MAX_AGENTS) continue
    const conflict = a.worktree?.status === 'conflict'
    agents.push({
      slug: digestKey(a.roleSlug),
      ...(typeof a.roleId === 'string' && a.roleId ? { roleId: digestKey(a.roleId) } : {}),
      firstPass: a.state === 'done' && !agentProducedNothing(a) && a.delegation?.verdict !== 'failed' && !escalated.has(a.id) && !conflict,
      error: a.state === 'error',
      conflict,
      turns: finite(a.usage?.turns),
      outTokens: finite(a.usage?.tokens?.output ?? a.outputTokens),
      inTokens: agentInTokens(a),
      costUsd: finite(a.usage?.costUsd ?? a.costUsd),
      wallMs: Math.max(0, finite((a.endedAt ?? r.summary.endedAt ?? a.startedAt) - a.startedAt)),
      kids: childCount.get(a.id) ?? 0
    })
  }

  const assignments: DigestAssignment[] = []
  for (const x of assignmentsRaw) {
    if (!x || typeof x !== 'object') continue
    const agentSlug = x.agentId ? byId.get(x.agentId)?.roleSlug : undefined
    const tier = typeof x.tier === 'string' && KEY_PLAIN.test(x.tier) ? x.tier : undefined
    assignments.push({
      roleId: digestKey(x.roleId),
      ...(agentSlug !== undefined ? { agentSlug: digestKey(agentSlug) } : {}),
      escalated: x.source === 'escalated',
      ...(tier ? { tier } : {})
    })
  }
  const failedReceiptRoleIds = (Array.isArray(r.delegation?.receipts) ? r.delegation.receipts : []).filter((rc) => rc?.verdict === 'failed').map((rc) => digestKey(rc.roleId))

  // Plan: ids made opaque, staff roles hashed, path overlaps computed here (paths themselves are not kept).
  let plan: DigestPlan | undefined
  const steps = Array.isArray(r.plan?.steps) ? r.plan.steps.slice(0, DIGEST_MAX_STEPS) : []
  if (steps.length >= 2) {
    const ids = new Map<string, string>()
    const idOf = (raw: unknown): string => {
      const k = String(raw)
      let v = ids.get(k)
      if (!v) ids.set(k, (v = `s${ids.size + 1}`))
      return v
    }
    const graph = steps.map((s) => ({ id: String(s.id), status: 'pending' as const, after: Array.isArray(s.after) ? s.after.map(String) : undefined, paths: Array.isArray(s.paths) ? s.paths.map(String) : undefined }))
    plan = {
      steps: steps.map((s) => {
        const role = typeof s.staff?.role === 'string' ? s.staff.role.trim().toLowerCase() : ''
        return { id: idOf(s.id), after: (Array.isArray(s.after) ? s.after : []).map(idOf), ...(role ? { role: digestHash(role) } : {}) }
      }),
      overlaps: pathOverlaps({ steps: graph }).map((o) => ({ first: idOf(o.first), second: idOf(o.second) }))
    }
  }

  // Merge conflicts: the spawners of the conflicting agents and the path prefixes two agents changed.
  let conflict: RunDigestBody['conflict']
  const conflicted = all.filter((a) => a.worktree?.status === 'conflict')
  if (conflicted.length) {
    const owners = new Map<string, Set<string>>()
    for (const a of all) for (const f of Array.isArray(a.worktree?.changedFiles) ? a.worktree.changedFiles.slice(0, 200) : []) {
      const p = dirPrefix(String(f))
      if (!p) continue
      const s = owners.get(p) ?? new Set()
      s.add(a.id)
      owners.set(p, s)
    }
    conflict = {
      leads: conflicted.map((a) => digestKey((byId.get(a.parentId ?? '') ?? a).roleSlug)),
      overlap: [...owners].filter(([, s]) => s.size >= 2).map(([p]) => p).sort()
    }
  }

  // One pass over the transcript: tool friction, status polling, Team review evidence, tool sequences, corrections, MCP use.
  const uses = new Map<string, string>()
  const owner = new Map<string, string>()
  const pollsByAgent = new Map<string, number>()
  const friction = new Map<string, { cats: Map<ErrorCategory, number>; missingTools: Set<string>; repeats: Map<string, number> }>()
  const evidence = new Map<string, DigestEvidence>()
  const toolIndex = new Map<string, number>()
  const toolNames: string[] = []
  const perAgent = new Map<string, number[]>()
  const corrections: DigestCorrection[] = []
  let firstUser = true
  const mcp = new Map<string, DigestMcpUse>()
  const roleIdOf = (agentId: string): string | undefined => {
    const id = byId.get(agentId)?.roleId
    return typeof id === 'string' && id ? digestKey(id) : undefined
  }
  const addEvidence = (key: string, make: () => DigestEvidence, at: number): void => {
    const e = evidence.get(key)
    if (e) {
      e.count++
      e.lastAt = Math.max(e.lastAt, at)
    } else if (evidence.size < MAX_EVIDENCE) evidence.set(key, make())
  }
  const t = Array.isArray(r.transcript) ? r.transcript : []
  for (let i = 0; i < t.length && i < DIGEST_TRANSCRIPT_LIMIT; i++) {
    const e = t[i]
    const b = e?.block
    if (!b) continue
    const at = finite(e.at)
    if (b.kind === 'tool_use') {
      const name = String(b.name)
      uses.set(b.id, name)
      owner.set(b.id, e.agentId)
      if (POLL_TOOLS.has(name)) pollsByAgent.set(e.agentId, (pollsByAgent.get(e.agentId) ?? 0) + 1)
      // tool sequences
      const key = digestKey(name)
      let idx = toolIndex.get(key)
      if (idx === undefined && toolNames.length < MAX_TOOL_NAMES) {
        idx = toolNames.length
        toolNames.push(key)
        toolIndex.set(key, idx)
      }
      if (idx !== undefined) {
        const list = perAgent.get(e.agentId) ?? []
        list.push(idx)
        perAgent.set(e.agentId, list)
      }
      // MCP use per role
      if (name.startsWith('mcp__')) {
        const slug = digestKey(byId.get(e.agentId)?.roleSlug ?? 'unknown')
        const roleId = roleIdOf(e.agentId)
        const k = `${slug}\u0000${roleId ?? ''}\u0000${key}`
        const m = mcp.get(k)
        if (m) m.count++
        else if (mcp.size < MAX_MCP_ENTRIES) mcp.set(k, { slug, ...(roleId ? { roleId } : {}), tool: key, count: 1 })
      }
      // Team review evidence: permission rule requests and connection searches.
      const base = toolBase(name)
      const roleId = roleIdOf(e.agentId)
      if (base === 'request_permission_rules') {
        const rules = (b.input as { rules?: unknown } | null | undefined)?.rules
        const list = Array.isArray(rules) ? rules.filter((x): x is string => typeof x === 'string').slice(0, 4).map((x) => evidenceText(x)) : []
        addEvidence(`ruleRequest\u0000${roleId ?? ''}\u0000${list.join(',')}`, () => ({ kind: 'ruleRequest', ...(roleId ? { roleId } : {}), rules: list, count: 1, lastAt: at }), at)
      } else if (base === 'request_mcp_install' || base === 'search_mcp_registry') {
        const input = b.input as { query?: unknown; name?: unknown } | null | undefined
        const what = evidenceText(typeof input?.query === 'string' ? input.query : typeof input?.name === 'string' ? input.name : '')
        addEvidence(`missingConnection\u0000${roleId ?? ''}\u0000${base}:${what.toLowerCase().slice(0, 60)}`, () => ({ kind: 'missingConnection', ...(roleId ? { roleId } : {}), tool: base, what, count: 1, lastAt: at }), at)
      }
    } else if (b.kind === 'tool_result' && b.isError) {
      const content = String(b.content ?? '')
      // Evolution: friction by category, unavailable tools, repeats of one identical error.
      const slug = digestKey(byId.get(e.agentId)?.roleSlug ?? 'unknown')
      const cat = classifyError(content)
      let f = friction.get(slug)
      if (!f) friction.set(slug, (f = { cats: new Map(), missingTools: new Set(), repeats: new Map() }))
      f.cats.set(cat, (f.cats.get(cat) ?? 0) + 1)
      if (cat === 'missing_tool') {
        const n = safeName(uses.get(b.toolUseId))
        if (n) f.missingTools.add(n)
      }
      if (cat !== 'other') {
        const key = digestHash(`${cat}:${(uses.get(b.toolUseId) ?? '').slice(0, 20)}:${content.slice(0, 80).toLowerCase().replace(/[0-9]+/g, '#').replace(/\s+/g, ' ')}`)
        f.repeats.set(key, (f.repeats.get(key) ?? 0) + 1)
      }
      // Team review: a tool the role lacks, or a permission denial.
      const ownerAgent = owner.get(b.toolUseId)
      const roleId = roleIdOf(ownerAgent ?? e.agentId)
      const text = content.slice(0, 2000)
      const usedName = uses.get(b.toolUseId)
      const tool = usedName !== undefined ? digestKey(toolBase(usedName)) : undefined
      const kind = EVIDENCE_MISSING_TOOL.test(text) ? 'missingTool' : EVIDENCE_DENIED.test(text) ? 'permissionDenied' : undefined
      if (kind) addEvidence(`${kind}\u0000${roleId ?? ''}\u0000${tool ?? ''}`, () => ({ kind, ...(roleId ? { roleId } : {}), ...(tool !== undefined ? { tool } : {}), count: 1, lastAt: at }), at)
    } else if (b.kind === 'user' && e.source !== 'harness') {
      if (firstUser) {
        firstUser = false
        continue
      }
      if (corrections.length >= MAX_CORRECTIONS_PER_RUN) continue
      const text = oneLine(String(b.text ?? '').slice(0, CORRECTION_TEXT_CHARS * 2))
      if (!text || !CORRECTION.test(text)) continue
      // Words are hashed from the redacted text, so a secret or a PIN in a correction never becomes a guessable hash.
      const tokens = tokenSet(safeLine(hideHome(text), CORRECTION_TEXT_CHARS * 2).slice(0, CORRECTION_TEXT_CHARS))
      if (tokens.size < 2) continue
      corrections.push({ tokens: [...tokens].map((w) => digestHash(w, 12)), excerpt: safeLine(hideHome(text), CORRECTION_EXCERPT_CHARS) })
    }
  }
  const polls: DigestPoll[] = []
  for (const [agentId, count] of pollsByAgent) {
    if (count < MIN_POLLS_PER_RUN || (childCount.get(agentId) ?? 0) < 1) continue
    const a = byId.get(agentId)
    if (!a?.roleSlug) continue
    polls.push({ slug: digestKey(a.roleSlug), polls: count, costUsd: finite(a.usage?.costUsd ?? a.costUsd), inTokens: agentInTokens(a) })
  }
  return {
    agents,
    rootNameKeys,
    assignments,
    failedReceiptRoleIds,
    ...(plan ? { plan } : {}),
    shape: spawnShape(r),
    ...(conflict ? { conflict } : {}),
    friction: [...friction].map(([slug, f]) => ({ slug, cats: [...f.cats], missingTools: [...f.missingTools], repeats: [...f.repeats] })),
    polls,
    evidence: [...evidence.values()],
    toolNames,
    toolSequences: [...perAgent.values()],
    corrections,
    mcpToolUses: [...mcp.values()]
  }
}

/** A spawner counts as polling at this many status calls in one run. */
export const MIN_POLLS_PER_RUN = 3
/** capabilities/evidence.ts's patterns. */
const EVIDENCE_DENIED = /\b(permission (?:was |is )?denied|not permitted|not allowed|denied by|requires approval|user (?:denied|rejected))\b/i
const EVIDENCE_MISSING_TOOL = /\b(no such tool|unknown tool|tool (?:is )?not (?:available|found|allowed)|not in (?:the )?allowed tools)\b/i

/** A run's whole digest. Pure. */
export function digestRun(r: RunRecord): RunDigest {
  return { digestVersion: DIGEST_VERSION, ...digestBody(r), ...digestSummaryPart(r.summary) }
}

/** What RunStore.getDigest digests with (handed in, so the store file itself stays free of this module's imports). */
export interface RunDigester {
  version: number
  body(record: RunRecord): RunDigestBody
  parse(v: unknown): RunDigestBody | undefined
  /** A cached or fresh body plus the summary part from the index as it is now. */
  assemble(body: RunDigestBody, summary: RunSummary): RunDigest
}

export const runDigester: RunDigester = {
  version: DIGEST_VERSION,
  body: digestBody,
  parse: (v) => parseDigestBody(v),
  assemble: (body, summary) => ({ digestVersion: DIGEST_VERSION, ...body, ...digestSummaryPart(summary) })
}

/** A run record or a digest as a digest (records are digested; digests pass through). */
export function asDigest(r: RunRecord | RunDigest): RunDigest {
  return isRunDigest(r) ? r : digestRun(r)
}

// ---- reading a cached body back ---------------------------------------------------------------------------------------

const KEY_RE = /^(?:[A-Za-z0-9_.:-]{0,128}|#[0-9a-f]{16})$/
const HASH_RE = /^[0-9a-f]{12,16}$/
const OPAQUE_RE = /^s[0-9]{1,6}$/
/** Hidden and control characters (capabilities/sanitize.ts: controls, soft hyphen, bidi, zero-width, Hangul fillers, tag characters, line separators). */
const UNSAFE_TEXT = HIDDEN_CHARS
const CATEGORIES: readonly string[] = ['missing_tool', 'bad_flag', 'missing_path', 'other']
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isCount = (v: unknown): v is number => isNum(v) && v >= 0 && Number.isInteger(v)
const isKey = (v: unknown): v is string => typeof v === 'string' && KEY_RE.test(v)
const optKey = (v: unknown): boolean => v === undefined || isKey(v)
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !UNSAFE_TEXT.test(v)
const arr = (v: unknown, max: number, each: (x: unknown) => boolean): boolean => Array.isArray(v) && v.length <= max && v.every(each)

/**
 * A cached body read back from disk: returned only when every field has the shape and bounds digestBody writes, else
 * undefined (the caller recomputes it; a sidecar is never trusted as found).
 */
export function parseDigestBody(v: unknown): RunDigestBody | undefined {
  if (!isObj(v)) return undefined
  const agentOk = (a: unknown): boolean =>
    isObj(a) && isKey(a.slug) && optKey(a.roleId) && typeof a.firstPass === 'boolean' && typeof a.error === 'boolean' && typeof a.conflict === 'boolean' &&
    isNum(a.turns) && isNum(a.outTokens) && isNum(a.inTokens) && isNum(a.costUsd) && isNum(a.wallMs) && a.wallMs >= 0 && isCount(a.kids)
  if (!arr(v.agents, DIGEST_MAX_AGENTS, agentOk)) return undefined
  if (!arr(v.rootNameKeys, 2 * DIGEST_MAX_AGENTS, (x) => typeof x === 'string' && HASH_RE.test(x))) return undefined
  if (!arr(v.assignments, 10_000, (x) => isObj(x) && isKey(x.roleId) && optKey(x.agentSlug) && typeof x.escalated === 'boolean' && (x.tier === undefined || (typeof x.tier === 'string' && KEY_PLAIN.test(x.tier))))) return undefined
  if (!arr(v.failedReceiptRoleIds, 10_000, isKey)) return undefined
  if (v.plan !== undefined) {
    const p = v.plan
    if (!isObj(p)) return undefined
    const stepOk = (s: unknown): boolean => isObj(s) && typeof s.id === 'string' && OPAQUE_RE.test(s.id) && arr(s.after, 10_000, (x) => typeof x === 'string' && OPAQUE_RE.test(x)) && (s.role === undefined || (typeof s.role === 'string' && HASH_RE.test(s.role)))
    if (!arr(p.steps, DIGEST_MAX_STEPS, stepOk) || (p.steps as unknown[]).length < 2) return undefined
    if (!arr(p.overlaps, DIGEST_MAX_STEPS * DIGEST_MAX_STEPS, (o) => isObj(o) && typeof o.first === 'string' && OPAQUE_RE.test(o.first) && typeof o.second === 'string' && OPAQUE_RE.test(o.second))) return undefined
  }
  const sh = v.shape
  if (!isObj(sh) || !isCount(sh.reports) || !isCount(sh.maxParallel) || !isNum(sh.busyMs) || !isNum(sh.sumMs)) return undefined
  if (v.conflict !== undefined) {
    const c = v.conflict
    if (!isObj(c) || !arr(c.leads, DIGEST_MAX_AGENTS + 1, isKey) || !arr(c.overlap, 10_000, (x) => isText(x, 40) && !/[<>]/.test(x as string))) return undefined
  }
  const frictionOk = (f: unknown): boolean =>
    isObj(f) && isKey(f.slug) &&
    arr(f.cats, CATEGORIES.length, (c) => Array.isArray(c) && c.length === 2 && CATEGORIES.includes(c[0] as string) && isCount(c[1])) &&
    arr(f.missingTools, DIGEST_TRANSCRIPT_LIMIT, (x) => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(x)) &&
    arr(f.repeats, DIGEST_TRANSCRIPT_LIMIT, (x) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && HASH_RE.test(x[0]) && isCount(x[1]))
  if (!arr(v.friction, DIGEST_MAX_AGENTS + 1, frictionOk)) return undefined
  if (!arr(v.polls, DIGEST_MAX_AGENTS + 1, (p) => isObj(p) && isKey(p.slug) && isCount(p.polls) && isNum(p.costUsd) && isNum(p.inTokens))) return undefined
  const evidenceOk = (e: unknown): boolean => {
    if (!isObj(e) || !optKey(e.roleId) || !isCount(e.count) || e.count < 1 || !isNum(e.lastAt)) return false
    if (e.kind === 'ruleRequest') return arr(e.rules, 4, (x) => isText(x, EVIDENCE_TEXT_MAX))
    if (e.kind === 'missingConnection') return (e.tool === 'request_mcp_install' || e.tool === 'search_mcp_registry') && isText(e.what, EVIDENCE_TEXT_MAX)
    if (e.kind === 'missingTool' || e.kind === 'permissionDenied') return optKey(e.tool)
    return false
  }
  if (!arr(v.evidence, MAX_EVIDENCE, evidenceOk)) return undefined
  if (!arr(v.toolNames, MAX_TOOL_NAMES, isKey)) return undefined
  const names = (v.toolNames as string[]).length
  if (!arr(v.toolSequences, DIGEST_TRANSCRIPT_LIMIT, (s) => arr(s, DIGEST_TRANSCRIPT_LIMIT, (i) => isCount(i) && (i as number) < names))) return undefined
  if (!arr(v.corrections, MAX_CORRECTIONS_PER_RUN, (c) => isObj(c) && arr(c.tokens, CORRECTION_TEXT_CHARS, (x) => typeof x === 'string' && /^[0-9a-f]{12}$/.test(x)) && isText(c.excerpt, CORRECTION_EXCERPT_CHARS) && !/[<>]/.test(c.excerpt as string))) return undefined
  if (!arr(v.mcpToolUses, MAX_MCP_ENTRIES, (m) => isObj(m) && isKey(m.slug) && optKey(m.roleId) && isKey(m.tool) && isCount(m.count))) return undefined
  return {
    agents: v.agents as DigestAgent[],
    rootNameKeys: v.rootNameKeys as string[],
    assignments: v.assignments as DigestAssignment[],
    failedReceiptRoleIds: v.failedReceiptRoleIds as string[],
    ...(v.plan !== undefined ? { plan: v.plan as DigestPlan } : {}),
    shape: { reports: sh.reports, maxParallel: sh.maxParallel, busyMs: sh.busyMs, sumMs: sh.sumMs },
    ...(v.conflict !== undefined ? { conflict: v.conflict as RunDigestBody['conflict'] } : {}),
    friction: v.friction as DigestFriction[],
    polls: v.polls as DigestPoll[],
    evidence: v.evidence as DigestEvidence[],
    toolNames: v.toolNames as string[],
    toolSequences: v.toolSequences as number[][],
    corrections: v.corrections as DigestCorrection[],
    mcpToolUses: v.mcpToolUses as DigestMcpUse[]
  }
}
