/**
 * Decision card bookkeeping for `orgai decide` and expectedRevision (cli-spec 3.4(4)): a live index of every pending
 * card (request id -> run, kind, revision) and a bounded map of tombstones for cards that were resolved or cancelled,
 * so a late or duplicate answer reads 'already-resolved' / 'cancelled' instead of 'not-found'. Pure bookkeeping, no
 * timers; RunManager owns it.
 */
import type { CardKind, DecidedBy, DecisionLookup, DecisionOutcome } from '@shared/types'
import { DECISION_TOMBSTONES_MAX } from '@shared/types'

export interface IndexedCard {
  runId: string
  projectId: string
  kind: CardKind
  revision: number
}

export interface DecisionTombstone {
  status: 'applied' | 'cancelled'
  kind: CardKind
  effectiveDecision?: string
  decidedBy?: DecidedBy
  runId: string
  at: number
}

export class DecisionIndex {
  private readonly requestIndex = new Map<string, IndexedCard>()
  private readonly tombstones = new Map<string, DecisionTombstone>()

  constructor(private readonly max: number = DECISION_TOMBSTONES_MAX) {}

  /** A new pending card. */
  add(requestId: string, card: IndexedCard): void {
    this.requestIndex.set(requestId, card)
  }

  get(requestId: string): IndexedCard | undefined {
    return this.requestIndex.get(requestId)
  }

  /** The card left the pending set: drop it from the index and record how it ended (oldest tombstone evicted past the cap). */
  resolve(requestId: string, tomb: Omit<DecisionTombstone, 'at' | 'kind' | 'runId'> & Partial<Pick<DecisionTombstone, 'at' | 'kind' | 'runId'>>): void {
    const card = this.requestIndex.get(requestId)
    this.requestIndex.delete(requestId)
    const kind = tomb.kind ?? card?.kind
    const runId = tomb.runId ?? card?.runId
    if (!kind || !runId) return
    // Re-inserting moves the entry to the newest position.
    this.tombstones.delete(requestId)
    this.tombstones.set(requestId, {
      status: tomb.status,
      kind,
      runId,
      at: tomb.at ?? Date.now(),
      ...(tomb.effectiveDecision !== undefined ? { effectiveDecision: tomb.effectiveDecision } : {}),
      ...(tomb.decidedBy ? { decidedBy: tomb.decidedBy } : {})
    })
    while (this.tombstones.size > this.max) {
      const oldest = this.tombstones.keys().next().value
      if (oldest === undefined) break
      this.tombstones.delete(oldest)
    }
  }

  tombstone(requestId: string): DecisionTombstone | undefined {
    return this.tombstones.get(requestId)
  }

  /** The outcome a decision method returns for a card that is no longer pending. */
  missOutcome(requestId: string): DecisionOutcome {
    const t = this.tombstones.get(requestId)
    if (!t) return { status: 'not-found', requestId }
    return {
      status: t.status === 'cancelled' ? 'cancelled' : 'already-resolved',
      requestId,
      runId: t.runId,
      ...(t.effectiveDecision !== undefined ? { effectiveDecision: t.effectiveDecision } : {}),
      ...(t.decidedBy ? { decidedBy: t.decidedBy } : {})
    }
  }

  /** runs:findDecision. */
  lookup(requestId: string): DecisionLookup {
    const card = this.requestIndex.get(requestId)
    if (card) return { status: 'pending', requestId, runId: card.runId, projectId: card.projectId, kind: card.kind, revision: card.revision }
    const t = this.tombstones.get(requestId)
    if (t) {
      return {
        status: t.status,
        requestId,
        runId: t.runId,
        kind: t.kind,
        at: t.at,
        ...(t.effectiveDecision !== undefined ? { effectiveDecision: t.effectiveDecision } : {}),
        ...(t.decidedBy ? { decidedBy: t.decidedBy } : {})
      }
    }
    return { status: 'not-found', requestId }
  }

  /** Counts, for tests and diagnostics. */
  size(): { pending: number; tombstones: number } {
    return { pending: this.requestIndex.size, tombstones: this.tombstones.size }
  }
}
