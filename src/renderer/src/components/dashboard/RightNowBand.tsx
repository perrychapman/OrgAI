import type { ReactElement } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useEffect } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { BandRun } from './BandRun'
import type { DashCaps } from './dashCaps'
import { useAllSummaries, useBandSnapshot, useNow } from './useDashboardData'
import { bandHeightEstimate, bandModel, countParts, fitBandModel, emptyLine, moreRunsLabel } from '../../lib/dashboardBand'
import { pausedRuns } from '../../lib/dashboard'
import { useArrival } from '../../lib/useArrival'
import { nextSettleAt, settleTimerDelay } from '../../lib/foldFinished'

/** After a row opens a run: the agent's canvas node when it exists, else the topbar heading unless focus is already somewhere real. */
function settleFocus(targetId: string | null): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (targetId) {
        const node = Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).find((n) => n.dataset.id === targetId)
        if (node) {
          node.focus({ preventScroll: true })
          return
        }
      }
      const active = document.activeElement
      if (active && active !== document.body) return
      const h = document.querySelector<HTMLElement>('main .topbar h1')
      if (!h) return
      h.tabIndex = -1
      h.focus({ preventScroll: true })
    })
  )
}

function openRun(projectId: string, runId: string, agentId: string | null, rootId: string | null): void {
  void useAppStore
    .getState()
    .focusRun(projectId, runId)
    .then(() => {
      if (agentId) useAppStore.getState().selectAgent(agentId)
      settleFocus(agentId ?? rootId)
    })
}

/** The Right now band (docs/design/dashboard-2.md section 6): runs as small subway lines, never announced. */
export function RightNowBand({ caps, budget }: { caps: DashCaps; budget?: number; onAnnounce: (text: string) => void }): ReactElement {
  const snap = useBandSnapshot()
  const elapsedNow = useNow()
  const summaries = useAllSummaries()
  const [showAll, setShowAll] = useState(false)
  const [tick, setTick] = useState(0)
  const rootRef = useRef<HTMLElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  // Agents leave their grace period on a timer, not on an event (same pattern as the Live view).
  const settleDue = useMemo(() => {
    let due: number | undefined
    const at = Date.now()
    for (const r of snap.runs) {
      const d = nextSettleAt(Object.values(r.agents), at)
      if (d !== undefined && (due === undefined || d < due)) due = d
    }
    return due
  }, [snap, tick])
  useEffect(() => {
    if (settleDue === undefined) return
    const id = window.setTimeout(() => setTick((t) => t + 1), settleTimerDelay(settleDue, Date.now()))
    return () => window.clearTimeout(id)
  }, [settleDue])

  const model = useMemo(
    () => fitBandModel(caps, budget, (c) => bandModel(snap.runs, snap.projects, snap.virtualProjects, Date.now(), c, { showAllRuns: showAll })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap, caps, budget, showAll, tick]
  )
  const paused = useMemo(() => pausedRuns(summaries).length, [summaries])

  // Motion (spec 3.14): arrivals after first paint rise in; first paint, relaunch and a hidden band never animate.
  const flatRuns = model.projects.flatMap((p) => p.runs.map((r) => r.id))
  const runArrived = useArrival(flatRuns, 'band', { maxPerBatch: 5 })
  const [reveal, setReveal] = useState<{ from: number } | null>(null)
  useEffect(() => {
    if (!reveal) return
    const id = window.setTimeout(() => setReveal(null), 1000)
    return () => window.clearTimeout(id)
  }, [reveal])
  const toggleAll = (): void => {
    setReveal(showAll ? null : { from: flatRuns.length })
    setShowAll((v) => !v)
  }
  const wasEmpty = useRef<boolean | null>(null)
  const [bandArrived, setBandArrived] = useState(false)
  useEffect(() => {
    const empty = model.total === 0
    const appeared = wasEmpty.current === true && !empty
    wasEmpty.current = empty
    if (!appeared) return undefined
    setBandArrived(true)
    const id = window.setTimeout(() => setBandArrived(false), 1000)
    return () => window.clearTimeout(id)
  }, [model.total])

  // Focus rules (6.5): a focused agent row that leaves hands focus to its run header; a run header that leaves, to the
  // next header, else the previous, else the heading. Live updates never move focus otherwise.
  const focused = useRef<{ key: string; runKeys: string[] } | null>(null)
  const runKeys = model.projects.flatMap((p) => p.runs.map((r) => `run:${r.id}`))
  const runKeySig = runKeys.join('\u0000')
  const onFocus = useCallback((e: React.FocusEvent<HTMLElement>) => {
    const key = (e.target as HTMLElement).closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey
    const root = rootRef.current
    if (!key || !root) return
    const keys = Array.from(root.querySelectorAll<HTMLElement>('[data-focus-key^="run:"]')).map((el) => el.dataset.focusKey as string)
    focused.current = { key, runKeys: keys }
  }, [])
  const onBlur = useCallback((e: React.FocusEvent<HTMLElement>) => {
    if (e.relatedTarget) focused.current = null
  }, [])
  const has = (key: string): boolean => !!rootRef.current && Array.from(rootRef.current.querySelectorAll<HTMLElement>('[data-focus-key]')).some((el) => el.dataset.focusKey === key)
  const focusKey = (key: string): boolean => {
    const el = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-focus-key]') ?? []).find((n) => n.dataset.focusKey === key)
    el?.focus({ preventScroll: true })
    return !!el
  }
  useLayoutEffect(() => {
    const f = focused.current
    if (!f || has(f.key)) return
    const active = document.activeElement
    if (active && active !== document.body && active !== document.documentElement) return
    focused.current = null
    if (!f.key.startsWith('run:')) {
      const run = f.key.slice(f.key.indexOf(':') + 1).split('/')[0]
      if (focusKey(`run:${run}`)) return
    }
    const i = f.runKeys.indexOf(f.key.startsWith('run:') ? f.key : `run:${f.key.slice(f.key.indexOf(':') + 1).split('/')[0]}`)
    const after = f.runKeys.slice(i + 1).find((k) => has(k))
    const before = f.runKeys.slice(0, Math.max(0, i)).reverse().find((k) => has(k))
    const target = after ?? before
    if (target) focusKey(target)
    else headingRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKeySig, model])

  const parts = countParts(model.counts)
  return (
    <section
      ref={rootRef}
      className={bandArrived ? 'dash-section dash-now motion-enter' : 'dash-section dash-now'}
      data-testid="dash-now"
      data-working={model.counts.working}
      data-waiting={model.counts.waiting}
      data-idle={model.counts.idle}
      data-budget={budget}
      data-estimate={bandHeightEstimate(model)}
      aria-labelledby="dash-now-heading"
      // No open run: the status sentence already says "Nothing is running", so the band is not drawn twice (walk-3).
      hidden={model.total === 0 ? true : undefined}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="dash-section-head">
        <h2 id="dash-now-heading" ref={headingRef} tabIndex={-1} data-section-heading="">
          Right now
        </h2>
        {parts.length > 0 && (
          <p className="dash-now-counts" data-testid="dash-now-counts">
            {parts.map((p, i) => (
              <span key={p.group}>
                {i > 0 && <span className="dash-sep" aria-hidden="true"> · </span>}
                <span className="dash-num" data-group={p.group}>
                  {p.text}
                </span>
              </span>
            ))}
          </p>
        )}
      </div>
      {model.total === 0 ? (
        <p className="dash-empty" data-testid="dash-now-empty">
          {emptyLine(paused)}
        </p>
      ) : (
        <>
          {model.projects.map((p) => (
            <section key={p.id} className="dash-now-project" data-testid="dash-now-project" data-project={p.id} aria-labelledby={`dash-now-p-${p.id}`}>
              <h3 id={`dash-now-p-${p.id}`}>
                {p.label}
                {p.client && <span className="dash-now-client"> · {p.client}</span>}
              </h3>
              <ul className="dash-runs">
                {p.runs.map((r) => {
                  const at = flatRuns.indexOf(r.id)
                  const revealed = reveal !== null && at >= reveal.from
                  const enter = revealed ? Math.min(at - reveal.from, 5) : runArrived(r.id) ? 0 : undefined
                  return <BandRun key={r.id} run={r} now={elapsedNow} onOpen={openRun} enter={enter} />
                })}
              </ul>
            </section>
          ))}
          {(model.hiddenRuns > 0 || showAll) && model.total > caps.bandRuns && (
            <Button variant="ghost" size="sm" testId="dash-now-more" onClick={toggleAll}>
              {showAll ? 'Show fewer' : moreRunsLabel(model.hiddenRuns)}
            </Button>
          )}
        </>
      )}
    </section>
  )
}
