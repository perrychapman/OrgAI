/**
 * `orgai runs list [--all-projects] [--limit N] [--status <word>]` and `orgai runs show <runId|R#> [--transcript]
 * [--tail N]` (cli-spec 6.1, 3.2(3)). Live host first, else the saved data. Status words come from statusText only.
 */
import { VIRTUAL_PROJECT_LABELS, isVirtualProjectId, type PendingCards, type Project, type RunSummary } from '../../shared/types'
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
import { checkProjectResolution, openReadSource, resolveRunFromSource, searchableProjectIds, type ReadSource } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

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
  throw new CliError(sub ? `Unknown runs command "${sub}". Use: orgai runs list | runs show <runId-or-R#>` : 'Use: orgai runs list | runs show <runId-or-R#>', EXIT.usage)
}

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

