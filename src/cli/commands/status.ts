/**
 * `orgai status [--all-projects]` (cli-spec 6.1; cli-standalone-default.md 4.3): the data folder, the orgai sessions
 * running on it (each with its folder, what it runs and the projects it has open), the current project and the newest run
 * per project in scope, read from the files (never a host). Exit 0; exit 2 only for a bad --project.
 */
import { projectConnection } from '../../shared/defaults'
import type { Project, RunSummary } from '../../shared/types'
import { formatDate } from '../../shared/view/dates'
import { runIndexMap, runName, runTag } from '../../shared/view/runLabels'
import { parseFlags } from '../flags'
import { emit, relativeTime, safeLine, shortDuration, styleFor, styleStatus, type Json } from '../output'
import { costText, kindLabel, statusWordOf } from '../render'
import { checkProjectResolution, openReadSource } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

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

    const runsByProject = new Map<string, RunSummary[]>()
    for (const p of scope) runsByProject.set(p.id, await src.runs(p.id).catch(() => []))

    const latest = scope
      .map((p) => {
        const runs = runsByProject.get(p.id) ?? []
        const newest = runs[0]
        if (!newest) return undefined
        return { project: p, run: newest, tag: runTag(runIndexMap(runs).get(newest.id)) }
      })
      .filter((x): x is { project: Project; run: RunSummary; tag: string } => !!x)

    const daemon = src.snapshot.daemon
    const hostJson: Json = {
      state: src.hostState,
      appVersion: daemon?.appVersion ?? null,
      pid: daemon?.pid ?? null,
      ownerCwd: daemon?.ownerCwd ?? null,
      startedAt: daemon?.startedAt ?? null,
      uptimeMs: daemon && src.hostState !== 'stopped' ? Math.max(0, Date.now() - daemon.startedAt) : null,
      dataDir: ctx.paths.dataDir,
      mock: ctx.env.ORGAI_MOCK === '1'
    }
    const sessions = src.snapshot.sessions
    const projectName = new Map(projects.map((p) => [p.id, p.name]))
    const value: Json = {
      hostState: src.hostState,
      liveInboxAvailable: false,
      host: hostJson,
      // Every orgai running on this data folder, oldest first (`host` above is the one daemon.json advertises).
      sessions: sessions.map((s) => ({ pid: s.pid, hostInstanceId: s.hostInstanceId, command: s.command, cwd: s.cwd, appVersion: s.appVersion, startedAt: s.startedAt, projects: s.projects })),
      project: project
        ? { id: project.id, name: project.name, kind: project.kind ?? 'code', path: project.path, connection: projectConnection(project), via: resolution.via }
        : null,
      ...(resolution.managedWorktree ? { managedWorktree: resolution.managedWorktree } : {}),
      latestRuns: latest.map((l) => ({ projectId: l.project.id, projectName: l.project.name, tag: l.tag, run: l.run }))
    }

    emit(ctx, value, () => {
      const st = styleFor(ctx)
      const now = Date.now()
      const lines: string[] = []
      {
        const mock = ctx.env.ORGAI_MOCK === '1' ? ' · mock' : ''
        if (sessions.length > 0) {
          // One line per running orgai: what it runs, where, its pid and age, and the projects it has open.
          lines.push(`${st.bold('orgai sessions running:')} ${sessions.length}${mock}`)
          for (const s of sessions) {
            const held = s.projects.map((id) => projectName.get(id) ?? id).map((n) => safeLine(n))
            const facts = [s.cwd ? safeLine(s.cwd) : '', `pid ${s.pid}`, `up ${shortDuration(now - s.startedAt)}`, held.length ? `in ${held.join(', ')}` : ''].filter(Boolean)
            lines.push(`  ${safeLine(s.command || 'orgai')}  ${st.dim(facts.join(' · '))}`)
          }
        } else {
          // None, or an orgai from before sessions, which owns the folder alone (daemon.json is all there is to say).
          const word = src.hostState === 'stopped' ? 'no' : 'yes'
          const facts = daemon && src.hostState !== 'stopped' ? ` (${[daemon.ownerCwd ? safeLine(daemon.ownerCwd) : '', daemon.appVersion ? `orgai ${safeLine(daemon.appVersion)}` : '', `pid ${daemon.pid}`, `up ${shortDuration(now - daemon.startedAt)}`].filter(Boolean).join(' · ')})` : ''
          lines.push(`${st.bold('Another orgai running:')} ${word}${facts}${mock}`)
        }
        lines.push(`  ${st.dim('Data folder:')} ${safeLine(ctx.paths.dataDir)}`)
      }
      if (project) {
        lines.push(`${st.bold('Project:')} ${safeLine(project.name)} ${st.dim(`(${project.kind ?? 'code'}, ${projectConnection(project)})`)}`)
        lines.push(`  ${st.dim('Folder:')} ${safeLine(project.path)}`)
        if (resolution.managedWorktree) lines.push(`  ${st.yellow('Inside an agent worktree;')} its project is ${safeLine(resolution.managedWorktree.mainCheckout)}`)
      } else if (!all) {
        lines.push(`${st.bold('Project:')} ${st.dim('none here (run inside a project folder or pass --project)')}`)
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
