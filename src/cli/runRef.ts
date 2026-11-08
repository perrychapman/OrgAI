/**
 * Run references and the read commands' data source (cli-spec 3.2(3), 6.1).
 *
 * `resolveRunRef` turns what the user typed into one run id: a full id, `R<n>` / `r<n>` (needs a project: the index
 * comes from runIndexMap over that project's runs, so it matches the app's run tabs), or a unique id prefix of at
 * least 6 characters. Ambiguous and unknown refs are usage errors (exit 2).
 *
 * `openReadSource` is the rule every read command follows: read the data folder (ReadOnlySnapshot), never a host.
 */
import { VIRTUAL_PROJECT_IDS, type Project, type RunRecord, type RunSummary } from '../shared/types'
import { runIndexMap } from '../shared/view/runLabels'
import { note } from './output'
import { SNAPSHOT_NOTE } from './ownedMessage'
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

/** What run-ref resolution needs of a data source: a ReadSource, or a live host (liveSource). */
export type RunSource = Pick<ReadSource, 'projects' | 'runs' | 'allRuns' | 'record'>

export interface ReadSource {
  snapshot: ReadOnlySnapshot
  /** The snapshot's view of daemon.json: 'stopped' when no orgai owns the folder. */
  hostState: ReadOnlySnapshot['hostState']
  projects(): Promise<Project[]>
  /** The project's runs, newest first. */
  runs(projectId: string): Promise<RunSummary[]>
  /** Every run of these projects (virtual ones included when `virtual`), newest first. */
  allRuns(projectIds: readonly string[]): Promise<RunSummary[]>
  /** The stored record; null when missing. */
  record(runId: string): Promise<RunRecord | null>
  close(): void
}

const newestFirst = (a: RunSummary, b: RunSummary): number => b.startedAt - a.startedAt || b.id.localeCompare(a.id)

/**
 * The data every read command shows (cli-standalone-default.md 4.3): the files of the data folder, never a host. Beside
 * another orgai that owns the folder a stderr note in text mode says this is a saved snapshot (no live cards). Never
 * starts a host, never writes. `quiet` skips the note (the command prints its own wording).
 */
export async function openReadSource(ctx: CliContext, opts: { quiet?: boolean } = {}): Promise<ReadSource> {
  return sourceOf(ctx, await ctx.readStore(), opts)
}

/**
 * For the read commands that start their own host when nobody owns the folder (usage show, secrets status): the saved
 * files as a ReadSource while another orgai owns it (with the snapshot note), else null. Chosen before any connect, so
 * an owned answer never reaches a host call.
 */
export async function ownerSnapshot(ctx: CliContext, opts: { quiet?: boolean } = {}): Promise<ReadSource | null> {
  const snap = await ctx.readStore()
  return snap.hostState === 'stopped' ? null : sourceOf(ctx, snap, opts)
}

function sourceOf(ctx: CliContext, snap: ReadOnlySnapshot, opts: { quiet?: boolean }): ReadSource {
  if (!opts.quiet && snap.hostState !== 'stopped') note(ctx, SNAPSHOT_NOTE)
  const byProject = (projectId: string): RunSummary[] => snap.runs.filter((r) => r.projectId === projectId).sort(newestFirst)
  return {
    snapshot: snap,
    hostState: snap.hostState,
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

/** A RunSource over a connected client (projects, runs, records); exec, resume and the TUI use it for their own host. */
export function liveSource(client: HostClient): RunSource {
  const runs = async (projectId: string): Promise<RunSummary[]> => {
    if (!projectId) return []
    const list = await client.call<RunSummary[]>('runs:list', [projectId])
    return (Array.isArray(list) ? list : []).slice().sort(newestFirst)
  }
  return {
    projects: async () => {
      const list = await client.call('projects:list', [])
      return Array.isArray(list) ? (list as Project[]) : []
    },
    runs,
    allRuns: async (ids) => {
      const lists = await Promise.all(ids.map((id) => runs(id).catch(() => [] as RunSummary[])))
      const seen = new Set<string>()
      return lists
        .flat()
        .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
        .sort(newestFirst)
    },
    record: async (runId) => (await client.call<RunRecord | null>('runs:get', [runId]).catch(() => null)) ?? null
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
  src: RunSource,
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
