import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChartColumn } from 'lucide-react'
import type { UsageStats, UsageTrendPoint } from '@shared/types'
import { Cost } from './ui/Cost'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import { SegmentedControl } from './ui/SegmentedControl'
import { costView, formatDuration, formatTokens, type CostInput } from '../lib/cost'
import { cleanIpcError } from '../lib/ipcError'
import {
  barFractions,
  bucketLabel,
  fillBuckets,
  formatShare,
  pointValue,
  rangeSince,
  shares,
  totalTokens,
  type TrendBucket,
  type TrendMetric
} from '../lib/trends'

type Days = '7' | '30' | '90'

/** A bucket's cost as a CostInput: unknown when runs spent tokens but none had a known cost, a lower bound when some did not. */
function pointCost(p: UsageTrendPoint): CostInput {
  if (p.runs === 0) return { costUsd: 0, costSource: 'none' }
  if (p.costUsd === null) return { costUsd: null, costSource: 'unknown' }
  // The bucket sums runs of different sources, so the tooltip says "reported or computed", never just one.
  return { costUsd: p.costUsd, costSource: 'provider', sourceMixed: true, ...(p.costUnknownRuns > 0 ? { costPartial: true } : {}) }
}

/**
 * History > Trends: usage of the project's work runs over a range. Totals, a bar chart per day or week with a table
 * behind it, and a row per role. Every cost goes through lib/cost.ts, so an unknown price never reads as $0.
 */
export default function UsageTrends({ projectId }: { projectId: string }): ReactElement {
  const [days, setDays] = useState<Days>('30')
  const [bucket, setBucket] = useState<TrendBucket>('day')
  const [metric, setMetric] = useState<TrendMetric>('tokens')
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    window.orgai.runs
      .usageStats({ projectId, since: rangeSince(Date.now(), Number(days)), bucket })
      .then((s) => {
        if (live) setStats(s)
      })
      .catch((e: unknown) => {
        if (live) setError(cleanIpcError(e))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [projectId, days, bucket, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  return (
    <div className="trends" data-testid="usage-trends">
      <div className="trends-controls">
        <SegmentedControl<Days>
          label="Range"
          value={days}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' }
          ]}
          onChange={setDays}
        />
        <SegmentedControl<TrendBucket>
          label="Group by"
          value={bucket}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' }
          ]}
          onChange={setBucket}
        />
      </div>
      <div className="trends-scroll" aria-busy={loading}>
        {error ? (
          <Banner
            tone="danger"
            title="Could not load usage"
            actions={
              <Button size="sm" onClick={retry}>
                Retry
              </Button>
            }
            testId="trends-error"
          >
            {error}
          </Banner>
        ) : !stats ? (
          <p className="trends-note" role="status" data-testid="trends-loading">
            Loading usage...
          </p>
        ) : stats.runs.length === 0 ? (
          <EmptyState
            compact
            icon={ChartColumn}
            title="No work runs in this range"
            description="Usage appears here once a work run has spent tokens. Try a longer range."
            testId="trends-empty"
          />
        ) : (
          <TrendsBody stats={stats} days={Number(days)} bucket={bucket} metric={metric} onMetric={setMetric} stale={loading} />
        )}
      </div>
    </div>
  )
}

function TrendsBody({
  stats,
  days,
  bucket,
  metric,
  onMetric,
  stale
}: {
  stats: UsageStats
  days: number
  bucket: TrendBucket
  metric: TrendMetric
  onMetric: (m: TrendMetric) => void
  stale: boolean
}): ReactElement {
  const { totals } = stats
  const points = useMemo(
    () => fillBuckets(stats.trend, rangeSince(stats.generatedAt, days), stats.generatedAt, bucket),
    [stats, days, bucket]
  )
  const fractions = useMemo(() => barFractions(points.map((p) => pointValue(p, metric))), [points, metric])
  const roles = useMemo(() => [...stats.roles].sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)), [stats.roles])
  const roleShares = useMemo(() => shares(roles.map((r) => totalTokens(r.tokens))), [roles])
  const totalCost: CostInput = { ...totals, sourceMixed: true }

  const unit = bucket === 'week' ? 'week' : 'day'
  const summary =
    `${metric === 'tokens' ? 'Tokens' : 'Cost'} per ${unit}, ${points.length} ${unit}s. ` +
    `Total ${formatTokens(totalTokens(totals.tokens))} tokens across ${stats.runs.length} runs.`

  return (
    <div className="trends-body" data-stale={stale || undefined}>
      <dl className="trends-totals" data-testid="trends-totals" aria-label="Totals for this range">
        <div>
          <dt>Runs</dt>
          <dd>{stats.runs.length}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd title={tokenTitle(totals.tokens)}>{formatTokens(totalTokens(totals.tokens))}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            <Cost value={totalCost} />
          </dd>
        </div>
        <div>
          <dt>Run time</dt>
          <dd>{formatDuration(totals.wallMs)}</dd>
        </div>
        <div>
          <dt>Waiting on you</dt>
          <dd>{formatDuration(totals.waitingMs)}</dd>
        </div>
      </dl>

      <section className="trends-section" aria-labelledby="trends-chart-h">
        <div className="trends-section-head">
          <h3 id="trends-chart-h">Per {unit}</h3>
          <SegmentedControl<TrendMetric>
            label="Chart shows"
            value={metric}
            options={[
              { value: 'tokens', label: 'Tokens' },
              { value: 'cost', label: 'Cost' }
            ]}
            onChange={onMetric}
          />
        </div>
        <div className="trends-chart" role="img" aria-label={summary} data-testid="trends-chart">
          {points.map((p, i) => {
            const v = pointValue(p, metric)
            const unknown = metric === 'cost' && p.runs > 0 && v === null
            return (
              <div
                key={p.bucket}
                className="trends-col"
                title={
                  metric === 'cost'
                    ? `${bucketLabel(p, bucket)}: ${p.runs} runs, ${costView(pointCost(p)).text}`
                    : `${bucketLabel(p, bucket)}: ${p.runs} runs, ${formatTokens(totalTokens(p.tokens))} tokens`
                }
              >
                <div className="trends-bar-slot">
                  <div
                    className={`trends-bar${unknown ? ' unknown' : ''}${p.costUnknownRuns > 0 && metric === 'cost' ? ' partial' : ''}`}
                    style={{ height: `${Math.round((unknown ? 0.08 : fractions[i]) * 100)}%` }}
                  />
                </div>
                <span className="trends-col-label">{bucketLabel(p, bucket)}</span>
              </div>
            )
          })}
        </div>
        {metric === 'cost' && points.some((p) => p.runs > 0 && p.costUnknownRuns > 0) && (
          <p className="trends-note" data-testid="trends-hatch-note">
            Hatched: some runs have no known price, so the cost of that {unit} is a minimum (or unknown).
          </p>
        )}
        <details className="trends-details">
          <summary>Show as table</summary>
          <div className="trends-table-wrap">
            <table className="history-table trends-table" aria-label={`Usage per ${unit}`} data-testid="trends-table">
              <thead>
                <tr>
                  <th scope="col">{bucket === 'week' ? 'Week of' : 'Day'}</th>
                  <th scope="col" className="num">
                    Runs
                  </th>
                  <th scope="col" className="num">
                    Tokens
                  </th>
                  <th scope="col" className="num">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody>
                {points
                  .filter((p) => p.runs > 0)
                  .map((p) => (
                    <tr key={p.bucket}>
                      <th scope="row">{bucketLabel(p, bucket)}</th>
                      <td className="num">{p.runs}</td>
                      <td className="num">{formatTokens(totalTokens(p.tokens))}</td>
                      <td className="num">
                        <Cost value={pointCost(p)} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="trends-section" aria-labelledby="trends-roles-h">
        <div className="trends-section-head">
          <h3 id="trends-roles-h">By role</h3>
        </div>
        <div className="trends-table-wrap">
          <table className="history-table trends-table trends-roles" aria-label="Usage per role" data-testid="trends-roles">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col" className="num">
                  Tokens
                </th>
                <th scope="col" className="num col-cost">
                  Cost
                </th>
                <th scope="col" className="num col-runs">
                  Runs
                </th>
                <th scope="col" className="col-share">
                  Share of tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r, i) => (
                <tr key={r.roleId ?? r.roleSlug}>
                  <th scope="row" className="trends-role">
                    {r.roleName}
                  </th>
                  <td className="num">{formatTokens(totalTokens(r.tokens))}</td>
                  <td className="num col-cost">
                    <Cost value={{ ...r, sourceMixed: true }} />
                  </td>
                  <td className="num col-runs">{r.runs}</td>
                  <td className="col-share">
                    <div className="share">
                      <div className="share-track" aria-hidden="true">
                        <div className="share-fill" style={{ width: `${Math.round(roleShares[i] * 100)}%` }} />
                      </div>
                      <span className="share-text">{formatShare(roleShares[i])}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function tokenTitle(t: { input: number; output: number; cacheRead: number; cacheWrite: number }): string {
  return `Input ${formatTokens(t.input)}, output ${formatTokens(t.output)}, cache read ${formatTokens(t.cacheRead)}, cache write ${formatTokens(t.cacheWrite)}`
}

