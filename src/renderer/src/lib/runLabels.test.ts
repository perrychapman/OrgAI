import { describe, expect, it } from 'vitest'
import { promptLine, runIndexMap, runTag, runTitle, shortPrompt } from './runLabels'
import { runStatus } from './runStatus'

describe('runIndexMap', () => {
  it('numbers runs by start order, oldest first, regardless of input order', () => {
    const m = runIndexMap([
      { id: 'c', startedAt: 300 },
      { id: 'a', startedAt: 100 },
      { id: 'b', startedAt: 200 }
    ])
    expect([m.get('a'), m.get('b'), m.get('c')]).toEqual([1, 2, 3])
  })
  it('stays stable when a newer run joins', () => {
    const before = runIndexMap([
      { id: 'a', startedAt: 1 },
      { id: 'b', startedAt: 2 }
    ])
    const after = runIndexMap([
      { id: 'a', startedAt: 1 },
      { id: 'b', startedAt: 2 },
      { id: 'c', startedAt: 3 }
    ])
    expect(after.get('a')).toBe(before.get('a'))
    expect(after.get('b')).toBe(before.get('b'))
  })
  it('breaks ties by id', () => {
    const m = runIndexMap([
      { id: 'b', startedAt: 1 },
      { id: 'a', startedAt: 1 }
    ])
    expect(m.get('a')).toBe(1)
  })
})

describe('labels', () => {
  it('formats tags and titles', () => {
    expect(runTag(2)).toBe('R2')
    expect(runTag(undefined)).toBe('R?')
    expect(runTitle(2, 'Add caching')).toBe('R2: Add caching')
  })
  it('collapses whitespace and cuts long prompts', () => {
    expect(promptLine('  a\n\n b ')).toBe('a b')
    expect(promptLine('   ')).toBe('Image prompt')
    expect(shortPrompt('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('runStatus', () => {
  it('uses one vocabulary', () => {
    expect(runStatus('running').word).toBe('Working')
    expect(runStatus('starting').word).toBe('Working')
    expect(runStatus('stopping').word).toBe('Working')
    expect(runStatus('idle').word).toBe('Idle')
    expect(runStatus('paused').word).toBe('Paused')
    expect(runStatus('finished').word).toBe('Finished')
    expect(runStatus('error').word).toBe('Failed')
  })
  it('lets waiting win and keeps the app-exit detail in the note', () => {
    expect(runStatus('running', { waiting: true })).toEqual({ word: 'Waiting for you', tone: 'warn' })
    expect(runStatus('finished', { endedWithApp: true })).toMatchObject({ word: 'Finished', note: 'Ended when OrgAI closed' })
  })
  it('maps words to tones', () => {
    expect(runStatus('running').tone).toBe('is-running')
    expect(runStatus('error').tone).toBe('danger')
    expect(runStatus('finished').tone).toBe('ok')
  })
})
