import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveRunChange, RunEvent } from '@shared/types'
import { reportLiveEvent, reportLiveRuns, useLiveChangeStore } from './liveChangeStore'

type Ev = Extract<RunEvent, { type: 'run.liveChange' }>
const ev = (what: Ev['what'], change: Partial<LiveRunChange> & { runId?: string }): Ev => ({
  type: 'run.liveChange',
  runId: change.runId ?? 'r1',
  projectId: 'p1',
  source: 'user',
  what,
  change: { runId: 'r1', title: 'Run', availability: 'now', ...change }
})
const note = () => useLiveChangeStore.getState().notes.p1

describe('liveChangeStore events', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { window?: unknown }).window = globalThis
    useLiveChangeStore.setState({ notes: {} })
  })
  afterEach(() => {
    reportLiveRuns('p1', 'mcp', undefined)
    vi.useRealTimers()
  })

  it('an org chart event makes one line on the orgChart surface; the final answer replaces the pending one', () => {
    reportLiveEvent(ev(['orgChart'], { availability: 'pending' }))
    expect(note().surface).toBe('orgChart')
    expect(note().lines.map((l) => l.availability)).toEqual(['pending'])
    vi.advanceTimersByTime(3_000)
    reportLiveEvent(ev(['orgChart'], { availability: 'now' }))
    expect(note().lines.map((l) => l.availability)).toEqual(['now'])
  })

  it('events of one save for two runs share the note; a later save replaces it', () => {
    reportLiveEvent(ev(['orgChart'], { runId: 'a' }))
    reportLiveEvent(ev(['orgChart'], { runId: 'b' }))
    expect(note().lines.map((l) => l.runId)).toEqual(['a', 'b'])
    vi.advanceTimersByTime(6_000)
    reportLiveEvent(ev(['orgChart'], { runId: 'a' }))
    expect(note().lines.map((l) => l.runId)).toEqual(['a'])
  })

  it('an mcp or skills event never adds a line next to its result line, but resolves its pending one', () => {
    reportLiveEvent(ev(['skills', 'grants'], { availability: 'now' }))
    expect(note()).toBeUndefined()
    reportLiveRuns('p1', 'role:x', [{ runId: 'r1', title: 'Run', availability: 'pending' }], { kind: 'grant', name: 'api-design' })
    expect(note().lines[0].text).toMatch(/^Applying access to api-design/)
    reportLiveEvent(ev(['skills', 'grants'], { availability: 'after-idle' }))
    expect(note().surface).toBe('role:x')
    expect(note().lines).toHaveLength(1)
    expect(note().lines[0].text).toMatch(/^Can use api-design once its agents are idle/)
  })

  it('a grants-only event reads its grants', () => {
    reportLiveEvent(ev(['orgChart', 'grants'], { grants: [{ role: 'Implementer', item: 'api-design', kind: 'skill', granted: false }] }))
    expect(note().lines[0].effect).toBe('No longer uses api-design')
  })
})
