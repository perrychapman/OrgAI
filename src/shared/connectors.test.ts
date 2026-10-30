import { describe, expect, it } from 'vitest'
import { CONNECTORS, CONNECTOR_REDIRECT_PORT, CONNECTOR_REDIRECT_URI, RESERVED_AUTH_PARAMS, connectorById, connectorVariant } from './connectors'
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
})
