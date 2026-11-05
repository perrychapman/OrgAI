/**
 * The host-wide bulk frame memory budget (cli-spec 3.3(1)): one semaphore of RPC_BULK_MEMORY_BUDGET_BYTES across every
 * socket, counting incoming lines while they grow past RPC_CONTROL_REQUEST_MAX_BYTES and outgoing frames over that
 * size until their write completes. Electron-free, no imports beyond shared constants.
 */
import { RPC_BULK_MEMORY_BUDGET_BYTES } from '../../shared/types'

/** One holder's share of the budget. release() is idempotent; grow() never shrinks. */
export interface BulkReservation {
  readonly bytes: number
  /** Raise this reservation to `total` bytes. False (and unchanged) when the budget cannot cover the increase. */
  grow(total: number): boolean
  release(): void
}

export class BulkBudget {
  private usedBytes = 0

  constructor(readonly totalBytes: number = RPC_BULK_MEMORY_BUDGET_BYTES) {}

  get used(): number {
    return this.usedBytes
  }

  get available(): number {
    return this.totalBytes - this.usedBytes
  }

  /** Reserve `bytes`, or null when the budget cannot cover it. */
  reserve(bytes: number): BulkReservation | null {
    const n = Math.max(0, Math.ceil(bytes))
    if (n > this.available) return null
    this.usedBytes += n
    let held = n
    let released = false
    const self = this
    return {
      get bytes() {
        return released ? 0 : held
      },
      grow(total: number): boolean {
        if (released) return false
        const want = Math.ceil(total)
        if (want <= held) return true
        const extra = want - held
        if (extra > self.available) return false
        self.usedBytes += extra
        held = want
        return true
      },
      release(): void {
        if (released) return
        released = true
        self.usedBytes -= held
        held = 0
      }
    }
  }
}
