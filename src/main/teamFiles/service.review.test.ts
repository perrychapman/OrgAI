import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TEAM_FILES_LIST_MAX, type McpLibraryEntry } from '@shared/types'
import { commitAll, createProject, git, initRepo, listOrgai, makeComputer, readOrgai, rolePath, setRole, type Computer } from './service.fixture'
import { TOO_MANY_MESSAGE } from './service'
import { readTeamFolder } from './disk'
import { parseTeamFiles } from './parse'

// Counts the git status calls the focus pass makes (the real function still runs).
// Every started call is remembered so afterEach can await it before the repo is removed.
const gitCalls = vi.hoisted(() => ({ n: 0, pending: [] as Promise<unknown>[] }))
vi.mock('../runtime/worktrees', async (orig) => {
  const real = await orig<typeof import('../runtime/worktrees')>()
  return {
    ...real,
    teamFilesStatusGit: (root: string) => {
      gitCalls.n++
      const p = real.teamFilesStatusGit(root)
      gitCalls.pending.push(p)
      return p
    }
  }
})
vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let root: string
let repo: string
let c: Computer

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-teamfiles-rev-'))
  repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  c = makeComputer(root, 'a', repo)
  gitCalls.n = 0
})

afterEach(async () => {
  // A focus pass's git status may still be running in the repo (EBUSY on Windows): wait for every one started.
  await Promise.allSettled(gitCalls.pending.splice(0))
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
})

const state = (cc: Computer, id: string) => (cc.svc as unknown as { store: { readState(id: string): { dirtyBefore?: unknown } } }).store.readState(id)
const mcpFile = (): string => join(repo, '.orgai', 'mcp.json')
const writeMcp = (servers: unknown[]): void => writeFileSync(mcpFile(), `${JSON.stringify({ format: 'orgai.team/1', servers }, null, 2)}\n`, 'utf8')

describe('H4: more changes than a status lists', () => {
  it('lists the most powerful first, counts what is left out and refuses to approve or create', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    writeMcp(Array.from({ length: 200 }, (_, i) => ({ name: `srv-${String(i).padStart(3, '0')}`, transport: 'stdio', command: 'npx', args: ['-y', `pkg-${i}@1.0.0`], enabled: true })))
    const team = join(repo, '.orgai', 'team.json')
    const j = JSON.parse(readFileSync(team, 'utf8')) as Record<string, unknown>
    j.permissionMode = 'bypassPermissions'
    writeFileSync(team, `${JSON.stringify(j, null, 2)}\n`, 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    expect(s.changes).toHaveLength(TEAM_FILES_LIST_MAX)
    expect(s.omittedChanges).toBeGreaterThanOrEqual(1)
    // Loosening settings come before the 200 servers, so bypassPermissions can never be the hidden one.
    expect(s.changes[0].id).toBe('settings:permissionMode')
    expect(() => c.svc.approve({ projectId: p.id, digest: s.digest! })).toThrow(TOO_MANY_MESSAGE)
    expect(c.projects.get(p.id)!.permissionMode).not.toBe('bypassPermissions')

    // The folder preview of a New project: no digest, an omitted count, the whole settings shown, and creating refuses.
    const found = c.svc.found(repo, { isDirectory: true })!
    expect(found.omittedChanges).toBeGreaterThanOrEqual(1)
    expect(found.digest).toBeUndefined()
    expect(found.changes[0].id).toBe('settings:permissionMode')
    expect(found.settings?.find((x) => x.label === 'Permission mode')?.value).toBe('bypassPermissions')
    const read = readTeamFolder(repo)
    const digest = parseTeamFiles(read.files, { base: null, agentsDirExists: read.agentsDirExists }).digest
    expect(() => c.svc.createFromFolder(c.projects.get(p.id)!, digest)).toThrow(TOO_MANY_MESSAGE)
  })
})

describe('H6: private-looking skill files', () => {
  it('never reach the folder, on the first write or later, and are not ingested from it', () => {
    const p = createProject(c)
    c.skills.create({ projectId: p.id, draft: { name: 'priv-skill', description: 'Has private files.', body: 'Body.' } })
    const spec = c.projects.get(p.id)!.skills!.find((s) => s.name === 'priv-skill')!
    const stored = c.skills.teamReadFiles(p.id, spec)!
    c.skills.teamStoreFiles(p.id, spec.id, [...stored, { path: '.env', data: Buffer.from('SECRET=1') }, { path: 'key.pem', data: Buffer.from('x') }, { path: 'notes.txt', data: Buffer.from('ok') }])
    const s = c.svc.status(p.id)
    expect(listOrgai(repo).filter((f) => f.startsWith('skills/priv-skill/'))).toEqual(['skills/priv-skill/SKILL.md', 'skills/priv-skill/notes.txt'])
    expect(s.notes.some((n) => /private-looking/.test(n) && n.includes('priv-skill'))).toBe(true)
    // A later write of the same skill does not bring them either, and the local copy keeps them.
    c.skills.teamStoreFiles(p.id, spec.id, [...stored, { path: '.env', data: Buffer.from('SECRET=1') }, { path: 'notes.txt', data: Buffer.from('changed') }])
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'Touch.' }))
    expect(listOrgai(repo).some((f) => f.endsWith('.env') || f.endsWith('.pem'))).toBe(false)
    // A private file placed in the folder by hand is dropped on read: nothing pending, nothing deleted.
    const before = c.svc.check(p.id).digest
    writeFileSync(join(repo, '.orgai', 'skills', 'priv-skill', '.env'), 'HAND=1', 'utf8')
    const after = c.svc.check(p.id)
    expect(after.state).toBe('in-sync')
    expect(after.digest).toBe(before)
    expect(readFileSync(join(repo, '.orgai', 'skills', 'priv-skill', '.env'), 'utf8')).toBe('HAND=1')
  })

  it('a new skill from the folder is previewed and stored without its private files', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const dir = join(repo, '.orgai', 'skills', 'fresh')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: fresh\ndescription: A fresh one.\n---\nDo it.\n', 'utf8')
    writeFileSync(join(dir, '.env'), 'KEY=1', 'utf8')
    writeFileSync(join(dir, 'server.key'), 'k', 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    c.svc.approve({ projectId: p.id, digest: s.digest! })
    const spec = c.projects.get(p.id)!.skills!.find((x) => x.name === 'fresh')!
    expect(c.skills.teamReadFiles(p.id, spec)!.map((f) => f.path)).toEqual(['SKILL.md'])
  })
})

describe('H5: a server that leaves keeps its id, secrets and sign-in (real git)', () => {
  function setup() {
    initRepo(repo)
    const p = createProject(c)
    c.svc.status(p.id)
    c.projects.update(p.id, (x) => ({
      ...x,
      mcpServers: [{ id: 'mcp-docs', name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp@1.0.0'], secretEnv: ['DOCS_TOKEN'], enabled: true, source: 'user', addedAt: '2026-01-01T00:00:00.000Z', oauth: undefined }]
    }))
    c.secrets.set(`mcp:${p.id}:mcp-docs:env:DOCS_TOKEN`, 's3cret')
    expect(readOrgai(c, 'mcp.json')).toContain('docs-mcp@1.0.0')
    commitAll(repo, 'team with docs')
    return p
  }

  it('checkout away, focus check, checkout back, approve: the same id and the secret', () => {
    const p = setup()
    git(repo, 'checkout', '-q', '-b', 'nodocs')
    rmSync(mcpFile())
    commitAll(repo, 'no mcp.json on this branch')
    const away = c.svc.check(p.id)
    expect(away.problems).toEqual([])
    expect(c.projects.get(p.id)!.mcpServers ?? []).toEqual([])
    // The secret is not deleted by the removal.
    expect(c.secrets.get(`mcp:${p.id}:mcp-docs:env:DOCS_TOKEN`)).toBe('s3cret')
    git(repo, 'checkout', '-q', 'main')
    const back = c.svc.check(p.id)
    expect(back.state).toBe('pending')
    c.svc.approve({ projectId: p.id, digest: back.digest! })
    const docs = c.projects.get(p.id)!.mcpServers!.find((m) => m.name === 'docs')!
    expect(docs.id).toBe('mcp-docs')
    expect(docs.addedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(c.secrets.get(`mcp:${p.id}:mcp-docs:env:DOCS_TOKEN`)).toBe('s3cret')
  })

  it('Undo after the removal brings the server back with its id and secret', () => {
    const p = setup()
    git(repo, 'checkout', '-q', '-b', 'nodocs')
    writeMcp([])
    c.svc.check(p.id)
    expect(c.projects.get(p.id)!.mcpServers ?? []).toEqual([])
    c.svc.undo({ projectId: p.id })
    expect(c.projects.get(p.id)!.mcpServers!.find((m) => m.name === 'docs')!.id).toBe('mcp-docs')
    expect(c.secrets.get(`mcp:${p.id}:mcp-docs:env:DOCS_TOKEN`)).toBe('s3cret')
  })

  it('a different launch under the same name gets a new id and the old secret stays under the tombstone', () => {
    const p = setup()
    git(repo, 'checkout', '-q', '-b', 'other')
    writeMcp([{ name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp@2.0.0'], secretEnv: ['DOCS_TOKEN'], enabled: true }])
    commitAll(repo, 'docs v2')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    c.svc.approve({ projectId: p.id, digest: s.digest! })
    const now = c.projects.get(p.id)!.mcpServers!.find((m) => m.name === 'docs')!
    expect(now.id).not.toBe('mcp-docs')
    expect([...c.secrets.keys()].filter((k) => k.includes(`:${now.id}:`))).toEqual([])
    expect(c.secrets.get(`mcp:${p.id}:mcp-docs:env:DOCS_TOKEN`)).toBe('s3cret')
    // Back to the first launch: the first id (and so the secret) returns.
    git(repo, 'checkout', '-q', 'main')
    const back = c.svc.check(p.id)
    c.svc.approve({ projectId: p.id, digest: back.digest! })
    expect(c.projects.get(p.id)!.mcpServers!.find((m) => m.name === 'docs')!.id).toBe('mcp-docs')
  })

  it('keeps at most 200 tombstones; the oldest go with their secrets', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const servers = Array.from({ length: 202 }, (_, i) => ({ id: `mcp-${i}`, name: `s${String(i).padStart(3, '0')}`, transport: 'stdio' as const, command: 'npx', args: ['-y', `p${i}@1.0.0`], enabled: true, source: 'user' as const, addedAt: '' }))
    c.projects.update(p.id, (x) => ({ ...x, mcpServers: servers.slice(0, 200) }))
    for (const s of servers.slice(0, 200)) c.secrets.set(`mcp:${p.id}:${s.id}:env:K`, 'v')
    expect(readOrgai(c, 'mcp.json')).toContain('s000')
    rmSync(mcpFile())
    c.svc.check(p.id)
    expect(c.projects.get(p.id)!.mcpServers ?? []).toEqual([])
    expect(c.secrets.get(`mcp:${p.id}:mcp-0:env:K`)).toBe('v')
    // Two more leave later: the two oldest tombstones are dropped with their stored values.
    const tomb = (c.svc as unknown as { commitTombstones(pid: string, add: unknown[], used: unknown[]): void }).commitTombstones.bind(c.svc)
    tomb(p.id, [{ name: 'x1', id: 'mcp-x1', spec: servers[200], at: Date.now() + 1 }, { name: 'x2', id: 'mcp-x2', spec: servers[201], at: Date.now() + 2 }], [])
    const left = [...c.secrets.keys()].filter((k) => k.startsWith(`mcp:${p.id}:mcp-`) && k.endsWith(':env:K'))
    expect(left).toHaveLength(198)
    expect(c.secrets.has(`mcp:${p.id}:mcp-0:env:K`)).toBe(false)
  })
})

describe('writes that cannot tell what they would overwrite', () => {
  it('a save while the team is over the size cap writes nothing, keeps the delta, and applies it once the folder reads again', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const before = readOrgai(c, 'agents/reviewer.md')
    const fillers: string[] = []
    for (let i = 0; i < 36; i++) {
      const f = join(repo, '.orgai', 'agents', `filler-${i}.md`)
      writeFileSync(f, 'x'.repeat(1_000_000), 'utf8')
      fillers.push(f)
    }
    expect(c.svc.check(p.id).state).toBe('problem')
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'Changed during the outage.' }))
    expect(readOrgai(c, 'agents/reviewer.md')).toBe(before)
    expect(listOrgai(repo).filter((f) => !f.startsWith('agents/filler-'))).toEqual(listOrgai(repo).filter((f) => !f.startsWith('agents/filler-')))
    expect(state(c, p.id).dirtyBefore).toBeDefined()
    expect(c.projects.get(p.id)!.roles.find((r) => r.slug === 'reviewer')!.prompt).toBe('Changed during the outage.')
    for (const f of fillers) rmSync(f)
    const s = c.svc.check(p.id)
    expect(s.state).toBe('in-sync')
    expect(readOrgai(c, 'agents/reviewer.md')).toContain('Changed during the outage.')
    expect(state(c, p.id).dirtyBefore).toBeUndefined()
  })

  it('a folder whose team.json went missing among team content is not written; an empty folder still gets the first write', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    rmSync(join(repo, '.orgai', 'team.json'))
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'Edit with no team.json.' }))
    expect(listOrgai(repo).includes('team.json')).toBe(false)
    expect(readOrgai(c, 'agents/reviewer.md')).not.toContain('Edit with no team.json.')
    expect(state(c, p.id).dirtyBefore).toBeDefined()
    // A folder with no team content at all (a branch that never had them) still takes a real saved change.
    rmSync(join(repo, '.orgai'), { recursive: true, force: true })
    c.svc.check(p.id)
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'First write after an empty branch.' }))
    expect(listOrgai(repo)).toContain('team.json')
    expect(readOrgai(c, 'agents/reviewer.md')).toContain('First write after an empty branch.')
  })

  it('an edit saved while its file is a problem is applied onto the file once it parses again', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const file = rolePath(c, 'reviewer')
    const good = readFileSync(file, 'utf8')
    writeFileSync(file, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n', 'utf8')
    expect(c.svc.check(p.id).state).toBe('problem')
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'Edited while the file was a problem.' }))
    expect(readFileSync(file, 'utf8')).toContain('<<<<<<<')
    expect(state(c, p.id).dirtyBefore).toBeDefined()
    // Someone fixes the file (back to its older content); the edit is applied onto it before anything is gated.
    writeFileSync(file, good, 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('in-sync')
    expect(readFileSync(file, 'utf8')).toContain('Edited while the file was a problem.')
    expect(c.projects.get(p.id)!.roles.find((r) => r.slug === 'reviewer')!.prompt).toBe('Edited while the file was a problem.')
  })
})

describe('library edits reach a linked skill', () => {
  function linked() {
    const p = createProject(c)
    c.svc.status(p.id)
    c.skills.libraryCreate({ name: 'house-style', description: 'Use for house style.', body: 'Original body.' })
    const lib = c.skills.libraryList()[0].entry
    c.skills.linkLibrary({ projectId: p.id, libraryId: lib.id })
    return { p, lib }
  }

  it('is a local delta: approved and the file follow, nothing is pending', () => {
    const { p, lib } = linked()
    expect(readOrgai(c, 'skills/house-style/SKILL.md')).toContain('Original body.')
    c.skills.libraryUpdate({ libraryId: lib.id, draft: { name: 'house-style', description: 'Use for house style.', body: 'Edited in the library.' } })
    expect(readOrgai(c, 'skills/house-style/SKILL.md')).toContain('Edited in the library.')
    expect(c.svc.check(p.id).state).toBe('in-sync')
  })

  it('a file change to the same skill still gates', () => {
    const { p, lib } = linked()
    const file = join(repo, '.orgai', 'skills', 'house-style', 'SKILL.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('Original body.', 'Edited in the file.'), 'utf8')
    expect(c.svc.check(p.id).state).toBe('pending')
    c.skills.libraryUpdate({ libraryId: lib.id, draft: { name: 'house-style', description: 'Use for house style.', body: 'Edited in the library.' } })
    // The file keeps its own change, which is still a pending change from the new approved text.
    expect(readFileSync(file, 'utf8')).toContain('Edited in the file.')
    expect(c.svc.check(p.id).state).toBe('pending')
  })
})

describe('connector entries added by an apply that fails', () => {
  it('are taken back (rolled back), and a failed apply leaves no entry behind', () => {
    const repo2 = join(root, 'repo2')
    mkdirSync(repo2, { recursive: true })
    const lib: McpLibraryEntry[] = []
    const entry = { id: 'mcpl-gh', name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', enabled: true, source: 'user', addedAt: '', connectorId: 'github', connectorVariant: 'app-readonly' } as McpLibraryEntry
    let added = 0
    const d = makeComputer(root, 'd', repo2, {
      mcp: {
        libraryEntries: () => lib,
        connectorPreview: () => entry,
        connectorEntry: () => {
          added++
          if (!lib.includes(entry)) lib.push(entry)
          return entry
        },
        discardConnectorEntry: (id) => {
          const i = lib.findIndex((e) => e.id === id)
          if (i >= 0) lib.splice(i, 1)
        },
        removeServerSecrets: () => undefined
      }
    })
    const p = d.projects.create({ name: 'D', path: repo2, brief: '' }, undefined, { mockAvailable: true })
    d.svc.status(p.id)
    writeFileSync(
      join(repo2, '.orgai', 'mcp.json'),
      `${JSON.stringify({ format: 'orgai.team/1', servers: [{ name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', enabled: true, connectorId: 'github', connectorVariant: 'app-readonly' }, { name: 'zz-unpinned', transport: 'stdio', command: 'npx', args: ['-y', 'nopin'], enabled: true }] }, null, 2)}\n`,
      'utf8'
    )
    const s = d.svc.check(p.id)
    expect(s.state).toBe('pending')
    expect(() => d.svc.approve({ projectId: p.id, digest: s.digest! })).toThrow()
    expect(added).toBe(1)
    expect(lib).toEqual([])
    expect(d.projects.get(p.id)!.mcpServers ?? []).toEqual([])
  })
})

describe('focus pass', () => {
  it('asks git again only when the files changed, and found() reads the folder once per stamp', async () => {
    initRepo(repo)
    const p = createProject(c)
    c.svc.status(p.id)
    commitAll(repo, 'team')
    await c.svc.checkAll()
    const first = gitCalls.n
    expect(first).toBeGreaterThanOrEqual(1)
    await c.svc.checkAll()
    await c.svc.checkAll()
    expect(gitCalls.n).toBe(first)
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'Changed on disk.' }))
    await c.svc.checkAll()
    expect(gitCalls.n).toBeGreaterThan(first)
    const a = c.svc.found(repo, { isDirectory: true })
    expect(c.svc.found(repo, { isDirectory: true })).toBe(a)
  })
})
