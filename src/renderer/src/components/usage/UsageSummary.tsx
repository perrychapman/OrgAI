import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { costView, formatDuration, formatTokens } from '../../lib/cost'
import { useReducedMotion } from '../../lib/canvas'
import { tokenMs } from '../../lib/useExitPresence'
import { useTweenedNumber } from '../../lib/useTweenedNumber'
import { parseDurationText, parseTokenText } from '../../lib/tween'
import { PARTIAL_COST_TITLE, type CostCoverage, type SummaryItemModel, type SummarySignal } from '../../lib/usagePage'
import {
  KPI_METRIC,
  deltaChip,
  deltaVs,
  pricedChip,
  sparkDrawable,
  sparkSignal,
  type SparkPoint
} from '../../lib/usageDashboard'
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

/** The number a tile's figure stands for (null = unknown or not numeric: it never tweens). The item carries text, so parse it back. */
function figureNumber(i: SummaryItemModel): number | null {
  switch (i.signal) {
    case 'cost': {
      // Only a known or lower-bound figure tweens; unknown or nothing spent never counts up from a made-up number.
      if (!i.cost) return null
      const kind = costView(i.cost, { precision: 'page' }).kind
      return kind === 'known' || kind === 'partial' ? (i.cost.costUsd ?? null) : null
    }
    case 'tokens':
      return i.text === undefined ? null : parseTokenText(i.text)
    case 'runs': {
      const n = i.text === undefined ? NaN : Number(i.text)
      return Number.isFinite(n) ? n : null
    }
    case 'wall':
      return i.text === undefined ? null : parseDurationText(i.text)
    default:
      return null
  }
}

/** The item as it reads while a tween shows `v` (same formatters as the final figure). */
function figureAt(i: SummaryItemModel, v: number): SummaryItemModel {
  switch (i.signal) {
    case 'cost':
      return i.cost ? { ...i, cost: { ...i.cost, costUsd: v } } : i
    case 'tokens':
      return { ...i, text: formatTokens(Math.round(v)) }
    case 'runs':
      return { ...i, text: String(Math.round(v)) }
    case 'wall':
      return { ...i, text: formatDuration(v) }
    default:
      return i
  }
}

/** One bucket's value for the scrub text ("$0.0043", "6.0k", "no price"). */
function scrubValue(signal: SummarySignal, p: SparkPoint | undefined): string {
  if (!p) return ''
  if (p.kind === 'unknown') return 'no price'
  if (p.kind === 'empty') return signal === 'runs' ? '0 runs' : 'no runs'
  if (p.value === null) return 'not reported'
  switch (signal) {
    case 'cost':
      return costView({ costUsd: p.value, costSource: 'computed', ...(p.kind === 'partial' ? { costPartial: true } : {}) }, { precision: 'page' }).text
    case 'tokens':
      return formatTokens(Math.round(p.value))
    case 'runs':
      return `${p.value} ${p.value === 1 ? 'run' : 'runs'}`
    case 'wall':
      return formatDuration(p.value)
    default:
      return String(p.value)
  }
}

export interface UsageTokenSplit {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * The KPI band: four tiles in one borderless row. Cost, Tokens and Runs are also the chart's metric switch (native
 * toggle buttons, aria-pressed); a 2 px bar slides to the pressed tile. Each tile shows its figure (it eases to a new
 * value after a user-triggered change), a glyph-and-sign delta chip and a full-width sparkline that can be read by
 * pointer. The spend chart is the keyboard path to per-day values.
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
  tokens,
  bucketLabels,
  onScrub,
  tweenKey,
  unpricedNote
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
  /** Bucket slot labels for the scrub text, same index as the spark points ("2 Nov"). */
  bucketLabels: string[]
  /** Sparkline scrub: pointer over a tile's sparkline reports the bucket slot index, null on leave. */
  onScrub: (i: number | null) => void
  /** Bumped by the view on every user-triggered filter or metric change; numbers tween only when this changed since the last value change (never first paint, never a poll refresh). */
  tweenKey: number
  /** Unpriced explanation for the "7 of 10 priced" popover (the view passes notes.partial or similar text, may be null). */
  unpricedNote: string | null
}): ReactElement {
  const reduced = useReducedMotion()
  const durationMs = useMemo(() => tokenMs('--dur-slow') || 260, [])
  const [scrub, setScrub] = useState<{ signal: SummarySignal; i: number } | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)

  const place = (animate: boolean): void => {
    const ul = listRef.current
    const bar = barRef.current
    if (!ul || !bar) return
    const on = ul.querySelector<HTMLElement>('[aria-pressed="true"]')?.closest<HTMLElement>('li')
    if (!on) {
      bar.dataset.hidden = 'true'
      return
    }
    delete bar.dataset.hidden
    if (!animate) bar.style.transition = 'none'
    bar.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px) scaleX(${on.offsetWidth / 100})`
    if (!animate) {
      void bar.offsetWidth
      bar.style.transition = ''
    }
    bar.dataset.ready = 'true'
  }
  const first = useRef(true)
  useLayoutEffect(() => {
    // The first measure places the bar without gliding; a later metric change glides.
    place(!first.current)
    first.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metric, items.length])
  useLayoutEffect(() => {
    const ul = listRef.current
    if (!ul || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => place(false))
    ro.observe(ul)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="usage-summary-wrap" role="group" aria-label="Key figures. Cost, Tokens and Runs choose what the chart shows.">
      <ul ref={listRef} className="usage-kpi" data-testid="usage-summary">
        {items.map((i) => (
          <Tile
            key={i.signal}
            item={i}
            coverage={coverage}
            modelChip={modelChip}
            onNoPrice={onNoPrice}
            points={spark[i.signal]}
            bucketWord={bucketWord}
            metric={metric}
            onMetric={onMetric}
            tokens={tokens}
            bucketLabels={bucketLabels}
            scrubIndex={scrub && scrub.signal === i.signal ? scrub.i : null}
            onScrub={(n) => {
              setScrub(n === null ? null : { signal: i.signal, i: n })
              onScrub(n)
            }}
            tweenKey={tweenKey}
            reduced={reduced}
            durationMs={durationMs}
            unpricedNote={unpricedNote}
          />
        ))}
      </ul>
      <span ref={barRef} className="usage-kpi-indicator" data-testid="usage-kpi-indicator" aria-hidden="true" />
    </div>
  )
}

function Tile({
  item: i,
  coverage,
  modelChip,
  onNoPrice,
  points,
  bucketWord,
  metric,
  onMetric,
  tokens,
  bucketLabels,
  scrubIndex,
  onScrub,
  tweenKey,
  reduced,
  durationMs,
  unpricedNote
}: {
  item: SummaryItemModel
  coverage: CostCoverage | null
  modelChip: string | null
  onNoPrice: () => void
  points: SparkPoint[] | undefined
  bucketWord: string
  metric: Metric
  onMetric: (m: Metric) => void
  tokens: UsageTokenSplit
  bucketLabels: string[]
  scrubIndex: number | null
  onScrub: (i: number | null) => void
  tweenKey: number
  reduced: boolean
  durationMs: number
  unpricedNote: string | null
}): ReactElement {
  const descId = useId()
  const m = KPI_METRIC[i.signal]
  const pressed = m !== undefined && metric === m
  const final = figure(i)
  const target = figureNumber(i)
  const shown = useTweenedNumber(target, { key: tweenKey, reduced, durationMs })
  const live = shown !== null && target !== null && shown !== target ? figure(figureAt(i, shown)) : final
  const chip = deltaChip(i.delta)
  const vs = deltaVs(i.delta)
  const sig = sparkSignal(i.signal)
  const drawable = sig && points && sparkDrawable(points) ? points : null
  const split =
    i.signal === 'tokens'
      ? `in ${formatTokens(tokens.input)} · out ${formatTokens(tokens.output)}, cache read ${formatTokens(tokens.cacheRead)}, cache write ${formatTokens(tokens.cacheWrite)}`
      : ''
  const title = [final.title, split].filter(Boolean).join(' ') || undefined
  const hint = drawable ? `Point at the sparkline to read a ${bucketWord.replace(/^per /, '')}; the chart is the keyboard path.` : ''
  // aria-describedby replaces the title as the description, so the figure's own title (model cost, lower bound) joins it.
  const description = [final.title, split, hint].filter(Boolean).join('. ')
  const scrubPoint = drawable && scrubIndex !== null ? drawable[scrubIndex] : undefined
  const scrubText = scrubPoint ? `${bucketLabels[scrubIndex ?? 0] ?? ''} · ${scrubValue(i.signal, scrubPoint)}` : null
  const priced = i.signal === 'cost' && coverage ? (pricedChip(coverage.line) ?? coverage.line) : null

  const body = (
    <>
      <span className="usage-kpi-label" data-chip={priced ? 'true' : undefined}>
        {i.label}
        {i.signal === 'cost' && modelChip && <span className="usage-summary-model">{modelChip}</span>}
      </span>
      <span className="usage-kpi-row">
        <span className="usage-kpi-value" title={final.title} aria-hidden="true" data-testid="usage-kpi-value">
          {live.text}
        </span>
        <span className="sr-only">{final.text}</span>
        <span className="usage-kpi-chip-slot" aria-hidden="true">
          {scrubText !== null ? (
            <span className="usage-kpi-scrub" data-testid="usage-kpi-scrub">
              {scrubText}
            </span>
          ) : chip ? (
            <span className="usage-kpi-delta usage-delta" title={i.delta ?? undefined}>
              <span className="usage-kpi-chip" data-direction={chip.glyph}>
                <span className="usage-kpi-glyph">{chip.glyph}</span> {chip.text}
              </span>
              {vs && <span className="usage-kpi-vs"> {vs}</span>}
            </span>
          ) : (
            <span className="usage-kpi-delta usage-kpi-nodelta">{i.deltaNote ?? 'no prior data'}</span>
          )}
        </span>
        {i.delta && <span className="sr-only">, {i.delta}</span>}
      </span>
    </>
  )

  return (
    <li
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
          aria-describedby={description ? descId : undefined}
          onClick={() => onMetric(m)}
          data-testid="usage-kpi-metric"
          data-metric={m}
          title={title}
        >
          {body}
        </button>
      ) : (
        <div className="usage-kpi-main" title={title}>
          {body}
        </div>
      )}
      {description && (
        <span id={descId} className="sr-only">
          {description}
        </span>
      )}
      {priced && coverage && (
        <span className="usage-kpi-coverage" data-testid="usage-coverage">
          <button
            type="button"
            className="usage-kpi-priced"
            onClick={onNoPrice}
            data-testid="usage-no-price-link"
            title={[coverage.noPriceLabel, unpricedNote].filter(Boolean).join('. ')}
          >
            {priced}
            <span className="sr-only">. {coverage.noPriceLabel}. Show them.</span>
          </button>
        </span>
      )}
      {/* Always present (empty when no sparkline) so the tiles keep one height. */}
      <span className="usage-kpi-spark-wrap">
        {drawable && <Sparkline points={drawable} active={scrubIndex} onScrub={onScrub} />}
      </span>
    </li>
  )
}
