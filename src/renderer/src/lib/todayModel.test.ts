import { describe, expect, it } from 'vitest'
import type { TodoItem } from '@shared/types'
import { openTodoRows } from './todayModel'

function todo(id: string, scope: TodoItem['scope'], updatedAt: number, over: Partial<TodoItem> = {}): TodoItem {
  return { id, scope, title: id, status: 'open', createdAt: 0, updatedAt, createdBy: 'user', editedBy: 'user', statusBy: 'user', ...over }
}

describe('openTodoRows', () => {
  const projects = [
    { id: 'p1', name: 'Billing API' },
    { id: 'p2', name: 'Docs' }
  ]

  it('leaves done items out and sorts newest first across lists', () => {
    const rows = openTodoRows(
      {
        chat: [todo('c1', { kind: 'chat' }, 30), todo('c2', { kind: 'chat' }, 50, { status: 'done' })],
        'project:p1': [todo('a', { kind: 'project', projectId: 'p1' }, 40), todo('b', { kind: 'project', projectId: 'p1' }, 10)],
        'project:p2': [todo('d', { kind: 'project', projectId: 'p2' }, 20)]
      },
      projects
    )
    expect(rows.map((r) => r.item.id)).toEqual(['a', 'c1', 'd', 'b'])
  })

  it('captions Chat and project lists and flags assistant items', () => {
    const rows = openTodoRows({ chat: [todo('c', { kind: 'chat' }, 2, { createdBy: 'agent' })], 'project:p1': [todo('a', { kind: 'project', projectId: 'p1' }, 1)] }, projects)
    expect(rows.map((r) => [r.list, r.agentAdded])).toEqual([['Chat', true], ['Billing API', false]])
  })

  it('skips items of a project that is gone and tolerates missing lists', () => {
    const rows = openTodoRows({ 'project:gone': [todo('x', { kind: 'project', projectId: 'gone' }, 1)], 'project:p1': undefined }, projects)
    expect(rows).toEqual([])
  })
})
