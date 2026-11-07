import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import { costView, formatTokens } from '../../lib/cost'
import { SegmentedControl } from '../ui/SegmentedControl'
import { bucketEnd, bucketPickOf } from '../../lib/usageOverview'
import {
  allUnpriced,
  axisLabel,
  barHeight,
  barState,
  barWidth,
  bucketLabel,
  clipMiddle,
  costFigureText,
  fillBuckets,
  formatTick,
  niceTicks,
  OTHER_KEY,
  otherNames,
  readoutText,
  rollupCost,
  segmentReadout,
  segmentsOf,
  slotWidth,
  stackMax,
  thinLabels,
  tokenSum,
  type BarState,
  type BucketSlot,
  type Metric,
  type Segment
} from '../../lib/usageCharts'
import type { UsagePanelProps } from './panelProps'
import { ChartTable } from './ChartTable'
import { CostText } from './RankedBars'
import '../../styles/usage-charts.css'

const GUTTER = 48
const RIGHT_PAD = 4
const TOP_PAD = 6
const STUB_LANE = 10
const LABEL_ROW = 20
const WIDE_PANEL_PX = 720
const LEGEND_PX = 220
const SERIES_VAR = ['--chart-s1', '--chart-s2', '--chart-s3', '--chart-s4', '--chart-s5']
const fillOf = (series: number): string => (series >= 0 ? `var(${SERIES_VAR[series]})` : 'var(--chart-other)')

interface Cursor {
  /** Bucket slot index. */
  i: number
  /** Segment index in the bucket's stack, or null for the bucket itself. */
  s: number | null
}

interface Bar {
  slot: BucketSlot
  segments: Segment[]
  state: BarState
  notLoaded: boolean
}

export default function SpendPanel({ data, overview, filters, bucket, span, series, onNarrow, announce, periodTrend, onClearBucket }: UsagePanelProps): ReactElement {
  // A day pick narrows data.trend to that bucket; the chart keeps the whole period (the pick stays outlined, the rest dims).
  const trend = periodTrend ?? data.trend
  const hatchId = `ucsp${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const rootRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const [rootW, setRootW] = useState(900)
  const [chosen, setChosen] = useState<Metric | null>(null)
  const [focus, setFocus] = useState<Cursor | null>(null)
  const [hover, setHover] = useState<Cursor | null>(null)
  const [rove, setRove] = useState<number | null>(null)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setRootW(Math.round(el.getBoundingClientRect().width)))
    setRootW(Math.round(el.getBoundingClientRect().width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const unpriced = useMemo(() => allUnpriced(trend), [trend])
  const metric: Metric = chosen ?? (unpriced ? 'tokens' : 'cost')
  const names = useMemo(() => new Map([...overview.projects, ...data.projects].map((p) => [p.projectId, p.projectName])), [overview.projects, data.projects])
  const nameOf = (key: string, seg?: Segment): string =>
    key === OTHER_KEY ? `Other (${seg?.projects ?? 0} ${seg?.projects === 1 ? 'project' : 'projects'})` : (names.get(key) ?? 'Removed project')

  const bars: Bar[] = useMemo(() => {
    const oldest = data.lowerBound ? overview.oldestIncludedAt : undefined
    return fillBuckets(trend, span.since, span.until, bucket).map((slot) => {
      const segments = slot.point ? segmentsOf(slot.point.byProject, series, metric) : []
      return {
        slot,
        segments,
        state: barState(segments, !!slot.point),
        notLoaded: oldest !== undefined && !slot.point && bucketEnd(slot.start, bucket) <= oldest
      }
    })
  }, [trend, data.lowerBound, overview.oldestIncludedAt, span.since, span.until, bucket, series, metric])

  const wide = rootW >= WIDE_PANEL_PX
  const totalH = wide ? 220 : 180
  const plotBoxW = wide ? rootW - LEGEND_PX - 16 : rootW
  const plotH = totalH - TOP_PAD - STUB_LANE - LABEL_ROW
  const n = bars.length
  const slot = slotWidth(n, plotBoxW - GUTTER - RIGHT_PAD)
  const innerW = Math.max(plotBoxW - GUTTER - RIGHT_PAD, n * slot)
  const svgW = GUTTER + innerW + RIGHT_PAD
  const bw = barWidth(slot)
  const baseY = TOP_PAD + plotH
  const ticks = niceTicks(stackMax(bars.map((b) => b.segments)))
  const labels = thinLabels(n, slot, 46)
  const selectedStart = filters.bucketPick && filters.bucketPick.size === bucket ? filters.bucketPick.start : filters.bucketPick ? bucketPickOf({ start: filters.bucketPick.start }, bucket).start : null
  const anyUnknown = bars.some((b) => b.segments.some((s) => s.state === 'unknown'))
  const anyPartial = bars.some((b) => b.segments.some((s) => s.state === 'partial'))

  const defaultRove = useMemo(() => {
    if (selectedStart !== null) {
      const at = bars.findIndex((b) => b.slot.start === selectedStart)
      if (at >= 0) return at
    }
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i]!.slot.point) return i
    return Math.max(0, bars.length - 1)
  }, [bars, selectedStart])
  const roving = rove !== null && rove < n ? rove : defaultRove

  const labelFor = (b: Bar): string => bucketLabel(b.slot.start, bucket)
  const barText = (b: Bar): string => {
    if (b.notLoaded) return `${labelFor(b)}: not loaded.`
    const p = b.slot.point
    if (!p) return `${labelFor(b)}: no runs.`
    const cost = rollupCost(p)
    return readoutText(labelFor(b), { runs: p.runs, cost, tokens: tokenSum(p.tokens) }, b.segments, nameOf, metric)
  }
  const segText = (b: Bar, s: Segment): string => segmentReadout(labelFor(b), nameOf(s.key, s), s, metric)

  const shown = focus ?? hover
  const readout = (() => {
    if (!shown) return n > 0 ? `${n} ${bucket === 'day' ? 'days' : bucket === 'week' ? 'weeks' : 'months'}. Hover or focus one for its figures.` : ''
    const b = bars[shown.i]
    if (!b) return ''
    const s = shown.s !== null ? b.segments[shown.s] : undefined
    return s ? segText(b, s) : barText(b)
  })()

  // The finding in words.
  const summary = (() => {
    const runs = data.totals.runs
    if (runs === 0) return 'No runs in this period.'
    const known = bars.filter((b) => b.segments.some((s) => s.value > 0))
    let best: Bar | null = null
    let bestV = 0
    for (const b of known) {
      const v = b.segments.reduce((a, s) => a + s.value, 0)
      if (v > bestV) {
        bestV = v
        best = b
      }
    }
    const busiest = best ? `; busiest ${bucket} ${bucket === 'week' ? 'from ' : ''}${axisLabel(best.slot.start, bucket)}, ${metric === 'tokens' ? `${formatTokens(bestV)} tokens` : costView({ costUsd: bestV, costSource: 'computed' }, { precision: 'page' }).text}` : ''
    if (metric === 'tokens') return `${formatTokens(tokenSum(data.totals.tokens))} tokens across ${runs} ${runs === 1 ? 'run' : 'runs'}${busiest}.`
    const total = costView(data.totals.cost, { precision: 'page' })
    if (total.kind === 'unknown') return `Cost unknown for ${runs} ${runs === 1 ? 'run' : 'runs'}: no price is known. Tokens are counted.`
    return `Estimated ${total.text} across ${runs} ${runs === 1 ? 'run' : 'runs'}${busiest}.`
  })()

  const focusEl = (i: number, s: number | null): void => {
    const sel = s === null ? `[data-i="${i}"][data-kind="bar"]` : `[data-i="${i}"][data-s="${s}"]`
    plotRef.current?.querySelector<SVGElement>(sel)?.focus()
  }

  const activate = (b: Bar, seg?: Segment): void => {
    if (!b.slot.point) {
      announce(barText(b))
      return
    }
    const pick = bucketPickOf({ start: b.slot.start }, bucket)
    onNarrow({ bucket: pick, ...(seg && seg.key !== OTHER_KEY ? { projectId: seg.key } : {}) })
  }

  const onKey = (e: KeyboardEvent<SVGElement>, i: number, s: number | null): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const b = bars[i]!
    const move = (ni: number): void => focusEl(Math.max(0, Math.min(n - 1, ni)), null)
    switch (e.key) {
      case 'ArrowLeft':
        move(i - 1)
        break
      case 'ArrowRight':
        move(i + 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(n - 1)
        break
      case 'ArrowUp':
        if (b.segments.length > 0) focusEl(i, s === null ? b.segments.length - 1 : Math.min(b.segments.length - 1, s + 1))
        break
      case 'ArrowDown':
        if (b.segments.length > 0) focusEl(i, s === null ? 0 : Math.max(0, s - 1))
        break
      case 'Escape':
        if (s !== null) focusEl(i, null)
        else if (filters.bucketPick && onClearBucket) onClearBucket()
        else return
        break
      case 'Enter':
      case ' ':
        activate(b, s !== null ? b.segments[s] : undefined)
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  // Legend: the projects that have a series colour (rank order), then Other.
  const legend = useMemo(() => {
    const own = data.projects.filter((p) => series.has(p.projectId)).sort((a, b) => series.get(a.projectId)! - series.get(b.projectId)!)
    const rest = data.projects.filter((p) => !series.has(p.projectId))
    return { own, rest }
  }, [data.projects, series])
  const other = otherNames(data.projects, series)
  const legendOtherCost = rollupCost({
    costUsd: legend.rest.some((p) => p.costUsd !== null) ? legend.rest.reduce((a, p) => a + (p.costUsd ?? 0), 0) : null,
    costKnownRuns: legend.rest.reduce((a, p) => a + p.costKnownRuns, 0),
    costUnknownRuns: legend.rest.reduce((a, p) => a + p.costUnknownRuns, 0)
  })

  // Table: one column per legend project (and Other).
  const tableCols = [
    { key: 'period', label: 'Period' },
    { key: 'runs', label: 'Runs', numeric: true },
    { key: 'tokens', label: 'Tokens', numeric: true },
    { key: 'cost', label: 'Cost', numeric: true },
    ...legend.own.map((p) => ({ key: p.projectId, label: p.projectName, numeric: true })),
    ...(legend.rest.length > 0 ? [{ key: OTHER_KEY, label: `Other (${legend.rest.length})`, numeric: true }] : [])
  ]
  const tableRows = bars
    .filter((b) => b.slot.point)
    .map((b) => {
      const p = b.slot.point!
      const costSegs = segmentsOf(p.byProject, series, 'cost')
      const cell = (key: string): ReactElement | string => {
        const s = costSegs.find((x) => x.key === key)
        return s ? <CostText value={s.cost} /> : '—'
      }
      return {
        key: String(b.slot.start),
        data: { bucket: b.slot.key },
        cells: [
          labelFor(b),
          p.runs,
          formatTokens(tokenSum(p.tokens)),
          <CostText key="c" value={rollupCost(p)} />,
          ...legend.own.map((pr) => cell(pr.projectId)),
          ...(legend.rest.length > 0 ? [cell(OTHER_KEY)] : [])
        ]
      }
    })

  const groupLabel = `Spend per ${bucket}, bar chart. Arrow keys move between ${bucket}s, Up and Down between projects, Enter narrows to the ${bucket} or project.`

  return (
    <section className="usage-panel uc-spend" aria-labelledby="usage-spend-h" data-testid="usage-spend" data-metric={metric}>
      <div className="usage-panel-head">
        <h2 id="usage-spend-h" tabIndex={-1}>
          Spend over time
        </h2>
        <p className="usage-panel-summary">{summary}</p>
        <div className="uc-metric" data-testid="usage-spend-metric">
          <SegmentedControl
            label="Chart shows"
            value={metric}
            options={[
              { value: 'cost', label: 'Cost' },
              { value: 'tokens', label: 'Tokens' }
            ]}
            onChange={setChosen}
          />
        </div>
      </div>
      <div ref={rootRef} className="uc-spend-body" data-wide={wide ? 'true' : 'false'}>
        <div className="uc-spend-chart">
          <div ref={plotRef} className="uc-spend-scroll">
            <div role="group" aria-label={groupLabel} className="uc-spend-plot" data-testid="usage-spend-plot" style={{ width: svgW }}>
              <svg
                width={svgW}
                height={totalH}
                viewBox={`0 0 ${svgW} ${totalH}`}
                className="uc-svg"
                focusable="false"
                onMouseLeave={() => setHover(null)}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(null)
                }}
              >
                <defs>
                  <pattern id={hatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="4" stroke="var(--chart-hatch)" strokeWidth="1.5" />
                  </pattern>
                </defs>
                <g aria-hidden="true">
                  {ticks.ticks.map((t) => {
                    const y = baseY - (t / ticks.max) * plotH
                    return (
                      <g key={t}>
                        <line x1={GUTTER} x2={svgW - RIGHT_PAD} y1={y} y2={y} className="uc-grid" />
                        <text x={GUTTER - 6} y={y + 4} textAnchor="end" className="uc-tick">
                          {formatTick(t, metric)}
                        </text>
                      </g>
                    )
                  })}
                  {bars.map((b, i) => (labels.has(i) ? (
                    <text key={b.slot.start} x={GUTTER + i * slot + slot / 2} y={totalH - 5} textAnchor={i === 0 && slot < 40 ? 'start' : i === n - 1 && slot < 40 ? 'end' : 'middle'} className="uc-tick">
                      {axisLabel(b.slot.start, bucket)}
                    </text>
                  ) : null))}
                </g>
                {bars.map((b, i) => {
                  const x0 = GUTTER + i * slot
                  const bx = x0 + (slot - bw) / 2
                  const selected = selectedStart === b.slot.start
                  const dim = selectedStart !== null && !selected
                  let cum = 0
                  const drawn = b.segments.filter((s) => s.state === 'known' || s.state === 'partial')
                  const stubs = b.segments.filter((s) => s.state === 'unknown')
                  return (
                    <g
                      key={b.slot.start}
                      data-testid="usage-spend-bar"
                      data-bucket={b.slot.key}
                      data-state={b.state}
                      data-i={i}
                      data-kind="bar"
                      data-not-loaded={b.notLoaded ? 'true' : undefined}
                      role="group"
                      aria-label={selected ? `${barText(b)} Selected.` : barText(b)}
                      tabIndex={i === roving ? 0 : -1}
                      className="uc-bar"
                      style={dim ? { opacity: 'var(--dim-opacity)' } : undefined}
                      onFocus={(e) => {
                        setRove(i)
                        if (e.target === e.currentTarget) setFocus({ i, s: null })
                      }}
                      onKeyDown={(e) => {
                        if (e.target === e.currentTarget) onKey(e, i, null)
                      }}
                      onMouseOver={() => setHover({ i, s: null })}
                      onClick={() => activate(b)}
                    >
                      <rect x={x0} y={TOP_PAD} width={slot} height={plotH + STUB_LANE} className="uc-hit" />
                      {b.notLoaded && <rect x={bx} y={TOP_PAD} width={bw} height={plotH} className="uc-notloaded" fill={`url(#${hatchId})`} />}
                      {drawn.map((s) => {
                        const h = barHeight(s.value, ticks.max, plotH)
                        const y = baseY - cum - h
                        cum += h
                        const si = b.segments.indexOf(s)
                        return (
                          <g key={s.key}>
                            <rect
                              x={bx}
                              y={y}
                              width={bw}
                              height={h}
                              fill={fillOf(s.series)}
                              className="uc-seg"
                              data-testid="usage-spend-segment"
                              data-project={s.key}
                              data-state={s.state}
                              data-i={i}
                              data-s={si}
                              role="button"
                              aria-label={segText(b, s)}
                              tabIndex={-1}
                              onFocus={() => {
                                setRove(i)
                                setFocus({ i, s: si })
                              }}
                              onKeyDown={(e) => onKey(e, i, si)}
                              onMouseOver={(e) => {
                                e.stopPropagation()
                                setHover({ i, s: si })
                              }}
                              onClick={(e) => {
                                e.stopPropagation()
                                activate(b, s)
                              }}
                            />
                            {s.state === 'partial' && <rect x={bx} y={y} width={bw} height={Math.min(8, h)} fill={`url(#${hatchId})`} className="uc-hatch" pointerEvents="none" />}
                          </g>
                        )
                      })}
                      {stubs.map((s, k) => {
                        const w = Math.max(3, bw / stubs.length - 1)
                        const si = b.segments.indexOf(s)
                        return (
                          <rect
                            key={s.key}
                            x={bx + k * (w + 1) + 0.5}
                            y={baseY + 3.5}
                            width={w - 1}
                            height={5}
                            fill="none"
                            className="uc-stub"
                            data-testid="usage-spend-segment"
                            data-project={s.key}
                            data-state="unknown"
                            data-i={i}
                            data-s={si}
                            role="button"
                            aria-label={segText(b, s)}
                            tabIndex={-1}
                            onFocus={() => {
                              setRove(i)
                              setFocus({ i, s: si })
                            }}
                            onKeyDown={(e) => onKey(e, i, si)}
                            onMouseOver={(e) => {
                              e.stopPropagation()
                              setHover({ i, s: si })
                            }}
                            onClick={(e) => {
                              e.stopPropagation()
                              activate(b, s)
                            }}
                          />
                        )
                      })}
                      {selected && <rect x={x0 + 1} y={TOP_PAD - 1} width={slot - 2} height={plotH + STUB_LANE + 2} className="uc-selected" />}
                    </g>
                  )
                })}
                <line x1={GUTTER} x2={svgW - RIGHT_PAD} y1={baseY} y2={baseY} className="uc-axis" />
              </svg>
            </div>
          </div>
          <p className="uc-readout" data-testid="usage-spend-readout">
            {readout}
          </p>
          {unpriced && metric === 'tokens' && chosen === null && <p className="uc-note">No prices known for this period; showing tokens.</p>}
          {unpriced && metric === 'cost' && <p className="uc-note">No prices are known for this period, so cost cannot be drawn. Choose Tokens to see the volume.</p>}
          {metric === 'cost' && !unpriced && (anyUnknown || anyPartial) && (
            <p className="uc-note">
              {anyPartial ? 'A hatched end is a lower bound: a run in it has no known price. ' : ''}
              {anyUnknown ? 'A dashed stub under the axis marks cost that is unknown; it adds nothing to the bars.' : ''}
            </p>
          )}
        </div>
        <ul className="uc-legend" data-testid="usage-spend-legend" aria-label="Projects in this chart">
          {legend.own.map((p) => {
            const idx = series.get(p.projectId)!
            const selectedProject = filters.projectIds.includes(p.projectId)
            return (
              <li key={p.projectId} className="uc-legend-row" data-series={idx}>
                <button
                  type="button"
                  className="uc-legend-btn"
                  data-testid="usage-spend-legend-row"
                  data-project={p.projectId}
                  aria-current={selectedProject ? 'true' : undefined}
                  title={`${p.projectName}: narrow to this project`}
                  onClick={() => onNarrow({ projectId: p.projectId })}
                >
                  <svg width="10" height="10" aria-hidden="true" focusable="false">
                    <rect width="10" height="10" rx="1" fill={fillOf(idx)} />
                  </svg>
                  <span className="uc-legend-name">{clipMiddle(p.projectName, 28)}</span>
                  <span className="uc-legend-value">{metric === 'tokens' ? `${formatTokens(tokenSum(p.tokens))}` : <CostText value={rollupCost(p)} />}</span>
                </button>
              </li>
            )
          })}
          {legend.rest.length > 0 && (
            <li className="uc-legend-row" data-series="other">
              <span className="uc-legend-btn uc-legend-static" data-testid="usage-spend-legend-other" title={`Smaller projects folded together: ${other.names}`}>
                <svg width="10" height="10" aria-hidden="true" focusable="false">
                  <rect width="10" height="10" rx="1" fill="var(--chart-other)" />
                </svg>
                <span className="uc-legend-name">Other ({other.count} {other.count === 1 ? 'project' : 'projects'})</span>
                <span className="uc-legend-value">
                  {metric === 'tokens' ? formatTokens(legend.rest.reduce((a, p) => a + tokenSum(p.tokens), 0)) : <CostText value={legendOtherCost} />}
                </span>
              </span>
            </li>
          )}
        </ul>
      </div>
      <ChartTable testId="usage-spend-table" caption="Spend over time by project" columns={tableCols} rows={tableRows} empty="No runs in this period." />
    </section>
  )
}
