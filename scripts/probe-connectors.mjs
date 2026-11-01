#!/usr/bin/env node
/**
 * Token-free connector probe. Spends no model tokens but USES THE NETWORK: it contacts every catalog connector's
 * server, so run it only with the user's consent, once per check (never in a loop).
 *
 * For every http variant in src/shared/connectors.ts it POSTs a JSON-RPC `initialize` without credentials, reads a
 * 401's WWW-Authenticate `resource_metadata`, fetches the RFC 9728 protected-resource metadata and the RFC 8414 /
 * OIDC authorization-server metadata, and reports what the server advertises: dynamic client registration
 * (registration_endpoint), client id metadata documents, PKCE methods, the RFC 9207 iss parameter and scopes. For
 * 'none' variants it reports whether initialize answered 200 without a key.
 *
 * Safety: no credentials are ever sent; redirects are not followed; 10 s timeout and a 64 KB body cap per request;
 * only JSON is parsed; strings and arrays in the report are truncated; https on public hosts only (private,
 * loopback and link-local addresses refused, also after DNS); at most 6 requests in flight.
 *
 * Usage: node scripts/probe-connectors.mjs [--list] [--only id[,id...]] [--out file.json]
 *   --list  print the parsed variants and exit (no network)
 *   --only  probe only these connector ids
 *   --out   also write the JSON report to this file
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = 10_000
const BODY_CAP = 64 * 1024
const CONCURRENCY = 6
const STR_MAX = 200
const ARR_MAX = 30

// ---- args ----
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}
const only = value('--only')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const out = value('--out')

// ---- catalog parsing (text only; the catalog is TypeScript) ----
export function parseCatalog(text) {
  const src = text.replace(/\r\n/g, '\n')
  const variants = []
  // google('<id>', ... '<url>' ...): the first https literal after the id is the server URL; auth is oauthClient.
  for (const m of src.matchAll(/\bgoogle\(\s*'([a-z0-9-]+)',[^]*?'(https:\/\/[^']+)'/g)) {
    variants.push({ connector: m[1], variant: 'readonly', url: m[2], auth: 'oauthClient' })
  }
  const start = src.indexOf('export const CONNECTORS')
  const end = src.indexOf('\n]\n', start)
  const body = src.slice(start, end)
  const blocks = body.split(/\n {2}\{\n {4}id: '/).slice(1)
  for (const block of blocks) {
    const connector = block.slice(0, block.indexOf("'"))
    const vStart = block.indexOf('variants:')
    if (vStart < 0) continue
    const vText = block.slice(vStart)
    const re = /id: '([a-z0-9-]+)'[^]*?url: '([^']+)'[^]*?auth:\s*(?:\{\s*kind:\s*'(\w+)'|(tokenAuth)\()/g
    for (const m of vText.matchAll(re)) {
      variants.push({ connector, variant: m[1], url: m[2], auth: m[3] ?? 'token' })
    }
  }
  return variants
}

// ---- helpers ----
const trunc = (v) => {
  if (typeof v === 'string') return v.length > STR_MAX ? `${v.slice(0, STR_MAX)}...` : v
  if (Array.isArray(v)) return v.slice(0, ARR_MAX).map(trunc)
  if (typeof v === 'boolean' || typeof v === 'number' || v === null) return v
  return undefined
}

function privateAddress(addr) {
  const v = isIP(addr)
  if (v === 4) {
    const [a, b] = addr.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (v === 6) {
    const s = addr.toLowerCase()
    if (s.startsWith('::ffff:')) return privateAddress(s.slice(7))
    return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff')
  }
  return true
}

const dnsCache = new Map()
async function assertPublic(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    throw new Error('invalid URL')
  }
  if (u.protocol !== 'https:') throw new Error('not https')
  if (u.username || u.password) throw new Error('credentials in URL')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('private host')
  if (isIP(host)) {
    if (privateAddress(host)) throw new Error('private address')
    return u
  }
  let addrs = dnsCache.get(host)
  if (!addrs) {
    addrs = lookup(host, { all: true }).then((r) => r.map((a) => a.address))
    dnsCache.set(host, addrs)
  }
  const list = await addrs
  if (!list.length || list.some(privateAddress)) throw new Error('resolves to a private address')
  return u
}

let inFlight = 0
const queue = []
async function slot(fn) {
  if (inFlight >= CONCURRENCY) await new Promise((r) => queue.push(r))
  inFlight++
  try {
    return await fn()
  } finally {
    inFlight--
    queue.shift()?.()
  }
}

async function readCapped(res) {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value: chunk } = await reader.read()
    if (done) break
    size += chunk.byteLength
    if (size > BODY_CAP) {
      chunks.push(chunk.subarray(0, chunk.byteLength - (size - BODY_CAP)))
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function request(url, init = {}) {
  await assertPublic(url)
  return slot(async () => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { ...init, redirect: 'manual', signal: ctl.signal })
      const text = await readCapped(res)
      const type = res.headers.get('content-type') ?? ''
      let json
      if (/\bjson\b/i.test(type)) {
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
      }
      return { status: res.status, type, json, wwwAuthenticate: res.headers.get('www-authenticate') ?? undefined, location: res.headers.get('location') ?? undefined }
    } finally {
      clearTimeout(timer)
    }
  })
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'orgai-probe', version: '1' } }
})

function resourceMetadataFrom(header) {
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header ?? '')
  return m ? m[1] : undefined
}

function wellKnown(base, suffix) {
  const u = new URL(base)
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')
  return [`${u.origin}/.well-known/${suffix}${path}`, ...(path ? [`${u.origin}/.well-known/${suffix}`] : [])]
}

async function firstJson(urls) {
  for (const url of urls) {
    try {
      const r = await request(url)
      if (r.status === 200 && r.json && typeof r.json === 'object' && !Array.isArray(r.json)) return { url, json: r.json }
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

async function probe(v) {
  const row = { connector: v.connector, variant: v.variant, auth: v.auth, url: v.url }
  try {
    const init = await request(v.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: INIT_BODY })
    row.reachable = true
    row.status = init.status
    if (init.location) row.redirect = trunc(init.location)
    if (v.auth === 'none') row.initializeOk = init.status === 200
    const rm = resourceMetadataFrom(init.wwwAuthenticate)
    if (init.wwwAuthenticate) row.wwwAuthenticate = trunc(init.wwwAuthenticate)
    if (v.auth === 'none' && init.status !== 401) return row
    const prmUrls = rm ? [rm, ...wellKnown(v.url, 'oauth-protected-resource')] : wellKnown(v.url, 'oauth-protected-resource')
    const prm = await firstJson(prmUrls)
    if (!prm) return row
    row.resourceMetadataUrl = trunc(prm.url)
    row.resource = trunc(prm.json.resource)
    row.resourceScopes = trunc(prm.json.scopes_supported)
    const as = Array.isArray(prm.json.authorization_servers) && typeof prm.json.authorization_servers[0] === 'string' ? prm.json.authorization_servers[0] : undefined
    row.authorizationServer = trunc(as)
    if (!as) return row
    const meta = await firstJson([...wellKnown(as, 'oauth-authorization-server'), ...wellKnown(as, 'openid-configuration'), `${as.replace(/\/+$/, '')}/.well-known/openid-configuration`])
    if (!meta) return row
    const m = meta.json
    row.asMetadataUrl = trunc(meta.url)
    row.issuer = trunc(m.issuer)
    row.dcr = typeof m.registration_endpoint === 'string'
    row.registrationEndpoint = trunc(m.registration_endpoint)
    row.cimd = m.client_id_metadata_document_supported === true
    row.codeChallengeMethods = trunc(m.code_challenge_methods_supported)
    row.issParameter = m.authorization_response_iss_parameter_supported === true
    row.scopes = trunc(m.scopes_supported)
  } catch (e) {
    row.reachable = row.reachable ?? false
    row.error = trunc(e?.name === 'AbortError' ? 'timeout' : String(e?.message ?? e))
  }
  return row
}

// ---- main ----
const catalog = parseCatalog(readFileSync(resolve(ROOT, 'src/shared/connectors.ts'), 'utf8')).filter((v) => !only || only.includes(v.connector))
if (flag('--list')) {
  for (const v of catalog) console.log(`${v.connector}/${v.variant}\t${v.auth}\t${v.url}`)
  console.log(`${catalog.length} variants`)
  process.exit(0)
}
if (!catalog.length) {
  console.error('No variants matched.')
  process.exit(1)
}
const results = await Promise.all(catalog.map(probe))
for (const r of results) {
  const bits = [
    `${r.connector}/${r.variant}`.padEnd(28),
    String(r.status ?? '-').padEnd(4),
    r.auth.padEnd(12),
    r.initializeOk !== undefined ? `init200=${r.initializeOk}` : '',
    r.dcr !== undefined ? `dcr=${r.dcr} cimd=${r.cimd} iss=${r.issParameter}` : '',
    r.issuer ? `issuer=${r.issuer}` : '',
    r.error ? `error=${r.error}` : ''
  ]
  console.log(bits.filter(Boolean).join(' '))
}
const report = { probedAt: new Date().toISOString(), tool: 'scripts/probe-connectors.mjs', note: 'Token-free, no credentials sent. Advertised metadata only; no sign-in was attempted.', results }
if (out) {
  writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Wrote ${out}`)
}
