import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  NEEDS_CLIENT_ID_MESSAGE,
  OAuthError,
  authStatusFrom,
  buildAuthorizeUrl,
  canonicalResource,
  createPkce,
  discover,
  exchangeCode,
  parseWwwAuthenticate,
  redactOAuth,
  refreshTokens,
  registerClient,
  runAuthorization,
  startLoopback,
  type FetchLike,
  type LoopbackServer,
  type OAuthDiscovery
} from './oauth'

type Handler = (url: URL, init: RequestInit | undefined) => Response | undefined | Promise<Response | undefined>

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/** A fake fetch routed by "METHOD url" handlers; unknown URLs are 404. Records every call. */
function fakeFetch(routes: Record<string, Handler>): { fetch: FetchLike; calls: { method: string; url: string; body?: string }[] } {
  const calls: { method: string; url: string; body?: string }[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined })
    const h = routes[`${method} ${url}`]
    return (h && (await h(new URL(url), init))) ?? new Response('nope', { status: 404 })
  }) as FetchLike
  return { fetch: f, calls }
}

const MCP = 'https://mcp.example.com/mcp'
const AS = 'https://auth.example.com'
const PRM = { resource: MCP, authorization_servers: [AS], scopes_supported: ['prm:scope'] }
const ASMETA = {
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  registration_endpoint: `${AS}/register`,
  scopes_supported: ['as:scope'],
  code_challenge_methods_supported: ['S256']
}

function discoveryRoutes(over: { asMeta?: Record<string, unknown>; challenge?: string } = {}): Record<string, Handler> {
  return {
    [`GET ${MCP}`]: () =>
      new Response('', {
        status: 401,
        headers: { 'www-authenticate': over.challenge ?? `Bearer realm="mcp", resource_metadata="https://mcp.example.com/prm.json", scope="repo read:org"` }
      }),
    'GET https://mcp.example.com/prm.json': () => json(PRM),
    [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json(over.asMeta ?? ASMETA)
  }
}

describe('parseWwwAuthenticate', () => {
  it('parses quoted and token params and several challenges', () => {
    const r = parseWwwAuthenticate(
      'Bearer realm="x", resource_metadata="https://a.b/prm", scope="repo read:org", error="invalid_token", Basic realm=y, charset=UTF-8'
    )
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({
      scheme: 'Bearer',
      params: { realm: 'x', resource_metadata: 'https://a.b/prm', scope: 'repo read:org', error: 'invalid_token' }
    })
    expect(r[1]).toEqual({ scheme: 'Basic', params: { realm: 'y', charset: 'UTF-8' } })
  })

  it('never throws', () => {
    for (const h of ['', ',,,', '=', 'Bearer', 'Bearer a="unterminated', '\u0000', 'Bearer ="x"']) expect(() => parseWwwAuthenticate(h)).not.toThrow()
    expect(parseWwwAuthenticate('Bearer')).toEqual([{ scheme: 'Bearer', params: {} }])
    expect(parseWwwAuthenticate(undefined as unknown as string)).toEqual([])
  })

  it('unescapes quoted pairs', () => {
    expect(parseWwwAuthenticate('Bearer realm="a \\"b\\" c"')[0].params.realm).toBe('a "b" c')
  })
})

describe('canonicalResource', () => {
  it('lowercases scheme and host, drops fragment and default port, keeps path and query', () => {
    expect(canonicalResource('HTTPS://MCP.Example.COM:443/Mcp/x?a=1#frag')).toBe('https://mcp.example.com/Mcp/x?a=1')
    expect(canonicalResource('https://Example.com/')).toBe('https://example.com')
    expect(canonicalResource('http://127.0.0.1:8080/m')).toBe('http://127.0.0.1:8080/m')
  })
})

describe('discover', () => {
  it('follows a 401 challenge to the resource metadata, then the AS metadata, with challenge scopes first', async () => {
    const { fetch, calls } = fakeFetch(discoveryRoutes())
    const d = await discover(MCP, fetch)
    expect(d).toMatchObject({
      resource: MCP,
      authorizationServer: AS,
      authorizationEndpoint: `${AS}/authorize`,
      tokenEndpoint: `${AS}/token`,
      registrationEndpoint: `${AS}/register`,
      scopes: ['repo', 'read:org'],
      codeChallengeMethods: ['S256']
    })
    expect(calls.map((c) => c.url)).toContain('https://mcp.example.com/prm.json')
  })

  it('falls back to the well-known path then root when there is no usable challenge', async () => {
    const routes = discoveryRoutes({ challenge: 'Bearer realm="x"' })
    delete routes['GET https://mcp.example.com/prm.json']
    routes['GET https://mcp.example.com/.well-known/oauth-protected-resource'] = () => json(PRM)
    const { fetch, calls } = fakeFetch(routes)
    const d = await discover(MCP, fetch)
    expect(d.scopes).toEqual(['prm:scope'])
    expect(calls.map((c) => c.url)).toContain('https://mcp.example.com/.well-known/oauth-protected-resource/mcp')
  })

  it('uses the path-insertion PRM when the server is not reachable for a probe', async () => {
    const routes = discoveryRoutes()
    delete routes[`GET ${MCP}`]
    delete routes['GET https://mcp.example.com/prm.json']
    routes['GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp'] = () => json(PRM)
    const { fetch } = fakeFetch(routes)
    expect((await discover(MCP, fetch)).authorizationServer).toBe(AS)
  })

  it('falls back to OIDC discovery (insertion then appended) for an issuer with a path', async () => {
    const issuer = 'https://auth.example.com/tenant'
    const routes = discoveryRoutes()
    routes['GET https://mcp.example.com/prm.json'] = () => json({ ...PRM, authorization_servers: [issuer] })
    delete routes[`GET ${AS}/.well-known/oauth-authorization-server`]
    routes['GET https://auth.example.com/tenant/.well-known/openid-configuration'] = () =>
      json({ ...ASMETA, issuer, scopes_supported: ['oidc'] })
    const { fetch, calls } = fakeFetch(routes)
    const d = await discover(MCP, fetch)
    expect(d.authorizationServer).toBe(issuer)
    const urls = calls.map((c) => c.url)
    expect(urls).toContain('https://auth.example.com/.well-known/oauth-authorization-server/tenant')
    expect(urls).toContain('https://auth.example.com/.well-known/openid-configuration/tenant')
  })

  it('falls back to OIDC at the origin', async () => {
    const routes = discoveryRoutes()
    delete routes[`GET ${AS}/.well-known/oauth-authorization-server`]
    routes[`GET ${AS}/.well-known/openid-configuration`] = () => json(ASMETA)
    const { fetch } = fakeFetch(routes)
    expect((await discover(MCP, fetch)).tokenEndpoint).toBe(`${AS}/token`)
  })

  it('scope precedence: challenge, then resource scopes, then AS scopes, else undefined', async () => {
    const noChallenge = 'Bearer resource_metadata="https://mcp.example.com/prm.json"'
    let { fetch } = fakeFetch(discoveryRoutes({ challenge: noChallenge }))
    expect((await discover(MCP, fetch)).scopes).toEqual(['prm:scope'])
    const routes = discoveryRoutes({ challenge: noChallenge })
    routes['GET https://mcp.example.com/prm.json'] = () => json({ authorization_servers: [AS] })
    ;({ fetch } = fakeFetch(routes))
    expect((await discover(MCP, fetch)).scopes).toEqual(['as:scope'])
    const r2 = discoveryRoutes({ challenge: noChallenge, asMeta: { ...ASMETA, scopes_supported: undefined } })
    r2['GET https://mcp.example.com/prm.json'] = () => json({ authorization_servers: [AS] })
    ;({ fetch } = fakeFetch(r2))
    expect((await discover(MCP, fetch)).scopes).toBeUndefined()
  })

  it('rejects non-https metadata URLs and reports discovery errors', async () => {
    const { fetch } = fakeFetch(discoveryRoutes({ asMeta: { ...ASMETA, token_endpoint: 'http://auth.example.com/token' } }))
    await expect(discover(MCP, fetch)).rejects.toMatchObject({ step: 'discovery', message: expect.stringContaining('Discovery failed') })
    await expect(discover('http://remote.example.com/mcp', fetch)).rejects.toBeInstanceOf(OAuthError)
    await expect(discover(MCP, fakeFetch({}).fetch)).rejects.toMatchObject({ step: 'discovery' })
  })

  it('allows http for loopback hosts', async () => {
    const base = 'http://127.0.0.1:9999'
    const { fetch } = fakeFetch({
      [`GET ${base}/mcp`]: () => new Response('', { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${base}/prm"` } }),
      [`GET ${base}/prm`]: () => json({ authorization_servers: [base] }),
      [`GET ${base}/.well-known/oauth-authorization-server`]: () =>
        json({ authorization_endpoint: `${base}/a`, token_endpoint: `${base}/t` })
    })
    const d = await discover(`${base}/mcp`, fetch)
    expect(d.authorizationEndpoint).toBe(`${base}/a`)
  })
})

describe('PKCE and authorize URL', () => {
  it('creates a base64url verifier and the S256 challenge', () => {
    const { verifier, challenge } = createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(createPkce().verifier).not.toBe(verifier)
  })

  it('builds the authorize URL', () => {
    const d: OAuthDiscovery = { resource: MCP, authorizationServer: AS, authorizationEndpoint: `${AS}/authorize`, tokenEndpoint: `${AS}/token` }
    const u = new URL(
      buildAuthorizeUrl(d, { clientId: 'cid', source: 'manual' }, { redirectUri: 'http://127.0.0.1:1/callback', state: 'st', challenge: 'ch', scopes: ['a', 'b'] })
    )
    const q = u.searchParams
    expect(q.get('response_type')).toBe('code')
    expect(q.get('client_id')).toBe('cid')
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:1/callback')
    expect(q.get('state')).toBe('st')
    expect(q.get('code_challenge')).toBe('ch')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('resource')).toBe(MCP)
    expect(q.get('scope')).toBe('a b')
    const none = new URL(buildAuthorizeUrl(d, { clientId: 'c', source: 'manual' }, { redirectUri: 'r', state: 's', challenge: 'c' }))
    expect(none.searchParams.has('scope')).toBe(false)
  })
})

describe('registerClient', () => {
  const d: OAuthDiscovery = { resource: MCP, authorizationServer: AS, authorizationEndpoint: 'x', tokenEndpoint: 'y', registrationEndpoint: `${AS}/register` }

  it('posts the RFC 7591 document', async () => {
    const { fetch, calls } = fakeFetch({ [`POST ${AS}/register`]: () => json({ client_id: 'dcr-id', client_secret: 'dcr-secret' }, 201) })
    const c = await registerClient(d, 'http://127.0.0.1:5/callback', fetch)
    expect(c).toEqual({ clientId: 'dcr-id', clientSecret: 'dcr-secret', source: 'dcr', redirectUri: 'http://127.0.0.1:5/callback' })
    expect(JSON.parse(calls[0].body!)).toEqual({
      client_name: 'OrgAI',
      redirect_uris: ['http://127.0.0.1:5/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  })

  it('fails with a registration error', async () => {
    const { fetch } = fakeFetch({ [`POST ${AS}/register`]: () => json({ error: 'invalid_redirect_uri' }, 400) })
    await expect(registerClient(d, 'r', fetch)).rejects.toMatchObject({ step: 'registration' })
  })
})

describe('token endpoint', () => {
  const D = { tokenEndpoint: `${AS}/token`, resource: MCP }
  const NOW = Date.parse('2026-01-01T00:00:00Z')

  it('sends resource, verifier, redirect and the client secret; parses JSON', async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${AS}/token`]: () => json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'repo' })
    })
    const t = await exchangeCode(D, { clientId: 'cid', clientSecret: 'csecret', source: 'manual' }, { code: 'the-code', verifier: 'ver', redirectUri: 'http://127.0.0.1:1/callback' }, fetch, () => NOW)
    expect(t).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: '2026-01-01T01:00:00.000Z', scope: 'repo' })
    const form = new URLSearchParams(calls[0].body)
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      code_verifier: 'ver',
      redirect_uri: 'http://127.0.0.1:1/callback',
      client_id: 'cid',
      resource: MCP,
      client_secret: 'csecret'
    })
  })

  it('omits client_secret without one and parses form-encoded bodies', async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${AS}/token`]: () => new Response('access_token=gho_abc&token_type=bearer&scope=repo', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    })
    const t = await exchangeCode(D, { clientId: 'cid', source: 'dcr' }, { code: 'c', verifier: 'v', redirectUri: 'r' }, fetch, () => NOW)
    expect(t).toEqual({ accessToken: 'gho_abc', scope: 'repo' })
    expect(new URLSearchParams(calls[0].body).has('client_secret')).toBe(false)
  })

  it('treats a 200 body with error as a failure', async () => {
    const { fetch } = fakeFetch({ [`POST ${AS}/token`]: () => json({ error: 'bad_verification_code', error_description: 'expired' }) })
    await expect(exchangeCode(D, { clientId: 'c', source: 'manual' }, { code: 'c', verifier: 'v', redirectUri: 'r' }, fetch)).rejects.toMatchObject({
      step: 'token',
      message: expect.stringContaining('bad_verification_code')
    })
  })

  it('refresh rotates the refresh token, or keeps the old one', async () => {
    let body: Record<string, unknown> = { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 60 }
    const { fetch, calls } = fakeFetch({ [`POST ${AS}/token`]: () => json(body) })
    const cfg = { tokenEndpoint: `${AS}/token`, resource: MCP, clientId: 'cid' }
    const rotated = await refreshTokens(cfg, { refreshToken: 'rt-1', clientSecret: 'cs' }, fetch, () => NOW)
    expect(rotated.refreshToken).toBe('rt-2')
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'cid',
      resource: MCP,
      client_secret: 'cs'
    })
    body = { access_token: 'at-3' }
    const kept = await refreshTokens(cfg, { refreshToken: 'rt-1' }, fetch, () => NOW)
    expect(kept).toEqual({ accessToken: 'at-3', refreshToken: 'rt-1' })
  })

  it('refresh failures are step refresh and never echo secrets', async () => {
    const { fetch } = fakeFetch({
      [`POST ${AS}/token`]: () => new Response('{"error":"invalid_grant","refresh_token":"rt-secret-1"} refresh_token=rt-secret-1 Bearer abc.def', { status: 400 })
    })
    const err = await refreshTokens({ tokenEndpoint: `${AS}/token`, resource: MCP, clientId: 'c' }, { refreshToken: 'rt-secret-1', clientSecret: 'cs-secret-1' }, fetch).catch((e) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect(err.step).toBe('refresh')
    expect(err.message).not.toContain('rt-secret-1')
    expect(err.message).not.toContain('abc.def')
  })
})

describe('redactOAuth', () => {
  it('redacts given secrets, bearer values, code= and token fields', () => {
    const text =
      'Bearer abc123 code=xyz&state=1 {"access_token":"AT","refresh_token":"RT","client_secret":"CS","id_token":"ID","x":"keep"} client_secret=zzz secret-value-9'
    const out = redactOAuth(text, ['secret-value-9'])
    for (const leak of ['abc123', 'xyz', '"AT"', '"RT"', '"CS"', '"ID"', 'zzz', 'secret-value-9']) expect(out).not.toContain(leak)
    expect(out).toContain('"x":"keep"')
    expect(out).toContain('[redacted]')
  })
})

describe('loopback', () => {
  const get = (url: string): Promise<Response> => fetch(url)

  it('resolves the code for the matching state and serves a static page', async () => {
    const lb = await startLoopback()
    expect(lb.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const p = lb.waitForCode('s1', { timeoutMs: 5000 })
    const res = await get(`${lb.redirectUri}?code=c0de&state=s1&junk=%3Cscript%3Ealert(1)%3C/script%3E`)
    const html = await res.text()
    expect(await p).toBe('c0de')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(html).toContain('Authorization received. You can close this window and return to OrgAI.')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toContain('c0de')
    expect(html).not.toContain('alert')
    lb.close()
  })

  it('rejects a mismatched state', async () => {
    const lb = await startLoopback()
    const p = lb.waitForCode('right', { timeoutMs: 5000 })
    const assertion = expect(p).rejects.toMatchObject({ step: 'callback' })
    const res = await get(`${lb.redirectUri}?code=c&state=wrong`)
    await res.text()
    await assertion
    lb.close()
  })

  it('answers 404 for other paths and ignores them', async () => {
    const lb = await startLoopback()
    const p = lb.waitForCode('s', { timeoutMs: 5000 })
    const other = await get(lb.redirectUri.replace('/callback', '/other?code=c&state=s'))
    expect(other.status).toBe(404)
    await other.text()
    await (await get(`${lb.redirectUri}?code=ok&state=s`)).text()
    expect(await p).toBe('ok')
    lb.close()
  })

  it('rejects an error response without echoing raw text', async () => {
    const lb = await startLoopback()
    const p = lb.waitForCode('s', { timeoutMs: 5000 })
    const assertion = expect(p).rejects.toMatchObject({ step: 'callback', message: expect.stringContaining('access_denied') })
    const res = await get(`${lb.redirectUri}?error=access_denied&error_description=user%20said%20no%3Cscript%3E&state=s`)
    const html = await res.text()
    expect(html).not.toContain('access_denied')
    await assertion
    const err = (await p.catch((e) => e)) as Error
    expect(err.message).not.toContain('<')
    lb.close()
  })

  it('rejects on timeout and on abort', async () => {
    const a = await startLoopback()
    await expect(a.waitForCode('s', { timeoutMs: 20 })).rejects.toMatchObject({ message: 'Authorization timed out.' })
    const b = await startLoopback()
    const ac = new AbortController()
    const p = b.waitForCode('s', { timeoutMs: 5000, signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ message: 'Authorization was cancelled.' })
    const c = await startLoopback()
    await expect(c.waitForCode('s', { timeoutMs: 5000, signal: AbortSignal.abort() })).rejects.toMatchObject({ message: 'Authorization was cancelled.' })
  })

  it('uses the requested port when free, else an ephemeral one', async () => {
    const a = await startLoopback()
    const port = Number(new URL(a.redirectUri).port)
    const b = await startLoopback({ port })
    expect(b.redirectUri).not.toBe(a.redirectUri)
    a.close()
    b.close()
  })
})

describe('runAuthorization', () => {
  /** The "browser": follows the authorize URL by hitting the redirect URI with a code and the state. */
  function browser(opts: { code?: string; state?: (s: string) => string } = {}): { open: (url: string) => Promise<void>; urls: URL[] } {
    const urls: URL[] = []
    return {
      urls,
      open: async (raw) => {
        const u = new URL(raw)
        urls.push(u)
        const redirect = new URL(u.searchParams.get('redirect_uri')!)
        redirect.searchParams.set('code', opts.code ?? 'auth-code-1')
        redirect.searchParams.set('state', opts.state ? opts.state(u.searchParams.get('state')!) : u.searchParams.get('state')!)
        await (await fetch(redirect)).text()
      }
    }
  }

  function flowRoutes(token: Handler, extra: Record<string, Handler> = {}): Record<string, Handler> {
    return {
      ...discoveryRoutes(),
      [`POST ${AS}/register`]: () => json({ client_id: 'dcr-client' }, 201),
      [`POST ${AS}/token`]: token,
      ...extra
    }
  }
  const okToken: Handler = () => json({ access_token: 'AT-secret', refresh_token: 'RT-secret', expires_in: 3600 })
  const NOW = Date.parse('2026-03-01T00:00:00Z')

  it('registers dynamically, authorizes and exchanges', async () => {
    const { fetch, calls } = fakeFetch(flowRoutes(okToken))
    const b = browser()
    const r = await runAuthorization({ url: MCP, fetch, openExternal: b.open, now: () => NOW })
    expect(r.tokens).toEqual({ accessToken: 'AT-secret', refreshToken: 'RT-secret', expiresAt: '2026-03-01T01:00:00.000Z' })
    expect(r.config).toMatchObject({
      resource: MCP,
      authorizationServer: AS,
      authorizationEndpoint: `${AS}/authorize`,
      tokenEndpoint: `${AS}/token`,
      registrationEndpoint: `${AS}/register`,
      scopes: ['repo', 'read:org'],
      clientId: 'dcr-client',
      clientSource: 'dcr',
      hasClientSecret: false,
      authorizedAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2026-03-01T01:00:00.000Z'
    })
    expect(r.config.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(r.clientSecret).toBeUndefined()
    const q = b.urls[0].searchParams
    expect(q.get('resource')).toBe(MCP)
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('scope')).toBe('repo read:org')
    const tokenCall = calls.find((c) => c.url === `${AS}/token`)!
    const form = new URLSearchParams(tokenCall.body)
    expect(form.get('code')).toBe('auth-code-1')
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(q.get('code_challenge'))
    expect(form.get('redirect_uri')).toBe(q.get('redirect_uri'))
  })

  it('a manual client id wins and DCR is not called; the secret is sent and returned', async () => {
    const { fetch, calls } = fakeFetch(flowRoutes(okToken))
    const r = await runAuthorization({
      url: MCP,
      clientId: ' my-app ',
      clientSecret: 'my-secret',
      config: { clientId: 'old', clientSource: 'dcr' },
      fetch,
      openExternal: browser().open
    })
    expect(calls.some((c) => c.url === `${AS}/register`)).toBe(false)
    expect(r.config).toMatchObject({ clientId: 'my-app', clientSource: 'manual', hasClientSecret: true })
    expect(r.config.redirectUri).toBeUndefined()
    expect(r.clientSecret).toBe('my-secret')
    expect(new URLSearchParams(calls.find((c) => c.url === `${AS}/token`)!.body).get('client_secret')).toBe('my-secret')
  })

  it('a stored manual client is reused with the stored secret, which is not returned again', async () => {
    const { fetch, calls } = fakeFetch(flowRoutes(okToken))
    const r = await runAuthorization({
      url: MCP,
      clientSecret: 'stored-secret',
      config: { clientId: 'kept', clientSource: 'manual', hasClientSecret: true, authorizationServer: AS },
      fetch,
      openExternal: browser().open
    })
    expect(r.config).toMatchObject({ clientId: 'kept', clientSource: 'manual', hasClientSecret: true })
    expect(r.clientSecret).toBeUndefined()
    expect(calls.some((c) => c.url === `${AS}/register`)).toBe(false)
  })

  it('reuses a stored dcr client when the redirect port is free, else re-registers', async () => {
    const probe = await startLoopback()
    const redirectUri = probe.redirectUri
    probe.close()
    await new Promise((r) => setTimeout(r, 50))
    const { fetch, calls } = fakeFetch(flowRoutes(okToken))
    const reuse = await runAuthorization({ url: MCP, config: { clientId: 'dcr-old', clientSource: 'dcr', redirectUri }, fetch, openExternal: browser().open })
    expect(reuse.config.clientId).toBe('dcr-old')
    expect(calls.some((c) => c.url === `${AS}/register`)).toBe(false)

    const busy = await startLoopback()
    const r2 = await runAuthorization({ url: MCP, config: { clientId: 'dcr-old', clientSource: 'dcr', redirectUri: busy.redirectUri }, fetch, openExternal: browser().open })
    busy.close()
    expect(r2.config.clientId).toBe('dcr-client')
    expect(calls.some((c) => c.url === `${AS}/register`)).toBe(true)
  })

  it('needs a client id when there is no DCR and none stored', async () => {
    const routes = flowRoutes(okToken)
    routes[`GET ${AS}/.well-known/oauth-authorization-server`] = () => json({ ...ASMETA, registration_endpoint: undefined })
    const { fetch } = fakeFetch(routes)
    const opener = vi.fn()
    const err = await runAuthorization({ url: MCP, fetch, openExternal: opener }).catch((e) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect(err.needsClientId).toBe(true)
    expect(err.message).toBe(NEEDS_CLIENT_ID_MESSAGE)
    expect(opener).not.toHaveBeenCalled()
  })

  it('refuses when S256 is not advertised, but proceeds when the field is absent', async () => {
    let { fetch } = fakeFetch(flowRoutes(okToken, { [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json({ ...ASMETA, code_challenge_methods_supported: ['plain'] }) }))
    await expect(runAuthorization({ url: MCP, fetch, openExternal: browser().open })).rejects.toMatchObject({
      step: 'authorization',
      message: expect.stringContaining('S256')
    })
    ;({ fetch } = fakeFetch(flowRoutes(okToken, { [`GET ${AS}/.well-known/oauth-authorization-server`]: () => json({ ...ASMETA, code_challenge_methods_supported: undefined }) })))
    await expect(runAuthorization({ url: MCP, fetch, openExternal: browser().open })).resolves.toBeTruthy()
  })

  it('fails on a state mismatch and closes the listener', async () => {
    const { fetch } = fakeFetch(flowRoutes(okToken))
    let created: LoopbackServer | undefined
    const closeSpy = vi.fn()
    const listen = async (o: { port?: number }): Promise<LoopbackServer> => {
      const real = await startLoopback(o)
      created = { ...real, close: () => (closeSpy(), real.close()) }
      return created
    }
    await expect(runAuthorization({ url: MCP, fetch, listen, openExternal: browser({ state: () => 'forged' }).open })).rejects.toMatchObject({ step: 'callback' })
    expect(closeSpy).toHaveBeenCalled()
  })

  it('can be cancelled', async () => {
    const { fetch } = fakeFetch(flowRoutes(okToken))
    const ac = new AbortController()
    const p = runAuthorization({ url: MCP, fetch, signal: ac.signal, openExternal: async () => ac.abort() })
    await expect(p).rejects.toMatchObject({ message: 'Authorization was cancelled.' })
  })

  it('never leaks tokens, codes or secrets in errors, even when the token endpoint echoes them', async () => {
    const echo: Handler = (_u, init) =>
      new Response(`bad request: ${String(init?.body)} {"access_token":"AT-secret","client_secret":"CS-secret"}`, { status: 400 })
    const { fetch } = fakeFetch(flowRoutes(echo))
    const err = (await runAuthorization({ url: MCP, clientId: 'app', clientSecret: 'CS-secret', fetch, openExternal: browser({ code: 'CODE-secret' }).open }).catch((e) => e)) as Error
    expect(err).toBeInstanceOf(OAuthError)
    for (const leak of ['CS-secret', 'AT-secret', 'CODE-secret']) expect(err.message).not.toContain(leak)
    expect(err.message).not.toMatch(/code_verifier=[A-Za-z0-9_-]{20}/)
    expect(err.message.length).toBeLessThan(400)
  })

  it('reports a failing opener', async () => {
    const { fetch } = fakeFetch(flowRoutes(okToken))
    await expect(
      runAuthorization({
        url: MCP,
        fetch,
        openExternal: async () => {
          throw new Error('no browser')
        }
      })
    ).rejects.toMatchObject({ step: 'authorization' })
  })
})

describe('authStatusFrom', () => {
  it('maps states', () => {
    expect(authStatusFrom(undefined, { accessToken: false, refreshToken: false }, 0)).toEqual({ state: 'notRequired' })
    expect(authStatusFrom({}, { accessToken: false, refreshToken: false }, 0)).toEqual({ state: 'notAuthorized' })
    expect(authStatusFrom({ expiresAt: '2020-01-01T00:00:00Z' }, { accessToken: true, refreshToken: false }, Date.now()).state).toBe('expired')
    expect(authStatusFrom({ expiresAt: '2020-01-01T00:00:00Z' }, { accessToken: true, refreshToken: true }, Date.now()).state).toBe('authorized')
  })
})
