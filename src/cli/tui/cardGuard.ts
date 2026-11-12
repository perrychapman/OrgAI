/**
 * The card-swap input guard (cli-spec 5.3(2), W4-T2). Whenever the top tray card changes (a different card, or the same
 * request at a new revision: `cardKey` covers host, run, kind, request and revision) action keys are ignored for
 * `guardMs`, so a key meant for the card that just left can never decide the one that replaced it. The first card
 * shown (the tray appearing) starts the window too. The host still validates expectedRevision on its side.
 */
import { CARD_SWAP_GUARD_MS } from './types'

export class CardSwapGuard {
  private readonly guardMs: number
  private current: string | undefined
  private observed = false
  private changedAt = Number.NEGATIVE_INFINITY
  private replacedCard = false

  /** The current window began because another card was replaced (false: the tray had no card before). */
  get replaced(): boolean {
    return this.replacedCard
  }

  constructor(guardMs: number = CARD_SWAP_GUARD_MS) {
    this.guardMs = Number.isFinite(guardMs) && guardMs >= 0 ? guardMs : CARD_SWAP_GUARD_MS
  }

  /** Record the top card key; true when it changed (the window then restarts at `now`). */
  observe(key: string | undefined, now: number): boolean {
    if (this.observed && key === this.current) return false
    const first = !this.observed
    this.replacedCard = this.current !== undefined && key !== undefined
    this.observed = true
    this.current = key
    // No card at all is nothing to guard against; the window starts when a card appears.
    if (key !== undefined) this.changedAt = now
    return !first || key !== undefined
  }

  /** false inside the guard window after a change. */
  accepts(now: number): boolean {
    if (this.current === undefined) return false
    return now - this.changedAt >= this.guardMs
  }

  /** Milliseconds left in the window (0 when keys are accepted). */
  remaining(now: number): number {
    if (this.current === undefined) return 0
    return Math.max(0, this.guardMs - (now - this.changedAt))
  }

  get key(): string | undefined {
    return this.current
  }
}
