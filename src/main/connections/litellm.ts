import type { ModelPrice, ProviderModel, UsageSpend } from '@shared/types'
import { makeDiscoveredModel } from './catalog'
import { sanitizeModelPrice } from '../runtime/pricing'

/**
 * LiteLLM proxy discovery. UNVERIFIED against a live proxy (written from LiteLLM's documented API):
 *   GET {base}/v1/models      -> { data: [{ id }] }                       (OpenAI-compatible)
 *   GET {base}/model/info     -> { data: [{ model_name, litellm_params: { model }, model_info: {
 *                                  litellm_provider, max_input_tokens, max_tokens, mode, input_cost_per_token,
 *                                  output_cost_per_token, cache_read_input_token_cost,
 *                                  cache_creation_input_token_cost } }] }      (costs: USD per token, may be null)
 *   GET {base}/key/info       -> { key, info: { spend, max_budget, budget_duration, budget_reset_at, key_alias, ... } }
 *                                (no `key` param: the caller's own key; needs the proxy's DB, else 500)
 * Auth is sent both as `Authorization: Bearer` and `x-api-key` since proxies differ. /model/info is
 * best-effort enrichment and may be admin-only. The key never appears in an error string.
 */

const TIMEOUT_MS = 10_000
/** Largest response body read from a proxy. */
export const LITELLM_MAX_BODY_BYTES = 5 * 1024 * 1024

type FetchLike = typeof fetch

/** Validate and normalize a proxy base URL (no trailing slash). Throws a short human error. */
export function normalizeBaseUrl(raw: string): string {
  const text = raw.trim()
  if (!text) throw new Error('LiteLLM base URL is empty')
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`"${text}" is not a valid URL`)
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  if (url.protocol === 'http:') {
    if (!local) throw new Error('LiteLLM over http is only allowed for localhost. Use https.')
  } else if (url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme ${url.protocol} (use https)`)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

function hostOf(base: string): string {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

function headers(key: string): Record<string, string> {
  return { Accept: 'application/json', Authorization: `Bearer ${key}`, 'x-api-key': key }
}

async function getJson(path: string, base: string, key: string, fetchImpl: FetchLike): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(`${base}${path}`, {
      method: 'GET',
      headers: headers(key),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error(`Timed out reaching ${hostOf(base)}`)
    if (/redirect/i.test(err.message)) throw new Error(`${hostOf(base)} redirected ${path}; refusing to follow`)
    throw new Error(`Could not reach ${hostOf(base)}`)
  }
  if (!res.ok) {
    let reason = res.statusText
    if (res.status === 401 || res.status === 403) reason = 'invalid key'
    else {
      try {
        const body = (await res.json()) as { error?: { message?: unknown } | string; detail?: unknown }
        const msg = typeof body.error === 'string' ? body.error : body.error?.message ?? body.detail
        if (typeof msg === 'string' && msg) reason = msg.split(key).join('***').slice(0, 120)
      } catch {
        // keep statusText
      }
    }
    throw new Error(`${res.status} from ${path}: ${reason || 'error'}`)
  }
  let text: string
  try {
    text = await readCapped(res, LITELLM_MAX_BODY_BYTES)
  } catch {
    throw new Error(`${path} response was too large or unreadable`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${path} did not return JSON`)
  }
}

/** The body as text, failing once it passes `max` bytes (the stream is cancelled). */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > max) throw new Error('too large')
  if (!res.body) {
    const t = await res.text()
    if (t.length > max) throw new Error('too large')
    return t
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error('too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

/** Model ids from a /v1/models body. Tolerates `{ data: [...] }`, a bare array, and string entries. */
export function parseModelIds(body: unknown): string[] {
  const list = Array.isArray(body) ? body : Array.isArray(obj(body).data) ? (obj(body).data as unknown[]) : []
  const ids = new Set<string>()
  for (const item of list) {
    if (ids.size >= LITELLM_MAX_MODELS) break
    const raw = typeof item === 'string' ? item.trim() : str(obj(item).id) ?? str(obj(item).model_name)
    if (raw && raw.length <= LITELLM_MAX_ID_CHARS) ids.add(raw)
  }
  return [...ids]
}

export interface ModelInfoEntry {
  litellmProvider?: string
  contextWindow?: number
  mode?: string
  /** USD per token from model_info; absent when the proxy has no input or output price. */
  price?: ModelPrice
  /** litellm_params.model. */
  upstream?: string
}

/** A finite number >= 0, from a number or a numeric string. */
function amount(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.length <= 40 && /^\s*[\d.eE+-]+\s*$/.test(v) ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** The four model_info price fields; undefined unless an input or output price is present. */
export function parsePrice(info: Record<string, unknown>): ModelPrice | undefined {
  const input = amount(info.input_cost_per_token)
  const output = amount(info.output_cost_per_token)
  if (input === undefined && output === undefined) return undefined
  const cacheRead = amount(info.cache_read_input_token_cost)
  const cacheCreation = amount(info.cache_creation_input_token_cost)
  // Out-of-range prices (1e300 and the like) are dropped, never clamped.
  return sanitizeModelPrice({
    inputPerToken: input ?? 0,
    outputPerToken: output ?? 0,
    ...(cacheRead !== undefined ? { cacheReadPerToken: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationPerToken: cacheCreation } : {})
  })
}

/** Per-model details from a /model/info body, keyed by model_name. */
export function parseModelInfo(body: unknown): Map<string, ModelInfoEntry> {
  const out = new Map<string, ModelInfoEntry>()
  const list = Array.isArray(obj(body).data) ? (obj(body).data as unknown[]) : []
  for (const item of list) {
    const e = obj(item)
    const name = str(e.model_name)
    if (!name || name.length > LITELLM_MAX_ID_CHARS) continue
    if (out.size >= LITELLM_MAX_MODELS && !out.has(name)) continue
    const info = obj(e.model_info)
    const params = obj(e.litellm_params)
    // model_info.litellm_provider is the cleanest; else the "provider/" prefix of litellm_params.model.
    const paramModel = str(params.model)?.slice(0, LITELLM_MAX_ID_CHARS)
    const provider = (str(info.litellm_provider) ?? (paramModel?.includes('/') ? paramModel.slice(0, paramModel.indexOf('/')) : undefined))?.slice(0, LITELLM_MAX_ID_CHARS)
    const prev = out.get(name)
    const price = prev?.price ?? parsePrice(info)
    const upstream = prev?.upstream ?? paramModel
    out.set(name, {
      litellmProvider: prev?.litellmProvider ?? provider,
      contextWindow: prev?.contextWindow ?? num(info.max_input_tokens) ?? num(info.max_tokens),
      mode: prev?.mode ?? str(info.mode)?.slice(0, 40),
      ...(price ? { price } : {}),
      ...(upstream ? { upstream } : {})
    })
  }
  return out
}

const CHAT_MODES = new Set(['chat', 'completion', 'responses'])
/** Bounds on untrusted proxy output: models kept per discovery and the longest model id accepted. */
export const LITELLM_MAX_MODELS = 2000
export const LITELLM_MAX_ID_CHARS = 200

/** Merge the two endpoints into catalog entries. Non-chat models (embeddings, images, audio) are dropped. */
export function buildLiteLLMModels(ids: string[], info: Map<string, ModelInfoEntry>): ProviderModel[] {
  const models: ProviderModel[] = []
  for (const id of ids) {
    if (models.length >= LITELLM_MAX_MODELS) break
    if (id.length > LITELLM_MAX_ID_CHARS) continue
    const e = info.get(id)
    if (e?.mode && !CHAT_MODES.has(e.mode)) continue
    models.push(
      makeDiscoveredModel('litellm', { id, litellmProvider: e?.litellmProvider, contextWindow: e?.contextWindow, price: e?.price, upstream: e?.upstream })
    )
  }
  return models
}

/** Discover the proxy's models. Throws a short human Error on failure; the key is never in the message. */
export async function fetchLiteLLMModels(baseUrl: string, key: string, fetchImpl: FetchLike = fetch): Promise<ProviderModel[]> {
  const base = normalizeBaseUrl(baseUrl)
  const ids = parseModelIds(await getJson('/v1/models', base, key, fetchImpl))
  let info = new Map<string, ModelInfoEntry>()
  try {
    info = parseModelInfo(await getJson('/model/info', base, key, fetchImpl))
  } catch {
    // best effort: /model/info is often admin-only
  }
  return buildLiteLLMModels(ids, info)
}

/** Epoch ms from an ISO string or an epoch number (seconds or ms); null otherwise. */
function instant(v: unknown): number | null {
  let t = Number.NaN
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) t = v < 1e12 ? v * 1000 : v
  else if (typeof v === 'string' && v.trim()) t = Date.parse(v.trim())
  // Only instants a Date can represent, so the renderer can always format them.
  return Number.isFinite(t) && t > 0 && Number.isFinite(new Date(t).getTime()) ? t : null
}

/**
 * The key's spend from a /key/info body (`{ key, info: {...} }` or the bare info object). null when there is no
 * numeric spend. A budget of 0 or less counts as no budget. The key itself is never read.
 */
export function parseKeyInfo(body: unknown): UsageSpend | null {
  const root = obj(body)
  const info = root.info && typeof root.info === 'object' && !Array.isArray(root.info) ? obj(root.info) : root
  const usd = amount(info.spend)
  if (usd === undefined) return null
  const budget = amount(info.max_budget)
  return {
    usd,
    budgetUsd: budget !== undefined && budget > 0 ? budget : null,
    resetsAt: instant(info.budget_reset_at),
    budgetDuration: str(info.budget_duration)?.slice(0, 40) ?? null,
    keyAlias: str(info.key_alias)?.slice(0, 120) ?? null
  }
}

/** The virtual key's own spend (GET /key/info). Throws a short human Error; the key is never in the message. */
export async function fetchLiteLLMKeyInfo(baseUrl: string, key: string, fetchImpl: FetchLike = fetch): Promise<UsageSpend | null> {
  return parseKeyInfo(await getJson('/key/info', normalizeBaseUrl(baseUrl), key, fetchImpl))
}
