import { describe, expect, it } from 'vitest'
import type { ConnectorInfo } from '@shared/types'
import { toolCapabilities, variantOf } from './toolCapabilities'

const base = (over: Partial<ConnectorInfo> = {}, readOnly = true): ConnectorInfo =>
  ({
    connector: {
      id: 'svc',
      name: 'Service',
      vendor: 'V',
      publisher: 'official',
      category: 'dev',
      description: 'd',
      status: 'stable',
      docsUrl: 'https://example.com',
      variants: [
        { id: 'readonly', label: 'Read only', description: 'Read issues and code.', transport: 'http', url: 'https://x', readOnly, auth: { kind: 'none' } },
        { id: 'full', label: 'Full', transport: 'http', url: 'https://y', readOnly: false, auth: { kind: 'none' } }
      ],
      defaultVariant: 'readonly',
      setup: [],
      verified: false
    },
    state: 'available',
    ...over
  }) as unknown as ConnectorInfo

describe('toolCapabilities', () => {
  it('describes a catalog entry as what the team could do', () => {
    const c = toolCapabilities(base())
    expect(c.mode).toBe('could')
    expect(c.can).toEqual(['Read issues and code', 'Read tools only'])
    expect(c.cannot).toEqual(['Use write tools: this connection is set up read-only'])
    expect(c.projects).toEqual([])
  })

  it('uses the added variant, never claims a write limit for a full variant', () => {
    const c = toolCapabilities(base({ state: 'connected', variant: 'full' }))
    expect(variantOf(base({ variant: 'full' }))?.id).toBe('full')
    expect(c.mode).toBe('can')
    expect(c.cannot).toEqual([])
    expect(c.can[0]).toBe("Use Service's tools (Full)")
  })

  it('lists linked projects and the token expiry', () => {
    const lib = { entry: {}, envSet: [], headersSet: [], missingSecrets: [], auth: { state: 'authorized', expiresAt: '2026-11-18T10:00:00Z' }, usedBy: [{ projectId: 'p', projectName: 'Notes API' }] }
    const c = toolCapabilities(base({ state: 'connected', library: lib as never }), Date.parse('2026-11-20T00:00:00Z'), 'en-GB')
    expect(c.projects).toEqual(['Notes API'])
    expect(c.signIn).toBe('The sign-in token expired on 18 Nov 2026.')
    const later = toolCapabilities(base({ state: 'connected', library: lib as never }), Date.parse('2026-11-01T00:00:00Z'), 'en-GB')
    expect(later.signIn).toBe('The current sign-in token expires on 18 Nov 2026.')
  })
})
