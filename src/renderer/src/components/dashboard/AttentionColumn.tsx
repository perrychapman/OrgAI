import type { ReactElement } from 'react'
import { useId, useMemo, useRef } from 'react'
import { Bell, CircleCheck } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { isVirtualProjectId } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { isRunLive, useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { useArrivalSettle, useAttentionList, useRowExits, type RowMotion } from './AttentionSection'
import { AttentionTileView, useTileFocus } from './AttentionTile'
import type { DashCaps } from './dashCaps'
import { needsItemKey, useNewDecisionAnnouncer, type NeedsItem } from './NeedsInline'
import { useDecisionTotal, useNow, useWaitingRuns } from './useDashboardData'
import { decisionLocationLabel } from '../../lib/chatPermissions'
import { decisionSince, groupDecisionTiles, isAwaitingReply, orderTiles, replyFacts, type AttentionTile, type ReplyTile } from '../../lib/attentionTiles'
import { rootOf } from '../../lib/dashboardBand'
import { waitingItems } from '../../lib/needsYou'
import { useTeamAttentionItems } from '../../lib/menuActions'
import { displayRunName } from '../../lib/orgChange'
import { waitingOrder, type WaitingOrderFacts } from '../../lib/waitingOrder'

/** What the order reads of a row: its kind, the start of its run (a team-files item has none) and its key. */
const orderFacts = (it: NeedsItem): WaitingOrderFacts => ({ key: needsItemKey(it), kind: it.kind, start: it.kind === 'team' ? 0 : it.run.summary.startedAt })

type StoreState = ReturnType<typeof useAppStore.getState>

/**
 * The live runs idle and waiting on the person's reply with no decision open (the greeting's rule, `isAwaitingReply`), as
 * JSON strings so a store event that changes nothing here renders nothing (`useShallow` compares the strings). The cheap
 * root check goes first: only a run that already looks idle pays for the status rule and the summary.
 */
function replySnapshot(s: StoreState): string[] {
  const known = new Set(s.projects.map((p) => p.id))
  const out: string[] = []
  for (const r of Object.values(s.runs)) {
    if (!isRunLive(r) || !(isVirtualProjectId(r.summary.projectId) || known.has(r.summary.projectId))) continue
    const root = rootOf(Object.values(r.agents))
    if (!root || root.state !== 'idle' || root.activity !== 'Waiting for you') continue
    const decisions = waitingItems(r, projectKindOf(s.projects.find((p) => p.id === r.summary.projectId))).length
    if (!isAwaitingReply({ summary: r.summary, agents: r.agents, plan: r.plan, decisions }, s.projects, s.virtualProjects)) continue
    out.push(JSON.stringify(replyFacts({ summary: r.summary, agents: r.agents, plan: r.plan, decisions, transcript: r.transcript }, displayRunName(r.summary))))
  }
  return out
}

function useReplyTiles(): ReplyTile[] {
  const rows = useAppStore(useShallow(replySnapshot))
  return useMemo(() => rows.map((r): ReplyTile => ({ ...(JSON.parse(r) as Omit<ReplyTile, 'kind'>), kind: 'reply' })), [rows])
}

type Tile = AttentionTile<NeedsItem>

function NeedsYouSection({ cap, onAnnounce }: { cap: number; onAnnounce: (text: string) => void }): ReactElement | null {
  const waiting = useWaitingRuns()
  const projects = useAppStore((s) => s.projects)
  const teamItems = useTeamAttentionItems()
  const replies = useReplyTiles()
  const decisionTotal = useDecisionTotal()
  const now = useNow()
  // Every project's history is in: the first data load is over, and the baseline of seen decisions is taken then.
  const ready = useAppStore((s) => s.projects.length > 0 && s.projects.every((p) => p.id in s.historyByProject))
  // The order of the rows and tiles last shown. The rule (kind, run start, key) places only keys that are new, so an event
  // on another row never moves one under the pointer (docs/design/dashboard-overhaul.md 7.2).
  const shownOrder = useRef<string[]>([])
  const shownTiles = useRef<string[]>([])
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
  // One tile per run (and per project for team files), then the runs idle on a reply, longest wait last.
  const tiles = useMemo<Tile[]>(() => {
    const decisions = groupDecisionTiles(items, (it) => (it.kind === 'team' ? { startedAt: 0 } : { startedAt: it.run.summary.startedAt, since: decisionSince(it.run) }))
    const ordered = orderTiles<Tile>([...decisions, ...replies], shownTiles.current)
    shownTiles.current = ordered.map((t) => t.key)
    return ordered
  }, [items, replies])
  const announced = useMemo(
    () => items.map((it) => ({ key: needsItemKey(it), project: it.kind === 'team' ? it.projectName : decisionLocationLabel(it.run.summary, projects), label: it.label })),
    [items, projects]
  )
  useNewDecisionAnnouncer(announced, ready, onAnnounce)
  // Arrival rule: tiles present once the data is in (plus a beat for pending cards to arrive) are the baseline and never
  // animate; a tile that arrives later enters. Same settle as the announcer, so the page loading in stays still. A tile
  // arriving is never announced; only a new decision is (above).
  const settled = useArrivalSettle(ready)
  const exits = useRowExits()
  const headingId = useId()
  const sectionRef = useRef<HTMLElement>(null)
  const model = useAttentionList<Tile>({ items: tiles, cap, itemKey: (t) => t.key, arrive: settled, exits })
  const focus = useTileFocus(model.listRef, sectionRef)
  const { rows } = model

  if (rows.length === 0) {
    if (!ready) return null
    // Nothing needs the person: a composed card, so the lead column is never blank. `dash-needs-you` is not in the DOM.
    return (
      <div className={settled ? 'dash-needs-clear motion-fade' : 'dash-needs-clear'} data-testid="dash-needs-clear">
        <span className="dash-section-icon" data-tone="success" aria-hidden="true">
          <Icon icon={CircleCheck} size="sm" />
        </span>
        <p>Nothing is waiting on you.</p>
      </div>
    )
  }

  const replyCount = replies.length
  const ctx = { projects, now, arrive: settled, exits, onAnnounce }
  return (
    <section ref={sectionRef} className="dash-section" data-testid="dash-needs-you" aria-labelledby={headingId}>
      <div className="dash-section-head">
        <span className="dash-section-icon" aria-hidden="true">
          <Icon icon={Bell} size="sm" />
        </span>
        <h2 id={headingId} tabIndex={-1} data-section-heading="">
          Waiting on you
        </h2>
        {decisionTotal > 0 && <span className="dash-count">{decisionTotal}</span>}
        {replyCount > 0 && (
          <span className="dash-attn-reply-count" data-testid="dash-attn-reply-count">
            {decisionTotal > 0 && (
              <span className="dash-sep" aria-hidden="true">
                {'· '}
              </span>
            )}
            {replyCount} awaiting reply
          </span>
        )}
      </div>
      <ul className="dash-rows dash-attn-grid" ref={model.listRef} onFocus={focus.onFocus} onBlur={focus.onBlur}>
        {rows.map((r) => (
          <AttentionTileView key={r.item.key} tile={r.item} motion={r.leaving ? ({ arrived: false, index: 0, leaving: true } satisfies RowMotion) : (model.motionOf.get(r.item.key) as RowMotion)} ctx={ctx} />
        ))}
      </ul>
      {model.hiddenCount > 0 && (
        <Button id={model.moreId} variant="ghost" size="sm" onClick={model.toggle} testId="dash-needs-more">
          {model.expanded ? 'Show fewer' : `Show ${model.hiddenCount} more`}
        </Button>
      )}
    </section>
  )
}

/**
 * Waiting on you (docs/design/dashboard-overhaul.md 7.2, board pass): fixed, first on the page. One tile per run that
 * needs the person: runs with open decisions (answered inline as before) and runs idle waiting on a reply. With nothing
 * to do it shows an all-clear card instead of the section.
 */
export function NeedsYouRegion({ caps, onAnnounce }: { caps: DashCaps; onAnnounce: (text: string) => void }): ReactElement | null {
  return <NeedsYouSection cap={caps.needs} onAnnounce={onAnnounce} />
}
