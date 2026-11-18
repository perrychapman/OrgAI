import { describe, expect, it, vi } from 'vitest'
import type { TodoItem, TranscriptBlock } from '@shared/types'
import { MOCK_TODO_ADDED, MOCK_TODO_DETAIL, MOCK_TODO_NONE, MOCK_TODO_TITLE, MockAdapter, TODO_TOKEN, type MockSession } from './mock'
import type { RuntimeContext, RuntimeTodoAccess } from './types'
import { fakeCtx, runSummary } from './testHelpers'

const quick = { folder: '/some/folder', team: 'single' as const, allowEdits: false, gitRepo: false }

/** A fake list that behaves like the service for what the mock touches: a duplicate open title is not a change. */
function fakeTodos(refuse?: string): RuntimeTodoAccess & { items: TodoItem[] } {
  const items: TodoItem[] = []
  return {
    items,
    scope: 'chat',
    list: () => items,
    add: (text) => {
      if (refuse) throw new Error(refuse)
      const dup = items.find((i) => i.title === text.title && i.status === 'open')
      if (dup) return { item: dup, changed: false }
      const item: TodoItem = {
        id: `todo_${items.length + 1}`,
        scope: { kind: 'chat' } as TodoItem['scope'],
        title: text.title,
        ...(text.detail ? { detail: text.detail } : {}),
        status: 'open',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'agent',
        editedBy: 'agent'
      } as TodoItem
      items.push(item)
      return { item, changed: true }
    },
    setStatus: () => {
      throw new Error('unused')
    },
    update: () => {
      throw new Error('unused')
    }
  }
}

async function runToIdle(ctx: ReturnType<typeof fakeCtx>): Promise<MockSession> {
  const session = (await new MockAdapter({ script: { delayMs: 0 } }).start(ctx)) as MockSession
  await vi.waitFor(() => expect(ctx.events.some((e) => e.type === 'run.status' && e.status === 'idle')).toBe(true), { timeout: 3000 })
  return session
}
const blocks = (ctx: ReturnType<typeof fakeCtx>): TranscriptBlock[] => ctx.events.flatMap((e) => (e.type === 'transcript' ? [e.entry.block] : []))
const texts = (ctx: ReturnType<typeof fakeCtx>) => blocks(ctx).flatMap((b) => (b.kind === 'text' ? [b.text] : []))
const stopAll = async (s: MockSession): Promise<void> => {
  await s.stop()
  await s.finished
}
const make = (over: Partial<RuntimeContext>, chat: boolean) =>
  fakeCtx({ run: chat ? runSummary({ projectId: 'quick', quick, prompt: TODO_TOKEN }) : runSummary({ prompt: TODO_TOKEN }), prompt: `note this ${TODO_TOKEN}`, autoContinue: false, ...over } as Partial<RuntimeContext>)

describe('mock [mock:todo]', () => {
  it.each([[true], [false]])('chat=%s: calls the real todo_list add and says it was added', async (chat) => {
    const todos = fakeTodos()
    const ctx = make({ todos }, chat)
    const session = await runToIdle(ctx)
    expect(todos.items).toHaveLength(1)
    expect(todos.items[0]).toMatchObject({ title: MOCK_TODO_TITLE, detail: MOCK_TODO_DETAIL })
    const use = blocks(ctx).find((b) => b.kind === 'tool_use' && b.name === 'todo_list')
    expect(use).toMatchObject({ input: { action: 'add', title: MOCK_TODO_TITLE, detail: MOCK_TODO_DETAIL } })
    expect(texts(ctx)).toEqual([MOCK_TODO_ADDED])
    await stopAll(session)
  })

  it('an item already open on the list is a duplicate from the tool and still says added (not a refusal)', async () => {
    const todos = fakeTodos()
    todos.add({ title: MOCK_TODO_TITLE }, {})
    const ctx = make({ todos }, true)
    const session = await runToIdle(ctx)
    const results = blocks(ctx).flatMap((b) => (b.kind === 'tool_result' ? [String(b.content)] : []))
    expect(results[0]).toMatch(/^Already on the list \(open\)/)
    expect(todos.items).toHaveLength(1)
    expect(texts(ctx)).toEqual([MOCK_TODO_ADDED])
    await stopAll(session)
  })

  it('a refusal is said back as the tool result', async () => {
    const ctx = make({ todos: fakeTodos('The to-do list is full.') }, true)
    const session = await runToIdle(ctx)
    expect(texts(ctx)).toEqual(['REFUSED: The to-do list is full.'])
    await stopAll(session)
  })

  it('without ctx.todos the root says to-dos are not available', async () => {
    const ctx = make({}, true)
    const session = await runToIdle(ctx)
    expect(texts(ctx)).toEqual([MOCK_TODO_NONE])
    await stopAll(session)
  })
})
