import { createHash, randomBytes } from 'node:crypto'
import {
  CAPABILITY_MAX_GAPS,
  CAPABILITY_MAX_ITEMS,
  CAPABILITY_MAX_RECOMMENDATIONS,
  CAPABILITY_RECOMMEND_TIMEOUT_MS,
  isVirtualProjectId,
  TEAM_REVIEW_MAX_DISMISSED,
  TEAM_REVIEW_OPEN_THROTTLE_MS,
  TEAM_REVIEW_PROACTIVE_LIMIT,
  type CapabilityAccess,
  type CapabilityApplied,
  type CapabilityApplyInput,
  type CapabilityApplyResult,
  type CapabilityDiscoverInput,
  type CapabilityDiscovery,
  type CapabilityGap,
  type CapabilityItem,
  type CapabilityProgressEvent,
  type CapabilityRecommendation,
  type CapabilityRecommendInput,
  type CapabilityScope,
  type CapabilitySourceId,
  type CapabilitySourceStatus,
  type CapabilityUndoInput,
  type CapabilityUndoResult,
  type CapabilityWarning,
  type ConnectorDef,
  type McpServerSpec,
  type Project,
  type Role,
  type RunRecord,
  type RunSummary,
  type TeamDismissInput,
  type TeamDismissal,
  type TeamRecommendations,
  type TeamRestoreInput,
  type TeamReview,
  type TeamReviewInput,
  type TeamReviewModelInput,
  type TeamReviewModelSkip,
  type TeamReviewSummary,
  type TeamReviewTrigger
} from '@shared/types'
import { newId, teamReviewOf } from '@shared/defaults'
import { connectorById } from '@shared/connectors'
import type { McpService } from '../mcp/service'
import type { ProjectStore } from '../store/projects'
import type { ProjectCompletionInput } from '../runtime/runManager'
import type { SkillServiceApi } from '../skills/types'
import { buildScannedSkill } from '../skills/scan'
import type { CandidatePayload, CapabilityServiceApi, DiscoveredCandidate, LocalContext, SourceResult } from './types'
import { discoverLocalSkills, discoverRepoSkills, rereadSkillFolder } from './localSkills'
import { discoverLocalMcp } from './localMcp'
import { discoverGithubSkills, discoverRegistry } from './outside'
import { discoverCatalog, discoverLibrary, discoverProject, dropProjectDuplicates } from './sources'
import {
  buildRecommendPrompt,
  canWrite,
  estimateRecommendTokens,
  fallbackRecommend,
  heldBy,
  parseRecommendAnswer,
  type LocalDetail,
  recommendable,
  recommendationId,
  registryQueries,
  scopeRoleIds
} from './recommend'
import { collectEvidence, EVIDENCE_MAX_RUNS, hasNewEvidence } from './evidence'
import { readReview, removeReview, reviewSummary, writeReview } from './reviewStore'
import { clampText, mcpSpecDigest } from './sanitize'

/** What index.ts hands the service. */
export interface CapabilityServiceDeps {
  projects: ProjectStore
  skills: SkillServiceApi
  mcp: McpService
  /** One-shot completion on the project's connection (RunManager.completeForProject). */
  complete(project: Project, input: ProjectCompletionInput): Promise<{ text: string; model?: string }>
  /** capabilities:progress push to every window. */
  progress(event: CapabilityProgressEvent): void
  /** capabilities:reviewUpdated push to every window. */
  reviewUpdated(summary: TeamReviewSummary): void
  /** Reviews persist under `<dataDir>/team-reviews/<projectId>.json`. */
  dataDir: string
  /** The project's persisted run summaries (RunManager.list) and one record with its transcript (RunManager.get). */
  listRuns(projectId: string): RunSummary[]
  getRun(runId: string): RunRecord | null
  /** A saved project reaches every window (index.ts broadcasts a project.updated RunEvent). */
  onProjectChanged(project: Project): void
  /** The user's home dir; under ORGAI_MOCK=1 index.ts passes `<data>/mock-home` (seeded fixtures). */
  homeDir: string
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  /** ORGAI_MOCK=1: outside fetches are network-free fixtures. */
  mock: boolean
  fetch?: typeof fetch
  /** Tests: clock and the runEnded debounce. */
  now?: () => number
  runEndedDebounceMs?: number
}

/** Snapshots kept per project (newest wins). */
export const SNAPSHOTS_PER_PROJECT = 4
/** Snapshots kept across all projects (the oldest by creation time go first). */
export const SNAPSHOTS_TOTAL = 16
/** recommend() reuses a discover() snapshot made with the same request id within this window. */
export const SNAPSHOT_REUSE_MS = 5 * 60_000
export const RUN_ENDED_DEBOUNCE_MS = 3_000

const STALE = 'The recommendations are out of date: what OrgAI found has changed since. Run them again.'

interface Snapshot {
  digest: string
  discovery: CapabilityDiscovery
  candidates: Map<string, DiscoveredCandidate>
  recs: Map<string, CapabilityRecommendation>
  requestId?: string
  at: number
  /** Made by refreshReview after an apply: at most one per project, so applies never evict a recommend result. */
  refresh?: boolean
}

interface UndoRecord {
  undoId: string
  projectId: string
  /** Each role's grants before the apply (undefined = the key was absent). */
  prevRoles: Map<string, { skills: string[] | undefined; mcpServers: string[] | undefined }>
  /** Each existing server's roles before the apply. */
  prevServerRoles: Map<string, string[] | undefined>
  addedSkillId?: string
  addedServerId?: string
  /** A connector library entry this apply created (removed on undo when no project links it). */
  createdLibraryId?: string
}

interface ModelOutcome {
  mode: 'model' | 'fallback'
  recommendations: CapabilityRecommendation[]
  gaps: CapabilityGap[]
  fallbackReason?: TeamRecommendations['fallbackReason']
  model?: string
  tokens?: number
}

type Emit = (phase: CapabilitySourceId | 'model', state: CapabilityProgressEvent['state'], count?: number, message?: string) => void

/**
 * What binds one candidate into the discovery digest: a local or registry MCP server by mcpSpecDigest of the spec
 * the apply would save (command, args, URL, env and header names, secret slots), a skill by its file digest,
 * anything else by its target.
 */
function candidateBinding(c: DiscoveredCandidate): string {
  if (c.payload.type === 'mcpSpec') return `spec:${mcpSpecDigest(c.payload.spec)}`
  return c.item.digest ?? c.item.target ?? ''
}

function digestOf(candidates: DiscoveredCandidate[]): string {
  const lines = candidates.map((c) => `${c.item.id}\0${c.item.kind}\0${candidateBinding(c)}\0${c.item.target ?? ''}\0${c.item.blockedReason ?? ''}`).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** Stable for the same candidate content: a dismissal stays until this changes. */
export function fingerprintOf(item: Pick<CapabilityItem, 'id' | 'digest' | 'version' | 'target'> | undefined, candidateId: string): string {
  return createHash('sha256')
    .update(`${candidateId}\0${item?.digest ?? ''}\0${item?.version ?? ''}\0${item?.target ?? ''}`)
    .digest('hex')
    .slice(0, 16)
}

/** Candidates of `items` whose persisted dismissal (a stub review counts) still matches their fingerprint. */
export function dismissedIds(review: Pick<TeamReview, 'dismissed'> | null | undefined, items: CapabilityItem[]): Set<string> {
  const out = new Set<string>()
  if (!review?.dismissed.length) return out
  const byId = new Map(items.map((i) => [i.id, i]))
  for (const d of review.dismissed) {
    const item = byId.get(d.candidateId)
    if (item && d.fingerprint === fingerprintOf(item, d.candidateId)) out.add(d.candidateId)
  }
  return out
}

/** The candidate is the same as when `r` was recommended (no earlier item known counts as the same). */
function sameCandidate(r: CapabilityRecommendation, was: CapabilityItem | undefined, now: CapabilityItem | undefined): boolean {
  return !was || fingerprintOf(was, r.candidateId) === fingerprintOf(now, r.candidateId)
}

/**
 * A pending recommendation as it should stay: its candidate is in `byId`, not blocked or dismissed, and its roles
 * are those that still exist and do not hold the candidate yet (the id is kept). null when no role is left.
 */
export function refineRecommendation(
  r: CapabilityRecommendation,
  roles: Pick<Role, 'id'>[],
  byId: ReadonlyMap<string, CapabilityItem>,
  excluded: ReadonlySet<string>
): CapabilityRecommendation | null {
  const item = byId.get(r.candidateId)
  if (!item || item.blockedReason || excluded.has(r.candidateId)) return null
  const roleIds = r.roleIds.filter((id) => roles.some((x) => x.id === id) && !heldBy(item, id))
  if (!roleIds.length) return null
  return roleIds.length === r.roleIds.length ? r : { ...r, roleIds }
}

function readable(e: unknown): string {
  return clampText(e instanceof Error ? e.message : String(e), 300) || 'Something went wrong.'
}

const LOCAL_SKILL_IDS: CapabilitySourceId[] = ['claude-skills', 'agents-skills', 'copilot-skills', 'claude-plugins']
const LOCAL_MCP_IDS: CapabilitySourceId[] = ['claude-code-mcp', 'repo-mcp', 'claude-desktop-mcp', 'cursor-mcp', 'codex-mcp']
const LABELS: Partial<Record<CapabilitySourceId, string>> = {
  'repo-skills': 'Repository skills',
  'claude-skills': 'Claude Code skills',
  'agents-skills': 'Agent skills folder',
  'copilot-skills': 'GitHub Copilot skills',
  'claude-plugins': 'Claude Code plugins',
  'claude-code-mcp': 'Claude Code MCP servers',
  'repo-mcp': 'Repository MCP servers',
  'claude-desktop-mcp': 'Claude Desktop MCP servers',
  'cursor-mcp': 'Cursor MCP servers',
  'codex-mcp': 'Codex MCP servers',
  project: 'This project',
  library: 'Your library',
  catalog: 'Curated connectors',
  registry: 'MCP Registry',
  github: 'anthropics/skills'
}

function skippedStatus(source: CapabilitySourceId, message: string): CapabilitySourceStatus {
  return { source, label: LABELS[source] ?? source, locations: [], state: 'skipped', count: 0, message }
}

/**
 * The Team assistant (capabilities:*): token-free discovery, a one-shot recommendation completion, least-privilege
 * apply from main's own snapshot with one undo per project, per-role grants, and the phase 2 Team review.
 */
export class CapabilityService implements CapabilityServiceApi {
  private snapshots = new Map<string, Snapshot[]>()
  private undos = new Map<string, UndoRecord>()
  private controllers = new Map<string, AbortController>()
  private interactive = new Map<string, AbortController>()
  private runTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingRuns = new Map<string, number>()
  private chains = new Map<string, Promise<unknown>>()
  /**
   * Activity (backgroundTasks): non-zero while a discover, recommend or review runs (tracked controllers), a project's
   * serial review chain is pending, or a debounced run-ended review is scheduled. A review counts in both maps; only
   * zero versus non-zero matters.
   */
  inFlightCount(): number { return this.controllers.size + this.chains.size + this.runTimers.size }
  private disposed = false
  private now: () => number

  constructor(private deps: CapabilityServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  // ---------- helpers ----------

  private project(projectId: string): Project {
    // The harness project is virtual (library assistants); it has no org chart to equip.
    if (isVirtualProjectId(projectId)) throw new Error('Project not found')
    const p = this.deps.projects.get(projectId)
    if (!p) throw new Error('Project not found')
    return p
  }

  /** The stored project with linked servers and skills refreshed from the libraries. */
  private fresh(projectId: string): Project {
    return this.deps.skills.withLibrary(this.deps.mcp.withLibrary(this.project(projectId)))
  }

  private emitter(projectId: string, requestId: string): Emit {
    return (phase, state, count, message) => {
      try {
        this.deps.progress({ projectId, requestId, phase, state, ...(count !== undefined ? { count } : {}), ...(message ? { message } : {}) })
      } catch {
        /* a window went away */
      }
    }
  }

  private track(requestId: string): AbortController {
    this.controllers.get(requestId)?.abort()
    const ac = new AbortController()
    this.controllers.set(requestId, ac)
    return ac
  }

  private untrack(requestId: string, ac: AbortController): void {
    if (this.controllers.get(requestId) === ac) this.controllers.delete(requestId)
  }

  private requestIdOf(id: string | undefined): string {
    return id ?? `req-${randomBytes(6).toString('hex')}`
  }

  private keep(projectId: string, snap: Snapshot): void {
    // A review refresh replaces the previous refresh instead of taking another slot: applying many recommendations
    // from one result must never push that result's snapshot out (its digest would then read as stale).
    // The same digest seen again: carry its recommendations over, and a refresh of a recommend result stays pinned.
    const same = this.snapshots.get(projectId)?.find((s) => s.digest === snap.digest && s !== snap)
    if (same) {
      for (const [id, r] of same.recs) if (!snap.recs.has(id)) snap.recs.set(id, r)
      if (!same.refresh) delete snap.refresh
    }
    const list = (this.snapshots.get(projectId) ?? []).filter((s) => s.digest !== snap.digest && !(snap.refresh && s.refresh))
    list.unshift(snap)
    this.snapshots.set(projectId, list.slice(0, SNAPSHOTS_PER_PROJECT))
    // Total cap: drop the oldest snapshots (never the new one) until the budget fits.
    let total = 0
    for (const l of this.snapshots.values()) total += l.length
    while (total > SNAPSHOTS_TOTAL) {
      let oldest: { pid: string; snap: Snapshot } | undefined
      for (const [pid, l] of this.snapshots) for (const sn of l) if (sn !== snap && (!oldest || sn.at < oldest.snap.at)) oldest = { pid, snap: sn }
      if (!oldest) break
      const rest = (this.snapshots.get(oldest.pid) ?? []).filter((x) => x !== oldest!.snap)
      if (rest.length) this.snapshots.set(oldest.pid, rest)
      else this.snapshots.delete(oldest.pid)
      total--
    }
  }

  /**
   * One interactive discovery per project at a time: starting a discover, a recommend or a manual review aborts the
   * older one for that project (its result comes back partial, and a partial review is not saved). Automatic reviews
   * (runEnded, and 'opened', which the tab fires beside its own discover) neither abort nor are aborted by this.
   */
  private supersede(projectId: string, ac: AbortController): () => void {
    this.interactive.get(projectId)?.abort()
    this.interactive.set(projectId, ac)
    return () => {
      if (this.interactive.get(projectId) === ac) this.interactive.delete(projectId)
    }
  }

  private findSnapshot(projectId: string, digest: string): Snapshot | undefined {
    return this.snapshots.get(projectId)?.find((s) => s.digest === digest)
  }

  /** Run one project's reviews one after another (they read and write the same file). */
  private serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(projectId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.chains.set(projectId, tail)
    void tail.then(() => {
      if (this.chains.get(projectId) === tail) this.chains.delete(projectId)
    })
    return next
  }

  // ---------- discovery ----------

  private async discoverSnap(
    project: Project,
    opts: { includeOutside: boolean; query?: string; requestId: string; signal: AbortSignal; emit: Emit; refresh?: boolean }
  ): Promise<Snapshot> {
    const { signal, emit } = opts
    const ctx: LocalContext = { projectPath: project.path, homeDir: this.deps.homeDir, env: this.deps.env, platform: this.deps.platform }
    const candidates: DiscoveredCandidate[] = []
    const sources: CapabilitySourceStatus[] = []
    const warnings: CapabilityWarning[] = []
    let stopped = false
    const take = (r: SourceResult): void => {
      candidates.push(...r.candidates)
      sources.push(...r.sources)
      warnings.push(...r.warnings)
      for (const s of r.sources) emit(s.source, s.state === 'found' || s.state === 'empty' || s.state === 'missing' ? 'done' : s.state, s.count, s.message)
    }
    const step = async (ids: CapabilitySourceId[], run: () => SourceResult | Promise<SourceResult>): Promise<void> => {
      if (signal.aborted) stopped = true
      if (stopped) {
        for (const id of ids) {
          sources.push(skippedStatus(id, 'Stopped.'))
          emit(id, 'skipped', 0, 'Stopped.')
        }
        return
      }
      for (const id of ids) emit(id, 'running')
      // Let a cancel arrive between the synchronous file reads.
      await new Promise<void>((r) => setImmediate(r))
      try {
        take(await run())
      } catch (e) {
        for (const id of ids) {
          sources.push({ source: id, label: LABELS[id] ?? id, locations: [], state: 'error', count: 0, message: readable(e) })
          emit(id, 'error', 0, readable(e))
        }
        warnings.push({ source: ids[0]!, message: readable(e) })
      }
    }
    await step(['project'], () => discoverProject(project, this.deps.skills.list(project.id), this.deps.mcp.list(project.id)))
    await step(['repo-skills'], () => discoverRepoSkills(ctx))
    await step(LOCAL_SKILL_IDS, () => discoverLocalSkills(ctx))
    await step(LOCAL_MCP_IDS, () => discoverLocalMcp(ctx))
    await step(['library'], () => discoverLibrary(project, this.deps.mcp.libraryList(), this.deps.skills.libraryList()))
    await step(['catalog'], () => discoverCatalog(project, this.deps.mcp.connectorsList()))
    if (opts.includeOutside) {
      const outside = { fetch: this.deps.fetch ?? fetch, mock: this.deps.mock, queries: registryQueries(project, opts.query), signal }
      await step(['registry'], () => discoverRegistry(outside))
      await step(['github'], () => discoverGithubSkills(outside))
    } else {
      for (const id of ['registry', 'github'] as const) {
        sources.push(skippedStatus(id, 'Outside sources are off.'))
        emit(id, 'skipped', 0, 'Outside sources are off.')
      }
    }
    if (signal.aborted || sources.some((s) => s.message === 'Stopped.')) stopped = true
    let merged = dropProjectDuplicates(candidates)
    let capped = false
    if (merged.length > CAPABILITY_MAX_ITEMS) {
      merged = merged.slice(0, CAPABILITY_MAX_ITEMS)
      capped = true
      warnings.push({ source: 'project', message: `Only the first ${CAPABILITY_MAX_ITEMS} candidates are listed.` })
    }
    const items = merged.map((c) => c.item)
    const digest = digestOf(merged)
    const discovery: CapabilityDiscovery = {
      projectId: project.id,
      items,
      sources,
      warnings: warnings.slice(0, 200),
      includeOutside: opts.includeOutside,
      digest,
      ...(stopped || capped ? { partial: true as const } : {}),
      createdAt: new Date(this.now()).toISOString()
    }
    const snap: Snapshot = { digest, discovery, candidates: new Map(merged.map((c) => [c.item.id, c])), recs: new Map(), requestId: opts.requestId, at: this.now(), ...(opts.refresh ? { refresh: true } : {}) }
    this.keep(project.id, snap)
    return snap
  }

  async discover(input: CapabilityDiscoverInput): Promise<CapabilityDiscovery> {
    const project = this.project(input.projectId)
    const requestId = this.requestIdOf(input.requestId)
    const ac = this.track(requestId)
    const release = this.supersede(project.id, ac)
    try {
      const snap = await this.discoverSnap(project, { includeOutside: input.includeOutside === true, query: input.query, requestId, signal: ac.signal, emit: this.emitter(project.id, requestId) })
      return snap.discovery
    } finally {
      release()
      this.untrack(requestId, ac)
    }
  }

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort()
  }

  // ---------- recommend ----------

  private async runModel(project: Project, snap: Snapshot, scope: CapabilityScope, signal: AbortSignal, emit: Emit, localDetail: LocalDetail = 'full', exclude: ReadonlySet<string> = new Set()): Promise<ModelOutcome> {
    // Dismissed candidates are never offered to the model nor to the keyword fallback.
    const items = exclude.size ? snap.discovery.items.filter((i) => !exclude.has(i.id)) : snap.discovery.items
    const salt = `${snap.digest}\0${scope.roleId ?? ''}`
    const fallback = (reason: NonNullable<TeamRecommendations['fallbackReason']>, extra: Partial<ModelOutcome> = {}): ModelOutcome => ({
      mode: 'fallback',
      recommendations: fallbackRecommend(items, project.roles, scope, salt),
      gaps: [],
      fallbackReason: reason,
      ...extra
    })
    if (!recommendable(items, scopeRoleIds(project.roles, scope)).length) return { mode: 'fallback', recommendations: [], gaps: [], fallbackReason: 'noCandidates' }
    if (signal.aborted) return fallback('cancelled')
    emit('model', 'running')
    const { system, prompt } = buildRecommendPrompt(project, items, scope, { localDetail })
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), CAPABILITY_RECOMMEND_TIMEOUT_MS)
    let tokens: number | undefined
    let usageModel: string | undefined
    try {
      const out = await this.deps.complete(project, {
        system,
        prompt,
        kind: 'recommend',
        tier: 'everyday',
        signal: AbortSignal.any([signal, timeout.signal]),
        onUsage: (u) => {
          tokens = (tokens ?? 0) + (Number(u?.tokens?.input) || 0) + (Number(u?.tokens?.output) || 0)
          if (typeof u?.model === 'string') usageModel = u.model
        }
      })
      if (signal.aborted) {
        emit('model', 'skipped', 0, 'Stopped.')
        return fallback('cancelled', { ...(tokens !== undefined ? { tokens } : {}) })
      }
      const parsed = parseRecommendAnswer(out?.text ?? '', items, project.roles, scope, salt)
      const model = out?.model ?? usageModel
      const extra = { ...(model ? { model } : {}), ...(tokens !== undefined ? { tokens } : {}) }
      if (!parsed.ok) {
        emit('model', 'error', 0, 'The answer could not be read; showing keyword matches instead.')
        return fallback('invalidAnswer', extra)
      }
      emit('model', 'done', parsed.recommendations.length)
      return { mode: 'model', recommendations: parsed.recommendations, gaps: parsed.gaps, ...extra }
    } catch (e) {
      const reason = signal.aborted ? 'cancelled' : timeout.signal.aborted ? 'timeout' : 'error'
      emit('model', reason === 'cancelled' ? 'skipped' : 'error', 0, reason === 'cancelled' ? 'Stopped.' : reason === 'timeout' ? 'The model took too long to answer.' : readable(e))
      return fallback(reason, tokens !== undefined ? { tokens } : {})
    } finally {
      clearTimeout(timer)
    }
  }

  async recommend(input: CapabilityRecommendInput): Promise<TeamRecommendations> {
    const project = this.project(input.projectId)
    const scope: CapabilityScope = input.scope?.roleId ? { roleId: input.scope.roleId } : {}
    if (scope.roleId && !project.roles.some((r) => r.id === scope.roleId)) throw new Error('Role not found')
    const requestId = this.requestIdOf(input.requestId)
    const includeOutside = input.includeOutside === true
    const emit = this.emitter(project.id, requestId)
    const reuse = input.requestId
      ? this.snapshots.get(project.id)?.find((s) => s.requestId === input.requestId && s.discovery.includeOutside === includeOutside && this.now() - s.at < SNAPSHOT_REUSE_MS && !s.discovery.partial)
      : undefined
    const ac = this.track(requestId)
    const release = this.supersede(project.id, ac)
    try {
      const snap = reuse ?? (await this.discoverSnap(project, { includeOutside, query: input.query, requestId, signal: ac.signal, emit }))
      const outcome = await this.runModel(project, snap, scope, ac.signal, emit, 'full', dismissedIds(readReview(this.deps.dataDir, project.id), snap.discovery.items))
      for (const r of outcome.recommendations) snap.recs.set(r.id, r)
      const partial = snap.discovery.partial || outcome.fallbackReason === 'cancelled'
      // A complete result also becomes the review's pending list, so it survives a reload or a restart.
      if (!partial) this.persistRecommend(project.id, snap, scope, outcome)
      return {
        projectId: project.id,
        scope,
        discovery: snap.discovery,
        recommendations: outcome.recommendations,
        gaps: outcome.gaps,
        digest: snap.digest,
        mode: outcome.mode,
        ...(outcome.fallbackReason ? { fallbackReason: outcome.fallbackReason } : {}),
        ...(outcome.model ? { model: outcome.model } : {}),
        ...(partial ? { partial: true as const } : {}),
        createdAt: new Date(this.now()).toISOString()
      }
    } finally {
      release()
      this.untrack(requestId, ac)
    }
  }

  /**
   * Merge a complete recommend result into the persisted review (after any review in flight): its recommendations
   * first, then the earlier pending ones whose candidate is unchanged, dismissed and already-held ones dropped, capped
   * at CAPABILITY_MAX_RECOMMENDATIONS. The review is rebound to this discovery (its digest) only when the snapshot is
   * not older than the stored discovery and not narrower (includeOutside on in the review but off here); then
   * `newCandidateIds` keeps only ids this discovery still lists. Otherwise the stored binding is kept and only the
   * fresh recommendations whose candidate has the same fingerprint in the stored discovery are merged in. With no
   * review yet a stub holds them. A model answer's gaps replace the earlier ones for the roles in scope. Never awaited
   * by recommend(); never throws.
   */
  private persistRecommend(projectId: string, snap: Snapshot, scope: CapabilityScope, outcome: ModelOutcome): void {
    void this.serial(projectId, async () => {
      const project = this.project(projectId)
      const prev = readReview(this.deps.dataDir, projectId)
      const prevAt = prev ? Date.parse(prev.discovery.createdAt) : NaN
      const rebind = !prev || ((!Number.isFinite(prevAt) || snap.at >= prevAt) && (snap.discovery.includeOutside || !prev.discovery.includeOutside))
      const snapById = new Map(snap.discovery.items.map((i) => [i.id, i]))
      const prevById = new Map((prev?.discovery.items ?? []).map((i) => [i.id, i]))
      // The discovery the review stays bound to, and the fresh picks that are valid against it.
      const items = rebind ? snap.discovery.items : prev!.discovery.items
      const byId = rebind ? snapById : prevById
      const dismissed = prev?.dismissed ?? []
      const excluded = dismissedIds({ dismissed }, items)
      const refine = (r: CapabilityRecommendation): CapabilityRecommendation | null => refineRecommendation(r, project.roles, byId, excluded)
      const matches = (r: CapabilityRecommendation): boolean => {
        if (rebind) return true
        const was = prevById.get(r.candidateId)
        return !!was && fingerprintOf(was, r.candidateId) === fingerprintOf(snapById.get(r.candidateId), r.candidateId)
      }
      const fresh = outcome.recommendations.filter(matches).map(refine).filter((r): r is CapabilityRecommendation => !!r)
      const have = new Set(fresh.map((r) => r.candidateId))
      const carried: CapabilityRecommendation[] = []
      for (const r of prev?.recommendations ?? []) {
        if (have.has(r.candidateId)) continue
        if (rebind && !sameCandidate(r, prevById.get(r.candidateId), snapById.get(r.candidateId))) continue
        const kept = refine(r)
        if (!kept) continue
        have.add(kept.candidateId)
        carried.push(kept)
      }
      const recommendations = [...fresh, ...carried].slice(0, CAPABILITY_MAX_RECOMMENDATIONS)
      const known = (g: CapabilityGap): boolean => project.roles.some((r) => r.id === g.roleId)
      let gaps = (prev?.gaps ?? []).filter(known)
      if (outcome.mode === 'model') {
        const inScope = (g: CapabilityGap): boolean => !scope.roleId || g.roleId === scope.roleId
        gaps = [...outcome.gaps.filter(known), ...gaps.filter((g) => !inScope(g))].slice(0, CAPABILITY_MAX_GAPS)
      }
      if (rebind) {
        for (const r of recommendations) snap.recs.set(r.id, r)
        const base: TeamReview = prev ?? this.stubReview(projectId, snap)
        const newCandidateIds = base.newCandidateIds.filter((id) => snapById.has(id))
        this.publish({ ...base, discovery: snap.discovery, digest: snap.digest, newCandidateIds, recommendations, gaps, pendingCount: recommendations.length, dismissed })
      } else {
        // Kept binding: the merged picks must be found by apply on the stored digest's snapshot when it is still held.
        const bound = this.findSnapshot(projectId, prev!.digest)
        for (const r of recommendations) bound?.recs.set(r.id, r)
        this.publish({ ...prev!, recommendations, gaps, pendingCount: recommendations.length, dismissed })
      }
    }).catch((e) => console.warn(`[capabilities] Saving the recommendations failed: ${readable(e)}`))
  }

  // ---------- apply / undo / grants ----------

  /** The snapshot for `digest`, re-discovered when it is gone (after a restart); undefined when the sources changed. */
  private async snapshotFor(project: Project, digest: string): Promise<Snapshot | undefined> {
    const known = this.findSnapshot(project.id, digest)
    if (known) return known
    const review = readReview(this.deps.dataDir, project.id)
    const fromReview = review?.digest === digest ? review : null
    const requestId = this.requestIdOf(undefined)
    const ac = new AbortController()
    const snap = await this.discoverSnap(project, { includeOutside: fromReview?.discovery.includeOutside === true, requestId, signal: ac.signal, emit: () => {} })
    if (snap.digest !== digest) return undefined
    for (const r of fromReview?.recommendations ?? []) snap.recs.set(r.id, r)
    return snap
  }

  private slugsOf(project: Project, roleIds: string[]): string[] {
    return roleIds.map((id) => project.roles.find((r) => r.id === id)!.slug)
  }

  /** Read-only or full connector variant for `access`, preferring the default variant. */
  private variantFor(def: ConnectorDef, access: CapabilityAccess): string {
    const want = access === 'read'
    const def0 = def.variants.find((v) => v.id === def.defaultVariant)
    if (def0 && def0.readOnly === want) return def0.id
    return (def.variants.find((v) => v.readOnly === want) ?? def0 ?? def.variants[0]!).id
  }

  async apply(input: CapabilityApplyInput): Promise<CapabilityApplyResult> {
    if (typeof input.digest !== 'string' || !input.digest) {
      this.project(input.projectId)
      throw new Error(STALE)
    }
    const snap = await this.snapshotFor(this.project(input.projectId), input.digest)
    if (!snap) throw new Error(STALE)
    // Read the project again: it may have changed while the snapshot was re-discovered.
    const project = this.project(input.projectId)
    let rec: CapabilityRecommendation | undefined
    let candidateId = input.candidateId
    if (input.recommendationId) {
      rec = snap.recs.get(input.recommendationId)
      if (!rec && !candidateId) throw new Error('Recommendation not found. Run the recommendations again.')
      if (rec && candidateId && candidateId !== rec.candidateId) throw new Error('The recommendation and the candidate do not match.')
      if (rec) candidateId = rec.candidateId
    }
    const cand = candidateId ? snap.candidates.get(candidateId) : undefined
    if (!cand) throw new Error('Candidate not found. Run the recommendations again.')
    const item = cand.item
    if (item.blockedReason) throw new Error(`${item.name} cannot be added: ${item.blockedReason}`)
    const roleIds = [...new Set(Array.isArray(input.roleIds) ? input.roleIds : [])]
    if (!roleIds.length) throw new Error('Choose at least one role. Nobody gets it until you do.')
    const roles: Role[] = []
    for (const id of roleIds) {
      const r = project.roles.find((x) => x.id === id)
      if (!r) throw new Error(`Unknown role: ${clampText(id, 60)}`)
      roles.push(r)
    }
    const access: CapabilityAccess = input.access ?? rec?.access ?? 'read'
    if (access === 'full') {
      const cannot = roles.filter((r) => !canWrite(r))
      if (cannot.length) throw new Error(`${cannot.map((r) => r.name).join(', ')} cannot change files or run commands, so only read access can be given.`)
    }

    const undo: UndoRecord = {
      undoId: `undo-${randomBytes(8).toString('hex')}`,
      projectId: project.id,
      prevRoles: new Map(project.roles.map((r) => [r.id, { skills: r.skills ? [...r.skills] : undefined, mcpServers: r.mcpServers ? [...r.mcpServers] : undefined }])),
      prevServerRoles: new Map((project.mcpServers ?? []).map((s) => [s.id, s.roles ? [...s.roles] : undefined]))
    }
    const notes: string[] = []
    let needsSetup: CapabilityApplyResult['needsSetup']
    let applied: CapabilityApplied
    const payload: CandidatePayload = cand.payload
    const name = item.name

    switch (payload.type) {
      case 'projectSkill': {
        this.grantSkill(project.id, payload.skillId, roleIds)
        applied = { kind: 'skill', id: payload.skillId, name, action: 'granted', roleIds, access }
        break
      }
      case 'projectMcp': {
        if (this.grantMcp(project.id, payload.serverId, roleIds) === 'everyRole') notes.push('Every role can already use it.')
        applied = { kind: 'mcp', id: payload.serverId, name, action: 'granted', roleIds, access }
        needsSetup = this.serverSetup(project.id, payload.serverId)
        break
      }
      case 'skillFolder': {
        const again = rereadSkillFolder(payload)
        if (!again.ok) throw new Error(again.reason)
        const skipped = (again as { skipped?: string[] }).skipped
        if (skipped?.length) notes.push(`Left out ${skipped.length} private-looking file${skipped.length === 1 ? '' : 's'}: ${clampText(skipped.slice(0, 5).join(', '), 200)}${skipped.length > 5 ? ', ...' : ''}`)
        const r = this.deps.skills.addSnapshot({
          projectId: project.id,
          files: again.files,
          folderName: payload.dir.split(/[\\/]/).pop() || name,
          source: payload.source,
          ...(payload.source === 'repo' ? { repoPath: payload.sourceRef } : { sourceRef: item.location ?? payload.sourceRef }),
          roleIds
        })
        const added = r.project.skills?.find((s) => !(project.skills ?? []).some((o) => o.id === s.id))
        if (!added) throw new Error('The skill could not be added.')
        undo.addedSkillId = added.id
        applied = { kind: 'skill', id: added.id, name: added.name, action: 'added', roleIds, access }
        break
      }
      case 'skillMd': {
        const built = buildScannedSkill([{ path: 'SKILL.md', data: Buffer.from(payload.text, 'utf8') }], name, name, null)
        if (typeof built === 'string') throw new Error(built)
        if (item.digest && built.digest !== item.digest) throw new Error(STALE)
        const r = this.deps.skills.addSnapshot({ projectId: project.id, files: built.data, folderName: name, source: 'github', sourceRef: payload.url, roleIds })
        const added = r.project.skills?.find((s) => !(project.skills ?? []).some((o) => o.id === s.id))
        if (!added) throw new Error('The skill could not be added.')
        undo.addedSkillId = added.id
        applied = { kind: 'skill', id: added.id, name: added.name, action: 'added', roleIds, access }
        notes.push('Only SKILL.md was fetched; resource files it mentions are not included.')
        break
      }
      case 'mcpSpec': {
        if ((project.mcpServers ?? []).some((s) => s.name === payload.spec.name)) throw new Error(`This project already has a connection named ${payload.spec.name}.`)
        // Secret slots have no value yet: save it turned off so runs never get a half-configured server.
        const slots = [...new Set([...(payload.spec.secretEnv ?? []), ...(payload.spec.secretHeaders ?? [])])]
        const off = slots.length > 0
        const offNote = `Turned off until you enter ${slots.join(', ')}; turn it on in Project settings > Tools.`
        if (off) notes.push(offNote)
        const spec: McpServerSpec = {
          ...structuredClone(payload.spec),
          id: newId('mcp'),
          enabled: !off,
          ...(off ? { description: clampText(`${payload.spec.description ?? ''} ${offNote}`, 300) } : {}),
          roles: this.slugsOf(project, roleIds),
          source: item.origin === 'registry' ? 'registry' : 'local',
          addedAt: new Date(this.now()).toISOString()
        }
        delete spec.libraryId
        delete spec.oauth
        delete spec.connectorId
        delete spec.connectorVariant
        this.deps.mcp.upsert({ projectId: project.id, spec })
        undo.addedServerId = spec.id
        applied = { kind: 'mcp', id: spec.id, name: spec.name, action: 'added', roleIds, access }
        needsSetup = this.serverSetup(project.id, spec.id)
        break
      }
      case 'connector': {
        const def = connectorById(payload.connectorId)
        if (!def) throw new Error('Unknown connector.')
        const before = this.deps.mcp.connectorsList().find((c) => c.connector.id === def.id)
        const variant = this.variantFor(def, access)
        const info = this.deps.mcp.connectorsAdd({ connectorId: def.id, variant })
        const libraryId = info.entry.id
        if (!before?.library) undo.createdLibraryId = libraryId
        const kept = info.entry.connectorVariant
        const keptVariant = def.variants.find((v) => v.id === kept)
        let actual = access
        if (before?.library && kept && kept !== variant && keptVariant) {
          actual = keptVariant.readOnly ? 'read' : access
          notes.push(`Kept the ${keptVariant.label} version already in your library; change it in App settings > Connectors.`)
        }
        const now = this.project(project.id)
        const link = (now.mcpServers ?? []).find((s) => s.libraryId === libraryId)
        if (link) {
          if (this.grantMcp(project.id, link.id, roleIds) === 'everyRole') notes.push('Every role can already use it.')
          applied = { kind: 'mcp', id: link.id, name: def.name, action: 'granted', roleIds, access: actual }
        } else {
          const r = this.deps.mcp.linkLibrary({ projectId: project.id, libraryId, roles: this.slugsOf(project, roleIds) })
          const added = r.project.mcpServers?.find((s) => s.libraryId === libraryId)
          if (!added) throw new Error(`${def.name} could not be linked.`)
          undo.addedServerId = added.id
          applied = { kind: 'mcp', id: added.id, name: def.name, action: 'linked', roleIds, access: actual }
        }
        const state = this.deps.mcp.connectorsList().find((c) => c.connector.id === def.id)?.state
        const lib = this.deps.mcp.libraryList().find((l) => l.entry.id === libraryId)
        const secrets = lib?.missingSecrets ?? []
        const signIn = state !== 'connected'
        if (signIn || secrets.length) needsSetup = { secrets: [...secrets], signIn, connectorId: def.id, libraryId }
        break
      }
      case 'libraryMcp': {
        const r = this.deps.mcp.linkLibrary({ projectId: project.id, libraryId: payload.libraryId, roles: this.slugsOf(project, roleIds) })
        const added = r.project.mcpServers?.find((s) => s.libraryId === payload.libraryId)
        if (!added) throw new Error(`${name} could not be linked.`)
        undo.addedServerId = added.id
        applied = { kind: 'mcp', id: added.id, name, action: 'linked', roleIds, access }
        needsSetup = this.serverSetup(project.id, added.id, payload.libraryId)
        break
      }
      case 'librarySkill': {
        const r = this.deps.skills.linkLibrary({ projectId: project.id, libraryId: payload.libraryId, roleIds })
        const added = r.project.skills?.find((s) => s.libraryId === payload.libraryId)
        if (!added) throw new Error(`${name} could not be linked.`)
        undo.addedSkillId = added.id
        applied = { kind: 'skill', id: added.id, name, action: 'linked', roleIds, access }
        break
      }
    }

    this.undos.set(project.id, undo)
    await this.refreshReview(project.id, candidateId!, rec?.id)
    const saved = this.fresh(project.id)
    this.deps.onProjectChanged(saved)
    return { project: saved, applied: applied!, undoId: undo.undoId, ...(needsSetup ? { needsSetup } : {}), notes }
  }

  /** Secrets still missing and whether a sign-in is needed for a project server. */
  private serverSetup(projectId: string, serverId: string, libraryId?: string): CapabilityApplyResult['needsSetup'] {
    const info = this.deps.mcp.list(projectId).find((s) => s.spec.id === serverId)
    if (!info) return undefined
    const signIn = info.auth.state === 'notAuthorized' || info.auth.state === 'expired' || info.auth.state === 'error'
    if (!info.missingSecrets.length && !signIn) return undefined
    return { secrets: [...info.missingSecrets], signIn, ...(libraryId ? { libraryId } : {}) }
  }

  private grantSkill(projectId: string, skillId: string, roleIds: string[]): void {
    const project = this.project(projectId)
    if (!(project.skills ?? []).some((s) => s.id === skillId)) throw new Error('Skill not found')
    this.deps.projects.save({
      ...project,
      roles: project.roles.map((r) => (roleIds.includes(r.id) && !(r.skills ?? []).includes(skillId) ? { ...r, skills: [...(r.skills ?? []), skillId] } : r))
    })
  }

  /** Adds the roles' slugs to the server's roles; 'everyRole' when it already reaches every role. */
  private grantMcp(projectId: string, serverId: string, roleIds: string[]): 'granted' | 'everyRole' {
    const project = this.project(projectId)
    const spec = (project.mcpServers ?? []).find((s) => s.id === serverId)
    if (!spec) throw new Error('Server not found')
    if (spec.roles === undefined) return 'everyRole'
    const slugs = this.slugsOf(project, roleIds)
    const next = [...new Set([...spec.roles, ...slugs])]
    this.deps.projects.save({ ...project, mcpServers: (project.mcpServers ?? []).map((s) => (s.id === serverId ? { ...s, roles: next } : s)) })
    return 'granted'
  }

  undo(input: CapabilityUndoInput): CapabilityUndoResult {
    this.project(input.projectId)
    const rec = this.undos.get(input.projectId)
    if (!rec || rec.undoId !== input.undoId) throw new Error('Nothing to undo: only the last change in this project can be undone.')
    this.undos.delete(input.projectId)
    let project = this.project(input.projectId)
    if (rec.addedSkillId && (project.skills ?? []).some((s) => s.id === rec.addedSkillId)) this.deps.skills.remove({ projectId: project.id, skillId: rec.addedSkillId })
    project = this.project(input.projectId)
    if (rec.addedServerId && (project.mcpServers ?? []).some((s) => s.id === rec.addedServerId)) this.deps.mcp.remove({ projectId: project.id, serverId: rec.addedServerId })
    if (rec.createdLibraryId) {
      const linked = this.deps.projects.list().some((p) => (p.mcpServers ?? []).some((s) => s.libraryId === rec.createdLibraryId))
      if (!linked && this.deps.mcp.libraryEntries().some((e) => e.id === rec.createdLibraryId)) {
        try {
          this.deps.mcp.libraryRemove({ libraryId: rec.createdLibraryId })
        } catch {
          /* already gone */
        }
      }
    }
    project = this.project(input.projectId)
    const skillIds = new Set((project.skills ?? []).map((s) => s.id))
    const serverIds = new Set((project.mcpServers ?? []).map((s) => s.id))
    const roles = project.roles.map((r) => {
      const prev = rec.prevRoles.get(r.id)
      if (!prev) return r
      const next: Role = { ...r }
      if (prev.skills === undefined) delete next.skills
      else next.skills = prev.skills.filter((id) => skillIds.has(id))
      if (prev.mcpServers === undefined) delete next.mcpServers
      else next.mcpServers = prev.mcpServers.filter((id) => serverIds.has(id))
      return next
    })
    const mcpServers = project.mcpServers?.map((s) => {
      if (!rec.prevServerRoles.has(s.id)) return s
      const prev = rec.prevServerRoles.get(s.id)
      const next: McpServerSpec = { ...s }
      if (prev === undefined) delete next.roles
      else next.roles = [...prev]
      return next
    })
    this.deps.projects.save({ ...project, roles, ...(mcpServers ? { mcpServers } : {}) })
    const saved = this.fresh(input.projectId)
    this.deps.onProjectChanged(saved)
    return { project: saved }
  }

  forgetProject(projectId: string): void {
    if (isVirtualProjectId(projectId)) return
    this.snapshots.delete(projectId)
    this.undos.delete(projectId)
    clearTimeout(this.runTimers.get(projectId))
    this.runTimers.delete(projectId)
    this.pendingRuns.delete(projectId)
    try {
      removeReview(this.deps.dataDir, projectId)
    } catch {
      /* best effort */
    }
  }

  // ---------- phase 2: the Team review ----------

  lastReview(projectId: string): TeamReview | null {
    if (isVirtualProjectId(projectId)) return null
    return readReview(this.deps.dataDir, projectId)
  }

  private publish(review: TeamReview): void {
    writeReview(this.deps.dataDir, review)
    try {
      this.deps.reviewUpdated(reviewSummary(review))
    } catch {
      /* a window went away */
    }
  }

  /**
   * After an apply: remove the applied recommendation (by id, or every one for the candidate) from the persisted
   * review and, for a local review, re-bind it to the project's new state. An apply changes what discovery finds
   * (the repo item becomes a project item), so without this the review's digest would be stale after a restart and
   * its other recommendations could not be applied. Best effort; an outside review keeps its old digest.
   */
  private async refreshReview(projectId: string, candidateId: string, recId?: string): Promise<void> {
    const review = readReview(this.deps.dataDir, projectId)
    if (!review) return
    const recommendations = review.recommendations.filter((r) => r.id !== recId && r.candidateId !== candidateId)
    let next: TeamReview = { ...review, recommendations, pendingCount: recommendations.length }
    if (!review.discovery.includeOutside) {
      try {
        const snap = await this.discoverSnap(this.project(projectId), { includeOutside: false, requestId: this.requestIdOf(undefined), signal: new AbortController().signal, emit: () => {}, refresh: true })
        if (!snap.discovery.partial) {
          const ids = new Set(snap.discovery.items.map((i) => i.id))
          const kept = recommendations.filter((r) => ids.has(r.candidateId))
          for (const r of kept) snap.recs.set(r.id, r)
          next = { ...next, discovery: snap.discovery, digest: snap.digest, recommendations: kept, pendingCount: kept.length }
        }
      } catch {
        /* keep the old binding */
      }
    }
    this.publish(next)
  }

  dismiss(input: TeamDismissInput): TeamReview {
    const project = this.project(input.projectId)
    const review = readReview(this.deps.dataDir, project.id)
    const snaps = this.snapshots.get(project.id) ?? []
    // The recommendation from the persisted review, else from a recommend() result still held in memory.
    let rec = input.recommendationId ? review?.recommendations.find((r) => r.id === input.recommendationId) : undefined
    let recSnap: Snapshot | undefined
    if (!rec && input.recommendationId) {
      for (const s of snaps) {
        if ((rec = s.recs.get(input.recommendationId))) {
          recSnap = s
          break
        }
      }
    }
    if (rec && input.candidateId && rec.candidateId !== input.candidateId) throw new Error('The recommendation and the candidate do not match.')
    const candidateId = rec?.candidateId ?? input.candidateId
    if (!candidateId) throw new Error('Recommendation not found')
    let item = review?.discovery.items.find((i) => i.id === candidateId)
    let from: Snapshot | undefined
    if (!item) {
      // The snapshot that held the recommendation first: the fingerprint must be of the spec the user saw.
      from = recSnap?.candidates.has(candidateId) ? recSnap : snaps.find((s) => s.candidates.has(candidateId))
      item = from?.candidates.get(candidateId)?.item
    }
    if (!item) throw new Error(input.recommendationId ? 'Recommendation not found' : 'Candidate not found')
    const entry: TeamDismissal = {
      candidateId,
      fingerprint: fingerprintOf(item, candidateId),
      at: new Date(this.now()).toISOString(),
      name: clampText(item.name, 64),
      kind: item.kind,
      ...(rec ? { recommendation: rec } : {})
    }
    // No review yet (a fresh recommend result): start one bound to that discovery so the dismissal persists.
    if (!review && from!.discovery.partial) throw new Error('That check was cut short. Run the recommendations again.')
    const base: TeamReview = review ?? this.stubReview(project.id, from!)
    const dismissed = [...base.dismissed.filter((d) => d.candidateId !== candidateId), entry].slice(-TEAM_REVIEW_MAX_DISMISSED)
    const recommendations = base.recommendations.filter((r) => r.id !== rec?.id && r.candidateId !== candidateId)
    const next: TeamReview = { ...base, recommendations, pendingCount: recommendations.length, dismissed }
    this.publish(next)
    return next
  }

  restore(input: TeamRestoreInput): TeamReview {
    const project = this.project(input.projectId)
    const review = readReview(this.deps.dataDir, project.id)
    const entry = review?.dismissed.find((d) => d.candidateId === input.candidateId)
    if (!review || !entry) throw new Error('Nothing to restore: that item is not dismissed.')
    const dismissed = review.dismissed.filter((d) => d.candidateId !== input.candidateId)
    let recommendations = review.recommendations
    const item = review.discovery.items.find((i) => i.id === entry.candidateId)
    // The dismissed card comes back only while its candidate is the one the user dismissed and some role still lacks it.
    if (entry.recommendation && item && fingerprintOf(item, entry.candidateId) === entry.fingerprint && !recommendations.some((r) => r.candidateId === entry.candidateId)) {
      const back = refineRecommendation(entry.recommendation, project.roles, new Map([[item.id, item]]), new Set())
      if (back) {
        recommendations = [back, ...recommendations].slice(0, CAPABILITY_MAX_RECOMMENDATIONS)
        this.findSnapshot(project.id, review.digest)?.recs.set(back.id, back)
      }
    }
    const next: TeamReview = { ...review, recommendations, pendingCount: recommendations.length, dismissed }
    this.publish(next)
    return next
  }

  /** A review with nothing pending, bound to a held discovery: only to persist a dismissal before any review ran. */
  private stubReview(projectId: string, snap: Snapshot): TeamReview {
    return {
      projectId,
      checkedAt: snap.discovery.createdAt,
      trigger: 'manual',
      mode: 'free',
      discovery: snap.discovery,
      digest: snap.digest,
      newCandidateIds: [],
      recommendations: [],
      gaps: [],
      evidence: [],
      dismissed: [],
      pendingCount: 0,
      runsSinceModel: 0,
      stub: true
    }
  }

  /** Something changed since the last review: the project was saved or a work run finished after it. */
  private changedSince(project: Project, review: TeamReview): boolean {
    const at = Date.parse(review.checkedAt)
    if (!Number.isFinite(at)) return true
    if (Date.parse(project.updatedAt) > at) return true
    try {
      return this.deps.listRuns(project.id).some((r) => r.kind === 'work' && (r.endedAt ?? 0) > at)
    } catch {
      return false
    }
  }

  async review(input: TeamReviewInput): Promise<TeamReview> {
    const project = this.project(input.projectId)
    const trigger = input.trigger === 'opened' ? 'opened' : 'manual'
    if (trigger === 'opened') {
      const prev = readReview(this.deps.dataDir, project.id)
      if (prev && !prev.stub && this.now() - Date.parse(prev.checkedAt) < TEAM_REVIEW_OPEN_THROTTLE_MS && !this.changedSince(project, prev)) return prev
    }
    const requestId = this.requestIdOf(input.requestId)
    const ac = this.track(requestId)
    const release = trigger === 'manual' ? this.supersede(project.id, ac) : () => {}
    try {
      return await this.serial(project.id, () =>
        this.runReview(project.id, {
          trigger,
          includeOutside: trigger === 'manual' && input.includeOutside === true,
          useModel: trigger === 'manual' && input.useModel === true,
          runsAdded: 0,
          requestId,
          signal: ac.signal
        })
      )
    } finally {
      release()
      this.untrack(requestId, ac)
    }
  }

  private recentRecords(projectId: string): RunRecord[] {
    try {
      const summaries = this.deps
        .listRuns(projectId)
        .filter((r) => r.kind === 'work' && r.endedAt !== undefined)
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
        .slice(0, EVIDENCE_MAX_RUNS)
      return summaries.map((s) => this.deps.getRun(s.id)).filter((r): r is RunRecord => !!r)
    } catch {
      return []
    }
  }

  private async runReview(
    projectId: string,
    opts: { trigger: TeamReviewTrigger; includeOutside: boolean; useModel: boolean; runsAdded: number; requestId: string; signal: AbortSignal }
  ): Promise<TeamReview> {
    const project = this.project(projectId)
    const prev = readReview(this.deps.dataDir, projectId)
    const emit = this.emitter(projectId, opts.requestId)
    const snap = await this.discoverSnap(project, { includeOutside: opts.includeOutside, requestId: opts.requestId, signal: opts.signal, emit })
    const items = snap.discovery.items
    const byId = new Map(items.map((i) => [i.id, i]))
    const evidence = collectEvidence(project, this.recentRecords(projectId))
    const prevIds = new Set((prev?.discovery.items ?? []).map((i) => i.id))
    const newCandidateIds = prev ? items.filter((i) => i.origin !== 'project' && !prevIds.has(i.id)).map((i) => i.id) : []
    let dismissed = prev?.dismissed ?? []
    const settings = teamReviewOf(project)
    let runsSinceModel = (prev?.runsSinceModel ?? 0) + opts.runsAdded
    const excluded = dismissedIds({ dismissed }, items)
    const stillUseful = (r: CapabilityRecommendation): boolean => refineRecommendation(r, project.roles, byId, excluded) !== null

    let skip: TeamReviewModelSkip | undefined
    if (!opts.useModel && opts.trigger === 'runEnded') {
      if (settings.auto === 'off') skip = 'autoOff'
      else if (settings.auto === 'free') skip = 'autoFree'
      else if (this.deps.mock) skip = 'mockFree'
      else if (runsSinceModel < settings.everyRuns) skip = 'everyRuns'
      // Nothing new since a review whose model step already looked at these candidates (a free-only previous review has not).
      else if (prev?.modelInput && !hasNewEvidence(prev.evidence, evidence) && newCandidateIds.length === 0) skip = 'noChange'
      else {
        const { system, prompt } = buildRecommendPrompt(project, items, {}, { localDetail: 'minimal' })
        if (estimateRecommendTokens(system, prompt) > settings.tokenBudget) skip = 'budget'
      }
    }

    // Pending recommendations carried over: the previous review's, and on a manual Re-check also the newest recommend
    // result still held in memory (what the user is looking at). Each is kept only while its candidate is unchanged
    // (same fingerprint as when it was recommended), so a Re-check merges by evidence instead of replacing the list.
    const unchanged = (r: CapabilityRecommendation, was: CapabilityItem | undefined): boolean => sameCandidate(r, was, byId.get(r.candidateId))
    const prevById = new Map((prev?.discovery.items ?? []).map((i) => [i.id, i]))
    const carried: CapabilityRecommendation[] = (prev?.recommendations ?? []).filter((r) => unchanged(r, prevById.get(r.candidateId)))
    if (opts.trigger === 'manual') {
      const since = prev && !prev.stub ? Date.parse(prev.checkedAt) : -Infinity
      const held = (this.snapshots.get(projectId) ?? [])
        .filter((s) => !s.refresh && !s.discovery.partial && s.recs.size > 0 && s.at >= since)
        .sort((a, b) => b.at - a.at)[0]
      const have = new Set(carried.map((r) => r.candidateId))
      for (const r of held?.recs.values() ?? []) {
        if (have.has(r.candidateId) || !unchanged(r, held!.candidates.get(r.candidateId)?.item)) continue
        have.add(r.candidateId)
        carried.push(r)
      }
    }
    let recommendations = carried.map((r) => refineRecommendation(r, project.roles, byId, excluded)).filter((r): r is CapabilityRecommendation => !!r).slice(0, CAPABILITY_MAX_RECOMMENDATIONS)
    // An automatic review never drops what is pending and adds new ones only up to TEAM_REVIEW_PROACTIVE_LIMIT.
    const automatic = opts.trigger !== 'manual'
    const room = automatic ? Math.max(0, TEAM_REVIEW_PROACTIVE_LIMIT - recommendations.length) : CAPABILITY_MAX_RECOMMENDATIONS
    // No room for an automatic model step's picks: do not spend tokens on it.
    if (!opts.useModel && opts.trigger === 'runEnded' && skip === undefined && room === 0) skip = 'pendingFull'
    const runModel = opts.useModel || (opts.trigger === 'runEnded' && skip === undefined)
    let gaps = (prev?.gaps ?? []).filter((g) => project.roles.some((r) => r.id === g.roleId))
    let mode: TeamReview['mode'] = 'free'
    let tokensUsed = prev?.tokensUsed
    let modelInput: TeamReviewModelInput | undefined
    if (skip === 'mockFree') {
      // No model under the mock: deterministic keyword matches stand in, so the first review has something pending.
      const have = new Set(recommendations.map((r) => r.candidateId))
      const salt = `${snap.digest}\0`
      let extra = fallbackRecommend(items, project.roles, {}, salt).filter((r) => !have.has(r.candidateId) && stillUseful(r))
      if (!recommendations.length && !extra.length) {
        // No shared words with any role (a default chart): offer the first candidate to the first non-root role anyway.
        const role = project.roles.find((r) => r.reportsTo !== null) ?? project.roles[0]
        const item = role ? recommendable(items).find((i) => i.origin !== 'project' && !excluded.has(i.id)) : undefined
        if (role && item) {
          const floor: CapabilityRecommendation = { id: recommendationId(item.id, [role.id], salt), candidateId: item.id, kind: item.kind, roleIds: [role.id], reason: 'Suggested for a first look (mock).', access: 'read' }
          extra = [floor].filter(stillUseful)
        }
      }
      recommendations = [...recommendations, ...extra.slice(0, room)].slice(0, CAPABILITY_MAX_RECOMMENDATIONS)
    }
    if (runModel) {
      modelInput = opts.useModel ? 'full' : 'proactive'
      const outcome = await this.runModel(project, snap, {}, opts.signal, emit, opts.useModel ? 'full' : 'minimal', excluded)
      if (outcome.mode === 'model') {
        mode = 'model'
        const fresh = outcome.recommendations.filter(stillUseful)
        if (opts.trigger === 'manual') {
          // A manual Re-check adds to what is pending; only a changed candidate, an apply or a dismissal removes one.
          const have = new Set(fresh.map((r) => r.candidateId))
          recommendations = [...fresh, ...recommendations.filter((r) => !have.has(r.candidateId))].slice(0, CAPABILITY_MAX_RECOMMENDATIONS)
        } else {
          const have = new Set(recommendations.map((r) => r.candidateId))
          recommendations = [...recommendations, ...fresh.filter((r) => !have.has(r.candidateId)).slice(0, room)]
        }
        gaps = outcome.gaps
        runsSinceModel = 0
      } else {
        skip = outcome.fallbackReason === 'timeout' ? 'timeout' : outcome.fallbackReason === 'cancelled' ? 'cancelled' : outcome.fallbackReason === 'noCandidates' ? 'noChange' : 'error'
      }
      if (outcome.tokens !== undefined) tokensUsed = outcome.tokens
    }
    // A dismiss or restore may have landed while this review awaited discovery or the model (they are not in
    // `serial`): take the stored list as it is now, drop what it dismisses and keep what it restored.
    const latest = readReview(this.deps.dataDir, projectId)
    if (latest) {
      const before = new Set(dismissed.map((d) => d.candidateId))
      dismissed = latest.dismissed
      const after = new Set(dismissed.map((d) => d.candidateId))
      const finalExcluded = dismissedIds({ dismissed }, items)
      const refineFinal = (r: CapabilityRecommendation): CapabilityRecommendation | null => refineRecommendation(r, project.roles, byId, finalExcluded)
      recommendations = recommendations.map(refineFinal).filter((r): r is CapabilityRecommendation => !!r)
      const have = new Set(recommendations.map((r) => r.candidateId))
      const latestById = new Map(latest.discovery.items.map((i) => [i.id, i]))
      const restored: CapabilityRecommendation[] = []
      for (const r of latest.recommendations) {
        if (!before.has(r.candidateId) || after.has(r.candidateId) || have.has(r.candidateId)) continue
        if (!sameCandidate(r, latestById.get(r.candidateId), byId.get(r.candidateId))) continue
        const back = refineFinal(r)
        if (!back) continue
        have.add(back.candidateId)
        restored.push(back)
      }
      recommendations = [...restored, ...recommendations].slice(0, CAPABILITY_MAX_RECOMMENDATIONS)
    }
    for (const r of recommendations) snap.recs.set(r.id, r)
    const review: TeamReview = {
      projectId,
      checkedAt: new Date(this.now()).toISOString(),
      trigger: opts.trigger,
      mode,
      ...(skip ? { modelSkipped: skip } : {}),
      discovery: snap.discovery,
      digest: snap.digest,
      newCandidateIds,
      recommendations,
      gaps,
      evidence,
      dismissed,
      pendingCount: recommendations.length,
      runsSinceModel,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      ...(modelInput ? { modelInput } : {})
    }
    // A review cut short (cancelled or superseded) is returned but never saved over the last complete one.
    if (!snap.discovery.partial) this.publish(review)
    return review
  }

  runEnded(projectId: string, _runId: string): void {
    try {
      if (this.disposed) return
      const project = this.deps.projects.get(projectId)
      if (isVirtualProjectId(projectId) || !project || teamReviewOf(project).auto === 'off') return
      // Setup-like and other non-work runs never trigger a review.
      const ended = (() => { try { return this.deps.listRuns(projectId).find((r) => r.id === _runId) } catch { return undefined } })()
      if (ended && ended.kind !== 'work') return
      this.pendingRuns.set(projectId, (this.pendingRuns.get(projectId) ?? 0) + 1)
      clearTimeout(this.runTimers.get(projectId))
      const timer = setTimeout(() => {
        this.runTimers.delete(projectId)
        void this.proactive(projectId)
      }, this.deps.runEndedDebounceMs ?? RUN_ENDED_DEBOUNCE_MS)
      ;(timer as { unref?: () => void }).unref?.()
      this.runTimers.set(projectId, timer)
    } catch {
      /* never throws */
    }
  }

  /** The debounced proactive review after work runs end. Never throws. */
  private async proactive(projectId: string): Promise<void> {
    const runsAdded = this.pendingRuns.get(projectId) ?? 0
    this.pendingRuns.delete(projectId)
    if (this.disposed || !this.deps.projects.get(projectId)) return
    const requestId = this.requestIdOf(undefined)
    const ac = this.track(requestId)
    try {
      await this.serial(projectId, () => this.runReview(projectId, { trigger: 'runEnded', includeOutside: false, useModel: false, runsAdded, requestId, signal: ac.signal }))
    } catch (e) {
      console.warn(`[capabilities] Team review after a run failed: ${readable(e)}`)
    } finally {
      this.untrack(requestId, ac)
    }
  }

  /** Test hook: wait for queued reviews of a project. */
  async idle(projectId: string): Promise<void> {
    await this.chains.get(projectId)
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.runTimers.values()) clearTimeout(t)
    this.runTimers.clear()
    for (const ac of this.controllers.values()) ac.abort()
    this.controllers.clear()
  }
}
