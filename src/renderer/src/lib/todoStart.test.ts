import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TodoItem } from '@shared/types'

vi.stubGlobal('window', { orgai: {}, dispatchEvent: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() })
vi.stubGlobal('Event', class {})
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
  cb()
  return 0
})

import type { ComposerDraft } from '../store/useAppStore'
import type { ConfirmOptions } from '../components/ui/ConfirmDialog'

const { useAppStore } = await import('../store/useAppStore')
const start = await import('./todoStart')

type Drafts = Record<string, ComposerDraft>

function fakeStore(initial: Drafts = {}): {
  subscribe: (l: (s: { composerDrafts: Drafts }, p: { composerDrafts: Drafts }) => void) => () => void
  getState: () => { composerDrafts: Drafts }
  set: (d: Drafts) => void
} {
  let state = { composerDrafts: initial }
  const listeners = new Set<(s: { composerDrafts: Drafts }, p: { composerDrafts: Drafts }) => void>()
  return {
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getState: () => state,
    set: (d) => {
      const prev = state
      state = { composerDrafts: d }
      for (const l of listeners) l(state, prev)
    }
  }
}

const link = { key: 'new:p1', scope: { kind: 'project', projectId: 'p1' } as const, id: 'todo_1' }

function item(over: Partial<TodoItem> = {}): TodoItem {
  return {
    id: 'todo_1',
    scope: { kind: 'project', projectId: 'p1' },
    title: 'Fix the login page',
    status: 'open',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'user',
    editedBy: 'user',
    statusBy: 'user',
    ...over
  }
}

beforeEach(() => start.clearPendingTodoStarts())

describe('pending links', () => {
  it('takes a link once', () => {
    start.setPendingTodoStart(link)
    expect(start.takeTodoStart('new:p1')).toEqual(link)
    expect(start.takeTodoStart('new:p1')).toBeUndefined()
    expect(start.takeTodoStart('new:other')).toBeUndefined()
  })

  it('restores a taken link unless another took the slot', () => {
    start.setPendingTodoStart(link)
    const taken = start.takeTodoStart('new:p1')
    start.restoreTodoStart(taken)
    expect(start.hasPendingTodoStart('new:p1')).toBe(true)
    start.takeTodoStart('new:p1')
    start.setPendingTodoStart({ ...link, id: 'todo_2' })
    start.restoreTodoStart(taken)
    expect(start.takeTodoStart('new:p1')?.id).toBe('todo_2')
    start.restoreTodoStart(undefined)
  })

  it('replaces the link when another to-do starts into the same draft', () => {
    start.setPendingTodoStart(link)
    start.setPendingTodoStart({ ...link, id: 'todo_2' })
    expect(start.takeTodoStart('new:p1')?.id).toBe('todo_2')
  })

  it('links the started run, and swallows a failure', async () => {
    const linkRun = vi.fn(async () => ({}))
    ;(window as unknown as { orgai: unknown }).orgai = { todos: { linkRun } }
    await start.linkTodoStart(link, 'run_1')
    expect(linkRun).toHaveBeenCalledWith({ scope: link.scope, id: 'todo_1', runId: 'run_1' })
    await start.linkTodoStart(undefined, 'run_1')
    await start.linkTodoStart(link, undefined)
    expect(linkRun).toHaveBeenCalledTimes(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    ;(window as unknown as { orgai: unknown }).orgai = { todos: { linkRun: vi.fn(async () => Promise.reject(new Error('no'))) } }
    await expect(start.linkTodoStart(link, 'run_1')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    ;(window as unknown as { orgai: unknown }).orgai = {}
    await expect(start.linkTodoStart(link, 'run_1')).resolves.toBeUndefined()
  })
})

describe('linkedStart', () => {
  const lead = 'To-do: Fix the login page'
  const linkRun = vi.fn(async () => ({}))
  beforeEach(() => {
    linkRun.mockClear()
    ;(window as unknown as { orgai: unknown }).orgai = { todos: { linkRun } }
  })

  it('links the run while the text still begins with the first line, extra text included', async () => {
    start.setPendingTodoStart({ ...link, lead })
    await start.linkedStart('new:p1', async () => 'run_1', (r) => r)(`${lead}\n\nMore\n\nand my own words`, undefined)
    expect(linkRun).toHaveBeenCalledWith({ scope: link.scope, id: 'todo_1', runId: 'run_1' })
    linkRun.mockClear()
    start.setPendingTodoStart({ ...link, lead })
    await start.linkedStart('new:p1', async () => 'run_2', (r) => r)(`  ${lead}  `, undefined)
    expect(linkRun).toHaveBeenCalledTimes(1)
  })

  it('drops the link silently when the whole text was replaced', async () => {
    start.setPendingTodoStart({ ...link, lead })
    const startFn = vi.fn(async () => 'run_1')
    await start.linkedStart('new:p1', startFn, (r) => r)('Something else entirely', undefined)
    expect(startFn).toHaveBeenCalled()
    expect(linkRun).not.toHaveBeenCalled()
    expect(start.hasPendingTodoStart('new:p1')).toBe(false)
  })

  it('gives the link back when a matching start throws', async () => {
    start.setPendingTodoStart({ ...link, lead })
    await expect(start.linkedStart('new:p1', async (): Promise<string> => Promise.reject(new Error('no')), (r) => r)(lead, undefined)).rejects.toThrow('no')
    expect(start.hasPendingTodoStart('new:p1')).toBe(true)
  })
})

describe('discard rule', () => {
  it('drops the link when the draft empties without a send', async () => {
    const store = fakeStore({ 'new:p1': { text: 'To-do: x', images: [] } })
    start.watchTodoDrafts(store)
    start.setPendingTodoStart(link)
    store.set({})
    await Promise.resolve()
    expect(start.hasPendingTodoStart('new:p1')).toBe(false)
  })

  it('keeps the link when a send takes it before the microtask', async () => {
    const store = fakeStore({ 'new:p1': { text: 'To-do: x', images: [] } })
    start.watchTodoDrafts(store)
    start.setPendingTodoStart(link)
    store.set({})
    // The start handler runs synchronously after the draft empties.
    const taken = start.takeTodoStart('new:p1')
    await Promise.resolve()
    expect(taken).toEqual(link)
    // A failed start brings the draft and the link back.
    start.restoreTodoStart(taken)
    store.set({ 'new:p1': { text: 'To-do: x', images: [] } })
    await Promise.resolve()
    expect(start.hasPendingTodoStart('new:p1')).toBe(true)
  })

  it('keeps the link while the draft still has text, or when the draft refills at once', async () => {
    const store = fakeStore({ 'new:p1': { text: 'To-do: x', images: [] } })
    start.watchTodoDrafts(store)
    start.setPendingTodoStart(link)
    store.set({ 'new:p1': { text: 'To-do: x edited', images: [] } })
    await Promise.resolve()
    expect(start.hasPendingTodoStart('new:p1')).toBe(true)
    store.set({})
    store.set({ 'new:p1': { text: 'back', images: [] } })
    await Promise.resolve()
    expect(start.hasPendingTodoStart('new:p1')).toBe(true)
  })

  it('does not touch links of other drafts', async () => {
    const store = fakeStore({ 'new:p1': { text: 'a', images: [] }, 'new:p2': { text: 'b', images: [] } })
    start.watchTodoDrafts(store)
    start.setPendingTodoStart(link)
    store.set({ 'new:p1': { text: 'a', images: [] } })
    await Promise.resolve()
    expect(start.hasPendingTodoStart('new:p1')).toBe(true)
  })
})

describe('startSessionFromTodo', () => {
  const open = vi.fn()
  const select = vi.fn()
  const openAssistant = vi.fn(async () => undefined)
  beforeEach(() => {
    open.mockClear()
    select.mockClear()
    openAssistant.mockClear()
    useAppStore.setState({ selectedProjectId: 'p1', composerDrafts: {}, openDraft: open, selectProject: select, openAssistant } as never)
  })

  it('fills an empty draft, opens the draft page and links without asking', async () => {
    const confirm = vi.fn(async () => true)
    expect(await start.startSessionFromTodo(item({ detail: 'More' }), confirm)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    expect(useAppStore.getState().composerDrafts['new:p1'].text).toBe('To-do: Fix the login page\n\nMore')
    expect(start.takeTodoStart('new:p1')?.lead).toBe('To-do: Fix the login page')
  })

  it('uses a fresh Chat start page for the chat list', async () => {
    const chat = item({ scope: { kind: 'chat' } })
    await start.startSessionFromTodo(chat, vi.fn(async () => true))
    expect(openAssistant).toHaveBeenCalledWith('quick', { fresh: true })
    expect(useAppStore.getState().composerDrafts['new:quick'].text).toBe('To-do: Fix the login page')
    expect(start.takeTodoStart('new:quick')?.scope).toEqual({ kind: 'chat' })
  })

  it('selects the project when another one is open', async () => {
    useAppStore.setState({ selectedProjectId: 'other' } as never)
    await start.startSessionFromTodo(item(), vi.fn(async () => true))
    expect(select).toHaveBeenCalledWith('p1')
  })

  it('asks before replacing an unsent message and stops when declined', async () => {
    useAppStore.setState({ composerDrafts: { 'new:p1': { text: 'my own words', images: [] } } } as never)
    const confirm = vi.fn(async (_o: ConfirmOptions) => false)
    expect(await start.startSessionFromTodo(item(), confirm)).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toMatchObject({ title: 'Replace your unsent message?', confirmTestId: 'todo-replace-draft-confirm' })
    expect(open).not.toHaveBeenCalled()
    expect(useAppStore.getState().composerDrafts['new:p1'].text).toBe('my own words')
    expect(start.hasPendingTodoStart('new:p1')).toBe(false)
  })

  it('replaces the message once confirmed, and not at all when it already is the prompt', async () => {
    useAppStore.setState({ composerDrafts: { 'new:p1': { text: 'my own words', images: [] } } } as never)
    expect(await start.startSessionFromTodo(item(), vi.fn(async () => true))).toBe(true)
    expect(useAppStore.getState().composerDrafts['new:p1'].text).toBe('To-do: Fix the login page')
    const confirm = vi.fn(async () => true)
    expect(await start.startSessionFromTodo(item(), confirm)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
})
