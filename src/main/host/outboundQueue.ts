/**
 * One socket's application-level outbound queue (cli-spec 3.3(4).4), in front of socket.write. Electron-free.
 *
 * - Frames are written in order; when socket.write returns false the queue waits for 'drain'.
 * - Push frames count against OUTBOUND_QUEUE_MAX_BYTES while they wait here (not yet handed to socket.write). Past it
 *   the socket is destroyed at once (onOverflow, logged once by the caller); the client resyncs with a snapshot. RPC
 *   responses never trip the cap: they are bounded by the frame caps, the in-flight limit and the bulk budget.
 * - Coalescing of unwritten frames: an agent.partial for (runId, agentId) replaces an unwritten partial of the same
 *   pair (the old one is dropped, the new one goes to the tail) unless a transcript or agent.upsert of that pair was
 *   queued after it; a transcript of a pair drops every unwritten partial of that pair.
 */

export const OUTBOUND_QUEUE_MAX_BYTES = 16 * 1024 * 1024

/** What the queue needs of a socket (net.Socket fits). */
export interface WritableSocketLike {
  write(chunk: string, cb?: (err?: Error | null) => void): boolean
  once(event: 'drain', listener: () => void): unknown
  end(): unknown
  destroy(): unknown
  readonly destroyed: boolean
}

export interface FrameMeta {
  kind: 'partial' | 'transcript' | 'upsert'
  /** `${runId}\u0000${agentId}`. */
  key: string
}

export interface EnqueueOptions {
  meta?: FrameMeta
  /** A push notification (counts against the cap). */
  push?: boolean
  /** Called once when the frame was written (write callback) or dropped (coalesced, destroyed). */
  onDone?: () => void
}

interface Item {
  frame: string
  bytes: number
  push: boolean
  meta?: FrameMeta
  onDone?: () => void
}

export function frameKey(runId: string, agentId: string): string {
  return `${runId}\u0000${agentId}`
}

export class OutboundQueue {
  private items: Item[] = []
  private pushBytes = 0
  private waitingDrain = false
  private ending = false
  private dead = false

  constructor(
    private readonly socket: WritableSocketLike,
    private readonly opts: { maxQueuedBytes?: number; onOverflow?: (queuedBytes: number) => void } = {}
  ) {}

  /** Push bytes waiting in this queue (not yet handed to socket.write). */
  get queuedBytes(): number {
    return this.pushBytes
  }

  /** Frames waiting in this queue. */
  get length(): number {
    return this.items.length
  }

  get closed(): boolean {
    return this.dead
  }

  /** Queue one frame (already '\n'-terminated). False when the queue is closed or overflowed (socket destroyed). */
  enqueue(frame: string, opts: EnqueueOptions = {}): boolean {
    if (this.dead || this.ending || this.socket.destroyed) {
      opts.onDone?.()
      return false
    }
    const item: Item = { frame, bytes: Buffer.byteLength(frame, 'utf8'), push: opts.push === true, meta: opts.meta, onDone: opts.onDone }
    if (item.meta?.kind === 'partial') this.dropPartial(item.meta.key, true)
    else if (item.meta?.kind === 'transcript') this.dropPartial(item.meta.key, false)
    if (item.push && this.pushBytes + item.bytes > (this.opts.maxQueuedBytes ?? OUTBOUND_QUEUE_MAX_BYTES)) {
      const queued = this.pushBytes + item.bytes
      item.onDone?.()
      this.destroy()
      this.opts.onOverflow?.(queued)
      return false
    }
    this.items.push(item)
    if (item.push) this.pushBytes += item.bytes
    this.flush()
    return true
  }

  /** Flush what is queued, then end the socket (a refused handshake). */
  end(): void {
    if (this.dead || this.ending) return
    this.ending = true
    this.flush()
  }

  /** Drop everything unwritten (onDone each) and destroy the socket. Idempotent. */
  destroy(): void {
    if (this.dead) return
    this.dead = true
    const items = this.items
    this.items = []
    this.pushBytes = 0
    for (const it of items) it.onDone?.()
    if (!this.socket.destroyed) this.socket.destroy()
  }

  /**
   * Remove unwritten partials of `key`. For a new partial (`stopAtBarrier`), scan back from the tail and stop at a
   * transcript or agent.upsert of the same key: a partial before such a barrier is kept.
   */
  private dropPartial(key: string, stopAtBarrier: boolean): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i].meta
      if (!m || m.key !== key) continue
      if (m.kind !== 'partial') {
        if (stopAtBarrier) return
        continue
      }
      const [gone] = this.items.splice(i, 1)
      if (gone.push) this.pushBytes -= gone.bytes
      gone.onDone?.()
      if (stopAtBarrier) return
    }
  }

  private flush(): void {
    while (!this.dead && !this.waitingDrain && this.items.length > 0) {
      if (this.socket.destroyed) {
        this.destroy()
        return
      }
      const it = this.items.shift() as Item
      if (it.push) this.pushBytes -= it.bytes
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        it.onDone?.()
      }
      let ok: boolean
      try {
        ok = this.socket.write(it.frame, finish)
      } catch {
        finish()
        this.destroy()
        return
      }
      if (!ok) {
        this.waitingDrain = true
        this.socket.once('drain', () => {
          this.waitingDrain = false
          this.flush()
        })
      }
    }
    if (!this.dead && this.ending && !this.waitingDrain && this.items.length === 0) {
      this.dead = true
      this.socket.end()
    }
  }
}
