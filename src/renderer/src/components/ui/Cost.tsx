import type { ReactElement } from 'react'
import { costView, type CostInput } from '../../lib/cost'

/**
 * One cost figure, worded by lib/cost.ts: "unknown" (never $0), "$0.42+" for a lower bound, and a tooltip that says
 * whether the provider reported it or OrgAI computed it (and whether it predates usage tracking).
 * `labelled` spells an unknown cost out ("Cost unknown") for places with no "Cost" column or label (meta line, strips).
 * Pass `hideEmpty` to render nothing when nothing was spent yet.
 */
export function Cost({ value, hideEmpty, labelled, className }: { value: CostInput; hideEmpty?: boolean; labelled?: boolean; className?: string }): ReactElement | null {
  const v = costView(value)
  if (hideEmpty && v.empty) return null
  return (
    <span className={`cost cost-${v.kind}${className ? ` ${className}` : ''}`} title={v.title || undefined}>
      {labelled && v.kind === 'unknown' ? 'Cost unknown' : v.text}
    </span>
  )
}
