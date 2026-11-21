import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { UsageOverviewConnection } from '@shared/types'
import { barFraction, clipMiddle, rankByCost, rollupCost, runsText, sharePercent } from '../../lib/usageCharts'
import type { UsagePanelProps } from './panelProps'
import { ChartTable } from './ChartTable'
import { buildRibbon } from '../../lib/usageRibbon'
import { CostText, RANK_TOP, rankFill, RankedBars, type RankedItem } from './RankedBars'
import '../../styles/usage-charts.css'
import '../../styles/usage-breakdown.css'

const NO_CONNECTION = '\u0000none'
const idOf = (c: UsageOverviewConnection): string => c.connection ?? NO_CONNECTION
const KIND_WORD: Record<'builtin' | 'proxy', string> = { builtin: 'Built in', proxy: 'Proxy' }
const kindWord = (c: UsageOverviewConnection): string => (c.kind ? KIND_WORD[c.kind] : '—')
const agentsText = (n: number): string => `${n} ${n === 1 ? 'agent' : 'agents'}`

/** "Where it went" Connection tab: spend by connection (no tokens are recorded per connection, so unknown costs rank after known ones, then by agents). */
export default function ConnectionsPanel({ data, filters, onNarrow, announce, embedded }: UsagePanelProps & { embedded?: boolean }): ReactElement {
  const limit = RANK_TOP
  const [showAll, setShowAll] = useState(false)

  const ranked = useMemo(() => {
    const byAgents = [...data.connections].sort((a, b) => b.agents - a.agents)
    return rankByCost(byAgents, (c) => ({ costUsd: c.costUsd, tokens: 0 }))
  }, [data.connections])
  const shown = showAll ? ranked : ranked.slice(0, limit)
  const maxCost = ranked.reduce((n, c) => Math.max(n, c.costUsd ?? 0), 0)
  const byId = new Map(ranked.map((c) => [idOf(c), c]))

  const ribbon = buildRibbon(
    ranked.map((c, i) => ({ id: idOf(c), name: c.name, value: c.costUsd, partial: c.costUnknownRuns > 0, fill: rankFill(i) })),
    'var(--chart-other)'
  )

  const items: RankedItem[] = shown.map((c, i) => ({
    id: idOf(c),
    data: { connection: c.connection ?? '' },
    name: c.name,
    shown: clipMiddle(c.name, 30),
    sub: c.kind ? KIND_WORD[c.kind] : undefined,
    fraction: c.costUsd === null ? 0 : barFraction(c.costUsd, maxCost),
    state: c.costUsd === null ? 'unknown' : c.costUnknownRuns > 0 ? 'partial' : 'known',
    fill: rankFill(i),
    cost: rollupCost(c),
    detail: `${runsText(c.runs)} · ${agentsText(c.agents)}`,
    selected: !!c.connection && filters.connection === c.connection
  }))

  const top = ranked.find((c) => c.costUsd !== null)
  const totalKnown = ranked.reduce((n, c) => n + (c.costUsd ?? 0), 0)
  const summary = (() => {
    if (ranked.length === 0) return 'No agents ran in this period.'
    if (!top || totalKnown <= 0) return 'Agents ran, but no cost is known for any connection.'
    if (ranked.length === 1) return `All of this period's estimated cost ran on ${top.name}.`
    const anyUnknown = ranked.some((c) => c.costUnknownRuns > 0)
    return `${top.name} is ${sharePercent(top.costUsd ?? 0, totalKnown)}% of this period's estimated cost${anyUnknown ? ', counting only runs with a known price' : ''}.`
  })()

  const rows = ranked.map((c) => ({
    key: idOf(c),
    data: { connection: c.connection ?? '' },
    cells: [c.name, kindWord(c), c.runs, c.agents, <CostText key="c" value={rollupCost(c)} />],
    sort: [c.name, c.kind ? KIND_WORD[c.kind] : null, c.runs, c.agents, c.costUsd]
  }))

  const Root = embedded ? 'div' : 'section'
  return (
    <Root
      className={embedded ? 'usage-panel-embedded' : 'usage-panel'}
      {...(embedded ? {} : { 'aria-labelledby': 'usage-connections-h' })}
      data-testid="usage-connections-panel"
    >
      {embedded ? (
        <p className="usage-panel-summary">{summary}</p>
      ) : (
        <div className="usage-panel-head">
          <h2 id="usage-connections-h" tabIndex={-1}>
            By connection
          </h2>
          <p className="usage-panel-summary">{summary}</p>
        </div>
      )}
      {items.length > 0 ? (
        <RankedBars
          label="Connections by estimated cost"
          items={items}
          ribbon={ribbon}
          rowTestId="usage-connection-row"
          onActivate={(it) => {
            const c = byId.get(it.id)
            if (c?.connection) onNarrow({ connection: c.connection })
            else announce('Unknown connection cannot be filtered.')
          }}
        />
      ) : (
        <p className="uc-empty">No runs in this period.</p>
      )}
      {ranked.length > limit && (
        <button type="button" className="link-btn uc-more" data-testid="usage-connections-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${ranked.length}`}
        </button>
      )}
      <ChartTable
        testId="usage-connections-table"
        caption="Usage by connection"
        columns={[
          { key: 'connection', label: 'Connection' },
          { key: 'kind', label: 'Kind', optional: true },
          { key: 'runs', label: 'Runs', numeric: true },
          { key: 'agents', label: 'Agents', numeric: true, optional: true },
          { key: 'cost', label: 'Cost', numeric: true }
        ]}
        rows={rows}
        empty="No runs in this period."
        announce={announce}
      />
    </Root>
  )
}
