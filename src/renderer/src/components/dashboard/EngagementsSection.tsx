import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Activity, Briefcase, FolderOpen, Network, StickyNote, type LucideIcon } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { engagementOpenLabel, engagementProjects, engagementTiles, visibleEngagements, type EngagementFactKind, type EngagementLoaded } from '../../lib/engagementTiles'
import { projectHue } from '../../lib/projectIdentity'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { DashSection } from './DashboardContext'
import { ProjectBadge } from './ProjectBadge'
import { afterFirstPaint, createProjectQueue } from './projectQueue'
import { useAllSummaries, useNow } from './useDashboardData'

const FACT_ICON: Record<EngagementFactKind, LucideIcon> = { runs: Activity, folders: FolderOpen, notes: StickyNote, knowledge: Network }

/** Its own queue (same 3-at-a-time bound and 5 minute cache as the outputs loads) so these reads never share cache keys with Pick up's. */
const loadQueue = createProjectQueue()

/** After the topbar heading takes focus unless focus already went somewhere real. */
function settleFocus(): void {
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

/**
 * Engagements (docs/design/dashboard-overhaul.md "Visual pass"): the most recent engagements as compact tiles. Facts: runs
 * this week (summaries the Dashboard holds), reference folders (the project record), and notes and knowledge items, which
 * come from the reads the engagement pages already make (`engagement.listNotes`, `knowledge.get`), once after first
 * paint and only for the engagements shown; a failed read draws no fact.
 */
export function EngagementsSection(): ReactElement | null {
  const projects = useAppStore((s) => s.projects)
  const openProject = useAppStore((s) => s.openProject)
  const setView = useAppStore((s) => s.setView)
  const summaries = useAllSummaries()
  const now = useNow(60_000)
  const [loaded, setLoaded] = useState<Record<string, EngagementLoaded>>({})
  const [expanded, setExpanded] = useState(false)

  const all = useMemo(() => engagementTiles(projects, summaries, now, loaded), [projects, summaries, now, loaded])
  const { shown, hidden } = visibleEngagements(all, expanded)
  const shownIds = shown.map((t) => t.project.id).join('\n')

  useEffect(() => {
    const ids = shownIds ? shownIds.split('\n') : []
    if (ids.length === 0) return undefined
    let live = true
    const cancel = afterFirstPaint(() => {
      for (const id of ids) {
        void loadQueue
          .enqueue('outputs', id, async () => {
            const [notes, graph] = await Promise.allSettled([window.orgai.engagement.listNotes(id), window.orgai.knowledge.get(id)])
            const out: EngagementLoaded = {}
            if (notes.status === 'fulfilled' && Array.isArray(notes.value)) out.notes = notes.value.length
            if (graph.status === 'fulfilled' && graph.value && Array.isArray(graph.value.nodes)) out.knowledge = graph.value.nodes.length
            return out
          })
          .then((r) => {
            if (live && r) setLoaded((prev) => (prev[id]?.notes === r.notes && prev[id]?.knowledge === r.knowledge ? prev : { ...prev, [id]: r }))
          })
      }
    })
    return () => {
      live = false
      cancel()
    }
  }, [shownIds])

  const count = engagementProjects(projects).length
  const open = (id: string): void => {
    void openProject(id)
    setView('run')
    settleFocus()
  }

  return (
    <DashSection id="engagements" testId="dash-engagements" icon={Briefcase} count={count} empty={count === 0}>
      <ul className="dash-eng-grid">
        {shown.map((t) => (
          <li key={t.project.id} className="dash-eng" data-testid="dash-engagement" data-project={t.project.id} data-hue={projectHue(t.project.id)}>
            <ProjectBadge projectId={t.project.id} name={t.project.name} size="md" />
            <div className="dash-eng-body">
              <button
                type="button"
                className="dash-eng-open"
                data-testid="dash-engagement-open"
                aria-label={engagementOpenLabel(t.project.name, t.client)}
                title={t.project.name}
                onClick={() => open(t.project.id)}
              >
                <span className="dash-eng-name">{t.project.name}</span>
              </button>
              <p className="dash-eng-meta">
                {t.client && (
                  <span className="dash-eng-client" title={t.client}>
                    {t.client}
                  </span>
                )}
                <span className="dash-eng-when">{t.activity}</span>
              </p>
              <ul className="dash-eng-facts" aria-label="Facts">
                {t.facts.map((f) => (
                  <li key={f.kind} className="dash-eng-fact" data-testid="dash-engagement-fact" data-fact={f.kind} title={f.label}>
                    <Icon icon={FACT_ICON[f.kind]} size="sm" />
                    <span aria-hidden="true">{f.text}</span>
                    <span className="sr-only">{f.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded((e) => !e)} testId="dash-engagements-more">
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </Button>
      )}
    </DashSection>
  )
}
