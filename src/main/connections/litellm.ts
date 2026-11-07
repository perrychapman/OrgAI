import { createHash } from 'node:crypto'
import { SPEND_PERIOD_DAYS, SPEND_PERIOD_NOTES, type ModelPrice, type ProviderModel, type SpendPeriod, type SpendPeriodsNote, type UsageSpend } from '@shared/types'
import { proxyModelFamily } from '@shared/defaults'
import type { ProxyKind } from '@shared/types'
import { classifyFamily, cleanOwnedBy, makeDiscoveredModel } from './catalog'
import { validModelId } from './codexAccount'
import { MOCK_BAD_KEY, isLocalOrPrivateHost, isMockProxyUrl, mockProxyModels, normalizeProxyUrl } from './proxy'
import { sanitizeModelPrice } from '../runtime/pricing'

/**
 * LiteLLM proxy discovery. UNVERIFIED against a live proxy (written from LiteLLM's documented API):
 *   GET {base}/v1/models      -> { data: [{ id }] }                       (OpenAI-compatible)
 *   GET {base}/model/info     -> { data: [{ model_name, litellm_params: { model }, model_info: {
 *                                  litellm_provider, max_input_tokens, max_tokens, mode, input_cost_per_token,
 *                                  output_cost_per_token, cache_read_input_token_cost,
 *                                  cache_creation_input_token_cost } }] }      (costs: USD per token, may be null)
 *   GET {base}/key/info       -> { key, info: { spend, max_budget, budget_duration, budget_reset_at, key_alias,
 *                                  total_spend, ... } }
 *                                (no `key` param: the caller's own key; needs the proxy's DB, else 500)
 *   GET {base}/user/daily/activity/aggregated?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&api_key=<sha256 of the key>
 *                             -> { results: [{ date: 'YYYY-MM-DD' (UTC calendar day), metrics: { spend, ... },
 *                                  breakdown: { api_keys: { '<sha256>': { metrics: { spend } } } } }], metadata }
 *                                (read from LiteLLM source v1.108.0, UNVERIFIED live: any role may call it, a key
 *                                with no user answers 403, no DB answers 500; proxies older than about v1.75 answer
 *                                404 and have only the paginated GET {base}/user/daily/activity (about v1.65+),
 *                                whose metadata adds page / total_pages / has_more)
 * Auth is sent both as `Authorization: Bearer` and `x-api-key` since proxies differ. /model/info is
 * best-effort enrichment and may be admin-only. The raw key never appears in an error string or a URL. The daily
 * routes carry its SHA-256 hash in the query: that hash is the proxy's stored key id, and LiteLLM's
 * user_api_key_auth accepts a presented hash as the key itself (it hashes only tokens starting with "sk-"), so the
 * hash is as sensitive as the key. It goes only to the proxy that already receives the raw key in the auth headers
 * of the same request (where an access log may keep the query string), is never logged by OrgAI and never enters
 * the returned UsageSpend.
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
  if (url.protocol === 'http:') {
    if (!isLocalOrPrivateHost(url.hostname)) throw new Error('LiteLLM over http is only allowed for localhost. Use https.')
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
  return getJsonUrl(`${base}${path}`, path, base, key, fetchImpl)
}

/** GET a full URL; `path` is what error messages call it, `base` only names the host. */
async function getJsonUrl(url: string, path: string, base: string, key: string, fetchImpl: FetchLike): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, {
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

/** A GET that never throws: the parsed JSON body, a non-2xx status, or 'failed' (network, timeout, redirect, oversized, non-JSON). */
type StatusAnswer = { kind: 'ok'; body: unknown } | { kind: 'status'; status: number } | { kind: 'failed' }

async function getStatusJson(url: string, key: string, fetchImpl: FetchLike): Promise<StatusAnswer> {
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', headers: headers(key), redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    return { kind: 'failed' }
  }
  if (!res.ok) return { kind: 'status', status: res.status }
  let text: string
  try {
    text = await readCapped(res, LITELLM_MAX_BODY_BYTES)
  } catch {
    return { kind: 'failed' }
  }
  try {
    return { kind: 'ok', body: JSON.parse(text) as unknown }
  } catch {
    return { kind: 'failed' }
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
    // validModelId: at most LITELLM_MAX_ID_CHARS (200), printable, no whitespace or control chars, no leading '-'.
    if (!validModelId(id)) continue
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

/** The entries of an OpenAI-style models body with their sanitized `owned_by`. Tolerates a bare array and string entries. */
export function parseProxyModelList(body: unknown): { id: string; ownedBy?: string }[] {
  const list = Array.isArray(body) ? body : Array.isArray(obj(body).data) ? (obj(body).data as unknown[]) : []
  const out = new Map<string, { id: string; ownedBy?: string }>()
  for (const item of list) {
    if (out.size >= LITELLM_MAX_MODELS) break
    const id = typeof item === 'string' ? item.trim() : str(obj(item).id) ?? str(obj(item).model_name)
    if (!id || id.length > LITELLM_MAX_ID_CHARS || out.has(id)) continue
    const ownedBy = typeof item === 'string' ? undefined : cleanOwnedBy(obj(item).owned_by)
    out.set(id, { id, ...(ownedBy ? { ownedBy } : {}) })
  }
  return [...out.values()]
}

export interface FetchProxyModelsOptions {
  /** 'litellm' also reads /model/info (prices, provider, context window); 'openai-compatible' reads only the models URL. */
  kind: ProxyKind
  /** The proxy's connection id, stamped on every catalog entry. */
  connection: string
  /** The Anthropic base URL (root) the LiteLLM-only /model/info route hangs off. Ignored for 'openai-compatible'. */
  baseUrl?: string
  /** Only the models URL (no /model/info), for a status probe. */
  listOnly?: boolean
}

/**
 * Discover a proxy's models: GET <modelsUrl> with the key as Bearer (redirects refused, 10 s, 5 MB, at most
 * LITELLM_MAX_MODELS ids that pass validModelId). Each entry gets `family = proxyModelFamily(id, ownedBy)`, its
 * adapter and `ownedBy`. For kind 'litellm' /model/info adds prices, upstream and context window (best effort: any
 * failure, a 404 included, only means no prices); 'openai-compatible' never calls /model/info or /key/info. With
 * ORGAI_MOCK=1 the mock proxy host answers without network (proxy.ts). Throws a short readable Error; the key is
 * never in the message.
 */
export async function fetchProxyModels(modelsUrl: string, key: string, fetchImpl: FetchLike = fetch, opts: FetchProxyModelsOptions): Promise<ProviderModel[]> {
  if (isMockProxyUrl(modelsUrl)) {
    if (key === MOCK_BAD_KEY) throw new Error('The key was refused (401).')
    return mockProxyModels(opts.connection)
  }
  const url = normalizeProxyUrlForFetch(modelsUrl)
  const entries = parseProxyModelList(await getJsonUrl(url, new URL(url).pathname, new URL(url).origin, key, fetchImpl))
  let info = new Map<string, ModelInfoEntry>()
  if (opts.kind === 'litellm' && opts.baseUrl && !opts.listOnly) {
    try {
      info = parseModelInfo(await getJson('/model/info', normalizeBaseUrl(opts.baseUrl), key, fetchImpl))
    } catch {
      // best effort: /model/info is often admin-only or absent
    }
  }
  const models: ProviderModel[] = []
  for (const { id, ownedBy } of entries) {
    if (models.length >= LITELLM_MAX_MODELS) break
    if (!validModelId(id)) continue
    const e = info.get(id)
    if (e?.mode && !CHAT_MODES.has(e.mode)) continue
    let family = proxyModelFamily(id, ownedBy)
    if (family === 'other' && e?.litellmProvider) family = classifyFamily(id, e.litellmProvider)
    models.push(
      makeDiscoveredModel(opts.connection, {
        id,
        family,
        ownedBy,
        litellmProvider: e?.litellmProvider,
        contextWindow: e?.contextWindow,
        price: e?.price,
        upstream: e?.upstream
      })
    )
  }
  return models
}

function normalizeProxyUrlForFetch(url: string): string {
  return normalizeProxyUrl(url, 'Models URL')
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
 * numeric spend. A budget of 0 or less counts as no budget. `totalUsd` is the lifetime `total_spend` (null when
 * absent or invalid). The key itself is never read.
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
    keyAlias: str(info.key_alias)?.slice(0, 120) ?? null,
    totalUsd: amount(info.total_spend) ?? null
  }
}

/** The virtual key's own spend (GET /key/info). Throws a short human Error; the key is never in the message. */
export async function fetchLiteLLMKeyInfo(baseUrl: string, key: string, fetchImpl: FetchLike = fetch): Promise<UsageSpend | null> {
  return parseKeyInfo(await getJson('/key/info', normalizeBaseUrl(baseUrl), key, fetchImpl))
}

// ---- Spend by period (GET /user/daily/activity/aggregated, UNVERIFIED live) ----

/** The fixed `UsageSpend.periodsNote` sentences live in the contract (shared/types.ts); re-exported for the tests. */
export { SPEND_PERIOD_NOTES }

/** Rows kept from one daily-activity answer (the probe asks for at most SPEND_PERIOD_DAYS days). */
export const LITELLM_MAX_DAILY_ROWS = 400

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The proxy's stored key id: the SHA-256 hex digest of the raw key (LiteLLM `hash_token`). UNVERIFIED live. Treat
 * it like the key: LiteLLM accepts a presented hash as a credential (see the header comment).
 */
export function keyHash(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex')
}

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** `YYYY-MM-DD` of a real UTC calendar date as its day start in epoch ms; undefined otherwise. */
function dayStartOf(date: unknown): number | undefined {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  const [y, m, d] = date.split('-').map(Number)
  const ms = Date.UTC(y, m - 1, d)
  // A round trip catches 2026-13-40 (Date.UTC rolls it over) and years Date.UTC rewrites (0-99).
  return Number.isFinite(ms) && y >= 100 && ymd(ms) === date ? ms : undefined
}

export interface PeriodBounds {
  /** 00:00 UTC of now's UTC date, epoch ms. */
  day: number
  /** Monday 00:00 UTC of now's ISO week (a Sunday belongs to the week that started the previous Monday). */
  week: number
  /** The 1st 00:00 UTC of now's month. */
  month: number
  /** The earlier of `week` and `month` as `YYYY-MM-DD`, never more than SPEND_PERIOD_DAYS days before `endDate`. */
  startDate: string
  /** Now's UTC date as `YYYY-MM-DD`. */
  endDate: string
}

/** UTC calendar period starts for `nowMs` (UTC arithmetic only, never local time). */
export function periodBounds(nowMs: number): PeriodBounds {
  const now = new Date(nowMs)
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const day = Date.UTC(y, m, now.getUTCDate())
  const sinceMonday = (new Date(day).getUTCDay() + 6) % 7
  const week = day - sinceMonday * DAY_MS
  const month = Date.UTC(y, m, 1)
  const start = Math.max(Math.min(week, month), day - SPEND_PERIOD_DAYS * DAY_MS)
  return { day, week, month, startDate: ymd(start), endDate: ymd(day) }
}

const plain = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/**
 * The key's spend per UTC day from a daily-activity body (aggregated or paginated: both carry `results`).
 * Only plain-object rows with a real `YYYY-MM-DD` date and a finite spend >= 0 are kept, the first row per date
 * (a repeated date is never double-counted), at most LITELLM_MAX_DAILY_ROWS. Cross-check of the `api_key` filter
 * through `breakdown.api_keys` (UNVERIFIED live):
 * the entry for `hash` wins when present; other hashes present but ours absent means the filter was ignored and
 * the day counts 0 for this key; no breakdown (or an empty map) falls back to `metrics.spend`.
 */
export function parseDailyActivity(body: unknown, hash: string): { date: string; usd: number }[] {
  const results = plain(body)?.results
  if (!Array.isArray(results)) return []
  const out: { date: string; usd: number }[] = []
  const seen = new Set<string>()
  for (const item of results) {
    if (out.length >= LITELLM_MAX_DAILY_ROWS) break
    const row = plain(item)
    if (!row || dayStartOf(row.date) === undefined || seen.has(row.date as string)) continue
    const keys = plain(plain(row.breakdown)?.api_keys)
    let usd: number | undefined
    if (keys && Object.hasOwn(keys, hash)) usd = amount(plain(plain(keys[hash])?.metrics)?.spend)
    else if (keys && Object.keys(keys).length > 0) usd = 0
    else usd = amount(plain(row.metrics)?.spend)
    if (usd === undefined) continue
    seen.add(row.date as string)
    out.push({ date: row.date as string, usd })
  }
  return out
}

/**
 * Sum the rows into the calendar periods of `nowMs`: a row counts for a period when its UTC day is at or after
 * the period start and not after now's UTC date (future-dated rows are ignored). `since` is the period start.
 */
export function spendPeriods(rows: { date: string; usd: number }[], nowMs: number): { day: SpendPeriod; week: SpendPeriod; month: SpendPeriod } {
  const b = periodBounds(nowMs)
  const sum = (since: number): SpendPeriod => {
    let usd = 0
    for (const r of rows) {
      const t = dayStartOf(r.date)
      if (t !== undefined && t >= since && t <= b.day) usd += r.usd
    }
    return { usd, since }
  }
  return { day: sum(b.day), week: sum(b.week), month: sum(b.month) }
}

type DailyOutcome = { periods: NonNullable<UsageSpend['periods']> } | { note: SpendPeriodsNote }

/**
 * The daily routes for the key's hash. Never throws and never fails the whole probe: an outcome is either the
 * periods or one fixed note. The raw key travels only in the auth headers (the hash in the query, see the header
 * comment). A sum that is not a finite number (absurd row values) is the `failed` note, never Infinity over IPC.
 * Worst case the two daily calls take 2 x TIMEOUT_MS on top of /key/info.
 */
export async function fetchDailySpend(base: string, key: string, fetchImpl: FetchLike, nowMs: number): Promise<DailyOutcome> {
  const bounds = periodBounds(nowMs)
  const hash = keyHash(key)
  const query = `?start_date=${bounds.startDate}&end_date=${bounds.endDate}&api_key=${hash}`
  let answer = await getStatusJson(`${base}/user/daily/activity/aggregated${query}`, key, fetchImpl)
  if (answer.kind === 'status' && (answer.status === 404 || answer.status === 405)) {
    // Older proxies have only the paginated route. One page is read; more pages means we cannot sum a period.
    answer = await getStatusJson(`${base}/user/daily/activity${query}`, key, fetchImpl)
    if (answer.kind === 'ok' && plain(plain(answer.body)?.metadata)?.has_more === true) return { note: SPEND_PERIOD_NOTES.unsupported }
  }
  if (answer.kind === 'failed') return { note: SPEND_PERIOD_NOTES.failed }
  if (answer.kind === 'status') {
    if (answer.status === 403) return { note: SPEND_PERIOD_NOTES.noUser }
    if (answer.status === 404 || answer.status === 405) return { note: SPEND_PERIOD_NOTES.unsupported }
    return { note: SPEND_PERIOD_NOTES.failed }
  }
  if (!Array.isArray(plain(answer.body)?.results)) return { note: SPEND_PERIOD_NOTES.failed }
  const periods = spendPeriods(parseDailyActivity(answer.body, hash), nowMs)
  if (![periods.day, periods.week, periods.month].every((p) => Number.isFinite(p.usd))) return { note: SPEND_PERIOD_NOTES.failed }
  return { periods }
}

/**
 * The key's spend: /key/info exactly as `fetchLiteLLMKeyInfo` (throws on failure, null without a spend), then the
 * daily routes, whose failure only sets `periodsNote`. `periods.day` is the UTC day of `nowMs`, which must be the
 * instant the caller records as `UsageStatus.updatedAt`. `periods` and `periodsNote` are never both set.
 */
export async function fetchLiteLLMSpend(baseUrl: string, key: string, fetchImpl: FetchLike = fetch, nowMs: number = Date.now()): Promise<UsageSpend | null> {
  const base = normalizeBaseUrl(baseUrl)
  const keyInfo = parseKeyInfo(await getJson('/key/info', base, key, fetchImpl))
  if (!keyInfo) return null
  const daily = await fetchDailySpend(base, key, fetchImpl, nowMs)
  return 'periods' in daily ? { ...keyInfo, periods: daily.periods } : { ...keyInfo, periodsNote: daily.note }
}
