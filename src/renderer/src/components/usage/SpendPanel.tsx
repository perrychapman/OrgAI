import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { Check, Table } from 'lucide-react'
import type { UsageOverviewTrendPoint, UsageProjectRollup } from '@shared/types'
import { formatTokens, type CostInput } from '../../lib/cost'
import { useReducedMotion } from '../../lib/canvas'
import { tokenMs } from '../../lib/useExitPresence'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { SegmentedControl } from '../ui/SegmentedControl'
import { bucketEnd, bucketPickOf } from '../../lib/usageOverview'
import {
  axisLabel,
  barHeight,
  barState,
  barWidth,
  bucketLabel,
  clipMiddle,
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
import { alignPrevious, overlayFigure, overlayMax, overlayReadout, visibleSegments, METRIC_WORD, type OverlayFigure, type SortValue } from '../../lib/usageDashboard'
import {
  barValueLabel,
  chartMotion,
  hiddenCount,
  morphFrom,
  nearestBucket,
  overlayCostText,
  overlayDisabledReason,
  previousCellText,
  previousSortValue,
  previousTipText,
  runsLine,
  sameKeys,
  sameSet,
  segmentFigure,
  spendSummary,
  tooltipPlacement,
  unpricedRuns,
  visibleTotals,
  visualGeom,
  type SegGeom
} from '../../lib/usageSpend'
import type { SpendInteractionProps, UsagePanelProps } from './panelProps'
import { ChartTable } from './ChartTable'
import { CostText } from './RankedBars'
import '../../styles/usage-charts.css'

const GUTTER = 48
const RIGHT_PAD = 14
const TOP_PAD = 16
const STUB_LANE = 14
const STUB_H = 7
const LABEL_ROW = 20
const MAX_BAR_PX = 48
const WIDE_PANEL_PX = 720
/** A filter change shows its data within this long of the change or the fade is skipped (the data never came). */
const VIEW_FADE_WINDOW_MS = 5000
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
  /** The segments still drawn (hidden series removed). */
  segments: Segment[]
  state: BarState
  notLoaded: boolean
  /** The previous period's figure for this slot while the overlay is on. */
  prev: OverlayFigure | null
}

/** A drawn segment's rect in svg px, kept between commits so a metric or legend change can morph from it. */
interface Geom extends SegGeom {
  x: number
  w: number
  fill: string
}
interface Ghost extends Geom {
  k: string
}
interface Snapshot {
  sig: string
  trend: UsageOverviewTrendPoint[]
  slots: string[]
  metric: Metric
  hidden: ReadonlySet<string>
  geom: Map<string, Geom>
}
interface Running {
  el: SVGGElement
  anim: Animation
}

const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** The transform a running morph currently applies to `el` (identity when none). Chromium's DOMMatrix reads the computed matrix. */
function currentScale(el: Element): { ty: number; sy: number } {
  const t = getComputedStyle(el).transform
  if (!t || t === 'none' || typeof DOMMatrixReadOnly === 'undefined') return { ty: 0, sy: 1 }
  const m = new DOMMatrixReadOnly(t)
  return { ty: m.f, sy: m.d }
}

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
  scrubIndex
}: UsagePanelProps & SpendInteractionProps): ReactElement {
  // A day pick narrows data.trend to that bucket; the chart keeps the whole period (the pick stays outlined, the rest dims).
  const trend = periodTrend ?? data.trend
  const hatchId = `ucsp${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const whyId = `${hatchId}why`
  const hintId = `${hatchId}hint`
  const tableId = `${hatchId}tbl`
  const reduced = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const plotRootRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [rootW, setRootW] = useState(900)
  const [focus, setFocus] = useState<Cursor | null>(null)
  const [hover, setHover] = useState<Cursor | null>(null)
  const [rove, setRove] = useState<number | null>(null)
  // The pointer's bucket column (state changes only when the column does), the column whose tooltip Escape hid, the table
  // disclosure, and the bars that just left (shrinking ghosts).
  const [ptr, setPtr] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const [tableOpen, setTableOpen] = useState(false)
  const [ghosts, setGhosts] = useState<Ghost[]>([])
  const [overlayIn, setOverlayIn] = useState(false)
  const ptrRef = useRef<number | null>(null)
  const rafRef = useRef(0)
  const pointerX = useRef(0)
  const prevRef = useRef<Snapshot | null>(null)
  const pendingView = useRef(0)
  const running = useRef<Running[]>([])
  const morphGen = useRef(0)
  const ghostTiming = useRef({ ms: 0, easing: '' })

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setRootW(Math.round(el.getBoundingClientRect().width)))
    setRootW(Math.round(el.getBoundingClientRect().width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current)
      for (const r of running.current) r.anim.cancel()
    },
    []
  )

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
  const plotBoxW = rootW
  const plotH = totalH - TOP_PAD - STUB_LANE - LABEL_ROW
  const n = bars.length
  const slot = slotWidth(n, plotBoxW - GUTTER - RIGHT_PAD)
  const innerW = Math.max(plotBoxW - GUTTER - RIGHT_PAD, n * slot)
  const svgW = GUTTER + innerW + RIGHT_PAD
  const bw = Math.min(barWidth(slot), MAX_BAR_PX)
  const baseY = TOP_PAD + plotH
  const scaleMax = Math.max(stackMax(bars.map((b) => b.segments)), overlayMax(bars.flatMap((b) => (b.prev ? [b.prev] : []))))
  const ticks = niceTicks(scaleMax)
  const labels = thinLabels(n, slot, 46)
  const selectedStart = filters.bucketPick && filters.bucketPick.size === bucket ? filters.bucketPick.start : filters.bucketPick ? bucketPickOf({ start: filters.bucketPick.start }, bucket).start : null
  const anyUnknown = bars.some((b) => b.segments.some((s) => s.state === 'unknown'))
  const anyPartial = bars.some((b) => b.segments.some((s) => s.state === 'partial'))
  const anyPrevUnknown = bars.some((b) => b.prev?.state === 'unknown')

  // Each bar's drawn stack (known and partial segments; unknown ones are stubs under the axis) with its svg y and height.
  const stacks = useMemo(
    () =>
      bars.map((b) => {
        let cum = 0
        return b.segments
          .filter((s) => s.state === 'known' || s.state === 'partial')
          .map((s) => {
            const h = barHeight(s.value, ticks.max, plotH)
            const y = baseY - cum - h
            cum += h
            return { s, y, h }
          })
      }),
    [bars, ticks.max, plotH, baseY]
  )

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
  const prevText = (b: Bar): string => (b.prev ? ` ${overlayReadout(b.prev, metric, overlayCostText(b.prev))}` : '')
  const barText = (b: Bar): string => {
    if (b.notLoaded) return `${labelFor(b)}: not loaded.`
    const p = b.slot.point
    if (!p) return `${labelFor(b)}: no runs.${prevText(b)}`
    const t = visibleTotals([p], series, hidden)
    if (t.runs === 0) return `${labelFor(b)}: ${hiddenN > 0 ? 'nothing in the series shown.' : 'no runs.'}${prevText(b)}`
    return `${readoutText(labelFor(b), { runs: t.runs, cost: t.cost, tokens: t.tokens }, b.segments, nameOf, metric)}${prevText(b)}`
  }
  const segText = (b: Bar, s: Segment): string => segmentReadout(labelFor(b), nameOf(s.key, s), s, metric)

  // The screen-reader readout (visually hidden, not a live region): what the focused or hovered bar or segment says.
  const shown = focus ?? hover
  const readout = (() => {
    if (!shown) return n > 0 ? `${n} ${bucket === 'day' ? 'days' : bucket === 'week' ? 'weeks' : 'months'}. Hover or focus one for its figures.` : ''
    const b = bars[shown.i]
    if (!b) return ''
    const s = shown.s !== null ? b.segments[shown.s] : undefined
    return s ? segText(b, s) : barText(b)
  })()

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
  const tipIdx = scrub ?? pointed ?? (focus && focus.i < n ? focus.i : null)
  const tipOn = tipIdx !== null && dismissed !== tipIdx
  const tip = tipOn ? tipContent(bars[tipIdx]!) : null

  function tipContent(b: Bar): { label: string; total: string | null; rows: { key: string; name: string; fill: string; value: string }[]; previous: string | null; runs: string | null; note: string | null } {
    const label = labelFor(b)
    const previous = b.prev ? previousTipText(b.prev, metric) : null
    const p = b.slot.point
    if (b.notLoaded) return { label, total: null, rows: [], previous, runs: null, note: 'Not loaded' }
    const t = p ? visibleTotals([p], series, hidden) : null
    if (!p || !t || t.runs === 0) return { label, total: null, rows: [], previous, runs: null, note: hiddenN > 0 && p ? 'Nothing in the series shown' : 'No runs' }
    return {
      label,
      total: barValueLabel(metric, b.segments) || null,
      rows: b.segments.map((s) => ({ key: s.key, name: clipMiddle(nameOf(s.key, s), 24), fill: fillOf(s.series), value: segmentFigure(metric, s) })),
      previous,
      runs: runsLine(t.runs, unpricedRuns(p, series, hidden)),
      note: null
    }
  }

  const cxOf = (i: number): number => GUTTER + i * slot + slot / 2
  const setCx = (i: number): void => plotRootRef.current?.style.setProperty('--cx', `${cxOf(i)}px`)

  // Escape hides the tooltip of one column; moving to another column shows it again.
  useEffect(() => {
    if (dismissed !== null && dismissed !== tipIdx) setDismissed(null)
  }, [dismissed, tipIdx])

  // The rule follows keyboard focus and the KPI scrub through the same --cx the pointer writes.
  useLayoutEffect(() => {
    if (tipOn && tipIdx !== null) setCx(tipIdx)
  })

  // Tooltip placement: right of the column, flipped to its left near the card's right edge, inside the visible plot.
  useLayoutEffect(() => {
    const el = tipRef.current
    const scroller = plotRef.current
    if (!tipOn || tipIdx === null || !el || !scroller) return
    const p = tooltipPlacement({ cx: cxOf(tipIdx) - scroller.scrollLeft, half: slot / 2, width: el.offsetWidth, viewLeft: 0, viewRight: scroller.clientWidth })
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
  // pointermove writes --cx in a frame and sets React state only when the column changes.
  const onPlotMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.pointerType === 'touch') return
    pointerX.current = e.clientX
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const root = plotRootRef.current
      if (!root) return
      const i = nearestBucket(pointerX.current - root.getBoundingClientRect().left, GUTTER, slot, n)
      if (i !== null) setCx(i)
      if (i !== ptrRef.current) {
        ptrRef.current = i
        setPtr(i)
      }
    })
  }

  // ---------- motion ----------

  // A filter, period or group-by change: the buckets are replaced, so the chart fades once (bars cannot be paired).
  const sig = useMemo(
    () => JSON.stringify([filters.period, bucket, filters.projectIds, filters.kinds, filters.connection, filters.model, filters.role?.label ?? null, filters.noPrice]),
    [filters.period, bucket, filters.projectIds, filters.kinds, filters.connection, filters.model, filters.role, filters.noPrice]
  )

  useLayoutEffect(() => {
    const geom = new Map<string, Geom>()
    bars.forEach((b, i) => {
      const x = GUTTER + i * slot + (slot - bw) / 2
      for (const { s, y, h } of stacks[i] ?? []) geom.set(`${b.slot.start}|${s.key}`, { bottom: y + h, h, x, w: bw, fill: fillOf(s.series) })
    })
    const next: Snapshot = { sig, trend, slots: bars.map((b) => String(b.slot.start)), metric, hidden, geom }
    const prev = prevRef.current
    prevRef.current = next
    if (!prev) return
    const now = performance.now()
    if (prev.sig !== sig) pendingView.current = now
    const dataChanged = prev.trend !== trend || !sameKeys(prev.slots, next.slots)
    const viewChanged = pendingView.current > 0 && now - pendingView.current < VIEW_FADE_WINDOW_MS && dataChanged
    if (viewChanged) pendingView.current = 0
    const metricChanged = prev.metric !== metric
    const hiddenChanged = !sameSet(prev.hidden, hidden)
    const motion = chartMotion({ prevSlots: prev.slots, nextSlots: next.slots, viewChanged, metricChanged, hiddenChanged, segments: Math.max(prev.geom.size, geom.size), reduced })
    if (motion === 'none') return
    const root = plotRootRef.current
    if (!root) return
    if (motion === 'fade') {
      root.classList.remove('motion-fade')
      void root.offsetWidth
      root.classList.add('motion-fade')
      return
    }
    const ms = tokenMs(metricChanged ? '--dur-slow' : '--dur-base')
    if (ms <= 1) return
    const easing = cssVar('--ease-in-out') || 'ease-in-out'
    // Rapid reversal: a segment still moving starts the next morph from where it is drawn, not from its last resting place.
    const from = new Map(prev.geom)
    for (const r of running.current) {
      const k = r.el.dataset.gk
      const g = k ? from.get(k) : undefined
      if (!k || !g || r.anim.playState !== 'running') continue
      const { ty, sy } = currentScale(r.el)
      from.set(k, { ...g, ...visualGeom(g, ty, sy) })
    }
    for (const r of running.current) r.anim.cancel()
    const started: Running[] = []
    for (const el of root.querySelectorAll<SVGGElement>('g[data-gk]')) {
      const k = el.dataset.gk!
      const to = geom.get(k)
      const mf = to ? morphFrom(from.get(k), to) : null
      if (!mf || typeof el.animate !== 'function') continue
      el.style.willChange = 'transform'
      const keyframes: Keyframe[] = mf.entering
        ? [{ transform: 'scaleY(0)', opacity: 0 }, { transform: 'none', opacity: 1 }]
        : [{ transform: `translateY(${mf.ty}px) scaleY(${mf.sy})` }, { transform: 'none' }]
      started.push({ el, anim: el.animate(keyframes, { duration: ms, easing }) })
    }
    running.current = started
    const gone: Ghost[] = []
    for (const [k, g] of from) if (!geom.has(k)) gone.push({ ...g, k })
    ghostTiming.current = { ms, easing }
    setGhosts(gone)
    const gen = ++morphGen.current
    const svg = svgRef.current
    if (started.length > 0 && svg) svg.setAttribute('data-morph', 'running')
    void Promise.allSettled(started.map((r) => r.anim.finished)).then(() => {
      for (const r of started) r.el.style.willChange = ''
      if (gen === morphGen.current) {
        svg?.removeAttribute('data-morph')
        running.current = []
      }
    })
  }, [stacks, sig, trend, metric, hidden, slot, bw, reduced])

  // Segments that left (a hidden series, a metric that dropped them) shrink and fade where they stood, then go.
  useLayoutEffect(() => {
    const root = plotRootRef.current
    if (ghosts.length === 0 || !root) return
    const { ms, easing } = ghostTiming.current
    const anims = [...root.querySelectorAll<SVGElement>('.uc-ghost')].map((el) =>
      el.animate([{ transform: 'scaleY(1)', opacity: 1 }, { transform: 'scaleY(0)', opacity: 0 }], { duration: ms, easing, fill: 'forwards' })
    )
    void Promise.allSettled(anims.map((a) => a.finished)).then(() => setGhosts((cur) => (cur === ghosts ? [] : cur)))
    return () => {
      for (const a of anims) a.cancel()
    }
  }, [ghosts])

  // Compare turned on by the user: the previous-period outlines fade in (CSS, scoped by data-anim-overlay).
  useEffect(() => {
    if (!overlayIn) return
    const t = window.setTimeout(() => setOverlayIn(false), tokenMs('--dur-base') + 80)
    return () => window.clearTimeout(t)
  }, [overlayIn])

  // ---------- interaction ----------

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
    // The keyboard takes over from a pointer resting on another column.
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') clearPointer()
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
        // The tooltip goes first and focus stays; with none showing, Escape keeps its old jobs.
        if (tipOn) setDismissed(tipIdx)
        else if (s !== null) focusEl(i, null)
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
  const groupLabel = `${METRIC_WORD[metric]} per ${bucket}, bar chart.`
  const hint = `Hover the chart or use the arrow keys to read one ${bucket}. Left and Right move between ${bucket}s, Up and Down between projects, Enter narrows to the ${bucket} or project, Escape hides the details.`
  const hasPrevious = previousTrend !== null && previousSpan !== null
  const whyOverlay = overlayDisabledReason(hasPrevious)
  const showUnknownKey = metric === 'cost' && !unpriced && anyUnknown
  const showPartialKey = metric === 'cost' && !unpriced && anyPartial

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
            {tableOpen ? 'Hide table' : 'Table'}
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
                  <span className="uc-legend-name">{clipMiddle(p.projectName, 28)}</span>
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
            <li className="uc-key" data-testid="usage-spend-unknown-key" title="Dashed box under the axis: the cost is unknown, so it adds no height.">
              <svg width="12" height="8" aria-hidden="true" focusable="false">
                <rect x="0.75" y="0.75" width="10.5" height="6.5" fill="none" className="uc-stub" />
              </svg>
              cost unknown
            </li>
          )}
          {showPartialKey && (
            <li className="uc-key" data-testid="usage-spend-partial-key" title="Hatched top: a lower bound, because some runs in it have no price.">
              <svg width="12" height="10" aria-hidden="true" focusable="false">
                <defs>
                  <pattern id={`${hatchId}k`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="4" stroke="var(--chart-hatch)" strokeWidth="2" />
                  </pattern>
                </defs>
                <rect width="12" height="10" rx="1" fill="var(--chart-other)" />
                <rect width="12" height="6" rx="1" fill={`url(#${hatchId}k)`} />
              </svg>
              lower bound
            </li>
          )}
          {overlayOn && (
            <li className="uc-key" data-testid="usage-spend-overlay-key">
              <svg width="18" height="10" aria-hidden="true" focusable="false">
                <rect x="1" y="1" width="16" height="8" fill="none" strokeDasharray="4 3" className="uc-prev" />
              </svg>
              previous period
            </li>
          )}
          {overlayOn && anyPrevUnknown && (
            <li className="uc-key" data-testid="usage-spend-overlay-unknown-key" title="A hollow circle: the previous period's cost is unknown.">
              <svg width="10" height="10" aria-hidden="true" focusable="false">
                <circle cx="5" cy="5" r="3" className="uc-prev uc-prev-unknown" />
              </svg>
              previous cost unknown
            </li>
          )}
        </ul>
        <div className="uc-spend-chart">
          <div ref={plotRef} className="uc-spend-scroll">
            <div
              ref={plotRootRef}
              role="group"
              aria-label={groupLabel}
              aria-describedby={hintId}
              className="uc-spend-plot"
              data-testid="usage-spend-plot"
              data-highlight={highlight ?? undefined}
              data-overlay={overlayOn ? 'true' : undefined}
              data-anim-overlay={overlayIn ? 'in' : undefined}
              style={{ width: svgW }}
              onPointerMove={onPlotMove}
              onPointerLeave={clearPointer}
              onAnimationEnd={(e) => {
                if (e.target === e.currentTarget && e.animationName === 'motion-fade') e.currentTarget.classList.remove('motion-fade')
              }}
            >
              {tipOn && (
                <div
                  className="uc-crosshair"
                  data-testid="usage-chart-crosshair"
                  aria-hidden="true"
                  style={{ '--slot': `${slot}px`, top: TOP_PAD - 8, height: plotH + STUB_LANE + 8 } as CSSProperties}
                />
              )}
              <svg
                ref={svgRef}
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
                    <line x1="0" y1="0" x2="0" y2="4" stroke="var(--chart-hatch)" strokeWidth="2" />
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
                  {bars.map((b, i) =>
                    labels.has(i) ? (
                      <text key={b.slot.start} x={GUTTER + i * slot + slot / 2} y={totalH - 5} textAnchor="middle" className="uc-tick">
                        {axisLabel(b.slot.start, bucket)}
                      </text>
                    ) : null
                  )}
                </g>
                {bars.map((b, i) => {
                  const x0 = GUTTER + i * slot
                  const bx = x0 + (slot - bw) / 2
                  const selected = selectedStart === b.slot.start
                  const dim = selectedStart !== null && !selected
                  const drawn = stacks[i] ?? []
                  const stubs = b.segments.filter((s) => s.state === 'unknown')
                  const prev = b.prev
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
                      <rect x={x0} y={TOP_PAD - 8} width={slot} height={plotH + STUB_LANE + 8} className="uc-hit" />
                      {b.notLoaded && <rect x={bx} y={TOP_PAD} width={bw} height={plotH} className="uc-notloaded" fill={`url(#${hatchId})`} />}
                      {drawn.map(({ s, y, h }) => {
                        const si = b.segments.indexOf(s)
                        return (
                          <g key={s.key} className="uc-segg" data-gk={`${b.slot.start}|${s.key}`} data-dim={dimOf(s.key) ? 'true' : undefined}>
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
                                onHighlight(s.key)
                              }}
                              onBlur={() => onHighlight(null)}
                              onKeyDown={(e) => onKey(e, i, si)}
                              onPointerEnter={() => onHighlight(s.key)}
                              onPointerLeave={() => onHighlight(null)}
                              onMouseOver={(e) => {
                                e.stopPropagation()
                                setHover({ i, s: si })
                              }}
                              onClick={(e) => {
                                e.stopPropagation()
                                activate(b, s)
                              }}
                            />
                            {s.state === 'partial' && <rect x={bx} y={y} width={bw} height={Math.min(10, h)} fill={`url(#${hatchId})`} className="uc-hatch" pointerEvents="none" />}
                          </g>
                        )
                      })}
                      {highlight !== null &&
                        drawn
                          .filter(({ s }) => s.key === highlight)
                          .map(({ s, y, h }) => (
                            <rect key={`hl-${s.key}`} x={bx + 1} y={y + 1} width={Math.max(0, bw - 2)} height={Math.max(0, h - 2)} className="uc-hl" data-testid="usage-spend-highlight" aria-hidden="true" />
                          ))}
                      {stubs.map((s, k) => {
                        const w = Math.max(5, (bw - (stubs.length - 1) * 2) / stubs.length)
                        const si = b.segments.indexOf(s)
                        return (
                          <rect
                            key={s.key}
                            x={bx + k * (w + 2) + 0.75}
                            y={baseY + 4.75}
                            width={w - 1.5}
                            height={STUB_H - 1.5}
                            fill="none"
                            className="uc-stub"
                            data-dim={dimOf(s.key) ? 'true' : undefined}
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
                              onHighlight(s.key)
                            }}
                            onBlur={() => onHighlight(null)}
                            onKeyDown={(e) => onKey(e, i, si)}
                            onPointerEnter={() => onHighlight(s.key)}
                            onPointerLeave={() => onHighlight(null)}
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
                      {prev && prev.state === 'unknown' && (
                        <circle cx={x0 + slot / 2} cy={baseY - 4} r={3} className="uc-prev uc-prev-unknown" data-testid="usage-spend-overlay-mark" data-state="unknown" aria-hidden="true" />
                      )}
                      {prev && prev.state !== 'empty' && prev.state !== 'unknown' && (() => {
                        const h = barHeight(prev.value, ticks.max, plotH)
                        return (
                          <rect
                            x={bx - 1.5}
                            y={baseY - h}
                            width={bw + 3}
                            height={h}
                            fill="none"
                            strokeDasharray="4 3"
                            className="uc-prev"
                            data-testid="usage-spend-overlay-mark"
                            data-state={prev.state}
                            aria-hidden="true"
                          />
                        )
                      })()}
                      {selected && <rect x={x0 + 1} y={TOP_PAD - 1} width={slot - 2} height={plotH + STUB_LANE + 2} className="uc-selected" />}
                    </g>
                  )
                })}
                {ghosts.length > 0 && (
                  <g aria-hidden="true" pointerEvents="none">
                    {ghosts.map((g) => (
                      <rect key={g.k} x={g.x} y={g.bottom - g.h} width={g.w} height={g.h} fill={g.fill} className="uc-ghost" />
                    ))}
                  </g>
                )}
                <line x1={GUTTER} x2={svgW - RIGHT_PAD} y1={baseY} y2={baseY} className="uc-axis" />
              </svg>
            </div>
          </div>
          {tip && (
            <div ref={tipRef} className="uc-tip" data-testid="usage-chart-tooltip" aria-hidden="true" data-side="right" style={{ top: TOP_PAD }}>
              <div className="uc-tip-head">
                <span className="uc-tip-date">{tip.label}</span>
                {tip.total && <span className="uc-tip-total">{tip.total}</span>}
              </div>
              {tip.note && <div className="uc-tip-note">{tip.note}</div>}
              {tip.rows.map((r) => (
                <div key={r.key} className={`uc-tip-row${highlight === r.key ? ' is-hl' : ''}`}>
                  <Swatch fill={r.fill} hollow={false} />
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
          <p className="sr-only" data-testid="usage-spend-readout">
            {readout}
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
