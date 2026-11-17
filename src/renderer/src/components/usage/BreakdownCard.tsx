import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react'
import type { SeriesHighlightProps, UsagePanelProps } from './panelProps'
import { RankEnterContext } from './RankedBars'
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
  const listRef = useRef<HTMLDivElement>(null)

  // Entry motion (body fade, rows rise, bars draw) only for a tab the user just chose, never first paint or a refresh.
  const [enter, setEnter] = useState(false)
  const enterTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(enterTimer.current), [])
  const choose = (t: Tab): void => {
    if (t === tab) return
    setTab(t)
    setEnter(true)
    window.clearTimeout(enterTimer.current)
    enterTimer.current = window.setTimeout(() => setEnter(false), 700)
  }

  // One 2 px indicator slides under the selected tab (transform only; plan M1). Measured before paint and on resize;
  // data-ready turns the transition on after the first measure and a resize snaps instead of gliding.
  const [bar, setBar] = useState<{ x: number; w: number } | null>(null)
  const [ready, setReady] = useState(false)
  const measure = (): void => {
    const el = refs.current.get(tab)
    if (!el || el.offsetWidth === 0) {
      setBar((b) => (b === null ? b : null))
      return
    }
    const x = el.offsetLeft
    const w = el.offsetWidth
    setBar((b) => (b && b.x === x && b.w === w ? b : { x, w }))
  }
  useLayoutEffect(measure, [tab])
  const measureRef = useRef(measure)
  measureRef.current = measure
  useEffect(() => {
    setReady(true)
    const list = listRef.current
    if (!list || typeof ResizeObserver === 'undefined') return undefined
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false
        return
      }
      list.setAttribute('data-snap', '')
      measureRef.current()
      requestAnimationFrame(() => list.removeAttribute('data-snap'))
    })
    ro.observe(list)
    for (const el of refs.current.values()) ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const move = (i: number): void => {
    const next = TABS[(i + TABS.length) % TABS.length]
    choose(next.id)
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
    choose(t)
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
      <div ref={listRef} className="usage-where-tabs" role="tablist" aria-label="Break down by" data-ready={ready && bar ? '' : undefined}>
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
        {bar && (
          <span
            className="usage-where-indicator"
            data-testid="usage-where-indicator"
            aria-hidden="true"
            style={{ '--tab-x': `${bar.x}px`, '--tab-w': bar.w } as CSSProperties}
          />
        )}
      </div>
      <div
        key={tab}
        className={enter ? 'usage-where-body motion-view' : 'usage-where-body'}
        role="tabpanel"
        id="usage-where-panel"
        aria-labelledby={`usage-where-tab-${tab}`}
      >
        <RankEnterContext.Provider value={enter}>
          {tab === 'project' && <ProjectsPanel {...panel} embedded highlight={highlight} onHighlight={onHighlight} />}
          {tab === 'model' && <ModelsPanel {...panel} embedded />}
          {tab === 'role' && <RolesPanel {...panel} embedded />}
          {tab === 'connection' && <ConnectionsPanel {...panel} embedded />}
        </RankEnterContext.Provider>
      </div>
    </section>
  )
}
