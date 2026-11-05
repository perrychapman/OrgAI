/**
 * `orgai status [--all-projects]` (cli-spec 6.1, 3.2(3)): the host, the current project, live runs with what needs
 * you, and the newest run per project in scope. Hostless it shows the saved data (and says so). Exit 0; exit 2 only
 * for a bad --project.
 */
import { projectConnection } from '../../shared/defaults'
import type { HostStatusResult, PendingCards, Project, RunSummary } from '../../shared/types'
import { formatDate } from '../../shared/view/dates'
import { runIndexMap, runName, runTag } from '../../shared/view/runLabels'
import { parseFlags } from '../flags'
import { emit, plural, relativeTime, safeLine, shortDuration, styleFor, styleStatus, type Json } from '../output'
import { costText, kindLabel, pendingItems, statusWordOf } from '../render'
import { checkProjectResolution, openReadSource } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

const ACTIVITY_WORDS: Record<string, [string, string]> = {
  liveRuns: ['live run', 'live runs'],
  pausedAutoResumes: ['paused run waiting to resume', 'paused runs waiting to resume'],
  inFlightRpcMutations: ['change in progress', 'changes in progress'],
  activeWorktreeOps: ['worktree operation', 'worktree operations'],
  backgroundTasks: ['background task', 'background tasks'],
  activeOAuthFlows: ['sign-in in progress', 'sign-ins in progress'],
  interactiveClients: ['attached terminal', 'attached terminals']
}

/** "1 live run, 2 attached terminals" from lease counts; '' when idle. */
export function activityText(counts: Partial<Record<string, number>>): string {
  return Object.entries(counts)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([k, n]) => {
      const w = ACTIVITY_WORDS[k] ?? [k, k]
      return `${n} ${n === 1 ? w[0] : w[1]}`
    })
    .join(', ')
}

interface LiveRow {
  summary: RunSummary
  cards?: PendingCards
  tag: string
  projectName: string
}

export const runStatus: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { 'all-projects': { type: 'boolean' } })
  if (positionals.length > 0) throw new CliError(`Unexpected argument "${positionals[0]}".`, EXIT.usage)
  const all = !!values['all-projects']
  const src = await openReadSource(ctx)
  try {
    const projects = await src.projects()
    const resolution = ctx.resolveProject(projects)
    checkProjectResolution(resolution)
    const project = resolution.project
    const scope: Project[] = all || !project ? projects : [project]

    let host: HostStatusResult | undefined
    if (src.live && src.client) host = await src.client.call<HostStatusResult>('host.status', []).catch(() => undefined)

    const runsByProject = new Map<string, RunSummary[]>()
    for (const p of scope) runsByProject.set(p.id, await src.runs(p.id).catch(() => []))
    const projectRuns = async (id: string): Promise<RunSummary[]> => {
      if (!runsByProject.has(id)) runsByProject.set(id, await src.runs(id).catch(() => []))
      return runsByProject.get(id)!
    }
    const nameOf = (id: string): string => projects.find((p) => p.id === id)?.name ?? id

    // Live runs and their decisions: only a live host knows the cards.
    const live: LiveRow[] = []
    if (src.live && src.client) {
      const listed = await src.client.call<RunSummary[]>('runs:listLive', []).catch(() => [] as RunSummary[])
      const inScope = (Array.isArray(listed) ? listed : []).filter((r) => all || !project || r.projectId === project.id)
      for (const r of inScope) {
        const cards = await src.client.call<PendingCards>('runs:pendingCards', [r.id]).catch(() => undefined)
        const idx = runIndexMap(await projectRuns(r.projectId))
        live.push({ summary: r, cards, tag: runTag(idx.get(r.id)), projectName: nameOf(r.projectId) })
      }
    }
    const needsYou = src.live ? live.reduce((n, r) => n + pendingItems(r.summary, r.cards).length, 0) : null

    const latest = scope
      .map((p) => {
        const runs = runsByProject.get(p.id) ?? []
        const newest = runs[0]
        if (!newest) return undefined
        return { project: p, run: newest, tag: runTag(runIndexMap(runs).get(newest.id)) }
      })
      .filter((x): x is { project: Project; run: RunSummary; tag: string } => !!x)

    const daemon = src.snapshot?.daemon
    const hostJson: Json = host
      ? { ...host, uptimeMs: Math.max(0, Date.now() - host.startedAt) }
      : {
          state: src.hostState,
          hostKind: daemon?.hostKind ?? null,
          appVersion: daemon?.appVersion ?? null,
          pid: daemon?.pid ?? null,
          startedAt: daemon?.startedAt ?? null,
          uptimeMs: daemon && src.hostState !== 'stopped' ? Math.max(0, Date.now() - daemon.startedAt) : null,
          dataDir: ctx.paths.dataDir,
          mock: ctx.env.ORGAI_MOCK === '1',
          activity: null
        }
    const value: Json = {
      hostState: src.live ? (host?.state ?? 'ready') : src.hostState,
      liveInboxAvailable: src.liveInboxAvailable,
      ...(src.hostless ? { hostUnavailable: src.hostless } : {}),
      host: hostJson,
      project: project
        ? { id: project.id, name: project.name, kind: project.kind ?? 'code', path: project.path, connection: projectConnection(project), via: resolution.via }
        : null,
      ...(resolution.managedWorktree ? { managedWorktree: resolution.managedWorktree } : {}),
      liveRuns: live.map((r) => ({ ...r.summary, tag: r.tag, needsYou: pendingItems(r.summary, r.cards).length })),
      needsYou,
      latestRuns: latest.map((l) => ({ projectId: l.project.id, projectName: l.project.name, tag: l.tag, run: l.run }))
    }

    emit(ctx, value, () => {
      const st = styleFor(ctx)
      const now = Date.now()
      const lines: string[] = []
      if (host) {
        const act = activityText(host.activity.counts)
        lines.push(
          `${st.bold('Host:')} ${host.state} (${host.hostKind}) · OrgAI ${safeLine(host.appVersion)} · pid ${host.pid} · up ${shortDuration(now - host.startedAt)}${host.mock ? ' · mock' : ''}`
        )
        lines.push(`  ${st.dim('Data folder:')} ${safeLine(host.dataDir)}`)
        lines.push(`  ${st.dim('Activity:')} ${act || 'idle'}`)
      } else {
        const word = src.hostState === 'stopped' ? 'not running' : src.hostState
        const facts = daemon && src.hostState !== 'stopped' ? ` (${[daemon.hostKind, daemon.appVersion ? `OrgAI ${safeLine(daemon.appVersion)}` : '', `pid ${daemon.pid}`].filter(Boolean).join(' · ')})` : ''
        lines.push(`${st.bold('Host:')} ${word}${facts}${ctx.env.ORGAI_MOCK === '1' ? ' · mock' : ''}`)
        lines.push(`  ${st.dim('Data folder:')} ${safeLine(ctx.paths.dataDir)}`)
      }
      if (project) {
        lines.push(`${st.bold('Project:')} ${safeLine(project.name)} ${st.dim(`(${project.kind ?? 'code'}, ${projectConnection(project)})`)}`)
        lines.push(`  ${st.dim('Folder:')} ${safeLine(project.path)}`)
        if (resolution.managedWorktree) lines.push(`  ${st.yellow('Inside an agent worktree;')} its project is ${safeLine(resolution.managedWorktree.mainCheckout)}`)
      } else if (!all) {
        lines.push(`${st.bold('Project:')} ${st.dim('none here (run inside a project folder or pass --project)')}`)
      }
      if (src.live) {
        lines.push(`${st.bold('Live runs:')} ${live.length === 0 ? st.dim('none') : ''}`.trimEnd())
        for (const r of live) {
          const waiting = pendingItems(r.summary, r.cards).length
          const word = statusWordOf({ summary: r.summary }, waiting > 0)
          const where = all || !project ? `${safeLine(r.projectName)} ` : ''
          lines.push(`  ${where}${r.tag}  ${styleStatus(st, word)}  ${safeLine(runName(r.summary))}${waiting ? st.yellow(` · ${plural(waiting, 'decision')}`) : ''}`)
        }
        lines.push(`${st.bold('Needs you:')} ${needsYou ? st.yellow(plural(needsYou, 'decision')) : 'nothing'}`)
      }
      if (latest.length > 0) {
        lines.push(st.bold(scope.length > 1 ? 'Latest run per project:' : 'Latest run:'))
        for (const l of latest) {
          const word = statusWordOf({ summary: l.run })
          const where = scope.length > 1 ? `${safeLine(l.project.name)}  ` : ''
          lines.push(
            `  ${where}${l.tag}  ${styleStatus(st, word)}  ${safeLine(runName(l.run))} ${st.dim(`· ${kindLabel(l.run)} · ${relativeTime(l.run.startedAt, now, formatDate)} · ${costText(l.run)}`)}`
          )
        }
      }
      return lines
    })
    return EXIT.ok
  } finally {
    src.close()
  }
}
