import { describe, expect, it, vi } from 'vitest'
import type { ConnectorAuth, McpLibraryInfo } from '@shared/types'
import { CONNECTORS, CONNECTOR_REDIRECT_PORT, connectorById, connectorVariant } from '@shared/connectors'
import { buildConnectorEntry, connectorEntryName, connectorState, mockConnectorTest, oauthPresetFor, tokenHeaderValue } from './connectors'
import { validateLibraryEntry } from './validate'
import { OAuthError, buildAuthorizeUrl, discoverWithPreset, refreshTokens, runAuthorization, startLoopback, type FetchLike, type LoopbackServer } from './oauth'

const NOW = new Date('2026-10-01T00:00:00.000Z')

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function recordingFetch(handler: (url: string, init?: RequestInit) => Response | undefined): { fetch: FetchLike; calls: { url: string; body?: string }[] } {
  const calls: { url: string; body?: string }[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
    return handler(url, init) ?? new Response('nope', { status: 404 })
  }) as FetchLike
  return { fetch: f, calls }
}

describe('buildConnectorEntry', () => {
  it('every preset variant builds a library entry that passes validate.ts', () => {
    for (const def of CONNECTORS) {
      for (const v of def.variants) {
        const e = buildConnectorEntry(def, v, `mcpl_${def.id}_${v.id}`.replace(/[^A-Za-z0-9_-]/g, '_'), [], NOW)
        expect(validateLibraryEntry(e), `${def.id}/${v.id}`).toEqual([])
        expect(e).toMatchObject({ name: def.id, transport: v.transport, url: v.url, connectorId: def.id, connectorVariant: v.id, source: 'user' })
        expect(e.oauth).toBeUndefined()
        if (v.auth.kind === 'token') expect(e.secretHeaders).toEqual([v.auth.header])
        else expect(e.secretHeaders).toBeUndefined()
      }
    }
  })

  it('picks a free name when a custom entry already holds the id', () => {
    const def = connectorById('github')!
    expect(connectorEntryName(def, ['github'])).toBe('github-2')
    expect(connectorEntryName(def, ['github', 'github-2'])).toBe('github-3')
    expect(() => connectorEntryName(def, ['github', ...Array.from({ length: 8 }, (_, i) => `github-${i + 2}`)])).toThrow(/already has entries/)
  })
})

describe('oauthPresetFor', () => {
  it('Google: fixed endpoints, read-only scopes, offline access, no resource, fixed redirect port', () => {
    const p = oauthPresetFor({ connectorId: 'gmail', connectorVariant: 'readonly' })!
    expect(p).toMatchObject({
      issuer: 'https://accounts.google.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      endpointsMode: 'replace',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
      sendResource: false,
      redirectPort: CONNECTOR_REDIRECT_PORT
    })
  })

  it('Slack: fallback endpoints and the authed_user token shape', () => {
    expect(oauthPresetFor({ connectorId: 'slack' })).toMatchObject({ endpointsMode: 'fallback', tokenResponse: 'slackUser', redirectPort: CONNECTOR_REDIRECT_PORT })
  })

  it('DCR connectors keep the plain flow (no fixed port); token connectors, unknown ids and plain entries get none', () => {
    expect(oauthPresetFor({ connectorId: 'notion' })).toEqual({})
    expect(oauthPresetFor({ connectorId: 'github' })).toBeUndefined()
    expect(oauthPresetFor({ connectorId: 'stripe', connectorVariant: 'key' })).toBeUndefined()
    expect(oauthPresetFor({ connectorId: 'nope' })).toBeUndefined()
    expect(oauthPresetFor({})).toBeUndefined()
  })
})

describe('tokenHeaderValue', () => {
  const auth = connectorVariant(connectorById('github')!).auth as Extract<ConnectorAuth, { kind: 'token' }>
  it('adds the prefix once, trims, refuses multi-line and empty values', () => {
    expect(tokenHeaderValue(auth, '  ghp_abc  ')).toBe('Bearer ghp_abc')
    expect(tokenHeaderValue(auth, 'bearer ghp_abc')).toBe('Bearer ghp_abc')
    expect(() => tokenHeaderValue(auth, 'a\nb')).toThrow(/single line/)
    expect(() => tokenHeaderValue(auth, '   ')).toThrow(/Enter/)
  })

  it('accepts printable ASCII with internal spaces only', () => {
    expect(tokenHeaderValue(auth, 'ghp_a-b.c~d+e/f=')).toBe('Bearer ghp_a-b.c~d+e/f=')
    expect(tokenHeaderValue(auth, 'tok with space')).toBe('Bearer tok with space')
    for (const bad of ['tokén', 'tok​x', 'tok x', 'tok\u{1F600}']) {
      expect(() => tokenHeaderValue(auth, bad), JSON.stringify(bad)).toThrow(/printable ASCII/)
    }
  })
})

describe('connectorState and the mock test', () => {
  const info = (over: Partial<McpLibraryInfo> = {}): McpLibraryInfo =>
    ({ entry: {} as McpLibraryInfo['entry'], envSet: [], headersSet: [], missingSecrets: [], auth: { state: 'notAuthorized' }, usedBy: [], ...over }) as McpLibraryInfo
  const gmail = connectorById('gmail')!
  const gv = connectorVariant(gmail)
  const github = connectorById('github')!
  const hv = connectorVariant(github)

  it('maps auth and secrets to a card state', () => {
    expect(connectorState(gv, undefined)).toBe('available')
    expect(connectorState(gv, info())).toBe('needsSetup')
    expect(connectorState(gv, info({ auth: { state: 'authorized' } }))).toBe('connected')
    expect(connectorState(gv, info({ auth: { state: 'error', error: 'x' } }))).toBe('error')
    expect(connectorState(hv, info({ auth: { state: 'notRequired' }, missingSecrets: ['Authorization'] }))).toBe('needsSetup')
    expect(connectorState(hv, info({ auth: { state: 'notRequired' } }))).toBe('connected')
  })

  it('mock test lists fake tools only when connected', () => {
    expect(mockConnectorTest(gmail, gv, info())).toMatchObject({ ok: false, needsAuthorization: true })
    expect(mockConnectorTest(github, hv, info({ missingSecrets: ['Authorization'] }))).toMatchObject({ ok: false })
    const ok = mockConnectorTest(gmail, gv, info({ auth: { state: 'authorized' } }))
    expect(ok.ok).toBe(true)
    expect(ok.tools).toContain('search_threads')
  })

  it("auth kind 'none': no OAuth preset, no secret slot, connected once added, mock tools by category", () => {
    const deepwiki = connectorById('deepwiki')!
    const dv = connectorVariant(deepwiki)
    expect(oauthPresetFor({ connectorId: 'deepwiki' })).toBeUndefined()
    const entry = buildConnectorEntry(deepwiki, dv, 'mcpl_dw', [], NOW)
    expect(entry.secretHeaders).toBeUndefined()
    expect(entry.oauth).toBeUndefined()
    expect(validateLibraryEntry(entry, [])).toEqual([])
    expect(connectorState(dv, undefined)).toBe('available')
    expect(connectorState(dv, info({ auth: { state: 'notRequired' } }))).toBe('connected')
    expect(mockConnectorTest(deepwiki, dv, info({ auth: { state: 'notRequired' } }))).toMatchObject({ ok: true, tools: ['search', 'read_page', 'ask_question'] })
  })

  it('every catalog entry builds a valid library entry for every variant', () => {
    for (const def of CONNECTORS) {
      for (const v of def.variants) {
        const entry = buildConnectorEntry(def, v, `mcpl_${def.id}`, [], NOW)
        expect(validateLibraryEntry(entry, []), `${def.id}/${v.id}`).toEqual([])
      }
    }
  })
})

describe('OAuth presets in oauth.ts', () => {
  const MCP = 'https://gmailmcp.googleapis.com/mcp/v1'
  const google = oauthPresetFor({ connectorId: 'gmail' })!

  it("'replace' skips discovery entirely and applies the preset scopes", async () => {
    const { fetch, calls } = recordingFetch(() => undefined)
    const d = await discoverWithPreset(MCP, fetch, google)
    expect(calls).toEqual([])
    expect(d).toEqual({
      resource: MCP,
      authorizationServer: 'https://accounts.google.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly']
    })
  })

  it("'fallback' uses the preset only when discovery fails", async () => {
    const preset = oauthPresetFor({ connectorId: 'slack' })!
    const failing = recordingFetch(() => undefined)
    const d = await discoverWithPreset('https://mcp.slack.com/mcp', failing.fetch, preset)
    expect(failing.calls.length).toBeGreaterThan(0)
    expect(d.authorizationEndpoint).toBe('https://slack.com/oauth/v2_user/authorize')
    expect(d.authorizationServer).toBe('https://slack.com')

    const AS = 'https://auth.slack.example'
    const working = recordingFetch((url) => {
      if (url === 'https://mcp.slack.com/.well-known/oauth-protected-resource/mcp') return json({ resource: 'https://mcp.slack.com/mcp', authorization_servers: [AS] })
      if (url === `${AS}/.well-known/oauth-authorization-server`) return json({ issuer: AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token` })
      return undefined
    })
    // A discovered server off slack.com would receive the client secret: the preset's endpoints win.
    const offDomain = await discoverWithPreset('https://mcp.slack.com/mcp', working.fetch, preset)
    expect(offDomain.authorizationEndpoint).toBe('https://slack.com/oauth/v2_user/authorize')
    expect(offDomain.tokenEndpoint).toBe('https://slack.com/api/oauth.v2.user.access')
  })

  it("'fallback' keeps discovered endpoints on the preset's registrable domain only", async () => {
    const preset = oauthPresetFor({ connectorId: 'slack' })!
    const routes = (as: string, tokenEndpoint: string, authorizationEndpoint = `${as}/authorize`): FetchLike =>
      recordingFetch((url) => {
        if (url === 'https://mcp.slack.com/.well-known/oauth-protected-resource/mcp') return json({ resource: 'https://mcp.slack.com/mcp', authorization_servers: [as] })
        if (url === `${as}/.well-known/oauth-authorization-server`) return json({ issuer: as, authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint })
        return undefined
      }).fetch
    const sub = await discoverWithPreset('https://mcp.slack.com/mcp', routes('https://auth.slack.com', 'https://api.slack.com/token'), preset)
    expect(sub).toMatchObject({ authorizationEndpoint: 'https://auth.slack.com/authorize', tokenEndpoint: 'https://api.slack.com/token' })
    const same = await discoverWithPreset('https://mcp.slack.com/mcp', routes('https://slack.com', 'https://slack.com/t'), preset)
    expect(same.tokenEndpoint).toBe('https://slack.com/t')
    const bad: [string, string?][] = [
      ['https://evil.example/token'],
      ['https://slack.com.evil.example/token'],
      ['https://evilslack.com/token'],
      ['https://slack.com/token', 'https://evil.example/authorize']
    ]
    for (const [token, authz] of bad) {
      const d = await discoverWithPreset('https://mcp.slack.com/mcp', routes('https://slack.com', token, authz), preset)
      expect(d.tokenEndpoint, token).toBe('https://slack.com/api/oauth.v2.user.access')
      expect(d.authorizationEndpoint, token).toBe('https://slack.com/oauth/v2_user/authorize')
    }
  })

  it('refuses preset endpoints that are not https or are private', async () => {
    const { fetch } = recordingFetch(() => undefined)
    for (const bad of ['http://accounts.example.com/auth', 'https://127.0.0.1/auth', 'https://10.0.0.1/auth']) {
      const err = await discoverWithPreset(MCP, fetch, { ...google, authorizationEndpoint: bad }).catch((e) => e)
      expect(err, bad).toBeInstanceOf(OAuthError)
    }
  })

  it('extra params never override reserved ones; resource is omitted when the preset says so', () => {
    const url = new URL(
      buildAuthorizeUrl(
        { resource: MCP, authorizationServer: 'https://a', authorizationEndpoint: 'https://a.example/auth', tokenEndpoint: 'https://a.example/token' },
        { clientId: 'cid', source: 'manual' },
        { redirectUri: 'http://127.0.0.1:1/callback', state: 'st', challenge: 'ch', extraParams: { access_type: 'offline', state: 'evil', Redirect_URI: 'https://evil', resource: 'x' }, sendResource: false }
      )
    )
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1/callback')
    expect(url.searchParams.has('Redirect_URI')).toBe(false)
    expect(url.searchParams.has('resource')).toBe(false)
  })

  it('runs the whole flow on the fixed port with a manual client, no resource, Google parameters', async () => {
    const { fetch, calls } = recordingFetch((url) =>
      url === 'https://oauth2.googleapis.com/token' ? json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }) : undefined
    )
    const listenOpts: unknown[] = []
    let authUrl: URL | undefined
    const listen = async (opts: { port?: number; strict?: boolean }): Promise<LoopbackServer> => {
      listenOpts.push(opts)
      return { redirectUri: `http://127.0.0.1:${opts.port}/callback`, close: () => {}, waitForCode: async () => ({ code: 'CODE' }) }
    }
    const r = await runAuthorization({
      url: MCP,
      clientId: 'gcp-client',
      clientSecret: 'gcp-secret',
      fetch,
      openExternal: async (u) => void (authUrl = new URL(u)),
      listen,
      preset: google
    })
    expect(listenOpts).toEqual([{ port: CONNECTOR_REDIRECT_PORT, strict: true }])
    expect(authUrl!.origin + authUrl!.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(authUrl!.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${CONNECTOR_REDIRECT_PORT}/callback`)
    expect(authUrl!.searchParams.get('access_type')).toBe('offline')
    expect(authUrl!.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly')
    expect(authUrl!.searchParams.has('resource')).toBe(false)
    const form = new URLSearchParams(calls.find((c) => c.url === 'https://oauth2.googleapis.com/token')!.body)
    expect(form.has('resource')).toBe(false)
    expect(form.get('client_secret')).toBe('gcp-secret')
    expect(r.config).toMatchObject({ resource: MCP, authorizationServer: 'https://accounts.google.com', clientId: 'gcp-client', clientSource: 'manual' })
    expect(r.tokens.accessToken).toBe('AT')
  })

  it('reads a Slack user token from authed_user', async () => {
    const { fetch } = recordingFetch((url) =>
      url === 'https://slack.com/api/oauth.v2.user.access' ? json({ ok: true, authed_user: { id: 'U1', access_token: 'xoxp-1', refresh_token: 'xoxe-1', expires_in: 43200 } }) : undefined
    )
    const r = await runAuthorization({
      url: 'https://mcp.slack.com/mcp',
      clientId: 'slack-client',
      clientSecret: 's',
      fetch,
      openExternal: async () => {},
      listen: async (o) => ({ redirectUri: `http://127.0.0.1:${o.port}/callback`, close: () => {}, waitForCode: async () => ({ code: 'C' }) }),
      preset: oauthPresetFor({ connectorId: 'slack' })
    })
    expect(r.tokens).toMatchObject({ accessToken: 'xoxp-1', refreshToken: 'xoxe-1' })
  })

  it('refresh omits resource when asked', async () => {
    const { fetch, calls } = recordingFetch(() => json({ access_token: 'AT2', expires_in: 60 }))
    await refreshTokens({ tokenEndpoint: 'https://oauth2.googleapis.com/token', resource: MCP, clientId: 'c' }, { refreshToken: 'RT', sendResource: false }, fetch)
    expect(new URLSearchParams(calls[0].body).has('resource')).toBe(false)
    await refreshTokens({ tokenEndpoint: 'https://oauth2.googleapis.com/token', resource: MCP, clientId: 'c' }, { refreshToken: 'RT' }, fetch)
    expect(new URLSearchParams(calls[1].body).get('resource')).toBe(MCP)
  })

  it('a strict loopback fails clearly when the port is busy instead of moving to another port', async () => {
    const busy = await startLoopback()
    const port = Number(new URL(busy.redirectUri).port)
    try {
      const err = await startLoopback({ port, strict: true }).catch((e) => e)
      expect(err).toBeInstanceOf(OAuthError)
      expect(err.message).toContain(`127.0.0.1:${port}`)
    } finally {
      busy.close()
    }
  })

  it('a strict loopback takes the port once a just-closed listener releases it', async () => {
    const first = await startLoopback()
    const port = Number(new URL(first.redirectUri).port)
    first.close()
    const again = await startLoopback({ port, strict: true })
    try {
      expect(again.redirectUri).toBe(`http://127.0.0.1:${port}/callback`)
    } finally {
      again.close()
    }
  })

  it('never opens the browser when the fixed port is busy', async () => {
    const opener = vi.fn()
    const err = await runAuthorization({
      url: MCP,
      clientId: 'c',
      fetch: recordingFetch(() => undefined).fetch,
      openExternal: opener,
      listen: async () => {
        throw new OAuthError('authorization', 'busy')
      },
      preset: google
    }).catch((e) => e)
    expect(err).toBeInstanceOf(OAuthError)
    expect(opener).not.toHaveBeenCalled()
  })
})
