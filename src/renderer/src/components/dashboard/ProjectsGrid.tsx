import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { FolderKanban } from 'lucide-react'
import type { Project, RunSummary } from '@shared/types'
import { isRunLive, useAppStore, type RunState } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { projectKindOf } from '@shared/defaults'
import { hasFolderTrustField } from '../../lib/folderTrust'
import { openProjectSettings } from '../../lib/openProjectSettings'
import { PROJECT_SETTINGS_SECTIONS } from '../../lib/settingsTarget'
import { canContinue } from '../../lib/runChains'
import { openFolderTrustReview } from '../FolderTrustNotice'
import { projectQueue } from './projectQueue'
import { useProjectSignals, type ProjectSignal } from './useProjectSignals'
import { buildAttentionCtx, deleteProjectBody, removeConfirmLabel } from '../../lib/dashboard'
import { useForgetEngagement } from './useForgetEngagement'
import { combinedDecisionCount, teamDecisionsFor } from '../../lib/needsYou'
import { useTeamAttentionItems } from '../../lib/menuActions'
import type { TeamAttentionItem } from '../../lib/teamFiles'
import { displayRunName } from '../../lib/orgChange'
import { useArrival } from '../../lib/useArrival'
import { PIN_LIMIT } from '../../lib/dashboardLayout'
import { Input } from '../ui/Input'
import { useConfirm } from '../ui/ConfirmDialog'
import { DashSection, sectionHeadingId, useDashboard } from './DashboardContext'
import { ProjectTile, type PinSource, type TileModel } from './ProjectTile'
import { costInWindow, filterProjects, idAfterRemoval, mergeSummaries, newestSummary, pinnedFirst, SEARCH_AFTER, tileChips, tileStatusKind, tileStatusLine, tileTeam, type TileChipKind } from './dashboardProjects'
import { projectSpark } from '../../lib/projectSparkline'

/** The tile model of one project from its live runs and saved history. */
function tileModel(project: Project, runs: readonly RunState[], history: readonly RunSummary[], now: number, teamItems: readonly TeamAttentionItem[], signal: ProjectSignal | undefined, pinned: boolean): TileModel {
  const live = runs.filter(isRunLive)
  // Live copies first: a live run wins over its saved record.
  const summaries = mergeSummaries(
    runs.map((r) => r.summary),
    [history]
  )
  const newest = newestSummary(summaries)
  const newestRun = newest ? runs.find((r) => r.summary.id === newest.id) : undefined
  const decisions = combinedDecisionCount(runs, teamDecisionsFor(teamItems, project.id))
  const isLive = !!newestRun && isRunLive(newestRun)
  const team = tileTeam(project.roles)
  const continuable = newest && !isLive && canContinue(summaries, newest.id) ? { id: newest.id, name: displayRunName(newest) } : null
  const working = runs.some((r) => r.summary.status === 'running' || r.summary.status === 'starting')
  return {
    project,
    decisions,
    live: live.length,
    working,
    statusLine: tileStatusLine({ open: live.length, decisions, working, newestStartedAt: newest?.startedAt, now }),
    statusKind: tileStatusKind({ open: live.length, decisions, working, newestStartedAt: newest?.startedAt }),
    spark: projectSpark(summaries, now),
    team,
    pinned,
    continuable,
    chips: tileChips({
      projectName: project.name,
      code: projectKindOf(project) === 'code',
      branches: signal?.branches ?? 0,
      suggestions: signal?.suggestions ?? 0,
      untrusted: hasFolderTrustField(project) && project.folderConfigTrust?.state === 'untrusted'
    }),
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

/** After a menu or chip opened another view: the topbar heading takes focus unless something real (a composer) already has it. */
function focusHeadingIfIdle(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active && active !== document.body && !active.closest('[data-testid=dashboard]')) return
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
  const projects = useAppStore((s) => s.projects)
  const runs = useAppStore((s) => s.runs)
  const history = useAppStore((s) => s.historyByProject)
  const openProject = useAppStore((s) => s.openProject)
  const setView = useAppStore((s) => s.setView)
  const selectProject = useAppStore((s) => s.selectProject)
  const openDraft = useAppStore((s) => s.openDraft)
  const focusComposer = useAppStore((s) => s.focusComposer)
  const continueFromHistory = useAppStore((s) => s.continueFromHistory)
  const removeProject = useAppStore((s) => s.removeProject)
  const { confirm, dialog } = useConfirm()
  const { forget, dialog: forgetDialog } = useForgetEngagement()
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [deleteError, setDeleteError] = useState<{ id: string; text: string } | null>(null)

  // "Last run 2h ago" and the 7-day window move on their own.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const teamItems = useTeamAttentionItems()
  const { layout, customising, togglePin, arriving, still } = useDashboard()
  const pinned = layout.pinned
  const [rings, setRings] = useState<Record<string, number>>({})
  const ordered = useMemo(() => pinnedFirst(projects, pinned, buildAttentionCtx(Object.values(runs), history, teamItems)), [projects, pinned, runs, history, teamItems])
  const pinnedIds = useMemo(() => new Set(projects.filter((p) => pinned.includes(p.id)).map((p) => p.id)), [projects, pinned])
  const pinFull = pinnedIds.size >= PIN_LIMIT
  const searching = projects.length > SEARCH_AFTER
  const filtering = searching && query.trim() !== ''
  // A tile created or cloned while the page is open rises in; first paint and search filtering never animate.
  const tileArrived = useArrival(
    projects.map((p) => p.id),
    '',
    { maxPerBatch: 3 }
  )
  const shown = useMemo(() => (searching ? filterProjects(ordered, query) : ordered), [ordered, query, searching])
  // Branch counts and team suggestions for the chips: after first paint, three calls at a time, once per session.
  const signals = useProjectSignals(ordered)
  const models = useMemo(() => {
    const byProject = new Map<string, RunState[]>()
    for (const r of Object.values(runs)) {
      const list = byProject.get(r.summary.projectId)
      if (list) list.push(r)
      else byProject.set(r.summary.projectId, [r])
    }
    return shown.map((p) => tileModel(p, byProject.get(p.id) ?? [], history[p.id] ?? [], now, teamItems, signals[p.id], pinnedIds.has(p.id)))
  }, [shown, runs, history, now, teamItems, signals, pinnedIds])

  // Pin or unpin: the tile moves, focus is re-found on the same control of the same tile, and a pin plays one ring there.
  const pin = (m: TileModel, source: PinSource): void => {
    const wasPinned = m.pinned
    if (!togglePin(m.project.id, m.project.name)) return
    if (!wasPinned) setRings((r) => ({ ...r, [m.project.id]: (r[m.project.id] ?? 0) + 1 }))
    const control = source === 'button' ? 'project-tile-pin' : 'project-tile-more'
    focusLater(() => document.querySelector<HTMLElement>(`${tileSelector(m.project.id)} [data-testid=${control}]`))
  }

  const open = (id: string): void => {
    void openProject(id)
    setView('run')
    focusHeading()
  }

  const newRun = (id: string): void => {
    selectProject(id)
    openDraft()
    focusComposer()
    focusHeadingIfIdle()
  }

  const continueRun = (id: string, runId: string): void => {
    void continueFromHistory(runId, id).then(focusHeadingIfIdle)
  }

  const chip = (id: string, kind: TileChipKind): void => {
    if (kind === 'branches') openProjectSettings(id, PROJECT_SETTINGS_SECTIONS.maintenance)
    else if (kind === 'suggestions') {
      selectProject(id)
      setView('team')
      focusHeadingIfIdle()
    } else openFolderTrustReview(id)
  }

  const remove = async (model: TileModel): Promise<void> => {
    const { project } = model
    const mine = Object.values(runs).filter((r) => r.summary.projectId === project.id)
    const openRuns = mine.filter((r) => isRunLive(r) || r.summary.status === 'paused').length
    const historyRuns = mergeSummaries(
      mine.map((r) => r.summary),
      [history[project.id] ?? []]
    ).length
    const engagement = projectKindOf(project) === 'engagement'
    const next = idAfterRemoval(
      shown.map((p) => p.id),
      project.id
    )
    const backToMenu = (): void => focusLater(() => document.querySelector<HTMLElement>(`${tileSelector(project.id)} [data-testid=project-tile-more]`))
    let done: string
    if (engagement) {
      const out = await forget(project, openRuns)
      if (out.status === 'cancelled') return backToMenu()
      if (out.status === 'error') {
        setDeleteError({ id: project.id, text: out.message })
        onAnnounce(`Could not forget ${project.name}: ${out.message}`)
        return backToMenu()
      }
      done = out.notice
    } else {
      const ok = await confirm({
        title: `Delete "${project.name}"?`,
        body: deleteProjectBody({ openRuns, historyRuns }),
        confirmLabel: removeConfirmLabel('code'),
        danger: true
      })
      if (!ok) return backToMenu()
      try {
        await removeProject(project.id)
      } catch (err) {
        const text = cleanIpcError(err)
        setDeleteError({ id: project.id, text })
        onAnnounce(`Could not delete ${project.name}: ${text}`)
        return backToMenu()
      }
      done = `Deleted ${project.name}.`
    }
    projectQueue.forget(project.id)
    setDeleteError(null)
    onAnnounce(done)
    focusLater(
      () =>
        (next ? document.querySelector<HTMLElement>(`${tileSelector(next)} [data-testid=project-tile-main]`) : null) ??
        document.querySelector<HTMLElement>('[data-testid=new-project]') ??
        document.querySelector<HTMLElement>('[data-testid=dash-start-choice] input:checked')
    )
  }

  return (
    <DashSection
      id="projects"
      testId="dash-projects"
      className="dash-projects-region"
      icon={FolderKanban}
      empty={projects.length === 0}
      count={filtering ? undefined : projects.length}
      headExtra={filtering ? <span className="dash-projects-count mono">{`${shown.length} of ${projects.length}`}</span> : undefined}
    >
      {searching && (
        <div className="dash-projects-search">
          <Input type="search" aria-label="Find a project" placeholder="Find a project" value={query} onChange={setQuery} data-testid="dash-project-search" />
        </div>
      )}
      {deleteError && (
        <p className="project-tile-error">
          Could not {(() => { const p = projects.find((q) => q.id === deleteError.id); return p && projectKindOf(p) === 'engagement' ? 'forget' : 'delete' })()} {projects.find((p) => p.id === deleteError.id)?.name ?? 'the project'}: {deleteError.text}
        </p>
      )}
      {models.length === 0 ? (
        <p className="dash-projects-none">{query.trim() ? `No project matches "${query.trim()}".` : 'No projects yet.'}</p>
      ) : (
        <div className="dash-projects-fit">
        <ul className="dash-projects-grid" aria-labelledby={sectionHeadingId('projects')}>
          {models.map((m, i) => (
            <ProjectTile
              key={m.project.id}
              // Tiles rise only while the page arrives (max six stagger steps in the CSS) or when a project is created.
              enter={tileArrived(m.project.id) || (arriving && !still)}
              index={i}
              customising={customising}
              pinFull={pinFull}
              ring={rings[m.project.id] ?? 0}
              onTogglePin={(source) => pin(m, source)}
              model={m}
              onOpen={() => open(m.project.id)}
              onDelete={() => void remove(m)}
              onNewRun={() => newRun(m.project.id)}
              onContinue={(runId) => continueRun(m.project.id, runId)}
              onChip={(kind) => chip(m.project.id, kind)}
              onAnnounce={onAnnounce}
            />
          ))}
        </ul>
        </div>
      )}
      {dialog}
      {forgetDialog}
    </DashSection>
  )
}
