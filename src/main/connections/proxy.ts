import { randomBytes } from 'node:crypto'
import { proxyModelFamily } from '@shared/defaults'
import { PROXY_NAME_MAX } from '@shared/types'
import type { ProviderModel } from '@shared/types'
import { hiddenCharIn } from '../capabilities/sanitize'
import { makeDiscoveredModel } from './catalog'

/**
 * Pure helpers for proxy connections (AppSettings.proxies): URL and name validation, ids, and the ORGAI_MOCK=1
 * stand-in proxy. Nothing here touches the network, settings or secrets.
 *
 * Mock proxy (ORGAI_MOCK=1 only): a proxy whose model list URL host is exactly MOCK_PROXY_HOST needs no network.
 * Any non-empty key connects and lists `mockProxyModels()`; the key MOCK_BAD_KEY answers "The key was refused (401)."
 * so e2e can show an error. Spend probes on that host return nothing. Outside mock mode the host is an ordinary
 * (unreachable) name. The fixed list carries no prices.
 */

/** Longest proxy URL, in characters. */
export const PROXY_URL_MAX = 2048

/** The host of the network-free mock proxy. */
export const MOCK_PROXY_HOST = 'mock-proxy.example.com'
/** The key the mock proxy refuses. */
export const MOCK_BAD_KEY = 'mock-bad-key'

/**
 * localhost, loopback and private-network hosts (the only hosts allowed over plain http). Link-local addresses
 * (169.254.0.0/16, fe80::/10: cloud metadata services live there) are NOT included. Pure.
 */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  // IPv6 unique-local (fc00::/7).
  if (h.includes(':')) return /^f[cd][0-9a-f]{2}:/.test(h)
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * Validate and normalize one proxy URL (no trailing slash). `label` names the field in the message ("Base URL",
 * "Models URL"). https, or http only for localhost / private-network hosts; no credentials, query or fragment; at most
 * PROXY_URL_MAX chars; no whitespace, control or hidden characters. Throws a short readable Error (never the URL's
 * secrets: credentials are refused, not echoed).
 */
export function normalizeProxyUrl(raw: unknown, label = 'URL'): string {
  if (typeof raw !== 'string') throw new Error(`${label} must be text`)
  const text = raw.trim()
  if (!text) throw new Error(`${label} is empty`)
  if (text.length > PROXY_URL_MAX) throw new Error(`${label} is longer than ${PROXY_URL_MAX} characters`)
  if (hiddenCharIn(text) || /\s/.test(text)) throw new Error(`${label} contains a space or hidden character`)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`${label} is not a valid URL`)
  }
  if (url.protocol === 'http:') {
    if (!isLocalOrPrivateHost(url.hostname)) throw new Error(`${label} over http is only allowed for localhost and private-network addresses. Use https.`)
  } else if (url.protocol !== 'https:') {
    throw new Error(`${label} must start with https:// (unsupported scheme ${url.protocol})`)
  }
  if (url.username || url.password) throw new Error(`${label} must not contain a user name or password. Put the key in the key field.`)
  if (url.search || text.includes('?')) throw new Error(`${label} must not contain a query (?...)`)
  if (url.hash || text.includes('#')) throw new Error(`${label} must not contain a fragment (#...)`)
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The reason a name is unusable, or null. */
function nameProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'The name must be text.'
  const name = collapse(raw)
  if (!name) return 'Give the connection a name.'
  if (name.length > PROXY_NAME_MAX) return `The name can be at most ${PROXY_NAME_MAX} characters.`
  if (hiddenCharIn(raw)) return 'The name contains a hidden character; remove it.'
  return null
}

/**
 * A proxy name from user input: whitespace collapsed, 1..PROXY_NAME_MAX chars, no control or hidden characters and
 * not equal (case-insensitive) to any of `existingNames`. Throws a readable Error otherwise.
 */
export function cleanProxyName(raw: unknown, existingNames: Iterable<string> = []): string {
  const problem = nameProblem(raw)
  if (problem) throw new Error(problem)
  const name = collapse(raw as string)
  const lower = name.toLowerCase()
  for (const e of existingNames) if (typeof e === 'string' && e.toLowerCase() === lower) throw new Error(`A connection named "${name}" already exists. Choose another name.`)
  return name
}

/**
 * A name read from a settings file: like cleanProxyName but a clash gets " 2", " 3"... (kept within the limit) and an
 * unusable name gives undefined (the caller drops or renames the entry). Never throws.
 */
export function readableProxyName(raw: unknown, existingNames: Iterable<string> = []): string | undefined {
  if (nameProblem(raw)) return undefined
  const taken = new Set([...existingNames].filter((e): e is string => typeof e === 'string').map((e) => e.toLowerCase()))
  const name = collapse(raw as string)
  if (!taken.has(name.toLowerCase())) return name
  for (let n = 2; n < 1000; n++) {
    const suffix = ` ${n}`
    const candidate = `${name.slice(0, PROXY_NAME_MAX - suffix.length).trimEnd()}${suffix}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return undefined
}

/** `proxy-` + 8 lowercase hex, not among `avoid` (existing ids and any removed ones the caller knows). */
export function newProxyId(avoid: Iterable<string> = []): string {
  const taken = new Set(avoid)
  for (let i = 0; i < 100; i++) {
    const id = `proxy-${randomBytes(4).toString('hex')}`
    if (!taken.has(id)) return id
  }
  throw new Error('Could not generate a connection id')
}

/** Key text from the user: at most 4,000 chars, no control or hidden characters. Returns the trimmed key or null (clear). */
export function cleanProxyKey(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') throw new Error('The API key must be text')
  const key = raw.trim()
  if (!key) return null
  if (key.length > 4000) throw new Error('The API key is too long')
  if (hiddenCharIn(key)) throw new Error('The API key contains a control or hidden character')
  return key
}

// ---------- ORGAI_MOCK=1 stand-in ----------

/** True when `url` names the mock proxy host AND the app runs with ORGAI_MOCK=1. */
export function isMockProxyUrl(url: string | undefined): boolean {
  if (process.env.ORGAI_MOCK !== '1' || !url) return false
  try {
    return new URL(url).hostname === MOCK_PROXY_HOST
  } catch {
    return false
  }
}

/** The mock proxy's fixed /v1/models-shaped list as catalog entries of `connection` (families from id and owned_by; no prices). */
export function mockProxyModels(connection: string): ProviderModel[] {
  const list: [string, string][] = [
    ['claude-opus-5', 'anthropic'],
    ['claude-sonnet-5-5', 'anthropic'],
    ['claude-haiku-4-5-20251001', 'anthropic'],
    ['claude-opus-5-high', 'antigravity'],
    ['gpt-6-sol', 'openai'],
    ['gpt-5.6-terra', 'openai'],
    ['gemini-3.5-flash-lite', 'antigravity'],
    ['qwen38', 'vllm-mock'],
    ['muse-spark-1.3', 'meta']
  ]
  return list.map(([id, ownedBy]) => makeDiscoveredModel(connection, { id, family: proxyModelFamily(id, ownedBy), ownedBy }))
}
