import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { Check, Table } from 'lucide-react'
import type { UsageProjectRollup } from '@shared/types'
import { costView, formatTokens, type CostInput } from '../../lib/cost'
import { useReducedMotion } from '../../lib/canvas'
import { tokenMs } from '../../lib/useExitPresence'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { SegmentedControl } from '../ui/SegmentedControl'
import { bucketEnd, bucketPickOf, previousPeriodWords } from '../../lib/usageOverview'
import {
  axisLabel,
  barHeight,
  barState,
  bucketLabel,
  clipMiddle,
  fillBuckets,
  formatTick,
  niceTicks,
  OTHER_KEY,
  otherNames,
  rollupCost,
  segmentsOf,
  stackMax,
  thinLabels,
  tokenSum,
  type BarState,
  type BucketSlot,
  type Metric,
  type Segment
} from '../../lib/usageCharts'
import { alignPrevious, overlayFigure, overlayMax, visibleSegments, METRIC_WORD, type OverlayFigure, type SortValue } from '../../lib/usageDashboard'
import { hiddenCount, overlayDisabledReason, previousCellText, previousSortValue, previousTipText, runsLine, tooltipPlacement, unpricedRuns, visibleTotals, spendSummary } from '../../lib/usageSpend'
import {
  areaPath,
  crosshairModel,
  edgePath,
  kindRuns,
  linePaths,
  moveIndex,
  nearestIndex,
  pointStep,
  pointXs,
  runExtent,
  seriesTotals,
  stackAreas,
  stackOrder,
  type CrosshairModel
} from '../../lib/usageAreas'
import type { SpendInteractionProps, UsagePanelProps } from './panelProps'
import { ChartTable } from './ChartTable'
import { CostText } from './RankedBars'
import { useDrawGen } from './useDrawGen'
import '../../styles/usage-charts.css'

const GUTTER = 48
const RIGHT_PAD = 14
const TOP_PAD = 16
const STUB_LANE = 14
const STUB_H = 7
const LABEL_ROW = 20
const WIDE_PANEL_PX = 720
const SERIES_VAR = ['--chart-s1', '--chart-s2', '--chart-s3', '--chart-s4', '--chart-s5']
const fillOf = (series: number): string => (series >= 0 ? `var(${SERIES_VAR[series]})` : 'var(--chart-other)')

interface Bar {
  slot: BucketSlot
  /** The segments still drawn (hidden series removed). */
  segments: Segment[]
  state: BarState
  notLoaded: boolean
  /** The previous period's figure for this slot while the overlay is on. */
  prev: OverlayFigure | null
}

type GapKind = 'unknown' | 'not-loaded'
type LaneKind = 'unknown' | 'partial'

/**
 * Spend over time: the chosen metric as stacked areas over the bucket slots (largest series at the bottom), with a
 * crosshair that follows the pointer or the arrow keys. The plot is one Tab stop and a slider by role: its value text
 * is the tooltip's sentence, updated only when the person moves (no live region; the page's one polite region is the
 * view's). Draw motion: the areas wipe in once on arrival and once per change the person made (`drawSeq`).
 */
export default function SpendPanel({
  data,
  overview,
  filters,
  bucket,
  span,
  series,
  onNarrow,
  announce,
  periodTrend,
  onClearBucket,
  metric,
  onMetric,
  unpriced,
  hidden,
  onToggleSeries,
  overlay,
  onOverlay,
  previousTrend,
  previousSpan,
  highlight,
  onHighlight,
  groupBy,
  scrubIndex,
  arriving,
  drawSeq
}: UsagePanelProps & SpendInteractionProps): ReactElement {
  // A day pick narrows data.trend to that bucket; the chart keeps the whole period (the pick stays outlined, the rest dims).
  const trend = periodTrend ?? data.trend
  const hatchId = `ucsp${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const whyId = `${hatchId}why`
  const hintId = `${hatchId}hint`
  const tableId = `${hatchId}tbl`
  const reduced = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const plotRootRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [rootW, setRootW] = useState(900)
  // The keyboard's slot (null until the person moves it), whether the plot has keyboard focus, the pointer's slot (state
  // changes only when the slot does), the slot whose tooltip Escape hid, and the table disclosure.
  const [rove, setRove] = useState<number | null>(null)
  const [keyFocus, setKeyFocus] = useState(false)
  const [ptr, setPtr] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [tableOpen, setTableOpen] = useState(false)
  const [overlayIn, setOverlayIn] = useState(false)
  const ptrRef = useRef<number | null>(null)
  const rafRef = useRef(0)
  const pointerX = useRef(0)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setRootW(Math.round(el.getBoundingClientRect().width)))
    setRootW(Math.round(el.getBoundingClientRect().width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  const names = useMemo(() => new Map([...overview.projects, ...data.projects].map((p) => [p.projectId, p.projectName])), [overview.projects, data.projects])
  const nameOf = (key: string, seg?: Segment): string =>
    key === OTHER_KEY ? `Other (${seg?.projects ?? 0} ${seg?.projects === 1 ? 'project' : 'projects'})` : (names.get(key) ?? 'Removed project')

  // The legend: the projects that have a series colour (rank order), then Other.
  const legend = useMemo(() => {
    const own = data.projects.filter((p) => series.has(p.projectId)).sort((a, b) => series.get(a.projectId)! - series.get(b.projectId)!)
    const rest = data.projects.filter((p) => !series.has(p.projectId))
    return { own, rest }
  }, [data.projects, series])
  const legendKeys = useMemo(() => [...legend.own.map((p) => p.projectId), ...(legend.rest.length > 0 ? [OTHER_KEY] : [])], [legend])
  const hiddenN = hiddenCount(hidden, legendKeys)

  const overlayOn = overlay && previousTrend !== null && previousSpan !== null
  const prevSlots = useMemo(
    () => (overlayOn && previousTrend && previousSpan ? fillBuckets(previousTrend, previousSpan.since, previousSpan.until, bucket) : null),
    [overlayOn, previousTrend, previousSpan, bucket]
  )

  const bars: Bar[] = useMemo(() => {
    const oldest = data.lowerBound ? overview.oldestIncludedAt : undefined
    const slots = fillBuckets(trend, span.since, span.until, bucket)
    const aligned = prevSlots ? alignPrevious(slots, prevSlots) : null
    return slots.map((slot, i) => {
      const segments = slot.point ? visibleSegments(segmentsOf(slot.point.byProject, series, metric), hidden) : []
      return {
        slot,
        segments,
        state: barState(segments, !!slot.point),
        notLoaded: oldest !== undefined && !slot.point && bucketEnd(slot.start, bucket) <= oldest,
        prev: aligned ? overlayFigure(aligned[i] ?? null, series, metric, hidden) : null
      }
    })
  }, [trend, data.lowerBound, overview.oldestIncludedAt, span.since, span.until, bucket, series, metric, hidden, prevSlots])

  // The plot takes the card's whole width; the legend sits above it. `wide` only picks the taller plot.
  const wide = rootW >= WIDE_PANEL_PX
  const totalH = wide ? 196 : 172
  const plotH = totalH - TOP_PAD - STUB_LANE - LABEL_ROW
  const n = bars.length
  const innerW = Math.max(40, rootW - GUTTER - RIGHT_PAD)
  const svgW = GUTTER + innerW + RIGHT_PAD
  const xs = useMemo(() => pointXs(n, GUTTER, innerW), [n, innerW])
  const step = pointStep(n, innerW)
  const baseY = TOP_PAD + plotH
  const scaleMax = Math.max(stackMax(bars.map((b) => b.segments)), overlayMax(bars.flatMap((b) => (b.prev ? [b.prev] : []))))
  const ticks = niceTicks(scaleMax, metric === 'runs')
  const labels = thinLabels(n, step, 46)
  const selectedStart = filters.bucketPick && filters.bucketPick.size === bucket ? filters.bucketPick.start : filters.bucketPick ? bucketPickOf({ start: filters.bucketPick.start }, bucket).start : null
  const selectedIdx = selectedStart === null ? -1 : bars.findIndex((b) => b.slot.start === selectedStart)
  const anyUnknown = bars.some((b) => b.segments.some((s) => s.state === 'unknown'))
  const anyPartial = bars.some((b) => b.segments.some((s) => s.state === 'partial'))
  const anyPrevUnknown = bars.some((b) => b.prev?.state === 'unknown')
  // The overlay's key names the previous span and its total under the metric (walk H2): "Previous 30 days: $0.012+".
  const previousKeyText = (() => {
    const words = previousPeriodWords(filters.period).replace(/^the /, '')
    const label = `${words.charAt(0).toUpperCase()}${words.slice(1)}`
    const figs = bars.flatMap((b) => (b.prev ? [b.prev] : []))
    const runs = figs.reduce((n, f) => n + f.runs, 0)
    if (runs === 0) return `${label}: no runs`
    const sum = figs.reduce((n, f) => n + f.value, 0)
    if (metric === 'runs') return `${label}: ${runs} ${runs === 1 ? 'run' : 'runs'}`
    if (metric === 'tokens') return `${label}: ${formatTokens(sum)} tokens`
    const known = figs.some((f) => f.state === 'known' || f.state === 'partial')
    if (!known) return `${label}: not priced`
    const partial = figs.some((f) => f.state === 'partial' || f.state === 'unknown')
    return `${label}: ${costView({ costUsd: sum, costSource: 'computed', sourceMixed: true, ...(partial ? { costPartial: true } : {}) }, { precision: 'page' }).text}`
  })()

  // ---------- the areas ----------

  const order = useMemo(() => stackOrder(seriesTotals(bars.map((b) => b.segments))), [bars])
  const seriesOf = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of bars) for (const s of b.segments) m.set(s.key, s.series)
    return m
  }, [bars])
  const bands = useMemo(
    () => stackAreas(order, bars.map((b) => new Map(b.segments.map((s) => [s.key, s.value]))), ticks.max, plotH, baseY),
    [order, bars, ticks.max, plotH, baseY]
  )
  // Slots with nothing to draw because there is no price (or no data loaded) are marked, never left to read as zero.
  const gapRuns = useMemo(() => kindRuns<GapKind>(bars.map((b) => (b.notLoaded ? 'not-loaded' : b.state === 'unknown' ? 'unknown' : null))), [bars])
  const laneRuns = useMemo(
    () =>
      kindRuns<LaneKind>(
        bars.map((b) => (b.notLoaded ? null : b.segments.some((s) => s.state === 'unknown') ? 'unknown' : b.segments.some((s) => s.state === 'partial') ? 'partial' : null))
      ),
    [bars]
  )
  const prevYs = bars.map((b) => (b.prev && b.prev.state !== 'unknown' ? baseY - barHeight(b.prev.value, ticks.max, plotH, 0) : null))
  const prevLines = overlayOn ? linePaths(xs, prevYs) : []
  const half = n === 1 ? innerW / 2 : 0

  const defaultRove = useMemo(() => {
    if (selectedIdx >= 0) return selectedIdx
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i]!.slot.point) return i
    return Math.max(0, bars.length - 1)
  }, [bars, selectedIdx])
  const roving = rove !== null && rove < n ? rove : defaultRove

  const labelFor = (b: Bar): string => bucketLabel(b.slot.start, bucket)
  const modelOf = (b: Bar): CrosshairModel => {
    const p = b.slot.point
    const t = p ? visibleTotals([p], series, hidden) : null
    return crosshairModel({
      label: labelFor(b),
      metric,
      notLoaded: b.notLoaded,
      hasPoint: !!p,
      runs: t?.runs ?? 0,
      runsLine: p && t && t.runs > 0 ? runsLine(t.runs, unpricedRuns(p, series, hidden)) : null,
      hiddenSeries: hiddenN > 0,
      segments: b.segments,
      order,
      name: (key, seg) => nameOf(key, seg),
      clip: (name) => clipMiddle(name, 24),
      previous: b.prev ? previousTipText(b.prev, metric) : null
    })
  }

  // What the chart adds to the KPI band, over the series that are shown.
  const summary = (() => {
    let best: { start: number; value: number } | null = null
    for (const b of bars) {
      const v = b.segments.reduce((a, s) => a + s.value, 0)
      if (v > 0 && (!best || v > best.value)) best = { start: b.slot.start, value: v }
    }
    const totals =
      hiddenN > 0
        ? visibleTotals(data.trend, series, hidden)
        : { runs: data.totals.runs, tokens: tokenSum(data.totals.tokens), cost: data.totals.cost }
    return spendSummary({ metric, bucket, totals, busiest: best, hidden: hiddenN })
  })()

  // ---------- crosshair and tooltip ----------

  const scrub = scrubIndex !== null && scrubIndex >= 0 && scrubIndex < n ? scrubIndex : null
  const pointed = ptr !== null && ptr < n ? ptr : null
  const tipIdx = scrub ?? pointed ?? (keyFocus && n > 0 ? roving : null)
  const tipOn = tipIdx !== null && dismissed !== tipIdx && bars[tipIdx] !== undefined
  const tip = tipOn ? modelOf(bars[tipIdx]!) : null
  // The focused plot's value text: the same sentence as the tooltip, for the keyboard's slot only.
  const valueText = n > 0 ? modelOf(bars[roving]!).text : ''

  const setCx = (i: number): void => plotRootRef.current?.style.setProperty('--cx', `${xs[i] ?? 0}px`)

  // Escape hides the tooltip of one slot; moving to another slot shows it again.
  useEffect(() => {
    if (dismissed !== null && dismissed !== tipIdx) setDismissed(null)
  }, [dismissed, tipIdx])

  // The rule follows keyboard focus and the KPI scrub through the same --cx the pointer writes.
  useLayoutEffect(() => {
    if (tipOn && tipIdx !== null) setCx(tipIdx)
  })

  // Tooltip placement: right of the point, flipped to its left near the card's right edge, inside the plot.
  useLayoutEffect(() => {
    const el = tipRef.current
    if (!tipOn || tipIdx === null || !el) return
    const p = tooltipPlacement({ cx: xs[tipIdx] ?? 0, half: 4, width: el.offsetWidth, viewLeft: 0, viewRight: svgW })
    el.style.left = `${p.left}px`
    el.dataset.side = p.side
  })

  const clearPointer = (): void => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    if (ptrRef.current !== null) {
      ptrRef.current = null
      setPtr(null)
    }
  }
  const slotAt = (clientX: number): number | null => {
    const root = plotRootRef.current
    return root ? nearestIndex(clientX - root.getBoundingClientRect().left, GUTTER, innerW, n) : null
  }
  // pointermove writes --cx in a frame and sets React state only when the slot changes.
  const onPlotMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch') return
    pointerX.current = e.clientX
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const i = slotAt(pointerX.current)
      if (i !== null) setCx(i)
      if (i !== ptrRef.current) {
        ptrRef.current = i
        setPtr(i)
      }
    })
  }

  // ---------- draw ----------

  // The areas wipe in left to right once on arrival and once for each change the person made, after its data rendered.
  const drawGen = useDrawGen({ arriving, drawSeq, fingerprint: [trend, metric, bucket, span.since, span.until] })

  // Compare turned on by the user: the previous-period outline fades in (CSS, scoped by data-anim-overlay).
  useEffect(() => {
    if (!overlayIn) return
    const t = window.setTimeout(() => setOverlayIn(false), tokenMs('--dur-base') + 80)
    return () => window.clearTimeout(t)
  }, [overlayIn])

  // ---------- interaction ----------

  const activate = (i: number, projectKey?: string): void => {
    const b = bars[i]
    if (!b) return
    if (!b.slot.point) {
      announce(modelOf(b).text)
      return
    }
    const pick = bucketPickOf({ start: b.slot.start }, bucket)
    onNarrow({ bucket: pick, ...(projectKey && projectKey !== OTHER_KEY ? { projectId: projectKey } : {}) })
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const next = moveIndex(roving, e.key, n)
    if (next !== null) {
      // The keyboard takes over from a pointer resting on another slot.
      clearPointer()
      setRove(next)
      setDismissed(null)
      // Any keyboard move shows the crosshair and tooltip, even when focus arrived by pointer or script (UX post walk H2).
      setKeyFocus(true)
    } else if (e.key === 'Escape') {
      // The tooltip goes first and focus stays; with none showing, Escape clears a day pick.
      if (tipOn) setDismissed(tipIdx)
      else if (filters.bucketPick && onClearBucket) onClearBucket()
      else return
    } else if (e.key === 'Enter' || e.key === ' ') activate(roving)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  const onPlotClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const i = slotAt(e.clientX)
    if (i === null) return
    const area = (e.target as Element).closest?.('[data-project]')
    activate(i, area?.getAttribute('data-project') ?? undefined)
  }

  const other = otherNames(data.projects, series)
  const legendOtherCost = rollupCost({
    costUsd: legend.rest.some((p) => p.costUsd !== null) ? legend.rest.reduce((a, p) => a + (p.costUsd ?? 0), 0) : null,
    costKnownRuns: legend.rest.reduce((a, p) => a + p.costKnownRuns, 0),
    costUnknownRuns: legend.rest.reduce((a, p) => a + p.costUnknownRuns, 0)
  })
  const otherName = `Other (${other.count} ${other.count === 1 ? 'project' : 'projects'})`
  // Legend figures follow the metric (owner review): cost, tokens or runs for the whole period.
  const legendValue = (ps: readonly UsageProjectRollup[], cost: CostInput): ReactElement | string => {
    if (metric === 'tokens') return formatTokens(ps.reduce((a, p) => a + tokenSum(p.tokens), 0))
    if (metric === 'runs') {
      const n = ps.reduce((a, p) => a + p.runs, 0)
      return `${n} ${n === 1 ? 'run' : 'runs'}`
    }
    return <CostText value={cost} />
  }
  const title = metric === 'cost' ? 'Spend over time' : metric === 'tokens' ? 'Tokens over time' : 'Runs over time'

  // Table: one column per legend project (and Other), then the previous period while the overlay is on.
  const tableCols = [
    { key: 'period', label: 'Period' },
    { key: 'runs', label: 'Runs', numeric: true },
    { key: 'tokens', label: 'Tokens', numeric: true },
    { key: 'cost', label: 'Cost', numeric: true },
    ...legend.own.map((p) => ({ key: p.projectId, label: p.projectName, numeric: true })),
    ...(legend.rest.length > 0 ? [{ key: OTHER_KEY, label: `Other (${legend.rest.length})`, numeric: true }] : []),
    ...(overlayOn ? [{ key: 'previous', label: 'Previous', numeric: true }] : [])
  ]
  const tableRows = bars
    .filter((b) => b.slot.point)
    .map((b) => {
      const p = b.slot.point!
      const costSegs = segmentsOf(p.byProject, series, 'cost')
      const segOf = (key: string): Segment | undefined => costSegs.find((x) => x.key === key)
      const cell = (key: string): ReactElement | string => {
        const s = segOf(key)
        return s ? <CostText value={s.cost} /> : '—'
      }
      const keys = [...legend.own.map((pr) => pr.projectId), ...(legend.rest.length > 0 ? [OTHER_KEY] : [])]
      const sort: SortValue[] = [
        b.slot.start,
        p.runs,
        tokenSum(p.tokens),
        p.costUsd,
        ...keys.map((k) => segOf(k)?.cost.costUsd ?? null),
        ...(overlayOn && b.prev ? [previousSortValue(b.prev, metric)] : [])
      ]
      return {
        key: String(b.slot.start),
        data: { bucket: b.slot.key },
        cells: [
          labelFor(b),
          p.runs,
          formatTokens(tokenSum(p.tokens)),
          <CostText key="c" value={rollupCost(p)} />,
          ...legend.own.map((pr) => cell(pr.projectId)),
          ...(legend.rest.length > 0 ? [cell(OTHER_KEY)] : []),
          ...(overlayOn && b.prev ? [previousCellText(b.prev, metric)] : [])
        ],
        sort
      }
    })

  const dimOf = (key: string): boolean => highlight !== null && highlight !== key
  const unitWord = bucket === 'day' ? 'day' : bucket === 'week' ? 'week' : 'month'
  const groupLabel = `${METRIC_WORD[metric]} per ${unitWord}, stacked area chart.`
  const hint = `Left and Right move between ${unitWord}s, Home and End jump to the first and last, Enter narrows the page to the ${unitWord}, Escape hides the details.`
  const hasPrevious = previousTrend !== null && previousSpan !== null
  const whyOverlay = overlayDisabledReason(hasPrevious)
  const showUnknownKey = metric === 'cost' && !unpriced && anyUnknown
  const showPartialKey = metric === 'cost' && !unpriced && anyPartial
  const right = GUTTER + innerW
  const sel = selectedIdx >= 0 ? runExtent({ from: selectedIdx, to: selectedIdx }, xs, step, GUTTER, right) : null
  const markerIdx = tip && tipIdx !== null ? tipIdx : null

  return (
    <section className="usage-panel uc-spend" aria-labelledby="usage-spend-h" data-testid="usage-spend" data-metric={metric}>
      <div className="usage-panel-head">
        <h2 id="usage-spend-h" tabIndex={-1}>
          {title}
        </h2>
        <div className="uc-head-controls">
          <div className="uc-metric" data-testid="usage-spend-metric">
            <SegmentedControl
              label="Chart shows"
              value={metric}
              options={[
                { value: 'cost', label: METRIC_WORD.cost },
                { value: 'tokens', label: METRIC_WORD.tokens },
                { value: 'runs', label: METRIC_WORD.runs }
              ]}
              onChange={onMetric}
            />
          </div>
          {groupBy}
          <div className="uc-overlay-ctl">
            <Button
              size="sm"
              className="uc-overlay"
              testId="usage-spend-overlay"
              pressed={overlayOn}
              icon={overlayOn ? Check : undefined}
              inert={!hasPrevious}
              ariaDescribedBy={whyOverlay ? whyId : undefined}
              onClick={() => {
                if (!overlay && hasPrevious && !reduced) setOverlayIn(true)
                onOverlay(!overlay)
              }}
            >
              Compare with previous period
            </Button>
            {whyOverlay && (
              <span id={whyId} className="uc-overlay-why">
                {whyOverlay}
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn sm uc-table-toggle"
            data-testid="usage-spend-table-toggle"
            aria-expanded={tableOpen}
            aria-controls={tableId}
            onClick={() => setTableOpen((o) => !o)}
          >
            <Icon icon={Table} size="sm" />
            {/* A fixed label: aria-expanded carries the state (Reviewer). */}
            Table
          </button>
        </div>
        <p className="usage-panel-summary">{summary}</p>
      </div>
      <div ref={rootRef} className="uc-spend-body">
        <ul className="uc-legend" data-testid="usage-spend-legend" aria-label="Chart legend. Press a project to hide or show it.">
          {legend.own.map((p) => {
            const idx = series.get(p.projectId)!
            const isHidden = hidden.has(p.projectId)
            return (
              <li key={p.projectId} className="uc-legend-row" data-series={idx} data-dim={dimOf(p.projectId) ? 'true' : undefined}>
                <button
                  type="button"
                  className="uc-legend-btn"
                  data-testid="usage-spend-legend-row"
                  data-project={p.projectId}
                  data-hidden={isHidden ? 'true' : 'false'}
                  data-highlight={highlight === p.projectId ? 'true' : undefined}
                  aria-pressed={!isHidden}
                  title={`${p.projectName}: ${isHidden ? 'show in the chart' : 'hide from the chart'}`}
                  onClick={() => onToggleSeries(p.projectId, p.projectName)}
                  onPointerEnter={() => onHighlight(p.projectId)}
                  onPointerLeave={() => onHighlight(null)}
                  onFocus={() => onHighlight(p.projectId)}
                  onBlur={() => onHighlight(null)}
                >
                  <Swatch fill={fillOf(idx)} hollow={isHidden} />
                  <span className="uc-legend-name">{p.projectName}</span>
                  <span className="uc-legend-value">{legendValue([p], rollupCost(p))}</span>
                </button>
              </li>
            )
          })}
          {legend.rest.length > 0 && (
            <li className="uc-legend-row" data-series="other" data-dim={dimOf(OTHER_KEY) ? 'true' : undefined}>
              <button
                type="button"
                className="uc-legend-btn"
                data-testid="usage-spend-legend-other"
                data-hidden={hidden.has(OTHER_KEY) ? 'true' : 'false'}
                data-highlight={highlight === OTHER_KEY ? 'true' : undefined}
                aria-pressed={!hidden.has(OTHER_KEY)}
                title={`Smaller projects folded together: ${other.names}. ${hidden.has(OTHER_KEY) ? 'Show in the chart' : 'Hide from the chart'}`}
                onClick={() => onToggleSeries(OTHER_KEY, otherName)}
                onPointerEnter={() => onHighlight(OTHER_KEY)}
                onPointerLeave={() => onHighlight(null)}
                onFocus={() => onHighlight(OTHER_KEY)}
                onBlur={() => onHighlight(null)}
              >
                <Swatch fill="var(--chart-other)" hollow={hidden.has(OTHER_KEY)} />
                <span className="uc-legend-name">{otherName}</span>
                <span className="uc-legend-value">{legendValue(legend.rest, legendOtherCost)}</span>
              </button>
            </li>
          )}
          {showUnknownKey && (
            <li className="uc-key" data-testid="usage-spend-unknown-key" title="Hatched band: the cost is unknown, so it adds no height. It is not zero.">
              <svg width="14" height="10" aria-hidden="true" focusable="false">
                <defs>
                  <pattern id={`${hatchId}k1`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="4" stroke="var(--chart-unknown)" strokeWidth="1.25" />
                  </pattern>
                </defs>
                <rect x="0.75" y="0.75" width="12.5" height="8.5" fill={`url(#${hatchId}k1)`} className="uc-stub" />
              </svg>
              Not priced
            </li>
          )}
          {showPartialKey && (
            <li className="uc-key" data-testid="usage-spend-partial-key" title="Hatched lane under the axis: a lower bound, because some runs in it have no price.">
              <svg width="14" height="10" aria-hidden="true" focusable="false">
                <defs>
                  <pattern id={`${hatchId}k2`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="4" stroke="var(--chart-unknown)" strokeWidth="1.25" />
                  </pattern>
                </defs>
                <rect x="0" y="2" width="14" height="6" fill={`url(#${hatchId}k2)`} />
              </svg>
              Lower bound
            </li>
          )}
          {overlayOn && (
            <li className="uc-key" data-testid="usage-spend-overlay-key">
              <svg width="18" height="10" aria-hidden="true" focusable="false">
                <line x1="1" y1="5" x2="17" y2="5" strokeDasharray="4 3" className="uc-prev" />
              </svg>
              {previousKeyText}
            </li>
          )}
          {overlayOn && anyPrevUnknown && (
            <li className="uc-key" data-testid="usage-spend-overlay-unknown-key" title="A hollow circle: the previous period's cost is unknown.">
              <svg width="10" height="10" aria-hidden="true" focusable="false">
                <circle cx="5" cy="5" r="3" className="uc-prev uc-prev-unknown" />
              </svg>
              previous not priced
            </li>
          )}
        </ul>
        <div className="uc-spend-chart">
          <div
            ref={plotRootRef}
            role={n > 0 ? 'slider' : 'img'}
            aria-label={groupLabel}
            aria-describedby={hintId}
            {...(n > 0 ? { 'aria-orientation': 'horizontal' as const, 'aria-valuemin': 0, 'aria-valuemax': n - 1, 'aria-valuenow': roving, 'aria-valuetext': valueText } : {})}
            tabIndex={n > 0 ? 0 : -1}
            className="uc-spend-plot"
            data-testid="usage-spend-plot"
            data-highlight={highlight ?? undefined}
            data-overlay={overlayOn ? 'true' : undefined}
            data-anim-overlay={overlayIn ? 'in' : undefined}
            data-draw={drawGen}
            data-cursor={tipIdx ?? undefined}
            style={{ width: svgW }}
            onPointerMove={onPlotMove}
            onPointerLeave={clearPointer}
            onClick={onPlotClick}
            onKeyDown={onKey}
            onFocus={(e) => setKeyFocus(e.currentTarget.matches(':focus-visible'))}
            onBlur={() => setKeyFocus(false)}
          >
            {tipOn && tipIdx !== null && (
              <div
                className="uc-crosshair"
                data-testid="usage-chart-crosshair"
                aria-hidden="true"
                style={{ top: TOP_PAD - 8, height: plotH + STUB_LANE + 8 } as CSSProperties}
              />
            )}
            <svg width={svgW} height={totalH} viewBox={`0 0 ${svgW} ${totalH}`} className="uc-svg" focusable="false" aria-hidden="true">
              <defs>
                <pattern id={`${hatchId}u`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="5" stroke="var(--chart-unknown)" strokeWidth="1.25" />
                </pattern>
                <pattern id={`${hatchId}l`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <line x1="0" y1="0" x2="0" y2="4" stroke="var(--chart-unknown)" strokeWidth="1.25" />
                </pattern>
              </defs>
              <g>
                {ticks.ticks.map((t) => {
                  const y = baseY - (t / ticks.max) * plotH
                  return (
                    <g key={t}>
                      <line x1={GUTTER} x2={right} y1={y} y2={y} className="uc-grid" />
                      <text x={GUTTER - 6} y={y + 4} textAnchor="end" className="uc-tick">
                        {formatTick(t, metric)}
                      </text>
                    </g>
                  )
                })}
                {bars.map((b, i) =>
                  labels.has(i) ? (
                    <text key={b.slot.start} x={xs[i]} y={totalH - 5} textAnchor="middle" className="uc-tick">
                      {axisLabel(b.slot.start, bucket)}
                    </text>
                  ) : null
                )}
              </g>
              {/* The drawn data wipes in left to right; keyed on the draw generation so a new one restarts it. */}
              <g key={drawGen} className={drawGen > 0 ? 'motion-draw-wipe' : undefined} data-testid="usage-spend-areas">
                {gapRuns.map((r) => {
                  const ext = runExtent(r, xs, step, GUTTER, right)
                  return (
                    <rect
                      key={`g${r.from}`}
                      x={ext.x}
                      y={TOP_PAD}
                      width={ext.w}
                      height={plotH}
                      fill={`url(#${hatchId}u)`}
                      className="uc-gap"
                      data-testid="usage-spend-gap"
                      data-kind={r.kind}
                    />
                  )
                })}
                {order.map((key) => {
                  const band = bands.get(key)
                  if (!band) return null
                  const idx = seriesOf.get(key) ?? -1
                  return (
                    <path
                      key={key}
                      d={areaPath(xs, band, half)}
                      fill={fillOf(idx)}
                      className="uc-area"
                      data-testid="usage-spend-area"
                      data-project={key}
                      data-series={idx}
                      data-dim={dimOf(key) ? 'true' : undefined}
                      onPointerEnter={() => onHighlight(key)}
                      onPointerLeave={() => onHighlight(null)}
                    />
                  )
                })}
                {laneRuns.map((r) => {
                  const ext = runExtent(r, xs, step, GUTTER, right)
                  return (
                    <rect
                      key={`l${r.from}`}
                      x={ext.x + 0.75}
                      y={baseY + 4.75}
                      width={Math.max(0, ext.w - 1.5)}
                      height={STUB_H - 1.5}
                      fill={`url(#${hatchId}l)`}
                      className={r.kind === 'unknown' ? 'uc-stub' : 'uc-lane'}
                      data-testid="usage-spend-lane"
                      data-kind={r.kind}
                    />
                  )
                })}
              </g>
              {highlight !== null && bands.has(highlight) && (
                <path d={edgePath(xs, bands.get(highlight)!, half)} className="uc-hl" data-testid="usage-spend-highlight" aria-hidden="true" />
              )}
              {sel && (
                <g aria-hidden="true" pointerEvents="none">
                  <rect x={GUTTER} y={TOP_PAD} width={Math.max(0, sel.x - GUTTER)} height={plotH} className="uc-veil" />
                  <rect x={sel.x + sel.w} y={TOP_PAD} width={Math.max(0, right - sel.x - sel.w)} height={plotH} className="uc-veil" />
                  <rect x={sel.x + 1} y={TOP_PAD - 1} width={Math.max(0, sel.w - 2)} height={plotH + STUB_LANE + 2} className="uc-selected" data-testid="usage-spend-selected" />
                </g>
              )}
              {prevLines.map((d, k) => (
                <path key={k} d={d} strokeDasharray="4 3" strokeLinecap="round" className="uc-prev" data-testid="usage-spend-overlay-mark" data-state="line" aria-hidden="true" />
              ))}
              {overlayOn &&
                bars.map((b, i) =>
                  b.prev && b.prev.state === 'unknown' ? (
                    <circle key={`pu${i}`} cx={xs[i]} cy={baseY - 4} r={3} className="uc-prev uc-prev-unknown" data-testid="usage-spend-overlay-mark" data-state="unknown" aria-hidden="true" />
                  ) : null
                )}
              {markerIdx !== null &&
                order.map((key) => {
                  const band = bands.get(key)
                  const b = bars[markerIdx]
                  const seg = b?.segments.find((s) => s.key === key)
                  if (!band || !seg || !(seg.value > 0)) return null
                  return <circle key={key} cx={xs[markerIdx]} cy={band.top[markerIdx]} r={3.5} fill={fillOf(seg.series)} className="uc-marker" />
                })}
              <line x1={GUTTER} x2={right} y1={baseY} y2={baseY} className="uc-axis" />
            </svg>
          </div>
          {tip && (
            <div ref={tipRef} className="uc-tip" data-testid="usage-chart-tooltip" aria-hidden="true" data-side="right" style={{ top: TOP_PAD }}>
              <div className="uc-tip-head">
                <span className="uc-tip-date">{tip.label}</span>
                {tip.total && <span className="uc-tip-total">{tip.total}</span>}
              </div>
              {tip.note && <div className="uc-tip-note">{tip.note}</div>}
              {tip.rows.map((r) => (
                <div key={r.key} className={`uc-tip-row${highlight === r.key ? ' is-hl' : ''}`} data-state={r.state}>
                  <Swatch fill={fillOf(r.series)} hollow={false} />
                  <span className="uc-tip-name">{r.name}</span>
                  <span className="uc-tip-value">{r.value}</span>
                </div>
              ))}
              {tip.previous && <div className="uc-tip-prev">Previous: {tip.previous}</div>}
              {tip.runs && <div className="uc-tip-runs">{tip.runs}</div>}
            </div>
          )}
          <p id={hintId} className="sr-only">
            {hint}
          </p>
          {unpriced && metric === 'cost' && <p className="uc-note">No prices are known for this period, so cost cannot be drawn. Choose Tokens or Runs to see the volume.</p>}
        </div>
      </div>
      <ChartTable id={tableId} open={tableOpen} testId="usage-spend-table" caption="Spend over time by project" columns={tableCols} rows={tableRows} empty="No runs in this period." />
    </section>
  )
}

/** The legend swatch: solid while the series is shown, a hollow outline while hidden (shape, not only colour). */
function Swatch({ fill, hollow }: { fill: string; hollow: boolean }): ReactElement {
  return (
    <svg width="10" height="10" aria-hidden="true" focusable="false">
      {hollow ? <rect x="0.75" y="0.75" width="8.5" height="8.5" rx="1" fill="none" stroke={fill} strokeWidth="1.5" /> : <rect width="10" height="10" rx="1" fill={fill} />}
    </svg>
  )
}
