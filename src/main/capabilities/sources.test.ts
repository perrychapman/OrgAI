import { describe, expect, it } from 'vitest'
import type { CapabilityItem, ConnectorInfo, McpLibraryInfo, McpServerInfo, Project, SkillInfo, SkillLibraryInfo } from '@shared/types'
import { CONNECTORS } from '@shared/connectors'
import { project as makeProject, role } from '../runtime/testHelpers'
import { discoverCatalog, discoverLibrary, discoverProject, dropProjectDuplicates, mcpGrantedTo, specTarget } from './sources'
import type { DiscoveredCandidate } from './types'

const roles = [role({ id: 'r1', slug: 'one' }), role({ id: 'r2', slug: 'two', mcpServers: ['srv'] }), role({ id: 'r3', slug: 'three' })]
const project = (over: Partial<Project> = {}): Project => makeProject({ roles, ...over })

describe('mcpGrantedTo', () => {
  it('undefined roles reach every role; otherwise slugs plus explicit Role.mcpServers', () => {
    expect(mcpGrantedTo(roles, { id: 'srv', roles: undefined })).toEqual(['r1', 'r2', 'r3'])
    expect(mcpGrantedTo(roles, { id: 'srv', roles: ['three'] })).toEqual(['r2', 'r3'])
    expect(mcpGrantedTo(roles, { id: 'other', roles: [] })).toEqual([])
  })
})

describe('specTarget', () => {
  it('drops key-like args and scrubs URLs', () => {
    expect(specTarget({ transport: 'stdio', command: 'npx', args: ['-y', 'pkg@1.0.0', 'API_KEY=abc123', 'sk-abcdefghijklmnop1234'] })).toBe('npx -y pkg@1.0.0')
    expect(specTarget({ transport: 'http', url: 'https://h.example.com/mcp?token=SECRET#frag' })).toBe('https://h.example.com/mcp')
    expect(specTarget({ transport: 'http', url: 'ftp://nope' })).toBe('')
  })
})

describe('discoverProject', () => {
  const skill = (over: object = {}): SkillInfo =>
    ({ spec: { id: 's1', name: 'my-skill', description: 'Does things', digest: 'dg', enabled: true }, grantedTo: ['r1'], ...over }) as unknown as SkillInfo
  const server = (spec: object, over: object = {}): McpServerInfo =>
    ({ spec: { id: 'm1', name: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'x@1'], enabled: true, ...spec }, missingSecrets: [], auth: { state: 'none' }, ...over }) as unknown as McpServerInfo

  it('lists skills and servers with grants, flags and missing secrets', () => {
    const out = discoverProject(project(), [skill()], [server({}, { missingSecrets: ['TOKEN'] })])
    expect(out.candidates).toHaveLength(2)
    const [s, m] = out.candidates.map((c) => c.item)
    expect(s).toMatchObject({ kind: 'skill', origin: 'project', inProject: { id: 's1', grantedTo: ['r1'] }, digest: 'dg' })
    expect(m).toMatchObject({ kind: 'mcp', flags: ['runsCode'], needsSecrets: ['TOKEN'], target: 'npx -y x@1' })
    expect(out.candidates[1]!.payload).toEqual({ type: 'projectMcp', serverId: 'm1' })
    expect(out.sources[0]).toMatchObject({ source: 'project', state: 'found', count: 2 })
    expect(discoverProject(project(), [], []).sources[0]!.state).toBe('empty')
  })

  it('leaves connector links to the catalog and blocks entries whose library entry is gone', () => {
    const out = discoverProject(project(), [skill({ libraryMissing: true })], [server({ connectorId: 'github' }), server({ id: 'm2', name: 'gone' }, { libraryMissing: true })])
    expect(out.candidates.map((c) => c.item.name)).toEqual(['my-skill', 'gone'])
    expect(out.candidates.every((c) => !!c.item.blockedReason)).toBe(true)
  })
})

describe('discoverLibrary', () => {
  const mcpEntry = (id: string, over: object = {}): McpLibraryInfo => ({ entry: { id, name: id, transport: 'http', url: 'https://x.example.com/mcp', ...over }, missingSecrets: [] }) as unknown as McpLibraryInfo
  const skillEntry = (id: string): SkillLibraryInfo => ({ entry: { id, name: id, description: 'd', digest: 'dd' }, usedBy: [] }) as unknown as SkillLibraryInfo

  it('lists unlinked entries and skips connectors and linked ones', () => {
    const p = project({ mcpServers: [{ id: 'm', name: 'a', libraryId: 'linked' }] as never, skills: [{ id: 's', libraryId: 'sl' }] as never })
    const out = discoverLibrary(p, [mcpEntry('linked'), mcpEntry('free'), mcpEntry('conn', { connectorId: 'github' })], [skillEntry('sl'), skillEntry('sfree')])
    expect(out.candidates.map((c) => c.payload)).toEqual([
      { type: 'libraryMcp', libraryId: 'free' },
      { type: 'librarySkill', libraryId: 'sfree' }
    ])
    expect(out.sources[0]).toMatchObject({ state: 'found', count: 2 })
    expect(discoverLibrary(project(), [], []).sources[0]!.state).toBe('missing')
    expect(discoverLibrary(project(), [mcpEntry('conn', { connectorId: 'x' })], []).sources[0]!.state).toBe('empty')
  })
})

describe('discoverCatalog', () => {
  it('lists every connector with stable ids and flags, and marks a linked one inProject', () => {
    const a = discoverCatalog(project(), [])
    expect(a.candidates).toHaveLength(CONNECTORS.length)
    expect(new Set(a.candidates.map((c) => c.item.id)).size).toBe(CONNECTORS.length)
    expect(discoverCatalog(project(), []).candidates.map((c) => c.item.id)).toEqual(a.candidates.map((c) => c.item.id))
    const gh = a.candidates.find((c) => c.item.connectorId === 'github')!.item
    expect(gh).toMatchObject({ kind: 'connector', origin: 'catalog', readOnlyAvailable: true })
    expect(gh.flags).toContain('remote')
    const info = { connector: CONNECTORS.find((c) => c.id === 'github')!, state: 'connected', library: { entry: { id: 'lib-gh' } } } as unknown as ConnectorInfo
    const linked = discoverCatalog(project({ mcpServers: [{ id: 'm9', name: 'github', libraryId: 'lib-gh', enabled: true, roles: ['one'] }] as never }), [info])
    const item = linked.candidates.find((c) => c.item.connectorId === 'github')!.item
    expect(item.connectorState).toBe('connected')
    expect(item.inProject).toMatchObject({ kind: 'mcp', id: 'm9', grantedTo: ['r1'] })
  })
})

describe('dropProjectDuplicates', () => {
  const cand = (id: string, origin: CapabilityItem['origin'], name = 'dup', kind: CapabilityItem['kind'] = 'skill'): DiscoveredCandidate =>
    ({ item: { id, kind, origin, name, flags: [], needsSecrets: [], notes: [], description: '', source: 'project', sourceLabel: '' }, payload: { type: 'projectSkill', skillId: id } }) as DiscoveredCandidate

  it('drops same-kind same-name non-project items and repeated ids, keeps catalog', () => {
    const out = dropProjectDuplicates([cand('a', 'project'), cand('b', 'repo'), cand('c', 'local'), cand('d', 'repo', 'dup', 'mcp'), cand('e', 'catalog'), cand('a', 'project'), cand('f', 'repo', 'other')])
    expect(out.map((c) => c.item.id)).toEqual(['a', 'd', 'e', 'f'])
  })
})
