// Pure parts of scripts/list-proxy-models.mjs (tested by scripts/proxy-models.test.mjs). No network, no key handling.

/** Most bytes read from the models endpoint. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024
/** Most models printed. */
export const MAX_MODELS = 2000

/** True for loopback, private-network and link-local hosts (literals and the usual local names only; no DNS). */
export function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0
  }
  if (h === '::1' || h === '::') return true
  if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7))
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
}

/** The URL to fetch, or throws a readable Error: https, or http only on a private host; no credentials. */
export function checkModelsUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('--url must be a full URL')
  }
  if (url.username || url.password) throw new Error('--url must not carry a user name or password; pass the key through --key-env')
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && isPrivateHost(url.hostname)) return url
  throw new Error('--url must be https (http only for localhost or a private network address)')
}

/** The family OrgAI would pick for a model: claude, openai or other. */
export function familyOf(id, ownedBy) {
  const bare = String(id ?? '').toLowerCase()
  const owner = String(ownedBy ?? '').toLowerCase()
  if (bare.includes('claude')) return 'claude'
  if (owner === 'anthropic') return 'claude'
  if (/^(gpt|o\d|codex|chatgpt)/.test(bare) || owner === 'openai') return 'openai'
  return 'other'
}

/** Strip control and hidden characters so a hostile proxy cannot drive the terminal. */
export function cleanText(value, max = 200) {
  return String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?')
    .slice(0, max)
}

/** Rows { id, owned_by, family } from an OpenAI-style `{ data: [...] }` body (or a bare array). */
export function parseModels(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null
  if (!list) throw new Error('The answer is not a model list ({ "data": [...] }).')
  const rows = []
  for (const m of list.slice(0, MAX_MODELS)) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue
    const ownedBy = typeof m.owned_by === 'string' ? m.owned_by : ''
    rows.push({ id: cleanText(m.id), owned_by: cleanText(ownedBy, 80), family: familyOf(m.id, ownedBy) })
  }
  return rows
}

/** The env var name holding the key: a plain environment variable name, else throws. */
export function keyEnvName(raw) {
  const name = raw === undefined ? 'PROXY_API_KEY' : raw
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new Error('--key-env needs an environment variable name')
  return name
}

/** A key that is safe to put in a header: non-empty, printable, at most 4,000 characters. */
export function checkKey(value) {
  if (typeof value !== 'string' || value === '') throw new Error('The key variable is not set or empty')
  if (value.length > 4000 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.trim())) throw new Error('The key variable does not hold a plain key')
  return value.trim()
}

/** Aligned text table of the rows. */
export function formatRows(rows) {
  if (rows.length === 0) return 'No models listed.'
  const w = Math.min(60, Math.max(2, ...rows.map((r) => r.id.length)))
  const o = Math.min(24, Math.max(8, ...rows.map((r) => r.owned_by.length)))
  const line = (a, b, c) => `${a.padEnd(w)}  ${b.padEnd(o)}  ${c}`
  return [line('ID', 'OWNED_BY', 'FAMILY'), ...rows.map((r) => line(r.id, r.owned_by, r.family))].join('\n')
}
