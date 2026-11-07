import type { ReactElement } from 'react'
import { costView, type CostInput } from '../../lib/cost'

/**
 * One cost figure, worded by lib/cost.ts: "unknown" (never $0), "$0.42+" for a lower bound, and a tooltip that says
 * whether the provider reported it or OrgAI computed it (and whether it predates usage tracking).
 * `labelled` spells an unknown cost out ("Cost unknown") for places with no "Cost" column or label (meta line, strips).
 * Pass `hideEmpty` to render nothing when nothing was spent yet. `compact` rounds to cents (Dashboard only).
 */
export function Cost({
  value,
  hideEmpty,
  labelled,
  compact,
  className
}: {
  value: CostInput
  hideEmpty?: boolean
  labelled?: boolean
  compact?: boolean
  className?: string
}): ReactElement | null {
  const v = costView(value, { compact })
  if (hideEmpty && v.empty) return null
  return (
    <span className={`cost cost-${v.kind}${className ? ` ${className}` : ''}`} title={v.title || undefined}>
      {labelled && v.kind === 'unknown' ? 'Cost unknown' : v.text}
    </span>
  )
}
