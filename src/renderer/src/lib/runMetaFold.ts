/** Pure parts of the run header's fold (components/RunMeta.tsx, useMetaFold). */

export interface FoldedItem {
  /** Index among the line's children; the original element is re-found by it. */
  idx: number
  label: string
  interactive: boolean
  /** The test id of the chip's button (or of the chip), repeated on its menu item: only one of the two is visible at a time. */
  testId?: string
  /** The chip button's title (what it does), repeated on its menu item. */
  title?: string
  /** The chip's screen-reader-only text, repeated after the label. */
  srText?: string
}

/**
 * The folded chips as menu items, in line order, from what the line shows right now (`isFolded` reads the DOM's
 * data-folded). A chip whose text is empty is not listed. The menu reads this when it opens, so it can never disagree with
 * which chips are display:none, whatever the fold's state last committed.
 */
export function listFolded<T>(kids: readonly T[], isFolded: (kid: T) => boolean, describe: (kid: T) => Omit<FoldedItem, 'idx'>): FoldedItem[] {
  const out: FoldedItem[] = []
  kids.forEach((kid, idx) => {
    if (!isFolded(kid)) return
    const d = describe(kid)
    if (d.label) out.push({ idx, ...d })
  })
  return out
}

export type FoldDecision = 'commit' | 'settle' | 'skip'

/**
 * Two fold answers that keep replacing each other (a chip that fits only by a sub-pixel) would loop until React stops the
 * page. In one burst (changes less than `windowMs` apart from the burst's start) the first `limit` changes commit, the next
 * one settles (commits the latest answer once, so state matches what the measure wrote to the DOM at that moment) and the
 * rest are skipped.
 */
export function createFoldGuard(limit = 6, windowMs = 200): (now: number) => FoldDecision {
  let at = 0
  let n = 0
  return (now) => {
    if (now - at > windowMs) {
      at = now
      n = 0
    }
    n++
    if (n <= limit) return 'commit'
    return n === limit + 1 ? 'settle' : 'skip'
  }
}
