import { describe, expect, it } from 'vitest'
import type { PendingCards, Project, RunEvent, RunRecord, RunSummary } from '../../shared/types'
import { EventJournal } from './eventJournal'
import { HostRpcFailure } from './registry'
import { RECENT_ENDED_MS, RunSubscription, filterKeyOf, followedRunsOf, parseRunsSubscribeInput, subscribeRuns, type RunsView } from './runSubscriptions'

const NOW = 1_800_000_000_000

function summary(id: string, projectId: string, extra: Partial<RunSummary> = {}): RunSummary {
  return { id, projectId, status: 'running', startedAt: NOW - 1000, prompt: 'p', kind: 'work', ...extra } as RunSummary
}

class FakeView implements RunsView {
  live = new Map<string, RunSummary>()
  stored = new Map<string, RunSummary>()
  records = new Map<string, RunRecord>()
  liveRuns(): RunSummary[] {
    return [...this.live.values()]
  }
  pendingCards(runId: string): PendingCards {
    return { runId } as unknown as PendingCards
  }
  get(runId: string): RunRecord | null {
    return this.records.get(runId) ?? null
  }
  list(projectId: string): RunSummary[] {
    const all = new Map([...this.stored, ...this.live])
    return [...all.values()].filter((s) => s.projectId === projectId)
  }
  summaryOf(runId: string): RunSummary | undefined {
    return this.live.get(runId)
  }
  summary(runId: string): RunSummary | null {
    return this.live.get(runId) ?? this.stored.get(runId) ?? null
  }
}

const status = (runId: string): RunEvent => ({ type: 'run.status', runId, status: 'running' })
const logOf = (runId: string): RunEvent => ({ type: 'log', runId, level: 'info', message: 'x' })

function deps(view: FakeView, journal = new EventJournal()) {
  return { view, journal, hostInstanceId: 'aaaaaaaaaaaa', storedProjectIds: () => ['p1', 'p2'], now: () => NOW }
}

describe('parseRunsSubscribeInput', () => {
  it('dedupes and sorts ids and refuses bad shapes', () => {
    expect(parseRunsSubscribeInput({ runIds: ['b', 'a', 'b'], followChains: true })).toEqual({ runIds: ['a', 'b'], followChains: true })
    expect(parseRunsSubscribeInput(undefined)).toEqual({})
    expect(parseRunsSubscribeInput(null)).toEqual({})
    for (const bad of [[], 'x', { runIds: 'a' }, { runIds: [1] }, { sinceSeq: -1 }, { sinceSeq: 1.5 }, { followChains: 'yes' }, { projectIds: [''] }]) {
      expect(() => parseRunsSubscribeInput(bad)).toThrow(HostRpcFailure)
    }
  })
})

describe('filterKeyOf', () => {
  it('is 16 hex chars, stable under order and duplicates, and changes with the filter', () => {
    const a = filterKeyOf({ runIds: ['r2', 'r1'], projectIds: ['p'], followChains: true })
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(filterKeyOf({ projectIds: ['p'], followChains: true, runIds: ['r1', 'r2', 'r1'] })).toBe(a)
    expect(filterKeyOf({ runIds: ['r1', 'r2'], projectIds: ['p'] })).not.toBe(a)
    expect(filterKeyOf({ runIds: ['r1', 'r2'], projectIds: ['p'], followChains: true, includeActiveRunRecord: 'r1' })).not.toBe(a)
    // sinceSeq / hostInstanceId do not change it.
    expect(filterKeyOf({ runIds: ['r1', 'r2'], projectIds: ['p'], followChains: true, sinceSeq: 9, hostInstanceId: 'x' })).toBe(a)
    expect(filterKeyOf({})).not.toBe(filterKeyOf({ runIds: [] }))
  })
})

describe('followedRunsOf', () => {
  it('walks resumedFrom successors over the listed runs projects', () => {
    const v = new FakeView()
    v.stored.set('r1', summary('r1', 'p1', { status: 'finished', endedAt: NOW - 5000 }))
    v.stored.set('r2', summary('r2', 'p1', { status: 'finished', resumedFrom: 'r1' }))
    v.live.set('r3', summary('r3', 'p1', { resumedFrom: 'r2' }))
    v.stored.set('x', summary('x', 'p1'))
    expect([...followedRunsOf(['r1'], v)].sort()).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('RunSubscription.matches', () => {
  it('follows a resumedFrom successor on its run.status before delivery', () => {
    const v = new FakeView()
    v.live.set('r1', summary('r1', 'p1'))
    const sub = new RunSubscription(parseRunsSubscribeInput({ runIds: ['r1'], followChains: true }), v)
    v.live.set('r2', summary('r2', 'p1', { resumedFrom: 'r1' }))
    expect(sub.matches(logOf('r2'))).toBe(false)
    expect(sub.matches(status('r2'))).toBe(true)
    expect(sub.followed.has('r2')).toBe(true)
    expect(sub.matches(logOf('r2'))).toBe(true)
    // Without followChains nothing is added.
    const plain = new RunSubscription(parseRunsSubscribeInput({ runIds: ['r1'] }), v)
    expect(plain.matches(status('r2'))).toBe(false)
  })

  it('agent.partial never grows the followed set', () => {
    const v = new FakeView()
    v.live.set('r2', summary('r2', 'p1', { resumedFrom: 'r1' }))
    const sub = new RunSubscription({ runIds: ['r1'], followChains: true }, v)
    sub.followed.delete('r2')
    expect(sub.matches({ type: 'agent.partial', runId: 'r2', agentId: 'root', text: 'x' })).toBe(false)
    expect(sub.followed.has('r2')).toBe(false)
  })

  it('projectIds match through the run project, and run.moved keeps a followed run', () => {
    const v = new FakeView()
    v.live.set('q1', summary('q1', 'quick'))
    const sub = new RunSubscription({ projectIds: ['quick'], followChains: true }, v)
    expect(sub.matches(logOf('q1'))).toBe(true)
    // The promotion: RunManager moves the summary, then emits run.moved.
    v.live.set('q1', summary('q1', 'p1'))
    expect(sub.matches({ type: 'run.moved', runId: 'q1', fromProjectId: 'quick', projectId: 'p1' })).toBe(true)
    expect(sub.matches(logOf('q1'))).toBe(true)
    // Without followChains the run leaves the filter with its project.
    v.live.set('q2', summary('q2', 'quick'))
    const plain = new RunSubscription({ projectIds: ['quick'] }, v)
    v.live.set('q2', summary('q2', 'p1'))
    expect(plain.matches({ type: 'run.moved', runId: 'q2', fromProjectId: 'quick', projectId: 'p1' })).toBe(true)
    expect(plain.matches(logOf('q2'))).toBe(false)
  })

  it("runId '' events: project.updated by project, others only for an empty filter", () => {
    const v = new FakeView()
    const project = { id: 'p1' } as Project
    const upd: RunEvent = { type: 'project.updated', runId: '', project }
    const other: RunEvent = { type: 'log', runId: '', level: 'info', message: 'x' }
    const all = new RunSubscription({}, v)
    expect(all.matches(upd)).toBe(true)
    expect(all.matches(other)).toBe(true)
    expect(all.matches(logOf('anything'))).toBe(true)
    const byProject = new RunSubscription({ projectIds: ['p1'] }, v)
    expect(byProject.matches(upd)).toBe(true)
    expect(byProject.matches(other)).toBe(false)
    expect(new RunSubscription({ projectIds: ['p2'] }, v).matches(upd)).toBe(false)
    expect(new RunSubscription({ runIds: ['r1'] }, v).matches(upd)).toBe(false)
  })
})

describe('subscribeRuns', () => {
  it('snapshot without sinceSeq: live runs, cards, recent ended runs within 10 minutes', () => {
    const v = new FakeView()
    v.live.set('r1', summary('r1', 'p1'))
    v.live.set('o1', summary('o1', 'p2'))
    v.stored.set('e1', summary('e1', 'p1', { status: 'finished', endedAt: NOW - 60_000 }))
    v.stored.set('e2', summary('e2', 'p1', { status: 'finished', endedAt: NOW - RECENT_ENDED_MS - 1 }))
    v.stored.set('e3', summary('e3', 'quick', { status: 'finished', endedAt: NOW - 1 }))
    const scoped = subscribeRuns({ projectIds: ['p1'] }, deps(v)).result
    expect(scoped.mode).toBe('snapshot')
    if (scoped.mode !== 'snapshot') throw new Error('mode')
    expect(scoped.snapshot.liveRuns.map((s) => s.id)).toEqual(['r1'])
    expect(Object.keys(scoped.snapshot.pendingCards)).toEqual(['r1'])
    expect(scoped.snapshot.recentEndedRuns.map((s) => s.id)).toEqual(['e1'])
    expect(scoped.seq).toBe(0)
    const all = subscribeRuns({}, deps(v)).result
    if (all.mode !== 'snapshot') throw new Error('mode')
    expect(all.snapshot.liveRuns.map((s) => s.id).sort()).toEqual(['o1', 'r1'])
    // Every stored project plus the virtual ids.
    expect(all.snapshot.recentEndedRuns.map((s) => s.id).sort()).toEqual(['e1', 'e3'])
  })

  it('activeRun has every image replaced by OmittedImage regardless of size', () => {
    const v = new FakeView()
    const record = {
      summary: summary('r1', 'p1'),
      agents: {},
      transcript: [{ id: 't', agentId: 'root', at: 1, block: { kind: 'user', text: 'hi', images: [{ mediaType: 'image/png', data: 'AAAA' }] } }]
    } as unknown as RunRecord
    v.records.set('r1', record)
    const r = subscribeRuns({ includeActiveRunRecord: 'r1' }, deps(v)).result
    if (r.mode !== 'snapshot') throw new Error('mode')
    const block = (r.snapshot.activeRun as unknown as { transcript: { block: { images: unknown[] } }[] }).transcript[0].block
    expect(block.images[0]).toEqual({ mediaType: 'image/png', byteLength: 3, omittedBase64: true })
    expect((record as unknown as { transcript: { block: { images: { data: string }[] } }[] }).transcript[0].block.images[0].data).toBe('AAAA')
  })

  it('replay only when hostInstanceId, filterKey and sinceSeq all fit', () => {
    const v = new FakeView()
    v.live.set('r1', summary('r1', 'p1'))
    const journal = new EventJournal({ maxEvents: 5 })
    journal.append(logOf('r1'))
    journal.append(logOf('other'))
    journal.append(logOf('r1'))
    const input = { runIds: ['r1'] }
    const key = filterKeyOf(input)
    const d = deps(v, journal)
    const ok = subscribeRuns({ ...input, sinceSeq: 1, filterKey: key, hostInstanceId: 'aaaaaaaaaaaa' }, d).result
    expect(ok).toMatchObject({ mode: 'replay', fromSeq: 1, toSeq: 3, filterKey: key })
    if (ok.mode !== 'replay') throw new Error('mode')
    expect(ok.events.map((e) => e.seq)).toEqual([3])
    expect(subscribeRuns({ ...input, sinceSeq: 1, filterKey: key, hostInstanceId: 'bbbbbbbbbbbb' }, d).result.mode).toBe('snapshot')
    expect(subscribeRuns({ ...input, sinceSeq: 1, filterKey: 'ffffffffffffffff', hostInstanceId: 'aaaaaaaaaaaa' }, d).result.mode).toBe('snapshot')
    expect(subscribeRuns({ ...input, sinceSeq: 9, filterKey: key, hostInstanceId: 'aaaaaaaaaaaa' }, d).result.mode).toBe('snapshot')
    for (let i = 0; i < 5; i++) journal.append(logOf('r1'))
    expect(subscribeRuns({ ...input, sinceSeq: 1, filterKey: key, hostInstanceId: 'aaaaaaaaaaaa' }, d).result.mode).toBe('snapshot')
    expect(subscribeRuns({ ...input, sinceSeq: 3, filterKey: key, hostInstanceId: 'aaaaaaaaaaaa' }, d).result.mode).toBe('replay')
  })

  it('a replay applies the follow rules in order', () => {
    const v = new FakeView()
    v.stored.set('r1', summary('r1', 'p1', { status: 'finished' }))
    const journal = new EventJournal()
    journal.append(logOf('r1'))
    v.live.set('r2', summary('r2', 'p1', { resumedFrom: 'r1' }))
    journal.append(status('r2'))
    journal.append(logOf('r2'))
    const input = { runIds: ['r1'], followChains: true }
    // r2 is known at subscribe time here too; the replay must still deliver both its events.
    const r = subscribeRuns({ ...input, sinceSeq: 0, filterKey: filterKeyOf(input), hostInstanceId: 'aaaaaaaaaaaa' }, deps(v, journal))
    if (r.result.mode !== 'replay') throw new Error('mode')
    expect(r.result.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(r.subscription.followed.has('r2')).toBe(true)
  })
})
