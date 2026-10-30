import type { ReactElement } from 'react'
import { costView, type CostInput } from '../../lib/cost'

/**
 * One cost figure, worded by lib/cost.ts: "unknown" (never $0), "$0.42+" for a lower bound, and a tooltip that says
 * whether the provider reported it or OrgAI computed it (and whether it predates usage tracking).
 * Pass `hideEmpty` to render nothing when nothing was spent yet.
 */
export function Cost({ value, hideEmpty, className }: { value: CostInput; hideEmpty?: boolean; className?: string }): ReactElement | null {
  const v = costView(value)
  if (hideEmpty && v.empty) return null
  return (
    <span className={`cost cost-${v.kind}${className ? ` ${className}` : ''}`} title={v.title || undefined}>
      {v.text}
    </span>
  )
}
