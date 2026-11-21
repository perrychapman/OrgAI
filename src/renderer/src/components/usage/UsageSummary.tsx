import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { costView, formatDuration, formatTokens } from '../../lib/cost'
import { useReducedMotion } from '../../lib/canvas'
import { useCountUp } from '../../lib/useCountUp'
import { definitionOf } from '../../lib/usageDefinitions'
import type { CostCoverage, SummaryItemModel, SummarySignal } from '../../lib/usagePage'
import { KPI_METRIC, deltaChip, deltaVs, pricedChip, sparkDrawable, sparkSignal, type SparkPoint } from '../../lib/usageDashboard'
import type { Metric } from '../../lib/usageCharts'
import Sparkline from './Sparkline'
import DefinedTerm, { DefinitionTip, tipHandlers } from './DefinedTerm'
import { figure, figureAt, figureNumber } from './kpiFigure'
import { useDrawKey } from './useDrawKey'
import '../../styles/usage-kpi.css'

/** One bucket's value for the scrub text ("$0.0043", "6.0k", "not priced"). */
function scrubValue(signal: SummarySignal, p: SparkPoint | undefined): string {
  if (!p) return ''
  if (p.kind === 'unknown') return 'not priced'
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
 * The definition a tile's label carries. Wall time says how it differs from the Dashboard's Agent time (baseline UX
 * finding 2): wall time is the clock time runs were open, Agent time is the time agents spent working.
 */
export function kpiDefinition(signal: SummarySignal): string {
  if (signal === 'cost') return definitionOf('Estimated cost')
  if (signal === 'wall') {
    return `${definitionOf('Wall time')} It is not the Dashboard's Agent time, which leaves out time a run was idle or waiting on you.`
  }
  return ''
}

/**
 * The KPI band: four tiles in one hairline-separated row. Cost, Tokens and Runs are also the chart's metric switch
 * (native toggle buttons, aria-pressed); a 2 px bar slides to the pressed tile. Wall time is a static figure that is
 * still a keyboard stop, so its definition is reachable. Each tile shows its figure (it counts up on arrival and tweens
 * after), a glyph-and-sign delta chip and a full-width area sparkline that can be read by pointer. The spend chart is
 * the keyboard path to per-day values.
 */
export default function UsageSummary({
  items,
  coverage,
  modelChip,
  onNoPrice,
  spark,
  metric,
  onMetric,
  tokens,
  bucketLabels,
  onScrub,
  arriving,
  drawSeq,
  unpricedNote
}: {
  items: readonly SummaryItemModel[]
  coverage: CostCoverage | null
  /** The model chip's id: the cost label reads "Model cost" and names it. */
  modelChip: string | null
  onNoPrice: () => void
  /** Per-signal sparkline points from the chart's bucket slots. Missing key = no sparkline. */
  spark: Partial<Record<SummarySignal, SparkPoint[]>>
  metric: Metric
  onMetric: (m: Metric) => void
  tokens: UsageTokenSplit
  /** Bucket slot labels for the scrub text, same index as the spark points ("2 Nov"). */
  bucketLabels: string[]
  /** Sparkline scrub: pointer over a tile's sparkline reports the bucket slot index, null on leave. */
  onScrub: (i: number | null) => void
  /** The page is staging its arrival: figures count up from zero, sparklines wipe in. */
  arriving: boolean
  /** Bumped by the view on every filter change the person makes: sparklines draw again once the new data is in. */
  drawSeq: number
  /** Unpriced explanation for the "7 of 10 priced" popover (the view passes notes.partial or similar text, may be null). */
  unpricedNote: string | null
}): ReactElement {
  const [scrub, setScrub] = useState<{ signal: SummarySignal; i: number } | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)
  const hintId = useId()

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
    <div
      className={arriving ? 'usage-summary-wrap motion-arrive-band' : 'usage-summary-wrap'}
      style={{ '--i': 0 } as CSSProperties}
      role="group"
      aria-label="Key figures"
      aria-describedby={hintId}
    >
      <span id={hintId} className="sr-only">
        Cost, Tokens and Runs choose what the chart shows.
      </span>
      <ul ref={listRef} className="usage-kpi" data-testid="usage-summary">
        {items.map((i, index) => (
          <Tile
            key={i.signal}
            item={i}
            index={index}
            coverage={coverage}
            modelChip={modelChip}
            onNoPrice={onNoPrice}
            points={spark[i.signal]}
            metric={metric}
            onMetric={onMetric}
            tokens={tokens}
            bucketLabels={bucketLabels}
            scrubIndex={scrub && scrub.signal === i.signal ? scrub.i : null}
            onScrub={(n) => {
              setScrub(n === null ? null : { signal: i.signal, i: n })
              onScrub(n)
            }}
            arriving={arriving}
            drawSeq={drawSeq}
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
  index,
  coverage,
  modelChip,
  onNoPrice,
  points,
  metric,
  onMetric,
  tokens,
  bucketLabels,
  scrubIndex,
  onScrub,
  arriving,
  drawSeq,
  unpricedNote
}: {
  item: SummaryItemModel
  index: number
  coverage: CostCoverage | null
  modelChip: string | null
  onNoPrice: () => void
  points: SparkPoint[] | undefined
  metric: Metric
  onMetric: (m: Metric) => void
  tokens: UsageTokenSplit
  bucketLabels: string[]
  scrubIndex: number | null
  onScrub: (i: number | null) => void
  arriving: boolean
  drawSeq: number
  unpricedNote: string | null
}): ReactElement {
  const descId = useId()
  const reduced = useReducedMotion()
  const m = KPI_METRIC[i.signal]
  const pressed = m !== undefined && metric === m
  const final = figure(i)
  const target = figureNumber(i)
  // Counts up from zero on arrival; later changes tween. Unknown never counts up and is never tweened from.
  const shown = useCountUp(target, { arriving, still: reduced })
  const live = shown !== null && target !== null && shown !== target ? figure(figureAt(i, shown)) : final
  const chip = deltaChip(i.delta)
  const vs = deltaVs(i.delta)
  const sig = sparkSignal(i.signal)
  const drawable = sig && points && sparkDrawable(points) ? points : null
  const split =
    i.signal === 'tokens'
      ? `in ${formatTokens(tokens.input)} · out ${formatTokens(tokens.output)}, cache read ${formatTokens(tokens.cacheRead)}, cache write ${formatTokens(tokens.cacheWrite)}`
      : ''
  const definition = kpiDefinition(i.signal)
  // The tip and the description are one text: the figure's own note (model cost, lower bound), the token split, the
  // definition. No title attribute: it would be a second tooltip over the first.
  const description = [final.title, split, definition].filter(Boolean).join(' ')
  const scrubPoint = drawable && scrubIndex !== null ? drawable[scrubIndex] : undefined
  const scrubText = scrubPoint ? `${bucketLabels[scrubIndex ?? 0] ?? ''} · ${scrubValue(i.signal, scrubPoint)}` : null
  const priced = i.signal === 'cost' && coverage ? (pricedChip(coverage.line) ?? coverage.line) : null
  const { draw, key } = useDrawKey(drawSeq, drawable ? drawable.map((p) => p.value ?? 'x').join(',') : '', arriving)
  const deltaWords = i.delta ?? i.deltaNote ?? ''

  // A tile that is a button carries its definition in the button's description. A static tile (Wall time) has no button of
  // its own, so its label is the defined term: a native button whose tip is the definition, and the value is plain text
  // read once beside it.
  const staticTerm = !m && !!description
  const body = (
    <>
      <span className="usage-kpi-label" data-chip={priced ? 'true' : undefined} data-defined={definition ? 'true' : undefined}>
        {staticTerm ? (
          <DefinedTerm text={description} align={index >= 2 ? 'end' : 'start'} testId="usage-kpi-term">
            {i.label}
          </DefinedTerm>
        ) : (
          i.label
        )}
        {i.signal === 'cost' && modelChip && <span className="usage-summary-model">{modelChip}</span>}
      </span>
      <span className="usage-kpi-row">
        <span className="usage-kpi-value" aria-hidden="true" data-testid="usage-kpi-value">
          {live.text}
        </span>
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
        {/* The final figure for assistive tech: the counting frames above are aria-hidden and never announced. */}
        <span className="sr-only">
          {final.text}
          {deltaWords ? `, ${deltaWords}` : ''}
        </span>
      </span>
    </>
  )

  return (
    <li
      className="usage-kpi-item"
      data-testid="usage-summary-item"
      data-signal={i.signal}
      data-on-chart={pressed ? 'true' : undefined}
      data-tip-host=""
      data-align={index >= 2 ? 'end' : 'start'}
      style={{ '--i': index } as CSSProperties}
      onKeyDown={tipHandlers.onKeyDown}
      onBlur={tipHandlers.onBlur}
      onPointerLeave={tipHandlers.onPointerLeave}
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
        >
          {body}
        </button>
      ) : (
        // A static figure: no role, no label of its own (a group's name would read the value a second time). Its
        // definition is reachable through the label button.
        <div className="usage-kpi-main usage-kpi-static" data-testid="usage-kpi-static">
          {body}
        </div>
      )}
      {description && m && <DefinitionTip id={descId} text={description} className="usage-kpi-tip" />}
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
        {drawable && <Sparkline key={key} points={drawable} active={scrubIndex} onScrub={onScrub} area draw={draw} />}
      </span>
    </li>
  )
}
