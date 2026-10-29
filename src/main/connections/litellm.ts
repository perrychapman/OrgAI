import type { ProviderModel } from '@shared/types'
import { makeDiscoveredModel } from './catalog'

/**
 * LiteLLM proxy discovery. UNVERIFIED against a live proxy (written from LiteLLM's documented API):
 *   GET {base}/v1/models      -> { data: [{ id }] }                       (OpenAI-compatible)
 *   GET {base}/model/info     -> { data: [{ model_name, litellm_params: { model }, model_info: {
 *                                  litellm_provider, max_input_tokens, max_tokens, mode } }] }
 * Auth is sent both as `Authorization: Bearer` and `x-api-key` since proxies differ. /model/info is
 * best-effort enrichment and may be admin-only. The key never appears in an error string.
 */

const TIMEOUT_MS = 10_000

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
        if (typeof msg === 'string' && msg) reason = msg.replace(key, '***').slice(0, 120)
      } catch {
        // keep statusText
      }
    }
    throw new Error(`${res.status} from ${path}: ${reason || 'error'}`)
  }
  try {
    return await res.json()
  } catch {
    throw new Error(`${path} did not return JSON`)
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)

/** Model ids from a /v1/models body. Tolerates `{ data: [...] }`, a bare array, and string entries. */
export function parseModelIds(body: unknown): string[] {
  const list = Array.isArray(body) ? body : Array.isArray(obj(body).data) ? (obj(body).data as unknown[]) : []
  const ids: string[] = []
  for (const item of list) {
    const id = typeof item === 'string' ? item : str(obj(item).id) ?? str(obj(item).model_name)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

export interface ModelInfoEntry {
  litellmProvider?: string
  contextWindow?: number
  mode?: string
}

/** Per-model details from a /model/info body, keyed by model_name. */
export function parseModelInfo(body: unknown): Map<string, ModelInfoEntry> {
  const out = new Map<string, ModelInfoEntry>()
  const list = Array.isArray(obj(body).data) ? (obj(body).data as unknown[]) : []
  for (const item of list) {
    const e = obj(item)
    const name = str(e.model_name)
    if (!name) continue
    const info = obj(e.model_info)
    const params = obj(e.litellm_params)
    // model_info.litellm_provider is the cleanest; else the "provider/" prefix of litellm_params.model.
    const paramModel = str(params.model)
    const provider = str(info.litellm_provider) ?? (paramModel?.includes('/') ? paramModel.slice(0, paramModel.indexOf('/')) : undefined)
    const prev = out.get(name)
    out.set(name, {
      litellmProvider: prev?.litellmProvider ?? provider,
      contextWindow: prev?.contextWindow ?? num(info.max_input_tokens) ?? num(info.max_tokens),
      mode: prev?.mode ?? str(info.mode)
    })
  }
  return out
}

const CHAT_MODES = new Set(['chat', 'completion', 'responses'])

/** Merge the two endpoints into catalog entries. Non-chat models (embeddings, images, audio) are dropped. */
export function buildLiteLLMModels(ids: string[], info: Map<string, ModelInfoEntry>): ProviderModel[] {
  const models: ProviderModel[] = []
  for (const id of ids) {
    const e = info.get(id)
    if (e?.mode && !CHAT_MODES.has(e.mode)) continue
    models.push(makeDiscoveredModel('litellm', { id, litellmProvider: e?.litellmProvider, contextWindow: e?.contextWindow }))
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
