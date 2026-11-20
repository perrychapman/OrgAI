import type { ReactElement } from 'react'
import { useMemo, useRef } from 'react'
import { projectKindOf } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { AttentionSection, useArrivalSettle, useRowExits } from './AttentionSection'
import type { DashCaps } from './dashCaps'
import { NeedsRow, needsItemKey, useNewDecisionAnnouncer, type NeedsItem } from './NeedsInline'
import { useWaitingRuns } from './useDashboardData'
import { decisionLocationLabel } from '../../lib/chatPermissions'
import { waitingItems } from '../../lib/needsYou'
import { openTeamFilesDecision, useTeamAttentionItems } from '../../lib/menuActions'
import { displayRunName } from '../../lib/orgChange'
import { waitingOrder, type WaitingOrderFacts } from '../../lib/waitingOrder'

/** What the order reads of a row: its kind, the start of its run (a team-files item has none) and its key. */
const orderFacts = (it: NeedsItem): WaitingOrderFacts => ({ key: needsItemKey(it), kind: it.kind, start: it.kind === 'team' ? 0 : it.run.summary.startedAt })

function NeedsYouSection({ cap, onAnnounce }: { cap: number; onAnnounce: (text: string) => void }): ReactElement {
  const waiting = useWaitingRuns()
  const projects = useAppStore((s) => s.projects)
  const jumpToDecision = useAppStore((s) => s.jumpToDecision)
  const teamItems = useTeamAttentionItems()
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
  // animate; a decision that arrives later enters. Same settle as the announcer, so the page loading in stays still.
  const settled = useArrivalSettle(ready)
  const exits = useRowExits()
  return (
    <AttentionSection
      arrive={settled}
      exits={exits}
      testId="dash-needs-you"
      moreTestId="dash-needs-more"
      title="Waiting on you"
      count={items.length}
      items={items}
      cap={cap}
      itemKey={needsItemKey}
      quiet
      renderItem={(it, motion) => (
        <NeedsRow
          key={needsItemKey(it)}
          item={it}
          motion={motion}
          onExpectExit={(on) => (on ? exits.mark([needsItemKey(it)]) : exits.unmark(needsItemKey(it)))}
          projectName={it.kind === 'team' ? it.projectName : decisionLocationLabel(it.run.summary, projects)}
          runName={it.kind === 'team' ? undefined : displayRunName(it.run.summary)}
          onAnnounce={onAnnounce}
          onOpen={() => (it.kind === 'team' ? openTeamFilesDecision(it.projectId) : void jumpToDecision(it.projectId, it.runId, it.kind === 'plan' ? undefined : it.key))}
        />
      )}
    />
  )
}

/** Waiting on you (docs/design/dashboard-overhaul.md 7.2): fixed, first on the page; renders nothing without decisions. */
export function NeedsYouRegion({ caps, onAnnounce }: { caps: DashCaps; onAnnounce: (text: string) => void }): ReactElement {
  return <NeedsYouSection cap={caps.needs} onAnnounce={onAnnounce} />
}
