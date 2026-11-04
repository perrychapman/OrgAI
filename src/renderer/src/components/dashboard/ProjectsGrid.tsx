import type { ReactElement } from 'react'
import { useEffect, useId, useMemo, useState } from 'react'
import type { Project, RunSummary } from '@shared/types'
import { isRunLive, useAppStore, type RunState } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { buildAttentionCtx, deleteProjectBody, projectAttentionOrder } from '../../lib/dashboard'
import { decisionCount } from '../../lib/needsYou'
import { projectStatus } from '../../lib/projectStatus'
import { runName } from '../../lib/runLabels'
import { isTeamSurfaceRun } from '../../lib/runSurface'
import { statusOfRun } from '../../lib/runStatus'
import { Input } from '../ui/Input'
import { useConfirm } from '../ui/ConfirmDialog'
import { ProjectTile, type TileModel } from './ProjectTile'
import { costInWindow, filterProjects, idAfterRemoval, mergeSummaries, SEARCH_AFTER } from './dashboardProjects'

/** The tile model of one project from its live runs and saved history. */
function tileModel(project: Project, runs: readonly RunState[], history: readonly RunSummary[], now: number): TileModel {
  const live = runs.filter(isRunLive)
  const summaries = mergeSummaries(
    runs.map((r) => r.summary),
    [history]
  )
  const newest = [...summaries].sort((a, b) => b.startedAt - a.startedAt)[0]
  const status = newest ? statusOfRun(runs.find((r) => r.summary.id === newest.id) ?? { summary: newest }, project, false) : undefined
  const decisions = decisionCount(runs)
  const st = projectStatus({ open: live.length, decisions, newest: newest && status ? { startedAt: newest.startedAt, status } : undefined, now })
  return {
    project,
    decisions,
    live: live.length,
    statusLine: st.subtitle || 'No runs yet',
    newestRun: newest ? runName(newest) : null,
    weekCost: costInWindow(summaries, now).cost
  }
}

/** Moves focus to the topbar heading (the page landmark) once the new view has rendered. */
function focusHeading(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const h = document.querySelector<HTMLElement>('main .topbar h1')
      if (!h) return
      h.tabIndex = -1
      h.focus({ preventScroll: true })
    })
  )
}

function focusLater(find: () => HTMLElement | null | undefined): void {
  requestAnimationFrame(() => requestAnimationFrame(() => find()?.focus()))
}

const tileSelector = (id: string): string => `[data-testid=project-tile][data-id="${CSS.escape(id)}"]`

/**
 * The Dashboard's project tiles, most urgent first (decisions, open runs, newest run, name). Opening, "Open folder" and
 * "Delete project…" live here; deletes and errors speak through `onAnnounce` (the page's one live region).
 */
export function ProjectsGrid({ onAnnounce }: { onAnnounce: (text: string) => void }): ReactElement {
  const headingId = useId()
  const projects = useAppStore((s) => s.projects)
  const runs = useAppStore((s) => s.runs)
  const history = useAppStore((s) => s.historyByProject)
  const openProject = useAppStore((s) => s.openProject)
  const setView = useAppStore((s) => s.setView)
  const removeProject = useAppStore((s) => s.removeProject)
  const { confirm, dialog } = useConfirm()
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [deleteError, setDeleteError] = useState<{ id: string; text: string } | null>(null)

  // "Last run 2h ago" and the 7-day window move on their own.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const ordered = useMemo(() => projectAttentionOrder(projects, buildAttentionCtx(Object.values(runs), history)), [projects, runs, history])
  const searching = projects.length > SEARCH_AFTER
  const shown = useMemo(() => (searching ? filterProjects(ordered, query) : ordered), [ordered, query, searching])
  const models = useMemo(() => {
    const byProject = new Map<string, RunState[]>()
    for (const r of Object.values(runs)) {
      if (isTeamSurfaceRun(r.summary)) continue
      const list = byProject.get(r.summary.projectId)
      if (list) list.push(r)
      else byProject.set(r.summary.projectId, [r])
    }
    return shown.map((p) => tileModel(p, byProject.get(p.id) ?? [], history[p.id] ?? [], now))
  }, [shown, runs, history, now])

  const open = (id: string): void => {
    void openProject(id)
    setView('run')
    focusHeading()
  }

  const remove = async (model: TileModel): Promise<void> => {
    const { project } = model
    const mine = Object.values(runs).filter((r) => r.summary.projectId === project.id && !isTeamSurfaceRun(r.summary))
    const openRuns = mine.filter((r) => isRunLive(r) || r.summary.status === 'paused').length
    const historyRuns = mergeSummaries(
      mine.map((r) => r.summary),
      [history[project.id] ?? []]
    ).length
    const ok = await confirm({
      title: `Delete "${project.name}"?`,
      body: deleteProjectBody({ openRuns, historyRuns }),
      confirmLabel: 'Delete project',
      danger: true
    })
    if (!ok) {
      focusLater(() => document.querySelector<HTMLElement>(`${tileSelector(project.id)} [data-testid=project-tile-more]`))
      return
    }
    const next = idAfterRemoval(
      shown.map((p) => p.id),
      project.id
    )
    try {
      await removeProject(project.id)
    } catch (err) {
      const text = cleanIpcError(err)
      setDeleteError({ id: project.id, text })
      onAnnounce(`Could not delete ${project.name}: ${text}`)
      focusLater(() => document.querySelector<HTMLElement>(`${tileSelector(project.id)} [data-testid=project-tile-more]`))
      return
    }
    setDeleteError(null)
    onAnnounce(`Deleted ${project.name}.`)
    focusLater(
      () =>
        (next ? document.querySelector<HTMLElement>(`${tileSelector(next)} [data-testid=project-tile-main]`) : null) ??
        document.querySelector<HTMLElement>('[data-testid=new-project]') ??
        document.querySelector<HTMLElement>('[data-testid=dash-start-choice] input:checked')
    )
  }

  return (
    <section className="dash-projects-region" data-testid="dash-projects" aria-labelledby={headingId}>
      <div className="dash-projects-head">
        <h2 id={headingId}>Projects</h2>
        <span className="dash-projects-count mono">{searching && query.trim() ? `${shown.length} of ${projects.length}` : projects.length}</span>
      </div>
      {searching && (
        <div className="dash-projects-search">
          <Input type="search" aria-label="Find a project" placeholder="Find a project" value={query} onChange={setQuery} data-testid="dash-project-search" />
        </div>
      )}
      {deleteError && (
        <p className="project-tile-error">
          Could not delete {projects.find((p) => p.id === deleteError.id)?.name ?? 'the project'}: {deleteError.text}
        </p>
      )}
      {models.length === 0 ? (
        <p className="dash-projects-none">{query.trim() ? `No project matches "${query.trim()}".` : 'No projects yet.'}</p>
      ) : (
        <ul className="dash-projects-grid" aria-labelledby={headingId}>
          {models.map((m) => (
            <ProjectTile key={m.project.id} model={m} onOpen={() => open(m.project.id)} onDelete={() => void remove(m)} onAnnounce={onAnnounce} />
          ))}
        </ul>
      )}
      {dialog}
    </section>
  )
}
