import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newProject } from '@shared/defaults'
import { TEAM_FILES_JSON } from '@shared/types'
import { teamDigest } from './digest'
import { listOrgai, makeComputer, createProject, readOrgai, rolePath, setRole, type Computer } from './service.fixture'
import { STALE_MESSAGE } from './service'
import { writeTeamFiles } from './disk'
import { removeProjectData } from '../store/projectData'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let root: string
let repo: string
let c: Computer

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-teamfiles-'))
  repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  c = makeComputer(root, 'a', repo)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('first open', () => {
  it('writes the files once at the first status and is in sync', () => {
    const p = createProject(c)
    // Nothing is written by a project being created, a plain check or the attention list.
    expect(listOrgai(repo)).toEqual([])
    expect(c.svc.check(p.id).state).toBe('off')
    expect(c.svc.check(p.id).offReason).toBe('not-written')
    expect(c.svc.listAttention()).toEqual([])
    expect(listOrgai(repo)).toEqual([])
    const s = c.svc.status(p.id)
    expect(s.state).toBe('in-sync')
    expect(listOrgai(repo)).toContain('team.json')
    expect(listOrgai(repo).filter((f) => f.startsWith('agents/')).length).toBe(p.roles.length)
    expect(s.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(c.svc.status(p.id).state).toBe('in-sync')
  })

  it('a save before the project was ever opened writes nothing', () => {
    const p = createProject(c)
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'Review harder.' }))
    expect(listOrgai(repo)).toEqual([])
  })

  it('writes the files at a run start (beforeRun) and gives no warning', () => {
    const p = createProject(c)
    const r = c.svc.beforeRun(p)
    expect(r.warning).toBeUndefined()
    expect(listOrgai(repo)).toContain('team.json')
  })
})

describe('write through', () => {
  it('a prompt edit rewrites only that role file and the approved team follows', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const before = Object.fromEntries(listOrgai(repo).map((f) => [f, readOrgai(c, f)]))
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'Review much harder.' }))
    const after = Object.fromEntries(listOrgai(repo).map((f) => [f, readOrgai(c, f)]))
    const changed = Object.keys(after).filter((f) => after[f] !== before[f])
    expect(changed).toEqual(['agents/reviewer.md'])
    expect(after['agents/reviewer.md']).toContain('Review much harder.')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('in-sync')
    expect(s.changes).toEqual([])
  })

  it('a CRLF copy of the same content is left alone: nothing is rewritten and nothing is pending', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    for (const f of listOrgai(repo)) {
      const abs = join(repo, '.orgai', ...f.split('/'))
      writeFileSync(abs, readFileSync(abs, 'utf8').replace(/\r?\n/g, '\r\n'), 'utf8')
    }
    const mtimes = Object.fromEntries(listOrgai(repo).map((f) => [f, statSync(join(repo, '.orgai', ...f.split('/'))).mtimeMs]))
    const s = c.svc.check(p.id)
    expect(s.state).toBe('in-sync')
    expect(s.changes).toEqual([])
    // A save of another role rewrites that role only; the CRLF files of equal content stay as they are.
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'Changed.' }))
    const now = Object.fromEntries(listOrgai(repo).map((f) => [f, statSync(join(repo, '.orgai', ...f.split('/'))).mtimeMs]))
    for (const f of Object.keys(mtimes)) if (f !== 'agents/reviewer.md') expect(now[f]).toBe(mtimes[f])
    expect(readOrgai(c, 'agents/implementer.md')).toContain('\r\n')
  })

  it('never writes a secret value into any file', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const id = 'mcp-docs'
    c.projects.update(p.id, (x) => ({
      ...x,
      mcpServers: [{ id, name: 'docs', transport: 'http', url: 'https://docs.example.com/mcp', secretHeaders: ['Authorization'], enabled: true, source: 'user', addedAt: '' }]
    }))
    c.secrets.set(`mcp:${p.id}:${id}:header:Authorization`, 'Bearer sk-supersecretvalue1234567890')
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'again' }))
    for (const f of listOrgai(repo)) expect(readOrgai(c, f)).not.toContain('supersecretvalue')
    expect(readOrgai(c, 'mcp.json')).toContain('Authorization')
    expect(readOrgai(c, 'mcp.json')).toContain('https://docs.example.com/mcp')
  })

  it('leaves a credential-shaped server out of mcp.json with a note, and it survives an ingest', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    c.projects.update(p.id, (x) => ({
      ...x,
      mcpServers: [
        { id: 'mcp-ok', name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp@1.0.0'], enabled: true, source: 'user', addedAt: '' },
        { id: 'mcp-local', name: 'local-one', transport: 'stdio', command: 'npx', args: ['-y', 'x@1.0.0', '--token=abcdefgh1234567890'], enabled: true, source: 'user', addedAt: '' }
      ],
      roles: x.roles.map((r) => (r.slug === 'reviewer' ? { ...r, mcpServers: ['mcp-local'] } : r))
    }))
    expect(readOrgai(c, 'mcp.json')).toContain('docs-mcp')
    expect(readOrgai(c, 'mcp.json')).not.toContain('abcdefgh1234567890')
    expect(c.svc.check(p.id).notes.join(' ')).toContain('local-one')
    // A change that comes from the files (a prompt edited by hand, applied at once) must keep the local server and its grant.
    writeFileSync(rolePath(c, 'implementer'), readFileSync(rolePath(c, 'implementer'), 'utf8').replace('You are a senior', 'You are a very senior'), 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('in-sync')
    const stored = c.projects.get(p.id)!
    expect(stored.roles.find((r) => r.slug === 'implementer')!.prompt).toContain('very senior')
    expect(stored.mcpServers!.map((m) => m.name).sort()).toEqual(['docs', 'local-one'])
    const reviewer = stored.roles.find((r) => r.slug === 'reviewer')!
    expect(reviewer.mcpServers).toContain('mcp-local')
  })

  it('a write that fails never fails the save; the change is written at the next check', () => {
    let fail = false
    const d = makeComputer(root, 'flaky', repo, {
      writeFiles: (...a) => (fail ? { written: [], removed: [], skipped: a[1].map((f) => f.path) } : writeTeamFiles(...a))
    })
    const p = createProject(d)
    d.svc.status(p.id)
    fail = true
    const saved = setRole(d, p.id, 'reviewer', () => ({ prompt: 'Saved while the folder refuses writes.' }))
    expect(saved.roles.find((r) => r.slug === 'reviewer')!.prompt).toBe('Saved while the folder refuses writes.')
    expect(readOrgai(d, 'agents/reviewer.md')).not.toContain('Saved while')
    fail = false
    const s = d.svc.check(p.id)
    expect(readOrgai(d, 'agents/reviewer.md')).toContain('Saved while the folder refuses writes.')
    expect(s.state).toBe('in-sync')
    expect(d.projects.get(p.id)!.roles.find((r) => r.slug === 'reviewer')!.prompt).toBe('Saved while the folder refuses writes.')
  })

  it('blocked teams (a role name that cannot be a file name) are not written and show a problem', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const before = readOrgai(c, 'team.json')
    c.projects.update(p.id, (x) => ({ ...x, roles: x.roles.map((r) => (r.slug === 'reviewer' ? { ...r, slug: 'Not A Slug' } : r)) }))
    expect(readOrgai(c, 'team.json')).toBe(before)
    expect(listOrgai(repo)).toContain('agents/reviewer.md')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('problem')
    expect(s.problems[0].message).toContain('file name')
  })
})

describe('what the folder says', () => {
  it('an edit that lowers power applies at once with one Undo; raising power waits for approval', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const file = rolePath(c, 'reviewer')
    // Raise power: Bash for the reviewer.
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain('- "Bash"')
    writeFileSync(file, text.replace(/tools:\n/, 'tools:\n  - "Bash"\n'), 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    expect(s.changes.map((x) => x.kind)).toContain('role')
    expect(c.projects.get(p.id)!.roles.find((r) => r.slug === 'reviewer')!.tools).not.toContain('Bash')
    // Runs keep the old tools and get one warning.
    const run = c.svc.beforeRun(c.projects.get(p.id)!)
    expect(run.warning).toContain('waiting for your approval')
    expect(run.project.roles.find((r) => r.slug === 'reviewer')!.tools).not.toContain('Bash')
    // A stale digest is refused, the current one is accepted.
    expect(() => c.svc.approve({ projectId: p.id, digest: 'a'.repeat(64) })).toThrow(STALE_MESSAGE)
    const done = c.svc.approve({ projectId: p.id, digest: s.digest! })
    expect(done.status.state).toBe('in-sync')
    expect(done.project.roles.find((r) => r.slug === 'reviewer')!.tools).toContain('Bash')
    expect(done.status.undo).toBeDefined()
  })

  it('reject keeps the last approved team until the files change', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const file = rolePath(c, 'reviewer')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/tools:\n/, 'tools:\n  - "Bash"\n'), 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    const r = c.svc.reject({ projectId: p.id, digest: s.digest! })
    expect(r.status.state).toBe('rejected')
    expect(c.svc.beforeRun(c.projects.get(p.id)!).warning).toBeUndefined()
    expect(c.svc.check(p.id).state).toBe('rejected')
    // The files change again: the rejection no longer applies.
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nExtra line.\n`, 'utf8')
    expect(c.svc.check(p.id).state).toBe('pending')
  })

  it('a pending tools change survives a local prompt edit of the same file; the save itself is approved and written', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const file = rolePath(c, 'reviewer')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/tools:\n/, 'tools:\n  - "Bash"\n'), 'utf8')
    expect(c.svc.check(p.id).state).toBe('pending')
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'A locally edited prompt.' }))
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('A locally edited prompt.')
    expect(text).toContain('"Bash"')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    const stored = c.projects.get(p.id)!.roles.find((r) => r.slug === 'reviewer')!
    expect(stored.prompt).toBe('A locally edited prompt.')
    expect(stored.tools).not.toContain('Bash')
  })

  it('an agent that edits its own role file during a run hits the gate', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const file = rolePath(c, 'implementer')
    // The file gains a Spawn right it did not have before.
    writeFileSync(file, readFileSync(file, 'utf8').replace('canSpawn: false', 'canSpawn: true'), 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    expect(c.projects.get(p.id)!.roles.find((r) => r.slug === 'implementer')!.canSpawn).toBe(false)
  })

  it('a deleted leaf role file is a removal; a deleted manager file is a problem and the team stays', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    rmSync(rolePath(c, 'researcher'))
    const s1 = c.svc.check(p.id)
    expect(s1.state).toBe('in-sync')
    expect(c.projects.get(p.id)!.roles.some((r) => r.slug === 'researcher')).toBe(false)
    rmSync(rolePath(c, 'orchestrator'))
    const s2 = c.svc.check(p.id)
    expect(s2.state).toBe('problem')
    expect(c.projects.get(p.id)!.roles.some((r) => r.slug === 'orchestrator')).toBe(true)
  })

  it('team.json deleted with agents present is a problem and nothing is overwritten', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    rmSync(join(repo, '.orgai', 'team.json'))
    const s = c.svc.check(p.id)
    expect(s.state).toBe('problem')
    expect(s.problems.some((x) => x.file === TEAM_FILES_JSON)).toBe(true)
    expect(listOrgai(repo)).not.toContain('team.json')
    expect(c.projects.get(p.id)!.roles.length).toBeGreaterThan(1)
  })

  it('a file that does not parse is a problem naming it; the team stays and a later save does not overwrite it', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const file = rolePath(c, 'reviewer')
    const broken = '<<<<<<< ours\nname: x\n=======\nname: y\n>>>>>>> theirs\n'
    writeFileSync(file, broken, 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('problem')
    expect(s.problems.map((x) => x.file)).toContain('.orgai/agents/reviewer.md')
    expect(() => c.svc.approve({ projectId: p.id, digest: s.digest ?? 'a'.repeat(64) })).toThrow()
    setRole(c, p.id, 'implementer', () => ({ prompt: 'Another change.' }))
    expect(readFileSync(file, 'utf8')).toBe(broken)
    expect(readOrgai(c, 'agents/implementer.md')).toContain('Another change.')
    expect(c.projects.get(p.id)!.roles.some((r) => r.slug === 'reviewer')).toBe(true)
  })

  it('a branch without .orgai keeps the team (problem); a real save then writes the full set', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    rmSync(join(repo, '.orgai'), { recursive: true })
    const s = c.svc.check(p.id)
    expect(s.state).toBe('problem')
    expect(c.projects.get(p.id)!.roles.length).toBeGreaterThan(1)
    expect(listOrgai(repo)).toEqual([])
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'Saved on a branch without files.' }))
    expect(listOrgai(repo)).toContain('team.json')
    expect(listOrgai(repo).filter((f) => f.startsWith('agents/')).length).toBe(c.projects.get(p.id)!.roles.length)
    expect(c.svc.check(p.id).state).toBe('in-sync')
  })

  it('a stale save built from an older copy keeps a change pulled into the folder', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const old = c.projects.get(p.id)!
    const file = rolePath(c, 'implementer')
    writeFileSync(file, readFileSync(file, 'utf8').replace('You are a senior', 'You are a pulled'), 'utf8')
    c.svc.check(p.id)
    expect(c.projects.get(p.id)!.roles.find((r) => r.slug === 'implementer')!.prompt).toContain('pulled')
    // The renderer still holds `old`: it saves a new brief.
    const saved = c.projects.saveFromRenderer({ ...old, brief: 'A new brief' })
    expect(saved.brief).toBe('A new brief')
    expect(saved.roles.find((r) => r.slug === 'implementer')!.prompt).toContain('pulled')
    expect(readOrgai(c, 'agents/implementer.md')).toContain('pulled')
    expect(readOrgai(c, 'team.json')).toContain('A new brief')
    expect(c.svc.check(p.id).state).toBe('in-sync')
  })

  it('Undo restores the previous team, rewrites the files and says which', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const file = rolePath(c, 'implementer')
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, original.replace('You are a senior', 'You are a pulled'), 'utf8')
    const s = c.svc.check(p.id)
    expect(s.applied.length).toBe(1)
    expect(s.undo?.files).toEqual(['.orgai/agents/implementer.md'])
    const u = c.svc.undo({ projectId: p.id })
    expect(u.project.roles.find((r) => r.slug === 'implementer')!.prompt).toContain('You are a senior')
    expect(readFileSync(file, 'utf8')).toBe(original)
    expect(u.status.undo).toBeUndefined()
    expect(u.status.lastUndo?.files).toEqual(['.orgai/agents/implementer.md'])
    expect(u.status.state).toBe('in-sync')
    expect(() => c.svc.undo({ projectId: p.id })).toThrow(/nothing to undo/)
  })

  it('a local change clears the Undo of an earlier one', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const file = rolePath(c, 'implementer')
    writeFileSync(file, readFileSync(file, 'utf8').replace('You are a senior', 'You are a pulled'), 'utf8')
    expect(c.svc.check(p.id).undo).toBeDefined()
    setRole(c, p.id, 'reviewer', () => ({ prompt: 'Local.' }))
    expect(c.svc.check(p.id).undo).toBeUndefined()
  })
})

describe('skills and servers', () => {
  it('a skill added in the project is written as a folder; a changed file is a gated change that stores the copy', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    c.skills.create({ projectId: p.id, draft: { name: 'code-style', description: 'Use when styling code.', body: '# Style\n\nTwo spaces.' } })
    expect(listOrgai(repo)).toContain('skills/code-style/SKILL.md')
    expect(readOrgai(c, 'skills/code-style/SKILL.md')).toContain('Two spaces.')
    // A script file added next to it by someone else is a gated change (skills can ship scripts).
    writeFileSync(join(repo, '.orgai', 'skills', 'code-style', 'run.sh'), '#!/bin/sh\necho hi\n', 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    expect(s.changes.some((x) => x.kind === 'skill' && (x.scripts ?? []).includes('run.sh'))).toBe(true)
    const done = c.svc.approve({ projectId: p.id, digest: s.digest! })
    expect(done.status.state).toBe('in-sync')
    const spec = c.projects.get(p.id)!.skills!.find((x) => x.name === 'code-style')!
    expect(spec.files.map((f) => f.path)).toContain('run.sh')
    expect(c.skills.teamReadFiles(p.id, spec)!.some((f) => f.path === 'run.sh')).toBe(true)
  })

  it('a linked skill is written as a copy; a changed file drops the link and stores the file\'s copy; the library entry is untouched', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    c.skills.libraryCreate({ name: 'house-style', description: 'Use for house style.', body: 'Original body.' })
    const lib = c.skills.libraryList()[0].entry
    c.skills.linkLibrary({ projectId: p.id, libraryId: lib.id })
    expect(readOrgai(c, 'skills/house-style/SKILL.md')).toContain('Original body.')
    const file = join(repo, '.orgai', 'skills', 'house-style', 'SKILL.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('Original body.', 'Edited in the file.'), 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    expect(c.projects.get(p.id)!.skills![0].libraryId).toBe(lib.id)
    c.svc.approve({ projectId: p.id, digest: s.digest! })
    const spec = c.projects.get(p.id)!.skills!.find((x) => x.name === 'house-style')!
    expect(spec.libraryId).toBeUndefined()
    expect(spec.source).toBe('repo')
    expect(c.skills.teamReadFiles(p.id, spec)!.find((f) => f.path === 'SKILL.md')!.data.toString()).toContain('Edited in the file.')
    expect(c.skills.libraryRead({ libraryId: lib.id }).body).toContain('Original body.')
  })

  it('a fromLibrary server links the library entry with the same name and identical definition, else keeps a project copy', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    c.library.push({ id: 'mcpl-docs', name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp@1.0.0'], source: 'user', addedAt: '' } as never)
    const file = join(repo, '.orgai', 'mcp.json')
    const servers = [
      { name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp@1.0.0'], enabled: true, fromLibrary: true },
      { name: 'other', transport: 'stdio', command: 'npx', args: ['-y', 'other-mcp@1.0.0'], enabled: true, fromLibrary: true }
    ]
    writeFileSync(file, `${JSON.stringify({ format: 'orgai.team/1', servers }, null, 2)}\n`, 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    c.svc.approve({ projectId: p.id, digest: s.digest! })
    const by = Object.fromEntries(c.projects.get(p.id)!.mcpServers!.map((m) => [m.name, m]))
    expect(by.docs.libraryId).toBe('mcpl-docs')
    expect(by.other.libraryId).toBeUndefined()
    expect(by.other.command).toBe('npx')
  })

  it('a pulled url change gets a new server id and never carries this computer\'s secrets to the new target', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    c.projects.update(p.id, (x) => ({
      ...x,
      mcpServers: [{ id: 'mcp-wiki', name: 'wiki', transport: 'http', url: 'https://wiki.example.com/mcp', secretHeaders: ['Authorization'], enabled: true, source: 'user', addedAt: '' }]
    }))
    c.secrets.set(`mcp:${p.id}:mcp-wiki:header:Authorization`, 'Bearer mine')
    const file = join(repo, '.orgai', 'mcp.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('https://wiki.example.com/mcp', 'https://evil.example.net/mcp'), 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    expect(s.changes.some((x) => x.kind === 'mcp' && (x.target ?? '').includes('evil.example.net'))).toBe(true)
    // Before approval the old server and its secret are untouched.
    expect(c.projects.get(p.id)!.mcpServers![0].url).toBe('https://wiki.example.com/mcp')
    expect(c.secrets.get(`mcp:${p.id}:mcp-wiki:header:Authorization`)).toBe('Bearer mine')
    c.svc.approve({ projectId: p.id, digest: s.digest! })
    const server = c.projects.get(p.id)!.mcpServers!.find((m) => m.name === 'wiki')!
    expect(server.url).toBe('https://evil.example.net/mcp')
    expect(server.id).not.toBe('mcp-wiki')
    expect([...c.secrets.keys()].filter((k) => k.includes(`:${server.id}:`))).toEqual([])
    expect([...c.secrets.keys()].filter((k) => k.includes(':mcp-wiki:'))).toEqual([])
  })

  it('the same launch keeps the server id and its secrets when only the description changes', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    c.projects.update(p.id, (x) => ({
      ...x,
      mcpServers: [{ id: 'mcp-wiki', name: 'wiki', transport: 'http', url: 'https://wiki.example.com/mcp', secretHeaders: ['Authorization'], enabled: true, source: 'user', addedAt: '' }]
    }))
    c.secrets.set(`mcp:${p.id}:mcp-wiki:header:Authorization`, 'Bearer mine')
    const file = join(repo, '.orgai', 'mcp.json')
    const j = JSON.parse(readFileSync(file, 'utf8')) as { servers: { description?: string }[] }
    j.servers[0].description = 'Company wiki'
    writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`, 'utf8')
    const s = c.svc.check(p.id)
    expect(s.state).toBe('in-sync')
    const server = c.projects.get(p.id)!.mcpServers!.find((m) => m.name === 'wiki')!
    expect(server.id).toBe('mcp-wiki')
    expect(server.description).toBe('Company wiki')
    expect(c.secrets.get(`mcp:${p.id}:mcp-wiki:header:Authorization`)).toBe('Bearer mine')
  })

  it('a connector server links the library entry of that connector, never using the file url', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    c.library.push({ id: 'mcpl-gh', name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', enabled: true, source: 'user', addedAt: '', connectorId: 'github', connectorVariant: 'app-readonly' } as never)
    const file = join(repo, '.orgai', 'mcp.json')
    writeFileSync(
      file,
      `${JSON.stringify({ format: 'orgai.team/1', servers: [{ name: 'github', transport: 'http', url: 'https://evil.example.net/x', enabled: true, connectorId: 'github', connectorVariant: 'app-readonly' }] }, null, 2)}\n`,
      'utf8'
    )
    const s = c.svc.check(p.id)
    expect(s.state).toBe('pending')
    c.svc.approve({ projectId: p.id, digest: s.digest! })
    const server = c.projects.get(p.id)!.mcpServers!.find((m) => m.name === 'github')!
    expect(server.libraryId).toBe('mcpl-gh')
    expect(server.url).toBe('https://api.githubcopilot.com/mcp/')
  })
})

describe('ownership, kinds and removal', () => {
  it('two projects on one folder: the older owns the files; the other is off and writes nothing', () => {
    const a = createProject(c)
    c.svc.status(a.id)
    const second = c.projects.create({ name: 'Second', path: repo, brief: '' }, undefined, {})
    const s = c.svc.status(second.id)
    expect(s.state).toBe('off')
    expect(s.offReason).toBe('shared-folder')
    expect(s.sharedWith?.projectId).toBe(a.id)
    const before = Object.fromEntries(listOrgai(repo).map((f) => [f, readOrgai(c, f)]))
    setRole(c, second.id, 'reviewer', () => ({ prompt: 'Second project change.' }))
    expect(Object.fromEntries(listOrgai(repo).map((f) => [f, readOrgai(c, f)]))).toEqual(before)
    expect(c.svc.beforeRun(c.projects.get(second.id)!).warning).toBeUndefined()
  })

  it('when the owner is removed the next project becomes owner and goes through first-seen', () => {
    const a = createProject(c)
    c.svc.status(a.id)
    const second = c.projects.create({ name: 'Second', path: repo, brief: '' }, undefined, {})
    setRole(c, a.id, 'reviewer', () => ({ prompt: 'The owner changed this.' }))
    expect(c.svc.status(second.id).offReason).toBe('shared-folder')
    c.projects.remove(a.id)
    removeProjectData(c.data, a.id)
    const s = c.svc.status(second.id)
    expect(s.state).toBe('pending')
    expect(s.firstSeen).toBe(true)
    expect(s.changes.some((x) => x.kind === 'role' && x.name.toLowerCase().includes('reviewer'))).toBe(true)
    // First-seen is everything: the cache is untouched until the user approves.
    expect(c.projects.get(second.id)!.roles.find((r) => r.slug === 'reviewer')!.prompt).not.toContain('The owner changed')
    c.svc.approve({ projectId: second.id, digest: s.digest! })
    expect(c.projects.get(second.id)!.roles.find((r) => r.slug === 'reviewer')!.prompt).toContain('The owner changed')
  })

  it('engagement projects write nothing in the folder, ever', () => {
    const p = c.projects.create({ name: 'Eng', path: repo, brief: '', kind: 'engagement' }, undefined, {})
    for (let i = 0; i < 2; i++) {
      expect(c.svc.status(p.id).offReason).toBe('engagement')
      expect(c.svc.beforeRun(p).warning).toBeUndefined()
      c.projects.update(p.id, (x) => ({ ...x, brief: `brief ${i}`, roles: x.roles.map((r) => ({ ...r, prompt: `changed ${i}` })) }))
    }
    expect(listOrgai(repo)).toEqual([])
    expect(() => c.svc.approve({ projectId: p.id, digest: 'a'.repeat(64) })).toThrow()
  })

  it('virtual projects are refused and never touch a folder', () => {
    expect(() => c.svc.check('quick')).toThrow(/not found/i)
    expect(() => c.svc.check('harness')).toThrow(/not found/i)
    const ghost = { ...newProject({ name: 'x', path: repo, brief: '' }), id: 'quick' }
    expect(c.svc.beforeSave(ghost, ghost)).toBe(ghost)
    expect(c.svc.beforeRun(ghost).project).toBe(ghost)
    expect(listOrgai(repo)).toEqual([])
  })

  it('a missing project folder is off (no-folder)', () => {
    const p = createProject(c, { path: join(root, 'not-yet') } as never)
    expect(c.svc.check(p.id).offReason).toBe('no-folder')
  })

  it('removing a project removes everything remembered about its team files', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    expect(statSync(join(c.data, 'projects', p.id, 'team-files', 'approved.json')).isFile()).toBe(true)
    removeProjectData(c.data, p.id)
    expect(() => statSync(join(c.data, 'projects', p.id))).toThrow()
  })

  it('remembering is tolerant: junk in the data folder means no snapshot, not a throw', () => {
    const p = createProject(c)
    c.svc.status(p.id)
    const dir = join(c.data, 'projects', p.id, 'team-files')
    writeFileSync(join(dir, 'approved.json'), '{ not json', 'utf8')
    writeFileSync(join(dir, 'state.json'), '[1,2', 'utf8')
    // No snapshot but files present: the cache is the baseline and the files in the folder equal it.
    const fresh = makeComputer(root, 'a2', repo)
    void fresh
    const s = c.svc.check(p.id)
    expect(['in-sync', 'pending']).toContain(s.state)
  })
})

describe('digest', () => {
  it('is the digest of the parsed team, so two projects with the same team have the same digest', () => {
    const p = createProject(c)
    const s = c.svc.status(p.id)
    const found = c.svc.found(repo, { isDirectory: true })
    expect(found?.digest).toBe(s.digest)
    expect(teamDigest({ settings: { brief: '', permissionMode: 'default' }, roles: [], skills: [], mcp: [] })).toMatch(/^[0-9a-f]{64}$/)
  })
})
