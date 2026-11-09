/**
 * A run-chain follower over `runs:subscribe` (cli-spec 3.3(4)), used by `orgai exec` and the terminal UI.
 *
 * - `start()` subscribes on the given client with the caller's input (runIds, followChains, includeActiveRunRecord);
 *   notifications that arrive before the result is applied are queued, then applied in order.
 * - A `snapshot` answer goes to `onSnapshot` (lastSeq = its seq); a `replay` answer's events go through `onEvent`
 *   like pushed ones. Durable events (`seq`) at or below lastSeq are dropped, so a replay after a reconnect never
 *   applies anything twice; a transient agent.partial (`atSeq`) always passes.
 * - When the socket closes, one reconnect loop runs with backoff (250 ms doubling to 5 s) for up to the window
 *   (30 s by default) and resubscribes with sinceSeq + hostInstanceId + filterKey. Past the window `onGone` fires.
 * - `resubscribe()` re-runs runs:subscribe on the current client with the resume fields (sinceSeq + hostInstanceId +
 *   filterKey), queueing notifications during the call exactly like `start()`: the TUI calls it after SIGCONT (an
 *   unchanged filter gets a replay) and after a focus change (a new includeActiveRunRecord changes the filterKey, so
 *   the host answers a snapshot).
 * - The follower itself never asks to be non-interactive: `orgai exec` puts `nonInteractive` in their
 *   subscribe input (exec subscribers must not hold the human grace window); the TUI leaves it out.
 */
import type { RunsEventParams, RunsSubscribeInput, RunsSubscribeResult } from '../../shared/types'
import type { ConnectResult, HostClient } from '../types'

export const RUN_STREAM_RECONNECT_WINDOW_MS = 30_000
const BACKOFF_START_MS = 250
const BACKOFF_MAX_MS = 5_000

export interface RunStreamTimers {
  sleep(ms: number): Promise<void>
  now(): number
}

export const defaultRunStreamTimers: RunStreamTimers = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now()
}

export type SnapshotResult = Extract<RunsSubscribeResult, { mode: 'snapshot' }>

export interface RunStreamOptions {
  client: HostClient
  /** A fresh connection for a reconnect (same scopes as the first one). */
  connect: () => Promise<ConnectResult>
  /** The subscribe input without the resume fields (runIds, followChains, includeActiveRunRecord), read per call. */
  subscribeInput: () => Omit<RunsSubscribeInput, 'sinceSeq' | 'hostInstanceId' | 'filterKey'>
  /** A pushed or replayed event (durable ones deduplicated by seq). */
  onEvent: (p: RunsEventParams) => void
  /** A snapshot answer; `firstTime` for the first subscribe. */
  onSnapshot: (res: SnapshotResult, firstTime: boolean) => void
  /** The reconnect window passed without a successful resubscribe. */
  onGone: () => void
  /** True once the caller is done: no more events, no reconnects. */
  stopped: () => boolean
  /** Timers (an object read at call time, so tests may swap its members). */
  timers?: RunStreamTimers
  reconnectWindowMs?: number
  /** The socket closed and the reconnect loop started (optional; the TUI shows "reconnecting"). */
  onReconnecting?: () => void
  /** A (re)subscribe answered and was applied (optional; after a reconnect, `firstTime` is false). */
  onSubscribed?: (mode: RunsSubscribeResult['mode'], firstTime: boolean) => void
  /**
   * true: the first client belongs to the caller: close() and a reconnect leave it open; a replacement client from a
   * reconnect is the stream's own and is still closed. A function: every client it answers true for belongs to the
   * caller and is never closed by the stream (the TUI's connection owns the clients its `connect` hands out too).
   */
  keepClient?: boolean | ((c: HostClient) => boolean)
}

export class RunStream {
  private current: HostClient
  private lastSeqValue: number | undefined
  private hostInstanceId: string | undefined
  private filterKey: string | undefined
  private offNote: () => void = () => undefined
  private offClose: () => void = () => undefined
  /**
   * One reconnect loop at a time. Set while a (re)subscribe is in flight too: a socket that closes during
   * runs:subscribe rejects that call (the loop, or the first subscribe, handles it), so its close listener must not
   * start a second loop.
   */
  private reconnecting = false
  /** The client whose socket closed while a (re)subscribe was in flight; checked once that subscribe settles. */
  private closedWhileBusy: HostClient | undefined
  private closed = false
  /** resubscribe() was called while a (re)subscribe was busy. */
  private resubscribeQueued = false

  constructor(private readonly o: RunStreamOptions) {
    this.current = o.client
  }

  /** The client in use (replaced after a reconnect). */
  get client(): HostClient {
    return this.current
  }

  /** The last durable seq applied. */
  get lastSeq(): number | undefined {
    return this.lastSeqValue
  }

  private get timers(): RunStreamTimers {
    return this.o.timers ?? defaultRunStreamTimers
  }

  private done(): boolean {
    return this.closed || this.o.stopped()
  }

  /** The first subscribe. On failure the listeners are removed, the client closed and the error rethrown. */
  async start(): Promise<void> {
    try {
      this.reconnecting = true
      this.watchClose(this.current)
      await this.subscribe(this.current, true)
    } catch (e) {
      this.close()
      throw e
    } finally {
      this.reconnecting = false
    }
    // The socket closed right after the first subscribe answered: reconnect now that the loop may start.
    if (this.closedWhileBusy === this.current) {
      this.closedWhileBusy = undefined
      void this.reconnect()
      return
    }
    this.runQueuedResubscribe()
  }

  /**
   * Subscribe again on the current client (resume fields included). While another (re)subscribe or the reconnect loop
   * is busy, one more resubscribe is queued for when it settles, so the newest subscribe input always wins. Rejects
   * when the call fails; a socket that closed during it starts the reconnect loop instead.
   */
  async resubscribe(): Promise<void> {
    if (this.done()) return
    if (this.reconnecting) {
      this.resubscribeQueued = true
      return
    }
    const c = this.current
    try {
      this.reconnecting = true
      await this.subscribe(c, false)
    } catch (e) {
      if (this.closedWhileBusy !== c) throw e
    } finally {
      this.reconnecting = false
    }
    if (this.closedWhileBusy === c) {
      this.closedWhileBusy = undefined
      void this.reconnect()
      return
    }
    this.runQueuedResubscribe()
  }

  /** A resubscribe asked for while busy runs now (errors are dropped: the caller's promise already settled). */
  private runQueuedResubscribe(): void {
    if (!this.resubscribeQueued || this.reconnecting || this.done()) return
    this.resubscribeQueued = false
    void this.resubscribe().catch(() => undefined)
  }

  /** Remove the listeners and close the client (not the caller's, with keepClient). Idempotent. */
  close(): void {
    this.closed = true
    this.offNote()
    this.offClose()
    this.closeOwned(this.current)
  }

  private closeOwned(c: HostClient): void {
    const keep = this.o.keepClient
    if (typeof keep === 'function' ? keep(c) : keep === true && c === this.o.client) return
    c.close()
  }

  private onRunsEvent(p: RunsEventParams): void {
    if (this.done() || !p || typeof p !== 'object' || !p.event) return
    if (typeof p.seq === 'number') {
      if (this.lastSeqValue !== undefined && p.seq <= this.lastSeqValue) return
      this.lastSeqValue = p.seq
    }
    this.o.onEvent(p)
  }

  private apply(res: RunsSubscribeResult, firstTime: boolean): void {
    this.hostInstanceId = res.hostInstanceId
    this.filterKey = res.filterKey
    if (res.mode === 'replay') {
      for (const e of res.events) this.onRunsEvent({ seq: e.seq, event: e.event })
      if (typeof res.toSeq === 'number' && (this.lastSeqValue === undefined || res.toSeq > this.lastSeqValue)) this.lastSeqValue = res.toSeq
      return
    }
    this.lastSeqValue = res.seq
    if (!this.done()) this.o.onSnapshot(res, firstTime)
  }

  private async subscribe(c: HostClient, firstTime: boolean): Promise<void> {
    let queue: RunsEventParams[] | null = []
    this.offNote()
    this.offNote = c.onNotification((method, params) => {
      if (method !== 'runs:event') return
      if (queue) queue.push(params as RunsEventParams)
      else this.onRunsEvent(params as RunsEventParams)
    })
    const input: RunsSubscribeInput = {
      ...this.o.subscribeInput(),
      ...(this.lastSeqValue !== undefined && this.hostInstanceId
        ? { sinceSeq: this.lastSeqValue, hostInstanceId: this.hostInstanceId, ...(this.filterKey ? { filterKey: this.filterKey } : {}) }
        : {})
    }
    let res: RunsSubscribeResult
    try {
      res = await c.call<RunsSubscribeResult>('runs:subscribe', [input], { timeoutMs: 60_000 })
    } catch (e) {
      // The host keeps the socket's earlier subscription when a resubscribe fails (a timeout, a refusal): deliver what
      // was queued and go back to direct delivery, so the stream never stays deaf with an ever-growing queue.
      const pending = queue
      queue = null
      for (const p of pending) this.onRunsEvent(p)
      throw e
    }
    this.apply(res, firstTime)
    const pending = queue
    queue = null
    for (const p of pending) this.onRunsEvent(p)
    if (!this.done()) this.o.onSubscribed?.(res.mode, firstTime)
  }

  private watchClose(c: HostClient): void {
    this.offClose()
    this.offClose = c.onClose(() => {
      if (this.done()) return
      if (this.reconnecting) this.closedWhileBusy = c
      else void this.reconnect()
    })
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    if (!this.done()) this.o.onReconnecting?.()
    try {
      const window = this.o.reconnectWindowMs ?? RUN_STREAM_RECONNECT_WINDOW_MS
      const started = this.timers.now()
      let delay = BACKOFF_START_MS
      while (!this.done()) {
        await this.timers.sleep(delay)
        if (this.done()) return
        const res = await this.o.connect().catch(() => undefined)
        if (res?.ok) {
          if (this.done()) {
            this.closeOwned(res.client)
            return
          }
          // The old client is closed before it is replaced, so no socket outlives the command.
          const previous = this.current
          this.current = res.client
          if (previous !== this.current) this.closeOwned(previous)
          try {
            this.watchClose(this.current)
            await this.subscribe(this.current, false)
            if (this.closedWhileBusy !== this.current) return
          } catch {
            // closed or refused: try again
          }
          this.closedWhileBusy = undefined
          this.closeOwned(this.current)
        }
        if (this.timers.now() - started >= window) {
          if (!this.done()) this.o.onGone()
          return
        }
        delay = Math.min(BACKOFF_MAX_MS, delay * 2)
      }
    } finally {
      this.reconnecting = false
      this.runQueuedResubscribe()
    }
  }
}
