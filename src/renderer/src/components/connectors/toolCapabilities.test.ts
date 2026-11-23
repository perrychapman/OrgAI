import { describe, expect, it } from 'vitest'
import type { ConnectorInfo } from '@shared/types'
import { CONNECTORS } from '@shared/connectors'
import { toolCapabilities, toolSummary, variantOf } from './toolCapabilities'

describe('toolSummary', () => {
  it('counts tools by the server annotations, unknown when absent', () => {
    const d = new Map([
      ['a', { readOnly: true }],
      ['b', { destructive: true, readOnly: false }],
      ['c', {}]
    ])
    expect(toolSummary(['a', 'b', 'c', 'd'], d)).toBe('1 read only, 1 can change or delete, 2 not described')
    expect(toolSummary(['a'], d)).toBe('1 read only')
  })
})

const base = (over: Partial<ConnectorInfo> = {}, readOnly = true): ConnectorInfo =>
  ({
    connector: {
      id: 'svc',
      name: 'Service',
      vendor: 'V',
      publisher: 'official',
      category: 'dev',
      description: 'Read issues and code.',
      status: 'stable',
      docsUrl: 'https://example.com',
      variants: [
        { id: 'readonly', label: 'Read only', description: 'app.example.com', transport: 'http', url: 'https://x', readOnly, auth: { kind: 'none' } },
        { id: 'full', label: 'Full', transport: 'http', url: 'https://y', readOnly: false, auth: { kind: 'none' } }
      ],
      defaultVariant: 'readonly',
      setup: [],
      verified: false
    },
    state: 'available',
    ...over
  }) as unknown as ConnectorInfo

const lib = (usedBy: { projectId: string; projectName: string }[], expiresAt?: string): never =>
  ({ entry: {}, envSet: [], headersSet: [], missingSecrets: [], auth: { state: 'authorized', expiresAt }, usedBy }) as never

describe('toolCapabilities', () => {
  it('describes a catalog entry as what the team could do, never a variant host name', () => {
    const c = toolCapabilities(base())
    expect(c.mode).toBe('could')
    expect(c.can).toEqual(['Read issues and code', 'Read tools only (Read only)'])
    expect(c.can.join(' ')).not.toContain('app.example.com')
    expect(c.cannot[0]).toMatch(/the service enforces it/)
    expect(c.projects).toEqual([])
  })

  it('says "can" only when connected and used by a project', () => {
    expect(toolCapabilities(base({ state: 'connected', library: lib([]) })).mode).toBe('could')
    expect(toolCapabilities(base({ state: 'needsSetup', library: lib([{ projectId: 'p', projectName: 'A' }]) })).mode).toBe('could')
    expect(toolCapabilities(base({ state: 'connected', library: lib([{ projectId: 'p', projectName: 'A' }]) })).mode).toBe('can')
  })

  it('uses the added variant and claims no write limit for a full variant', () => {
    const c = toolCapabilities(base({ state: 'connected', variant: 'full' }))
    expect(variantOf(base({ variant: 'full' }))?.id).toBe('full')
    expect(c.cannot).toEqual([])
  })

  it('mentions the token expiry only when the entry needs attention', () => {
    const exp = '2026-11-18T10:00:00Z'
    expect(toolCapabilities(base({ state: 'connected', library: lib([], exp) }), Date.parse('2026-11-20T00:00:00Z')).signIn).toBeUndefined()
    expect(toolCapabilities(base({ state: 'error', library: lib([], exp) }), Date.parse('2026-11-20T00:00:00Z'), 'en-GB').signIn).toBe('The sign-in expired on 18 Nov 2026.')
  })

  it('never shows a bare host name as a capability for any curated connector', () => {
    for (const def of CONNECTORS) {
      const c = toolCapabilities({ connector: def, state: 'available' } as ConnectorInfo)
      for (const line of c.can) expect(line).not.toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/i)
    }
  })
})
