import { useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type { SeriesHighlightProps, UsagePanelProps } from './panelProps'
import ProjectsPanel from './ProjectsPanel'
import ModelsPanel from './ModelsPanel'
import RolesPanel from './RolesPanel'
import ConnectionsPanel from './ConnectionsPanel'
import '../../styles/usage-breakdown.css'

type Tab = 'project' | 'model' | 'role' | 'connection'
const TABS: { id: Tab; label: string }[] = [
  { id: 'project', label: 'Project' },
  { id: 'model', label: 'Model' },
  { id: 'role', label: 'Role' },
  { id: 'connection', label: 'Connection' }
]

/** "Where it went": one card, one breakdown at a time (docs/design/usage-dashboard-options.md option D). */
export default function BreakdownCard(props: UsagePanelProps & SeriesHighlightProps): ReactElement {
  const { highlight, onHighlight, ...panel } = props
  const [tab, setTab] = useState<Tab>('project')
  const refs = useRef(new Map<Tab, HTMLButtonElement>())

  const move = (i: number): void => {
    const next = TABS[(i + TABS.length) % TABS.length]
    setTab(next.id)
    refs.current.get(next.id)?.focus()
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.key === 'ArrowRight') move(i + 1)
    else if (e.key === 'ArrowLeft') move(i - 1)
    else if (e.key === 'Home') move(0)
    else if (e.key === 'End') move(TABS.length - 1)
    else return
    e.preventDefault()
  }
  // Leaving the project tab ends any highlight the pointer or focus left behind.
  const select = (t: Tab): void => {
    if (t !== 'project') onHighlight(null)
    setTab(t)
  }

  return (
    <section className="usage-panel usage-where-card" aria-labelledby="usage-where-h" data-testid="usage-where">
      <div className="usage-panel-head">
        <h2 id="usage-where-h" tabIndex={-1}>
          Where it went
        </h2>
        {/* Ranked by cost whatever the chart shows (owner review: say it rather than follow the chart's metric). */}
        <p className="usage-panel-summary usage-where-basis" data-testid="usage-where-basis">
          Ranked by estimated cost, for the whole period.
        </p>
      </div>
      <div className="usage-where-tabs" role="tablist" aria-label="Break down by">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`usage-where-tab-${t.id}`}
            aria-controls="usage-where-panel"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            className="usage-where-tab"
            data-testid="usage-where-tab"
            data-tab={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el)
              else refs.current.delete(t.id)
            }}
            onClick={() => select(t.id)}
            onKeyDown={(e) => {
              onKey(e, i)
              if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) onHighlight(null)
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="usage-where-body" role="tabpanel" id="usage-where-panel" aria-labelledby={`usage-where-tab-${tab}`}>
        {tab === 'project' && <ProjectsPanel {...panel} embedded highlight={highlight} onHighlight={onHighlight} />}
        {tab === 'model' && <ModelsPanel {...panel} embedded />}
        {tab === 'role' && <RolesPanel {...panel} embedded />}
        {tab === 'connection' && <ConnectionsPanel {...panel} embedded />}
      </div>
    </section>
  )
}
