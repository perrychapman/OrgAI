import type { ReactElement, ReactNode } from 'react'
import { costView, formatTokens } from '../../lib/cost'
import { PARTIAL_COST_TITLE, type CostCoverage, type SummaryItemModel, type SummarySignal } from '../../lib/usagePage'
import { KPI_METRIC, deltaDirection, shortDelta, sparkSignal, type SparkPoint } from '../../lib/usageDashboard'
import type { Metric } from '../../lib/usageCharts'
import Sparkline from './Sparkline'
import '../../styles/usage-kpi.css'

function figure(i: SummaryItemModel): { text: string; title?: string } {
  if (i.cost) {
    const v = costView(i.cost, { precision: 'page' })
    if (v.kind === 'unknown' && i.noPriceText) return { text: i.noPriceText, ...(v.title ? { title: v.title } : {}) }
    // "At least" already says it is a lower bound, so the "+" goes (never "At least $4.20+").
    const atLeast = i.atLeast && v.kind !== 'unknown' && v.kind !== 'none'
    const text = atLeast ? `At least ${v.text.replace(/\+$/, '')}` : v.text
    const partial = i.atLeast || v.kind === 'partial' ? PARTIAL_COST_TITLE : ''
    const title = [i.title, v.title, partial].filter(Boolean).join(' ')
    return { text, ...(title ? { title } : {}) }
  }
  if (i.text !== undefined) return { text: `${i.text}${i.atLeast ? '+' : ''}`, ...(i.title ? { title: i.title } : {}) }
  return { text: i.noPriceText ?? '—', ...(i.title ? { title: i.title } : {}) }
}

const ARROW = { up: '↑', down: '↓', same: '→' } as const

export interface UsageTokenSplit {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * The KPI band: six figures in one borderless row. Cost, Tokens and Runs are also the chart's metric switch
 * (native toggle buttons, aria-pressed). Each shows a text delta against the previous equal span and, when the
 * view supplies points, a sparkline.
 */
export default function UsageSummary({
  items,
  coverage,
  modelChip,
  onNoPrice,
  spark,
  bucketWord,
  metric,
  onMetric,
  tokens
}: {
  items: readonly SummaryItemModel[]
  coverage: CostCoverage | null
  /** The model chip's id: the cost label reads "Model cost" and names it. */
  modelChip: string | null
  onNoPrice: () => void
  /** Per-signal sparkline points from the chart's bucket slots. Missing key = no sparkline. */
  spark: Partial<Record<SummarySignal, SparkPoint[]>>
  /** "per day" / "per week" / "per month": for the sparkline's title text only. */
  bucketWord: string
  metric: Metric
  onMetric: (m: Metric) => void
  tokens: UsageTokenSplit
}): ReactElement {
  return (
    <div className="usage-summary-wrap">
      <ul
        className="usage-kpi"
        data-testid="usage-summary"
        role="group"
        aria-label="Key figures. Cost, Tokens and Runs choose what the chart shows."
      >
        {items.map((i) => {
          const f = figure(i)
          const m = KPI_METRIC[i.signal]
          const dir = deltaDirection(i.delta ?? null)
          const sig = sparkSignal(i.signal)
          const pts = sig ? spark[i.signal] : undefined
          const pressed = m !== undefined && metric === m
          const label = (
            <span className="usage-kpi-label">
              {i.label}
              {i.signal === 'cost' && modelChip && <span className="usage-summary-model">{modelChip}</span>}
            </span>
          )
          const value = (
            <span className="usage-kpi-value" title={f.title}>
              {f.text}
            </span>
          )
          const delta: ReactNode = i.delta ? (
            <span className="usage-kpi-delta usage-delta" title={i.delta}>
              {dir && (
                <span className="usage-kpi-arrow" aria-hidden="true">
                  {ARROW[dir]}
                </span>
              )}
              <span aria-hidden="true">{shortDelta(i.delta)}</span>
              <span className="sr-only">{i.delta}</span>
            </span>
          ) : null
          return (
            <li
              key={i.signal}
              className="usage-kpi-item"
              data-testid="usage-summary-item"
              data-signal={i.signal}
              data-on-chart={pressed ? 'true' : undefined}
            >
              {m ? (
                <button
                  type="button"
                  className="usage-kpi-main usage-kpi-switch"
                  aria-pressed={pressed}
                  onClick={() => onMetric(m)}
                  data-testid="usage-kpi-metric"
                  data-metric={m}
                  title={i.signal === 'cost' ? i.title : undefined}
                >
                  {label}
                  {value}
                  {delta}
                  {pressed && <span className="usage-kpi-on">On chart</span>}
                </button>
              ) : (
                <div className="usage-kpi-main" title={i.signal === 'cost' ? i.title : undefined}>
                  {label}
                  {value}
                  {delta}
                </div>
              )}
              {i.signal === 'tokens' && (
                <p
                  className="usage-kpi-sub"
                  title={`Cache read ${formatTokens(tokens.cacheRead)} · cache write ${formatTokens(tokens.cacheWrite)}`}
                >
                  in {formatTokens(tokens.input)} · out {formatTokens(tokens.output)}
                </p>
              )}
              {i.signal === 'cost' && coverage && (
                <p className="usage-kpi-sub" data-testid="usage-coverage">
                  <span>{coverage.line}</span>
                  <button type="button" className="usage-text-link" onClick={onNoPrice} data-testid="usage-no-price-link">
                    {coverage.noPriceLabel}
                  </button>
                </p>
              )}
              {/* Always present (empty for Cost per run, which has no per-bucket figure) so sparklines share one baseline. */}
              <span className="usage-kpi-spark-wrap" title={pts ? `${i.label} ${bucketWord}` : undefined}>
                {pts && <Sparkline points={pts} />}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
