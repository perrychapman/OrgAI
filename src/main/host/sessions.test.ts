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
  projectHolder,
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
    expect(parseSessionRecord({ ...info(A), projects: ['p', 7, ''], cwd: 'x\0y', command: 5 }, A)).toMatchObject({ projects: ['p'], cwd: '', command: '' })
    expect(parseSessionRecord({ ...info(A), pid: -1 }, A)).toBeNull()
    expect(parseSessionRecord(null, A)).toBeNull()
  })
})

describe('project claims', () => {
  it('one session per project: the second is refused and told who holds it', () => {
    const a = register(A, { cwd: '/work/a' })
    const b = register(B)
    expect(a.claimProject('proj_1')).toEqual({ ok: true })
    expect(a.claimProject('proj_1')).toEqual({ ok: true }) // already ours
    expect(a.holdsProject('proj_1')).toBe(true)
    const refused = b.claimProject('proj_1')
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.holder?.hostInstanceId).toBe(A)
    expect(projectHolder(dataDir, 'proj_1')?.hostInstanceId).toBe(A)
    expect(() => b.requireProject('proj_1')).toThrow(ProjectBusyError)
    try {
      b.requireProject('proj_1', 'The project Demo')
    } catch (e) {
      expect((e as ProjectBusyError).message).toBe(`The project Demo is open in another orgai session (/work/a, pid ${process.pid}). Use that one, or quit it first.`)
      expect((e as ProjectBusyError).code).toBe('session_busy')
    }
    // Different projects never conflict.
    expect(b.claimProject('proj_2')).toEqual({ ok: true })
    expect(listSessions(dataDir).map((s) => s.record.projects)).toEqual([['proj_1'], ['proj_2']])
  })

  it('a claim is free again after releaseProject and after the session ends', () => {
    const a = register(A)
    const b = register(B)
    a.requireProject('proj_1')
    a.releaseProject('proj_1')
    expect(a.holdsProject('proj_1')).toBe(false)
    expect(b.claimProject('proj_1')).toEqual({ ok: true })
    b.release()
    expect(a.claimProject('proj_1')).toEqual({ ok: true })
    // The claim file stays for the next claimant; it is never deleted.
    expect(existsSync(projectLockPath(dataDir, 'proj_1'))).toBe(true)
  })

  it('ids that differ only in case, or hold path characters, get their own claim files', () => {
    const a = register(A)
    const b = register(B)
    expect(projectLockPath(dataDir, 'Proj_1')).not.toBe(projectLockPath(dataDir, 'proj_1'))
    expect(projectLockPath(dataDir, '../../etc')).toMatch(/project-[0-9a-f]{32}\.lock$/)
    a.requireProject('Proj_1')
    expect(b.claimProject('proj_1')).toEqual({ ok: true })
  })
})

describe('sweepDeadSessions and liveness', () => {
  it('leaves live sessions and claim files alone and removes nothing of them', () => {
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
    // A dead session's recorded claim holds nothing: the lock is what counts.
    expect(projectHolder(dataDir, 'proj_1')).toBeUndefined()
    expect(b.claimProject('proj_1')).toEqual({ ok: true })
    expect(sweepDeadSessions(dataDir)).toBe(1)
    expect(readdirSync(sessionsDirOf(dataDir)).filter((n) => !n.startsWith('project-')).sort()).toEqual([`${B}.json`, `${B}.lock`])
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
  it('a session in another process is live, holds its project, and is dead the moment it is killed', async () => {
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
        const refused = mine.claimProject('proj_1')
        expect(refused.ok).toBe(false)
        expect(!refused.ok && refused.holder?.pid).toBe(c.pid)
        expect(mine.claimProject('proj_2')).toEqual({ ok: true })
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
    expect(mine.claimProject('proj_1')).toEqual({ ok: true })
    expect(sweepDeadSessions(dataDir)).toBe(1)
  }, 120_000)
})
