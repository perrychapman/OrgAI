/**
 * Run references and the read commands' data source (cli-spec 3.2(3), 6.1).
 *
 * `resolveRunRef` turns what the user typed into one run id: a full id, `R<n>` / `r<n>` (needs a project: the index
 * comes from runIndexMap over that project's runs, so it matches the app's run tabs), or a unique id prefix of at
 * least 6 characters. Ambiguous and unknown refs are usage errors (exit 2).
 *
 * `openReadSource` is the rule every read command follows: connect to the live host with the 'read' scope; when no
 * host is running, it is still starting or terminal access is off, read the data dir instead (ReadOnlySnapshot) and
 * say so on stderr in text mode. A read command never starts a host.
 */
import { VIRTUAL_PROJECT_IDS, type Project, type RunRecord, type RunSummary } from '../shared/types'
import { runIndexMap } from '../shared/view/runLabels'
import { note, warn } from './output'
import { CliError, EXIT, type CliContext, type HostClient, type ProjectResolution, type ReadOnlySnapshot } from './types'

/** The host's id shape (src/main/host/params.ts PARAM_ID_PATTERN; copied so the CLI bundle stays small). */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const TAG_RE = /^[Rr]([1-9]\d{0,6})$/
/** A prefix shorter than this is never matched (too likely to be ambiguous or a typo). */
export const RUN_PREFIX_MIN = 6

export interface RunRefInput {
  /** Every run the lookup may match (all projects for an id or prefix; the project's own for R#). */
  runs: readonly Pick<RunSummary, 'id' | 'projectId' | 'startedAt'>[]
  /** The resolved project; required for R<n>. */
  projectId?: string
}

/** One run id from a ref, or a CliError(exit 2). */
export function resolveRunRef(ref: string, input: RunRefInput): string {
  const raw = (ref ?? '').trim()
  if (!raw) throw new CliError('Give a run id or R<number>.', EXIT.usage)
  const tag = TAG_RE.exec(raw)
  if (tag) {
    if (!input.projectId) {
      throw new CliError(`${raw.toUpperCase()} needs a project: run this inside a project folder or pass --project.`, EXIT.usage)
    }
    const index = Number(tag[1])
    const own = input.runs.filter((r) => r.projectId === input.projectId)
    for (const [id, n] of runIndexMap(own)) if (n === index) return id
    throw new CliError(`This project has no run R${index}${own.length ? ` (it has R1 to R${own.length})` : ''}.`, EXIT.usage)
  }
  if (!RUN_ID_PATTERN.test(raw)) throw new CliError(`"${raw.slice(0, 64)}" is not a run id or R<number>.`, EXIT.usage)
  const exact = input.runs.find((r) => r.id === raw)
  if (exact) return exact.id
  if (raw.length >= RUN_PREFIX_MIN) {
    const hits = [...new Set(input.runs.filter((r) => r.id.startsWith(raw)).map((r) => r.id))]
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) {
      const shown = hits.slice(0, 5).join(', ')
      throw new CliError(`"${raw}" matches ${hits.length} runs (${shown}${hits.length > 5 ? ', ...' : ''}). Type more of the id.`, EXIT.usage)
    }
  }
  throw new CliError(`No run matches "${raw}".${raw.length < RUN_PREFIX_MIN ? ` An id prefix needs at least ${RUN_PREFIX_MIN} characters.` : ''}`, EXIT.usage)
}

/** True when the ref is an R<n> tag. */
export const isRunTag = (ref: string): boolean => TAG_RE.test(ref.trim())

// ---------- Data source ----------

/** Why the source is the saved data: the ConnectResult reason. */
export type HostlessReason = 'no_host' | 'starting' | 'disabled' | 'draining' | 'unreachable'

export interface ReadSource {
  /** The live host answered. */
  live: boolean
  client?: HostClient
  snapshot?: ReadOnlySnapshot
  /** 'ready' when live; else the snapshot's view of daemon.json. */
  hostState: ReadOnlySnapshot['hostState']
  /** Pending cards are known only with a live host. */
  liveInboxAvailable: boolean
  /** Set when hostless: why. */
  hostless?: { reason: HostlessReason; message: string }
  projects(): Promise<Project[]>
  /** runs:list(projectId), newest first. */
  runs(projectId: string): Promise<RunSummary[]>
  /** Every run of these projects (virtual ones included when `virtual`), newest first. */
  allRuns(projectIds: readonly string[]): Promise<RunSummary[]>
  /** runs:get (bulk) or the stored record; null when missing. */
  record(runId: string): Promise<RunRecord | null>
  close(): void
}

/** The note printed on stderr in text mode when the saved data is shown. */
export function hostlessNote(reason: HostlessReason, message: string): string {
  switch (reason) {
    case 'no_host':
      return 'No OrgAI host is running; showing saved data.'
    case 'starting':
      return 'OrgAI is starting; showing saved data.'
    case 'disabled':
      return message || 'Terminal access is turned off in OrgAI; showing saved data.'
    case 'draining':
      return 'OrgAI is shutting down; showing saved data.'
    case 'unreachable':
      return 'The OrgAI host did not answer; showing saved data.'
  }
}

const HOSTLESS: ReadonlySet<string> = new Set<HostlessReason>(['no_host', 'starting', 'disabled', 'draining', 'unreachable'])

/** The exit code for a connect refusal that is not a hostless case. */
function refusalExit(reason: string): number {
  return reason === 'auth_failed' ? EXIT.auth : EXIT.failure
}

const newestFirst = (a: RunSummary, b: RunSummary): number => b.startedAt - a.startedAt || b.id.localeCompare(a.id)

/** The version skew warning goes to stderr once per process. */
let skewWarned = false
/** Tests reset the once-per-process flag. */
export function resetSkewWarning(): void {
  skewWarned = false
}

/** Print hello.versionSkewWarning once (stderr, every format). */
export function warnVersionSkew(ctx: CliContext, client: HostClient): void {
  const w = client.hello.versionSkewWarning
  if (w && !skewWarned) {
    skewWarned = true
    warn(ctx, w)
  }
}

/**
 * The live host (scope 'read'), else the saved data with a stderr note in text mode. Other refusals (auth, protocol,
 * refused) are CliErrors. `quiet` skips the note (the command prints its own wording).
 */
export async function openReadSource(ctx: CliContext, opts: { quiet?: boolean } = {}): Promise<ReadSource> {
  const res = await ctx.connect(['read'], { clientKind: 'cli', waitStartingMs: 2000 })
  if (res.ok) {
    const client = res.client
    warnVersionSkew(ctx, client)
    const runs = async (projectId: string): Promise<RunSummary[]> => {
      const list = await client.call<RunSummary[]>('runs:list', [projectId])
      return (Array.isArray(list) ? list : []).slice().sort(newestFirst)
    }
    return {
      live: true,
      client,
      hostState: 'ready',
      liveInboxAvailable: true,
      projects: async () => {
        const list = await client.call<Project[]>('projects:list', [])
        return Array.isArray(list) ? list : []
      },
      runs,
      allRuns: async (projectIds) => {
        const lists = await Promise.all(projectIds.map((id) => runs(id).catch(() => [] as RunSummary[])))
        const seen = new Set<string>()
        return lists
          .flat()
          .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
          .sort(newestFirst)
      },
      record: async (runId) => (await client.call<RunRecord | null>('runs:get', [runId], { timeoutMs: 60_000 })) ?? null,
      close: () => client.close()
    }
  }
  if (!HOSTLESS.has(res.reason)) throw new CliError(res.message || `Could not connect to the OrgAI host (${res.reason}).`, refusalExit(res.reason))
  const reason = res.reason as HostlessReason
  if (!opts.quiet) note(ctx, hostlessNote(reason, res.message))
  const snap = await ctx.readStore()
  const byProject = (projectId: string): RunSummary[] => snap.runs.filter((r) => r.projectId === projectId).sort(newestFirst)
  return {
    live: false,
    snapshot: snap,
    hostState: snap.hostState,
    liveInboxAvailable: false,
    hostless: { reason, message: res.message },
    projects: async () => snap.projects,
    runs: async (projectId) => byProject(projectId),
    allRuns: async (projectIds) => {
      const ids = new Set(projectIds)
      return snap.runs.filter((r) => ids.has(r.projectId)).sort(newestFirst)
    },
    record: async (runId) => snap.readRecord(runId),
    close: () => undefined
  }
}

/** Every project id worth searching for a run id: the real projects plus the assistants' virtual projects. */
export function searchableProjectIds(projects: readonly Project[]): string[] {
  return [...projects.map((p) => p.id), ...VIRTUAL_PROJECT_IDS]
}

/** --project errors are usage errors (exit 2); no project at all is fine for callers that allow it. */
export function checkProjectResolution(res: ProjectResolution): void {
  if (res.error) throw new CliError(res.error, EXIT.usage)
}

/**
 * Resolve `ref` against the source: R<n> over the resolved project's runs, an id or prefix over every project's runs.
 * Returns the id and the runs it was looked up in (the caller's chain and index maps come from them). A full id that
 * no list contains is still accepted when the record exists (runs:list may leave some runs out).
 */
export async function resolveRunFromSource(
  ctx: CliContext,
  src: ReadSource,
  ref: string
): Promise<{ runId: string; projects: Project[]; resolution: ProjectResolution; runs: RunSummary[] }> {
  const projects = await src.projects()
  const resolution = ctx.resolveProject(projects)
  checkProjectResolution(resolution)
  const projectId = resolution.project?.id
  const runs = isRunTag(ref) ? (projectId ? await src.runs(projectId) : []) : await src.allRuns(searchableProjectIds(projects))
  try {
    return { runId: resolveRunRef(ref, { runs, projectId }), projects, resolution, runs }
  } catch (e) {
    const raw = ref.trim()
    if (!isRunTag(raw) && RUN_ID_PATTERN.test(raw) && raw.length >= RUN_PREFIX_MIN) {
      const rec = await src.record(raw).catch(() => null)
      if (rec) return { runId: rec.summary.id, projects, resolution, runs: [...runs, rec.summary] }
    }
    throw e
  }
}
