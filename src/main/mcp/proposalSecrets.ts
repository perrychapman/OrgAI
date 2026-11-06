/**
 * Wave 7 (cli-standalone.md round 6 item 10): an approved MCP proposal stores the values typed on its card before it
 * changes mcp-library.json or projects.json. When the secret store refuses them, McpService.applyProposal /
 * applyLibraryProposal throw this before any record changed (and every value they wrote is put back), so RunManager
 * keeps the card open waiting for secrets instead of answering it. Light on purpose: RunManager and the storesSecret
 * predicates (host/storesSecret.ts, bundled into the CLI) import this file, so it imports shared types only.
 */
import type { McpSecretKind, McpServersProposalPayload } from '../../shared/types'
import { proposalSecretKey } from '../../shared/types'

export class ProposalSecretsNotSaved extends Error {
  constructor(readonly reason: string) {
    // The store's sentences may end with a period; the caller appends its own.
    super(`The secret values could not be saved: ${reason.replace(/[.\s]+$/, '')}`)
    this.name = 'ProposalSecretsNotSaved'
  }
}

/** One secret slot of an MCP proposal card, well formed. */
export interface ProposalSecretSlot {
  serverId: string
  kind: McpSecretKind
  name: string
}

/** A slot as the card lists it: a string server id and name, kind 'env' or 'header'. */
export function isProposalSecretSlot(slot: unknown): slot is ProposalSecretSlot {
  if (!slot || typeof slot !== 'object') return false
  const s = slot as { serverId?: unknown; kind?: unknown; name?: unknown }
  return typeof s.serverId === 'string' && typeof s.name === 'string' && (s.kind === 'env' || s.kind === 'header')
}

/** The ids of the servers a proposal adds or changes: only their slots take a typed value. */
export function proposalUpsertedIds(p: Pick<McpServersProposalPayload, 'upsert'>): Set<string> {
  return new Set((Array.isArray(p.upsert) ? p.upsert : []).map((u) => u?.id).filter((id): id is string => typeof id === 'string'))
}

/**
 * The value typed on the card for one slot, as it would be stored: a non-empty string under the slot's
 * proposalSecretKey, and for a header one line only. Undefined otherwise (nothing is stored for it).
 */
export function typedSlotValue(slot: ProposalSecretSlot, values: unknown): string | undefined {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return undefined
  const key = proposalSecretKey(slot)
  const v = Object.hasOwn(values, key) ? (values as Record<string, unknown>)[key] : undefined
  if (typeof v !== 'string' || v === '' || (slot.kind === 'header' && /[\r\n]/.test(v))) return undefined
  return v
}

/**
 * The card's slots that take a typed value: a well-formed slot of a server the proposal upserts, with a value
 * typedSlotValue accepts. The one rule shared by the setup:decide storesSecret predicate (prepare the vault exactly
 * when this is non-empty) and McpService.planProposalSecrets (which also drops a slot the saved definition does not
 * declare, or one of a library entry that keeps its values per project), so the two never disagree about a slot.
 */
export function proposalTypedSlots(p: Pick<McpServersProposalPayload, 'upsert' | 'secrets'>, values: unknown): Array<{ slot: ProposalSecretSlot; value: string }> {
  const upserted = proposalUpsertedIds(p)
  const out: Array<{ slot: ProposalSecretSlot; value: string }> = []
  for (const slot of Array.isArray(p.secrets) ? p.secrets : []) {
    if (!isProposalSecretSlot(slot) || !upserted.has(slot.serverId)) continue
    const value = typedSlotValue(slot, values)
    if (value !== undefined) out.push({ slot, value })
  }
  return out
}
