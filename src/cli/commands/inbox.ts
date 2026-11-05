/**
 * `orgai inbox [--all-projects]` (cli-spec 6.1): every open decision card ("Needs you") of the live runs in scope
 * (the cwd project unless --all-projects; every project when the folder is not one). Cards live only in a host's
 * memory, so without a live host there is nothing to list: "No live decisions: the OrgAI host is not running."
 */
import { VIRTUAL_PROJECT_LABELS, isVirtualProjectId, type PendingCards, type Project, type RunSummary } from '../../shared/types'
import { formatDate } from '../../shared/view/dates'
import { runIndexMap, runName, runTag } from '../../shared/view/runLabels'
import { parseFlags } from '../flags'
import { emit, relativeTime, safeLine, styleFor, table, termWidth, type Json } from '../output'
import { cardCreatedAt, pendingItems } from '../render'
import { checkProjectResolution, openReadSource } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

export const NO_LIVE_DECISIONS = 'No live decisions: the OrgAI host is not running.'
export const DECIDE_LATER = 'Answer them with `orgai decide <requestId> <action>` or in the OrgAI app.'

export const runInbox: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { 'all-projects': { type: 'boolean' } })
  if (positionals.length > 0) throw new CliError(`Unexpected argument "${positionals[0]}".`, EXIT.usage)
  const all = !!values['all-projects']
  const src = await openReadSource(ctx, { quiet: true })
  try {
    if (!src.live || !src.client) {
      emit(ctx, { hostState: src.hostState, liveInboxAvailable: false, ...(src.hostless ? { hostUnavailable: src.hostless } : {}), items: [] }, () => {
        const lines = [NO_LIVE_DECISIONS]
        if (src.hostless?.reason === 'disabled' && src.hostless.message) lines.push(safeLine(src.hostless.message))
        return lines
      })
      return EXIT.ok
    }
    const client = src.client
    const projects = await src.projects()
    const resolution = ctx.resolveProject(projects)
    checkProjectResolution(resolution)
    const project = all ? undefined : resolution.project
    const listed = await client.call<RunSummary[]>('runs:listLive', [])
    const live = (Array.isArray(listed) ? listed : []).filter((r) => !project || r.projectId === project.id)
    const nameOf = (id: string): string => (isVirtualProjectId(id) ? VIRTUAL_PROJECT_LABELS[id] : (projects.find((p: Project) => p.id === id)?.name ?? id))
    const indexes = new Map<string, Map<string, number>>()
    const items: { kind: string; label: string; requestId: string; runId: string; runTag: string; runName: string; projectId: string; projectName: string; createdAt?: number }[] = []
    for (const r of live) {
      const cards = await client.call<PendingCards>('runs:pendingCards', [r.id]).catch(() => undefined)
      const rows = pendingItems(r, cards)
      if (rows.length === 0) continue
      if (!indexes.has(r.projectId)) indexes.set(r.projectId, runIndexMap(await src.runs(r.projectId).catch(() => [])))
      const tag = runTag(indexes.get(r.projectId)!.get(r.id))
      for (const w of rows) {
        const createdAt = cardCreatedAt(cards, w.key)
        items.push({ kind: w.kind, label: w.label, requestId: w.key, runId: r.id, runTag: tag, runName: runName(r), projectId: r.projectId, projectName: nameOf(r.projectId), ...(createdAt ? { createdAt } : {}) })
      }
    }
    const value: Json = { hostState: 'ready', liveInboxAvailable: true, project: project ? { id: project.id, name: project.name } : null, items }
    emit(ctx, value, () => {
      const st = styleFor(ctx)
      if (items.length === 0) return [project ? `Nothing needs you in ${safeLine(project.name)}.` : 'Nothing needs you.']
      const now = Date.now()
      const lines = table(
        [
          { header: 'NEEDS YOU', flex: true, min: 12, style: (c: string) => st.yellow(c) },
          { header: 'WHERE', min: 6, ellipsis: 'middle' },
          { header: 'REQUEST', min: 8 },
          { header: 'AGE', min: 3 }
        ],
        items.map((i) => [safeLine(i.label), `${safeLine(i.projectName)} ${i.runTag}`, safeLine(i.requestId), i.createdAt ? relativeTime(i.createdAt, now, formatDate) : '']),
        termWidth(ctx),
        st
      )
      lines.push(st.dim(DECIDE_LATER))
      return lines
    })
    return EXIT.ok
  } finally {
    src.close()
  }
}
