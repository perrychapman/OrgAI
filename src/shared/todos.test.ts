import { describe, expect, it } from 'vitest'
import { cleanTodoScope, cleanTodoText, sameTodoScope, sortTodos, todoScopeKey, todoStartPrompt } from './todos'
import { TODO_DETAIL_MAX_CHARS, TODO_TITLE_MAX_CHARS, type TodoItem } from './types'

function item(over: Partial<TodoItem>): TodoItem {
  return { id: 'todo_a', scope: { kind: 'chat' }, title: 't', status: 'open', createdAt: 1, updatedAt: 1, createdBy: 'user', editedBy: 'user', statusBy: 'user', ...over }
}

describe('scope', () => {
  it('keys and compares', () => {
    expect(todoScopeKey({ kind: 'chat' })).toBe('chat')
    expect(todoScopeKey({ kind: 'project', projectId: 'p1' })).toBe('project:p1')
    expect(sameTodoScope({ kind: 'chat' }, { kind: 'chat' })).toBe(true)
    expect(sameTodoScope({ kind: 'project', projectId: 'a' }, { kind: 'project', projectId: 'b' })).toBe(false)
    expect(sameTodoScope({ kind: 'project', projectId: 'a' }, { kind: 'chat' })).toBe(false)
  })
  it('rebuilds untrusted input', () => {
    const raw = { kind: 'project', projectId: 'p1', extra: 1 }
    const out = cleanTodoScope(raw)
    expect(out).toEqual({ kind: 'project', projectId: 'p1' })
    expect(out).not.toBe(raw)
    expect(cleanTodoScope({ kind: 'chat', projectId: 'x' })).toEqual({ kind: 'chat' })
    for (const bad of [null, 'chat', 5, {}, { kind: 'project' }, { kind: 'project', projectId: '' }, { kind: 'project', projectId: 3 }, { kind: 'project', projectId: 'x'.repeat(201) }, { kind: 'other' }]) {
      expect(cleanTodoScope(bad)).toBeNull()
    }
    expect(cleanTodoScope({ kind: 'project', projectId: 'x'.repeat(200) })).not.toBeNull()
  })
})

describe('cleanTodoText', () => {
  it('trims and collapses whitespace in the title', () => {
    expect(cleanTodoText({ title: '  Fix \n the   bug\t now ' })).toEqual({ ok: true, title: 'Fix the bug now' })
  })
  it('returns only the fields given', () => {
    expect(cleanTodoText({})).toEqual({ ok: true })
    expect(cleanTodoText({ detail: ' more\nlines ' })).toEqual({ ok: true, detail: 'more\nlines' })
  })
  it('clears detail with null or blank', () => {
    expect(cleanTodoText({ detail: null })).toEqual({ ok: true, detail: null })
    expect(cleanTodoText({ detail: '   ' })).toEqual({ ok: true, detail: null })
  })
  it('refuses empty, non-text and over-long input without cutting', () => {
    expect(cleanTodoText({ title: '   ' }).ok).toBe(false)
    expect(cleanTodoText({ title: 5 }).ok).toBe(false)
    expect(cleanTodoText({ detail: 5 }).ok).toBe(false)
    expect(cleanTodoText({ title: 'a'.repeat(TODO_TITLE_MAX_CHARS) }).ok).toBe(true)
    expect(cleanTodoText({ title: 'a'.repeat(TODO_TITLE_MAX_CHARS + 1) }).ok).toBe(false)
    expect(cleanTodoText({ detail: 'a'.repeat(TODO_DETAIL_MAX_CHARS) }).ok).toBe(true)
    const long = cleanTodoText({ detail: 'a'.repeat(TODO_DETAIL_MAX_CHARS + 1) })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.problem).toMatch(/longer than/)
  })
  it('refuses hidden characters', () => {
    for (const c of ['‮', '​', '\u0007', '­', 'ㅤ', '\u{e0041}']) {
      expect(cleanTodoText({ title: `a${c}b` }).ok).toBe(false)
      expect(cleanTodoText({ detail: `a${c}b` }).ok).toBe(false)
    }
  })
})

describe('sortTodos', () => {
  it('puts open first by newest created, then done by newest done, and does not mutate', () => {
    const items = [
      item({ id: 'd1', status: 'done', doneAt: 10 }),
      item({ id: 'o1', createdAt: 1 }),
      item({ id: 'd2', status: 'done', doneAt: 20 }),
      item({ id: 'o2', createdAt: 5 })
    ]
    const copy = JSON.parse(JSON.stringify(items))
    expect(sortTodos(items).map((i) => i.id)).toEqual(['o2', 'o1', 'd2', 'd1'])
    expect(items).toEqual(copy)
  })
  it('is stable for ties', () => {
    const items = [item({ id: 'a', createdAt: 3 }), item({ id: 'b', createdAt: 3 }), item({ id: 'c', createdAt: 3 })]
    expect(sortTodos(items).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('todoStartPrompt', () => {
  it('uses the title, plus the detail after a blank line', () => {
    expect(todoStartPrompt(item({ title: 'Call Sam' }))).toBe('To-do: Call Sam')
    expect(todoStartPrompt(item({ title: 'Call Sam', detail: 'About the lease' }))).toBe('To-do: Call Sam\n\nAbout the lease')
  })
})
