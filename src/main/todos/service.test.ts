import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TODOS_MAX_PER_SCOPE, TODO_RUN_WRITES_MAX, TODO_STARTED_RUNS_MAX } from '../../shared/types'
import type { TodoScope, TodosChangedEvent } from '../../shared/types'
import { TodoService } from './service'
import type { TodoCaller } from './service'
import { TodoStore } from './store'

const CHAT: TodoScope = { kind: 'chat' }
const P1: TodoScope = { kind: 'project', projectId: 'p1' }
const CALLER: TodoCaller = { runId: 'run_a', agentId: 'ag1', roleName: 'Lead' }

let dir: string
let clock: number
let seq: number
let events: TodosChangedEvent[]
let projects: Set<string>
let runs: Map<string, TodoScope>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-todosvc-'))
  clock = 1_700_000_000_000
  seq = 0
  events = []
  projects = new Set(['p1'])
  runs = new Map()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function make(): TodoService {
  return new TodoService({
    store: new TodoStore(dir),
    now: () => clock,
    projectExists: (id) => projects.has(id),
    runScope: (id) => runs.get(id) ?? null,
    changed: (e) => events.push(e),
    newId: () => `todo_${(++seq).toString(16).padStart(8, '0')}`
  })
}

describe('TodoService user writes', () => {
  it('creates, lists in sort order and pushes a change', () => {
    const s = make()
    const a = s.save({ scope: CHAT, title: '  Buy   milk ' })
    expect(a).toMatchObject({ title: 'Buy milk', status: 'open', createdBy: 'user', editedBy: 'user', statusBy: 'user' })
    clock += 10
    s.save({ scope: CHAT, title: 'Second', status: 'done' })
    expect(s.list(CHAT).map((i) => i.title)).toEqual(['Buy milk', 'Second'])
    expect(events[0]).toEqual({ scope: CHAT, ids: [a.id] })
  })

  it('requires a title on create', () => {
    expect(() => make().save({ scope: CHAT })).toThrow('Give the item a short title.')
  })

  it('ignores main-owned fields on input', () => {
    const s = make()
    const a = s.save({
      scope: CHAT,
      title: 'x',
      id: undefined,
      createdBy: 'agent',
      editedBy: 'agent',
      statusBy: 'agent',
      createdAt: 5,
      updatedAt: 5,
      source: { runId: 'evil' },
      startedRunIds: ['evil']
    })
    expect(a.id).toBe('todo_00000001')
    expect(a.createdBy).toBe('user')
    expect(a.createdAt).toBe(clock)
    expect(a.source).toBeUndefined()
    expect(a.startedRunIds).toBeUndefined()
  })

  it('updates, sets doneAt, and updatedAt strictly increases even on a frozen clock', () => {
    const s = make()
    const a = s.save({ scope: CHAT, title: 'x' })
    const b = s.save({ scope: CHAT, id: a.id, title: 'y', detail: 'more' })
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt)
    const c = s.save({ scope: CHAT, id: a.id, status: 'done' })
    expect(c.updatedAt).toBeGreaterThan(b.updatedAt)
    expect(c.doneAt).toBeDefined()
    expect(c.statusBy).toBe('user')
    const d = s.save({ scope: CHAT, id: a.id, status: 'open', detail: null })
    expect(d.doneAt).toBeUndefined()
    expect(d.detail).toBeUndefined()
  })

  it('refuses a stale expectedUpdatedAt', () => {
    const s = make()
    const a = s.save({ scope: CHAT, title: 'x' })
    s.save({ scope: CHAT, id: a.id, title: 'y' })
    expect(() => s.save({ scope: CHAT, id: a.id, title: 'z', expectedUpdatedAt: a.updatedAt })).toThrow(
      'This to-do changed since you opened it. Reload it and try again.'
    )
  })

  it('refuses bad input with one sentence', () => {
    const s = make()
    expect(() => s.save({ scope: { kind: 'nope' }, title: 'x' })).toThrow('That is not a to-do list.')
    expect(() => s.save({ scope: { kind: 'project', projectId: 'gone' }, title: 'x' })).toThrow('That project no longer exists.')
    expect(() => s.save({ scope: CHAT, id: 'bad', title: 'x' })).toThrow('No such to-do.')
    expect(() => s.save({ scope: CHAT, id: 'todo_0000ffff', title: 'x' })).toThrow('No such to-do.')
    expect(() => s.save({ scope: CHAT, title: 'a‮b' })).toThrow(/characters that cannot be shown/)
    expect(() => s.save({ scope: CHAT, title: 'x', status: 'weird' })).toThrow()
    expect(() => s.list({ kind: 'project', projectId: 'gone' })).toThrow('That project no longer exists.')
  })

  it('refuses an item from another scope', () => {
    const s = make()
    const a = s.save({ scope: CHAT, title: 'x' })
    expect(() => s.save({ scope: P1, id: a.id, title: 'y' })).toThrow('No such to-do.')
  })

  it('enforces the per-list cap', () => {
    const s = make()
    for (let i = 0; i < TODOS_MAX_PER_SCOPE; i++) s.save({ scope: CHAT, title: `t${i}` })
    expect(() => s.save({ scope: CHAT, title: 'one more' })).toThrow(
      `This list holds ${TODOS_MAX_PER_SCOPE} items, the most it can. Remove some or clear done items first.`
    )
    expect(() => s.agentAdd(CHAT, { title: 'again' }, CALLER)).toThrow(/most it can/)
  })

  it('removes and pushes the removed id; unknown id refused', () => {
    const s = make()
    const a = s.save({ scope: CHAT, title: 'x' })
    s.remove({ scope: CHAT, id: a.id })
    expect(s.list(CHAT)).toEqual([])
    expect(events.at(-1)).toEqual({ scope: CHAT, ids: [], removed: [a.id] })
    expect(() => s.remove({ scope: CHAT, id: a.id })).toThrow('No such to-do.')
  })

  it('clearDone removes done items only and does not push when none', () => {
    const s = make()
    const a = s.save({ scope: CHAT, title: 'a', status: 'done' })
    s.save({ scope: CHAT, title: 'b' })
    const n = events.length
    expect(s.clearDone(CHAT)).toBe(1)
    expect(events.at(-1)).toEqual({ scope: CHAT, ids: [], removed: [a.id] })
    expect(s.list(CHAT)).toHaveLength(1)
    const m = events.length
    expect(s.clearDone(CHAT)).toBe(0)
    expect(events).toHaveLength(m)
    expect(m).toBe(n + 1)
  })

  it('removeScope drops the list without a project check', () => {
    const s = make()
    const a = s.save({ scope: P1, title: 'a' })
    const b = s.save({ scope: P1, title: 'b' })
    projects.delete('p1')
    expect(s.removeScope(P1)).toBe(2)
    expect(events.at(-1)).toEqual({ scope: P1, ids: [], removed: [a.id, b.id] })
    expect(s.removeScope(P1)).toBe(0)
  })
})

describe('TodoService.linkRun', () => {
  it('records the run, dedupes, caps and leaves updatedAt alone', () => {
    const s = make()
    const a = s.save({ scope: P1, title: 'x' })
    for (let i = 0; i < TODO_STARTED_RUNS_MAX + 3; i++) {
      runs.set(`r${i}`, P1)
      s.linkRun({ scope: P1, id: a.id, runId: `r${i}` })
    }
    const out = s.linkRun({ scope: P1, id: a.id, runId: 'r5' })
    expect(out.startedRunIds).toHaveLength(TODO_STARTED_RUNS_MAX)
    expect(out.startedRunIds?.[0]).toBe('r5')
    expect(new Set(out.startedRunIds).size).toBe(TODO_STARTED_RUNS_MAX)
    expect(out.updatedAt).toBe(a.updatedAt)
  })

  it('refuses unknown runs, other lists and bad ids', () => {
    const s = make()
    const a = s.save({ scope: P1, title: 'x' })
    expect(() => s.linkRun({ scope: P1, id: a.id, runId: 'nope' })).toThrow('No such run.')
    expect(() => s.linkRun({ scope: P1, id: a.id, runId: 'bad id!' })).toThrow('No such run.')
    runs.set('rc', CHAT)
    expect(() => s.linkRun({ scope: P1, id: a.id, runId: 'rc' })).toThrow('That run does not belong to this list.')
    runs.set('rp', P1)
    expect(() => s.linkRun({ scope: P1, id: 'todo_0000ffff', runId: 'rp' })).toThrow('No such to-do.')
  })
})

describe('TodoService agent', () => {
  it('adds with source, dedupes open titles case-insensitively without counting', () => {
    const s = make()
    const r = s.agentAdd(P1, { title: 'Call Bob', detail: 'about the deal' }, CALLER)
    expect(r.changed).toBe(true)
    expect(r.item).toMatchObject({ createdBy: 'agent', editedBy: 'agent', statusBy: 'agent', source: { runId: 'run_a', agentId: 'ag1', roleName: 'Lead' } })
    const n = events.length
    const dup = s.agentAdd(P1, { title: 'call bob' }, CALLER)
    expect(dup).toEqual({ item: r.item, changed: false })
    expect(events).toHaveLength(n)
    // a done item with the same title does not block a new one
    s.agentSetStatus(P1, r.item.id, 'done', CALLER)
    expect(s.agentAdd(P1, { title: 'Call Bob' }, CALLER).changed).toBe(true)
  })

  it('refuses a missing project and bad text', () => {
    const s = make()
    expect(() => s.agentAdd({ kind: 'project', projectId: 'gone' }, { title: 'x' }, CALLER)).toThrow('That project no longer exists.')
    expect(() => s.agentAdd(CHAT, { title: 7 }, CALLER)).toThrow('The title must be text.')
    expect(() => s.agentAdd(CHAT, { title: undefined }, CALLER)).toThrow('Give the item a short title.')
  })

  it('agentUpdate works on its own items and sets editedBy agent', () => {
    const s = make()
    const a = s.agentAdd(CHAT, { title: 'one' }, CALLER).item
    const r = s.agentUpdate(CHAT, a.id, { detail: 'extra' }, CALLER)
    expect(r.changed).toBe(true)
    expect(r.item.detail).toBe('extra')
    expect(r.item.updatedAt).toBeGreaterThan(a.updatedAt)
    expect(s.agentUpdate(CHAT, a.id, { detail: 'extra' }, CALLER).changed).toBe(false)
    expect(() => s.agentUpdate(CHAT, a.id, {}, CALLER)).toThrow('Give a new title or detail.')
  })

  it('agentUpdate is refused on user-created and user-edited items', () => {
    const s = make()
    const u = s.save({ scope: CHAT, title: 'mine' })
    expect(() => s.agentUpdate(CHAT, u.id, { title: 'theirs' }, CALLER)).toThrow('Only the user can change that item; add a new one instead.')
    const a = s.agentAdd(CHAT, { title: 'agent one' }, CALLER).item
    s.save({ scope: CHAT, id: a.id, title: 'agent one, edited' })
    expect(() => s.agentUpdate(CHAT, a.id, { title: 'again' }, CALLER)).toThrow('Only the user can change that item; add a new one instead.')
  })

  it('agentSetStatus works on a user item and is a no-op when unchanged', () => {
    const s = make()
    const u = s.save({ scope: CHAT, title: 'mine' })
    const r = s.agentSetStatus(CHAT, u.id, 'done', CALLER)
    expect(r.changed).toBe(true)
    expect(r.item).toMatchObject({ status: 'done', statusBy: 'agent', editedBy: 'user', createdBy: 'user' })
    expect(r.item.doneAt).toBeDefined()
    const n = events.length
    expect(s.agentSetStatus(CHAT, u.id, 'done', CALLER).changed).toBe(false)
    expect(events).toHaveLength(n)
    const back = s.agentSetStatus(CHAT, u.id, 'open', CALLER)
    expect(back.item.doneAt).toBeUndefined()
    expect(() => s.agentSetStatus(CHAT, 'bad', 'done', CALLER)).toThrow('No such to-do.')
  })

  it('limits successful writes per run', () => {
    const s = make()
    for (let i = 0; i < TODO_RUN_WRITES_MAX; i++) s.agentAdd(CHAT, { title: `t${i}` }, CALLER)
    expect(() => s.agentAdd(CHAT, { title: 'over' }, CALLER)).toThrow(
      `The to-do write limit for this run (${TODO_RUN_WRITES_MAX}) is reached; nothing was saved.`
    )
    expect(s.list(CHAT)).toHaveLength(TODO_RUN_WRITES_MAX)
    expect(s.agentAdd(CHAT, { title: 'other run' }, { runId: 'run_b' }).changed).toBe(true)
    // reads and dedupes still work for the limited run
    expect(s.agentList(CHAT).length).toBe(TODO_RUN_WRITES_MAX + 1)
    expect(s.agentAdd(CHAT, { title: 't0' }, CALLER).changed).toBe(false)
  })
})

describe('TodoService read-only store', () => {
  it('refuses writes with the store sentence', () => {
    fs.writeFileSync(path.join(dir, 'todos.json'), 'junk')
    const s = make()
    expect(s.readOnlyReason()).toContain('todos.json')
    expect(() => s.save({ scope: CHAT, title: 'x' })).toThrow(/read-only/)
    expect(() => s.agentAdd(CHAT, { title: 'x' }, CALLER)).toThrow(/read-only/)
    expect(events).toEqual([])
    expect(fs.readFileSync(path.join(dir, 'todos.json'), 'utf8')).toBe('junk')
  })
})
