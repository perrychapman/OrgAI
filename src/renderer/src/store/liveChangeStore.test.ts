import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveRunChange, RunEvent } from '@shared/types'
import { expectInspectorSave, reportLiveEvent, reportLiveRuns, trackRoles, useLiveChangeStore } from './liveChangeStore'

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

  it('an event for a save the role inspector made goes to that role and group, not the org chart', () => {
    expectInspectorSave('p1', 'role:x', 'skills')
    reportLiveEvent(ev(['orgChart', 'grants'], { grants: [{ role: 'Dev', item: 'api-design', kind: 'skill', granted: false }] }))
    expect(note().surface).toBe('role:x')
    expect(note().part).toBe('skills')
    expect(note().lines[0].effect).toBe('No longer uses api-design')
    // A save without grants (a rename) is still the org chart's.
    vi.advanceTimersByTime(6_000)
    reportLiveEvent(ev(['orgChart'], {}))
    expect(note().surface).toBe('orgChart')
  })

  it('names an added, removed or edited role from the roster change, also when the roster arrives after the event', () => {
    const lead = { id: 'l', name: 'Lead', prompt: 'p' }
    trackRoles('p1', [lead])
    trackRoles('p1', [lead, { id: 'd', name: 'Dev', prompt: '' }])
    reportLiveEvent(ev(['orgChart'], {}))
    expect(note().lines[0].effect).toBe('Added Dev to this run')
    vi.advanceTimersByTime(10_000)
    reportLiveEvent(ev(['orgChart'], {}))
    expect(note().lines[0].effect).toBe('Org chart changes are in use now')
    vi.advanceTimersByTime(1_000)
    trackRoles('p1', [{ ...lead, prompt: 'q' }, { id: 'd', name: 'Dev', prompt: '' }])
    expect(note().lines[0].effect).toMatch(/^Updated Lead is in use now/)
  })

  it('the line ends 20 s after the final answer, and never later than 30 s after the save', () => {
    reportLiveEvent(ev(['orgChart'], { availability: 'pending' }))
    vi.advanceTimersByTime(15_000)
    reportLiveEvent(ev(['orgChart'], { availability: 'now' }))
    // 20 s after the final answer would be 35 s after the save: the 30 s ceiling wins.
    vi.advanceTimersByTime(14_000)
    expect(note()).toBeDefined()
    vi.advanceTimersByTime(1_000)
    expect(note()).toBeUndefined()
    reportLiveEvent(ev(['orgChart'], { availability: 'now' }))
    vi.advanceTimersByTime(19_000)
    expect(note()).toBeDefined()
    vi.advanceTimersByTime(1_000)
    expect(note()).toBeUndefined()
  })

  it('a grants-only event reads its grants', () => {
    reportLiveEvent(ev(['orgChart', 'grants'], { grants: [{ role: 'Implementer', item: 'api-design', kind: 'skill', granted: false }] }))
    expect(note().lines[0].effect).toBe('No longer uses api-design')
  })
})
