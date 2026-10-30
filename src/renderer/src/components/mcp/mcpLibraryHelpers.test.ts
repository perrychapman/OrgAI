import { describe, expect, it } from 'vitest'
import type { McpServerInfo, McpServerSpec } from '@shared/types'
import type { ConnectorInfo } from '@shared/types'
import { authTarget, authWarning, emptyKind, linkedServerFor, relativeTime, setUpConnectors, splitConnectorServers, transportWords, useInProjectBlocker } from './mcpLibraryHelpers'

type Over = Omit<Partial<McpServerInfo>, 'spec'> & { spec?: Partial<McpServerSpec> }
const info = (over: Over = {}): McpServerInfo => ({
  spec: { id: 'a', name: 'github', transport: 'http', url: 'https://x', enabled: true, source: 'user', addedAt: '', ...over.spec },
  envSet: [],
  headersSet: [],
  missingSecrets: [],
  auth: over.auth ?? { state: 'notAuthorized' }
})

describe('mcpLibraryHelpers', () => {
  it('words transports plainly', () => {
    expect(transportWords('stdio')).toBe('Runs on this machine')
    expect(transportWords('sse')).toBe('Remote server')
  })
  it('formats relative times', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(relativeTime('2026-01-04T00:00:00Z', now)).toBe('in 3 days')
    expect(relativeTime('2025-12-31T22:00:00Z', now)).toBe('2 hours ago')
    expect(relativeTime('nope', now)).toBeUndefined()
  })
  it('targets the library entry for linked servers', () => {
    expect(authTarget('p', info({ spec: { libraryId: 'lib' } }).spec)).toEqual({ libraryId: 'lib' })
    expect(authTarget('p', info({}).spec)).toEqual({ projectId: 'p', serverId: 'a' })
  })
  it('warns only for enabled remote servers needing sign-in', () => {
    expect(authWarning([info({}), info({ spec: { enabled: false } }), info({ spec: { transport: 'stdio' } }), info({ auth: { state: 'authorized' } })])).toHaveLength(1)
    expect(authWarning([info({ auth: { state: 'expired' } })])[0].expired).toBe(true)
  })
  describe('connectors', () => {
    const conn = (id: string, state: ConnectorInfo['state'], entryId?: string): ConnectorInfo =>
      ({ connector: { id }, state, library: entryId ? { entry: { id: entryId } } : undefined }) as unknown as ConnectorInfo
    it('finds the linked server and splits rows', () => {
      const a = info({ spec: { id: 's1', libraryId: 'L1', connectorId: 'slack' } })
      const b = info({ spec: { id: 's2', libraryId: 'L2', connectorId: 'gone' } })
      const c = info({ spec: { id: 's3', libraryId: 'L3' } })
      const cs = [conn('slack', 'connected', 'L1'), conn('gmail', 'available')]
      expect(linkedServerFor(cs[0], [a, b, c])?.spec.id).toBe('s1')
      expect(linkedServerFor(cs[1], [a])).toBeUndefined()
      const { connector, rest } = splitConnectorServers([a, b, c], cs)
      expect(connector.map((s) => s.spec.id)).toEqual(['s1'])
      expect(rest.map((s) => s.spec.id)).toEqual(['s2', 's3'])
    })
    it('lists set-up connectors and picks the empty state', () => {
      const cs = [conn('a', 'available'), conn('b', 'needsSetup', 'L'), conn('c', 'connected', 'M')]
      expect(setUpConnectors(cs).map((c) => c.connector.id)).toEqual(['b', 'c'])
      expect(emptyKind(cs)).toBe('use')
      expect(emptyKind([conn('b', 'needsSetup', 'L')])).toBe('none')
      expect(emptyKind(null)).toBe('none')
    })
    it('needs a role before Use in this project', () => {
      expect(useInProjectBlocker(3, [])).toMatch(/at least one role/)
      expect(useInProjectBlocker(3, ['x'])).toBeNull()
      expect(useInProjectBlocker(0, [])).toBeNull()
    })
  })
})
