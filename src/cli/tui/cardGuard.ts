/** The 750 ms card-swap input guard (cli-spec 5.3(2), W4-T2). Stub until W4-T2 lands. */
import { CARD_SWAP_GUARD_MS } from './types'

export class CardSwapGuard {
  private readonly guardMs: number
  constructor(guardMs: number = CARD_SWAP_GUARD_MS) {
    this.guardMs = guardMs
  }

  /** true when the top card changed. */
  observe(key: string | undefined, now: number): boolean {
    void [key, now, this.guardMs]
    throw new Error('not implemented (Wave 4)')
  }

  accepts(now: number): boolean {
    void now
    throw new Error('not implemented (Wave 4)')
  }

  get key(): string | undefined {
    throw new Error('not implemented (Wave 4)')
  }
}
