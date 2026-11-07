/**
 * How many rows the Decision Tray gets (moved out of App.tsx so the tray owns its own sizing; issues #25, #28). Pure.
 */
import { cardDetailLines, hintPhrases, wrapPhrases } from './decisions'
import type { TrayCard } from './types'

/** Cards listed under the top card before the rest collapse to a count. */
export const NEXT_CARDS_MAX = 3

/**
 * Rows the Decision Tray gets, from the rows it would really draw: the header, the card's detail lines, one row for the
 * scroll cue / mode / status line, the key hints wrapped at this width, and the queued cards (or their count). At least 5
 * and at most about a third of the window (12 at the most), so a short card leaves the tree room (ux-review-tui-org.md
 * F3). Inline mode keeps its one footer line (3 = the footer's three lines).
 */
export function trayHeight(cards: readonly TrayCard[], cols: number, rows: number, inline: boolean): number {
  if (cards.length === 0) return inline ? 0 : 1
  if (inline) return 3
  const cap = Math.max(5, Math.min(12, Math.floor(rows * 0.35)))
  const width = Math.max(20, cols)
  let detail = 3
  let hints = 1
  try {
    detail = cardDetailLines(cards[0], width - 2).length
    hints = wrapPhrases(hintPhrases(cards[0], false), ' · ', width).length
  } catch {
    detail = 3
    hints = 1
  }
  const next = Math.min(NEXT_CARDS_MAX, cards.length - 1) + (cards.length - 1 > NEXT_CARDS_MAX ? 1 : 0)
  return Math.min(cap, Math.max(5, 1 + detail + 1 + hints + next))
}
