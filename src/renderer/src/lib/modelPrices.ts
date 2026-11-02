import type { ConnectionId, ModelPrice, ModelPriceInfo, ModelPriceOverride } from '@shared/types'
import { MODEL_PRICE_ID_MAX_CHARS, MODEL_PRICE_MAX_PER_TOKEN, MODEL_PRICE_OVERRIDES_MAX } from '@shared/defaults'

/** Prices are stored per token and shown per million tokens (USD). */
const MTOK = 1e6

/** Per-token price to a per-million-token number, rounded to kill float noise (3e-6 * 1e6 = 3.0000000000000004). */
export function toPerMTok(perToken: number): number {
  return Number((perToken * MTOK).toPrecision(12))
}

/** Per-million-token number to per-token, rounded the same way. */
export function fromPerMTok(perMTok: number): number {
  return Number((perMTok / MTOK).toPrecision(12))
}

/** Text for a per-MTok field: no trailing zeros, no exponent. */
export function formatPerMTok(perToken: number | undefined): string {
  if (perToken === undefined) return ''
  return String(toPerMTok(perToken))
}

/** Display text for a table cell: "$3.00", "$12.50", "$0.30", "$0.125", or an em dash for a missing price. Two decimals at least. */
export function displayPerMTok(perToken: number | undefined): string {
  if (perToken === undefined) return '—'
  const n = toPerMTok(perToken)
  if (n >= 1) return `$${n.toFixed(2)}`
  let t = String(Number(n.toPrecision(3)))
  if (!t.includes('.')) t += '.'
  const decimals = t.length - t.indexOf('.') - 1
  return `$${t}${'0'.repeat(Math.max(0, 2 - decimals))}`
}

/** Rows to show by default: overrides plus models in use (or all rows). `inUse` holds model ids. */
export function visiblePriceRows<T extends { model: string; source: string }>(rows: readonly T[], inUse: ReadonlySet<string>, showAll: boolean): T[] {
  return showAll ? [...rows] : rows.filter((r) => r.source === 'override' || inUse.has(r.model))
}

export interface PriceDraft {
  model: string
  connection: '' | ConnectionId
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
}

export type PriceField = 'model' | 'input' | 'output' | 'cacheRead' | 'cacheWrite'
export type PriceErrors = Partial<Record<PriceField, string>>

export function draftFromInfo(row: Pick<ModelPriceInfo, 'model' | 'connection' | 'price'>): PriceDraft {
  return {
    model: row.model,
    connection: row.connection ?? '',
    input: formatPerMTok(row.price.inputPerToken),
    output: formatPerMTok(row.price.outputPerToken),
    cacheRead: formatPerMTok(row.price.cacheReadPerToken),
    cacheWrite: formatPerMTok(row.price.cacheCreationPerToken)
  }
}

export const EMPTY_DRAFT: PriceDraft = { model: '', connection: '', input: '', output: '', cacheRead: '', cacheWrite: '' }

const MAX_PER_MTOK = toPerMTok(MODEL_PRICE_MAX_PER_TOKEN)

/** Parse a per-MTok field. Empty is allowed only when `optional`. */
function parseField(text: string, optional: boolean): { value?: number; error?: string } {
  const t = text.trim()
  if (t === '') return optional ? {} : { error: 'Enter a price, or 0 if it is free.' }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return { error: 'Use a plain non-negative number, like 3 or 0.30.' }
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return { error: 'Use a plain non-negative number, like 3 or 0.30.' }
  if (fromPerMTok(n) > MODEL_PRICE_MAX_PER_TOKEN) return { error: `At most $${MAX_PER_MTOK.toLocaleString('en-US')} per million tokens.` }
  return { value: fromPerMTok(n) }
}

/** Validate a draft; returns the override to save, or per-field errors. */
export function validateDraft(draft: PriceDraft): { override: ModelPriceOverride } | { errors: PriceErrors } {
  const errors: PriceErrors = {}
  const model = draft.model.trim()
  if (!model) errors.model = 'Enter a model id.'
  else if (model.length > MODEL_PRICE_ID_MAX_CHARS) errors.model = `At most ${MODEL_PRICE_ID_MAX_CHARS} characters.`
  const input = parseField(draft.input, false)
  const output = parseField(draft.output, false)
  const cacheRead = parseField(draft.cacheRead, true)
  const cacheWrite = parseField(draft.cacheWrite, true)
  if (input.error) errors.input = input.error
  if (output.error) errors.output = output.error
  if (cacheRead.error) errors.cacheRead = cacheRead.error
  if (cacheWrite.error) errors.cacheWrite = cacheWrite.error
  if (Object.keys(errors).length > 0) return { errors }
  const price: ModelPrice = { inputPerToken: input.value as number, outputPerToken: output.value as number }
  if (cacheRead.value !== undefined) price.cacheReadPerToken = cacheRead.value
  if (cacheWrite.value !== undefined) price.cacheCreationPerToken = cacheWrite.value
  const override: ModelPriceOverride = { model, price }
  if (draft.connection) override.connection = draft.connection
  return { override }
}

/** The host's matching rule: case-insensitive, date stamp and [1m] suffix ignored. */
export function overrideKey(model: string, connection?: ConnectionId): string {
  const id = model.trim().toLowerCase().replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')
  return `${connection ?? ''}|${id}`
}

/** The overrides after saving `next`: replaces an entry with the same key (and the one being edited, if renamed). */
export function upsertOverride(
  list: readonly ModelPriceOverride[],
  next: ModelPriceOverride,
  replacing?: { model: string; connection?: ConnectionId }
): { list: ModelPriceOverride[] } | { error: string } {
  const drop = new Set([overrideKey(next.model, next.connection)])
  if (replacing) drop.add(overrideKey(replacing.model, replacing.connection))
  const rest = list.filter((o) => !drop.has(overrideKey(o.model, o.connection)))
  if (rest.length >= MODEL_PRICE_OVERRIDES_MAX) return { error: `At most ${MODEL_PRICE_OVERRIDES_MAX} price overrides. Clear one first.` }
  return { list: [...rest, next] }
}

export function removeOverride(list: readonly ModelPriceOverride[], model: string, connection?: ConnectionId): ModelPriceOverride[] {
  const key = overrideKey(model, connection)
  return list.filter((o) => overrideKey(o.model, o.connection) !== key)
}
