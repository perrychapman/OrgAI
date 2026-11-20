import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/types'
import { bucketCommitDays, commitWindowStartMs, CommitActivityService, lastSevenLocalDays, localDayKey } from './commitActivity'
import { gitCommitTimes } from '../runtime/worktrees'

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

  it('a hostile core.fsmonitor / core.pager in the repository config is not run', async () => {
    const marker = join(base, 'ran.txt')
    const hostile = join(base, 'hostile')
    mkdirSync(hostile)
    g(hostile, ['init', '-q'])
    commit(hostile, 'x.txt', iso(0, 7))
    const cmd = `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${JSON.stringify(marker)}`
    g(hostile, ['config', 'core.fsmonitor', cmd])
    g(hostile, ['config', 'core.pager', cmd])
    g(hostile, ['config', 'core.sshCommand', cmd])
    const r = await gitCommitTimes(hostile, new Date(2000, 0, 1).getTime())
    expect(r.ok).toBe(true)
    expect(r.times).toHaveLength(1)
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
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
