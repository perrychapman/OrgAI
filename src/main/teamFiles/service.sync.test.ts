import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitAll, createFromFolder, createProject, git, initRepo, makeComputer, readOrgai, rolePath, setRole, tryGit, type Computer } from './service.fixture'
import { STALE_MESSAGE } from './service'
import { integrateWorktree } from '../runtime/worktrees'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

/**
 * Two "computers": two clones of one bare repository, each with its own data folder and service. Real git, no tokens.
 */

let root: string
let origin: string
let A: Computer
let B: Computer

function clone(name: string, ...config: string[]): string {
  const dir = join(root, `clone-${name}`)
  git(root, ...config.flatMap((c) => ['-c', c]), 'clone', '-q', origin, dir)
  git(dir, 'config', 'user.name', name)
  git(dir, 'config', 'user.email', `${name}@example.com`)
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-sync-'))
  origin = join(root, 'origin.git')
  mkdirSync(origin)
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  const seed = join(root, 'seed')
  initRepo(seed)
  writeFileSync(join(seed, 'README.md'), '# demo\n', 'utf8')
  commitAll(seed, 'init')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', 'origin', 'main')
  A = makeComputer(root, 'a', clone('a'))
  B = makeComputer(root, 'b', clone('b'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function publish(c: Computer, message: string): void {
  commitAll(c.repo, message)
  git(c.repo, 'push', '-q', 'origin', 'main')
}

function pull(c: Computer): void {
  git(c.repo, 'pull', '-q', '--no-rebase', 'origin', 'main')
}

/** Computer A migrates, commits and pushes; B pulls and creates its project from the folder. */
function bootstrap(): { a: string; b: string } {
  const pa = createProject(A)
  A.svc.status(pa.id)
  publish(A, 'team files')
  pull(B)
  const pb = createFromFolder(B)
  return { a: pa.id, b: pb.id }
}

describe('team files between two computers', () => {
  it('a New project created from the preview has nothing pending, and has no default roles', () => {
    const { a, b } = bootstrap()
    const sb = B.svc.status(b)
    expect(sb.state).toBe('in-sync')
    expect(sb.changes).toEqual([])
    expect(sb.firstSeen).toBeUndefined()
    expect(B.projects.get(b)!.roles.map((r) => r.slug).sort()).toEqual(A.projects.get(a)!.roles.map((r) => r.slug).sort())
    expect(B.svc.status(b).digest).toBe(A.svc.status(a).digest)
  })

  it('an existing project on B that never saw the files sees everything as first-seen pending', () => {
    createProject(A)
    const pa = A.projects.list()[0]
    A.svc.status(pa.id)
    setRole(A, pa.id, 'reviewer', () => ({ prompt: 'A reviewer prompt that A wrote.' }))
    publish(A, 'team files')
    pull(B)
    const pb = createProject(B)
    const s = B.svc.status(pb.id)
    expect(s.state).toBe('pending')
    expect(s.firstSeen).toBe(true)
    expect(B.projects.get(pb.id)!.roles.find((r) => r.slug === 'reviewer')!.prompt).not.toContain('that A wrote')
    expect(B.svc.beforeRun(B.projects.get(pb.id)!).warning).toContain('waiting for your approval')
  })

  it('a prompt change pulled from A is applied at once, and Undo restores it and lists the files', () => {
    const { a, b } = bootstrap()
    const original = readFileSync(rolePath(B, 'reviewer'), 'utf8')
    setRole(A, a, 'reviewer', () => ({ prompt: 'Review with great care.' }))
    publish(A, 'prompt')
    pull(B)
    const s = B.svc.check(b)
    expect(s.state).toBe('in-sync')
    expect(s.applied.length).toBe(1)
    expect(B.projects.get(b)!.roles.find((r) => r.slug === 'reviewer')!.prompt).toBe('Review with great care.')
    expect(B.updated.length).toBeGreaterThan(0)
    const u = B.svc.undo({ projectId: b })
    expect(B.projects.get(b)!.roles.find((r) => r.slug === 'reviewer')!.prompt).not.toBe('Review with great care.')
    expect(u.status.lastUndo?.files).toEqual(['.orgai/agents/reviewer.md'])
    const lf = (t: string): string => t.split('\r\n').join('\n')
    expect(lf(readFileSync(rolePath(B, 'reviewer'), 'utf8'))).toBe(lf(original))
    // The undone file shows as uncommitted in git.
    expect(tryGit(B.repo, 'status', '--porcelain').out).toContain('.orgai/agents/reviewer.md')
  })

  it('Bash added on A is pending on B; runs keep the old tools; stale approve is refused; approve works', () => {
    const { a, b } = bootstrap()
    setRole(A, a, 'reviewer', (r) => ({ tools: [...r.tools, 'Bash'] }))
    publish(A, 'bash')
    pull(B)
    const s = B.svc.check(b)
    expect(s.state).toBe('pending')
    expect(s.changes.length).toBe(1)
    expect(s.changes[0].elevatedAdded).toContain('Bash')
    const run = B.svc.beforeRun(B.projects.get(b)!)
    expect(run.warning).toContain('waiting for your approval')
    expect(run.project.roles.find((r) => r.slug === 'reviewer')!.tools).not.toContain('Bash')
    expect(() => B.svc.approve({ projectId: b, digest: '0'.repeat(64) })).toThrow(STALE_MESSAGE)
    const done = B.svc.approve({ projectId: b, digest: s.digest! })
    expect(done.status.state).toBe('in-sync')
    expect(done.project.roles.find((r) => r.slug === 'reviewer')!.tools).toContain('Bash')
    expect(B.svc.beforeRun(done.project).warning).toBeUndefined()
  })

  it('reject stays rejected until the files change', () => {
    const { a, b } = bootstrap()
    setRole(A, a, 'reviewer', (r) => ({ tools: [...r.tools, 'Bash'] }))
    publish(A, 'bash')
    pull(B)
    const s = B.svc.check(b)
    B.svc.reject({ projectId: b, digest: s.digest! })
    expect(B.svc.check(b).state).toBe('rejected')
    expect(B.svc.beforeRun(B.projects.get(b)!).warning).toBeUndefined()
    setRole(A, a, 'implementer', () => ({ prompt: 'Something else changed.' }))
    publish(A, 'more')
    pull(B)
    const s2 = B.svc.check(b)
    expect(s2.state).toBe('pending')
    // The prompt change applied at once; Bash is still the only thing waiting.
    expect(s2.changes.length).toBe(1)
  })

  it('a checkout with core.autocrlf=true has the same digest and nothing pending, and nothing is rewritten', () => {
    const { a } = bootstrap()
    const dir = clone('crlf', 'core.autocrlf=true')
    expect(readFileSync(join(dir, '.orgai', 'agents', 'reviewer.md'), 'utf8')).toContain('\r\n')
    const C = makeComputer(root, 'c', dir)
    const pc = createFromFolder(C)
    const s = C.svc.status(pc.id)
    expect(s.state).toBe('in-sync')
    expect(s.digest).toBe(A.svc.status(a).digest)
    const before = readFileSync(join(dir, '.orgai', 'agents', 'reviewer.md'), 'utf8')
    setRole(C, pc.id, 'implementer', () => ({ prompt: 'Changed on the CRLF checkout.' }))
    expect(readFileSync(join(dir, '.orgai', 'agents', 'reviewer.md'), 'utf8')).toBe(before)
    expect(C.svc.check(pc.id).state).toBe('in-sync')
  })

  it('a real merge conflict in a role file is a problem naming it; the team stays and a later save keeps the file', () => {
    const { a, b } = bootstrap()
    setRole(A, a, 'reviewer', () => ({ prompt: 'Prompt from A.' }))
    publish(A, 'A prompt')
    setRole(B, b, 'reviewer', () => ({ prompt: 'Prompt from B.' }))
    commitAll(B.repo, 'B prompt')
    const r = tryGit(B.repo, 'pull', '--no-rebase', 'origin', 'main')
    expect(r.ok).toBe(false)
    const file = rolePath(B, 'reviewer')
    expect(readFileSync(file, 'utf8')).toContain('<<<<<<<')
    const s = B.svc.check(b)
    expect(s.state).toBe('problem')
    expect(s.problems.map((p) => p.file)).toContain('.orgai/agents/reviewer.md')
    expect(B.projects.get(b)!.roles.find((x) => x.slug === 'reviewer')!.prompt).toBe('Prompt from B.')
    const conflicted = readFileSync(file, 'utf8')
    setRole(B, b, 'implementer', () => ({ prompt: 'Edited while the conflict stands.' }))
    expect(readFileSync(file, 'utf8')).toBe(conflicted)
    expect(readOrgai(B, 'agents/implementer.md')).toContain('Edited while the conflict stands.')
    expect(() => B.svc.approve({ projectId: b, digest: B.svc.check(b).digest ?? '0'.repeat(64) })).toThrow()
  })

  it('a branch without .orgai keeps the team and reports a problem', () => {
    const { b } = bootstrap()
    git(B.repo, 'checkout', '-q', '--orphan', 'bare')
    git(B.repo, 'rm', '-rfq', '.')
    writeFileSync(join(B.repo, 'other.txt'), 'x', 'utf8')
    commitAll(B.repo, 'a branch with no team')
    expect(existsSync(join(B.repo, '.orgai'))).toBe(false)
    const s = B.svc.check(b)
    expect(s.state).toBe('problem')
    expect(B.projects.get(b)!.roles.length).toBeGreaterThan(1)
  })

  it('a report merged through a real integrateWorktree hits the same gate', async () => {
    const { b } = bootstrap()
    const root2 = B.repo
    git(root2, 'worktree', 'add', '-q', '-b', 'worktree-agent-x', join(root2, '.claude', 'worktrees', 'agent-x'))
    const wt = join(root2, '.claude', 'worktrees', 'agent-x')
    const file = join(wt, '.orgai', 'agents', 'reviewer.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/tools:\r?\n/, 'tools:\n  - "Bash"\n'), 'utf8')
    const res = await integrateWorktree(root2, { path: wt, branch: 'worktree-agent-x', status: 'merging' }, 'report edits its own role')
    expect(res.info.status).toBe('merged')
    const s = B.svc.check(b)
    expect(s.state).toBe('pending')
    expect(B.projects.get(b)!.roles.find((r) => r.slug === 'reviewer')!.tools).not.toContain('Bash')
  })

  it('commit stages only the team files, never pushes, and says so when there is nothing to commit', async () => {
    const { b } = bootstrap()
    writeFileSync(join(B.repo, 'notes.txt'), 'mine', 'utf8')
    git(B.repo, 'add', 'notes.txt')
    setRole(B, b, 'reviewer', () => ({ prompt: 'Local team edit.' }))
    const st = await B.svc.withGit(B.svc.check(b))
    expect(st.uncommitted).toBe(true)
    expect(st.uncommittedFiles).toContain('.orgai/agents/reviewer.md')
    const head = git(B.repo, 'rev-parse', 'HEAD')
    const r = await B.svc.commit({ projectId: b })
    expect(r.ok).toBe(true)
    expect(r.committed).toEqual(['.orgai/agents/reviewer.md'])
    expect(r.status.uncommitted).toBe(false)
    expect(git(B.repo, 'show', '--name-only', '--format=%s', 'HEAD')).toBe('Update OrgAI team files\n\n.orgai/agents/reviewer.md')
    expect(git(B.repo, 'diff', '--cached', '--name-only')).toBe('notes.txt')
    expect(git(B.repo, 'rev-parse', 'origin/main')).toBe(head)
    const again = await B.svc.commit({ projectId: b })
    expect(again).toMatchObject({ ok: true, message: 'Nothing to commit.', committed: [] })
  })

  it('commit refuses a folder that is not a git repository', async () => {
    const dir = join(root, 'plain')
    mkdirSync(dir)
    const C = makeComputer(root, 'plain', dir)
    const p = createProject(C)
    C.svc.status(p.id)
    const r = await C.svc.commit({ projectId: p.id })
    expect(r.ok).toBe(false)
    expect(r.message).toBe('This folder is not a git repository, so there is nothing to commit to.')
  })
})
