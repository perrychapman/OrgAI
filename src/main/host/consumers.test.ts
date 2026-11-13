/** Consumer evidence and check tests (docs/design/parallel-sessions.md 4.8). Real child processes; no tokens. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireOsLock } from '../store/shared/osLock'
import {
  ConsumerEvidence,
  canRemoveDeadHostEvidence,
  collectExcludedPids,
  consumerCheck,
  defaultCwdHolders,
  defaultIsAlive,
  emptyEvidenceText,
  parseLsofCwd,
  readEvidence
} from './consumers'
import { hostLockPath } from './hostRegistry'
import { readStartTokenTable, startTokenOfSync, type StartTokenTable } from './startTokens'
import { skipIfTokenReadTimedOut, timed } from './testing/startTokenTimeout'

let dir: string
let file: string
let kids: ChildProcess[]

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-consumers-')))
  file = join(dir, 'h.children.json')
  writeFileSync(file, emptyEvidenceText('aaaaaaaaaaaa'))
  kids = []
})
afterEach(() => {
  for (const k of kids) k.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

const sleeper = (cwd?: string): ChildProcess => {
  const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', cwd })
  kids.push(c)
  return c
}
const exited = (c: ChildProcess): Promise<void> => new Promise((ok) => (c.exitCode !== null || c.signalCode ? ok() : c.once('exit', () => ok())))
const evidence = (over: Partial<ConstructorParameters<typeof ConsumerEvidence>[0]> = {}): ConsumerEvidence => new ConsumerEvidence({ file, hostInstanceId: 'aaaaaaaaaaaa', ...over })
const T = (rows: [number, number, string | null][]): StartTokenTable => new Map(rows.map(([pid, ppid, token]) => [pid, { ppid, token }]))
const noCwd = (): number[] => []

describe('ConsumerEvidence', () => {
  it('records a pending spawn durably, then resolves it to a pid and start time', () => {
    const ev = evidence({ startTokenOf: () => 'lstart:Mon Jan 1 00:00:00 2026' })
    const id = ev.recordPendingSpawn({ chainId: 'run_1', kind: 'claude' })
    expect(readEvidence(file)!.pending).toEqual([expect.objectContaining({ id, chainId: 'run_1', kind: 'claude' })])
    ev.resolvePendingSpawn(id, { pid: 4242 })
    const data = readEvidence(file)!
    expect(data.pending).toEqual([])
    expect(data.descendants).toEqual([expect.objectContaining({ pid: 4242, start: 'lstart:Mon Jan 1 00:00:00 2026' })])
  })

  it('clears a pending spawn only by its own id', () => {
    const ev = evidence()
    const a = ev.recordPendingSpawn({ kind: 'git' })
    const b = ev.recordPendingSpawn({ kind: 'mcp' })
    ev.clearPendingSpawn(a)
    expect(readEvidence(file)!.pending.map((p) => p.id)).toEqual([b])
    expect(readEvidence(file)!.pending[0].chainId).toBeUndefined()
  })

  it('records and clears per-chain resources', () => {
    const ev = evidence()
    ev.setChainResources('run_1', { scratchDir: '/s', worktrees: ['/w1'] })
    expect(readEvidence(file)!.chains.run_1).toEqual({ scratchDir: '/s', worktrees: ['/w1'], mcpBuildDirs: [] })
    ev.clearChainResources('run_1')
    expect(readEvidence(file)!.chains).toEqual({})
  })

  it('snapshot adds new descendants and keeps a reparented one until it is seen to exit', () => {
    const ev = evidence({ hostPid: 100, platform: 'linux' })
    // 200 is a child of host 100, 300 a grandchild
    expect(ev.snapshot(T([[100, 1, 'ticks:1'], [200, 100, 'ticks:2'], [300, 200, 'ticks:3']]))).toBe(true)
    expect(readEvidence(file)!.descendants.map((d) => d.pid)).toEqual([200, 300])
    // 200 exits; 300 is reparented to init and no longer under the host: stays listed
    ev.snapshot(T([[100, 1, 'ticks:1'], [300, 1, 'ticks:3']]))
    expect(readEvidence(file)!.descendants.map((d) => d.pid)).toEqual([300])
    // 300 is replaced by an unrelated process that reuses the pid (other token): seen to exit
    ev.snapshot(T([[100, 1, 'ticks:1'], [300, 1, 'ticks:99']]))
    expect(readEvidence(file)!.descendants).toEqual([])
  })

  it('an unreadable token in the table certifies nothing; a null recorded token stays until the pid is gone', () => {
    const ev = evidence({ hostPid: 100 })
    ev.resolvePendingSpawn(ev.recordPendingSpawn({ kind: 'x' }), { pid: 200, startToken: null })
    ev.resolvePendingSpawn(ev.recordPendingSpawn({ kind: 'x' }), { pid: 300, startToken: 'ticks:3' })
    ev.snapshot(T([[100, 1, 'ticks:1'], [200, 100, 'ticks:2'], [300, 100, null]]))
    // the null-token child is not upgraded, the token-less row does not clear 300
    expect(readEvidence(file)!.descendants).toEqual([
      expect.objectContaining({ pid: 200, start: null }),
      expect.objectContaining({ pid: 300, start: 'ticks:3' })
    ])
    ev.snapshot(T([[100, 1, 'ticks:1']]))
    expect(readEvidence(file)!.descendants).toEqual([])
  })

  it('a spawn recorded while the table read was in flight survives the merge', async () => {
    let release!: (t: StartTokenTable) => void
    const ev = evidence({ hostPid: 100, readTable: () => new Promise<StartTokenTable>((ok) => (release = ok)) })
    ev.resolvePendingSpawn(ev.recordPendingSpawn({ kind: 'old' }), { pid: 200, startToken: 'ticks:2' })
    const p = ev.refresh()
    // while the read is in flight: a new spawn, resolved after the table was taken
    ev.resolvePendingSpawn(ev.recordPendingSpawn({ kind: 'new' }), { pid: 500, startToken: 'ticks:5' })
    const pendingId = ev.recordPendingSpawn({ kind: 'still-pending' })
    // the table shows 200 gone and has no 500
    release(T([[100, 1, 'ticks:1']]))
    await p
    const data = readEvidence(file)!
    expect(data.descendants.map((d) => d.pid)).toEqual([500])
    expect(data.pending.map((x) => x.id)).toEqual([pendingId])
    expect(ev.current().descendants.map((d) => d.pid)).toEqual([500])
    // the next table, read after the spawn, judges it normally
    await (async () => {
      ev.snapshot(T([[100, 1, 'ticks:1']]))
    })()
    expect(readEvidence(file)!.descendants).toEqual([])
  })

  it('an unreadable table changes nothing', async () => {
    const ev = evidence({ readTable: async () => null })
    ev.recordPendingSpawn({ kind: 'x' })
    expect(await ev.refresh()).toBe(false)
    expect(readEvidence(file)!.pending).toHaveLength(1)
  })

  it('records a real child found through the real process table (reparented stays listed after its parent dies)', async () => {
    if (process.platform === 'win32') return
    const ev = evidence()
    // a shell that backgrounds a sleeper (grandchild), then exits so the sleeper is reparented
    const sh = spawn('sh', ['-c', 'sleep 30 & echo $!; sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] })
    kids.push(sh)
    const grand = await new Promise<number>((ok) => sh.stdout!.once('data', (d) => ok(Number(String(d).trim()))))
    expect(await ev.refresh()).toBe(true)
    const pids = readEvidence(file)!.descendants.map((d) => d.pid)
    expect(pids).toContain(sh.pid)
    expect(pids).toContain(grand)
    process.kill(sh.pid!, 'SIGKILL')
    await exited(sh)
    await ev.refresh()
    const after = readEvidence(file)!.descendants.map((d) => d.pid)
    expect(after).toContain(grand)
    expect(after).not.toContain(sh.pid)
    process.kill(grand, 'SIGKILL')
    const table = await readStartTokenTable()
    expect(table).not.toBeNull()
  })
})

describe('consumerCheck', () => {
  it('passes with empty evidence', async () => {
    expect(await consumerCheck({ evidenceFile: file, isAlive: () => false, cwdHolders: noCwd })).toBe('pass')
  })

  it('is uncertain when the file is missing or unreadable', async () => {
    expect(await consumerCheck({ evidenceFile: join(dir, 'nope.json'), cwdHolders: noCwd })).toBe('uncertain')
    writeFileSync(file, '{broken')
    expect(await consumerCheck({ evidenceFile: file, cwdHolders: noCwd })).toBe('uncertain')
    writeFileSync(file, JSON.stringify({ version: 9 }))
    expect(await consumerCheck({ evidenceFile: file, cwdHolders: noCwd })).toBe('uncertain')
  })

  it('is uncertain while a pending spawn is unresolved', async () => {
    evidence().recordPendingSpawn({ kind: 'claude' })
    expect(await consumerCheck({ evidenceFile: file, isAlive: () => false, cwdHolders: noCwd })).toBe('uncertain')
  })

  it('is live while a recorded descendant is alive with the same start time (real child), then passes after it exits', async (ctx) => {
    const c = sleeper()
    const ev = evidence()
    // Recording reads the child's start token; a read that timed out records null (no information).
    const rec = await timed(() => ev.resolvePendingSpawn(ev.recordPendingSpawn({ kind: 'claude' }), { pid: c.pid! }))
    const recorded = readEvidence(file)!.descendants.find((d) => d.pid === c.pid)
    skipIfTokenReadTimedOut(ctx, recorded?.start === null, rec.ms, "Recording the child's start token")
    const r = await timed(() => consumerCheck({ evidenceFile: file, isAlive: defaultIsAlive, cwdHolders: noCwd }))
    skipIfTokenReadTimedOut(ctx, r.value === 'uncertain', r.ms, 'The liveness check of the live child')
    expect(r.value).toEqual({ status: 'live', pids: [c.pid] })
    c.kill('SIGKILL')
    await exited(c)
    const after = await timed(() => consumerCheck({ evidenceFile: file, isAlive: defaultIsAlive, cwdHolders: noCwd }))
    skipIfTokenReadTimedOut(ctx, after.value === 'uncertain', after.ms, 'The liveness check of the exited child')
    expect(after.value).toBe('pass')
  }, 90_000)

  it('does not count a reused pid with a different start time as alive', async () => {
    const c = sleeper()
    const ev = evidence()
    ev.resolvePendingSpawn(ev.recordPendingSpawn({ kind: 'x' }), { pid: c.pid!, startToken: 'lstart:Mon Jan 1 00:00:00 2001' })
    if (process.platform === 'darwin') {
      expect(await consumerCheck({ evidenceFile: file, isAlive: defaultIsAlive, cwdHolders: noCwd })).toBe('pass')
    }
  })

  it('is live when a process holds its cwd inside a private path, and uncertain when the cwd check is unavailable', async () => {
    const hit = await consumerCheck({ evidenceFile: file, isAlive: () => false, privatePaths: ['/x'], cwdHolders: (p) => (p.includes('/x') ? [77] : []) })
    expect(hit).toEqual({ status: 'live', pids: [77] })
    expect(await consumerCheck({ evidenceFile: file, isAlive: () => false, cwdHolders: () => 'unavailable' })).toBe('uncertain')
  })

  it('uses chain resources from the evidence as private paths', async () => {
    evidence().setChainResources('run_1', { scratchDir: '/scratch/a', worktrees: ['/wt/b'] })
    let seen: string[] = []
    await consumerCheck({ evidenceFile: file, isAlive: () => false, privatePaths: ['/auth'], cwdHolders: (p) => ((seen = p), []) })
    expect(seen.sort()).toEqual(['/auth', '/scratch/a', '/wt/b'])
  })

  it.skipIf(process.platform === 'win32')('finds a real child whose cwd is inside a scratch folder (lsof) and honours the exclude set', async () => {
    const scratch = join(dir, 'scratch', 'run_1')
    mkdirSync(scratch, { recursive: true })
    const c = sleeper(scratch)
    await new Promise((r) => setTimeout(r, 200))
    const found = await consumerCheck({
      evidenceFile: file,
      isAlive: () => false,
      privatePaths: [join(dir, 'scratch')],
      cwdHolders: defaultCwdHolders(new Set([process.pid]))
    })
    expect(found).toEqual({ status: 'live', pids: [c.pid] })
    const excluded = await consumerCheck({
      evidenceFile: file,
      isAlive: () => false,
      privatePaths: [join(dir, 'scratch')],
      cwdHolders: defaultCwdHolders(new Set([c.pid!]))
    })
    expect(excluded).toBe('pass')
    // a process in the project folder (outside the private paths) does not count
    const other = await consumerCheck({ evidenceFile: file, isAlive: () => false, privatePaths: [join(dir, 'other')], cwdHolders: defaultCwdHolders() })
    expect(other).toBe('pass')
  })
})

describe('helpers', () => {
  it('parseLsofCwd filters by path prefix and exclusion', () => {
    const text = 'p10\nfcwd\nn/a/b/c\np11\nfcwd\nn/a/bc\np12\nfcwd\nn/a/b\n'
    expect(parseLsofCwd(text, ['/a/b'])).toEqual([10, 12])
    expect(parseLsofCwd(text, ['/a/b/'], new Set([10]))).toEqual([12])
  })

  it('collectExcludedPids has self, ancestors, live hosts and their descendants', () => {
    const ev = evidence()
    ev.resolvePendingSpawn(ev.recordPendingSpawn({ kind: 'x' }), { pid: 555, startToken: 's' })
    const table = T([[1, 0, 'a'], [20, 1, 'b'], [30, 20, 'c']])
    const set = collectExcludedPids({ table, selfPid: 30, liveHosts: [{ pid: 999, childrenFile: file }] })
    expect([...set].sort((a, b) => a - b)).toEqual([1, 20, 30, 555, 999])
  })

  it('a null recorded token is uncertain while the pid exists, and passes once it is gone', async (ctx) => {
    const c = sleeper()
    const ev = evidence()
    ev.resolvePendingSpawn(ev.recordPendingSpawn({ kind: 'x' }), { pid: c.pid!, startToken: null })
    expect(await consumerCheck({ evidenceFile: file, isAlive: defaultIsAlive, cwdHolders: noCwd })).toBe('uncertain')
    c.kill('SIGKILL')
    await exited(c)
    const gone = await timed(() => startTokenOfSync(c.pid!))
    skipIfTokenReadTimedOut(ctx, gone.value === null, gone.ms, 'The token read of the exited child')
    expect(gone.value).toBe('gone')
    const after = await timed(() => consumerCheck({ evidenceFile: file, isAlive: defaultIsAlive, cwdHolders: noCwd }))
    skipIfTokenReadTimedOut(ctx, after.value === 'uncertain', after.ms, 'The liveness check of the exited child')
    expect(after.value).toBe('pass')
  }, 90_000)
})

describe('canRemoveDeadHostEvidence', () => {
  const setup = (): { control: string } => {
    const control = join(dir, 'control')
    mkdirSync(join(control, 'locks'), { recursive: true })
    mkdirSync(join(control, 'hosts'), { recursive: true })
    writeFileSync(join(control, 'hosts', 'aaaaaaaaaaaa.children.json'), emptyEvidenceText('aaaaaaaaaaaa'))
    return { control }
  }
  const base = { hostInstanceId: 'aaaaaaaaaaaa', isAlive: () => false, cwdHolders: noCwd }

  it('is true only with a free lock and a passing check', async () => {
    const { control } = setup()
    expect(await canRemoveDeadHostEvidence({ ...base, controlDir: control })).toBe(true)
    const lock = await acquireOsLock(hostLockPath(control, 'aaaaaaaaaaaa'), 'exclusive', { waitMs: 0 })
    try {
      expect(await canRemoveDeadHostEvidence({ ...base, controlDir: control })).toBe(false)
    } finally {
      lock.release()
    }
    expect(await canRemoveDeadHostEvidence({ ...base, controlDir: control })).toBe(true)
  })

  it('is false for uncertain or live evidence', async () => {
    const { control } = setup()
    const f = join(control, 'hosts', 'aaaaaaaaaaaa.children.json')
    const ev = new ConsumerEvidence({ file: f })
    const id = ev.recordPendingSpawn({ kind: 'claude' })
    expect(await canRemoveDeadHostEvidence({ ...base, controlDir: control })).toBe(false)
    ev.resolvePendingSpawn(id, { pid: 4242, startToken: 's' })
    expect(await canRemoveDeadHostEvidence({ ...base, isAlive: () => true, controlDir: control })).toBe(false)
    expect(await canRemoveDeadHostEvidence({ ...base, controlDir: control })).toBe(true)
    rmSync(f)
    expect(await canRemoveDeadHostEvidence({ ...base, controlDir: control })).toBe(false)
  })
})
