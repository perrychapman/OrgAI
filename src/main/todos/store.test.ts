import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TODOS_MAX_PER_SCOPE, TODO_STARTED_RUNS_MAX } from '../../shared/types'
import type { TodoItem, TodoScope } from '../../shared/types'
import { TodoStore } from './store'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-todos-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const CHAT: TodoScope = { kind: 'chat' }
const PROJ: TodoScope = { kind: 'project', projectId: 'p1' }
const hex = (n: number): string => `todo_${n.toString(16).padStart(8, '0')}`

function item(n: number, over: Partial<TodoItem> = {}): TodoItem {
  return {
    id: hex(n),
    scope: CHAT,
    title: `Item ${n}`,
    status: 'open',
    createdAt: 1_700_000_000_000 + n,
    updatedAt: 1_700_000_000_000 + n,
    createdBy: 'user',
    editedBy: 'user',
    statusBy: 'user',
    ...over
  }
}

function rawFile(dataDir: string, lists: unknown, version: unknown = 1): void {
  fs.writeFileSync(path.join(dataDir, 'todos.json'), JSON.stringify({ version, lists }))
}

describe('TodoStore', () => {
  it('starts empty and writable; round trips through a fresh store', () => {
    const store = new TodoStore(path.join(dir, 'nested'))
    expect(store.readOnlyReason()).toBeNull()
    expect(store.list(CHAT)).toEqual([])
    const full = item(1, {
      detail: 'More',
      status: 'done',
      doneAt: 1_700_000_005_000,
      source: { runId: 'run_1', agentId: 'a:1', roleName: 'Lead' },
      startedRunIds: ['r1', 'r2']
    })
    store.update((d) => {
      d.lists.chat = [full]
    })
    const again = new TodoStore(path.join(dir, 'nested'))
    expect(again.list(CHAT)).toEqual([full])
    expect(again.get(CHAT, full.id)).toEqual(full)
    expect(again.get(PROJ, full.id)).toBeUndefined()
  })

  it('returns copies', () => {
    const store = new TodoStore(dir)
    store.update((d) => {
      d.lists.chat = [item(1)]
    })
    store.list(CHAT)[0].title = 'changed'
    expect(store.list(CHAT)[0].title).toBe('Item 1')
  })

  it('writes the .bak of the previous good file', () => {
    const store = new TodoStore(dir)
    store.update((d) => {
      d.lists.chat = [item(1)]
    })
    expect(fs.existsSync(`${store.file}.bak`)).toBe(false)
    store.update((d) => {
      d.lists.chat.push(item(2))
    })
    const bak = JSON.parse(fs.readFileSync(`${store.file}.bak`, 'utf8'))
    expect(bak.lists.chat).toHaveLength(1)
  })

  it('removes empty lists', () => {
    const store = new TodoStore(dir)
    store.update((d) => {
      d.lists.chat = [item(1)]
    })
    store.update((d) => {
      d.lists.chat = []
    })
    expect(JSON.parse(fs.readFileSync(store.file, 'utf8')).lists).toEqual({})
  })

  it('never overwrites an unreadable file, is read-only and shows the backup', () => {
    const good = new TodoStore(dir)
    good.update((d) => {
      d.lists.chat = [item(1)]
    })
    good.update((d) => {
      d.lists.chat.push(item(2))
    })
    fs.writeFileSync(good.file, '{ not json')
    const store = new TodoStore(dir)
    expect(store.readOnlyReason()).toContain('todos.json')
    expect(store.list(CHAT)).toHaveLength(1)
    expect(() => store.update((d) => void (d.lists.chat = []))).toThrow(/read-only/)
    expect(fs.readFileSync(store.file, 'utf8')).toBe('{ not json')
  })

  it('treats version 2 as unreadable', () => {
    rawFile(dir, { chat: [item(1)] }, 2)
    const store = new TodoStore(dir)
    expect(store.readOnlyReason()).not.toBeNull()
    expect(store.list(CHAT)).toEqual([])
  })

  it('re-checks the disk before persisting', () => {
    const store = new TodoStore(dir)
    store.update((d) => {
      d.lists.chat = [item(1)]
    })
    fs.writeFileSync(store.file, 'garbage')
    expect(() => store.update((d) => void d.lists.chat.push(item(2)))).toThrow(/read-only/)
    expect(store.readOnlyReason()).not.toBeNull()
    expect(fs.readFileSync(store.file, 'utf8')).toBe('garbage')
  })

  it('drops junk items field by field', () => {
    const bad: unknown[] = [
      { ...item(1), id: 'nope' },
      { ...item(2), title: 'has‮hidden' },
      { ...item(3), title: '' },
      { ...item(4), status: 'weird' },
      { ...item(5), createdAt: -1 },
      { ...item(6), createdBy: 'robot' },
      { ...item(7), scope: { kind: 'bogus' } },
      'string',
      null
    ]
    const ok = item(10, { extra: 'x' } as Partial<TodoItem>)
    rawFile(dir, { chat: [...bad, ok, item(10)] })
    const store = new TodoStore(dir)
    const list = store.list(CHAT)
    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('extra')
  })

  it('keeps doneAt only on done items and cleans source and startedRunIds', () => {
    rawFile(dir, {
      chat: [
        item(1, { doneAt: 1_700_000_009_000 }),
        item(2, { status: 'done', doneAt: 1_700_000_009_000, source: { runId: 'bad id!' } as TodoItem['source'] }),
        item(3, { source: { runId: 'r', agentId: 'bad id', roleName: 'bad​role' } as TodoItem['source'] }),
        item(4, { startedRunIds: ['a', 'a', 'bad id', ...Array.from({ length: 20 }, (_, i) => `r${i}`)] })
      ]
    })
    const list = new TodoStore(dir).list(CHAT)
    expect(list[0].doneAt).toBeUndefined()
    expect(list[1].doneAt).toBe(1_700_000_009_000)
    expect(list[1].source).toBeUndefined()
    expect(list[2].source).toEqual({ runId: 'r' })
    expect(list[3].startedRunIds).toHaveLength(TODO_STARTED_RUNS_MAX)
    expect(list[3].startedRunIds?.[0]).toBe('a')
  })

  it('drops an item that sits in the wrong list, and duplicate ids', () => {
    rawFile(dir, { chat: [item(1), item(2, { scope: PROJ })], 'project:p1': [item(3, { scope: PROJ }), item(1, { scope: PROJ })] })
    const store = new TodoStore(dir)
    expect(store.list(CHAT).map((i) => i.id)).toEqual([hex(1)])
    expect(store.list(PROJ).map((i) => i.id)).toEqual([hex(3)])
  })

  it('keeps the newest items past the per-list cap', () => {
    const many = Array.from({ length: TODOS_MAX_PER_SCOPE + 5 }, (_, i) => item(i + 1))
    rawFile(dir, { chat: many })
    const list = new TodoStore(dir).list(CHAT)
    expect(list).toHaveLength(TODOS_MAX_PER_SCOPE)
    expect(list.some((i) => i.id === hex(1))).toBe(false)
    expect(list.some((i) => i.id === hex(TODOS_MAX_PER_SCOPE + 5))).toBe(true)
  })

  it('logs a dropped count once without contents', () => {
    const logs: string[] = []
    rawFile(dir, { chat: [item(1), { ...item(2), title: 'secret‮' }] })
    new TodoStore(dir, { log: (m) => logs.push(m) })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('1 invalid')
    expect(logs[0]).not.toContain('secret')
  })
})
