import { describe, expect, it } from 'vitest'
import type { McpLibraryEntry, McpServerSpec, Project, SecretStatus } from '../../shared/types'
import { mcpLibraryPrefix, mcpSecretPrefix } from '../store/secrets'
import { STORES_SECRET, librarySecretPrefix, projectServerSecretPrefix, type StoresSecretHostView } from './storesSecret'

const server = (over: Partial<McpServerSpec> = {}): McpServerSpec =>
  ({ id: 's1', name: 'gh', transport: 'stdio', command: 'npx', secretEnv: ['TOKEN'], enabled: true, source: 'user', addedAt: '', ...over }) as McpServerSpec

function view(opts: { servers?: McpServerSpec[]; entry?: Partial<McpLibraryEntry>; statuses?: Record<string, SecretStatus> } = {}): StoresSecretHostView {
  const statuses = opts.statuses ?? {}
  const project = { id: 'p1', mcpServers: opts.servers ?? [] } as unknown as Project
  const entry = opts.entry ? ({ id: 'lib1', name: 'lib', transport: 'stdio', secretEnv: ['TOKEN'], secretHeaders: [], source: 'user', addedAt: '', ...opts.entry } as McpLibraryEntry) : undefined
  return {
    project: (id) => (id === 'p1' ? project : null),
    libraryEntry: (id) => (entry && id === entry.id ? entry : undefined),
    secretKeys: (prefix = '') => Object.keys(statuses).filter((k) => k.startsWith(prefix)),
    secretStatus: (k) => statuses[k] ?? 'unset'
  }
}

const run = (channel: string, args: unknown[], v: StoresSecretHostView = view()): boolean => STORES_SECRET[channel](args, v)

describe('storesSecret predicates (cli-standalone.md 5.6)', () => {
  it('mirror the store key prefixes', () => {
    expect(projectServerSecretPrefix('p1', 's1')).toBe(mcpSecretPrefix('p1', 's1'))
    expect(librarySecretPrefix('lib1')).toBe(mcpLibraryPrefix('lib1'))
  })

  it('connections:setSecret: a trimmed non-empty LiteLLM key only', () => {
    expect(run('connections:setSecret', [{ id: 'litellm', apiKey: 'sk-1' }])).toBe(true)
    for (const apiKey of [null, '', '   ', undefined, 42]) expect(run('connections:setSecret', [{ id: 'litellm', apiKey }]), String(apiKey)).toBe(false)
    expect(run('connections:setSecret', [{ id: 'openai', apiKey: 'sk-1' }])).toBe(false)
  })

  it('connectors:setToken: a token with text; null and blank store nothing', () => {
    expect(run('connectors:setToken', [{ connectorId: 'zapier', token: 'abc' }])).toBe(true)
    for (const token of [null, '', '  ']) expect(run('connectors:setToken', [{ connectorId: 'zapier', token }])).toBe(false)
  })

  it('mcp:setSecret / mcpLibrary:setSecret: a non-empty value', () => {
    for (const c of ['mcp:setSecret', 'mcpLibrary:setSecret']) {
      expect(run(c, [{ value: 'v' }]), c).toBe(true)
      expect(run(c, [{ value: null }]), c).toBe(false)
      expect(run(c, [{ value: '' }]), c).toBe(false)
    }
  })

  it('setup:decide: an approval with a non-empty secret value', () => {
    expect(run('setup:decide', [{ runId: 'r', proposalId: 'x', decision: { behavior: 'approve', secrets: { 's1:env:TOKEN': 'v' } } }])).toBe(true)
    expect(run('setup:decide', [{ runId: 'r', proposalId: 'x', decision: { behavior: 'approve', secrets: { 's1:env:TOKEN': '' } } }])).toBe(false)
    expect(run('setup:decide', [{ runId: 'r', proposalId: 'x', decision: { behavior: 'approve' } }])).toBe(false)
    expect(run('setup:decide', [{ runId: 'r', proposalId: 'x', decision: { behavior: 'revise', feedback: 'no', secrets: { a: 'v' } } }])).toBe(false)
  })

  it("mcp:answerInstall: approved for the project or library with a value; 'run' keeps values in memory", () => {
    const d = (over: Record<string, unknown>) => [{ runId: 'r', requestId: 'q', decision: { approved: true, scope: 'project', secrets: { TOKEN: 'v' }, ...over } }]
    expect(run('mcp:answerInstall', d({}))).toBe(true)
    expect(run('mcp:answerInstall', d({ scope: 'library' }))).toBe(true)
    expect(run('mcp:answerInstall', d({ scope: 'run' }))).toBe(false)
    expect(run('mcp:answerInstall', d({ scope: undefined }))).toBe(false)
    expect(run('mcp:answerInstall', d({ approved: false }))).toBe(false)
    expect(run('mcp:answerInstall', d({ secrets: { TOKEN: '' } }))).toBe(false)
  })

  it('mcp:authorize: only with a client secret (the tokens are prepared by the flow itself)', () => {
    expect(run('mcp:authorize', [{ libraryId: 'lib1', clientId: 'c', clientSecret: 's' }])).toBe(true)
    expect(run('mcp:authorize', [{ libraryId: 'lib1', clientId: 'c' }])).toBe(false)
    expect(run('mcp:authorize', [{ libraryId: 'lib1', clientSecret: '' }])).toBe(false)
  })

  it('mcp:promote: a project-only server with a readable value; unreadable or linked or empty is false', () => {
    const p = mcpSecretPrefix('p1', 's1')
    const args = [{ projectId: 'p1', serverId: 's1' }]
    expect(run('mcp:promote', args, view({ servers: [server()], statuses: { [`${p}env:TOKEN`]: 'set' } }))).toBe(true)
    expect(run('mcp:promote', args, view({ servers: [server()], statuses: { [`${p}oauth:accessToken`]: 'set' } }))).toBe(true)
    expect(run('mcp:promote', args, view({ servers: [server()] }))).toBe(false)
    expect(run('mcp:promote', args, view({ servers: [server()], statuses: { [`${p}env:TOKEN`]: 'set', [`${p}oauth:accessToken`]: { unreadable: 'locked' } } }))).toBe(false)
    expect(run('mcp:promote', args, view({ servers: [server({ libraryId: 'lib1' })], statuses: { [`${p}env:TOKEN`]: 'set' } }))).toBe(false)
    expect(run('mcp:promote', [{ projectId: 'nope', serverId: 's1' }], view({ servers: [server()], statuses: { [`${p}env:TOKEN`]: 'set' } }))).toBe(false)
  })

  it('mcp:copyFromLibrary: per-project values always, entry values only with copySecrets, unreadable never', () => {
    const link = server({ libraryId: 'lib1' })
    const lib = `${mcpLibraryPrefix('lib1')}env:TOKEN`
    const own = `${mcpSecretPrefix('p1', 's1')}env:TOKEN`
    const args = (copySecrets: boolean) => [{ projectId: 'p1', serverId: 's1', copySecrets }]
    expect(run('mcp:copyFromLibrary', args(true), view({ servers: [link], entry: {}, statuses: { [lib]: 'set' } }))).toBe(true)
    expect(run('mcp:copyFromLibrary', args(false), view({ servers: [link], entry: {}, statuses: { [lib]: 'set' } }))).toBe(false)
    expect(run('mcp:copyFromLibrary', args(false), view({ servers: [link], entry: { perProjectSecrets: true }, statuses: { [own]: 'set' } }))).toBe(true)
    expect(run('mcp:copyFromLibrary', args(true), view({ servers: [link], entry: { perProjectSecrets: true }, statuses: { [lib]: 'set' } }))).toBe(false)
    expect(run('mcp:copyFromLibrary', args(true), view({ servers: [link], entry: {}, statuses: { [lib]: { unreadable: 'pending' } } }))).toBe(false)
    expect(run('mcp:copyFromLibrary', args(true), view({ servers: [link], entry: { buildDigest: 'x' }, statuses: { [lib]: 'set' } }))).toBe(false)
    expect(run('mcp:copyFromLibrary', args(true), view({ servers: [server()], entry: {}, statuses: { [lib]: 'set' } }))).toBe(false)
  })
})
