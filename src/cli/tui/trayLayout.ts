/**
 * How many rows the Decision Tray gets (moved out of App.tsx so the tray owns its own sizing; issues #25, #28). Pure.
 */
import { cardDetailLines, hintPhrases, proposalPreview, wrapPhrases } from './decisions'
import { INLINE_TRAY_MAX } from './layout'
import type { TrayCard } from './types'

/** Cards listed under the top card before the rest collapse to a count. */
export const NEXT_CARDS_MAX = 3
export const PROPOSAL_CARD_MAX_WIDTH = 96

/**
 * Rows the Decision Tray gets, from the rows it would really draw: the header, the card's detail lines, one row for the
 * scroll cue / mode / status line, the key hints wrapped at this width, and the queued cards (or their count). At least 5
 * and at most about a third of the window (12 at the most), so a short card leaves the tree room (ux-review-tui-org.md
 * F3). Inline mode keeps its one footer line (3 = the footer's three lines).
 */
export function trayHeight(cards: readonly TrayCard[], cols: number, rows: number, inline: boolean, focused = true, focusHint = 'Shift+Tab to choose'): number {
  if (cards.length === 0) return inline ? 0 : 1
  if (inline) {
    // The footer: the card's title line, then its key row wrapped at separators (only while the tray has focus; R2-M2).
    if (!focused) return 1
    try {
      return Math.min(INLINE_TRAY_MAX, 1 + wrapPhrases(hintPhrases(cards[0], false), ' · ', Math.max(20, cols)).length)
    } catch {
      return 2
    }
  }
  const cap = Math.max(5, Math.min(12, Math.floor(rows * 0.35)))
  const isPreview = proposalPreview(cards[0], cols) !== undefined
  const width = Math.max(20, isPreview ? Math.min(cols, PROPOSAL_CARD_MAX_WIDTH) - 3 : cols)
  let detail = 3
  let hints = 1
  try {
    detail = (proposalPreview(cards[0], width - 2) ?? cardDetailLines(cards[0], width - 2)).length
    hints = wrapPhrases([...hintPhrases(cards[0], false, true), focused ? 'Esc to type' : focusHint], ' · ', width).length
  } catch {
    detail = 3
    hints = 1
  }
  const next = Math.min(NEXT_CARDS_MAX, cards.length - 1) + (cards.length - 1 > NEXT_CARDS_MAX ? 1 : 0)
  return Math.min(cap, Math.max(5, 1 + detail + 1 + hints + next + (isPreview ? 1 : 0)))
}
