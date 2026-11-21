/**
 * The proportional ribbon that leads "Where it went": one bar split by share of the known cost, the top rows each
 * with their colour and the rest folded into Other. Pure; BreakdownCard's panels draw it.
 *
 * Shares are of known cost only. A row whose cost is unknown has no width (unknown is never a zero-width share): it is
 * counted so the caption can say so, and its row says "Not priced".
 */
export const RIBBON_TOP = 5

export interface RibbonEntry {
  /** The row's id (the ribbon segment narrows the same way the row does). */
  id: string
  name: string
  /** Known cost, or null when unknown. */
  value: number | null
  /** A lower bound: some runs in it have no price. */
  partial: boolean
  /** The row's colour (a token reference). */
  fill: string
}

export interface RibbonSegment {
  /** The entry id, or null for Other. */
  id: string | null
  name: string
  value: number
  /** 0..1 of the known total. */
  share: number
  /** "61%" (under 1% reads "<1%"). */
  percent: string
  fill: string
  partial: boolean
  /** How many rows an Other segment holds. */
  count: number
}

export interface Ribbon {
  segments: RibbonSegment[]
  /** Rows with no known cost (no width in the ribbon). */
  unknown: number
  total: number
}

export function percentWord(share: number): string {
  if (share <= 0) return '0%'
  const p = Math.round(share * 100)
  return p < 1 ? '<1%' : `${p}%`
}

/** The ribbon of the ranked entries: the first `top` with a known cost keep their own segment, the remainder fold into Other. */
export function buildRibbon(entries: readonly RibbonEntry[], otherFill: string, top = RIBBON_TOP): Ribbon {
  const known = entries.filter((e) => e.value !== null && e.value > 0)
  const unknown = entries.filter((e) => e.value === null).length
  const total = known.reduce((n, e) => n + (e.value ?? 0), 0)
  if (!(total > 0)) return { segments: [], unknown, total: 0 }
  const own = known.slice(0, top)
  const rest = known.slice(top)
  const segments: RibbonSegment[] = own.map((e) => ({
    id: e.id,
    name: e.name,
    value: e.value ?? 0,
    share: (e.value ?? 0) / total,
    percent: percentWord((e.value ?? 0) / total),
    fill: e.fill,
    partial: e.partial,
    count: 1
  }))
  if (rest.length > 0) {
    const value = rest.reduce((n, e) => n + (e.value ?? 0), 0)
    segments.push({
      id: null,
      name: `Other (${rest.length})`,
      value,
      share: value / total,
      percent: percentWord(value / total),
      fill: otherFill,
      partial: rest.some((e) => e.partial),
      count: rest.length
    })
  }
  return { segments, unknown, total }
}

/** The ribbon's one-line caption: what is not in it. Empty when every row is priced. */
export function ribbonNote(r: Ribbon): string {
  if (r.unknown <= 0) return ''
  const rows = `${r.unknown} ${r.unknown === 1 ? 'row has' : 'rows have'} no known price`
  return r.total > 0 ? `${rows} and ${r.unknown === 1 ? 'is' : 'are'} not in the ribbon.` : `${rows}, so there is nothing to split.`
}

/** The text on a segment's title: "orgai: 61% of the estimated cost". */
export function ribbonTitle(s: RibbonSegment): string {
  return `${s.name}: ${s.percent} of the estimated cost${s.partial ? ' (at least, some runs have no price)' : ''}`
}
