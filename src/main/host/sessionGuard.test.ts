import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectBusyError, RunBusyError, registerSession, type SessionHandle } from './sessions'
import { WorktreesBusyError, createSessionGuard, shortStringsIn } from './sessionGuard'
import { SOLO, createSharedStoreSync, type StoreSync } from '../store/shared/storeSync'

let dataDir: string
const handles: SessionHandle[] = []
const syncs: { close(): void }[] = []

function session(id: string): { handle: SessionHandle; sync: StoreSync } {
  const handle = registerSession(dataDir, { hostInstanceId: id, pid: process.pid, startedAt: Date.now(), appVersion: 't', cwd: `/work/${id}`, command: 'tui' })
  handles.push(handle)
  const sync = createSharedStoreSync(handle, { checkMs: 0, liveForMs: 0 })
  syncs.push(sync)
  return { handle, sync }
}

const A = 'aaaaaaaaaaaa'
const B = 'bbbbbbbbbbbb'
const projects = new Map([
  ['proj_1', { id: 'proj_1', name: 'Alpha', path: '/code/alpha' }],
  ['proj_2', { id: 'proj_2', name: 'Beta', path: '/code/beta' }]
])
const runs = new Map([
  ['run_a', { id: 'run_a', projectId: 'proj_1' }],
  ['run_chat', { id: 'run_chat', projectId: 'quick' }]
])

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'orgai-guard-'))
})
afterEach(() => {
  for (const s of syncs.splice(0)) s.close()
  for (const h of handles.splice(0)) h.release()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const guardOf = (sync: StoreSync, hosted: Record<string, string> = {}, liveIn: Record<string, string[]> = {}) =>
  createSessionGuard({
    sync,
    project: (id) => projects.get(id),
    run: (id) => runs.get(id),
    hostedElsewhere: (id) => hosted[id] ?? null,
    workingElsewhereIn: (projectId) => liveIn[projectId] ?? []
  })

describe('shortStringsIn', () => {
  it('finds ids anywhere a request carries them, and skips long text and bytes', () => {
    const long = 'x'.repeat(201)
    const found = shortStringsIn(['proj_1', { projectId: 'proj_2', nested: { list: ['run_a', 7, null, { deep: 'd4' }] }, prompt: long, bytes: new Uint8Array(4) }, undefined, ''])
    expect([...found].sort()).toEqual(['d4', 'proj_1', 'proj_2', 'run_a'])
  })

  it('stops at its depth and count limits instead of walking a huge payload', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too-deep' } } } } } } }
    expect(shortStringsIn([deep]).has('too-deep')).toBe(false)
    expect(shortStringsIn([Array.from({ length: 10_000 }, (_, i) => `s${i}`)]).size).toBeLessThan(4001)
  })

  it('reaches an id near the top of a request even when thousands of values hang below it', () => {
    // A project as projects:save sends it, with its id after a large roles array (key order is the caller's).
    const roles = Array.from({ length: 600 }, (_, i) => ({ id: `role_${i}`, slug: `r${i}`, name: `Role ${i}`, tools: ['Read', 'Edit', 'Bash'], prompt: 'p', model: 'm', tier: 'deep' }))
    const found = shortStringsIn([{ roles, id: 'proj_1' }])
    expect(found.has('proj_1')).toBe(true)
  })
})

describe('createSessionGuard', () => {
  it('does nothing when the data folder is not shared', () => {
    expect(() => guardOf(SOLO, { run_a: B })('runs:send', ['run_a', 'proj_1'])).not.toThrow()
  })

  it('opens the stored projects a changing request names, directly or through a run', () => {
    const a = session(A)
    guardOf(a.sync)('projects:save', [{ id: 'proj_1', name: 'Alpha', path: '/code/alpha', roles: [] }])
    expect(a.handle.hasProjectOpen('proj_1')).toBe(true)
    guardOf(a.sync)('runs:send', ['run_a', 'hello'])
    guardOf(a.sync)('runs:send', ['run_chat', 'hello'])
    // A Chat run has no project to open; an id that is no stored project or run opens nothing.
    guardOf(a.sync)('settings:set', [{ theme: 'dark', note: 'proj_9' }])
    expect(a.handle.record().projects).toEqual(['proj_1'])
  })

  it('lets a second session work in a project another one has open', () => {
    const a = session(A)
    const b = session(B)
    guardOf(a.sync)('runs:start', [{ projectId: 'proj_1', prompt: 'go' }])
    const guard = guardOf(b.sync)
    expect(guard('runs:start', [{ projectId: 'proj_1', prompt: 'me too' }])).toBeUndefined()
    expect(guard('projects:save', [{ id: 'proj_1', name: 'Alpha 2', path: '/code/alpha', roles: [] }])).toBeUndefined()
    expect(guard('runs:send', ['run_a', 'hello'])).toBeUndefined()
    expect(a.handle.record().projects).toEqual(['proj_1'])
    expect(b.handle.record().projects).toEqual(['proj_1'])
  })

  it('removing a project needs it alone: refused while another session has it open, held alone until the request is done', () => {
    const a = session(A)
    const b = session(B)
    guardOf(a.sync)('runs:start', [{ projectId: 'proj_1', prompt: 'go' }])
    const guard = guardOf(b.sync)
    expect(() => guard('projects:remove', [{ projectId: 'proj_1' }])).toThrow(ProjectBusyError)
    expect(() => guard('projects:remove', [{ projectId: 'proj_1' }])).toThrow(`The project Alpha is open in another orgai session (/work/${A}, pid ${process.pid}). Quit it there first.`)
    // Nobody else in it: held alone for the length of the request, so nobody opens it meanwhile.
    a.handle.closeProject('proj_1')
    const done = guard('projects:remove', [{ projectId: 'proj_1' }])
    expect(typeof done).toBe('function')
    expect(() => guardOf(a.sync)('runs:start', [{ projectId: 'proj_1', prompt: 'go' }])).toThrow('The project Alpha is being removed or moved by another orgai session. Try again in a moment.')
    ;(done as () => void)()
    // Removed: the remover does not keep it open.
    expect(b.handle.hasProjectOpen('proj_1')).toBe(false)
    expect(guardOf(a.sync)('runs:start', [{ projectId: 'proj_1', prompt: 'go' }])).toBeUndefined()
  })

  it('moving a project to another folder needs it alone too; any other save does not', () => {
    const a = session(A)
    const b = session(B)
    guardOf(a.sync)('runs:start', [{ projectId: 'proj_1', prompt: 'go' }])
    const guard = guardOf(b.sync)
    expect(() => guard('projects:save', [{ id: 'proj_1', name: 'Alpha', path: '/code/moved', roles: [] }])).toThrow(ProjectBusyError)
    a.handle.closeProject('proj_1')
    const done = guard('projects:save', [{ id: 'proj_1', name: 'Alpha', path: '/code/moved', roles: [] }])
    expect(typeof done).toBe('function')
    ;(done as () => void)()
    // Moved, not removed: the session that moved it still has it open.
    expect(b.handle.hasProjectOpen('proj_1')).toBe(true)
  })

  it('report branches are not merged or discarded here while another session hosts a run that is working in the project', () => {
    const a = session(A)
    const b = session(B)
    const busy = guardOf(b.sync, {}, { proj_1: [A] })
    for (const channel of ['maintenance:integrateWorktree', 'maintenance:discardWorktree']) {
      expect(() => busy(channel, [{ projectId: 'proj_1', branch: 'worktree-agent-x' }])).toThrow(WorktreesBusyError)
    }
    expect(() => busy('maintenance:integrateWorktree', [{ projectId: 'proj_1', branch: 'worktree-agent-x' }])).toThrow(
      `The project Alpha has a run working in another orgai session (/work/${A}, pid ${process.pid}): its report branches may be that run's work in progress. Merge or discard them there, or once it is idle.`
    )
    // Another session only having the project open (nothing working there) does not stop it, nor does work in another project.
    guardOf(a.sync)('runs:start', [{ projectId: 'proj_1', prompt: 'go' }])
    expect(guardOf(b.sync, {}, { proj_2: [A] })('maintenance:integrateWorktree', [{ projectId: 'proj_1', branch: 'worktree-agent-x' }])).toBeUndefined()
  })

  it('taking OrgAI out of a repository needs the project alone, and leaves it this session\'s', () => {
    const a = session(A)
    const b = session(B)
    guardOf(a.sync)('runs:start', [{ projectId: 'proj_1', prompt: 'go' }])
    const guard = guardOf(b.sync)
    expect(() => guard('maintenance:uninstallRepo', ['proj_1'])).toThrow(ProjectBusyError)
    a.handle.closeProject('proj_1')
    const done = guard('maintenance:uninstallRepo', ['proj_1'])
    expect(typeof done).toBe('function')
    // While it is held alone, this session's own other requests cannot open it either, and say why at once.
    expect(() => guard('runs:start', [{ projectId: 'proj_1', prompt: 'go' }])).toThrow('is being removed or moved by another orgai session')
    ;(done as () => void)()
    expect(b.handle.hasProjectOpen('proj_1')).toBe(true)
  })

  it('refuses a run another session hosts before any project is opened, Chat runs included', () => {
    const a = session(A)
    const b = session(B)
    const guard = guardOf(b.sync, { run_chat: A, run_a: A })
    expect(() => guard('runs:send', ['run_chat', 'hello'])).toThrow(RunBusyError)
    expect(() => guard('runs:stop', ['run_chat'])).toThrow(`Run run_chat is live in another orgai session (/work/${A}, pid ${process.pid}). Use that one, or quit it first.`)
    expect(() => guard('runs:continue', [{ runId: 'run_a', projectId: 'proj_2' }])).toThrow(RunBusyError)
    expect(b.handle.record().projects).toEqual([])
    void a
  })
})
