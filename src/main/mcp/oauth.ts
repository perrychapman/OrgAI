import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpAuthStatus, McpOAuthConfig } from '@shared/types'

/**
 * OAuth 2.1 authorization for remote MCP servers (MCP authorization spec 2025-06-18 / 2025-11-25): protected
 * resource metadata (RFC 9728), authorization server metadata (RFC 8414 / OIDC discovery), client registration
 * (a user-entered client id first, then dynamic client registration RFC 7591), PKCE S256, resource indicators
 * (RFC 8707), a one-shot loopback redirect on 127.0.0.1, token exchange and refresh with rotation.
 *
 * Pure apart from the injected fetch, opener and the loopback server; no Electron, no SecretStore. McpService
 * stores what runAuthorization returns. No message, log line or error produced here contains a token, a code
 * or a client secret.
 */

export type FetchLike = typeof fetch

/** The step a failure happened in; McpService shows `${message}` which already names it. */
export type OAuthStep = 'discovery' | 'registration' | 'authorization' | 'callback' | 'token' | 'refresh'

export class OAuthError extends Error {
  constructor(
    readonly step: OAuthStep,
    message: string,
    /** No usable client: DCR is unavailable and no client id is stored or entered. */
    readonly needsClientId = false
  ) {
    super(message)
    this.name = 'OAuthError'
  }
}

/** Shown (state 'error', needsClientId) when the server needs a pre-registered OAuth app. */
export const NEEDS_CLIENT_ID_MESSAGE =
  'This server needs a pre-registered OAuth app. Enter its client id (and secret if it has one), then authorize again.'

/** One challenge of a WWW-Authenticate header, e.g. { scheme: 'Bearer', params: { resource_metadata, scope } }. */
export interface AuthChallenge {
  scheme: string
  params: Record<string, string>
}

/** What discovery found for one MCP server URL. */
export interface OAuthDiscovery {
  /** Canonical resource URI (RFC 8707) for the `resource` parameter. */
  resource: string
  /** Issuer of the chosen authorization server. */
  authorizationServer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  /** Scopes to request: the challenge's `scope` first, else the resource's (or AS's) scopes_supported. */
  scopes?: string[]
  /** code_challenge_methods_supported as advertised; runAuthorization refuses when S256 is not in it. */
  codeChallengeMethods?: string[]
}

export interface OAuthClient {
  clientId: string
  clientSecret?: string
  source: 'manual' | 'dcr'
  /** 'dcr': the redirect URI it was registered with. */
  redirectUri?: string
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** ISO timestamp from expires_in; missing when the server gave none. */
  expiresAt?: string
  scope?: string
}

const HTTP_TIMEOUT_MS = 15_000
const EXCERPT_MAX = 200
const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60_000

// ---------------------------------------------------------------------------------------------------------------
// Redaction

const TOKEN_KEYS = 'access_token|refresh_token|client_secret|id_token|code_verifier|code'

/** Replace every occurrence of the given secret values (and bearer tokens / code= / *_token= params) with [redacted]. */
export function redactOAuth(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const s of [...secrets].filter((v) => v && v.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(s).join('[redacted]')
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 [redacted]')
  out = out.replace(new RegExp(`("(?:${TOKEN_KEYS})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), '$1"[redacted]"')
  out = out.replace(new RegExp(`\\b(${TOKEN_KEYS})=[^&\\s"']*`, 'gi'), '$1=[redacted]')
  return out
}

function excerpt(text: string, secrets: readonly string[] = []): string {
  return redactOAuth(text, secrets).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX)
}

// ---------------------------------------------------------------------------------------------------------------
// WWW-Authenticate and URLs

/** Parse a WWW-Authenticate header (several challenges, quoted or token params). Never throws. */
export function parseWwwAuthenticate(header: string): AuthChallenge[] {
  const out: AuthChallenge[] = []
  try {
    const s = String(header ?? '')
    let i = 0
    let current: AuthChallenge | undefined
    const skip = (re: RegExp): void => {
      while (i < s.length && re.test(s[i])) i++
    }
    while (i < s.length) {
      skip(/[\s,]/)
      if (i >= s.length) break
      const start = i
      while (i < s.length && !/[\s,=]/.test(s[i])) i++
      const name = s.slice(start, i)
      if (!name) {
        i++
        continue
      }
      skip(/\s/)
      if (s[i] === '=' && current) {
        i++
        skip(/\s/)
        let value = ''
        if (s[i] === '"') {
          i++
          while (i < s.length && s[i] !== '"') {
            if (s[i] === '\\' && i + 1 < s.length) i++
            value += s[i++]
          }
          i++
        } else {
          const v = i
          while (i < s.length && !/[\s,]/.test(s[i])) i++
          value = s.slice(v, i)
        }
        current.params[name.toLowerCase()] = value
      } else if (s[i] === '=') {
        i++ // stray "name=" before any scheme
      } else {
        current = { scheme: name, params: {} }
        out.push(current)
      }
    }
  } catch {
    /* return what was parsed */
  }
  return out
}

/** The canonical MCP server URI used as the RFC 8707 `resource`: lowercase scheme and host, no fragment. */
export function canonicalResource(url: string): string {
  const u = new URL(url)
  u.hash = ''
  const path = u.pathname === '/' && !u.search ? '' : u.pathname
  return `${u.protocol}//${u.host}${path}${u.search}`
}

function isLoopbackHost(h: string): boolean {
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
}

/** https, or http for loopback hosts only. */
function secureUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const u = new URL(value)
    if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname))) return u.href
  } catch {
    /* invalid */
  }
  return undefined
}

function requireSecure(value: unknown, what: string): string {
  if (!secureUrl(value)) throw new OAuthError('discovery', `Discovery failed: ${what} is missing or not an https URL.`)
  return value as string
}

async function fetchJson(fetchImpl: FetchLike, url: string): Promise<Record<string, unknown> | undefined> {
  if (!secureUrl(url)) return undefined
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    if (!res.ok) return undefined
    const body: unknown = await res.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const stringList = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const l = v.filter((x): x is string => typeof x === 'string' && x.length > 0)
  return l.length ? l : undefined
}

/**
 * Discover the authorization server for an MCP URL: probe it (401 + WWW-Authenticate resource_metadata), else
 * /.well-known/oauth-protected-resource[/<path>]; then RFC 8414 / OIDC metadata of the first authorization server.
 * Throws OAuthError('discovery').
 */
export async function discover(resourceUrl: string, fetchImpl: FetchLike): Promise<OAuthDiscovery> {
  let target: URL
  try {
    target = new URL(resourceUrl)
  } catch {
    throw new OAuthError('discovery', 'Discovery failed: the server URL is not valid.')
  }
  if (!secureUrl(target.href)) throw new OAuthError('discovery', 'Discovery failed: the server URL must be https.')
  const resource = canonicalResource(resourceUrl)

  let metadataUrl: string | undefined
  let challengeScopes: string[] | undefined
  try {
    const res = await fetchImpl(target.href, { method: 'GET', headers: { Accept: 'application/json, text/event-stream' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
    await res.body?.cancel().catch(() => {})
    if (res.status === 401) {
      const challenges = parseWwwAuthenticate(res.headers.get('www-authenticate') ?? '')
      for (const c of challenges) {
        metadataUrl ??= secureUrl(c.params.resource_metadata)
        if (!challengeScopes && c.params.scope) challengeScopes = c.params.scope.split(/\s+/).filter(Boolean)
      }
    }
  } catch {
    /* fall back to well-known */
  }

  const candidates: string[] = []
  if (metadataUrl) candidates.push(metadataUrl)
  const path = target.pathname.replace(/\/+$/, '')
  if (path) candidates.push(`${target.origin}/.well-known/oauth-protected-resource${path}`)
  candidates.push(`${target.origin}/.well-known/oauth-protected-resource`)
  let prm: Record<string, unknown> | undefined
  for (const c of candidates) {
    prm = await fetchJson(fetchImpl, c)
    if (prm) break
  }
  if (!prm) throw new OAuthError('discovery', 'Discovery failed: the server does not publish protected resource metadata.')
  const servers = Array.isArray(prm.authorization_servers) ? prm.authorization_servers : []
  const issuer = typeof servers[0] === 'string' ? servers[0] : undefined
  if (!issuer) throw new OAuthError('discovery', 'Discovery failed: the resource metadata names no authorization server.')
  requireSecure(issuer, 'the authorization server')

  const iu = new URL(issuer)
  const ipath = iu.pathname.replace(/\/+$/, '')
  const asCandidates = [`${iu.origin}/.well-known/oauth-authorization-server${ipath}`, `${iu.origin}/.well-known/openid-configuration${ipath}`]
  if (ipath) asCandidates.push(`${iu.origin}${ipath}/.well-known/openid-configuration`)
  let meta: Record<string, unknown> | undefined
  for (const c of asCandidates) {
    meta = await fetchJson(fetchImpl, c)
    if (meta) break
  }
  if (!meta) throw new OAuthError('discovery', 'Discovery failed: the authorization server publishes no metadata.')

  const authorizationEndpoint = requireSecure(meta.authorization_endpoint, 'authorization_endpoint')
  const tokenEndpoint = requireSecure(meta.token_endpoint, 'token_endpoint')
  const registrationEndpoint = meta.registration_endpoint === undefined ? undefined : requireSecure(meta.registration_endpoint, 'registration_endpoint')
  const scopes = challengeScopes?.length ? challengeScopes : (stringList(prm.scopes_supported) ?? stringList(meta.scopes_supported))
  const codeChallengeMethods = stringList(meta.code_challenge_methods_supported)
  return {
    resource,
    authorizationServer: issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(scopes ? { scopes } : {}),
    ...(codeChallengeMethods ? { codeChallengeMethods } : {})
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Registration, PKCE, authorize URL

/** RFC 7591 dynamic client registration (public client, PKCE, the loopback redirect). Throws OAuthError('registration'). */
export async function registerClient(d: OAuthDiscovery, redirectUri: string, fetchImpl: FetchLike): Promise<OAuthClient> {
  if (!d.registrationEndpoint) throw new OAuthError('registration', NEEDS_CLIENT_ID_MESSAGE, true)
  let res: Response
  try {
    res = await fetchImpl(d.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'OrgAI',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    })
  } catch (e) {
    throw new OAuthError('registration', `Registration failed: ${excerpt((e as Error).message)}`)
  }
  const text = await res.text().catch(() => '')
  let body: Record<string, unknown> | undefined
  try {
    body = JSON.parse(text)
  } catch {
    /* handled below */
  }
  if (!res.ok || !body || typeof body.client_id !== 'string' || !body.client_id) {
    throw new OAuthError('registration', `Registration failed (HTTP ${res.status}): ${excerpt(text)}`)
  }
  const secret = typeof body.client_secret === 'string' && body.client_secret ? body.client_secret : undefined
  return { clientId: body.client_id, ...(secret ? { clientSecret: secret } : {}), source: 'dcr', redirectUri }
}

const b64url = (b: Buffer): string => b.toString('base64url')

/** PKCE S256: a crypto.randomBytes verifier and its base64url SHA-256 challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

/** The authorization URL: response_type=code, client_id, redirect_uri, state, code_challenge (S256), resource, scope. */
export function buildAuthorizeUrl(
  d: OAuthDiscovery,
  client: OAuthClient,
  p: { redirectUri: string; state: string; challenge: string; scopes?: string[] }
): string {
  const u = new URL(d.authorizationEndpoint)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', client.clientId)
  u.searchParams.set('redirect_uri', p.redirectUri)
  u.searchParams.set('state', p.state)
  u.searchParams.set('code_challenge', p.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('resource', d.resource)
  if (p.scopes?.length) u.searchParams.set('scope', p.scopes.join(' '))
  return u.toString()
}

// ---------------------------------------------------------------------------------------------------------------
// Loopback

/** A one-shot loopback redirect listener on 127.0.0.1. */
export interface LoopbackServer {
  /** http://127.0.0.1:<port>/callback */
  redirectUri: string
  /**
   * Resolve with the code of the first /callback request whose state matches exactly; reject (OAuthError
   * 'callback') on an error response, a state mismatch, timeout or abort. The page served is plain static HTML
   * without scripts and never echoes query parameters.
   */
  waitForCode(state: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<string>
  close(): void
}

const PAGE_OK = 'Authorization received. You can close this window and return to OrgAI.'
const PAGE_ERR = 'Authorization failed. You can close this window and return to OrgAI.'

function page(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>OrgAI</title></head><body><p>${message}</p></body></html>`
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Listen on 127.0.0.1 (the given port when free, else an ephemeral one). */
export async function startLoopback(opts: { port?: number } = {}): Promise<LoopbackServer> {
  interface Callback {
    code?: string
    state?: string
    error?: string
    description?: string
  }
  let received: Callback | undefined
  let waiter: { state: string; settle(cb: Callback): void } | undefined
  let closed = false

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      res.writeHead(400).end()
      return
    }
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" }).end('Not found')
      return
    }
    const cb: Callback = {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
      error: url.searchParams.get('error') ?? undefined,
      description: url.searchParams.get('error_description') ?? undefined
    }
    const ok = !cb.error && !!cb.code && (!waiter || sameString(cb.state ?? '', waiter.state))
    res.writeHead(ok ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'no-store',
      Connection: 'close'
    })
    res.end(page(ok ? PAGE_OK : PAGE_ERR), () => {
      if (waiter) waiter.settle(cb)
      else received ??= cb
    })
  })

  const listen = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const onError = (e: Error): void => reject(e)
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError)
        resolve()
      })
    })
  if (opts.port) {
    try {
      await listen(opts.port)
    } catch {
      await listen(0)
    }
  } else await listen(0)
  const port = (server.address() as AddressInfo).port

  const close = (): void => {
    if (closed) return
    closed = true
    server.close()
    server.closeIdleConnections?.()
    setTimeout(() => server.closeAllConnections?.(), 1000).unref()
  }

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    close,
    waitForCode(state, { timeoutMs, signal }) {
      return new Promise<string>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let done = false
        const finish = (fn: () => void): void => {
          if (done) return
          done = true
          if (timer) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          waiter = undefined
          close()
          fn()
        }
        const onAbort = (): void => finish(() => reject(new OAuthError('callback', 'Authorization was cancelled.')))
        const settle = (cb: Callback): void =>
          finish(() => {
            if (cb.error) {
              const desc = cb.description ? `: ${cb.description.replace(/[^\w .,'-]/g, '').slice(0, 80)}` : ''
              reject(new OAuthError('callback', `Authorization was denied (${cb.error.replace(/[^\w.-]/g, '').slice(0, 40)}${desc}).`))
            } else if (!cb.code || !cb.state || !sameString(cb.state, state)) {
              reject(new OAuthError('callback', 'Authorization response did not match this request (state mismatch).'))
            } else resolve(cb.code)
          })
        if (signal?.aborted) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => finish(() => reject(new OAuthError('callback', 'Authorization timed out.'))), timeoutMs)
        waiter = { state, settle }
        if (received) settle(received)
      })
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Token endpoint

async function postToken(
  step: 'token' | 'refresh',
  endpoint: string,
  form: Record<string, string | undefined>,
  secrets: string[],
  fetchImpl: FetchLike,
  now: () => number
): Promise<OAuthTokens> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(form)) if (v) body.set(k, v)
  const label = step === 'token' ? 'Token request' : 'Token refresh'
  let res: Response
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
    })
  } catch (e) {
    throw new OAuthError(step, `${label} failed: ${excerpt((e as Error).message, secrets)}`)
  }
  const text = await res.text().catch(() => '')
  let parsed: Record<string, unknown> = {}
  try {
    const j: unknown = JSON.parse(text)
    if (j && typeof j === 'object') parsed = j as Record<string, unknown>
  } catch {
    parsed = Object.fromEntries(new URLSearchParams(text))
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const access = str(parsed.access_token)
  if (!res.ok || parsed.error || !access) {
    const err = str(parsed.error)
    const desc = str(parsed.error_description)
    const detail = err
      ? `${err.replace(/[^\w.-]/g, '').slice(0, 40)}${desc ? `: ${excerpt(desc, secrets)}` : ''}`
      : excerpt(text, secrets) || 'no access token in the response'
    throw new OAuthError(step, `${label} failed (HTTP ${res.status}): ${detail}`)
  }
  const expiresIn = Number(parsed.expires_in)
  const hasExpiry = parsed.expires_in !== undefined && parsed.expires_in !== '' && Number.isFinite(expiresIn)
  return {
    accessToken: access,
    ...(str(parsed.refresh_token) ? { refreshToken: str(parsed.refresh_token) } : {}),
    ...(hasExpiry ? { expiresAt: new Date(now() + expiresIn * 1000).toISOString() } : {}),
    ...(str(parsed.scope) ? { scope: str(parsed.scope) } : {})
  }
}

/** authorization_code grant with code_verifier, redirect_uri and resource (client_secret when the client has one). */
export async function exchangeCode(
  d: Pick<OAuthDiscovery, 'tokenEndpoint' | 'resource'>,
  client: OAuthClient,
  p: { code: string; verifier: string; redirectUri: string },
  fetchImpl: FetchLike,
  now: () => number = Date.now
): Promise<OAuthTokens> {
  return postToken(
    'token',
    d.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      client_id: client.clientId,
      resource: d.resource,
      client_secret: client.clientSecret
    },
    [p.code, p.verifier, client.clientSecret ?? ''],
    fetchImpl,
    now
  )
}

/**
 * refresh_token grant (resource, client_secret when stored). The result carries the rotated refresh token when
 * the server sent one, else the old one. Throws OAuthError('refresh').
 */
export async function refreshTokens(
  config: Pick<McpOAuthConfig, 'tokenEndpoint' | 'resource' | 'clientId'>,
  p: { refreshToken: string; clientSecret?: string },
  fetchImpl: FetchLike,
  now: () => number = Date.now
): Promise<OAuthTokens> {
  if (!config.tokenEndpoint || !config.clientId) throw new OAuthError('refresh', 'Token refresh failed: the stored authorization is incomplete. Authorize again.')
  const t = await postToken(
    'refresh',
    config.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: p.refreshToken,
      client_id: config.clientId,
      resource: config.resource,
      client_secret: p.clientSecret
    },
    [p.refreshToken, p.clientSecret ?? ''],
    fetchImpl,
    now
  )
  return { ...t, refreshToken: t.refreshToken ?? p.refreshToken }
}

// ---------------------------------------------------------------------------------------------------------------
// The flow

export interface AuthorizeFlowInput {
  /** The MCP server URL. */
  url: string
  /** The stored config: a client id (manual or dcr), a dcr redirectUri to reuse, endpoints from last time. */
  config?: McpOAuthConfig
  /** A newly entered client id (wins over the stored one; source 'manual'). */
  clientId?: string
  /** The client secret to use: newly entered, else the stored one. */
  clientSecret?: string
  fetch: FetchLike
  /** Opens the authorization URL in the system browser (shell.openExternal in index.ts). */
  openExternal(url: string): Promise<void>
  signal?: AbortSignal
  /** Default 5 minutes. */
  timeoutMs?: number
  now?: () => number
  /** Tests inject a fake listener. Default startLoopback. */
  listen?: (opts: { port?: number }) => Promise<LoopbackServer>
}

export interface AuthorizeFlowResult {
  /** The full non-secret config to store (endpoints, client id and source, scopes, authorizedAt, expiresAt, hasClientSecret). */
  config: McpOAuthConfig
  tokens: OAuthTokens
  /** A client secret to store (from DCR or newly entered); undefined = keep whatever is stored. */
  clientSecret?: string
}

/**
 * The whole interactive flow: discover, pick the client (entered id > stored id > DCR > OAuthError with
 * needsClientId), listen, open the browser, wait for the callback, exchange the code. Throws OAuthError.
 */
export async function runAuthorization(input: AuthorizeFlowInput): Promise<AuthorizeFlowResult> {
  const now = input.now ?? Date.now
  const listen = input.listen ?? startLoopback
  const d = await discover(input.url, input.fetch)
  if (d.codeChallengeMethods && !d.codeChallengeMethods.includes('S256')) {
    throw new OAuthError('authorization', 'Authorization failed: the authorization server does not support PKCE S256.')
  }

  const entered = input.clientId?.trim()
  const stored =
    input.config?.clientId && (!input.config.authorizationServer || input.config.authorizationServer === d.authorizationServer) ? input.config : undefined
  let listener: LoopbackServer | undefined
  try {
    let client: OAuthClient
    let secretToStore: string | undefined
    let hasClientSecret = false
    if (entered) {
      listener = await listen({})
      client = { clientId: entered, ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}), source: 'manual' }
      secretToStore = input.clientSecret || undefined
      hasClientSecret = !!input.clientSecret
    } else if (stored && stored.clientSource !== 'dcr') {
      listener = await listen({})
      client = { clientId: stored.clientId!, ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}), source: 'manual' }
      hasClientSecret = !!input.clientSecret || !!stored.hasClientSecret
    } else if (stored && stored.redirectUri) {
      let port: number | undefined
      try {
        port = Number(new URL(stored.redirectUri).port) || undefined
      } catch {
        /* register anew */
      }
      listener = await listen({ port })
      if (listener.redirectUri === stored.redirectUri) {
        client = { clientId: stored.clientId!, ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}), source: 'dcr', redirectUri: stored.redirectUri }
        hasClientSecret = !!input.clientSecret || !!stored.hasClientSecret
      } else {
        client = await registerClient(d, listener.redirectUri, input.fetch)
        secretToStore = client.clientSecret
        hasClientSecret = !!client.clientSecret
      }
    } else if (d.registrationEndpoint) {
      listener = await listen({})
      client = await registerClient(d, listener.redirectUri, input.fetch)
      secretToStore = client.clientSecret
      hasClientSecret = !!client.clientSecret
    } else {
      throw new OAuthError('registration', NEEDS_CLIENT_ID_MESSAGE, true)
    }

    const redirectUri = listener.redirectUri
    const { verifier, challenge } = createPkce()
    const state = b64url(randomBytes(16))
    const url = buildAuthorizeUrl(d, client, { redirectUri, state, challenge, scopes: d.scopes })
    const codeP = listener.waitForCode(state, { timeoutMs: input.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS, signal: input.signal })
    codeP.catch(() => {})
    try {
      await input.openExternal(url)
    } catch (e) {
      listener.close()
      throw new OAuthError('authorization', `Could not open the browser: ${excerpt((e as Error).message)}`)
    }
    const code = await codeP
    const tokens = await exchangeCode(d, client, { code, verifier, redirectUri }, input.fetch, now)
    const config: McpOAuthConfig = {
      resource: d.resource,
      authorizationServer: d.authorizationServer,
      authorizationEndpoint: d.authorizationEndpoint,
      tokenEndpoint: d.tokenEndpoint,
      ...(d.registrationEndpoint ? { registrationEndpoint: d.registrationEndpoint } : {}),
      ...(d.scopes ? { scopes: d.scopes } : {}),
      clientId: client.clientId,
      clientSource: client.source,
      ...(client.source === 'dcr' ? { redirectUri: client.redirectUri } : {}),
      hasClientSecret,
      authorizedAt: new Date(now()).toISOString(),
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {})
    }
    return { config, tokens, ...(secretToStore ? { clientSecret: secretToStore } : {}) }
  } finally {
    listener?.close()
  }
}

/**
 * The state shown for a server. No config = 'notRequired'; config without an access token = 'notAuthorized'; an
 * access token past expiresAt with no refresh token = 'expired'; otherwise 'authorized' (an expired token with a
 * refresh token is refreshed before use).
 */
export function authStatusFrom(
  config: McpOAuthConfig | undefined,
  stored: { accessToken: boolean; refreshToken: boolean },
  now: number
): McpAuthStatus {
  if (!config) return { state: 'notRequired' }
  const extra = { ...(config.expiresAt ? { expiresAt: config.expiresAt } : {}), ...(config.account ? { account: config.account } : {}) }
  if (!stored.accessToken) return { state: 'notAuthorized' }
  const expires = config.expiresAt ? Date.parse(config.expiresAt) : NaN
  if (Number.isFinite(expires) && expires <= now && !stored.refreshToken) return { state: 'expired', ...extra }
  return { state: 'authorized', ...extra }
}
