import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ModelPrice } from '@shared/types'
import { sanitizeModelPrice } from '../runtime/pricing'

/**
 * Community model prices: LiteLLM's public price list (model_prices_and_context_window.json), fetched at most once
 * per 24 h and cached under <data>/model-prices.json. The body is untrusted: size-capped, parsed defensively, prototype
 * keys skipped, every price run through sanitizeModelPrice. Prices are a fallback after OrgAI's builtin table; the
 * setting AppSettings.communityPrices (missing = on) turns fetching and use off.
 */

export const COMMUNITY_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
export const COMMUNITY_MAX_BYTES = 8 * 1024 * 1024
export const COMMUNITY_MAX_ENTRIES = 20_000
const MAX_KEY_CHARS = 200
const FETCH_TIMEOUT_MS = 20_000
const SKIP_KEYS = new Set(['sample_spec', '__proto__', 'constructor', 'prototype'])
const DAY_MS = 24 * 3600_000

type Prices = Record<string, ModelPrice>

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The prices in LiteLLM's JSON (a map of model key to entry). Entries that are not chat or responses models are skipped. */
export function parseCommunityPrices(raw: unknown): Prices {
  const out = Object.create(null) as Prices
  if (!isRecord(raw)) return out
  let count = 0
  for (const key of Object.keys(raw)) {
    if (count >= COMMUNITY_MAX_ENTRIES) break
    if (SKIP_KEYS.has(key) || key.length > MAX_KEY_CHARS) continue
    const entry = raw[key]
    if (!isRecord(entry)) continue
    if (entry.mode !== undefined && entry.mode !== 'chat' && entry.mode !== 'responses') continue
    const price = sanitizeModelPrice({
      inputPerToken: entry.input_cost_per_token,
      outputPerToken: entry.output_cost_per_token,
      cacheReadPerToken: entry.cache_read_input_token_cost,
      cacheCreationPerToken: entry.cache_creation_input_token_cost
    })
    if (!price) continue
    out[key] = price
    count++
  }
  return out
}

/** The cache file's prices, sanitized again (it is a file on disk). */
function sanitizeCached(raw: unknown): Prices {
  const out = Object.create(null) as Prices
  if (!isRecord(raw)) return out
  let count = 0
  for (const key of Object.keys(raw)) {
    if (count >= COMMUNITY_MAX_ENTRIES) break
    if (SKIP_KEYS.has(key) || key.length > MAX_KEY_CHARS) continue
    const price = sanitizeModelPrice(raw[key])
    if (!price) continue
    out[key] = price
    count++
  }
  return out
}

/** Read a response body as text, refusing more than `max` bytes (content-length and the bytes actually read). */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) throw new Error('The price list is too large.')
  if (!res.body) {
    const text = await res.text()
    if (Buffer.byteLength(text, 'utf8') > max) throw new Error('The price list is too large.')
    return text
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new Error('The price list is too large.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface CommunityPricesDeps {
  dataDir: string
  /** AppSettings.communityPrices !== false. Read at every use. */
  enabled: () => boolean
  fetch?: typeof fetch
  now?: () => number
  url?: string
}

export interface CommunityPricesStart {
  bootDelayMs?: number
  checkEveryMs?: number
  staleAfterMs?: number
}

export class CommunityPrices {
  private file: string
  private prices: Prices | undefined
  private fetchedAt = 0
  private busy = false
  private disposed = false
  private timers: ReturnType<typeof setTimeout>[] = []
  private lastError = ''

  constructor(private deps: CommunityPricesDeps) {
    this.file = join(deps.dataDir, 'model-prices.json')
    this.load()
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!isRecord(parsed) || parsed.version !== 1) return
      const prices = sanitizeCached(parsed.prices)
      if (Object.keys(prices).length === 0) return
      this.prices = prices
      this.fetchedAt = typeof parsed.fetchedAt === 'number' && Number.isFinite(parsed.fetchedAt) ? parsed.fetchedAt : 0
    } catch (e) {
      console.warn('Ignoring unreadable model-prices.json:', (e as Error).message)
    }
  }

  /** Write the cache. A disk error is logged as such (apart from fetch failures), the tmp file removed; never throws. */
  private save(prices: Prices): boolean {
    const tmp = `${this.file}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ version: 1, fetchedAt: this.fetchedAt, prices }), 'utf8')
      renameSync(tmp, this.file)
      return true
    } catch (e) {
      console.warn(`Community model prices fetched but not saved to disk: ${(e as Error).message}`)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // best effort
      }
      return false
    }
  }

  /** The cached prices, or undefined when the setting is off or nothing is cached. */
  get(): Prices | undefined {
    return this.deps.enabled() ? this.prices : undefined
  }

  /** When the cache was last fetched (epoch ms), 0 = never. */
  get lastFetchedAt(): number {
    return this.fetchedAt
  }

  /**
   * Fetch the price list when it is enabled and the cache is older than staleAfterMs (or missing). A failure keeps
   * the last good cache and logs once per distinct message. Returns whether new prices were stored.
   */
  async refresh(staleAfterMs = DAY_MS): Promise<boolean> {
    if (this.disposed || this.busy || !this.deps.enabled()) return false
    // A fetchedAt in the future (skew, tampered file) counts as stale.
    const age = this.now() - this.fetchedAt
    if (this.prices && this.fetchedAt && age >= 0 && age < staleAfterMs) return false
    this.busy = true
    try {
      const f = this.deps.fetch ?? fetch
      const res = await f(this.deps.url ?? COMMUNITY_PRICES_URL, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await readCapped(res, COMMUNITY_MAX_BYTES)
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error('The price list is not valid JSON.')
      }
      const prices = parseCommunityPrices(json)
      if (Object.keys(prices).length === 0) throw new Error('The price list has no usable prices.')
      this.prices = prices
      this.fetchedAt = this.now()
      this.lastError = ''
      this.save(prices)
      return true
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 200)
      if (message !== this.lastError) console.warn(`Community model prices not updated: ${message}`)
      this.lastError = message
      return false
    } finally {
      this.busy = false
    }
  }

  /** Boot delay, then a check every checkEveryMs (unref'd timers; dispose() clears them). */
  start(opts: CommunityPricesStart = {}): void {
    if (this.disposed) return
    const { bootDelayMs = 20_000, checkEveryMs = 60 * 60_000, staleAfterMs = DAY_MS } = opts
    const tick = (): void => void this.refresh(staleAfterMs)
    const boot = setTimeout(() => {
      tick()
      const every = setInterval(tick, checkEveryMs)
      every.unref?.()
      this.timers.push(every)
    }, bootDelayMs)
    boot.unref?.()
    this.timers.push(boot)
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.timers.splice(0)) {
      clearTimeout(t)
      clearInterval(t)
    }
  }
}
