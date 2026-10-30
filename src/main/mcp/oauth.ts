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
 *
 * CONTRACT STUB (Runtime Lead): signatures are fixed; the Runtime Engineer implements the bodies and tests.
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

/** Parse a WWW-Authenticate header (several challenges, quoted or token params). Never throws. */
export function parseWwwAuthenticate(_header: string): AuthChallenge[] {
  throw new Error('not implemented')
}

/** The canonical MCP server URI used as the RFC 8707 `resource`: lowercase scheme and host, no fragment. */
export function canonicalResource(_url: string): string {
  throw new Error('not implemented')
}

/**
 * Discover the authorization server for an MCP URL: probe it (401 + WWW-Authenticate resource_metadata), else
 * /.well-known/oauth-protected-resource[/<path>]; then RFC 8414 / OIDC metadata of the first authorization server.
 * Throws OAuthError('discovery').
 */
export async function discover(_resourceUrl: string, _fetchImpl: FetchLike): Promise<OAuthDiscovery> {
  throw new Error('not implemented')
}

/** RFC 7591 dynamic client registration (public client, PKCE, the loopback redirect). Throws OAuthError('registration'). */
export async function registerClient(_d: OAuthDiscovery, _redirectUri: string, _fetchImpl: FetchLike): Promise<OAuthClient> {
  throw new Error('not implemented')
}

/** PKCE S256: a crypto.randomBytes verifier and its base64url SHA-256 challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  throw new Error('not implemented')
}

/** The authorization URL: response_type=code, client_id, redirect_uri, state, code_challenge (S256), resource, scope. */
export function buildAuthorizeUrl(
  _d: OAuthDiscovery,
  _client: OAuthClient,
  _p: { redirectUri: string; state: string; challenge: string; scopes?: string[] }
): string {
  throw new Error('not implemented')
}

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

/** Listen on 127.0.0.1 (the given port when free, else an ephemeral one). */
export async function startLoopback(_opts: { port?: number } = {}): Promise<LoopbackServer> {
  throw new Error('not implemented')
}

/** authorization_code grant with code_verifier, redirect_uri and resource (client_secret when the client has one). */
export async function exchangeCode(
  _d: Pick<OAuthDiscovery, 'tokenEndpoint' | 'resource'>,
  _client: OAuthClient,
  _p: { code: string; verifier: string; redirectUri: string },
  _fetchImpl: FetchLike,
  _now?: () => number
): Promise<OAuthTokens> {
  throw new Error('not implemented')
}

/**
 * refresh_token grant (resource, client_secret when stored). The result carries the rotated refresh token when
 * the server sent one, else the old one. Throws OAuthError('refresh').
 */
export async function refreshTokens(
  _config: Pick<McpOAuthConfig, 'tokenEndpoint' | 'resource' | 'clientId'>,
  _p: { refreshToken: string; clientSecret?: string },
  _fetchImpl: FetchLike,
  _now?: () => number
): Promise<OAuthTokens> {
  throw new Error('not implemented')
}

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
export async function runAuthorization(_input: AuthorizeFlowInput): Promise<AuthorizeFlowResult> {
  throw new Error('not implemented')
}

/**
 * The state shown for a server. No config = 'notRequired'; config without an access token = 'notAuthorized'; an
 * access token past expiresAt with no refresh token = 'expired'; otherwise 'authorized' (an expired token with a
 * refresh token is refreshed before use).
 */
export function authStatusFrom(
  _config: McpOAuthConfig | undefined,
  _stored: { accessToken: boolean; refreshToken: boolean },
  _now: number
): McpAuthStatus {
  throw new Error('not implemented')
}

/** Replace every occurrence of the given secret values (and bearer tokens / code= / *_token= params) with [redacted]. */
export function redactOAuth(_text: string, _secrets: readonly string[] = []): string {
  throw new Error('not implemented')
}
