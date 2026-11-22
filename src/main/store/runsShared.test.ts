// RunStore on a data folder several orgai sessions share (docs/design/cli-sessions.md). Two sessions in one process
// stand in for two processes where only the merge logic matters; the last block uses real processes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { RunSummary } from '@shared/types'
import { RunBusyError, registerSession, type SessionHandle } from '../host/sessions'
import { RunStore, hasWorktreeAtWork, loadRunIndex, parseRunOwners } from './runs'
import { createSharedStoreSync, type StoreSync } from './shared/storeSync'
import { killAndWait, viteNodeCli } from './shared/testing/viteNode'

let dataDir: string
const handles: SessionHandle[] = []
const syncs: { close(): void }[] = []
const children: ChildProcess[] = []

const A = 'aaaaaaaaaaaa'
const B = 'bbbbbbbbbbbb'

interface Sess {
  handle: SessionHandle
  sync: StoreSync
  store: RunStore
}

/** A session with its own sync and store. checkMs 0 / liveForMs 0: every read sees the disk and the locks as they are. */
function session(id: string): Sess {
  const handle = registerSession(dataDir, { hostInstanceId: id, pid: process.pid, startedAt: Date.now(), appVersion: 't', cwd: `/work/${id}`, command: 'tui' })
  handles.push(handle)
  const sync = createSharedStoreSync(handle, { checkMs: 0, liveForMs: 0 })
  syncs.push(sync)
  return { handle, sync, store: new RunStore(dataDir, { sync }) }
}

function run(id: string, over: Partial<RunSummary> = {}): RunSummary {
  return { id, projectId: 'quick', kind: 'work', prompt: `prompt ${id}`, status: 'finished', startedAt: 1000, totalCostUsd: 0, ...over }
}

const onDisk = (): { runs: RunSummary[]; owners?: Record<string, string> } => JSON.parse(readFileSync(join(dataDir, 'runs.json'), 'utf8'))

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'orgai-runs-shared-'))
})
afterEach(async () => {
  for (const s of syncs.splice(0)) s.close()
  for (const h of handles.splice(0)) h.release()
  await killAndWait(children)
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('two sessions, one run index', () => {
  it('neither loses the other\'s run: each write lands on the newest index', () => {
    const a = session(A)
    const b = session(B)
    // Both loaded an empty index. Without the merge, b's write would drop a1.
    a.store.upsert(run('a1', { startedAt: 1 }))
    b.store.upsert(run('b1', { startedAt: 2 }))
    a.store.upsert(run('a2', { startedAt: 3 }))
    expect(onDisk().runs.map((r) => r.id)).toEqual(['a1', 'b1', 'a2'])
    expect(a.store.list('quick').map((r) => r.id)).toEqual(['a2', 'b1', 'a1'])
    expect(b.store.list('quick').map((r) => r.id)).toEqual(['a2', 'b1', 'a1'])
    expect(b.store.get('a2')?.prompt).toBe('prompt a2')
  })

  it('a run another session hosts stays live here, names its host, and cannot be changed', () => {
    const a = session(A)
    const b = session(B)
    a.store.upsert(run('a1', { status: 'running' }))
    expect(onDisk().owners).toEqual({ a1: A })
    // b sees it running, not "ended when OrgAI closed".
    expect(b.store.get('a1')).toMatchObject({ status: 'running' })
    expect(b.store.get('a1')?.endedBy).toBeUndefined()
    expect(b.store.hostedElsewhere('a1')).toBe(A)
    expect(a.store.hostedElsewhere('a1')).toBeNull()
    expect(() => b.store.upsert(run('a1', { status: 'finished' }))).toThrow(RunBusyError)
    try {
      b.store.upsert(run('a1', { status: 'finished' }))
    } catch (e) {
      expect((e as RunBusyError).message).toBe(`Run a1 is live in another orgai session (/work/${A}, pid ${process.pid}). Use that one, or quit it first.`)
      expect((e as RunBusyError).code).toBe('session_busy')
    }
    expect(() => b.store.moveToProject(['a1'], 'proj_x')).toThrow(RunBusyError)
    // Usage back-fill and removal skip it.
    b.store.setUsage([{ id: 'a1', usage: { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, updatedAt: 1 } as never }])
    expect(b.store.get('a1')?.usage).toBeUndefined()
    expect(b.store.removeProject('quick')).toBe(0)
    expect(a.store.get('a1')).toMatchObject({ status: 'running' })
    // Its host goes on writing it, and ends it: then it is an ordinary stored run with no owner.
    a.store.upsert(run('a1', { status: 'idle' }))
    expect(b.store.get('a1')?.status).toBe('idle')
    a.store.upsert(run('a1', { status: 'finished', endedAt: 5 }))
    expect(onDisk().owners).toBeUndefined()
    expect(b.store.hostedElsewhere('a1')).toBeNull()
    b.store.upsert(run('a1', { status: 'finished', endedAt: 5, title: 'titled later by b' }))
    expect(a.store.get('a1')?.title).toBe('titled later by b')
  })

  it('a paused run is held by its host too', () => {
    const a = session(A)
    const b = session(B)
    a.store.upsert(run('a1', { status: 'paused', pausedUntil: 99 }))
    expect(b.store.get('a1')?.status).toBe('paused')
    expect(() => b.store.upsert(run('a1', { status: 'finished' }))).toThrow(RunBusyError)
  })

  it('a session that starts later leaves the others\' live runs alone and settles only those of sessions that are gone', () => {
    const a = session(A)
    a.store.upsert(run('a1', { status: 'running' }))
    // Left by a session that no longer exists: open on disk, owned by nobody that is running.
    writeFileSync(
      join(dataDir, 'runs.json'),
      JSON.stringify({ version: 1, runs: [...onDisk().runs, run('gone1', { status: 'idle' }), run('gone2', { status: 'running' })], owners: { a1: A, gone1: 'cccccccccccc' } })
    )
    const b = session(B)
    expect(b.store.get('a1')).toMatchObject({ status: 'running' })
    expect(b.store.get('gone1')).toMatchObject({ status: 'finished', endedBy: 'app', endedWithApp: true, endedWhile: 'idle' })
    // No owner at all (written by an older orgai, or before owners existed): crashed as well.
    expect(b.store.get('gone2')).toMatchObject({ status: 'finished', endedBy: 'app', endedWhile: 'working' })
    // The next write persists the settlement and keeps only the live owner.
    b.store.upsert(run('b1'))
    expect(onDisk().owners).toEqual({ a1: A })
    expect(onDisk().runs.find((r) => r.id === 'gone1')?.status).toBe('finished')
    expect(a.store.get('a1')?.status).toBe('running')
  })

  it('a host that ends while its run is open: the others see the run settled without any write', () => {
    const a = session(A)
    const b = session(B)
    a.store.upsert(run('a1', { status: 'running' }))
    expect(b.store.get('a1')?.status).toBe('running')
    // The process is gone (its lock with it); runs.json is untouched.
    a.handle.release()
    const settled = new RunStore(dataDir, { sync: b.sync })
    expect(settled.get('a1')).toMatchObject({ status: 'finished', endedBy: 'app' })
    expect(b.store.hostedElsewhere('a1')).toBeNull()
    // And now b may take it over (continue it, title it).
    b.store.upsert({ ...(settled.get('a1') as RunSummary), title: 'after the crash' })
    expect(onDisk().runs.find((r) => r.id === 'a1')).toMatchObject({ status: 'finished', title: 'after the crash' })
  })

  it('prune and removeProject never drop a run another session hosts', () => {
    const a = session(A)
    const b = session(B)
    a.store.upsert(run('old-live', { startedAt: 1, status: 'idle' }))
    b.store.upsert(run('old-done', { startedAt: 2 }))
    b.store.upsert(run('new-done', { startedAt: 3 }))
    expect(b.store.prune(() => 1)).toBe(1)
    expect(onDisk().runs.map((r) => r.id).sort()).toEqual(['new-done', 'old-live'])
    expect(b.store.removeProject('quick')).toBe(1)
    expect(onDisk().runs.map((r) => r.id)).toEqual(['old-live'])
    expect(a.store.get('old-live')?.status).toBe('idle')
  })

  it('two sessions each host a run in the same project; each sees the other\'s as live elsewhere and cannot change it', () => {
    const a = session(A)
    const b = session(B)
    a.store.upsert(run('a1', { projectId: 'proj_1', status: 'running', startedAt: 1 }))
    b.store.upsert(run('b1', { projectId: 'proj_1', status: 'running', startedAt: 2 }))
    // An open run opens its project for the session that hosts it; a Chat run has no project.
    expect(a.handle.hasProjectOpen('proj_1')).toBe(true)
    expect(b.handle.hasProjectOpen('proj_1')).toBe(true)
    a.store.upsert(run('a-chat', { status: 'running' }))
    expect(a.handle.hasProjectOpen('quick')).toBe(false)
    expect(onDisk().owners).toEqual({ a1: A, b1: B, 'a-chat': A })

    // Each session's view of the project's runs: its own as it is, the other's marked with where it is live.
    const where = { pid: process.pid, cwd: `/work/${A}`, command: 'tui' }
    expect(b.store.list('proj_1').map((r) => [r.id, r.status, r.liveElsewhere])).toEqual([
      ['b1', 'running', undefined],
      ['a1', 'running', where]
    ])
    expect(b.store.get('a1')?.liveElsewhere).toEqual(where)
    expect(a.store.get('a1')?.liveElsewhere).toBeUndefined()
    expect(b.store.all().find((r) => r.id === 'a1')?.liveElsewhere).toEqual(where)
    // Who is working in the project elsewhere: runs that are starting, running or stopping, of kind work.
    expect(a.store.workingElsewhereIn('proj_1')).toEqual([B])
    expect(b.store.workingElsewhereIn('proj_1')).toEqual([A])
    expect(b.store.workingElsewhereIn('proj_2')).toEqual([])
    a.store.upsert(run('a1', { projectId: 'proj_1', status: 'idle', startedAt: 1 }))
    expect(b.store.workingElsewhereIn('proj_1')).toEqual([])
    expect(b.store.get('a1')?.liveElsewhere).toEqual(where)
    // Idle, but one of its reports still works in the background (or its branch waits at a merge card): at work.
    const recordOf = (agents: Record<string, unknown>): void => {
      mkdirSync(join(dataDir, 'runs'), { recursive: true })
      writeFileSync(join(dataDir, 'runs', 'a1.json'), JSON.stringify({ summary: run('a1', { projectId: 'proj_1', status: 'idle' }), agents, transcript: [], logs: [] }))
    }
    recordOf({ root: { id: 'root' }, w1: { id: 'w1', worktree: { path: '/r/wt', branch: 'worktree-agent-w1', status: 'active' } } })
    expect(b.store.workingElsewhereIn('proj_1')).toEqual([A])
    recordOf({ root: { id: 'root' }, w1: { id: 'w1', worktree: { path: '/r/wt', branch: 'worktree-agent-w1', status: 'review' } } })
    expect(b.store.workingElsewhereIn('proj_1')).toEqual([A])
    // Its reports are done; a branch left in conflict or held is a leftover, not work in progress.
    recordOf({ root: { id: 'root' }, w1: { id: 'w1', worktree: { path: '/r/wt', branch: 'worktree-agent-w1', status: 'conflict' } } })
    expect(b.store.workingElsewhereIn('proj_1')).toEqual([])
    // A record that cannot be read counts as at work: nothing of that run is touched.
    writeFileSync(join(dataDir, 'runs', 'a1.json'), '{ damaged')
    expect(b.store.workingElsewhereIn('proj_1')).toEqual([A])
    rmSync(join(dataDir, 'runs', 'a1.json'))
    a.store.upsert(run('a-setup', { projectId: 'proj_1', status: 'running', kind: 'setup', startedAt: 3 }))
    expect(b.store.workingElsewhereIn('proj_1')).toEqual([])
    a.store.upsert(run('a-setup', { projectId: 'proj_1', status: 'finished', kind: 'setup', startedAt: 3 }))
    a.store.upsert(run('a1', { projectId: 'proj_1', status: 'running', startedAt: 1 }))
    // The mark is never stored, even when a summary that carries it is written back.
    expect(() => b.store.upsert({ ...(b.store.get('a1') as RunSummary), title: 'not mine' })).toThrow(RunBusyError)
    b.store.upsert({ ...run('b1', { projectId: 'proj_1', status: 'running', startedAt: 2 }), liveElsewhere: where })
    expect(JSON.stringify(onDisk())).not.toContain('liveElsewhere')

    // Its host ends the run: nobody is live elsewhere in the project for the other session any more.
    a.store.upsert(run('a1', { projectId: 'proj_1', status: 'finished', startedAt: 1 }))
    expect(b.store.get('a1')?.liveElsewhere).toBeUndefined()
    expect(b.store.workingElsewhereIn('proj_1')).toEqual([])
    expect(onDisk().owners).toEqual({ b1: B, 'a-chat': A })
  })

  it('a re-read that fails keeps the runs in memory instead of emptying the index', () => {
    const a = session(A)
    a.store.upsert(run('a1'))
    writeFileSync(join(dataDir, 'runs.json'), '{ damaged')
    expect(a.store.list('quick').map((r) => r.id)).toEqual(['a1'])
    a.store.upsert(run('a2'))
    expect(onDisk().runs.map((r) => r.id)).toEqual(['a1', 'a2'])
  })
})

describe('one process per data folder (the desktop app, an older orgai)', () => {
  it('ignores owners: every open run is settled, and the next write drops the owners map', () => {
    const a = session(A)
    a.store.upsert(run('a1', { status: 'running' }))
    expect(onDisk().owners).toEqual({ a1: A })
    // No sync given and none installed for this folder: the store behaves as it always did.
    const solo = new RunStore(dataDir)
    expect(solo.get('a1')).toMatchObject({ status: 'finished', endedBy: 'app' })
    expect(solo.hostedElsewhere('a1')).toBeNull()
    solo.upsert(run('s1'))
    expect(onDisk().owners).toBeUndefined()
  })

  it('loadRunIndex and parseRunOwners read the file as data', () => {
    expect(parseRunOwners({ owners: { r1: A, r2: 'not-an-id', r3: 7, __proto__: A } })).toEqual({ r1: A })
    expect(parseRunOwners({ owners: [A] })).toEqual({})
    expect(parseRunOwners(null)).toEqual({})
    const parsed = { runs: [run('r1', { status: 'running' }), run('r2', { status: 'running' }), run('r3')], owners: { r1: A, r2: B, r3: A } }
    const loaded = loadRunIndex(parsed, (id) => id === A, 7)
    expect(loaded.runs.map((r) => r.status)).toEqual(['running', 'finished', 'finished'])
    // Only open runs of running sessions keep an owner.
    expect(loaded.owners).toEqual({ r1: A })
    expect(loadRunIndex(parsed).runs.map((r) => r.status)).toEqual(['finished', 'finished', 'finished'])
    expect(loadRunIndex(parsed).owners).toEqual({})
  })
})

const runsModule = resolve(__dirname, 'runs.ts')
const sessionsModule = resolve(__dirname, '../host/sessions.ts')
const syncModule = resolve(__dirname, 'shared/storeSync.ts')

function child(body: string, args: string[], onLine?: (line: string, c: ChildProcess) => void): Promise<number | null> {
  const script = join(dataDir, `child-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(
    script,
    `import { RunStore } from ${JSON.stringify(runsModule)}
import { registerSession } from ${JSON.stringify(sessionsModule)}
import { createSharedStoreSync } from ${JSON.stringify(syncModule)}
const [dataDir, id, count] = process.argv.slice(2)
const handle = registerSession(dataDir, { hostInstanceId: id, pid: process.pid, startedAt: Date.now(), appVersion: 't', cwd: '/child/' + id, command: 'exec' })
const store = new RunStore(dataDir, { sync: createSharedStoreSync(handle, { waitMs: 240000 }) })
const run = (rid: string, status: string) => ({ id: rid, projectId: 'quick', kind: 'work', prompt: rid, status, startedAt: Date.now(), totalCostUsd: 0 })
${body}
`
  )
  return new Promise((res, rej) => {
    // runs.ts imports through the @shared alias, which the children get from vitest.config.ts.
    const c = spawn(process.execPath, [viteNodeCli(), '-c', resolve(process.cwd(), 'vitest.config.ts'), script, ...args], { stdio: ['ignore', 'pipe', 'inherit'], cwd: process.cwd() })
    children.push(c)
    let buf = ''
    c.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine?.(buf.slice(0, i), c)
        buf = buf.slice(i + 1)
      }
    })
    c.on('error', rej)
    c.on('exit', (code) => res(code))
  })
}

describe('real processes on one run index', () => {
  it('two processes x 100 runs, each started and then ended: all 200 are in the index, none lost, none left open', async () => {
    const body = `for (let i = 0; i < Number(count); i++) { store.upsert(run(id + '-' + i, 'running') as any); store.upsert(run(id + '-' + i, 'finished') as any) }
handle.release()
process.exit(0)`
    const codes = await Promise.all([child(body, [dataDir, A, '100']), child(body, [dataDir, B, '100'])])
    expect(codes).toEqual([0, 0])
    const disk = onDisk()
    expect(disk.runs).toHaveLength(200)
    expect(new Set(disk.runs.map((r) => r.id)).size).toBe(200)
    expect(disk.runs.every((r) => r.status === 'finished')).toBe(true)
    expect(disk.owners).toBeUndefined()
  }, 300_000)

  it('a process killed while hosting a run: the run is live until then, and settled as cut by the app afterwards', async () => {
    let seenLive = false
    let killed: Promise<void> | undefined
    const exited = child(
      `store.upsert(run('k1', 'running') as any)
console.log('ready')
setInterval(() => {}, 1000)`,
      [dataDir, B, '0'],
      (line, c) => {
        if (line !== 'ready' || killed) return
        const mine = session(A)
        expect(mine.store.get('k1')?.status).toBe('running')
        expect(mine.store.hostedElsewhere('k1')).toBe(B)
        expect(() => mine.store.upsert(run('k1'))).toThrow(RunBusyError)
        seenLive = true
        killed = new Promise<void>((r) => {
          c.once('exit', () => r())
          c.kill('SIGKILL')
        })
      }
    )
    await exited
    await killed
    expect(seenLive).toBe(true)
    // A fresh store, as the next orgai would build it.
    const next = new RunStore(dataDir, { sync: syncs[0] as unknown as StoreSync })
    expect(next.get('k1')).toMatchObject({ status: 'finished', endedBy: 'app', endedWithApp: true, endedWhile: 'working' })
    expect(next.hostedElsewhere('k1')).toBeNull()
  }, 120_000)
})

describe('hasWorktreeAtWork', () => {
  it('is true while any agent worktree is active, waiting on children, merging or under review', () => {
    const wt = (status: string) => ({ a: { worktree: { status } } })
    for (const s of ['active', 'waiting-children', 'merging', 'review']) expect(hasWorktreeAtWork(wt(s))).toBe(true)
    for (const s of ['merged', 'empty', 'removed', 'conflict', 'held']) expect(hasWorktreeAtWork(wt(s))).toBe(false)
    expect(hasWorktreeAtWork({ root: {}, a: { worktree: null } })).toBe(false)
    expect(hasWorktreeAtWork(undefined)).toBe(false)
    expect(hasWorktreeAtWork('agents')).toBe(false)
  })
})
