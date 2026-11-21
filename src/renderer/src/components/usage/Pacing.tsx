import { useId, type CSSProperties, type ReactElement } from 'react'
import { costView } from '../../lib/cost'
import { useReducedMotion } from '../../lib/canvas'
import { arcPath, gaugeFraction, polar } from '../../lib/gauge'
import { useCountUp } from '../../lib/useCountUp'
import type { PacingModel } from '../../lib/usagePacing'
import type { SummaryItemModel } from '../../lib/usagePage'
import { PlanGauges } from '../limits/PlanGauge'
import { useLimitEntries } from '../limits/useLimitEntries'
import { figure, figureAt, figureNumber } from './kpiFigure'
import { useDrawKey } from './useDrawKey'
import '../../styles/usage-pacing.css'

/** The burn dial: a half circle, 200 by 112, the arc centred at (100, 100). */
const DIAL = { cx: 100, cy: 100, r: 84, from: -90, sweep: 180 }
const DIAL_PATH = arcPath(DIAL.cx, DIAL.cy, DIAL.r, DIAL.from, DIAL.sweep)

/**
 * A half-circle dial: the arc fills to spend so far over the projection (brand gradient, allowed on meters), a tick marks
 * where the previous period stood at this point, and the sentence under it says what the tick is. It traces on arrival
 * and again on the person's own filter change. The whole dial has one text alternative; the drawn parts are hidden from it.
 */
function BurnDial({ dial, arriving, drawSeq }: { dial: NonNullable<PacingModel['dial']>; arriving: boolean; drawSeq: number }): ReactElement {
  const reduced = useReducedMotion()
  const gradientId = `usage-dial-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const fill = gaugeFraction(dial.fill * 100)
  const pct = Math.round(dial.fill * 100)
  const shown = useCountUp(pct, { arriving, still: reduced })
  const { draw, key } = useDrawKey(drawSeq, String(pct), arriving)
  const tickAt = dial.tick === null ? null : DIAL.from + DIAL.sweep * dial.tick
  const a = tickAt === null ? null : polar(DIAL.cx, DIAL.cy, DIAL.r - 12, tickAt)
  const b = tickAt === null ? null : polar(DIAL.cx, DIAL.cy, DIAL.r + 10, tickAt)
  return (
    <figure className="usage-dial" data-testid="usage-pacing-dial" data-fill={pct}>
      <div className="usage-dial-img" role="img" aria-label={dial.text}>
        <svg viewBox="0 0 200 112" width="200" height="112" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="var(--brand-ui-from)" />
              <stop offset="1" stopColor="var(--brand-ui-to)" />
            </linearGradient>
          </defs>
          <path className="usage-dial-track" d={DIAL_PATH} pathLength={1} />
          {fill > 0 && (
            <path
              key={key}
              className={draw ? 'usage-dial-fill motion-draw-trace' : 'usage-dial-fill'}
              d={DIAL_PATH}
              pathLength={1}
              stroke={`url(#${gradientId})`}
              style={{ '--frac': fill } as CSSProperties}
              data-testid="usage-pacing-arc"
            />
          )}
          {a && b && <line className="usage-dial-tick" x1={a.x} y1={a.y} x2={b.x} y2={b.y} data-testid="usage-pacing-tick" />}
        </svg>
        <span className="usage-dial-text" aria-hidden="true">
          <span className="usage-dial-pct">{shown === null ? '' : `${Math.round(shown)}%`}</span>
          <span>of the projection</span>
        </span>
      </div>
      {/* What the drawing means: the fill is spend so far of the projection; the tick is where the earlier period stood. */}
      <figcaption className="usage-dial-caption" aria-hidden="true" data-testid="usage-pacing-tick-text">
        {dial.caption}
      </figcaption>
    </figure>
  )
}

/**
 * The Usage page's one hero card (docs/design/dashboard-usage-redesign Pacing): the period's spend as the page's one
 * figure, its pace against the previous period at the same point, a burn dial toward the projection, and the plan or
 * budget gauges. The projection is "Projected", never a fact, and absent with its reason unless a fifth of the period
 * has passed and every run is priced (lib/usagePacing.ts). An unknown spend reads "Not priced", never $0 and never counts up.
 */
export default function Pacing({
  item,
  label,
  periodText,
  model,
  unavailable,
  arriving,
  drawSeq
}: {
  /** The cost summary item (label, cost, lower-bound flag), the same one the KPI band shows. */
  item: SummaryItemModel
  /** "Estimated cost" or "Model cost". */
  label: string
  /** "6 Oct to 5 Nov 2026 (30 days)". */
  periodText: string
  /** null = pacing does not apply (one bucket is picked): `unavailable` says why. */
  model: PacingModel | null
  unavailable: string | null
  arriving: boolean
  drawSeq: number
}): ReactElement {
  const reduced = useReducedMotion()
  const limits = useLimitEntries()
  const kind = item.cost ? costView(item.cost, { precision: 'page' }).kind : 'none'
  const final = figure(item)
  const finalText = kind === 'none' ? 'Nothing spent' : final.text
  const target = figureNumber(item)
  const counted = useCountUp(target, { arriving, still: reduced })
  const text = counted !== null && target !== null && counted !== target ? figure(figureAt(item, counted)).text : finalText
  const projection = model ? model.projectionText : unavailable
  return (
    <section
      className={`hero-card usage-pacing${arriving ? ' motion-arrive-hero' : ''}`}
      aria-label="Pacing"
      data-testid="usage-pacing"
      data-projection={model?.state ?? 'none'}
      data-cost-kind={kind}
    >
      <div className="usage-pacing-main">
        <p className="usage-pacing-label">
          {label} <span aria-hidden="true">·</span> {periodText}
        </p>
        {/* The counting frames are hidden from assistive tech; the final figure is read once. */}
        <p className="usage-pacing-figure" aria-hidden="true" data-testid="usage-pacing-figure">
          {text}
        </p>
        <p className="sr-only" data-testid="usage-pacing-figure-text">
          {finalText}
        </p>
        <p className="usage-pacing-line">
          {model?.pace && (
            <span className="usage-pacing-pace" data-testid="usage-pacing-pace" data-direction={model.pace.glyph ?? 'level'}>
              {/* The arrow is decoration: "more than" / "less than" carry the direction. */}
              {model.pace.glyph && (
                <>
                  <span aria-hidden="true" className="usage-pacing-glyph">
                    {model.pace.glyph}
                  </span>{' '}
                </>
              )}
              {model.pace.text}
            </span>
          )}
          {projection && (
            <span className="usage-pacing-projection" data-testid="usage-pacing-projection" data-state={model?.state ?? 'none'}>
              {projection}
            </span>
          )}
        </p>
      </div>
      {model?.dial && <BurnDial dial={model.dial} arriving={arriving} drawSeq={drawSeq} />}
      {limits.length > 0 && <PlanGauges entries={limits} arrive={arriving} className="usage-pacing-gauges" />}
    </section>
  )
}
