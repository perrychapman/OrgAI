/**
 * `orgai runs list [--all-projects] [--limit N] [--status <word>]` and `orgai runs show <runId|R#> [--transcript]
 * [--tail N]` (cli-spec 6.1, 3.2(3)). Live host first, else the saved data. Status words come from statusText only.
 *
 * `orgai runs send <ref> <text|->`, `runs interrupt <ref>` and `runs stop <ref>` act on a live run through the host
 * (scopes read + operate); they never start a host. The ref resolves to its chain's newest run, the only member that
 * can be live.
 */
import { VIRTUAL_PROJECT_LABELS, isVirtualProjectId, type PendingCards, type Project, type RunRecord, type RunSummary } from '../../shared/types'
import { formatDate } from '../../shared/view/dates'
import { chainOf, isOpenStatus } from '../../shared/view/runChains'
import { runIndexMap, runName, runTag } from '../../shared/view/runLabels'
import { statusText } from '../../shared/view/runStatus'
import { parseFlags } from '../flags'
import { emit, relativeTime, safeLine, styleFor, styleStatus, table, termWidth, type Json } from '../output'
import {
  agentTreeLines,
  costText,
  kindLabel,
  matchesStatus,
  pendingItems,
  planLines,
  recordWithoutImages,
  STATUS_FILTER_WORDS,
  statusViewOf,
  summaryLines,
  tailRows
} from '../render'
import { checkProjectResolution, openReadSource, resolveRunFromSource, searchableProjectIds, warnVersionSkew, type ReadSource } from '../runRef'
import { CliError, EXIT, HOST_STARTING_WAIT_MS, type CliContext, type CommandFn, type HostCallError } from '../types'

const DEFAULT_LIMIT = 20
const DEFAULT_TAIL = 20

/** A positive integer flag value, else a usage error. */
export function intFlag(name: string, raw: string | undefined, def: number, max = 100_000): number {
  if (raw === undefined) return def
  if (!/^\d+$/.test(raw.trim())) throw new CliError(`--${name} needs a whole number.`, EXIT.usage)
  const n = Number(raw)
  if (n < 0 || n > max) throw new CliError(`--${name} must be between 0 and ${max}.`, EXIT.usage)
  return n
}

export const runRuns: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const [sub, ...rest] = args
  if (sub === 'list') return runsList(ctx, rest)
  if (sub === 'show') return runsShow(ctx, rest)
  if (sub === 'send') return runsSend(ctx, rest)
  if (sub === 'interrupt' || sub === 'stop') return runsControl(ctx, sub, rest)
  throw new CliError(sub ? `Unknown runs command "${sub}". ${RUNS_USAGE}` : RUNS_USAGE, EXIT.usage)
}

const RUNS_USAGE = 'Use: orgai runs list | show <runId-or-R#> | send <runId-or-R#> <text|-> | interrupt <runId-or-R#> | stop <runId-or-R#>'

function projectName(projects: readonly Project[], id: string): string {
  if (isVirtualProjectId(id)) return VIRTUAL_PROJECT_LABELS[id]
  return projects.find((p) => p.id === id)?.name ?? id
}

/** Open runs' pending cards (live host only), keyed by run id. */
async function cardsOf(src: ReadSource, runs: readonly RunSummary[]): Promise<Map<string, PendingCards>> {
  const out = new Map<string, PendingCards>()
  if (!src.live || !src.client) return out
  for (const r of runs) {
    if (!isOpenStatus(r.status)) continue
    const cards = await src.client.call<PendingCards>('runs:pendingCards', [r.id]).catch(() => undefined)
    if (cards) out.set(r.id, cards)
  }
  return out
}

async function runsList(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, {
    'all-projects': { type: 'boolean' },
    limit: { type: 'string', short: 'n' },
    status: { type: 'string' }
  })
  if (positionals.length > 0) throw new CliError(`Unexpected argument "${positionals[0]}".`, EXIT.usage)
  const limit = intFlag('limit', values.limit, DEFAULT_LIMIT)
  const statusWord = values.status?.trim().toLowerCase()
  if (statusWord !== undefined && !STATUS_FILTER_WORDS.includes(statusWord)) {
    throw new CliError(`--status must be one of: ${STATUS_FILTER_WORDS.join(', ')}.`, EXIT.usage)
  }
  const all = !!values['all-projects']
  const src = await openReadSource(ctx)
  try {
    const projects = await src.projects()
    const resolution = ctx.resolveProject(projects)
    checkProjectResolution(resolution)
    if (!all && !resolution.project) {
      throw new CliError('No OrgAI project here. Run this inside a project folder, pass --project <id-or-path>, or use --all-projects.', EXIT.usage)
    }
    const scopeIds = all ? searchableProjectIds(projects) : [resolution.project!.id]
    const byProject = new Map<string, RunSummary[]>()
    for (const id of scopeIds) byProject.set(id, await src.runs(id).catch(() => []))
    const indexes = new Map<string, Map<string, number>>()
    for (const [id, runs] of byProject) indexes.set(id, runIndexMap(runs))
    const merged = [...byProject.values()].flat().sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
    const cards = await cardsOf(src, merged)
    let rows = merged.map((s) => {
      const waiting = pendingItems(s, cards.get(s.id)).length > 0
      const view = statusViewOf({ summary: s }, waiting)
      return { s, view, tag: runTag(indexes.get(s.projectId)?.get(s.id)), project: projectName(projects, s.projectId) }
    })
    if (statusWord) rows = rows.filter((r) => matchesStatus(r.view, statusWord))
    const total = rows.length
    if (limit > 0) rows = rows.slice(0, limit)

    const value: Json = {
      hostState: src.live ? 'ready' : src.hostState,
      liveInboxAvailable: src.liveInboxAvailable,
      ...(src.hostless ? { hostUnavailable: src.hostless } : {}),
      project: resolution.project ? { id: resolution.project.id, name: resolution.project.name, path: resolution.project.path } : null,
      total,
      runs: rows.map((r) => ({
        tag: r.tag,
        status: statusText(r.view),
        name: runName(r.s),
        kindLabel: kindLabel(r.s),
        projectName: r.project,
        cost: costText(r.s),
        summary: r.s
      }))
    }
    emit(ctx, value, () => {
      const st = styleFor(ctx)
      if (rows.length === 0) return [statusWord ? `No ${statusWord} runs.` : 'No runs yet.']
      const now = Date.now()
      const cols = [
        ...(all ? [{ header: 'PROJECT', min: 6, ellipsis: 'middle' as const }] : []),
        { header: 'RUN', min: 3 },
        { header: 'STATUS', min: 6, style: (c: string) => styleStatus(st, c) },
        { header: 'NAME', flex: true, min: 8 },
        { header: 'KIND', min: 3 },
        { header: 'STARTED', min: 6 },
        { header: 'COST', min: 4, align: 'right' as const }
      ]
      const cells = rows.map((r) => [
        ...(all ? [safeLine(r.project)] : []),
        r.tag,
        statusText(r.view),
        safeLine(runName(r.s)),
        kindLabel(r.s),
        relativeTime(r.s.startedAt, now, formatDate),
        costText(r.s)
      ])
      const lines = table(cols, cells, termWidth(ctx), st)
      if (total > rows.length) lines.push(st.dim(`${total - rows.length} more; use --limit ${Math.min(total, 1000)} to see them.`))
      return lines
    })
    return EXIT.ok
  } finally {
    src.close()
  }
}

async function runsShow(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { transcript: { type: 'boolean' }, tail: { type: 'string' } })
  if (positionals.length !== 1) throw new CliError('Use: orgai runs show <runId-or-R#> [--transcript] [--tail N]', EXIT.usage)
  const tail = intFlag('tail', values.tail, DEFAULT_TAIL)
  const src = await openReadSource(ctx)
  try {
    const { runId, projects, runs } = await resolveRunFromSource(ctx, src, positionals[0])
    const rec = await src.record(runId)
    if (!rec) throw new CliError(`Run ${runId} has no saved record.`, EXIT.failure)
    const s = rec.summary
    const projectRuns = runs.filter((r) => r.projectId === s.projectId)
    const list = projectRuns.some((r) => r.id === s.id) ? projectRuns : [...projectRuns, s]
    const index = runIndexMap(list)
    const tag = runTag(index.get(s.id))
    const chain = chainOf(list, s.id)
    const pos = chain.findIndex((r) => r.id === s.id)
    const previous = pos > 0 ? chain[pos - 1] : undefined
    let cards: PendingCards | undefined
    if (src.live && src.client && isOpenStatus(s.status)) cards = await src.client.call<PendingCards>('runs:pendingCards', [s.id]).catch(() => undefined)
    const waitingRows = pendingItems(s, cards, rec.agents)
    const view = statusViewOf({ summary: s, plan: rec.plan, agents: rec.agents }, waitingRows.length > 0)
    const project = projects.find((p) => p.id === s.projectId)
    const st = styleFor(ctx)
    const rows = tailRows(rec.transcript, rec.agents, st, values.transcript ? 0 : tail)

    const value: Json = {
      hostState: src.live ? 'ready' : src.hostState,
      liveInboxAvailable: src.liveInboxAvailable,
      ...(src.hostless ? { hostUnavailable: src.hostless } : {}),
      tag,
      status: statusText(view),
      ...(view.note ? { statusNote: view.note } : {}),
      name: runName(s),
      kindLabel: kindLabel(s),
      projectName: projectName(projects, s.projectId),
      cost: costText(s),
      chain: { index: pos + 1, count: chain.length, runIds: chain.map((r) => r.id) },
      needsYou: waitingRows.map((w) => ({ kind: w.kind, label: w.label, requestId: w.key })),
      transcriptTotal: rec.transcript.length,
      record: recordWithoutImages(values.transcript || tail === 0 ? rec : { ...rec, transcript: rec.transcript.slice(-tail) })
    }
    emit(ctx, value, () => {
      const lines = summaryLines(s, {
        st,
        tag,
        projectName: projectName(projects, s.projectId),
        projectPath: project?.path,
        chain: chain.length > 1 ? { index: pos + 1, count: chain.length, previousTag: previous ? runTag(index.get(previous.id)) : undefined } : undefined,
        waiting: waitingRows.length > 0,
        record: rec
      })
      if (waitingRows.length > 0) {
        lines.push(st.bold('Needs you:'))
        for (const w of waitingRows) lines.push(`  ${safeLine(w.label)} ${st.dim(`(request ${safeLine(w.key)})`)}`)
      }
      if (rec.plan) lines.push(...planLines(rec.plan, st))
      const tree = agentTreeLines(s, rec.agents, st)
      if (tree.length > 0) lines.push(st.bold('Agents:'), ...tree)
      if (rows.total === 0) lines.push(st.dim('No transcript yet.'))
      else {
        const shown = rows.lines.length
        lines.push(st.bold(shown < rows.total ? `Transcript (last ${shown} of ${rows.total}; --transcript shows all):` : 'Transcript:'))
        for (const l of rows.lines) lines.push(`  ${l}`)
      }
      return lines
    })
    return EXIT.ok
  } finally {
    src.close()
  }
}


// ---------- send / interrupt / stop ----------

/** The most a message read from stdin may hold (bytes). */
export const RUN_SEND_STDIN_MAX_BYTES = 1024 * 1024

export const NO_HOST_FOR_RUNS = 'No OrgAI host is running; only a running host can reach a live run.'

/** Replaceable for tests: read all of stdin, refusing more than `max` bytes. */
export const runsDeps = {
  readStdin: (max: number): Promise<string> => readProcessStdin(max)
}

async function readProcessStdin(max: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += b.length
    if (size > max) throw new CliError(`The message on stdin is longer than ${max >= 1024 * 1024 ? `${max / (1024 * 1024)} MB` : `${max} bytes`}.`, EXIT.usage)
    chunks.push(b)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** connect with ['read', 'operate']; never starts a host. */
async function connectOperate(ctx: CliContext): Promise<ReadSource> {
  const res = await ctx.connect(['read', 'operate'], { clientKind: 'cli', waitStartingMs: HOST_STARTING_WAIT_MS })
  if (!res.ok) {
    if (res.reason === 'no_host') throw new CliError(NO_HOST_FOR_RUNS, EXIT.failure)
    if (res.reason === 'auth_failed') throw new CliError(safeLine(res.message) || 'The OrgAI host refused the handshake.', EXIT.auth)
    if (res.reason === 'starting' || res.reason === 'draining') {
      throw new CliError(res.reason === 'starting' ? 'OrgAI is still starting; try again in a moment.' : 'OrgAI is shutting down.', EXIT.hostBusy)
    }
    throw new CliError(safeLine(res.message) || `Could not connect to the OrgAI host (${res.reason}).`, EXIT.failure)
  }
  // Reuse the read source's run lookups over this (read + operate) connection.
  warnVersionSkew(ctx, res.client)
  const client = res.client
  const runs = async (projectId: string): Promise<RunSummary[]> => {
    const list = await client.call<RunSummary[]>('runs:list', [projectId])
    return (Array.isArray(list) ? list : []).slice().sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
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
        .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
    },
    record: async (runId) => (await client.call<RunRecord | null>('runs:get', [runId], { timeoutMs: 60_000 })) ?? null,
    close: () => client.close()
  }
}

/** The chain's newest run for `ref`, refused (exit 1, its status word) unless it can take the action. */
async function liveTarget(ctx: CliContext, src: ReadSource, ref: string, action: 'send' | 'interrupt' | 'stop'): Promise<RunSummary> {
  const { runId, runs } = await resolveRunFromSource(ctx, src, ref)
  let list = runs
  if (!list.some((r) => r.id === runId)) {
    const rec = await src.record(runId).catch(() => null)
    if (rec) list = [...list, rec.summary]
  }
  const own = list.find((r) => r.id === runId)
  const projectRuns = own ? list.filter((r) => r.projectId === own.projectId) : list
  const chain = chainOf(projectRuns, runId)
  const newest = chain.length > 0 ? chain[chain.length - 1] : own
  if (!newest) throw new CliError(`Run ${safeLine(runId)} was not found.`, EXIT.failure)
  // stop also ends a paused run (it cancels the auto-resume); send and interrupt need an open session.
  const ok = isOpenStatus(newest.status) || (action === 'stop' && newest.status === 'paused')
  if (!ok) {
    const word = statusText(statusViewOf({ summary: newest }))
    throw new CliError(`Run ${safeLine(newest.id)} is not live (${word}).${action === 'send' ? ' Continue it with orgai resume.' : ''}`, EXIT.failure)
  }
  return newest
}

function hostRefusal(e: unknown): CliError {
  if (e instanceof CliError) return e
  const data = (e as Partial<HostCallError>)?.data
  const message = data?.message ?? (e instanceof Error ? e.message : String(e))
  return new CliError(safeLine(message) || 'The OrgAI host refused.', EXIT.failure)
}

async function runsSend(ctx: CliContext, args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, {})
  if (positionals.length < 1 || positionals.length > 2) throw new CliError('Use: orgai runs send <runId-or-R#> <text|->', EXIT.usage)
  const [ref, given] = positionals
  let text: string
  if (given === '-' || (given === undefined && !ctx.io.stdinIsTTY)) text = await runsDeps.readStdin(RUN_SEND_STDIN_MAX_BYTES)
  else if (given === undefined) throw new CliError('Give the message text, or - to read it from stdin.', EXIT.usage)
  else text = given
  if (Buffer.byteLength(text, 'utf8') > RUN_SEND_STDIN_MAX_BYTES) throw new CliError('The message is longer than 1 MB.', EXIT.usage)
  if (!text.trim()) throw new CliError('The message is empty.', EXIT.usage)
  const src = await connectOperate(ctx)
  try {
    const target = await liveTarget(ctx, src, ref, 'send')
    await src.client!.call('runs:send', [{ runId: target.id, text }], { timeoutMs: 60_000 }).catch((e: unknown) => {
      throw hostRefusal(e)
    })
    emit(ctx, { runId: target.id, action: 'send' }, () => `Sent to ${safeLine(runName(target))} (${safeLine(target.id)}).`)
    return EXIT.ok
  } finally {
    src.close()
  }
}

async function runsControl(ctx: CliContext, action: 'interrupt' | 'stop', args: string[]): Promise<number> {
  const { positionals } = parseFlags(args, {})
  if (positionals.length !== 1) throw new CliError(`Use: orgai runs ${action} <runId-or-R#>`, EXIT.usage)
  const src = await connectOperate(ctx)
  try {
    const target = await liveTarget(ctx, src, positionals[0], action)
    await src.client!.call(action === 'stop' ? 'runs:stop' : 'runs:interrupt', [target.id], { timeoutMs: 60_000 }).catch((e: unknown) => {
      throw hostRefusal(e)
    })
    emit(ctx, { runId: target.id, action }, () =>
      action === 'stop' ? `Ended the session of ${safeLine(runName(target))} (${safeLine(target.id)}).` : `Interrupted ${safeLine(runName(target))} (${safeLine(target.id)}).`
    )
    return EXIT.ok
  } finally {
    src.close()
  }
}
