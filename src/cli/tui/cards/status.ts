/** The tray's status sentences (W4-T2): decision outcomes and why an open confirmation closed. Pure. */
import type { DecidedBy, DecisionOutcome } from '../../../shared/types'
import { sanitizeTty } from '../sanitizeTty'
import type { ResolvedCardInfo, Tone, TrayCard } from '../types'

export interface TrayStatus {
  text: string
  tone?: Tone
}

/** Who resolved a card, in words. Only the headless policy, the CLI or a terminal UI can (nothing else shares this process). */
export function surfaceWords(by: DecidedBy | undefined): string {
  if (!by) return 'something else'
  switch (by.surface) {
    case 'tui':
      return 'the terminal UI'
    case 'cli':
      return 'the CLI'
    case 'policy':
      return 'the headless decision policy'
    default:
      return 'something else'
  }
}

function line(s: unknown): string {
  return sanitizeTty(typeof s === 'string' ? s : String(s ?? '')).replace(/\s+/g, ' ').trim()
}

/** The status line after a decision call answered; undefined when nothing needs saying (applied: the card leaves by events). */
export function outcomeStatus(o: DecisionOutcome): TrayStatus | undefined {
  switch (o.status) {
    case 'applied':
      return o.applyError ? { text: `It could not be applied: ${line(o.applyError)}. The agent was asked to revise.`, tone: 'warn' } : undefined
    case 'stale-revision':
      return { text: 'The card changed; check it again', tone: 'warn' }
    case 'already-resolved':
      return { text: `Resolved by ${surfaceWords(o.decidedBy)}`, tone: 'dim' }
    case 'cancelled':
      return { text: o.decidedBy ? `Resolved by ${surfaceWords(o.decidedBy)}` : 'The card was cancelled; its run ended', tone: 'dim' }
    case 'not-found':
      return { text: 'That decision is no longer open', tone: 'dim' }
    default:
      return undefined
  }
}

/** The status line of a rejected decision call (the error text, sanitized). */
export function rejectionStatus(e: unknown): TrayStatus {
  const data = (e as { data?: { message?: unknown } } | null)?.data
  const msg = data?.message ?? (e instanceof Error ? e.message : e)
  return { text: line(msg) || 'The decision could not be sent.', tone: 'danger' }
}

/**
 * Why a confirmation (or an open note or secret field) bound to `boundKey` closed: the card was resolved elsewhere,
 * cancelled, or changed (a new revision or another card on top).
 */
export function boundCardClosedStatus(bound: Pick<TrayCard, 'key' | 'ref'>, resolved: readonly ResolvedCardInfo[]): TrayStatus {
  const newestFirst = [...resolved].reverse()
  const info =
    newestFirst.find((r) => r.key === bound.key) ??
    newestFirst.find((r) => r.ref.runId === bound.ref.runId && r.ref.kind === bound.ref.kind && r.ref.requestId === bound.ref.requestId)
  if (info) {
    if (info.cancelled) return { text: 'The card was cancelled; its run ended', tone: 'dim' }
    // This tray leaves a bound mode before it sends its own decision, so a decision that closes one came from the
    // headless policy or this terminal's own flow (nothing else can answer this process's cards).
    if (info.decidedBy) return { text: `Resolved by ${surfaceWords(info.decidedBy)}`, tone: 'dim' }
  }
  return { text: 'The card changed', tone: 'dim' }
}
