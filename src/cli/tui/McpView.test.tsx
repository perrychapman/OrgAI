/**
 * /mcp: the list at 120 columns, Space on/off, the role ticks saved as one field (and saving them unchanged), the
 * confirm before a removal, the selection kept on a row after one, adding a library entry, the empty library and
 * read-only refusals, the live-run note, setting a secret value (masked in the frame, one slot or several, this
 * project's own or the library entry's), and deleting a stored value only after a confirm asks, and Esc.
 * The host is an in-memory fake of TuiToolsApi that keeps a server list and records every call.
 */
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpAuthState, McpLibraryInfo, McpMutationResult, McpServerInfo, McpServerSpec, Project } from '../../shared/types'
import { fixtureProject, mountView, tick } from './configTestUtil'
import { MCP_LIVE_NOTE, McpView, type McpViewProps } from './McpView'
import { char, env, key } from './panes/testUtil'
import { patchedMcpSpec, type McpPatch, type TuiToolsApi } from './toolsApi'
import type { InputEvent } from './types'

const mounted: { unmount(): void }[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
})

const ENV = env({ color: false })

const server = (over: Partial<McpServerSpec> & Pick<McpServerSpec, 'id' | 'name'> & { authState?: McpAuthState; missingSecrets?: string[]; envSet?: string[]; headersSet?: string[]; secretScope?: 'project' | 'library' }): McpServerInfo => ({
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
  ...(over.secretScope ? { secretScope: over.secretScope } : {})
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

/** Servers that take secrets: one slot, two slots, and a link whose values live in the library entry (rows: Docs, Notion, Tracker). */
const secretServers = (): McpServerInfo[] => [
  server({ id: 's1', name: 'Docs', command: 'npx', secretEnv: ['DOCS_TOKEN'], missingSecrets: ['DOCS_TOKEN'] }),
  server({ id: 's2', name: 'Tracker', transport: 'http', url: 'https://tracker.example/mcp', secretEnv: ['TRACKER_KEY'], secretHeaders: ['Authorization'], missingSecrets: ['TRACKER_KEY', 'Authorization'] }),
  server({ id: 's3', name: 'Notion', libraryId: 'l1', secretHeaders: ['Authorization'], headersSet: ['Authorization'], secretScope: 'library' })
]

/** The same servers with DOCS_TOKEN already stored, so an empty value would delete a working secret. */
const storedSecretServers = (): McpServerInfo[] => [
  server({ id: 's1', name: 'Docs', command: 'npx', secretEnv: ['DOCS_TOKEN'], envSet: ['DOCS_TOKEN'] }),
  ...secretServers().slice(1)
]

/** Type a whole string into an open dialog, one character at a time. */
const typed = (s: string): InputEvent[] => [...s].map((c) => char(c))

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
  /** Every mcp:setSecret the view made (the value is kept here only so a test can read it back). */
  secrets: { serverId: string; kind: 'env' | 'header'; name: string; value: string | null }[]
  /** Every mcpLibrary:setSecret the view made. */
  librarySecrets: { libraryId: string; kind: 'env' | 'header'; name: string; value: string | null }[]
}

/** The has-flags a secret save leaves on a server or a library entry (`null` deletes the stored value). */
const secretFlags = (info: { envSet: string[]; headersSet: string[]; missingSecrets: string[] }, kind: 'env' | 'header', name: string, value: string | null): { envSet: string[]; headersSet: string[]; missingSecrets: string[] } => {
  const add = (list: string[]): string[] => (list.includes(name) ? list : [...list, name])
  const drop = (list: string[]): string[] => list.filter((n) => n !== name)
  const stored = (list: string[]): string[] => (value === null ? drop(list) : add(list))
  return {
    envSet: kind === 'env' ? stored(info.envSet) : [...info.envSet],
    headersSet: kind === 'header' ? stored(info.headersSet) : [...info.headersSet],
    missingSecrets: value === null ? add(info.missingSecrets) : drop(info.missingSecrets)
  }
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
    secrets: [],
    librarySecrets: [],
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
    async setMcpSecret(_projectId, serverId, kind, name, value) {
      api.secrets.push({ serverId, kind, name, value })
      api.servers = api.servers.map((s) => (s.spec.id === serverId ? { ...s, ...secretFlags(s, kind, name, value) } : s))
      return done()
    },
    async setMcpLibrarySecret(libraryId, kind, name, value) {
      api.librarySecrets.push({ libraryId, kind, name, value })
      api.library = api.library.map((e) => (e.entry.id === libraryId ? { ...e, ...secretFlags(e, kind, name, value) } : e))
    },
    // The view never touches the skills half of the api.
    skills: async () => [],
    skillLibrary: async () => [],
    readSkill: async () => undefined as never,
    readLibrarySkill: async () => undefined as never,
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
    expect(v.frame()).toContain('Turn Tracker on?')
    expect(v.api.sets).toHaveLength(0)
    await v.keys(char('y'))
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
    expect(v.api.links).toEqual([])
    await v.keys(char('y'))
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
    await v.keys(key('enter'), char('y'))
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

  it('s on a server that takes no secret says so and calls nothing', async () => {
    const v = mcpView(120)
    await tick(60)
    expect(v.frame()).toContain('s secret')
    await v.keys(char('s'))
    const f = v.frame()
    expect(f).toContain('Docs takes no secret.')
    expect(v.api.secrets).toHaveLength(0)
    expect(v.api.librarySecrets).toHaveLength(0)
  })

  it('s sets one secret: the value is masked in the frame and reaches the host once', async () => {
    const api = fakeTools({ servers: secretServers() })
    const v = mcpView(120, { liveRun: true }, api)
    await tick(60)
    await v.keys(char('s'))
    expect(v.frame()).toContain('Value of DOCS_TOKEN for Docs')
    expect(v.frame()).toContain('Typed text is hidden')
    await v.keys(...typed('super-secret-value'))
    let f = v.frame()
    expect(f).toContain('•'.repeat('super-secret-value'.length))
    expect(f).not.toContain('super-secret-value')
    await v.keys(key('enter'))
    await tick(60)
    expect(api.secrets).toEqual([{ serverId: 's1', kind: 'env', name: 'DOCS_TOKEN', value: 'super-secret-value' }])
    f = unwrapped(v.frame())
    expect(f).toContain('Saved DOCS_TOKEN for Docs.')
    expect(f).toContain('A run that is live now may not use it until its next run.')
    expect(f).not.toContain('super-secret-value')
    // The live-run note is about on/off and roles; a secret does not add it.
    expect(f).not.toContain(MCP_LIVE_NOTE)
    expect(api.servers.find((s) => s.spec.id === 's1')?.envSet).toEqual(['DOCS_TOKEN'])
    expect(api.servers.find((s) => s.spec.id === 's1')?.missingSecrets).toEqual([])
    expect(selectedRow(v.frame())).toContain('Docs')
  })

  it('an empty value on a slot that has none saves nothing and says so', async () => {
    const api = fakeTools({ servers: secretServers() })
    const v = mcpView(120, {}, api)
    await tick(60)
    await v.keys(char('s'), key('enter'))
    await tick(60)
    expect(api.secrets).toHaveLength(0)
    expect(v.frame()).toContain('Nothing typed: nothing saved.')
    expect(api.servers.find((s) => s.spec.id === 's1')?.missingSecrets).toEqual(['DOCS_TOKEN'])
  })

  it('the secret hint says an empty value asks first', async () => {
    const api = fakeTools({ servers: secretServers() })
    const v = mcpView(120, {}, api)
    await tick(60)
    await v.keys(char('s'))
    expect(unwrapped(v.frame())).toContain('Leave it empty to delete the stored value (it asks first).')
  })

  it('an empty value on a stored slot asks first: n keeps it, y deletes it', async () => {
    const api = fakeTools({ servers: storedSecretServers() })
    const v = mcpView(120, {}, api)
    await tick(60)
    await v.keys(char('s'), key('enter'))
    const asked = unwrapped(v.frame())
    expect(asked).toContain('Confirm')
    expect(asked).toContain('Delete the stored value of DOCS_TOKEN for Docs?')
    expect(asked).toContain('Press y to delete, n or Esc to keep it.')
    expect(asked).not.toContain('Every project that links this library entry loses it.')
    expect(api.secrets).toHaveLength(0)
    await v.keys(char('n'))
    await tick(60)
    expect(api.secrets).toHaveLength(0)
    expect(api.servers.find((s) => s.spec.id === 's1')?.envSet).toEqual(['DOCS_TOKEN'])
    // y is the same call the view made before: the value goes, the slot reads missing again.
    await v.keys(char('s'), key('enter'), char('y'))
    await tick(60)
    expect(api.secrets).toEqual([{ serverId: 's1', kind: 'env', name: 'DOCS_TOKEN', value: null }])
    expect(unwrapped(v.frame())).toContain('Deleted DOCS_TOKEN of Docs.')
    expect(api.servers.find((s) => s.spec.id === 's1')?.envSet).toEqual([])
    expect(api.servers.find((s) => s.spec.id === 's1')?.missingSecrets).toEqual(['DOCS_TOKEN'])
  })

  it('deleting a library entry\'s stored value says every project that links it loses it', async () => {
    const api = fakeTools({ servers: secretServers() })
    const v = mcpView(120, {}, api)
    await tick(60)
    // Notion is the middle row, and its Authorization is stored in the library entry.
    await v.keys(key('down'), char('s'), key('enter'))
    const asked = unwrapped(v.frame())
    expect(asked).toContain('Delete the stored value of Authorization for Notion?')
    expect(asked).toContain('Every project that links this library entry loses it.')
    expect(api.librarySecrets).toHaveLength(0)
    await v.keys(char('y'))
    await tick(60)
    expect(api.librarySecrets).toEqual([{ libraryId: 'l1', kind: 'header', name: 'Authorization', value: null }])
    expect(api.secrets).toHaveLength(0)
    expect(unwrapped(v.frame())).toContain('Deleted Authorization of Notion.')
    expect(api.library.find((e) => e.entry.id === 'l1')?.headersSet).toEqual([])
    expect(selectedRow(v.frame())).toContain('Notion')
  })

  it('s on a server with two secrets asks which one first, then takes the value', async () => {
    const api = fakeTools({ servers: secretServers() })
    const v = mcpView(120, {}, api)
    await tick(60)
    // Tracker is the last row (Docs, Notion, Tracker).
    await v.keys(key('down'), key('down'), char('s'))
    let f = v.frame()
    expect(f).toContain('Which secret of Tracker?')
    expect(f).toContain('TRACKER_KEY')
    expect(f).toContain('Authorization')
    expect(f).toContain('missing')
    await v.keys(key('enter'))
    f = v.frame()
    expect(f).toContain('Value of TRACKER_KEY for Tracker')
    await v.keys(...typed('tracker-key'), key('enter'))
    await tick(60)
    expect(api.secrets).toEqual([{ serverId: 's2', kind: 'env', name: 'TRACKER_KEY', value: 'tracker-key' }])
    expect(v.frame()).toContain('Saved TRACKER_KEY for Tracker.')
    // The other slot, picked from the list now that the first one reads set.
    await v.keys(char('s'), key('down'), key('enter'))
    expect(v.frame()).toContain('Value of Authorization for Tracker')
    await v.keys(...typed('Bearer abc'), key('enter'))
    await tick(60)
    expect(api.secrets[1]).toEqual({ serverId: 's2', kind: 'header', name: 'Authorization', value: 'Bearer abc' })
    expect(api.servers.find((s) => s.spec.id === 's2')?.headersSet).toEqual(['Authorization'])
  })

  it('s on a linked server writes the value to the library entry every project shares', async () => {
    const api = fakeTools({ servers: secretServers() })
    const v = mcpView(120, {}, api)
    await tick(60)
    // Notion is the middle row.
    await v.keys(key('down'), char('s'))
    expect(v.frame()).toContain('Value of Authorization for Notion')
    expect(unwrapped(v.frame())).toContain('It belongs to your library entry: every project that links it uses it.')
    await v.keys(...typed('library-token'), key('enter'))
    await tick(60)
    expect(api.librarySecrets).toEqual([{ libraryId: 'l1', kind: 'header', name: 'Authorization', value: 'library-token' }])
    expect(api.secrets).toHaveLength(0)
    const f = unwrapped(v.frame())
    expect(f).toContain('Saved Authorization for Notion.')
    expect(f).not.toContain('library-token')
    expect(api.library.find((e) => e.entry.id === 'l1')?.headersSet).toEqual(['Authorization'])
    expect(selectedRow(v.frame())).toContain('Notion')
  })

  it('s works on the server whose details are open', async () => {
    const api = fakeTools({ servers: secretServers() })
    const v = mcpView(120, {}, api)
    await tick(60)
    await v.keys(key('enter'), char('s'))
    expect(v.frame()).toContain('Value of DOCS_TOKEN for Docs')
    await v.keys(...typed('docs-token'), key('enter'))
    await tick(60)
    expect(api.secrets).toEqual([{ serverId: 's1', kind: 'env', name: 'DOCS_TOKEN', value: 'docs-token' }])
    expect(v.frame()).toContain('MCP · Docs')
  })

  it('s is refused in a read-only session', async () => {
    const api = fakeTools({ servers: secretServers() })
    const v = mcpView(120, { readOnly: 'Another orgai owns this data folder.' }, api)
    await tick(60)
    await v.keys(char('s'))
    expect(v.frame()).toContain('Read-only: Another orgai owns this data folder.')
    expect(api.secrets).toHaveLength(0)
    expect(api.librarySecrets).toHaveLength(0)
  })
})

describe('MCP view: a widening save asks first', () => {
  it('Space on an off server shows what it is, saves nothing until y', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(key('down'), char(' '))
    const f = v.frame()
    expect(f).toContain('Turn Search on?')
    expect(f).toContain('y saves')
    expect(f).toContain('any other key cancels')
    expect(v.api.sets).toHaveLength(0)
    await v.keys(char('y'))
    expect(v.api.sets).toEqual([{ serverId: 'm2', patch: { enabled: true } }])
    expect(v.frame()).toContain('Turned Search on.')
  })

  it('any other key cancels and saves nothing', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(key('down'), char(' '), char('q'))
    expect(v.frame()).not.toContain('Turn Search on?')
    expect(v.api.sets).toHaveLength(0)
    await v.keys(key('down'), char(' '), key('enter'))
    expect(v.frame()).not.toContain('Turn Tracker on?')
    expect(v.api.sets).toHaveLength(0)
  })

  it('Space on a server that is on saves at once (narrowing)', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(char(' '))
    expect(v.api.sets).toEqual([{ serverId: 'm1', patch: { enabled: false } }])
    expect(v.frame()).not.toContain('Turn Docs on?')
  })

  it('l asks before linking; another key cancels', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(char('l'), key('enter'))
    expect(v.frame()).toContain('Add Notion from your library, for every role?')
    expect(v.frame()).toContain('source: library entry l1')
    await v.keys(char('n'))
    expect(v.api.links).toHaveLength(0)
    await v.keys(char('l'), key('enter'), char('y'))
    expect(v.api.links).toEqual(['l1'])
  })

  it('a roles change that adds a role asks; one that only removes does not', async () => {
    const v = mcpView(120)
    await tick(60)
    // Search holds Lead and Dev: tick Qa as well.
    await v.keys(key('down'), char('r'), key('down'), key('down'), char(' '), key('enter'))
    expect(v.frame()).toContain('use Search?')
    expect(v.api.sets).toHaveLength(0)
    await v.keys(char('q'))
    expect(v.api.sets).toHaveLength(0)
    // Untick Dev: narrowing, saved at once.
    await v.keys(char('r'), key('down'), char(' '), key('enter'))
    expect(v.api.sets).toEqual([{ serverId: 'm2', patch: { roles: ['lead'] } }])
  })

  it('going to every role asks', async () => {
    const v = mcpView(120)
    await tick(60)
    await v.keys(key('down'), char('r'), key('down'), key('down'), char(' '), key('down'), char(' '), key('enter'))
    expect(v.frame()).toContain('Let every role use Search?')
    expect(v.api.sets).toHaveLength(0)
  })

  it('shows names of env variables, headers and secret slots, never their values, and the whole command', async () => {
    const info = server({ id: 'x1', name: 'Zed', enabled: false, command: 'node', args: ['--flag', `${'alpha '.repeat(30)}ENDTOKEN`], secretEnv: ['ZED_TOKEN'] })
    ;(info.spec as McpServerSpec).env = { PLAIN_VAR: 'plain-value-9' }
    ;(info.spec as McpServerSpec).headers = { 'X-Team': 'header-value-7' }
    const v = mcpView(120, {}, fakeTools({ servers: [info] }))
    await tick(60)
    await v.keys(char(' '))
    const f = v.frame()
    expect(f).toContain('PLAIN_VAR')
    expect(f).toContain('ZED_TOKEN')
    expect(f).toContain('X-Team')
    expect(f).not.toContain('plain-value-9')
    expect(f).not.toContain('header-value-7')
    expect(f).toContain('ENDTOKEN')
    expect(f).toContain('command: node')
    expect(f).not.toContain('…')
  })

  it('a hostile argument never reaches the frame as an escape', async () => {
    const info = server({ id: 'x1', name: 'Zed', enabled: false, command: 'node', args: ['a\u001b[2Jb\u001b]0;pwn\u0007c‮d'] })
    const v = mcpView(120, {}, fakeTools({ servers: [info] }))
    await tick(60)
    await v.keys(char(' '))
    // eslint-disable-next-line no-control-regex
    expect(/[\u001b\u0007‮]/.test(v.frame().replace(/\u001b\[[0-9;]*m/g, ''))).toBe(false)
    expect(v.frame()).toContain('Turn Zed on?')
  })

  it('refuses instead of cutting when the definition does not fit the window', async () => {
    const args = Array.from({ length: 60 }, (_, i) => `argument-number-${i}`)
    const info = server({ id: 'x1', name: 'Zed', enabled: false, command: 'node', args })
    const v = mcpView(120, {}, fakeTools({ servers: [info] }))
    await tick(60)
    await v.keys(char(' '))
    expect(v.frame()).toContain('too long to show whole')
    expect(v.frame()).not.toContain('Turn Zed on?')
    expect(v.api.sets).toHaveLength(0)
  })

  it('a confirmation that fit when it opened is closed, not accepted, after the window shrinks', async () => {
    const args = Array.from({ length: 20 }, (_, i) => `argument-number-${i}`)
    const info = server({ id: 'x1', name: 'Zed', enabled: false, command: 'node', args })
    const api = fakeTools({ servers: [info] })
    let resize: (rows: number) => void = () => undefined
    function Resizable() {
      const [rows, setRows] = useState(60)
      resize = setRows
      return <McpView width={120} height={rows} env={ENV} projectId="p1" api={api} onClose={() => undefined} />
    }
    const v = mountView(() => <Resizable />, ENV)
    mounted.push(v.r)
    await tick(60)
    await v.keys(char(' '))
    expect(v.frame()).toContain('Turn Zed on?')
    resize(14)
    await tick(60)
    await v.keys(char('y'))
    expect(api.sets).toHaveLength(0)
    expect(v.frame()).toContain('too long to show whole')
    expect(v.frame()).not.toContain('Turn Zed on?')
    // The dialog is gone: a second y does nothing either.
    await v.keys(char('y'))
    expect(api.sets).toHaveLength(0)
  })

  it('the highlighted row is the one an action uses after the list shrinks', async () => {
    const api = fakeTools({ servers: secretServers() })
    const orig = api.setMcpLibrarySecret
    api.setMcpLibrarySecret = async (...a) => {
      await orig(...a)
      api.servers = api.servers.slice(0, 1)
    }
    const v = mcpView(120, {}, api)
    await tick(60)
    // Rows: Docs, Notion, Tracker. Select Notion and save its library secret; the reloaded list holds only Docs.
    await v.keys(key('down'), char('s'), ...typed('tok'), key('enter'))
    await tick(60)
    expect(selectedRow(v.frame())).toContain('Docs')
  })
})
