/**
 * /mcp's model (cli-parity 3.7): the row text (order, the three role wordings, the flags and their order), the row
 * never exceeding the width at 40 and at 120 columns, one server's detail lines, the role choices and their round trip,
 * and the library choices leaving out what this project already links.
 */
import { describe, expect, it } from 'vitest'
import type { McpAuthState, McpLibraryInfo, McpServerInfo, McpServerSpec } from '../../shared/types'
import { fixtureProject, role } from './configTestUtil'
import { checkedFromRoles, libraryOptions, mcpDetailLines, mcpRoleOptions, mcpRowSegs, mcpRows, mcpSecretScope, mcpSecretSlots, rolesFromChecks, type McpData } from './mcpModel'
import { textWidth } from './panes/text'

const server = (over: Partial<McpServerSpec> & Pick<McpServerSpec, 'id' | 'name'> & { authState?: McpAuthState; libraryMissing?: true; missingSecrets?: string[]; envSet?: string[]; headersSet?: string[]; secretScope?: 'project' | 'library' }): McpServerInfo => ({
  spec: {
    id: over.id,
    name: over.name,
    transport: over.transport ?? 'stdio',
    enabled: over.enabled ?? true,
    source: over.source ?? 'user',
    addedAt: '2025-01-01T00:00:00.000Z',
    ...(over.command ? { command: over.command } : {}),
    ...(over.args ? { args: over.args } : {}),
    ...(over.url ? { url: over.url } : {}),
    ...(over.roles ? { roles: over.roles } : {}),
    ...(over.description ? { description: over.description } : {}),
    ...(over.libraryId ? { libraryId: over.libraryId } : {}),
    ...(over.secretEnv ? { secretEnv: over.secretEnv } : {}),
    ...(over.secretHeaders ? { secretHeaders: over.secretHeaders } : {})
  },
  envSet: over.envSet ?? [],
  headersSet: over.headersSet ?? [],
  missingSecrets: over.missingSecrets ?? [],
  auth: { state: over.authState ?? 'notRequired' },
  ...(over.libraryMissing ? { libraryMissing: true } : {}),
  ...(over.secretScope ? { secretScope: over.secretScope } : {})
})

const entry = (id: string, name: string, description?: string): McpLibraryInfo => ({
  entry: { id, name, transport: 'stdio', source: 'user', addedAt: '2025-01-01T00:00:00.000Z', ...(description ? { description } : {}) },
  envSet: [],
  headersSet: [],
  missingSecrets: [],
  auth: { state: 'notRequired' },
  usedBy: []
})

const data = (servers: McpServerInfo[], project = fixtureProject()): McpData => ({ project, servers })
const joined = (segs: { text: string }[]): string => segs.map((s) => s.text).join('')

describe('mcpRows', () => {
  it('one row per server, sorted by name whatever the case', () => {
    const rows = mcpRows(data([server({ id: 'a', name: 'zeta' }), server({ id: 'b', name: 'Alpha' }), server({ id: 'c', name: 'Beta' })]))
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Beta', 'zeta'])
  })

  it('says on or off', () => {
    const rows = mcpRows(data([server({ id: 'a', name: 'Docs' }), server({ id: 'b', name: 'Search', enabled: false })]))
    expect(rows.map((r) => r.state)).toEqual(['on', 'off'])
  })

  it('says every role, no role, 1 role, 3 roles', () => {
    const rows = mcpRows(data([server({ id: 'a', name: 'all' }), server({ id: 'b', name: 'none', roles: [] }), server({ id: 'c', name: 'one', roles: ['lead'] }), server({ id: 'd', name: 'three', roles: ['lead', 'dev', 'qa'] })]))
    expect(rows.map((r) => r.roles)).toEqual(['every role', 'no role', '1 role', '3 roles'])
  })

  it('does not count a slug this project does not have', () => {
    const rows = mcpRows(data([server({ id: 'a', name: 'one', roles: ['lead', 'ghost'] })]))
    expect(rows[0].roles).toBe('1 role')
  })

  it('shows the transport and the flags in their order', () => {
    const rows = mcpRows(data([server({ id: 'a', name: 'gone', transport: 'http', url: 'https://x.example/mcp', libraryId: 'l1', libraryMissing: true, missingSecrets: ['TOKEN'], authState: 'expired' })]))
    expect(rows[0].transport).toBe('http')
    expect(rows[0].flags).toEqual(['library entry gone', 'needs a secret', 'needs sign-in'])
  })

  it('flags nothing for a server that needs neither a secret nor a sign-in', () => {
    const rows = mcpRows(data([server({ id: 'a', name: 'plain', authState: 'authorized' }), server({ id: 'b', name: 'local' })]))
    expect(rows.map((r) => r.flags)).toEqual([[], []])
  })
})

describe('mcpRowSegs', () => {
  const rows = mcpRows(data([server({ id: 'a', name: 'a-server-name-long-enough', enabled: false, roles: ['lead', 'dev'], libraryId: 'l1', libraryMissing: true, missingSecrets: ['TOKEN'], authState: 'notAuthorized' }), server({ id: 'b', name: 'Docs' })]))
  const nameWidth = Math.min(28, Math.max(...rows.map((r) => textWidth(r.name))))

  it('keeps every part at 120 columns, flags last', () => {
    const segs = mcpRowSegs(rows[0], 120, nameWidth, ' · ', '…', false)
    const line = joined(segs)
    expect(line).toContain('a-server-name-long-enough')
    expect(line).toContain('off · 2 roles · stdio · library entry gone · needs a secret · needs sign-in')
    expect(textWidth(line)).toBeLessThanOrEqual(120)
  })

  it('never exceeds the width at 40 or at 120 columns', () => {
    for (const width of [40, 120]) {
      for (const row of rows) {
        for (const selected of [false, true]) {
          expect(textWidth(joined(mcpRowSegs(row, width, nameWidth, ' · ', '…', selected)))).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  it('drops the flags, then the transport, then the roles before it cuts the name', () => {
    const at40 = joined(mcpRowSegs(rows[0], 40, nameWidth, ' · ', '…', false))
    expect(at40).toContain('off')
    expect(at40).not.toContain('needs a secret')
    expect(at40).not.toContain('stdio')
    expect(at40).not.toContain('2 roles')
    const at20 = joined(mcpRowSegs(rows[0], 20, nameWidth, ' · ', '…', false))
    expect(at20.endsWith('…')).toBe(true)
    const marked = mcpRowSegs(rows[1], 120, nameWidth, ' · ', '…', true)
    expect(marked[0].text).toBe('> ')
    expect(marked[0].tone).toBe('accent')
  })
})

describe('mcpDetailLines', () => {
  it('lists the facts of one stdio server, then its description', () => {
    const project = fixtureProject({ roles: [role({ id: 'lead', reportsTo: null, mcpServers: ['m1'] }), role({ id: 'dev' })] })
    const lines = mcpDetailLines(data([server({ id: 'm1', name: 'Docs', command: 'npx', args: ['-y', '@mcp/docs'], roles: ['dev'], description: 'Reads the docs.', missingSecrets: ['DOCS_TOKEN'] })], project), 'm1')
    expect(lines).toEqual([
      'Docs',
      'state: on',
      'transport: stdio',
      'command: npx -y @mcp/docs',
      'available to: Dev',
      'granted on their own: Lead',
      'secrets missing: DOCS_TOKEN',
      'secrets: none',
      'sign-in: notRequired',
      'source: this project',
      'Reads the docs.'
    ])
  })

  it('says every role, shows the url and the library entry, and marks a server that is gone', () => {
    const lines = mcpDetailLines(data([server({ id: 'm2', name: 'Tracker', transport: 'sse', url: 'https://t.example/mcp', libraryId: 'l9', authState: 'authorized' })]), 'm2')
    expect(lines).toContain('available to: every role')
    expect(lines).toContain('granted on their own: none')
    expect(lines).toContain('url: https://t.example/mcp')
    expect(lines).toContain('source: library entry l9')
    expect(lines).toContain('secrets missing: none')
    expect(mcpDetailLines(data([]), 'nope')).toEqual(['This server is gone.'])
  })

  it('lists every secret slot the server takes, each with whether a value is stored', () => {
    const lines = mcpDetailLines(data([server({ id: 'm1', name: 'Docs', secretEnv: ['DOCS_TOKEN', 'DOCS_REGION'], secretHeaders: ['Authorization'], envSet: ['DOCS_TOKEN'], missingSecrets: ['DOCS_REGION', 'Authorization'] })]), 'm1')
    expect(lines).toContain('secrets missing: DOCS_REGION, Authorization')
    expect(lines).toContain('secrets: DOCS_TOKEN (set), DOCS_REGION (missing), Authorization (missing)')
    expect(mcpDetailLines(data([server({ id: 'm2', name: 'Plain' })]), 'm2')).toContain('secrets: none')
  })
})

describe('mcpSecretSlots and mcpSecretScope', () => {
  it('the env slots first, then the header slots, each with whether a value is stored', () => {
    const info = server({ id: 'm1', name: 'Docs', secretEnv: ['DOCS_TOKEN', 'DOCS_REGION'], secretHeaders: ['Authorization'], envSet: ['DOCS_TOKEN'], headersSet: [], missingSecrets: ['DOCS_REGION', 'Authorization'] })
    expect(mcpSecretSlots(info)).toEqual([
      { kind: 'env', name: 'DOCS_TOKEN', set: true },
      { kind: 'env', name: 'DOCS_REGION', set: false },
      { kind: 'header', name: 'Authorization', set: false }
    ])
  })

  it('no slot when the spec names none, and a field that is missing or not an array names none either', () => {
    expect(mcpSecretSlots(server({ id: 'm1', name: 'Docs' }))).toEqual([])
    const broken = { spec: { id: 'm1', name: 'Docs', transport: 'stdio', enabled: true, source: 'user', addedAt: '', secretEnv: 'DOCS_TOKEN', secretHeaders: { 0: 'Authorization' } }, envSet: null, headersSet: 'Authorization' } as unknown as McpServerInfo
    expect(mcpSecretSlots(broken)).toEqual([])
  })

  it('library scope only for a link whose values live in the entry it links', () => {
    expect(mcpSecretScope(server({ id: 'm1', name: 'Docs' }))).toBe('project')
    expect(mcpSecretScope(server({ id: 'm2', name: 'Notion', libraryId: 'l1' }))).toBe('project')
    expect(mcpSecretScope(server({ id: 'm3', name: 'Notion', libraryId: 'l1', secretScope: 'project' }))).toBe('project')
    expect(mcpSecretScope(server({ id: 'm4', name: 'Notion', libraryId: 'l1', secretScope: 'library' }))).toBe('library')
    // 'library' with no entry to write to is still this project's own secret.
    expect(mcpSecretScope(server({ id: 'm5', name: 'Odd', secretScope: 'library' }))).toBe('project')
  })
})

describe('mcpRoleOptions and the role round trip', () => {
  it('offers one option per role, by slug', () => {
    expect(mcpRoleOptions(fixtureProject())).toEqual([
      { value: 'lead', label: 'Lead' },
      { value: 'dev', label: 'Dev' },
      { value: 'qa', label: 'Qa' },
      { value: 'intern', label: 'Intern' }
    ])
  })

  it('every role checked means every role; anything else keeps the project order', () => {
    const p = fixtureProject()
    expect(checkedFromRoles(p, undefined)).toEqual(['lead', 'dev', 'qa', 'intern'])
    expect(rolesFromChecks(p, checkedFromRoles(p, undefined))).toBeUndefined()
    expect(rolesFromChecks(p, checkedFromRoles(p, ['dev']))).toEqual(['dev'])
    expect(rolesFromChecks(p, checkedFromRoles(p, []))).toEqual([])
    expect(rolesFromChecks(p, ['intern', 'lead'])).toEqual(['lead', 'intern'])
    expect(rolesFromChecks(p, ['lead', 'ghost'])).toEqual(['lead'])
  })

  it('ticks every role for an open server and only the slugs the project has', () => {
    const p = fixtureProject()
    expect(checkedFromRoles(p, undefined)).toEqual(['lead', 'dev', 'qa', 'intern'])
    expect(checkedFromRoles(p, ['dev', 'ghost'])).toEqual(['dev'])
  })
})

describe('libraryOptions', () => {
  it('leaves out the entries this project already links and sorts the rest by name', () => {
    const options = libraryOptions([entry('l1', 'Zeta'), entry('l2', 'Docs'), entry('l3', 'Notion', 'Reads and writes Notion pages.')], [server({ id: 'm1', name: 'Zeta', libraryId: 'l1' })])
    expect(options.map((o) => o.value)).toEqual(['l2', 'l3'])
    expect(options.map((o) => o.label)).toEqual(['Docs', 'Notion'])
    expect(options[0].detail).toBe('')
    expect(options[1].detail).toBe('Reads and writes Notion pages.')
  })
})
