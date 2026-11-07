/**
 * How many rows the Decision Tray gets (moved out of App.tsx so the tray owns its own sizing; issue #28). Pure.
 */
import { cardDetailLines } from './decisions'
import type { TrayCard } from './types'

/**
 * Rows the Decision Tray gets: what the top card needs (header, detail lines, a status or mode line, the key hints, the
 * next cards), at least 5 and at most about a third of the window (12 at the most), so a short card leaves the tree room
 * (ux-review-tui-org.md F3). Inline mode keeps its one footer line (3 = the footer's three lines).
 */
export function trayHeight(cards: readonly TrayCard[], cols: number, rows: number, inline: boolean): number {
  if (cards.length === 0) return inline ? 0 : 1
  if (inline) return 3
  const cap = Math.max(5, Math.min(12, Math.floor(rows * 0.35)))
  let detail = 3
  try {
    detail = cardDetailLines(cards[0], Math.max(18, cols - 4)).length
  } catch {
    detail = 3
  }
  const next = Math.min(3, cards.length - 1) + (cards.length - 1 > 3 ? 1 : 0)
  return Math.min(cap, Math.max(5, 1 + detail + 1 + 2 + next))
}
