import { describe, expect, it } from 'vitest'
import type { TodoItem } from '../types'
import { todoListView, todoScopeFor, todosCountLabel } from './todos'

function item(over: Partial<TodoItem> & { id: string }): TodoItem {
  return {
    scope: { kind: 'chat' },
    title: `Title ${over.id}`,
    status: 'open',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'user',
    editedBy: 'user',
    statusBy: 'user',
    ...over
  }
}

const all = { runExists: () => true }

describe('todoScopeFor', () => {
  it('maps chat, projects and other assistants', () => {
    expect(todoScopeFor('quick')).toEqual({ kind: 'chat' })
    expect(todoScopeFor('p1')).toEqual({ kind: 'project', projectId: 'p1' })
    expect(todoScopeFor('skills')).toBeNull()
    expect(todoScopeFor('harness')).toBeNull()
    expect(todoScopeFor('')).toBeNull()
  })
})

describe('todosCountLabel', () => {
  it('pluralises', () => {
    expect(todosCountLabel(1)).toBe('1 open to-do')
    expect(todosCountLabel(0)).toBe('0 open to-dos')
    expect(todosCountLabel(3)).toBe('3 open to-dos')
  })
})

describe('todoListView', () => {
  it('orders open newest first, done newest done first', () => {
    const v = todoListView(
      [
        item({ id: 'a', createdAt: 1 }),
        item({ id: 'b', createdAt: 3 }),
        item({ id: 'c', createdAt: 2, status: 'done', doneAt: 10 }),
        item({ id: 'd', createdAt: 5, status: 'done', doneAt: 20 })
      ],
      all
    )
    expect(v.open.map((r) => r.id)).toEqual(['b', 'a'])
    expect(v.done.map((r) => r.id)).toEqual(['d', 'c'])
    expect(v.openCount).toBe(2)
    expect(v.doneCount).toBe(2)
    expect(v.open[0].canStart).toBe(true)
    expect(v.done[0].canStart).toBe(false)
  })

  it('marks the source only for agent items', () => {
    const v = todoListView(
      [
        item({ id: 'u', createdBy: 'user', source: { runId: 'r1' } }),
        item({ id: 'g', createdBy: 'agent', source: { runId: 'r1' } }),
        item({ id: 'r', createdBy: 'agent', source: { runId: 'r1', roleName: 'Researcher' } })
      ],
      all
    )
    const by = Object.fromEntries(v.open.map((r) => [r.id, r]))
    expect(by.u.sourceText).toBeUndefined()
    expect(by.u.sourceRunId).toBeUndefined()
    expect(by.g.sourceText).toBe('Added by assistant')
    expect(by.r.sourceText).toBe('Added by Researcher')
    expect(by.r.sourceRunId).toBe('r1')
  })

  it('clamps a long agent-written role name', () => {
    const v = todoListView([item({ id: 'x', createdBy: 'agent', source: { runId: 'r', roleName: 'R'.repeat(100) } })], all)
    expect(v.open[0].sourceText).toBe(`Added by ${'R'.repeat(39)}…`)
  })

  it('links runs only while they exist', () => {
    const known = { runExists: (id: string) => id === 'live' }
    const v = todoListView(
      [item({ id: 'a', createdBy: 'agent', source: { runId: 'gone' }, startedRunIds: ['live', 'gone'] }), item({ id: 'b', createdBy: 'agent', source: { runId: 'live' } })],
      known
    )
    const by = Object.fromEntries(v.open.map((r) => [r.id, r]))
    expect(by.a.sourceText).toBe('Added by assistant')
    expect(by.a.sourceRunId).toBeUndefined()
    expect(by.a.startedRuns).toEqual([
      { id: 'live', exists: true },
      { id: 'gone', exists: false }
    ])
    expect(by.b.sourceRunId).toBe('live')
  })

  it('keeps title whole, clamps only the check label, and carries detail and the start prompt', () => {
    const title = 'T'.repeat(150)
    const v = todoListView([item({ id: 'a', title, detail: 'More\ntext' }), item({ id: 'b' })], all)
    const a = v.open.find((r) => r.id === 'a')!
    expect(a.title).toBe(title)
    expect(a.checkLabel).toBe(`${'T'.repeat(79)}…`)
    expect(a.detail).toBe('More\ntext')
    expect(a.startPrompt).toBe(`To-do: ${title}\n\nMore\ntext`)
    expect(v.open.find((r) => r.id === 'b')!.detail).toBeUndefined()
  })

  it('handles an empty list', () => {
    expect(todoListView([], all)).toEqual({ open: [], done: [], openCount: 0, doneCount: 0 })
  })
})
