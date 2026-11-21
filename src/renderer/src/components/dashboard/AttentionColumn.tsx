import type { CSSProperties, ReactElement } from 'react'
import { useEffect, useId, useMemo, useRef } from 'react'
import { useAppStore } from '../../store/useAppStore'
import { projectKindOf } from '@shared/defaults'
import { Button } from '../ui/Button'
import { useArrivalSettle, useAttentionList, useRowExits, type RowMotion } from './AttentionSection'
import { sectionHeadingId, useDashboard } from './DashboardContext'
import type { DashCaps } from './dashCaps'
import { NeedsRow, needsItemKey, useNewDecisionAnnouncer, type NeedsItem } from './NeedsInline'
import { useDecisionTotal, useWaitingRuns } from './useDashboardData'
import { decisionLocationLabel } from '../../lib/chatPermissions'
import { openTeamFilesDecision, useTeamAttentionItems } from '../../lib/menuActions'
import { displayRunName } from '../../lib/orgChange'
import { waitingItems } from '../../lib/needsYou'
import { needsCountText } from '../../lib/needsInline'
import { waitingOrder, type WaitingOrderFacts } from '../../lib/waitingOrder'
import { useBellCue } from '../../lib/useBellCue'

/** Spoken once when the last decision leaves while focus was in Needs you. */
export const NOTHING_ELSE_NEEDS_YOU = 'Nothing else needs you.'

/** What the order reads of a row: its kind, the start of its run (a team-files item has none) and its key. */
const orderFacts = (it: NeedsItem): WaitingOrderFacts => ({ key: needsItemKey(it), kind: it.kind, start: it.kind === 'team' ? 0 : it.run.summary.startedAt })

/**
 * Needs you (docs/design/dashboard-usage-redesign/project/components/NeedsYou): fixed, never hidden, reordered or
 * collapsed, and drawn only while a decision is open. Every open decision is a row, answerable in place (Allow once and
 * Deny, or the options of a short question; the rules are in NeedsInline.tsx and lib/needsInline.ts). The only amber
 * surface of the Dashboard. A row that arrives after the page settled rises and rings once and the count pings; rows on
 * screen never move for it (`waitingOrder` places only keys that are new). Runs idle on a reply are not decisions: the
 * Briefing says so and Right now lists them.
 */
function NeedsYouSection({ cap, onAnnounce }: { cap: number; onAnnounce: (text: string) => void }): ReactElement | null {
  const waiting = useWaitingRuns()
  const projects = useAppStore((s) => s.projects)
  const teamItems = useTeamAttentionItems()
  const decisionTotal = useDecisionTotal()
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  // Every project's history is in: the first data load is over, and the baseline of seen decisions is taken then.
  const ready = useAppStore((s) => s.projects.length > 0 && s.projects.every((p) => p.id in s.historyByProject))
  // The order of the rows last shown. The rule (kind, run start, key) places only keys that are new, so an event on
  // another row never moves one under the pointer (docs/design/dashboard-overhaul.md 7.2).
  const shownOrder = useRef<string[]>([])
  const items = useMemo<NeedsItem[]>(() => {
    const all: NeedsItem[] = [
      ...waiting.flatMap((run) =>
        waitingItems(run, projectKindOf(projects.find((p) => p.id === run.summary.projectId))).map((it): NeedsItem => ({ ...it, projectId: run.summary.projectId, run }))
      ),
      ...teamItems.map((t): NeedsItem => ({ kind: 'team', key: t.key, projectId: t.projectId, label: t.label, projectName: t.projectName }))
    ]
    const ordered = waitingOrder(all, orderFacts, shownOrder.current)
    shownOrder.current = ordered.map(needsItemKey)
    return ordered
  }, [waiting, projects, teamItems])
  const announced = useMemo(
    () => items.map((it) => ({ key: needsItemKey(it), project: it.kind === 'team' ? it.projectName : decisionLocationLabel(it.run.summary, projects), label: it.label })),
    [items, projects]
  )
  useNewDecisionAnnouncer(announced, ready, onAnnounce)
  // Arrival rule: rows present once the data is in (plus a beat for pending cards to arrive) are the baseline and never
  // animate; a row that arrives later rises and rings. A row arriving is never announced; only a new decision is (above).
  const settled = useArrivalSettle(ready)
  const exits = useRowExits()
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const model = useAttentionList<NeedsItem>({ items, cap, itemKey: needsItemKey, arrive: settled, exits, headingRef, sectionRef })
  const cue = useBellCue(decisionTotal)
  const { arriving } = useDashboard()
  const { rows } = model

  // The last decision is answered (or goes): the section is drawn no more, so focus cannot stay in it. It moves to the
  // Right now heading when a run is open, else to the status sentence under the greeting, and the live region says so
  // once. Only when focus was inside the section and nothing real holds it by then; the hook above has already handed
  // focus to the next row when one remains.
  const none = rows.length === 0
  const hadRows = useRef(false)
  const focusInside = useRef(false)
  useEffect(() => {
    const onIn = (e: FocusEvent): void => {
      focusInside.current = !!sectionRef.current?.contains(e.target as Node)
    }
    document.addEventListener('focusin', onIn)
    return () => document.removeEventListener('focusin', onIn)
  }, [])
  useEffect(() => {
    if (!none) {
      hadRows.current = true
      return undefined
    }
    if (!hadRows.current) return undefined
    hadRows.current = false
    if (!focusInside.current) return undefined
    focusInside.current = false
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (!active || active === document.body || active === document.documentElement) {
        const target = document.getElementById(sectionHeadingId('now')) ?? document.querySelector<HTMLElement>('[data-testid="dash-greeting-brief"]')
        if (target) {
          if (!target.hasAttribute('tabindex')) target.tabIndex = -1
          target.focus({ preventScroll: true })
        }
      }
      onAnnounce(NOTHING_ELSE_NEEDS_YOU)
    })
    return () => cancelAnimationFrame(frame)
  }, [none, onAnnounce])

  if (none) return null

  const runIds = new Set(items.flatMap((it) => (it.kind === 'team' ? [] : [it.run.summary.id])))
  return (
    <section
      ref={sectionRef}
      className={arriving ? 'dash-section dash-needs motion-arrive-band' : 'dash-section dash-needs'}
      style={arriving ? ({ '--i': 0 } as CSSProperties) : undefined}
      data-testid="dash-needs-you"
      aria-labelledby={headingId}
    >
      <div className="dash-section-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} data-section-heading="">
          Needs you
        </h2>
        <span className="dash-count" data-testid="dash-needs-count" data-ping={cue.ping ? '' : undefined} onAnimationEnd={cue.onPingEnd}>
          {needsCountText(decisionTotal, runIds.size)}
        </span>
      </div>
      <ul className="dash-rows dash-needs-list" ref={model.listRef} onFocus={model.onFocus} onBlur={model.onBlur}>
        {rows.map((r) => {
          const it = r.item
          const key = needsItemKey(it)
          const motion: RowMotion = r.leaving ? { arrived: false, index: 0, leaving: true } : (model.motionOf.get(key) as RowMotion)
          return (
            <NeedsRow
              key={key}
              item={it}
              motion={motion}
              onExpectExit={(on) => (on ? exits.mark([key]) : exits.unmark(key))}
              projectName={it.kind === 'team' ? it.projectName : decisionLocationLabel(it.run.summary, projects)}
              runName={it.kind === 'team' ? undefined : displayRunName(it.run.summary)}
              onAnnounce={onAnnounce}
              onOpen={() => (it.kind === 'team' ? openTeamFilesDecision(it.projectId) : void jumpToDecision(it.projectId, it.runId, it.kind === 'plan' ? undefined : it.key))}
            />
          )
        })}
      </ul>
      {model.hiddenCount > 0 && (
        <Button id={model.moreId} variant="ghost" size="sm" onClick={model.toggle} testId="dash-needs-more">
          {model.expanded ? 'Show fewer' : `Show ${model.hiddenCount} more`}
        </Button>
      )}
    </section>
  )
}

/** Needs you: a fixed region drawn only while a decision is open. */
export function NeedsYouRegion({ caps, onAnnounce }: { caps: DashCaps; onAnnounce: (text: string) => void }): ReactElement | null {
  return <NeedsYouSection cap={caps.needs} onAnnounce={onAnnounce} />
}
