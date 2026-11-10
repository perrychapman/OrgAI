import { useMemo } from 'react'
import type { ReactElement } from 'react'
import { tierForModel } from '@shared/defaults'
import { TRUNCATED_LIMIT_LABEL } from '../../lib/usagePage'
import { minutesText, pageCost, percentText } from '../../lib/usageEfficiency'
import { rowFigures } from '../../lib/usageOverview'
import { costByTier, leadComparison, makeTierOf, OTHER_TIER_LABEL, type TierKey } from '../../lib/usageStaffing'
import { useAppStore } from '../../store/useAppStore'
import type { UsagePanelProps } from './panelProps'
import { ChartTable } from './ChartTable'
import '../../styles/usage-charts.css'

const FILL: Record<TierKey, string> = {
  top: 'var(--chart-s1)',
  deep: 'var(--chart-s2)',
  everyday: 'var(--chart-s3)',
  fast: 'var(--chart-s4)',
  other: 'var(--chart-other)'
}

const runsWord = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'run' : 'runs'}`
const costOrDash = (usd: number | null): string => (usd === null ? '—' : pageCost(usd))
const timeOrDash = (ms: number | null): string => (ms === null ? '—' : minutesText(ms))

/** Cost by tier, and runs the lead did alone against runs with reports (orchestration-efficiency 4.7). */
export default function StaffingPanel({ data, overview, filters }: UsagePanelProps): ReactElement {
  const connections = useAppStore((s) => s.connections)
  const tierOf = useMemo(
    () => makeTierOf((connections ?? []).map((c) => ({ id: c.connection.id, tierModels: c.connection.tierModels ?? {} })), tierForModel),
    [connections]
  )
  // The rows are the newest N runs when main cut the list; the total then has to be theirs too, or the rest would read as "no tier".
  const rowsOnly = overview.truncated && !data.folded
  const total = useMemo(() => {
    if (!rowsOnly) return data.totals.cost.costUsd
    let sum = 0
    let any = false
    for (const r of data.rows) {
      const c = rowFigures(r, filters.model).cost.costUsd
      if (c !== null) {
        sum += c
        any = true
      }
    }
    return any ? sum : null
  }, [rowsOnly, data.totals.cost.costUsd, data.rows, filters.model])
  const parts = useMemo(() => costByTier(data.rows, total, tierOf, filters.model), [data.rows, total, tierOf, filters.model])
  const cmp = useMemo(() => leadComparison(data.rows), [data.rows])
  const showCmp = cmp.alone.runs > 0 || cmp.withReports.runs > 0
  if (!parts && !showCmp) return <></>

  const scope = rowsOnly ? ` From the newest ${TRUNCATED_LIMIT_LABEL} runs.` : ''
  const tiered = parts?.filter((p) => p.key !== 'other').reduce((n, p) => n + p.share, 0) ?? 0
  const summary = parts
    ? `${percentText(tiered)} of the cost is tied to a tier from the model that ran.${scope}`
    : 'Not enough priced runs for a split by tier.'

  return (
    <section className="usage-panel" id="usage-staffing" aria-labelledby="usage-staffing-h" data-testid="usage-staffing">
      <div className="usage-panel-head">
        <h2 id="usage-staffing-h" tabIndex={-1}>
          Cost by tier
        </h2>
        <p className="usage-panel-summary" data-testid="usage-tier-summary">
          {summary}
        </p>
      </div>
      {parts && (
        <>
          <svg width="100%" height="12" aria-hidden="true" focusable="false" data-testid="usage-tier-bar" style={{ display: 'block', borderRadius: 3, overflow: 'hidden' }}>
            {parts.reduce<{ x: number; els: ReactElement[] }>(
              (acc, p) => ({ x: acc.x + p.share, els: [...acc.els, <rect key={p.key} x={`${acc.x * 100}%`} width={`${p.share * 100}%`} height="12" fill={FILL[p.key]} />] }),
              { x: 0, els: [] }
            ).els}
          </svg>
          <ul className="uc-rank" aria-label="Cost by tier" data-testid="usage-tier-list">
            {parts.map((p) => (
              <li key={p.key} data-testid="usage-tier-row" data-tier={p.key} data-cost={p.costUsd} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: FILL[p.key], flex: 'none' }} />
                <span style={{ flex: 1 }}>{p.label}</span>
                <span className="num">{pageCost(p.costUsd)}</span>
                <span className="num" style={{ minWidth: '4ch', textAlign: 'right' }}>{percentText(p.share)}</span>
              </li>
            ))}
          </ul>
          <p className="usage-note">
            A tier is read from the model each agent ran on. "{OTHER_TIER_LABEL}" holds models that match no tier and cost that was not priced per model.
          </p>
          <ChartTable
            testId="usage-tier-table"
            caption="Cost by tier"
            columns={[
              { key: 'tier', label: 'Tier' },
              { key: 'cost', label: 'Cost', numeric: true },
              { key: 'share', label: 'Share', numeric: true }
            ]}
            rows={parts.map((p) => ({ key: p.key, data: { tier: p.key }, cells: [p.label, pageCost(p.costUsd), percentText(p.share)] }))}
          />
        </>
      )}
      {showCmp && (
        <div data-testid="usage-lead-compare">
          <h3 style={{ marginTop: 16 }}>Lead alone and with reports</h3>
          <p className="usage-note">Team runs only. Median over the period. Runs from before OrgAI recorded reports are left out.</p>
          <table className="usage-tbl" data-testid="usage-lead-table">
            <caption className="sr-only">Runs the lead did alone against runs with reports</caption>
            <thead>
              <tr>
                <th scope="col">Runs</th>
                <th scope="col" className="num">Count</th>
                <th scope="col" className="num">Median wall time</th>
                <th scope="col" className="num">Median cost</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['alone', 'Lead alone', cmp.alone],
                  ['reports', 'With reports', cmp.withReports]
                ] as const
              ).map(([key, label, g]) => (
                <tr key={key} data-testid="usage-lead-row" data-group={key} data-runs={g.runs}>
                  <th scope="row">{label}</th>
                  <td className="num">{runsWord(g.runs)}</td>
                  <td className="num">{timeOrDash(g.medianWallMs)}</td>
                  <td className="num" title={g.runs > 0 && g.costKnownRuns < g.runs ? `${g.costKnownRuns} of ${g.runs} runs have a known cost.` : undefined}>
                    {costOrDash(g.medianCostUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
