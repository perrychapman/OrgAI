/**
 * /mcp: the list at 120 columns, Space on/off, the role ticks saved as one field (and saving them unchanged), the
 * confirm before a removal, the selection kept on a row after one, adding a library entry, the empty library and
 * read-only refusals, the live-run note, and Esc.
 * The host is an in-memory fake of TuiToolsApi that keeps a server list and records every call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpAuthState, McpLibraryInfo, McpMutationResult, McpServerInfo, McpServerSpec, Project } from '../../shared/types'
import { fixtureProject, mountView, tick } from './configTestUtil'
import { MCP_LIVE_NOTE, McpView, type McpViewProps } from './McpView'
import { char, env, key } from './panes/testUtil'
import { patchedMcpSpec, type McpPatch, type TuiToolsApi } from './toolsApi'

const mounted: { unmount(): void }[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
})

const ENV = env({ color: false })

const server = (over: Partial<McpServerSpec> & Pick<McpServerSpec, 'id' | 'name'> & { authState?: McpAuthState; missingSecrets?: string[] }): McpServerInfo => ({
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
    ...(over.libraryId ? { libraryId: over.libraryId } : {})
  },
  envSet: [],
  headersSet: [],
  missingSecrets: over.missingSecrets ?? [],
  auth: { state: over.authState ?? 'notRequired' }
})

const libEntry = (id: string, name: string, description?: string): McpLibraryInfo => ({
  entry: { id, name, transport: 'stdio', source: 'user', addedAt: '2025-01-01T00:00:00.000Z', ...(description ? { description } : {}) },
  envSet: [],
  headersSet: [],
  missingSecrets: [],
  auth: { state: 'notRequired' },
  usedBy: []
})

const servers = (): McpServerInfo[] => [
  server({ id: 'm1', name: 'Docs', command: 'npx', args: ['-y', '@mcp/docs'], description: 'Reads the project docs.' }),
  server({ id: 'm2', name: 'Search', enabled: false, roles: ['lead', 'dev'] }),
  server({ id: 'm3', name: 'Tracker', transport: 'http', url: 'https://tracker.example/mcp', roles: ['lead'], enabled: false, missingSecrets: ['Authorization'], authState: 'notAuthorized' })
]

export interface FakeTools extends TuiToolsApi {
  stored: Project
  servers: McpServerInfo[]
  library: McpLibraryInfo[]
  /** Every mcp:upsert the view made, in order. */
  sets: { serverId: string; patch: McpPatch }[]
  /** Every mcp:linkLibrary the view made. */
  links: string[]
  /** Every mcp:remove the view made. */
  removes: string[]
}

function fakeTools(over: Partial<Pick<FakeTools, 'servers' | 'library'>> = {}): FakeTools {
  const done = (): McpMutationResult => ({ project: structuredClone(api.stored), servers: structuredClone(api.servers) })
  const api: FakeTools = {
    stored: fixtureProject(),
    servers: servers(),
    library: [libEntry('l1', 'Notion', 'Reads and writes Notion pages.')],
    sets: [],
    links: [],
    removes: [],
    ...over,
    project: async () => structuredClone(api.stored),
    mcpServers: async () => structuredClone(api.servers),
    mcpLibrary: async () => structuredClone(api.library),
    async setMcp(_projectId, serverId, patch) {
      api.sets.push({ serverId, patch })
      api.servers = api.servers.map((s) => (s.spec.id === serverId ? { ...s, spec: patchedMcpSpec(s.spec, patch) } : s))
      return done()
    },
    async linkMcp(_projectId, libraryId) {
      api.links.push(libraryId)
      const entry = api.library.find((e) => e.entry.id === libraryId)
      if (entry) {
        const spec: McpServerSpec = { id: `srv-${libraryId}`, name: entry.entry.name, transport: entry.entry.transport, enabled: true, source: 'library', addedAt: '2025-01-01T00:00:00.000Z', libraryId, ...(entry.entry.command ? { command: entry.entry.command } : {}), ...(entry.entry.description ? { description: entry.entry.description } : {}) }
        api.servers = [...api.servers, { spec, envSet: [], headersSet: [], missingSecrets: [], auth: { state: 'notRequired' } }]
      }
      return done()
    },
    async removeMcp(_projectId, serverId) {
      api.removes.push(serverId)
      api.servers = api.servers.filter((s) => s.spec.id !== serverId)
      return done()
    },
    // The view never touches the skills half of the api.
    skills: async () => [],
    skillLibrary: async () => [],
    readSkill: async () => undefined as never,
    updateSkill: async () => undefined as never,
    linkSkill: async () => undefined as never,
    removeSkill: async () => undefined as never
  }
  return api
}

function mcpView(width: number, over: Partial<McpViewProps> = {}, api = fakeTools()) {
  const onClose = vi.fn()
  const v = mountView(() => <McpView width={width} height={24} env={ENV} projectId="p1" api={api} onClose={onClose} {...over} />, ENV)
  mounted.push(v.r)
  return { ...v, api, onClose }
}

const widest = (frame: string): number => Math.max(...frame.split('\n').map((l) => [...l].length))
/** The frame's lines joined across the border, so a wrapped message can be read as one sentence. */
const unwrapped = (frame: string): string => frame.replace(/\s*│\n│\s*/g, ' ')
/** The row the frame highlights (its `> ` marker), the border aside; undefined when no row is highlighted. */
const selectedRow = (frame: string): string | undefined => frame.split('\n').map((l) => l.replace(/^│ /, '')).find((l) => l.startsWith('> '))

describe('MCP view', () => {
  it('lists every server with its state, who may use it, its transport and what to watch out for', async () => {
    const v = mcpView(120)
    await tick(60)
    const f = v.frame()
    expect(f).toContain('MCP servers of App (3 servers)')
    expect(f).toMatch(/Docs\s+on · every role · stdio/)
    expect(f).toMatch(/Search\s+off · 2 roles · stdio/)
    expect(f).toMatch(/Tracker\s+off · 1 role · http · needs a secret · needs sign-in/)
    expect(f).toContain('Space on/off')
    expect(f).toContain('l add from library')
    expect(widest(f)).toBeLessThanOrEqual(120)
  })

  it('fits 80 columns: the keys wrap onto the footer and every row stays inside', async () => {
    const v = mcpView(80)
    await tick(60)
    const f = v.frame()
    expect(widest(f)).toBeLessThanOrEqual(80)
    expect(f).toContain('Tracker')
    expect(f).toContain('Esc back')
  })

  it('Enter opens the details; Esc backs out one level, then closes the view', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(key('down'), key('enter'))
    let f = v.frame()
    expect(f).toContain('MCP · Search')
    expect(f).toContain('state: off')
    expect(f).toContain('transport: stdio')
    expect(f).toContain('available to: Lead, Dev')
    expect(f).toContain('granted on their own: none')
    expect(f).toContain('source: this project')
    expect(f).toContain('Up/Down scroll')
    await v.keys(key('escape'))
    f = v.frame()
    expect(f).toContain('MCP servers of App')
    expect(v.onClose).not.toHaveBeenCalled()
    await v.keys(key('escape'))
    expect(v.onClose).toHaveBeenCalledTimes(1)
  })

  it('Space turns the selected server off and says so', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(char(' '))
    expect(v.api.sets).toEqual([{ serverId: 'm1', patch: { enabled: false } }])
    const f = v.frame()
    expect(f).toContain('Turned Docs off.')
    expect(f).toMatch(/Docs\s+off · every role · stdio/)
    expect(v.api.servers.find((s) => s.spec.id === 'm1')?.spec.enabled).toBe(false)
  })

  it('Space turns a server on and warns when its secrets are still unset', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(key('down'), key('down'), char(' '))
    const f = v.frame()
    expect(f).toContain('Turned Tracker on.')
    expect(f).toContain('It cannot start until its secrets are set: orgai mcp set-secret')
  })

  it('r ticks the roles that may use a server; Enter saves them as one field', async () => {
    const v = mcpView(120)
    await tick(60)
    // Docs is open to every role: every box starts ticked, so saving as-is changes nothing.
    await v.keys(char('r'))
    expect(v.frame()).toContain('Roles that may use Docs')
    expect(v.frame()).toContain('Space toggles')
    await v.keys(key('enter'))
    expect(v.frame()).toContain('Nothing changed.')
    expect(v.api.sets).toHaveLength(0)
    // Untick Dev, then save.
    await v.keys(char('r'), key('down'), char(' '), key('enter'))
    expect(v.api.sets).toEqual([{ serverId: 'm1', patch: { roles: ['lead', 'qa', 'intern'] } }])
    const f = v.frame()
    expect(f).toContain('Docs is now available to 3 roles.')
    expect(f).toMatch(/Docs\s+on · 3 roles · stdio/)
  })

  it('r unticks every role and ticks them all again (no list on the spec)', async () => {
    const v = mcpView(120)
    await tick(60)
    // Search: untick Lead and Dev.
    await v.keys(key('down'), char('r'), char(' '), key('down'), char(' '), key('enter'))
    expect(v.api.sets[0].patch).toEqual({ roles: [] })
    expect(v.frame()).toContain('Search is now available to no role.')
    expect(v.frame()).toMatch(/Search\s+off · no role · stdio/)
  })

  it('r on a server saved with a list of every role changes nothing', async () => {
    const api = fakeTools()
    api.servers = [server({ id: 'm0', name: 'All roles', roles: ['lead', 'dev', 'qa', 'intern'] }), ...servers()]
    const v = mcpView(120, {}, api)
    await tick(60)
    // 'All roles' sorts first: its boxes all start ticked, so Enter saves nothing and the list keeps its 4 roles.
    expect(v.frame()).toMatch(/All roles\s+on · 4 roles · stdio/)
    await v.keys(char('r'), key('enter'))
    expect(v.frame()).toContain('Nothing changed.')
    expect(v.api.sets).toHaveLength(0)
    expect(v.frame()).toMatch(/All roles\s+on · 4 roles · stdio/)
  })

  it('r on a server whose list names a role this project no longer has changes nothing too', async () => {
    const api = fakeTools()
    api.servers = [server({ id: 'm5', name: 'Old list', roles: ['ghost'] }), ...servers()]
    const v = mcpView(120, {}, api)
    await tick(60)
    // Nothing is ticked for a slug the project does not have, so saving the unticked boxes changes nothing.
    expect(v.frame()).toMatch(/Old list\s+on · no role · stdio/)
    await v.keys(char('r'), key('enter'))
    expect(v.frame()).toContain('Nothing changed.')
    expect(v.api.sets).toHaveLength(0)
  })

  it('x asks first and removes only on y', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(key('down'), char('x'))
    expect(v.frame()).toContain('Remove Search from this project?')
    expect(v.frame()).toContain('y confirms')
    expect(v.api.removes).toHaveLength(0)
    await v.keys(char('y'))
    expect(v.api.removes).toEqual(['m2'])
    const f = v.frame()
    expect(f).toContain('Removed Search.')
    expect(f).toContain('MCP servers of App (2 servers)')
  })

  it('keeps a row highlighted when the last server in the list is removed', async () => {
    const v = mcpView(120)
    await tick(60)
    // Tracker is the last row: after its removal the selection falls back to the new last row.
    await v.keys(key('down'), key('down'), char('x'), char('y'))
    expect(v.api.removes).toEqual(['m3'])
    const f = v.frame()
    expect(f).toContain('Removed Tracker.')
    expect(selectedRow(f)).toContain('Search')
  })

  it('x leaves the details screen and keeps the library entry of a linked server', async () => {
    const api = fakeTools()
    api.servers = [...api.servers, server({ id: 'm4', name: 'Notion', libraryId: 'l1' })]
    const v = mcpView(120, {}, api)
    await tick(60)
    // Notion sorts between Docs and Search: open its details, then remove it.
    await v.keys(key('down'), key('enter'))
    expect(v.frame()).toContain('MCP · Notion')
    expect(v.frame()).toContain('source: library entry l1')
    await v.keys(char('x'), char('y'))
    expect(v.api.removes).toEqual(['m4'])
    expect(v.frame()).toContain('MCP servers of App')
    expect(v.api.library).toHaveLength(1)
  })

  it('l adds a library entry for every role', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(char('l'))
    expect(v.frame()).toContain('Add a server from your library')
    expect(v.frame()).toContain('Notion')
    await v.keys(key('enter'))
    expect(v.api.links).toEqual(['l1'])
    const f = v.frame()
    expect(f).toContain('Added Notion for every role.')
    expect(f).toMatch(/Notion\s+on · every role · stdio/)
  })

  it('l says so when the library has nothing else to add', async () => {
    const v = mcpView(120, {}, fakeTools({ library: [] }))
    await tick(60)
    await v.keys(char('l'))
    expect(v.frame()).toContain('Your library has no other server to add. Add one with: orgai mcp library add')
    expect(v.api.links).toHaveLength(0)
  })

  it('an empty project says how to add one', async () => {
    const v = mcpView(120, {}, fakeTools({ servers: [] }))
    await tick(60)
    const f = v.frame()
    expect(f).toContain('MCP servers of App (0 servers)')
    expect(f).toContain('This project has no MCP servers. Press l to add one from your library, or run: orgai mcp add')
  })

  it('an empty project can still add its first server from the library', async () => {
    const v = mcpView(120, {}, fakeTools({ servers: [] }))
    await tick(60)
    await v.keys(char('l'))
    await tick(60)
    expect(v.frame()).toContain('Add a server from your library')
    await v.keys(key('enter'))
    await tick(60)
    expect(v.api.links).toEqual(['l1'])
    expect(v.frame()).toContain('Added Notion for every role.')
  })

  it('refuses every edit in a read-only session', async () => {
    const v = mcpView(120, { readOnly: 'Another orgai owns this data folder.' })
    await tick(60)
    await v.keys(char(' '), char('r'), char('l'), char('x'))
    expect(v.frame()).toContain('Read-only: Another orgai owns this data folder.')
    expect(v.api.sets).toHaveLength(0)
    expect(v.api.links).toHaveLength(0)
    expect(v.api.removes).toHaveLength(0)
  })

  it('a live run that did not take the save itself gets the note after one', async () => {
    const v = mcpView(120, { liveRun: true })
    await tick(60)
    await v.keys(char(' '))
    const f = unwrapped(v.frame())
    expect(f).toContain('Turned Docs off.')
    expect(f).toContain(MCP_LIVE_NOTE)
  })

  it('Ctrl+C closes the view', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(key('char', { ch: 'c', ctrl: true, raw: '\u0003' }))
    expect(v.onClose).toHaveBeenCalledTimes(1)
  })
})
