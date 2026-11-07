import type { ReactElement } from 'react'
import { costView } from '../../lib/cost'
import { PARTIAL_COST_TITLE, type CostCoverage, type SummaryItemModel } from '../../lib/usagePage'

function figure(i: SummaryItemModel): { text: string; title?: string } {
  if (i.cost) {
    const v = costView(i.cost, { precision: 'page' })
    if (v.kind === 'unknown' && i.noPriceText) return { text: i.noPriceText, ...(v.title ? { title: v.title } : {}) }
    const plus = i.atLeast && v.kind !== 'unknown' && v.kind !== 'none' && !v.text.endsWith('+') ? '+' : ''
    const text = `${i.atLeast && v.kind !== 'unknown' && v.kind !== 'none' ? 'At least ' : ''}${v.text}${plus}`
    const partial = i.atLeast || v.kind === 'partial' ? PARTIAL_COST_TITLE : ''
    const title = [i.title, v.title, partial].filter(Boolean).join(' ')
    return { text, ...(title ? { title } : {}) }
  }
  if (i.text !== undefined) return { text: `${i.text}${i.atLeast ? '+' : ''}`, ...(i.title ? { title: i.title } : {}) }
  return { text: i.noPriceText ?? '—', ...(i.title ? { title: i.title } : {}) }
}

/**
 * The summary strip (4.3): five figures, each with a one-line text delta against the previous equal span when one is
 * known. Under Estimated cost a coverage line says how many runs the figure rests on, with the no-price link.
 */
export default function UsageSummary({
  items,
  coverage,
  modelChip,
  liveNote,
  onNoPrice
}: {
  items: readonly SummaryItemModel[]
  coverage: CostCoverage | null
  /** The model chip's id: the cost label reads "Model cost" and names it. */
  modelChip: string | null
  liveNote: string | null
  onNoPrice: () => void
}): ReactElement {
  return (
    <div className="usage-summary-wrap">
      <dl className="usage-summary" data-testid="usage-summary">
        {items.map((i) => {
          const f = figure(i)
          return (
            <div key={i.signal} className="usage-summary-item" data-testid="usage-summary-item" data-signal={i.signal}>
              <dt className="usage-summary-label" title={i.signal === 'cost' ? i.title : undefined}>
                {i.label}
                {i.signal === 'cost' && modelChip && <span className="usage-summary-model">{modelChip}</span>}
              </dt>
              <dd className="usage-summary-value" title={f.title}>
                {f.text}
              </dd>
              {i.signal === 'cost' && coverage && (
                <dd className="usage-summary-sub" data-testid="usage-coverage">
                  <span>{coverage.line}</span>
                  <button type="button" className="usage-link" onClick={onNoPrice} data-testid="usage-no-price-link">
                    {coverage.noPriceLabel}
                  </button>
                </dd>
              )}
              {i.delta && <dd className="usage-summary-sub usage-delta">{i.delta}</dd>}
            </div>
          )
        })}
      </dl>
      {liveNote && (
        <p className="usage-live-note" data-testid="usage-live-note">
          {liveNote}
        </p>
      )}
    </div>
  )
}
