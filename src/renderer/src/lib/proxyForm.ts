import type { ProxyKind } from '@shared/types'
import { PROXY_NAME_MAX } from '@shared/types'

/** Pure logic behind the Add proxy dialog and the proxy card's fields. Main re-validates everything. */

export const PROXY_KIND_OPTIONS: { value: ProxyKind; label: string; hint: string }[] = [
  { value: 'litellm', label: 'LiteLLM proxy', hint: 'Reports prices and spend as well as the model list.' },
  { value: 'openai-compatible', label: 'OpenAI-compatible proxy', hint: 'Lists models only. Prices and spend are not reported.' }
]

export function kindHint(kind: ProxyKind): string {
  return PROXY_KIND_OPTIONS.find((o) => o.value === kind)?.hint ?? ''
}

const trimSlashes = (s: string): string => s.trim().replace(/\/+$/, '')

/** Names of every connection a new proxy must not repeat (case-insensitive): the built-ins and the other proxies. */
export function takenNames(names: readonly string[]): string[] {
  return ['Anthropic', 'OpenAI', ...names]
}

export function nameProblem(raw: string, taken: readonly string[]): string | null {
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) return 'Give the proxy a name.'
  if (name.length > PROXY_NAME_MAX) return `The name can be at most ${PROXY_NAME_MAX} characters.`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤﻿]/.test(raw)) return 'The name contains a hidden character; remove it.'
  const lower = name.toLowerCase()
  if (taken.some((t) => t.trim().toLowerCase() === lower)) return `A connection named "${name}" already exists. Choose another name.`
  return null
}

function isLocalOrPrivate(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  if (h.includes(':')) return /^f[cd][0-9a-f]{2}:/.test(h)
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** The reason a URL is unusable, or null. `required` false lets an empty field pass. */
export function urlProblem(raw: string, label: string, required: boolean): string | null {
  const text = raw.trim()
  if (!text) return required ? `Enter the ${label}.` : null
  if (/\s/.test(text)) return `${label} must not contain spaces.`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return `${label} is not a valid URL. Start it with https://`
  }
  if (url.protocol === 'http:') {
    if (!isLocalOrPrivate(url.hostname)) return `${label} over http is only allowed for localhost and private-network addresses. Use https.`
  } else if (url.protocol !== 'https:') return `${label} must start with https://`
  if (url.username || url.password) return `${label} must not contain a user name or password. Put the key in the key field.`
  if (url.search || text.includes('?') || url.hash || text.includes('#')) return `${label} must not contain a query or fragment.`
  return null
}

/** What the OpenAI URL becomes when left empty (matches defaults.ts proxyOpenAIBase). '' until the Anthropic URL is typed. */
export function defaultOpenAIUrl(anthropicUrl: string): string {
  const base = trimSlashes(anthropicUrl)
  if (!base) return ''
  return /\/v1$/i.test(base) ? base : `${base}/v1`
}

/** What the models endpoint becomes when left empty (matches defaults.ts proxyModelsUrl). */
export function defaultModelsUrl(anthropicUrl: string, openaiUrl: string): string {
  const base = trimSlashes(openaiUrl) || defaultOpenAIUrl(anthropicUrl)
  return base ? `${base}/models` : ''
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw.trim()).host
  } catch {
    return ''
  }
}

/** The models endpoint's host when it differs from the base URL's host (the key is sent there), else null. */
export function otherModelsHost(anthropicUrl: string, openaiUrl: string, modelsUrl: string): string | null {
  const models = hostOf(modelsUrl)
  if (!models) return null
  const base = hostOf(openaiUrl) || hostOf(anthropicUrl)
  const a = hostOf(anthropicUrl)
  if (!base && !a) return null
  return models !== base && models !== a ? models : null
}

export interface ProxyFormValues {
  name: string
  kind: ProxyKind
  anthropicBaseUrl: string
  openaiBaseUrl: string
  modelsUrl: string
}

export type ProxyFormErrors = Partial<Record<'name' | 'anthropicBaseUrl' | 'openaiBaseUrl' | 'modelsUrl', string>>

export function validateProxyForm(v: ProxyFormValues, taken: readonly string[]): ProxyFormErrors {
  const out: ProxyFormErrors = {}
  const n = nameProblem(v.name, taken)
  if (n) out.name = n
  const a = urlProblem(v.anthropicBaseUrl, 'Anthropic URL', true)
  if (a) out.anthropicBaseUrl = a
  const o = urlProblem(v.openaiBaseUrl, 'OpenAI URL', false)
  if (o) out.openaiBaseUrl = o
  const m = urlProblem(v.modelsUrl, 'Models endpoint', false)
  if (m) out.modelsUrl = m
  return out
}

/** The saved record's optional fields as form text ('' when unset). */
export const optionalText = (v: string | undefined): string => v ?? ''
