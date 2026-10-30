import { describe, expect, it } from 'vitest'
import type { McpServerInfo, McpServerSpec } from '@shared/types'
import { authTarget, authWarning, relativeTime, transportWords } from './mcpLibraryHelpers'

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
})
