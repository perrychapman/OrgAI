import { describe, expect, it } from 'vitest'
import type { ConnectorInfo, McpLibraryInfo, McpServerInfo } from '@shared/types'
import { CONNECTORS } from '@shared/connectors'
import { connectionRow, libraryRows, orderSetupRows, projectServerRows, projectsWithOwnServers, usedByCaption } from './setupGaps'

const used = (...names: string[]): McpLibraryInfo['usedBy'] => names.map((n, i) => ({ projectId: `p${i}`, projectName: n }))

function lib(id: string, over: Record<string, unknown> = {}, rest: Partial<McpLibraryInfo> = {}): McpLibraryInfo {
  return {
    entry: { id, name: id, ...over } as unknown as McpLibraryInfo['entry'],
    envSet: [],
    headersSet: [],
    missingSecrets: [],
    auth: { state: 'notRequired' } as McpLibraryInfo['auth'],
    usedBy: used('Billing API'),
    ...rest
  }
}

const needsAuth = { auth: { state: 'notAuthorized' } as McpLibraryInfo['auth'] }

describe('usedByCaption', () => {
  it('lists up to three names and counts the rest', () => {
    expect(usedByCaption([])).toBe('')
    expect(usedByCaption(['A', 'B'])).toBe('Used by A, B')
    expect(usedByCaption(['A', 'B', 'C'])).toBe('Used by A, B, C')
    expect(usedByCaption(['A', 'B', 'C', 'D', 'E'])).toBe('Used by A, B, C and 2 more')
    expect(usedByCaption(['A', 'A', 'B'])).toBe('Used by A, B')
  })
})

describe('libraryRows', () => {
  it('shows a used service that needs sign in, with the projects using it', () => {
    const rows = libraryRows([lib('github', {}, { ...needsAuth, usedBy: used('Billing API', 'Docs site') })], [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'service', id: 'github', line: 'github · Needs sign in', caption: 'Used by Billing API, Docs site', action: 'Set up', target: { type: 'library', libraryId: 'github' } })
  })

  it('skips a service nobody uses, one that is ready, and one with no sign in to do', () => {
    expect(libraryRows([lib('a', {}, { ...needsAuth, usedBy: [] })], [])).toEqual([])
    expect(libraryRows([lib('b')], [])).toEqual([])
    expect(libraryRows([lib('c', {}, { auth: { state: 'authorized' } as McpLibraryInfo['auth'] })], [])).toEqual([])
  })

  it('counts a missing secret as needing a sign in', () => {
    expect(libraryRows([lib('t', {}, { missingSecrets: ['TOKEN'] })], [])).toHaveLength(1)
  })

  it('names the connector button by how it signs in', () => {
    const oauth = CONNECTORS.find((c) => c.variants.every((v) => v.auth.kind === 'oauth'))
    const token = CONNECTORS.find((c) => c.variants.every((v) => v.auth.kind === 'token'))
    expect(oauth).toBeTruthy()
    expect(token).toBeTruthy()
    const info = (c: NonNullable<typeof oauth>, state: ConnectorInfo['state'] = 'needsSetup'): ConnectorInfo => ({ connector: c, state })
    const a = libraryRows([lib('x', { connectorId: oauth!.id }, needsAuth)], [info(oauth!)])
    expect(a[0]).toMatchObject({ action: 'Sign in', target: { type: 'connector', connectorId: oauth!.id } })
    const b = libraryRows([lib('y', { connectorId: token!.id }, { missingSecrets: ['TOKEN'] })], [info(token!)])
    expect(b[0]).toMatchObject({ action: 'Add token', target: { type: 'connector', connectorId: token!.id } })
  })

  it('falls back to Set up when the connector is not in the list', () => {
    expect(libraryRows([lib('x', { connectorId: 'gone' }, needsAuth)], [])[0].action).toBe('Set up')
  })

  it('shows a per-project entry once per project that still lacks values, never as a service', () => {
    const info = lib('notion', { perProjectSecrets: true }, {
      ...needsAuth,
      projectSecrets: [
        { projectId: 'p1', projectName: 'Billing API', serverId: 's1', missingSecrets: ['KEY'] },
        { projectId: 'p2', projectName: 'Docs site', serverId: 's2', missingSecrets: ['KEY', 'ID'] },
        { projectId: 'p3', projectName: 'Done', serverId: 's3', missingSecrets: [] }
      ]
    })
    const rows = libraryRows([info], [])
    expect(rows.map((r) => [r.kind, r.line, r.caption, r.action])).toEqual([
      ['project-value', 'notion · Needs a value for this project', 'Billing API', 'Set value'],
      ['project-value', 'notion · Needs 2 values for this project', 'Docs site', 'Set value']
    ])
    expect(rows[0].target).toEqual({ type: 'project', projectId: 'p1', serverId: 's1' })
  })

  it('shows a connector in error once, as a service when it also needs sign in', () => {
    const def = CONNECTORS[0]
    const entry = lib('e', { connectorId: def.id }, needsAuth)
    const err: ConnectorInfo = { connector: def, library: entry, state: 'error' }
    expect(libraryRows([entry], [err]).map((r) => r.kind)).toEqual(['service'])
    const fine = lib('f', { connectorId: def.id }, { usedBy: used('Docs site') })
    const rows = libraryRows([fine], [{ connector: def, library: fine, state: 'error' }])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'connector', line: `${def.name} has a problem`, caption: 'Used by Docs site', action: 'Open' })
  })

  it('ignores a connector in error that no project uses', () => {
    const def = CONNECTORS[0]
    const entry = lib('e', { connectorId: def.id }, { usedBy: [] })
    expect(libraryRows([entry], [{ connector: def, library: entry, state: 'error' }])).toEqual([])
  })
})

describe('project servers', () => {
  const server = (id: string, over: Record<string, unknown> = {}, rest: Partial<McpServerInfo> = {}): McpServerInfo => ({
    spec: { id, name: id, enabled: true, ...over } as unknown as McpServerInfo['spec'],
    envSet: [],
    headersSet: [],
    missingSecrets: [],
    auth: { state: 'notRequired' } as McpServerInfo['auth'],
    ...rest
  })

  it('picks projects with an enabled server of their own', () => {
    const spec = (enabled: boolean, libraryId?: string): NonNullable<Parameters<typeof projectsWithOwnServers>[0][number]['mcpServers']>[number] => ({ enabled, ...(libraryId ? { libraryId } : {}) }) as never
    expect(
      projectsWithOwnServers([
        { id: 'a', mcpServers: [spec(true)] },
        { id: 'b', mcpServers: [spec(true, 'lib')] },
        { id: 'c', mcpServers: [spec(false)] },
        { id: 'd' }
      ])
    ).toEqual(['a'])
  })

  it('rows only servers that need a sign in or a value, never linked ones', () => {
    const rows = projectServerRows({ id: 'p', name: 'Billing API' }, [
      server('ok'),
      server('auth', {}, { auth: { state: 'expired' } as McpServerInfo['auth'] }),
      server('val', {}, { missingSecrets: ['K'], secretScope: 'project' }),
      server('linked', { libraryId: 'l' }, { missingSecrets: ['K'] })
    ])
    expect(rows.map((r) => [r.id, r.line, r.caption, r.action])).toEqual([
      ['p:auth', 'auth · Needs sign in', 'Billing API', 'Set up'],
      ['p:val', 'val · Needs a value for this project', 'Billing API', 'Set up']
    ])
  })
})

describe('connectionRow and ordering', () => {
  it('uses the helper text and sends to Connection settings', () => {
    expect(connectionRow({ id: 'openai', text: 'OpenAI is not connected. 2 projects use it.' })).toMatchObject({ kind: 'connection', id: 'openai', action: 'Connection settings', target: { type: 'connections' } })
  })

  it('orders connection, service, project value, project server, connector, then by name', () => {
    const r = (kind: Parameters<typeof orderSetupRows>[0][number]['kind'], line: string): Parameters<typeof orderSetupRows>[0][number] => ({ kind, id: `${kind}-${line}`, line, action: 'x', target: { type: 'connections' } })
    const out = orderSetupRows([r('connector', 'a'), r('project-server', 'a'), r('service', 'b'), r('connection', 'z'), r('project-value', 'a'), r('service', 'A')])
    expect(out.map((x) => `${x.kind}:${x.line}`)).toEqual(['connection:z', 'service:A', 'service:b', 'project-value:a', 'project-server:a', 'connector:a'])
  })
})
