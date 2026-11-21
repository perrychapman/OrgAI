import { costView, formatDuration, formatTokens } from '../../lib/cost'
import { parseDurationText, parseTokenText } from '../../lib/tween'
import { PARTIAL_COST_TITLE, type SummaryItemModel } from '../../lib/usagePage'

/**
 * How a summary figure reads and what number it stands for, shared by the KPI band and the Pacing header so both say
 * the same thing in the same words: unknown is "Not priced" (never $0), a lower bound is "$0.42+" or "At least $4.20".
 */

export function figure(i: SummaryItemModel): { text: string; title?: string } {
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

/** The number a figure stands for (null = unknown or not numeric: it never counts up or tweens). The item carries text, so parse it back. */
export function figureNumber(i: SummaryItemModel): number | null {
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

/** The item as it reads while a count or tween shows `v` (same formatters as the final figure). */
export function figureAt(i: SummaryItemModel, v: number): SummaryItemModel {
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
