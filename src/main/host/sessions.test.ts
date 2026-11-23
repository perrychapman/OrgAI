import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { killAndWait, spawnViteNode } from '../store/shared/testing/viteNode'
import {
  ProjectBusyError,
  isSessionLive,
  listSessions,
  liveSessions,
  parseSessionRecord,
  projectHolders,
  projectLockPath,
  registerSession,
  sessionLiveness,
  sessionLockPath,
  sessionRecordPath,
  sessionsDirOf,
  sweepDeadSessions,
  type SessionHandle
} from './sessions'

let dataDir: string
const open: SessionHandle[] = []
const children: ChildProcess[] = []

const info = (id: string, extra: Partial<{ cwd: string; command: string; startedAt: number }> = {}) => ({
  hostInstanceId: id,
  pid: process.pid,
  startedAt: extra.startedAt ?? 1000,
  appVersion: '0.0.0-test',
  cwd: extra.cwd ?? `/work/${id}`,
  command: extra.command ?? 'tui'
})
const register = (id: string, extra?: Parameters<typeof info>[1]): SessionHandle => {
  const h = registerSession(dataDir, info(id, extra))
  open.push(h)
  return h
}

const A = 'aaaaaaaaaaaa'
const B = 'bbbbbbbbbbbb'

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'orgai-sessions-'))
})
afterEach(async () => {
  for (const h of open.splice(0)) h.release()
  await killAndWait(children)
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('session registry', () => {
  it('a registered session is listed live with its record; releasing removes its files', () => {
    expect(listSessions(dataDir)).toEqual([])
    const a = register(A, { cwd: '/work/a', command: 'exec' })
    expect(isSessionLive(dataDir, A)).toBe(true)
    expect(listSessions(dataDir)).toEqual([{ live: true, record: { hostInstanceId: A, pid: process.pid, startedAt: 1000, appVersion: '0.0.0-test', cwd: '/work/a', command: 'exec', projects: [] } }])
    a.release()
    a.release() // idempotent
    expect(isSessionLive(dataDir, A)).toBe(false)
    expect(listSessions(dataDir)).toEqual([])
    expect(existsSync(sessionRecordPath(dataDir, A))).toBe(false)
    expect(existsSync(sessionLockPath(dataDir, A))).toBe(false)
  })

  it('two sessions see each other, oldest first, and neither is refused', () => {
    const a = register(A, { startedAt: 1 })
    const b = register(B, { startedAt: 2 })
    expect(liveSessions(dataDir).map((s) => s.hostInstanceId)).toEqual([A, B])
    expect(a.others().map((s) => s.hostInstanceId)).toEqual([B])
    expect(b.others().map((s) => s.hostInstanceId)).toEqual([A])
    b.release()
    expect(a.others()).toEqual([])
  })

  it('refuses an id that a live session already holds', () => {
    register(A)
    expect(() => registerSession(dataDir, info(A))).toThrow(/already in use/)
  })

  it('update rewrites the record without losing claims', () => {
    const a = register(A)
    a.requireProject('proj_1')
    a.update({ endpoint: '/tmp/d.sock', processStartTime: 'Mon Jan  1 00:00:00 2026' })
    expect(a.record()).toMatchObject({ endpoint: '/tmp/d.sock', processStartTime: 'Mon Jan  1 00:00:00 2026', projects: ['proj_1'] })
    expect(listSessions(dataDir)[0]?.record).toEqual(a.record())
  })

  it('a record that is not this id, or not a record, is not listed', () => {
    mkdirSync(sessionsDirOf(dataDir), { recursive: true })
    writeFileSync(sessionRecordPath(dataDir, A), JSON.stringify({ ...info(B), projects: [] }))
    writeFileSync(sessionRecordPath(dataDir, B), '{ not json')
    expect(listSessions(dataDir)).toEqual([])
    expect(parseSessionRecord({ ...info(A), projects: ['p', 7, ''], cwd: 5, command: 5 }, A)).toMatchObject({ projects: ['p'], cwd: '', command: '' })
    // A folder name can hold anything; what a refusal quotes from another session's record cannot drive a terminal.
    const hostile = parseSessionRecord({ ...info(A), cwd: '/work/\u001b[2Jwiped\u0000\n\u202eevil\u2028', command: 'tui\u0007', endpoint: '/run/d.sock' }, A)
    expect(hostile).toMatchObject({ cwd: '/work/[2Jwipedevil', command: 'tui', endpoint: '/run/d.sock' })
    // An endpoint is a path this process may connect to: never rewritten, dropped when it holds a NUL.
    expect(parseSessionRecord({ ...info(A), endpoint: '/run/d\u0000.sock' }, A)?.endpoint).toBeUndefined()
    expect(parseSessionRecord({ ...info(A), pid: -1 }, A)).toBeNull()
    expect(parseSessionRecord(null, A)).toBeNull()
  })
})

describe('open projects', () => {
  it('any number of sessions have a project open, and each knows the others in it', () => {
    const a = register(A, { cwd: '/work/a' })
    const b = register(B)
    expect(a.openProject('proj_1')).toEqual({ ok: true })
    expect(a.openProject('proj_1')).toEqual({ ok: true }) // already open here
    expect(a.hasProjectOpen('proj_1')).toBe(true)
    expect(b.openProject('proj_1')).toEqual({ ok: true })
    expect(() => b.requireProject('proj_1')).not.toThrow()
    expect(projectHolders(dataDir, 'proj_1').map((s) => s.hostInstanceId)).toEqual([A, B])
    expect(a.othersIn('proj_1').map((s) => s.hostInstanceId)).toEqual([B])
    expect(b.othersIn('proj_1').map((s) => [s.hostInstanceId, s.cwd])).toEqual([[A, '/work/a']])
    expect(b.openProject('proj_2')).toEqual({ ok: true })
    expect(a.othersIn('proj_2').map((s) => s.hostInstanceId)).toEqual([B])
    expect(listSessions(dataDir).map((s) => s.record.projects)).toEqual([['proj_1'], ['proj_1', 'proj_2']])
  })

  it('a project is held alone only while nobody else has it open; a refusal names who does and changes nothing', () => {
    const a = register(A, { cwd: '/work/a' })
    const b = register(B)
    a.requireProject('proj_1')
    b.requireProject('proj_1')
    const refused = b.exclusiveProject('proj_1')
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.holders.map((s) => s.hostInstanceId)).toEqual([A])
    // The refused session still has it open, and so does the other.
    expect(b.hasProjectOpen('proj_1')).toBe(true)
    expect(projectHolders(dataDir, 'proj_1').map((s) => s.hostInstanceId)).toEqual([A, B])
    expect(new ProjectBusyError('proj_1', !refused.ok ? refused.holders[0] : undefined, 'The project Demo').message).toBe(
      `The project Demo is open in another orgai session (/work/a, pid ${process.pid}). Quit it there first.`
    )
    expect(new ProjectBusyError('proj_1', undefined).code).toBe('session_busy')

    a.closeProject('proj_1')
    expect(a.hasProjectOpen('proj_1')).toBe(false)
    const alone = b.exclusiveProject('proj_1')
    expect(alone.ok).toBe(true)
    // While it is held alone nobody opens it: it is being removed or moved.
    expect(a.openProject('proj_1')).toEqual({ ok: false, holder: undefined })
    expect(() => a.requireProject('proj_1', 'The project Demo')).toThrow('The project Demo is being removed or moved by another orgai session. Try again in a moment.')
    expect(b.hasProjectOpen('proj_1')).toBe(false)
    // Given back after a removal: nobody has it open. After a move: the session keeps it open.
    if (alone.ok) alone.held.release(false)
    expect(projectHolders(dataDir, 'proj_1')).toEqual([])
    expect(a.openProject('proj_1')).toEqual({ ok: true })
    a.closeProject('proj_1')
    const again = b.exclusiveProject('proj_1')
    if (again.ok) again.held.release(true)
    expect(b.hasProjectOpen('proj_1')).toBe(true)
    expect(a.openProject('proj_1')).toEqual({ ok: true })
  })

  it('two sessions that both have a project open and both want it alone: neither gets it, and both still have it open', () => {
    const a = register(A)
    const b = register(B)
    a.requireProject('proj_1')
    b.requireProject('proj_1')
    // Each attempt steps aside for itself only: the other's hold is still there, and its own comes back.
    expect(a.exclusiveProject('proj_1').ok).toBe(false)
    expect(b.exclusiveProject('proj_1').ok).toBe(false)
    expect(a.exclusiveProject('proj_1').ok).toBe(false)
    expect([a.hasProjectOpen('proj_1'), b.hasProjectOpen('proj_1')]).toEqual([true, true])
    expect(projectHolders(dataDir, 'proj_1').map((s) => s.hostInstanceId)).toEqual([A, B])
  })

  it('a project held alone is not opened by the same session meanwhile, and is given back when the session ends', () => {
    const a = register(A)
    const b = register(B)
    const alone = a.exclusiveProject('proj_1')
    expect(alone.ok).toBe(true)
    expect(a.openProject('proj_1')).toEqual({ ok: false, holder: undefined })
    expect(a.exclusiveProject('proj_1')).toEqual({ ok: false, holders: [] })
    expect(b.openProject('proj_1').ok).toBe(false)
    // The session ends in the middle of it (a quit during a removal): the lock goes with it.
    a.release()
    expect(b.openProject('proj_1')).toEqual({ ok: true })
  })

  it('a session that ends no longer has its projects open', () => {
    const a = register(A)
    const b = register(B)
    a.requireProject('proj_1')
    b.requireProject('proj_1')
    expect(b.exclusiveProject('proj_1').ok).toBe(false)
    a.release()
    const alone = b.exclusiveProject('proj_1')
    expect(alone.ok).toBe(true)
    if (alone.ok) alone.held.release(true)
    // The lock file stays for whoever opens the project next; it is never deleted.
    expect(existsSync(projectLockPath(dataDir, 'proj_1'))).toBe(true)
  })

  it('ids that differ only in case, or hold path characters, get their own lock files', () => {
    const a = register(A)
    const b = register(B)
    expect(projectLockPath(dataDir, 'Proj_1')).not.toBe(projectLockPath(dataDir, 'proj_1'))
    expect(projectLockPath(dataDir, '../../etc')).toMatch(/project-[0-9a-f]{32}\.lock$/)
    a.requireProject('Proj_1')
    expect(b.exclusiveProject('proj_1').ok).toBe(true)
  })
})

describe('sweepDeadSessions and liveness', () => {
  it('leaves live sessions and project lock files alone and removes nothing of them', () => {
    const a = register(A)
    a.requireProject('proj_1')
    expect(sweepDeadSessions(dataDir)).toBe(0)
    expect(isSessionLive(dataDir, A)).toBe(true)
    expect(readdirSync(sessionsDirOf(dataDir)).sort()).toEqual([`${A}.json`, `${A}.lock`, expect.stringMatching(/^project-[0-9a-f]{32}\.lock$/)])
  })

  it('removes the record, lock and temp files of a session whose process is gone', () => {
    mkdirSync(sessionsDirOf(dataDir), { recursive: true })
    // What a crashed session leaves: a record, a free lock file, a record temp file. And a stray lock with no record.
    writeFileSync(sessionRecordPath(dataDir, A), JSON.stringify({ ...info(A), projects: ['proj_1'] }))
    writeFileSync(sessionLockPath(dataDir, A), '')
    writeFileSync(`${sessionRecordPath(dataDir, A)}.tmp-0123abcd`, '{}')
    writeFileSync(sessionLockPath(dataDir, 'cccccccccccc'), '')
    const b = register(B)
    expect(listSessions(dataDir).map((s) => [s.record.hostInstanceId, s.live])).toEqual([[A, false], [B, true]])
    // What a dead session's record says it had open counts for nothing: the lock is what counts.
    expect(projectHolders(dataDir, 'proj_1')).toEqual([])
    expect(b.exclusiveProject('proj_1').ok).toBe(true)
    expect(sweepDeadSessions(dataDir)).toBe(1)
    // (Project locks and the lock of the turn to take one alone stay: they are never deleted.)
    expect(readdirSync(sessionsDirOf(dataDir)).filter((n) => /^[0-9a-f]{12}\./.test(n)).sort()).toEqual([`${B}.json`, `${B}.lock`])
  })

  it('sessionLiveness caches: a dead id stays dead, a live one is asked again after its window', () => {
    let clock = 0
    const alive = sessionLiveness(dataDir, { liveForMs: 100, now: () => clock })
    expect(alive(A)).toBe(false)
    const a = register(A)
    // Seen dead before it registered: ids are never reused, so the answer stands (a session registers before it writes anything).
    expect(alive(A)).toBe(false)
    const b = register(B)
    expect(alive(B)).toBe(true)
    b.release()
    expect(alive(B)).toBe(true) // inside the window
    clock = 150
    expect(alive(B)).toBe(false)
    a.release()
  })
})

const modulePath = resolve(__dirname, 'sessions.ts')

function child(body: string, args: string[], onLine: (line: string, c: ChildProcess) => void): Promise<number | null> {
  const script = join(dataDir, `child-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(script, `import { registerSession } from ${JSON.stringify(modulePath)}\nconst [dataDir, id] = process.argv.slice(2)\n${body}\n`)
  return new Promise((res, rej) => {
    const c = spawnViteNode(script, args, { stdio: ['ignore', 'pipe', 'inherit'], cwd: process.cwd() })
    children.push(c)
    let buf = ''
    c.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i), c)
        buf = buf.slice(i + 1)
      }
    })
    c.on('error', rej)
    c.on('exit', (code) => res(code))
  })
}

describe('sessions across processes', () => {
  it('a session in another process is live, has its project open beside this one, and is dead the moment it is killed', async () => {
    let checked = false
    let killed: Promise<void> | undefined
    const exited = child(
      `const s = registerSession(dataDir, { hostInstanceId: id, pid: process.pid, startedAt: Date.now(), appVersion: 't', cwd: '/elsewhere', command: 'tui' })
s.requireProject('proj_1')
console.log('ready')
setInterval(() => {}, 1000)`,
      [dataDir, B],
      (line, c) => {
        if (line !== 'ready' || killed) return
        const mine = register(A)
        expect(isSessionLive(dataDir, B)).toBe(true)
        expect(mine.others().map((s) => [s.hostInstanceId, s.cwd, s.projects])).toEqual([[B, '/elsewhere', ['proj_1']]])
        // Both have it open; neither can take it alone while the other is in it.
        expect(mine.openProject('proj_1')).toEqual({ ok: true })
        expect(mine.othersIn('proj_1').map((s) => s.pid)).toEqual([c.pid])
        const refused = mine.exclusiveProject('proj_1')
        expect(refused.ok).toBe(false)
        expect(!refused.ok && refused.holders.map((s) => s.pid)).toEqual([c.pid])
        expect(mine.hasProjectOpen('proj_1')).toBe(true)
        checked = true
        killed = new Promise<void>((r) => {
          c.once('exit', () => r())
          c.kill('SIGKILL')
        })
      }
    )
    await exited
    await killed
    expect(checked).toBe(true)
    // Killed without any cleanup: its record is still there, but its locks are gone with the process.
    expect(listSessions(dataDir).map((s) => [s.record.hostInstanceId, s.live])).toEqual([[A, true], [B, false]])
    const mine = open[0] as SessionHandle
    expect(mine.others()).toEqual([])
    // The killed session's shared hold went with its process.
    const alone = mine.exclusiveProject('proj_1')
    expect(alone.ok).toBe(true)
    if (alone.ok) alone.held.release(true)
    expect(sweepDeadSessions(dataDir)).toBe(1)
  }, 120_000)
})
