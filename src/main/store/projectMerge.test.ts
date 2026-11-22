import { describe, expect, it } from 'vitest'
import { mergeIdList, mergeProject } from './projectMerge'

interface P {
  id: string
  updatedAt?: string
  name?: string
  brief?: string
  roles?: { id: string; name: string; prompt?: string }[]
  tags?: string[]
  extra?: unknown
}

const base: P = {
  id: 'p1',
  updatedAt: 't0',
  name: 'Alpha',
  brief: 'old brief',
  roles: [
    { id: 'lead', name: 'Lead' },
    { id: 'dev', name: 'Developer' },
    { id: 'qa', name: 'Tester' }
  ],
  tags: ['a', 'b']
}

describe('mergeProject', () => {
  it('puts only what the caller changed onto what the others saved', () => {
    const mine: P = { ...base, brief: 'my brief' }
    const theirs: P = { ...base, updatedAt: 't1', name: 'Alpha renamed' }
    expect(mergeProject(base, mine, theirs)).toEqual({ ...base, updatedAt: 't1', name: 'Alpha renamed', brief: 'my brief' })
  })

  it('a save that changed nothing leaves the others\' version exactly', () => {
    const theirs: P = { ...base, updatedAt: 't1', name: 'Theirs', extra: { added: true } }
    expect(mergeProject(base, { ...base }, theirs)).toEqual(theirs)
  })

  it('the same field changed by both: the caller\'s save wins, as any later save does', () => {
    const merged = mergeProject(base, { ...base, name: 'Mine' }, { ...base, updatedAt: 't1', name: 'Theirs' })
    expect(merged.name).toBe('Mine')
    expect(merged.updatedAt).toBe('t1')
  })

  it('a field the caller removed is removed; one the others added stays', () => {
    const mine: P = { ...base }
    delete mine.brief
    const merged = mergeProject(base, mine, { ...base, updatedAt: 't1', extra: 7 })
    expect('brief' in merged).toBe(false)
    expect(merged.extra).toBe(7)
  })

  it('lists of things with ids are merged per item: each side keeps its own edit, addition and removal', () => {
    const mine: P = {
      ...base,
      roles: [
        { id: 'lead', name: 'Lead' },
        { id: 'dev', name: 'Developer', prompt: 'mine' },
        { id: 'docs', name: 'Writer' }
      ]
    } // changed dev, removed qa, added docs
    const theirs: P = {
      ...base,
      updatedAt: 't1',
      roles: [
        { id: 'lead', name: 'Team lead' },
        { id: 'dev', name: 'Developer' },
        { id: 'qa', name: 'Tester' },
        { id: 'ops', name: 'Operations' }
      ]
    } // renamed lead, added ops
    expect(mergeProject(base, mine, theirs).roles).toEqual([
      { id: 'lead', name: 'Team lead' },
      { id: 'dev', name: 'Developer', prompt: 'mine' },
      { id: 'docs', name: 'Writer' },
      { id: 'ops', name: 'Operations' }
    ])
  })

  it('a plain list is one value: the caller\'s when the caller changed it', () => {
    expect(mergeProject(base, { ...base, tags: ['a', 'c'] }, { ...base, updatedAt: 't1', tags: ['a', 'b', 'd'] }).tags).toEqual(['a', 'c'])
    expect(mergeProject(base, { ...base }, { ...base, updatedAt: 't1', tags: ['a', 'b', 'd'] }).tags).toEqual(['a', 'b', 'd'])
  })

  it('never takes the id or updatedAt from the caller', () => {
    const merged = mergeProject(base, { ...base, id: 'other', updatedAt: 'mine' } as P, { ...base, updatedAt: 't1' })
    expect([merged.id, merged.updatedAt]).toEqual(['p1', 't1'])
  })
})

describe('mergeIdList', () => {
  const item = (id: string, v = 0) => ({ id, v })
  it('an item the others removed stays removed unless the caller changed it', () => {
    expect(mergeIdList([item('a'), item('b')], [item('a'), item('b')], [item('a')])).toEqual([item('a')])
    expect(mergeIdList([item('a'), item('b')], [item('a'), item('b', 1)], [item('a')])).toEqual([item('a'), item('b', 1)])
  })
  it('keeps the caller\'s order and appends what only the others added', () => {
    expect(mergeIdList([item('a'), item('b')], [item('b'), item('a')], [item('a'), item('b'), item('c')])).toEqual([item('b'), item('a'), item('c')])
  })
})
