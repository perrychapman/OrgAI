import { describe, expect, it } from 'vitest'
import {
  CONNECTORS,
  CONNECTOR_REDIRECT_PORT,
  CONNECTOR_REDIRECT_URI,
  EASE_ORDER,
  RESERVED_AUTH_PARAMS,
  connectorById,
  connectorEase,
  connectorMatches,
  connectorVariant,
  easeRank
} from './connectors'
import { CONNECTOR_CATEGORIES } from './types'
import type { ConnectorDef } from './types'
import { isValidMcpServerName } from './defaults'

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/

function httpsPublic(url: string | undefined): boolean {
  if (!url) return false
  const u = new URL(url)
  return u.protocol === 'https:' && !PRIVATE.test(u.hostname) && !u.username && !u.password && !u.hash
}

describe('connector catalog', () => {
  it('has unique kebab-case ids that are valid MCP server names', () => {
    const ids = CONNECTORS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(isValidMcpServerName(id), id).toBe(true)
  })

  it('every def is complete, unverified and structured-clone safe', () => {
    for (const c of CONNECTORS) {
      expect(c.name.trim(), c.id).not.toBe('')
      expect(c.description.trim(), c.id).not.toBe('')
      expect(c.publisher).toBe('official')
      expect(['preview', 'stable']).toContain(c.status)
      expect(c.verified, c.id).toBe(false)
      expect(httpsPublic(c.docsUrl), c.docsUrl).toBe(true)
      expect(c.setup.length, c.id).toBeGreaterThan(0)
      expect(structuredClone(c)).toEqual(c)
      expect(JSON.parse(JSON.stringify(c))).toEqual(c)
    }
  })

  it('variants: unique ids, a valid default, https public URLs only', () => {
    for (const c of CONNECTORS) {
      const ids = c.variants.map((v) => v.id)
      expect(ids.length, c.id).toBeGreaterThan(0)
      expect(new Set(ids).size, c.id).toBe(ids.length)
      expect(ids, c.id).toContain(c.defaultVariant)
      for (const v of c.variants) {
        expect(['http', 'sse']).toContain(v.transport)
        expect(httpsPublic(v.url), `${c.id}/${v.id}`).toBe(true)
        expect(typeof v.readOnly).toBe('boolean')
      }
    }
  })

  it('auth: override endpoints are https and public, extra params never touch reserved ones', () => {
    for (const c of CONNECTORS) {
      for (const v of c.variants) {
        const a = v.auth
        if (a.kind === 'token') {
          expect(a.header).toMatch(/^[A-Za-z0-9-]+$/)
          expect(a.label.trim()).not.toBe('')
          expect(a.help.trim()).not.toBe('')
          if (a.link) expect(httpsPublic(a.link)).toBe(true)
          continue
        }
        if (a.kind === 'none') {
          expect(Object.keys(a), `${c.id}/${v.id}`).toEqual(['kind'])
          continue
        }
        const o = a.overrides ?? {}
        for (const url of [o.issuer, o.authorizationEndpoint, o.tokenEndpoint]) if (url !== undefined) expect(httpsPublic(url), url).toBe(true)
        // Endpoints come in pairs: a single one could not be used.
        expect(!!o.authorizationEndpoint, `${c.id}/${v.id}`).toBe(!!o.tokenEndpoint)
        for (const k of Object.keys(o.extraAuthParams ?? {})) expect(RESERVED_AUTH_PARAMS).not.toContain(k.toLowerCase())
        if (a.kind === 'oauthClient') {
          expect(httpsPublic(a.consoleUrl)).toBe(true)
          expect(c.setup.join('\n'), c.id).toContain(CONNECTOR_REDIRECT_URI)
        }
      }
    }
  })

  it('the fixed redirect is a loopback URI on the fixed port', () => {
    expect(CONNECTOR_REDIRECT_URI).toBe(`http://127.0.0.1:${CONNECTOR_REDIRECT_PORT}/callback`)
    expect(CONNECTOR_REDIRECT_PORT).toBeGreaterThan(1024)
    expect(CONNECTOR_REDIRECT_PORT).toBeLessThan(49152)
  })

  it('includes the researched presets with their URLs', () => {
    const url = (id: string, variant?: string): string => connectorVariant(connectorById(id)!, variant).url
    expect(url('gmail')).toBe('https://gmailmcp.googleapis.com/mcp/v1')
    expect(url('google-calendar')).toBe('https://calendarmcp.googleapis.com/mcp/v1')
    expect(url('google-drive')).toBe('https://drivemcp.googleapis.com/mcp/v1')
    expect(url('slack')).toBe('https://mcp.slack.com/mcp')
    expect(url('linear')).toBe('https://mcp.linear.app/mcp/readonly')
    expect(url('linear', 'full')).toBe('https://mcp.linear.app/mcp')
    expect(url('github')).toBe('https://api.githubcopilot.com/mcp/')
    expect(connectorVariant(connectorById('github')!).headers).toEqual({ 'X-MCP-Readonly': 'true' })
    expect(url('atlassian')).toBe('https://mcp.atlassian.com/v2/mcp')
  })

  it('connectorById and connectorVariant fall back safely', () => {
    expect(connectorById('nope')).toBeUndefined()
    expect(connectorById(42 as unknown as string)).toBeUndefined()
    const linear = connectorById('linear')!
    expect(connectorVariant(linear, 'bogus').id).toBe('readonly')
    expect(connectorVariant(linear).id).toBe('readonly')
  })

  it('every category is in the union and every def has lowercase, non-empty, unique aliases', () => {
    for (const c of CONNECTORS) {
      expect(CONNECTOR_CATEGORIES, c.id).toContain(c.category)
      expect(c.aliases?.length, c.id).toBeGreaterThan(0)
      const aliases = c.aliases ?? []
      expect(new Set(aliases).size, c.id).toBe(aliases.length)
      for (const a of aliases) {
        expect(a.trim(), c.id).toBe(a)
        expect(a, c.id).not.toBe('')
        expect(a, c.id).toBe(a.toLowerCase())
      }
    }
  })

  it('every variant has a unique url+headers+auth within its connector', () => {
    for (const c of CONNECTORS) {
      const keys = c.variants.map((v) => JSON.stringify([v.url, v.headers ?? {}, v.auth.kind]))
      expect(new Set(keys).size, c.id).toBe(keys.length)
    }
  })

  it('the default variant is the easiest one', () => {
    for (const c of CONNECTORS) {
      const best = Math.min(...c.variants.map((v) => easeRank(connectorEase(c, v.id))))
      expect(easeRank(connectorEase(c)), c.id).toBe(best)
    }
    expect(connectorById('stripe')!.defaultVariant).toBe('oauth')
    expect(connectorById('exa')!.defaultVariant).toBe('free')
    expect(connectorById('cloudflare')!.defaultVariant).toBe('oauth')
  })

  it('includes the 2026-10-31 entries with their documented URLs', () => {
    const url = (id: string, variant?: string): string => connectorVariant(connectorById(id)!, variant).url
    expect(url('intercom')).toBe('https://mcp.intercom.com/mcp')
    expect(url('intercom', 'eu')).toBe('https://mcp.eu.intercom.com/mcp')
    expect(url('supabase')).toBe('https://mcp.supabase.com/mcp?read_only=true')
    expect(url('supabase', 'full')).toBe('https://mcp.supabase.com/mcp')
    expect(url('deepwiki')).toBe('https://mcp.deepwiki.com/mcp')
    expect(url('exa')).toBe('https://mcp.exa.ai/mcp')
    expect(connectorVariant(connectorById('exa')!, 'key').auth).toMatchObject({ kind: 'token', header: 'x-api-key' })
    expect(url('cloudflare')).toBe('https://mcp.cloudflare.com/mcp')
    expect(url('datadog')).toBe('https://mcp.datadoghq.com/v1/mcp')
    expect(url('datadog', 'eu1')).toBe('https://mcp.datadoghq.eu/v1/mcp')
    expect(url('vercel')).toBe('https://mcp.vercel.com')
    expect(url('asana')).toBe('https://mcp.asana.com/v2/mcp')
    expect(url('hubspot')).toBe('https://mcp.hubspot.com')
    expect(url('box')).toBe('https://mcp.box.com')
    expect(url('paypal')).toBe('https://mcp.paypal.com/http')
    expect(url('paypal', 'sandbox')).toBe('https://mcp.sandbox.paypal.com/http')
    for (const id of ['google-docs', 'google-sheets', 'google-slides', 'google-chat']) {
      const v = connectorVariant(connectorById(id)!)
      expect(v.auth.kind, id).toBe('oauthClient')
      expect(v.readOnly, id).toBe(true)
      if (v.auth.kind === 'oauthClient') for (const s of v.auth.scopes ?? []) expect(s, id).toMatch(/readonly$/)
    }
    expect(connectorById('google-people')).toBeUndefined()
  })

  it('includes the second-wave entries with their URLs, categories and easiest defaults', () => {
    const url = (id: string, variant?: string): string => connectorVariant(connectorById(id)!, variant).url
    const expected: Record<string, [string, ConnectorDef['category'], string]> = {
      'microsoft-learn': ['https://learn.microsoft.com/api/mcp', 'knowledge', 'none'],
      'aws-knowledge': ['https://knowledge-mcp.global.api.aws', 'knowledge', 'none'],
      context7: ['https://mcp.context7.com/mcp', 'knowledge', 'none'],
      granola: ['https://mcp.granola.ai/mcp', 'meetings', 'signIn'],
      neon: ['https://mcp.neon.tech/mcp?readonly=true', 'cloud', 'signIn'],
      amplitude: ['https://mcp.amplitude.com/mcp', 'data', 'signIn'],
      posthog: ['https://mcp.posthog.com/mcp', 'data', 'signIn'],
      webflow: ['https://mcp.webflow.com/mcp', 'design', 'signIn'],
      miro: ['https://mcp.miro.com/', 'design', 'signIn'],
      zoom: ['https://zoom.us/mcp/meeting/streamable', 'meetings', 'ownApp'],
      zapier: ['https://mcp.zapier.com/api/v1/connect', 'automation', 'token'],
      gitlab: ['https://gitlab.com/api/v4/mcp', 'dev', 'signIn']
    }
    for (const [id, [u, category, ease]] of Object.entries(expected)) {
      const def = connectorById(id)
      expect(def, id).toBeDefined()
      expect(url(id), id).toBe(u)
      expect(def!.category, id).toBe(category)
      expect(connectorEase(def!), id).toBe(ease)
    }
    expect(url('neon', 'full')).toBe('https://mcp.neon.tech/mcp')
    expect(connectorEase(connectorById('neon')!, 'key')).toBe('token')
    expect(url('amplitude', 'eu')).toBe('https://mcp.eu.amplitude.com/mcp')
    // Context7 answers without a key: the keyless variant is the default, the key one sends a Bearer header.
    const c7 = connectorById('context7')!
    expect(c7.defaultVariant).toBe('free')
    expect(connectorVariant(c7).auth).toEqual({ kind: 'none' })
    expect(connectorVariant(c7, 'key').auth).toMatchObject({ kind: 'token', header: 'Authorization', prefix: 'Bearer ' })
    expect(connectorVariant(connectorById('zapier')!).auth).toMatchObject({ kind: 'token', header: 'Authorization', prefix: 'Bearer ' })
    expect(connectorMatches(connectorById('microsoft-learn')!, 'azure docs')).toBe(true)
    expect(connectorMatches(c7, 'upstash')).toBe(true)
  })

  it('every oauthClient preset names its issuer, and Google hosts carry no inferred-host note', () => {
    for (const c of CONNECTORS) {
      for (const v of c.variants) if (v.auth.kind === 'oauthClient') expect(v.auth.overrides?.issuer, `${c.id}/${v.id}`).toBeTruthy()
    }
    const issuer = (id: string): string | undefined => {
      const a = connectorVariant(connectorById(id)!).auth
      return a.kind === 'oauthClient' ? a.overrides?.issuer : undefined
    }
    expect(issuer('asana')).toBe('https://app.asana.com')
    expect(issuer('hubspot')).toBe('https://mcp.hubspot.com')
    expect(issuer('box')).toBe('https://api.box.com')
    expect(issuer('zoom')).toBe('https://zoom.us')
    for (const c of CONNECTORS.filter((d) => d.vendor === 'Google')) expect(JSON.stringify(c.notes), c.id).not.toContain('follows the pattern')
    expect(JSON.stringify(connectorById('datadog'))).not.toContain('inferred')
  })

  it('Google setup names the AI-agent client box and the Developer Preview Program', () => {
    for (const c of CONNECTORS.filter((d) => d.vendor === 'Google')) {
      const text = c.setup.join(' ')
      expect(text, c.id).toContain('Use this client for an AI-powered agent')
      expect(text, c.id).toContain('Developer Preview Program')
    }
  })

  it('Stripe no longer asks for a full secret key', () => {
    const key = connectorVariant(connectorById('stripe')!, 'key')
    expect(key.label).toBe('Agent API key')
    expect(JSON.stringify(connectorById('stripe'))).toContain('Agent tag')
  })
})

describe('connectorEase', () => {
  const def = (kinds: ConnectorDef['variants'][number]['auth'][]): ConnectorDef => ({
    ...connectorById('linear')!,
    variants: kinds.map((auth, i) => ({ id: `v${i}`, label: `V${i}`, transport: 'http', url: 'https://x.example/mcp', readOnly: true, auth })),
    defaultVariant: 'v0'
  })

  it('maps every auth kind', () => {
    const d = def([
      { kind: 'oauth' },
      { kind: 'none' },
      { kind: 'token', header: 'Authorization', label: 'Key', help: 'h' },
      { kind: 'oauthClient', consoleUrl: 'https://console.example', clientSecret: 'required' }
    ])
    expect(connectorEase(d)).toBe('signIn')
    expect(connectorEase(d, 'v1')).toBe('none')
    expect(connectorEase(d, 'v2')).toBe('token')
    expect(connectorEase(d, 'v3')).toBe('ownApp')
    expect(connectorEase(d, 'missing')).toBe('signIn')
  })

  it('EASE_ORDER ranks no sign-in, one-click sign-in, token, own app', () => {
    expect(EASE_ORDER).toEqual(['none', 'signIn', 'token', 'ownApp'])
    expect(easeRank('none')).toBeLessThan(easeRank('signIn'))
    expect(easeRank('signIn')).toBeLessThan(easeRank('token'))
    expect(easeRank('token')).toBeLessThan(easeRank('ownApp'))
  })

  it('catalog examples', () => {
    expect(connectorEase(connectorById('deepwiki')!)).toBe('none')
    expect(connectorEase(connectorById('linear')!)).toBe('signIn')
    expect(connectorEase(connectorById('github')!)).toBe('token')
    expect(connectorEase(connectorById('gmail')!)).toBe('ownApp')
  })
})

describe('connectorMatches', () => {
  it('matches name, vendor, category and aliases case-insensitively, all words required', () => {
    const gmail = connectorById('gmail')!
    expect(connectorMatches(gmail, '')).toBe(true)
    expect(connectorMatches(gmail, 'GMAIL')).toBe(true)
    expect(connectorMatches(gmail, 'google mail')).toBe(true)
    expect(connectorMatches(gmail, 'inbox')).toBe(true)
    expect(connectorMatches(connectorById('linear')!, 'tickets')).toBe(true)
    expect(connectorMatches(gmail, 'mail tickets')).toBe(false)
    expect(connectorMatches(gmail, 42 as unknown as string)).toBe(true)
  })
})
