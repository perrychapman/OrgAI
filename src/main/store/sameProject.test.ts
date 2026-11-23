// Two orgai sessions working in ONE project (docs/design/cli-sessions.md): the project's own files (its record, notes,
// knowledge graph, permission rules) are read, changed and rewritten by both, and neither loses what the other wrote.
// The first block uses real processes, because an in-process test cannot interleave two read-change-write sequences.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Project } from '@shared/types'
import { newProject } from '@shared/defaults'
import { registerSession, SessionBusyError, type SessionHandle } from '../host/sessions'
import { listRules } from '../runtime/permissionRules'
import { readKnowledge } from './knowledge'
import { listNotes } from './projectData'
import { ProjectStore } from './projects'
import { NAMED_LOCK_WAIT_MS, withNamedLock } from './shared/namedLock'
import { createSharedStoreSync, enableStoreSync, lockedForProcess, oneChangePerCall, storeSyncFor, type StoreSync } from './shared/storeSync'
import { trySyncLock, trySyncSharedLock } from './shared/syncLock'
import { killAndWait, viteNodeCli } from './shared/testing/viteNode'

let dataDir: string
let projectDir: string
const handles: SessionHandle[] = []
const cleanups: Array<() => void> = []
const children: ChildProcess[] = []

const A = 'aaaaaaaaaaaa'
const B = 'bbbbbbbbbbbb'

function session(id: string): { handle: SessionHandle; sync: StoreSync & { close(): void } } {
  const handle = registerSession(dataDir, { hostInstanceId: id, pid: process.pid, startedAt: Date.now(), appVersion: 't', cwd: `/work/${id}`, command: 'tui' })
  handles.push(handle)
  const sync = createSharedStoreSync(handle, { checkMs: 0, liveForMs: 0 })
  cleanups.push(() => sync.close())
  return { handle, sync }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'orgai-same-project-'))
  projectDir = join(dataDir, 'repo')
  mkdirSync(projectDir)
})
afterEach(async () => {
  for (const c of cleanups.splice(0)) c()
  for (const h of handles.splice(0)) h.release()
  await killAndWait(children)
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const here = (name: string): string => resolve(__dirname, name)

function child(body: string, args: string[]): Promise<number | null> {
  const script = join(dataDir, `child-${Math.random().toString(36).slice(2)}.ts`)
  writeFileSync(
    script,
    `import { registerSession } from ${JSON.stringify(here('../host/sessions.ts'))}
import { createSharedStoreSync, enableStoreSync } from ${JSON.stringify(here('shared/storeSync.ts'))}
import { ProjectStore } from ${JSON.stringify(here('projects.ts'))}
import { saveNote } from ${JSON.stringify(here('projectData.ts'))}
import { upsertNode } from ${JSON.stringify(here('knowledge.ts'))}
import { addRules } from ${JSON.stringify(here('../runtime/permissionRules.ts'))}
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [dataDir, id, projectId, count, rulesFile] = process.argv.slice(2)
const handle = registerSession(dataDir, { hostInstanceId: id, pid: process.pid, startedAt: Date.now(), appVersion: 't', cwd: '/child/' + id, command: 'exec' })
enableStoreSync(dataDir, createSharedStoreSync(handle, { waitMs: 240000 }))
const projects = new ProjectStore(dataDir)
const n = Number(count)
${body}
handle.release()
process.exit(0)
`
  )
  return new Promise((res, rej) => {
    // The modules import through the @shared alias, which the children get from vitest.config.ts.
    const c = spawn(process.execPath, [viteNodeCli(), '-c', resolve(process.cwd(), 'vitest.config.ts'), script, ...args], { stdio: ['ignore', 'pipe', 'inherit'], cwd: process.cwd() })
    children.push(c)
    c.on('error', rej)
    c.on('exit', (code) => res(code))
  })
}

describe('two processes in one project', () => {
  it('each adds 60 notes, 60 knowledge nodes, 60 permission rules and 60 roles at the same moment: every one of the 480 is there afterwards', async () => {
    const seed = session(A)
    const off = enableStoreSync(dataDir, seed.sync)
    const store = new ProjectStore(dataDir)
    const project = store.save(newProject({ name: 'Shared', path: projectDir, brief: '' }))
    const before = project.roles.length
    off()
    seed.sync.close()
    seed.handle.release()
    const rulesFile = join(dataDir, 'rules.json')
    const N = 60
    const ids = ['cccccccccccc', 'dddddddddddd']
    // Four phases, one kind of file each. Both processes start a phase at the same moment (a go file), so that their
    // tight loops of "read the whole file, change it, rewrite the whole file" really overlap on the same file.
    const body = `const pause = new Int32Array(new SharedArrayBuffer(4))
const phase = (k: number, step: (i: number) => void): void => {
  writeFileSync(join(dataDir, id + '.ready-' + k), '')
  while (!existsSync(join(dataDir, 'go-' + k))) Atomics.wait(pause, 0, 0, 1)
  for (let i = 0; i < n; i++) step(i)
}
phase(0, (i) => void saveNote(dataDir, projectId, { title: id + ' note ' + i, text: 'text ' + i }))
phase(1, (i) => void upsertNode(dataDir, projectId, { kind: 'person', name: id + ' node ' + i, summary: 's' }, { by: 'user', at: Date.now() }))
phase(2, (i) => void addRules({ file: rulesFile }, ['Bash(echo ' + id + i + ':*)']))
phase(3, (i) => {
  const p = projects.get(projectId)
  projects.save({ ...p, roles: [...p.roles, { ...p.roles[0], id: id + '-role-' + i, slug: id + '-role-' + i, name: 'Role ' + i, reportsTo: p.roles[0].id }] })
})`
    const running = Promise.all(ids.map((id) => child(body, [dataDir, id, project.id, String(N), rulesFile])))
    for (let k = 0; k < 4; k++) {
      const end = Date.now() + 120_000
      while (!ids.every((id) => existsSync(join(dataDir, `${id}.ready-${k}`)))) {
        if (Date.now() > end) throw new Error(`the children did not reach phase ${k}`)
        await new Promise((r) => setTimeout(r, 20))
      }
      writeFileSync(join(dataDir, `go-${k}`), '')
    }
    const codes = await running
    expect(codes).toEqual([0, 0])
    expect(listNotes(dataDir, project.id)).toHaveLength(2 * N)
    expect(readKnowledge(dataDir, project.id).nodes).toHaveLength(2 * N)
    expect(listRules({ file: rulesFile })).toHaveLength(2 * N)
    const roles = (JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf8')) as { projects: Project[] }).projects[0]!.roles
    expect(roles).toHaveLength(before + 2 * N)
    expect(new Set(roles.map((r) => r.id)).size).toBe(before + 2 * N)
  }, 300_000)
})

describe('a project saved from a copy another session has since changed', () => {
  it('keeps both sessions\' changes, field by field and role by role', () => {
    const a = session(A)
    const b = session(B)
    const storeA = new ProjectStore(dataDir, { sync: a.sync })
    const storeB = new ProjectStore(dataDir, { sync: b.sync })
    const fresh = newProject({ name: 'Shared', path: projectDir, brief: 'first' })
    const lead = { ...fresh.roles[0]!, id: 'lead', slug: 'lead', name: 'Lead' }
    const role = (id: string, name: string): Project['roles'][number] => ({ ...lead, id, slug: id, name, reportsTo: 'lead' })
    const made = storeA.save({ ...fresh, roles: [lead, role('dev', 'Developer')] })
    // Both read the same version; A saves first.
    const copyA = storeA.get(made.id) as Project
    const copyB = storeB.get(made.id) as Project
    storeA.save({ ...copyA, brief: 'brief from A', roles: [...copyA.roles, role('qa', 'Tester')] } as Project)
    const saved = storeB.save({ ...copyB, name: 'Renamed by B', roles: copyB.roles.map((r) => (r.id === 'dev' ? { ...r, name: 'Engineer' } : r)) } as Project)
    expect(saved).toMatchObject({ name: 'Renamed by B', brief: 'brief from A' })
    expect(saved.roles.map((r) => [r.id, r.name])).toEqual([
      ['lead', 'Lead'],
      ['dev', 'Engineer'],
      ['qa', 'Tester']
    ])
    expect(storeA.get(made.id)).toMatchObject({ name: 'Renamed by B', brief: 'brief from A' })
    // Two saves of one project never share an updatedAt (it tells a later save which version its copy came from).
    expect(new Set([made.updatedAt, storeA.get(made.id)!.updatedAt, copyA.updatedAt]).size).toBe(2)
  })

  it('a copy whose version this process never had is stored as it is, as before', () => {
    const a = session(A)
    const store = new ProjectStore(dataDir, { sync: a.sync })
    const made = store.save(newProject({ name: 'Shared', path: projectDir, brief: 'first' }))
    store.save({ ...made, brief: 'second' } as Project)
    const stale = { ...made, updatedAt: '1999-01-01T00:00:00.000Z', name: 'From nowhere' } as Project
    expect(store.save(stale)).toMatchObject({ name: 'From nowhere', brief: 'first' })
  })
})

describe('locks', () => {
  it('a shared lock is held by many at once and keeps an exclusive one out; an exclusive one keeps shared ones out', () => {
    const path = join(dataDir, 'p.lock')
    const one = trySyncSharedLock(path)
    const two = trySyncSharedLock(path)
    expect(one && two).toBeTruthy()
    expect(trySyncLock(path)).toBeNull()
    one!.release()
    expect(trySyncLock(path)).toBeNull()
    two!.release()
    const alone = trySyncLock(path)
    expect(alone).toBeTruthy()
    expect(trySyncSharedLock(path)).toBeNull()
    alone!.release()
    const again = trySyncSharedLock(path)
    expect(again).toBeTruthy()
    again!.release()
    // Nothing was ever written to the lock file.
    expect(readFileSync(path).length).toBe(0)
  })

  it('withNamedLock: one holder at a time across sessions; a waiter gets its turn, and gives up after its wait', async () => {
    const a = session(A)
    const off = enableStoreSync(dataDir, a.sync)
    cleanups.push(off)
    const order: string[] = []
    let release!: () => void
    const first = withNamedLock(dataDir, 'evolve:p1', async () => {
      order.push('first in')
      await new Promise<void>((r) => (release = r))
      order.push('first out')
    })
    await Promise.resolve()
    // Another name is free; the same name waits (here: gives up at once with waitMs 0).
    await withNamedLock(dataDir, 'evolve:p2', async () => void order.push('other name'))
    await expect(withNamedLock(dataDir, 'evolve:p1', async () => 'never', { waitMs: 0, busy: 'Busy elsewhere.' })).rejects.toThrow(SessionBusyError)
    await expect(withNamedLock(dataDir, 'evolve:p1', async () => 'never', { waitMs: 0, busy: 'Busy elsewhere.' })).rejects.toThrow('Busy elsewhere.')
    const second = withNamedLock(dataDir, 'evolve:p1', async () => void order.push('second in'), { waitMs: 5000 })
    await new Promise((r) => setTimeout(r, 60))
    expect(order).toEqual(['first in', 'other name'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first in', 'other name', 'first out', 'second in'])
    expect(NAMED_LOCK_WAIT_MS).toBeGreaterThan(1000)
  })

  it('with one process per data folder none of this locks anything', async () => {
    expect(storeSyncFor(dataDir).shared).toBe(false)
    expect(await withNamedLock(dataDir, 'x', async () => 1)).toBe(1)
    const service = { n: 0, add: (k: number): number => (service.n += k) }
    expect(oneChangePerCall(dataDir, service)).toBe(service)
    expect(lockedForProcess(() => 7)).toBe(7)
  })

  it('oneChangePerCall runs each call of a service under the write lock, and lockedForProcess takes the same lock', () => {
    const a = session(A)
    const b = session(B)
    cleanups.push(enableStoreSync(dataDir, a.sync))
    const held: boolean[] = []
    // "Held" is seen from outside: another session's lock with no wait budget cannot get in.
    const outside = createSharedStoreSync(b.handle, { waitMs: 0 })
    cleanups.push(() => outside.close())
    const lockedOut = (): boolean => {
      try {
        outside.locked(() => undefined)
        return false
      } catch {
        return true
      }
    }
    class Service {
      total = 0
      add(k: number): number {
        held.push(lockedOut())
        return (this.total += this.twice(k))
      }
      twice(k: number): number {
        return 2 * k
      }
      async later(): Promise<boolean> {
        const during = lockedOut()
        await Promise.resolve()
        // After the first await the lock is no longer held: work that spans awaits takes a named lock instead.
        return during && !lockedOut()
      }
    }
    const service = oneChangePerCall(dataDir, new Service())
    expect(service.add(3)).toBe(6)
    expect(service.total).toBe(6)
    expect(held).toEqual([true])
    expect(lockedOut()).toBe(false)
    expect(service.add).toBe(service.add)
    expect(lockedForProcess(() => lockedOut())).toBe(true)
    return expect(service.later()).resolves.toBe(true)
  })
})
