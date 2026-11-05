import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLibraryEntry } from '@shared/types'
import { createProject, initRepo, makeComputer, type Computer } from './service.fixture'
import { LINKS_CHANGED_MESSAGE } from './service'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let root: string
let repo: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-teamfiles-lows-'))
  repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const mcpFile = (r = repo): string => join(r, '.orgai', 'mcp.json')
const writeMcp = (r: string, servers: unknown[]): void => writeFileSync(mcpFile(r), `${JSON.stringify({ format: 'orgai.team/1', servers }, null, 2)}\n`, 'utf8')
const tombstones = (c: Computer, pid: string): Array<{ id: string }> => (c.svc as unknown as { store: { readTombstones(id: string): Array<{ id: string }> } }).store.readTombstones(pid)

const ghEntry = (url: string): McpLibraryEntry => ({ id: 'mcpl-gh', name: 'github', transport: 'http', url, enabled: true, source: 'user', addedAt: '', connectorId: 'github', connectorVariant: 'app-readonly' }) as McpLibraryEntry
const ghDoc = { name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', enabled: true, connectorId: 'github', connectorVariant: 'app-readonly' }

describe('N1: an explicit removal forgets the removed server\'s tombstone', () => {
  it('a server the main process removes loses its tombstone; one that left through the files keeps it', () => {
    initRepo(repo)
    const c = makeComputer(root, 'a', repo)
    const p = createProject(c)
    c.svc.status(p.id)
    const server = { id: 'mcp-docs', name: 'docs', transport: 'stdio' as const, command: 'npx', args: ['-y', 'docs-mcp@1.0.0'], enabled: true, source: 'user' as const, addedAt: '' }
    c.projects.update(p.id, (x) => ({ ...x, mcpServers: [server] }))
    // It leaves through the files: tombstoned, kept.
    rmSync(mcpFile())
    c.svc.check(p.id)
    expect(c.projects.get(p.id)!.mcpServers ?? []).toEqual([])
    expect(tombstones(c, p.id).map((t) => t.id)).toEqual(['mcp-docs'])
    // The same id is back in the project (e.g. an undo path) and the user removes it on purpose.
    c.projects.update(p.id, (x) => ({ ...x, mcpServers: [server] }))
    c.projects.update(p.id, (x) => ({ ...x, mcpServers: [] }))
    expect(tombstones(c, p.id)).toEqual([])
  })
})

// N2 (overlayOwnRoles) is tested in src/main/runtime/runManagerLiveOverlay.test.ts.

describe('N4: approve and create refuse when this computer\'s library changed since the status', () => {
  function withLibrary() {
    const lib: McpLibraryEntry[] = [ghEntry('https://api.githubcopilot.com/mcp/')]
    const c = makeComputer(root, 'n4', repo, {
      mcp: {
        libraryEntries: () => lib,
        connectorPreview: () => ghEntry('https://api.githubcopilot.com/mcp/'),
        connectorEntry: () => ghEntry('https://api.githubcopilot.com/mcp/'),
        removeServerSecrets: () => undefined
      }
    })
    return { c, lib }
  }

  it('approve refuses when a linked entry points somewhere else now, and works after a new status', () => {
    const { c, lib } = withLibrary()
    const p = createProject(c)
    c.svc.status(p.id)
    writeMcp(repo, [ghDoc])
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    // The file's address must equal the entry's, so a change the digest cannot see is the entry going away (sign-in with it).
    lib.length = 0
    expect(() => c.svc.approve({ projectId: p.id, digest: s.digest! })).toThrow(LINKS_CHANGED_MESSAGE)
    expect(c.projects.get(p.id)!.mcpServers ?? []).toEqual([])
  })

  it('approve is unaffected when the library did not change', () => {
    const { c } = withLibrary()
    const p = createProject(c)
    c.svc.status(p.id)
    writeMcp(repo, [ghDoc])
    const s = c.svc.check(p.id)
    c.svc.approve({ projectId: p.id, digest: s.digest! })
    expect(c.projects.get(p.id)!.mcpServers!.map((m) => m.name)).toEqual(['github'])
  })

  it('createFromFolder refuses when the entry changed after found() showed it', () => {
    const { c, lib } = withLibrary()
    mkdirSync(join(repo, '.orgai'), { recursive: true })
    const seed = createProject(c)
    c.svc.status(seed.id)
    writeMcp(repo, [ghDoc])
    c.svc.check(seed.id)
    c.svc.approve({ projectId: seed.id, digest: c.svc.check(seed.id).digest! })
    const found = c.svc.found(repo, { isDirectory: true })!
    expect(found.digest).toBeTruthy()
    lib.length = 0
    const fresh = { ...seed, id: 'proj_new' }
    expect(() => c.svc.createFromFolder(fresh, found.digest!)).toThrow(LINKS_CHANGED_MESSAGE)
  })
})

describe('N5: createFromFolder rolls back a connector entry when the project is never stored', () => {
  it('discards the entry it added when ProjectStore.create fails afterwards, and keeps it when the project is stored', () => {
    const lib: McpLibraryEntry[] = []
    const entry = ghEntry('https://api.githubcopilot.com/mcp/')
    const discarded: string[] = []
    const c = makeComputer(root, 'n5', repo, {
      mcp: {
        libraryEntries: () => lib,
        connectorPreview: () => entry,
        connectorEntry: () => {
          if (!lib.includes(entry)) lib.push(entry)
          return entry
        },
        discardConnectorEntry: (id) => {
          discarded.push(id)
          const i = lib.findIndex((e) => e.id === id)
          if (i >= 0) lib.splice(i, 1)
        },
        removeServerSecrets: () => undefined
      }
    })
    const seed = createProject(c)
    c.svc.status(seed.id)
    writeMcp(repo, [ghDoc])
    c.svc.approve({ projectId: seed.id, digest: c.svc.check(seed.id).digest! })
    c.projects.remove(seed.id)
    lib.length = 0
    const found = c.svc.found(repo, { isDirectory: true })!
    const digest = found.digest!
    // The store step fails after build (the project is never stored).
    const stub = { ...seed, id: 'proj_gone' }
    c.svc.createFromFolder(stub, digest)
    expect(lib).toHaveLength(1)
    c.svc.sweepPendingCreates()
    expect(discarded).toEqual(['mcpl-gh'])
    expect(lib).toEqual([])
    // A stored project keeps its entry: the real create path calls adopted.
    const made = c.projects.create({ name: 'Real', path: repo, brief: '', teamFiles: { digest } }, undefined, {
      teamFiles: { build: (pp) => c.svc.createFromFolder(pp, digest), adopted: (pp) => c.svc.adopted(pp.id) }
    })
    c.svc.sweepPendingCreates()
    expect(c.projects.get(made.id)).toBeTruthy()
    expect(lib).toHaveLength(1)
  })
})
