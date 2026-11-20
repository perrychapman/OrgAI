import type { CSSProperties, KeyboardEvent, ReactElement } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, GitCommitHorizontal } from 'lucide-react'
import { projectKindOf } from '@shared/defaults'
import { isRunLive, useAppStore, type RunState } from '../../store/useAppStore'
import { commitChart, type CommitActivityInput, type CommitColumn, type CommitLegendItem } from '../../lib/commitChart'
import { Icon } from '../ui/Icon'
import { useRovingFocus } from '../connectors/useRovingFocus'
import { ProjectBadge } from './ProjectBadge'
import { useNow } from './useDashboardData'

/**
 * Commits this week by project (docs/design/dashboard-overhaul.md "Visual pass"): fixed in the right column of the lead
 * band, beside Waiting on you; not arrangeable, so it draws its own card with the shared `.dash-section` head. One stacked
 * bar per local day (oldest left, today right), a segment per project in its identity hue with a 2 px surface gap, a
 * linear scale from zero, then a legend. The model is `lib/commitChart.ts`; this file only draws it and asks for the data.
 *
 * Data: `window.orgai.projects.commitActivity()` (read-only, desktop; main caches 60 s), read through a feature-detecting
 * accessor so the tile shows its empty state wherever the call is missing. It is asked once after first paint and again
 * when a work run leaves the live set, never more than once per COMMIT_REFRESH_MIN_MS (a run end inside the window waits
 * for its end). A failure is silent: the earlier answer stays, or the empty card shows.
 *
 * Keyboard: the day group is one Tab stop (roving, today at rest); arrows, Home and End move, Enter or Space pins the day
 * in the readout (aria-pressed), Esc unpins. The readout is a plain paragraph, not a live region. Nothing here animates.
 */

/** The least time between two reads of the commit activity from this tile. */
export const COMMIT_REFRESH_MIN_MS = 10 * 60_000

type CommitActivityReader = () => Promise<CommitActivityInput[]>

/** The IPC call when this build has it (it landed on dev after this tile), else null. */
function commitActivityReader(): CommitActivityReader | null {
  const projects = (window as unknown as { orgai?: { projects?: { commitActivity?: CommitActivityReader } } }).orgai?.projects
  const fn = projects?.commitActivity
  return typeof fn === 'function' ? () => fn.call(projects) : null
}

function liveWorkIds(runs: Record<string, RunState>): Set<string> {
  const ids = new Set<string>()
  for (const r of Object.values(runs)) if (isRunLive(r) && (r.summary.kind ?? 'work') === 'work') ids.add(r.summary.id)
  return ids
}

interface Loaded {
  status: 'loading' | 'ready'
  data: CommitActivityInput[]
}

function useCommitActivity(enabled: boolean): Loaded {
  const [state, setState] = useState<Loaded>(() => ({ status: commitActivityReader() ? 'loading' : 'ready', data: [] }))
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let last = 0
    let wait: number | undefined
    let first: number | undefined
    const load = (): void => {
      last = Date.now()
      const read = commitActivityReader()
      if (!read) {
        setState((s) => ({ status: 'ready', data: s.data }))
        return
      }
      read().then(
        (data) => {
          if (alive) setState({ status: 'ready', data: Array.isArray(data) ? data : [] })
        },
        () => {
          if (alive) setState((s) => ({ status: 'ready', data: s.data }))
        }
      )
    }
    const request = (): void => {
      if (wait !== undefined) return
      const left = last + COMMIT_REFRESH_MIN_MS - Date.now()
      if (left <= 0) load()
      else
        wait = window.setTimeout(() => {
          wait = undefined
          load()
        }, left)
    }
    // After first paint: the frame, then a task, so the Dashboard is drawn before the read starts.
    const raf = window.requestAnimationFrame(() => {
      first = window.setTimeout(load, 0)
    })
    let seenRuns = useAppStore.getState().runs
    let live = liveWorkIds(seenRuns)
    const unsub = useAppStore.subscribe((s) => {
      if (s.runs === seenRuns) return
      seenRuns = s.runs
      const now = liveWorkIds(s.runs)
      const ended = [...live].some((id) => !now.has(id))
      live = now
      if (ended) request()
    })
    return () => {
      alive = false
      unsub()
      window.cancelAnimationFrame(raf)
      if (first !== undefined) window.clearTimeout(first)
      if (wait !== undefined) window.clearTimeout(wait)
    }
  }, [enabled])
  return state
}

function Head({ total }: { total: number }): ReactElement {
  return (
    <div className="dash-section-head">
      <span className="dash-section-icon" aria-hidden="true">
        <Icon icon={GitCommitHorizontal} size="sm" />
      </span>
      <h2 id="dash-h-commits" tabIndex={-1} data-section-heading="">
        Commits this week
      </h2>
      {total > 0 && (
        <span className="dash-count" data-testid="dash-commits-total">
          {total}
        </span>
      )}
    </div>
  )
}

function Day({
  column,
  pinned,
  onPin,
  onHover,
  onFocusDay
}: {
  column: CommitColumn
  pinned: boolean
  onPin: () => void
  onHover: (on: boolean) => void
  onFocusDay: (on: boolean) => void
}): ReactElement {
  return (
    <button
      type="button"
      className="dash-commits-day"
      data-testid="dash-commits-day"
      data-date={column.date}
      data-total={column.total}
      data-today={column.today ? 'true' : undefined}
      data-pinned={pinned ? 'true' : undefined}
      aria-pressed={pinned}
      aria-label={column.name}
      onClick={onPin}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={() => onFocusDay(true)}
      onBlur={() => onFocusDay(false)}
    >
      <span className="dash-commits-track" data-testid="dash-commits-track" aria-hidden="true">
        {column.total > 0 && (
          <span className="dash-commits-bar" style={{ height: `${column.pct}%`, '--commit-n': column.segments.length } as CSSProperties}>
            {column.segments.map((s) => (
              <span
                key={s.id}
                className="dash-commits-seg"
                data-testid="dash-commits-seg"
                data-project={s.id}
                data-kind={s.kind}
                data-hue={s.hue}
                data-commits={s.commits}
                style={{ flexGrow: s.commits }}
              />
            ))}
          </span>
        )}
      </span>
      <span className="dash-commits-labels" aria-hidden="true">
        <span className="dash-commits-initial">{column.initial}</span>
        <span className="dash-commits-end">{column.today ? 'Today' : ''}</span>
      </span>
    </button>
  )
}

function LegendItem({ item }: { item: CommitLegendItem }): ReactElement {
  return (
    <li className="dash-commits-legend-item" data-testid="dash-commits-legend-item" data-project={item.id} data-kind={item.kind} title={item.title}>
      {item.kind === 'project' ? <ProjectBadge projectId={item.id} name={item.name} size="xs" /> : <span className="dash-commits-other-dot" aria-hidden="true" />}
      <span className="dash-commits-name">{item.name}</span>
      <span className="dash-num dash-commits-figure">{item.total}</span>
    </li>
  )
}

function Chart({ columns, legend, weekReadout, text }: { columns: CommitColumn[]; legend: CommitLegendItem[]; weekReadout: string; text: string }): ReactElement {
  const [pinned, setPinned] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const shownDate = hover ?? focused ?? (pinned && columns.some((c) => c.date === pinned) ? pinned : null)
  const shown = columns.find((c) => c.date === shownDate)

  const groupRef = useRef<HTMLDivElement>(null)
  const roving = useRovingFocus(groupRef, '[data-testid=dash-commits-day]')
  // Today is the tab stop at rest; the hook keeps whichever day has focus.
  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group || group.contains(document.activeElement)) return
    for (const el of group.querySelectorAll<HTMLElement>('[data-testid=dash-commits-day]')) el.tabIndex = el.dataset.today === 'true' ? 0 : -1
  })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Esc unpins the readout and stops there, so it does not also leave customise mode.
    if (e.key === 'Escape' && pinned) {
      e.stopPropagation()
      setPinned(null)
      return
    }
    roving.onKeyDown(e)
  }

  return (
    <div className="dash-commits-body" data-testid="dash-commits-chart">
      <div className="dash-commits-inner">
        <div ref={groupRef} className="dash-commits-days" role="group" aria-label="Commits per day, last 7 days" onKeyDown={onKeyDown} onFocus={roving.onFocus}>
          {columns.map((c) => (
            <Day
              key={c.date}
              column={c}
              pinned={pinned === c.date}
              onPin={() => setPinned((p) => (p === c.date ? null : c.date))}
              onHover={(on) => setHover((h) => (on ? c.date : h === c.date ? null : h))}
              onFocusDay={(on) => setFocused((f) => (on ? c.date : f === c.date ? null : f))}
            />
          ))}
        </div>
        <p className="dash-commits-readout" data-testid="dash-commits-readout">
          {shown ? shown.readout : weekReadout}
        </p>
        <ul className="dash-commits-legend" aria-hidden="true">
          {legend.map((l) => (
            <LegendItem key={l.id} item={l} />
          ))}
        </ul>
        <p className="sr-only" data-testid="dash-commits-text">
          {text}
        </p>
      </div>
    </div>
  )
}

export function CommitsSection(): ReactElement | null {
  const projects = useAppStore((s) => s.projects)
  const code = useMemo(() => projects.filter((p) => projectKindOf(p) === 'code').map((p) => ({ id: p.id, name: p.name })), [projects])
  const loaded = useCommitActivity(code.length > 0)
  // A minute tick, so the seven days roll over at midnight even when no new answer arrives.
  const now = useNow(60_000)
  const chart = useMemo(() => commitChart(loaded.data, code, now), [loaded.data, code, now])

  if (code.length === 0) return null
  return (
    <section className="dash-section dash-commits" data-testid="dash-commits" aria-labelledby="dash-h-commits">
      <Head total={loaded.status === 'ready' ? chart.total : 0} />
      {loaded.status === 'loading' ? (
        <div className="dash-commits-body" data-testid="dash-commits-loading" aria-hidden="true">
          <div className="dash-commits-inner">
            <div className="dash-commits-placeholder" />
          </div>
        </div>
      ) : chart.empty ? (
        <p className="dash-empty dash-commits-empty" data-testid="dash-commits-empty">
          <Icon icon={GitBranch} size="sm" />
          <span>No commits this week.</span>
        </p>
      ) : (
        <Chart columns={chart.columns} legend={chart.legend} weekReadout={chart.weekReadout} text={chart.text} />
      )}
    </section>
  )
}
