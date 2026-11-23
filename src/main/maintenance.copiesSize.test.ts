import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Project } from '@shared/types'
import { FINISHED_COPIES_WALK_MAX_ENTRIES } from '@shared/types'
import { MaintenanceService, walkCopyBytes } from './maintenance'
import type { ProjectStore } from './store/projects'

let root: string
let outside: string

function git(cwd: string, args: string): string {
  return execSync(`git -c user.name=OrgAI-Test -c user.email=test@orgai.local ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function put(dir: string, rel: string, content: string | Buffer): void {
  const full = join(dir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function addCopy(id: string): string {
  const rel = `.claude/worktrees/agent-${id}`
  git(root, `worktree add -q -b worktree-agent-${id} ${rel}`)
  return join(root, rel)
}

function service(extra: Record<string, unknown> = {}): MaintenanceService {
  const project = { id: 'p1', name: 'Demo', path: root, roles: [], ...extra } as unknown as Project
  return new MaintenanceService({ get: () => project, list: () => [project] } as unknown as ProjectStore)
}

/** True when this machine lets the test make a directory link without elevation. */
function tryLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  }
}

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-copysize-')))
  outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-copysize-out-')))
  git(root, 'init -q -b main')
  put(root, 'README.md', 'x\n')
  put(root, '.git/info/exclude', '.claude/\n')
  git(root, 'add -A')
  git(root, 'commit -q -m init')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('finishedCopiesSize', () => {
  it('is empty for a project with no finished copy', async () => {
    expect(await service().finishedCopiesSize('p1')).toEqual({ count: 0, bytes: 0, truncated: false })
  })

  it('counts the copies and the bytes of their regular files, leaving each .git link out', async () => {
    const a = addCopy('a')
    const b = addCopy('b')
    put(a, 'one.bin', Buffer.alloc(1000))
    put(a, 'deep/er/two.bin', Buffer.alloc(2500))
    put(b, 'three.bin', Buffer.alloc(40))
    const tracked = statSync(join(a, 'README.md')).size * 2 // README.md is checked out into both copies (its size depends on autocrlf)
    const res = await service().finishedCopiesSize('p1')
    expect(res).toEqual({ count: 2, bytes: 1000 + 2500 + 40 + tracked, truncated: false })
    // The same list listWorktrees gives.
    expect((await service().listWorktrees('p1')).length).toBe(res.count)
  })

  it('does not count a copy nested inside another one twice', async () => {
    const parent = addCopy('par')
    put(parent, 'p.bin', Buffer.alloc(100))
    git(parent, 'add -A')
    git(parent, 'commit -q -m p')
    git(parent, `worktree add -q -b worktree-agent-kid .claude/worktrees/agent-kid`)
    put(join(parent, '.claude/worktrees/agent-kid'), 'k.bin', Buffer.alloc(7000))
    const res = await service().finishedCopiesSize('p1')
    expect(res.count).toBe(2)
    // README (2) + p.bin (100) in the parent; README + p.bin + k.bin in the child; nothing twice.
    const readme = statSync(join(parent, 'README.md')).size
    expect(res.bytes).toBe(readme + 100 + readme + 100 + 7000)
  })

  it('never follows a link out of a copy', async (ctx) => {
    const copy = addCopy('lnk')
    put(outside, 'huge.bin', Buffer.alloc(50_000))
    if (!tryLink(outside, join(copy, 'escape'))) ctx.skip()
    put(copy, 'real.bin', Buffer.alloc(10))
    const res = await service().finishedCopiesSize('p1')
    expect(res.bytes).toBe(10 + statSync(join(copy, 'README.md')).size)
    expect(res.truncated).toBe(false)
  })

  it('is empty for an engagement and for a folder that is not a git repository', async () => {
    addCopy('x')
    expect(await service({ kind: 'engagement' }).finishedCopiesSize('p1')).toEqual({ count: 0, bytes: 0, truncated: false })
    const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-copysize-plain-')))
    try {
      put(plain, 'a.txt', 'abc')
      const project = { id: 'p2', name: 'Plain', path: plain, roles: [] } as unknown as Project
      const svc = new MaintenanceService({ get: () => project, list: () => [project] } as unknown as ProjectStore)
      expect(await svc.finishedCopiesSize('p2')).toEqual({ count: 0, bytes: 0, truncated: false })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('throws for an unknown project like the other maintenance calls', async () => {
    const svc = new MaintenanceService({ get: () => undefined, list: () => [] } as unknown as ProjectStore)
    await expect(svc.finishedCopiesSize('nope')).rejects.toThrow(/Project not found/)
  })
})

describe('walkCopyBytes', () => {
  it('stops at the entry budget and says so, with a lower bound', () => {
    const dir = join(outside, 'tree')
    for (let i = 0; i < 10; i++) put(dir, `f${i}.bin`, Buffer.alloc(100))
    const full = walkCopyBytes(dir, { left: 100 })
    expect(full).toEqual({ bytes: 1000, truncated: false })
    const cut = walkCopyBytes(dir, { left: 4 })
    expect(cut.truncated).toBe(true)
    expect(cut.bytes).toBe(400)
    // Exactly as many entries as the budget is not truncated.
    expect(walkCopyBytes(dir, { left: 10 })).toEqual({ bytes: 1000, truncated: false })
  })

  it('shares one budget across calls and counts links and folders as entries', () => {
    const a = join(outside, 'a')
    const b = join(outside, 'b')
    put(a, 'x/y/z.bin', Buffer.alloc(5))
    put(b, 'q.bin', Buffer.alloc(5))
    const budget = { left: 3 }
    expect(walkCopyBytes(a, budget)).toEqual({ bytes: 5, truncated: false })
    expect(budget.left).toBe(0)
    expect(walkCopyBytes(b, budget)).toMatchObject({ truncated: true })
  })

  it('skips the copy\'s own .git entry only at its root', () => {
    const dir = join(outside, 'withgit')
    put(dir, '.git', 'gitdir: /somewhere\n')
    put(dir, 'sub/.git/config', 'c'.repeat(30))
    put(dir, 'f.bin', Buffer.alloc(8))
    expect(walkCopyBytes(dir, { left: 100 })).toEqual({ bytes: 38, truncated: false })
  })
})

describe('finishedCopiesSize truncation', () => {
  it('reports truncated with a lower bound when the entry budget runs out, and stops walking', async () => {
    const a = addCopy('t1')
    const b = addCopy('t2')
    for (let i = 0; i < 20; i++) put(a, `f${i}.bin`, Buffer.alloc(10))
    put(b, 'late.bin', Buffer.alloc(1_000_000))
    const project = { id: 'p1', name: 'Demo', path: root, roles: [] } as unknown as Project
    const svc = new MaintenanceService({ get: () => project, list: () => [project] } as unknown as ProjectStore, undefined, { walkMaxEntries: 8 })
    const res = await svc.finishedCopiesSize('p1')
    expect(res.truncated).toBe(true)
    expect(res.count).toBe(2)
    expect(res.bytes).toBeLessThan(1_000_000)
  })

  it('uses the contract maximum by default', async () => {
    expect(FINISHED_COPIES_WALK_MAX_ENTRIES).toBe(200_000)
    addCopy('d1')
    expect((await service().finishedCopiesSize('p1')).truncated).toBe(false)
  })
})
