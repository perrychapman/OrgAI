import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectCommitActivity } from '@shared/types'
import { bucketCommitDays, commitWindowStartMs, CommitActivityService, lastSevenLocalDays, localDayKey } from './commitActivity'
import { commitTimesArgs, gitCommitTimes, hasPlainGitDir, killProcessTree, readOnlyGitEnv } from '../runtime/worktrees'

const local = (y: number, m: number, d: number, h = 0, min = 0): number => Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000)

describe('bucketCommitDays', () => {
  const now = new Date(2026, 10, 20, 15, 0) // 20 Nov 2026 15:00 local

  it('returns seven local days, oldest first, today last', () => {
    const days = bucketCommitDays(now, [])
    expect(days.map((d) => d.date)).toEqual(['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'])
    expect(days.every((d) => d.commits === 0)).toBe(true)
  })

  it('splits at local midnight: 23:59 belongs to the earlier day, 00:00 to the next', () => {
    const days = bucketCommitDays(now, [local(2026, 11, 18, 23, 59), local(2026, 11, 19, 0, 0), local(2026, 11, 19, 0, 0)])
    expect(days.find((d) => d.date === '2026-11-18')?.commits).toBe(1)
    expect(days.find((d) => d.date === '2026-11-19')?.commits).toBe(2)
  })

  it('ignores commits before the window and after today', () => {
    const days = bucketCommitDays(now, [local(2026, 11, 13, 23, 59), local(2026, 11, 21, 0, 0), Number.NaN])
    expect(days.reduce((n, d) => n + d.commits, 0)).toBe(0)
    expect(commitWindowStartMs(now)).toBe(new Date(2026, 10, 14).getTime())
  })

  it('keeps seven distinct days across a DST change (calendar arithmetic, not 24 h steps)', () => {
    // Spring forward in the US/EU falls in March, fall back in late October / early November; sweep a whole year.
    for (let month = 0; month < 12; month++) {
      for (const day of [1, 8, 15, 22, 28]) {
        const d = new Date(2026, month, day, 12)
        const keys = lastSevenLocalDays(d).map(localDayKey)
        expect(new Set(keys).size).toBe(7)
        expect(keys[6]).toBe(localDayKey(d))
        const bucket = bucketCommitDays(d, lastSevenLocalDays(d).map((x) => Math.floor(x.getTime() / 1000) + 60))
        expect(bucket.map((b) => b.commits)).toEqual([1, 1, 1, 1, 1, 1, 1])
      }
    }
  })
})

describe('CommitActivityService (fake git)', () => {
  const code = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, path: `/p/${id}`, ...extra }) as Project
  const now = new Date(2026, 10, 20, 15, 0)

  it('returns code projects only, in order, with available false when git fails or the folder is untrusted', async () => {
    const commitTimes = vi.fn(async (root: string) => (root.endsWith('bad') ? { ok: false, times: [] } : { ok: true, times: [local(2026, 11, 20, 9, 0)] }))
    const svc = new CommitActivityService({
      listProjects: () => [code('a'), code('eng', { kind: 'engagement' } as Partial<Project>), code('bad'), code('locked')],
      folderTrusted: (p) => p.id !== 'locked',
      commitTimes,
      now: () => now
    })
    const out = await svc.activity()
    expect(out.map((o) => o.projectId)).toEqual(['a', 'bad', 'locked'])
    expect(out[0]).toMatchObject({ available: true, total: 1 })
    expect(out[0].days).toHaveLength(7)
    expect(out[1]).toMatchObject({ available: false, total: 0 })
    expect(out[2]).toMatchObject({ available: false, total: 0 })
    expect(out[2].days.every((d) => d.commits === 0)).toBe(true)
    expect(commitTimes).not.toHaveBeenCalledWith('/p/locked', expect.anything())
    expect(() => structuredClone(out)).not.toThrow()
  })

  it('caches for 60 s and caps projects at 50 and concurrency at 3', async () => {
    let running = 0
    let peak = 0
    const calls = vi.fn()
    const commitTimes = async (root: string): Promise<{ ok: boolean; times: number[] }> => {
      calls(root)
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { ok: true, times: [] }
    }
    const list = Array.from({ length: 55 }, (_, i) => code(`p${i}`))
    const svc = new CommitActivityService({ listProjects: () => list, folderTrusted: () => true, commitTimes, now: () => now })
    const first = await svc.activity()
    expect(first).toHaveLength(55)
    expect(first.slice(50).every((o) => !o.available)).toBe(true)
    expect(calls).toHaveBeenCalledTimes(50)
    expect(peak).toBeLessThanOrEqual(3)
    await svc.activity()
    expect(calls).toHaveBeenCalledTimes(50)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 61_000)
    try {
      await Promise.resolve()
      const p = svc.activity()
      await vi.runAllTimersAsync()
      await p
    } finally {
      vi.useRealTimers()
    }
    expect(calls).toHaveBeenCalledTimes(100)
  })

  it('reuses the pending run while a slow batch is still going, however long it takes (L4)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const started: string[] = []
      const gates: Array<() => void> = []
      const commitTimes = (root: string): Promise<{ ok: boolean; times: number[] }> => {
        started.push(root)
        return new Promise((resolve) => gates.push(() => resolve({ ok: true, times: [] })))
      }
      const list = Array.from({ length: 6 }, (_, i) => code(`s${i}`))
      const svc = new CommitActivityService({ listProjects: () => list, folderTrusted: () => true, commitTimes, now: () => now })
      const first = svc.activity()
      await Promise.resolve()
      await Promise.resolve()
      expect(started).toHaveLength(3) // concurrency 3, three more waiting
      vi.setSystemTime(Date.now() + 5 * 60_000) // far past the 60 s cache time while nothing has settled
      const second = svc.activity()
      await Promise.resolve()
      expect(started).toHaveLength(3) // not queued again
      while (gates.length) {
        gates.shift()?.()
        for (let i = 0; i < 5; i++) await Promise.resolve()
      }
      const [a, b] = await Promise.all([first, second])
      expect(started).toHaveLength(6) // each project ran once
      expect(a).toEqual(b)
      expect(a).toHaveLength(6)
      await svc.activity() // settled just now: still served from memory
      expect(started).toHaveLength(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives back the same answer shape when git throws', async () => {
    const svc = new CommitActivityService({
      listProjects: () => [code('boom')],
      folderTrusted: () => true,
      commitTimes: () => Promise.reject(new Error('x')),
      now: () => now
    })
    const out: ProjectCommitActivity[] = await svc.activity()
    expect(out).toEqual([{ projectId: 'boom', available: false, days: expect.any(Array), total: 0 }])
  })
})

describe('commit query environment and arguments', () => {
  it('pins GIT_DIR and the work tree, allows no transport, no lazy fetch, and keeps the system config', () => {
    const saved = { ...process.env }
    process.env.GIT_DIR = '/elsewhere'
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'core.pager'
    process.env.GIT_SSH_COMMAND = 'evil'
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    try {
      const root = join(tmpdir(), 'some-project')
      const env = readOnlyGitEnv(root)
      expect(Object.keys(env).filter((k) => k.toUpperCase().startsWith('GIT_')).sort()).toEqual([
        'GIT_ALLOW_PROTOCOL',
        'GIT_DIR',
        'GIT_NO_LAZY_FETCH',
        'GIT_NO_REPLACE_OBJECTS',
        'GIT_OPTIONAL_LOCKS',
        'GIT_PAGER',
        'GIT_TERMINAL_PROMPT',
        'GIT_WORK_TREE'
      ])
      expect(env).toMatchObject({ GIT_DIR: join(root, '.git'), GIT_WORK_TREE: root, GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'orgai-none', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_NO_REPLACE_OBJECTS: '1' })
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
  })

  it('ends the revision list with -- and asks for the commit time only', () => {
    const args = commitTimesArgs(Date.UTC(2026, 10, 14), 5000)
    expect(args.slice(-2)).toEqual(['HEAD', '--'])
    expect(args).toContain('--format=%ct')
    expect(args).toContain('--max-count=5000')
    expect(args.indexOf('log')).toBeGreaterThan(args.indexOf('--no-pager'))
  })
})

describe('killProcessTree', () => {
  it('win32: runs System32\\taskkill.exe /PID <pid> /T /F by absolute path with no shell, and kills the direct child if that cannot start', () => {
    const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
    let onError: (() => void) | undefined
    const fakeSpawn = ((file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts })
      return { on: (e: string, cb: () => void) => { if (e === 'error') onError = cb }, unref: () => undefined }
    }) as unknown as typeof spawn
    const kill = vi.fn(() => true)
    expect(killProcessTree({ pid: 4321, kill }, 'SIGKILL', { platform: 'win32', spawn: fakeSpawn })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toMatch(/^[A-Za-z]:\\.*\\System32\\taskkill\.exe$/)
    expect(calls[0].args).toEqual(['/PID', '4321', '/T', '/F'])
    expect(calls[0].opts).toMatchObject({ shell: false, windowsHide: true })
    expect(kill).not.toHaveBeenCalled()
    onError?.()
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('win32: a non-zero taskkill exit falls back to the direct kill, a zero exit does not', () => {
    const exits: Array<(code: number | null) => void> = []
    const fakeSpawn = (() => ({ on: (e: string, cb: (code: number | null) => void) => { if (e === 'exit') exits.push(cb) }, unref: () => undefined })) as unknown as typeof spawn
    const kill = vi.fn(() => true)
    killProcessTree({ pid: 10, kill }, 'SIGKILL', { platform: 'win32', spawn: fakeSpawn })
    exits[0](0)
    expect(kill).not.toHaveBeenCalled()
    killProcessTree({ pid: 11, kill }, 'SIGKILL', { platform: 'win32', spawn: fakeSpawn })
    exits[1](128)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('does not run a tree kill against a child that has already exited', () => {
    const spawnFn = vi.fn()
    const killGroup = vi.fn()
    const kill = vi.fn(() => true)
    for (const gone of [{ exitCode: 0 }, { signalCode: 'SIGKILL' as const }]) {
      killProcessTree({ pid: 99, kill, ...gone }, 'SIGKILL', { platform: 'win32', spawn: spawnFn as unknown as typeof spawn })
      killProcessTree({ pid: 99, kill, ...gone }, 'SIGKILL', { platform: 'linux', killGroup })
    }
    expect(spawnFn).not.toHaveBeenCalled()
    expect(killGroup).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('POSIX: signals the process group, and falls back to the direct child when that fails', () => {
    const killGroup = vi.fn()
    const kill = vi.fn(() => true)
    expect(killProcessTree({ pid: 77, kill }, 'SIGKILL', { platform: 'linux', killGroup })).toBe(true)
    expect(killGroup).toHaveBeenCalledWith(77, 'SIGKILL')
    expect(kill).not.toHaveBeenCalled()
    killProcessTree({ pid: 77, kill }, 'SIGTERM', { platform: 'linux', killGroup: () => { throw new Error('ESRCH') } })
    expect(kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('without a pid it only kills the direct child, and never throws', () => {
    const kill = vi.fn(() => { throw new Error('gone') })
    expect(killProcessTree({ kill })).toBe(false)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  describe('against a real process tree', () => {
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const wait = async (ok: () => boolean, ms = 8000): Promise<boolean> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (ok()) return true
        await new Promise((r) => setTimeout(r, 50))
      }
      return ok()
    }
    let dir: string
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'orgai-tree-'))
    })
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    // A parent that starts one grandchild (both sleep) and writes the grandchild's pid to a file.
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000)"
    const startTree = async (name: string): Promise<{ parent: ReturnType<typeof spawn>; grandchild: number }> => {
      const pidFile = join(dir, name)
      const parent = spawn(process.execPath, ['-e', script, pidFile], { windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32' })
      expect(await wait(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0)).toBe(true)
      return { parent, grandchild: Number(readFileSync(pidFile, 'utf8')) }
    }

    it('ends the grandchild too, where killing only the direct child leaves it running', async () => {
      const control = await startTree('control.pid')
      try {
        control.parent.kill()
        expect(await wait(() => !alive(control.parent.pid ?? 0))).toBe(true)
        expect(alive(control.grandchild)).toBe(true) // the direct kill left the grandchild behind
        const tree = await startTree('tree.pid')
        expect(killProcessTree(tree.parent)).toBe(true)
        expect(await wait(() => !alive(tree.grandchild))).toBe(true)
        expect(await wait(() => !alive(tree.parent.pid ?? 0))).toBe(true)
      } finally {
        try {
          process.kill(control.grandchild, 'SIGKILL') // the control's orphan
        } catch {
          /* already gone */
        }
      }
    }, 30_000)
  })
})

const GIT_OK = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!GIT_OK)('commit activity against real temporary repositories', () => {
  let base: string
  let repo: string
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
  const g = (cwd: string, args: string[], date?: string): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore', env: date ? { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : env })
  }
  const iso = (daysAgo: number, hour: number): string => {
    const d = new Date()
    d.setDate(d.getDate() - daysAgo)
    d.setHours(hour, 0, 0, 0)
    return d.toISOString()
  }
  const commit = (cwd: string, file: string, date: string): void => {
    writeFileSync(join(cwd, file), `${file}${date}`)
    g(cwd, ['add', '.'])
    g(cwd, ['commit', '-m', file, '--no-gpg-sign'], date)
  }

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'orgai-commits-'))
    repo = join(base, 'repo')
    mkdirSync(repo)
    g(repo, ['init', '-q'])
    g(repo, ['config', 'commit.gpgsign', 'false'])
    // Chronological order (git's --since stops walking at the first too-old commit, so history must not be skewed).
    commit(repo, 'old.txt', iso(10, 10))
    commit(repo, 'c.txt', iso(2, 10))
    // A merge commit on a side branch must not count (only its two parents' own commits do).
    g(repo, ['checkout', '-q', '-b', 'side'])
    commit(repo, 'side.txt', iso(1, 11))
    g(repo, ['checkout', '-q', '-'])
    commit(repo, 'main2.txt', iso(1, 12))
    g(repo, ['merge', '--no-ff', '-q', '-m', 'merge', 'side'], iso(1, 13))
    commit(repo, 'a.txt', iso(0, 8))
    commit(repo, 'b.txt', iso(0, 9))
  })

  afterAll(() => rmSync(base, { recursive: true, force: true }))

  it('counts commits per local day, leaves out merges and anything older than the window', async () => {
    const svc = new CommitActivityService({ listProjects: () => [{ id: 'r', name: 'r', path: repo } as Project], folderTrusted: () => true })
    const [r] = await svc.activity()
    expect(r.available).toBe(true)
    expect(r.days).toHaveLength(7)
    expect(r.days[6].commits).toBe(2)
    expect(r.days[5].commits).toBe(2) // side.txt and main2.txt, not the merge
    expect(r.days[4].commits).toBe(1)
    expect(r.total).toBe(5)
  })

  it('is unavailable for a folder that is not a repository, a missing folder and a repository without commits', async () => {
    const plain = join(base, 'plain')
    mkdirSync(plain)
    const empty = join(base, 'empty')
    mkdirSync(empty)
    g(empty, ['init', '-q'])
    for (const path of [plain, join(base, 'missing'), empty]) {
      const svc = new CommitActivityService({ listProjects: () => [{ id: 'x', name: 'x', path } as Project], folderTrusted: () => true })
      const [r] = await svc.activity()
      expect(r).toMatchObject({ projectId: 'x', available: false, total: 0 })
      expect(r.days).toHaveLength(7)
    }
  })

  it('does not run git in an untrusted folder (default trust rules)', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'settings.json'), '{"hooks":{}}')
    const untrusted = { id: 'u', name: 'u', path: repo, folderConfigTrust: { state: 'untrusted' } } as Project
    const svc = new CommitActivityService({ listProjects: () => [untrusted] })
    const [r] = await svc.activity()
    expect(r.available).toBe(false)
    expect(r.total).toBe(0)
  })

  it('a partial clone with a missing HEAD commit does not start the uploadpack program of its promisor remote (H1)', async () => {
    const marker = join(base, 'uploadpack-ran.txt').replace(/\\/g, '/')
    const remote = join(base, 'promisor-remote.git')
    mkdirSync(remote)
    g(remote, ['init', '-q', '--bare'])
    const partial = join(base, 'partial')
    mkdirSync(partial)
    g(partial, ['init', '-q'])
    commit(partial, 'p.txt', iso(0, 7))
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: partial, env }).toString().trim()
    // A fake partial clone: the repository names a promisor remote whose upload-pack is a program that leaves a marker, and
    // the commit HEAD names is not in the object store, so reading it makes git ask the promisor remote for it.
    g(partial, ['config', 'core.repositoryformatversion', '1'])
    g(partial, ['config', 'extensions.partialClone', 'origin'])
    g(partial, ['config', 'remote.origin.promisor', 'true'])
    g(partial, ['config', 'remote.origin.url', remote.replace(/\\/g, '/')])
    g(partial, ['config', 'remote.origin.uploadpack', `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${marker}`])
    rmSync(join(partial, '.git', 'objects', head.slice(0, 2), head.slice(2)), { force: true })
    const r = await gitCommitTimes(partial, new Date(2000, 0, 1).getTime())
    expect(r.ok).toBe(false)
    expect(existsSync(marker)).toBe(false)
    const svc = new CommitActivityService({ listProjects: () => [{ id: 'pc', name: 'pc', path: partial } as Project], folderTrusted: () => true })
    expect((await svc.activity())[0]).toMatchObject({ available: false, total: 0 })
    expect(existsSync(marker)).toBe(false)
  })

  it('a .git file (a gitdir: redirect, also a linked worktree) is unavailable and is not followed (M1)', async () => {
    const redirect = join(base, 'redirect')
    mkdirSync(redirect)
    writeFileSync(join(redirect, '.git'), `gitdir: ${join(repo, '.git').replace(/\\/g, '/')}\n`)
    expect(hasPlainGitDir(redirect)).toBe(false)
    expect(await gitCommitTimes(redirect, new Date(2000, 0, 1).getTime())).toEqual({ ok: false, times: [] })
    const svc = new CommitActivityService({ listProjects: () => [{ id: 'rd', name: 'rd', path: redirect } as Project], folderTrusted: () => true })
    expect((await svc.activity())[0]).toMatchObject({ available: false, total: 0 })
  })

  it('a .git directory with a commondir file or a non-empty alternates file is unavailable; a normal repository counts', async () => {
    const mk = (name: string): string => {
      const dir = join(base, name)
      mkdirSync(dir)
      g(dir, ['init', '-q'])
      commit(dir, 'f.txt', iso(0, 4))
      return dir
    }
    const since = new Date(2000, 0, 1).getTime()
    const normal = mk('normal-ok')
    mkdirSync(join(normal, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(normal, '.git', 'objects', 'info', 'alternates'), '\n')
    expect(hasPlainGitDir(normal)).toBe(true) // an empty alternates file is harmless
    expect((await gitCommitTimes(normal, since)).times).toHaveLength(1)
    const common = mk('with-commondir')
    writeFileSync(join(common, '.git', 'commondir'), '../other/.git\n')
    const alt = mk('with-alternates')
    mkdirSync(join(alt, '.git', 'objects', 'info'), { recursive: true })
    writeFileSync(join(alt, '.git', 'objects', 'info', 'alternates'), '\\\\server\\share\\objects\n')
    for (const [id, path] of [['cd', common], ['al', alt]]) {
      expect(hasPlainGitDir(path)).toBe(false)
      expect(await gitCommitTimes(path, since)).toEqual({ ok: false, times: [] })
      const svc = new CommitActivityService({ listProjects: () => [{ id, name: id, path } as Project], folderTrusted: () => true })
      expect((await svc.activity())[0]).toMatchObject({ available: false, total: 0 })
    }
  })

  it('an empty .git directory inside a repository with commits does not count the parent repository (M1)', async () => {
    const outer = join(base, 'outer')
    mkdirSync(outer)
    g(outer, ['init', '-q'])
    commit(outer, 'o.txt', iso(0, 6))
    const inner = join(outer, 'inner')
    mkdirSync(join(inner, '.git'), { recursive: true })
    expect(hasPlainGitDir(inner)).toBe(true) // a real directory passes the structural check; git then refuses it
    expect(await gitCommitTimes(inner, new Date(2000, 0, 1).getTime())).toEqual({ ok: false, times: [] })
    const svc = new CommitActivityService({ listProjects: () => [{ id: 'in', name: 'in', path: inner } as Project], folderTrusted: () => true })
    expect((await svc.activity())[0]).toMatchObject({ available: false, total: 0 })
    expect((await gitCommitTimes(outer, new Date(2000, 0, 1).getTime())).times).toHaveLength(1) // the parent itself is fine
  })

  it('a tracked file named HEAD does not make the revision ambiguous (L2)', async () => {
    const named = join(base, 'named-head')
    mkdirSync(named)
    g(named, ['init', '-q'])
    commit(named, 'HEAD', iso(0, 5))
    const r = await gitCommitTimes(named, new Date(2000, 0, 1).getTime())
    expect(r.ok).toBe(true)
    expect(r.times).toHaveLength(1)
  })

  it('stops at the commit cap', async () => {
    const r = await gitCommitTimes(repo, new Date(2000, 0, 1).getTime(), { maxCommits: 2 })
    expect(r.ok).toBe(true)
    expect(r.times).toHaveLength(2)
  })

  it('serves a second call from the cache without running git again', async () => {
    const times = vi.fn(async () => ({ ok: true, times: [] as number[] }))
    const svc = new CommitActivityService({ listProjects: () => [{ id: 'c', name: 'c', path: repo } as Project], folderTrusted: () => true, commitTimes: times })
    await svc.activity()
    await svc.activity()
    expect(times).toHaveBeenCalledTimes(1)
  })
})
