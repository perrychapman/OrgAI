import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, ChartColumn, ClipboardCopy, Download } from 'lucide-react'
import { Icon } from './ui/Icon'
import type { RunKind, UsageStats, UsageStatsQuery, UsageTrendPoint } from '@shared/types'
import { useAppStore, useProjectSummaries } from '../store/useAppStore'
import { Cost } from './ui/Cost'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import { SegmentedControl } from './ui/SegmentedControl'
import { costView, formatDuration, formatTokens, type CostInput } from '../lib/cost'
import { cleanIpcError } from '../lib/ipcError'
import type { UsagePeriod } from '../lib/usageOverview'
import {
  barFractions,
  bucketLabel,
  chartSpan,
  copiedText,
  csvFileName,
  csvRowCount,
  fillBuckets,
  formatShare,
  groupByKind,
  loadRange,
  mergeRoleRows,
  monthOptions,
  pointValue,
  rangeSince,
  rangeToKey,
  saveRange,
  shares,
  totalTokens,
  type TrendsRange,
  type TrendBucket,
  type TrendMetric
} from '../lib/trends'

type RangeChoice = '7' | '30' | '90' | 'month'

/** Trends' range as the Usage page's period: 7 / 30 days and a month map over; 90 days leaves the page's default. */
function usagePeriodFor(range: TrendsRange): { period?: UsagePeriod } {
  if (range.kind === 'month') return { period: { kind: 'months', from: range.month, to: range.month } }
  if (range.days === 7 || range.days === 30) return { period: { kind: 'days', days: range.days } }
  return {}
}

const ALL_KINDS: RunKind[] = ['work', 'setup', 'mcp-assist', 'skill-assist']

/** The runs:usageStats / usageCsv query of a range; every run kind is counted. */
function queryFor(projectId: string, range: TrendsRange, now: number): UsageStatsQuery {
  const base = { projectId, kinds: ALL_KINDS }
  return range.kind === 'month' ? { ...base, range: { month: range.month } } : { ...base, since: rangeSince(now, range.days) }
}

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
  const [range, setRange] = useState<TrendsRange>(() => loadRange(projectId))
  const [bucket, setBucket] = useState<TrendBucket>('day')
  const [metric, setMetric] = useState<TrendMetric>('tokens')
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [csvStatus, setCsvStatus] = useState<{ text: string; failed: boolean } | null>(null)
  const [csvBusy, setCsvBusy] = useState(false)
  const openUsage = useAppStore((s) => s.openUsage)
  const projectName = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.name ?? '')
  const months = useMemo(() => monthOptions(Date.now()), [])
  const rangeKey = rangeToKey(range)

  useEffect(() => {
    setRange(loadRange(projectId))
  }, [projectId])

  useEffect(() => {
    setCsvStatus(null)
  }, [projectId, rangeKey])

  const pickRange = useCallback(
    (choice: RangeChoice) => {
      const next: TrendsRange = choice === 'month' ? { kind: 'month', month: months[0].value } : { kind: 'days', days: Number(choice) as 7 | 30 | 90 }
      setRange(next)
      saveRange(projectId, next)
    },
    [months, projectId]
  )
  const pickMonth = useCallback(
    (month: string) => {
      const next: TrendsRange = { kind: 'month', month }
      setRange(next)
      saveRange(projectId, next)
    },
    [projectId]
  )

  const noRuns = !!stats && stats.runs.length === 0

  const copyCsv = useCallback(async () => {
    setCsvBusy(true)
    try {
      const csv = await window.orgai.runs.usageCsv(queryFor(projectId, range, Date.now()))
      // No BOM on the clipboard: pasted text would start with an invisible character.
      await navigator.clipboard.writeText(csv.replace(/^﻿/, ''))
      setCsvStatus({ text: copiedText(csvRowCount(csv)), failed: false })
    } catch (e) {
      setCsvStatus({ text: `Could not copy: ${cleanIpcError(e)}`, failed: true })
    } finally {
      setCsvBusy(false)
    }
  }, [projectId, range])

  const saveCsv = useCallback(async () => {
    setCsvBusy(true)
    try {
      const csv = await window.orgai.runs.usageCsv(queryFor(projectId, range, Date.now()))
      // Exactly one BOM (main already writes one) keeps spreadsheet apps from misreading non-ASCII titles.
      const url = URL.createObjectURL(new Blob(['﻿', csv.replace(/^﻿/, '')], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = csvFileName(projectName, range)
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      // The renderer cannot see where or whether the download finishes, so the notice says only what is known.
      setCsvStatus({ text: 'Your browser is saving the CSV.', failed: false })
    } catch (e) {
      setCsvStatus({ text: `Could not save: ${cleanIpcError(e)}`, failed: true })
    } finally {
      setCsvBusy(false)
    }
  }, [projectId, range, projectName])

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    window.orgai.runs
      .usageStats({ ...queryFor(projectId, range, Date.now()), bucket })
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
  }, [projectId, rangeKey, bucket, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  return (
    <div className="trends" data-testid="usage-trends">
      <div className="trends-controls" data-testid="trends-controls">
        <SegmentedControl<RangeChoice>
          label="Range"
          value={range.kind === 'month' ? 'month' : (String(range.days) as RangeChoice)}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
            { value: 'month', label: 'Month' }
          ]}
          onChange={pickRange}
        />
        {range.kind === 'month' && (
          // ui/Select takes no test id, so this is the same native select on the same class.
          <select className="select" aria-label="Month" data-testid="trends-month" value={range.month} onChange={(e) => pickMonth(e.target.value)}>
            {months.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        <SegmentedControl<TrendBucket>
          label="Group by"
          value={bucket}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' }
          ]}
          onChange={setBucket}
        />
        <div className="trends-csv">
          <Button icon={ClipboardCopy} size="sm" disabled={!stats || noRuns || csvBusy} onClick={() => void copyCsv()} testId="trends-copy-csv">
            Copy as CSV
          </Button>
          <Button icon={Download} size="sm" disabled={!stats || noRuns || csvBusy} onClick={() => void saveCsv()} testId="trends-save-csv">
            Save CSV...
          </Button>
          <p
            key={csvStatus?.failed ? 'failed' : 'ok'}
            className={`trends-csv-status${csvStatus?.failed ? ' failed' : ''}`}
            role={csvStatus?.failed ? 'alert' : 'status'}
            data-testid="trends-csv-status"
          >
            {csvStatus?.text ?? ''}
          </p>
        </div>
      </div>
      <p className="trends-see-all">
        <button type="button" className="link-btn" data-testid="trends-see-all" onClick={() => openUsage({ projectIds: [projectId], ...usagePeriodFor(range) })}>
          See all projects
          <Icon icon={ArrowUpRight} size="xs" />
        </button>
      </p>
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
            title="No runs in this range"
            description="Usage appears here once a run has spent tokens. Try another range."
            testId="trends-empty"
          />
        ) : (
          <TrendsBody stats={stats} range={range} bucket={bucket} metric={metric} onMetric={setMetric} stale={loading} />
        )}
      </div>
    </div>
  )
}

function TrendsBody({
  stats,
  range,
  bucket,
  metric,
  onMetric,
  stale
}: {
  stats: UsageStats
  range: TrendsRange
  bucket: TrendBucket
  metric: TrendMetric
  onMetric: (m: TrendMetric) => void
  stale: boolean
}): ReactElement {
  const { totals } = stats
  const points = useMemo(() => {
    const span = chartSpan(range, stats.generatedAt)
    return fillBuckets(stats.trend, span.since, span.until, bucket)
  }, [stats, range, bucket])
  const summaries = useProjectSummaries()
  const summaryById = useMemo(() => new Map(summaries.map((s) => [s.id, s])), [summaries])
  const kinds = useMemo(() => groupByKind(stats.runs, (id) => summaryById.get(id)), [stats.runs, summaryById])
  const fractions = useMemo(() => barFractions(points.map((p) => pointValue(p, metric))), [points, metric])
  const roles = useMemo(() => mergeRoleRows(stats.roles).sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)), [stats.roles])
  const roleShares = useMemo(() => shares(roles.map((r) => totalTokens(r.tokens))), [roles])
  const totalCost: CostInput = { ...totals, sourceMixed: true }

  const unit = bucket === 'week' ? 'week' : 'day'
  const summary =
    `${metric === 'tokens' ? 'Tokens' : 'Cost'} per ${unit}, ${points.length} ${unit}s. ` +
    `Total ${formatTokens(totalTokens(totals.tokens))} tokens across ${stats.runs.length} runs.`

  return (
    <div className="trends-body" data-stale={stale || undefined}>
      <p className="trends-note trends-scope" data-testid="trends-scope">
        Every run in this range: work, setup, Ask and saved chats.
      </p>
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
          <dt>Estimated cost</dt>
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

      <section className="trends-section" aria-labelledby="trends-kinds-h">
        <div className="trends-section-head">
          <h3 id="trends-kinds-h">By kind</h3>
        </div>
        <div className="trends-table-wrap">
          <table className="history-table trends-table trends-kinds" aria-label="Usage per kind of run" data-testid="trends-kinds">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col" className="num">
                  Runs
                </th>
                <th scope="col" className="num">
                  Tokens
                </th>
                <th scope="col" className="num">
                  Estimated cost
                </th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((k) => (
                <tr key={k.label} data-kind={k.label}>
                  <th scope="row">{k.label}</th>
                  <td className="num">{k.runs}</td>
                  <td className="num">{formatTokens(totalTokens(k.tokens))}</td>
                  <td className="num">
                    <Cost
                      value={
                        k.costUsd === null
                          ? { costUsd: null, costSource: 'unknown' }
                          : { costUsd: k.costUsd, costSource: 'provider', sourceMixed: true, ...(k.costUnknownRuns > 0 ? { costPartial: true } : {}) }
                      }
                    />
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

