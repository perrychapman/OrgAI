import { describe, expect, it } from 'vitest'
import type {
  AgentInstance,
  McpInstallRequest,
  MergeReview,
  PendingCards,
  PermissionRequest,
  PermissionRuleRequest,
  Proposal,
  RunEvent,
  RunRecord,
  RunsEventParams,
  RunSummary,
  TranscriptEntry,
  UserQuestion
} from '../../shared/types'
import type { SnapshotResult } from '../client/runStream'
import { record, summary } from '../testing/fakeContext'
import {
  addNotice,
  applyEvent,
  applyRecord,
  applyRunList,
  applySnapshot,
  cardArrivalSeq,
  createInitialState,
  createPartialTracker,
  setActiveRun,
  upsertRunSummary,
  type PartialTracker
} from './state'
import { TUI_NOTICE_MAX, TUI_RESOLVED_MAX, TUI_TRANSCRIPT_MAX, type TuiState } from './types'

const HOST = 'aaaaaaaaaaaa'

function snap(seq: number, o: { live?: RunSummary[]; ended?: RunSummary[]; cards?: Record<string, PendingCards>; active?: RunRecord; omitted?: number } = {}): SnapshotResult {
  return {
    mode: 'snapshot',
    hostInstanceId: HOST,
    seq,
    filterKey: 'fk',
    snapshot: {
      liveRuns: o.live ?? [],
      recentEndedRuns: o.ended ?? [],
      pendingCards: o.cards ?? {},
      ...(o.active ? { activeRun: o.active } : {}),
      ...(o.omitted ? { activeRunOmitted: o.omitted } : {})
    }
  }
}

const cards = (extra: Partial<PendingCards> = {}): PendingCards => ({
  permissions: [],
  questions: [],
  proposals: [],
  ruleRequests: [],
  mergeReviews: [],
  mcpInstalls: [],
  ...extra
})

const entry = (id: string, agentId = 'root', text = `text ${id}`, at = 1): TranscriptEntry => ({ id, agentId, at, block: { kind: 'text', text } })
const ev = (event: RunEvent, seq?: number): RunsEventParams => (seq === undefined ? { atSeq: 0, event } : { seq, event })
const perm = (id: string, runId = 'r1'): PermissionRequest => ({ id, runId, agentId: 'root', toolName: 'Bash', input: { command: 'ls' }, summary: 'Run ls' })

function liveState(): TuiState {
  const s = createInitialState('/work')
  const r1 = summary('r1', { status: 'running', startedAt: 100 })
  return applySnapshot(s, snap(10, { live: [r1], active: record(r1, { transcript: [entry('e1'), entry('e2')] }) }), { activeRunId: 'r1' })
}

describe('createInitialState', () => {
  it('starts connecting, composing to the active run, with empty maps', () => {
    const s = createInitialState('/work')
    expect(s).toEqual({ connection: 'connecting', folder: '/work', runs: {}, runOrder: [], activeChain: [], composeTarget: 'active', notices: [], resolved: [], cardSeq: 0 })
  })
})

describe('applySnapshot', () => {
  it('replaces runs from liveRuns and recentEndedRuns, applies the active record and its omitted count', () => {
    const s0 = createInitialState('/work')
    const r1 = summary('r1', { status: 'running', startedAt: 200 })
    const r0 = summary('r0', { status: 'finished', startedAt: 100, endedAt: 150 })
    const s = applySnapshot(s0, snap(10, { live: [r1], ended: [r0], active: record(r1, { transcript: [entry('e9')] }), omitted: 8 }), { activeRunId: 'r1' })
    expect(Object.keys(s.runs).sort()).toEqual(['r0', 'r1'])
    expect(s.runOrder).toEqual(['r0', 'r1'])
    expect(s.activeRunId).toBe('r1')
    expect(s.activeChain).toEqual(['r1'])
    expect(s.runs.r1.recordLoaded).toBe(true)
    expect(s.runs.r1.omitted).toBe(8)
    expect(s.runs.r0.recordLoaded).toBe(false)
    expect(s.lastSeq).toBe(10)
    expect(s.hostInstanceId).toBe(HOST)
    expect(s.connection).toBe('live')
  })

  it('a resync snapshot after replayed events never duplicates transcript rows and drops cards no longer pending', () => {
    let s = liveState()
    s = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry('e3') }, 11))
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'r1', request: perm('p1') }, 12))
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'r1', request: perm('p2') }, 13))
    // The same event replayed (the reducer dedupes even when RunStream did not).
    s = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry('e3') }, 11))
    expect(s.runs.r1.transcript.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    const r1 = summary('r1', { status: 'running', startedAt: 100 })
    s = applySnapshot(s, snap(20, { live: [r1], cards: { r1: cards({ permissions: [perm('p2')] }) }, active: record(r1, { transcript: [entry('e1'), entry('e2'), entry('e3'), entry('e4')] }) }), { activeRunId: 'r1' })
    expect(s.runs.r1.transcript.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(s.runs.r1.cards.permissions.map((c) => c.id)).toEqual(['p2'])
    // p2 keeps its arrival order.
    expect(cardArrivalSeq(s.runs.r1.cards.permissions[0])).toBe(2)
  })

  it('drops an open run the snapshot no longer lists, keeps the active chain and ended runs', () => {
    let s = createInitialState('/work')
    s = applySnapshot(s, snap(1, { live: [summary('r1', { status: 'running', startedAt: 1 }), summary('r2', { status: 'running', startedAt: 2 })], ended: [summary('r0', { startedAt: 0 })] }), { activeRunId: 'r1' })
    s = applySnapshot(s, snap(5), { activeRunId: 'r1' })
    expect(Object.keys(s.runs).sort()).toEqual(['r0', 'r1'])
    expect(s.runOrder).toEqual(['r0', 'r1', 'r2'])
  })

  it('a snapshot that lists a successor of the active run follows it', () => {
    let s = liveState()
    s = applySnapshot(s, snap(30, { live: [summary('r2', { status: 'running', startedAt: 300, resumedFrom: 'r1' })], ended: [summary('r1', { startedAt: 100, endedAt: 200 })] }), { activeRunId: 'r1' })
    expect(s.activeChain).toEqual(['r1', 'r2'])
    expect(s.activeRunId).toBe('r2')
  })
})

describe('applyEvent', () => {
  it('tracks lastSeq from durable seq only', () => {
    let s = liveState()
    s = applyEvent(s, ev({ type: 'run.status', runId: 'r1', status: 'idle' }, 14))
    s = applyEvent(s, { atSeq: 99, event: { type: 'agent.partial', runId: 'r1', agentId: 'root', text: 'hi' } })
    expect(s.lastSeq).toBe(14)
    expect(s.runs.r1.summary.status).toBe('idle')
  })

  it('run.status carries pause facts, end facts and the session id; run.title, run.finalized, usage and cost reach the summary', () => {
    let s = liveState()
    s = applyEvent(s, ev({ type: 'run.status', runId: 'r1', status: 'running', sessionId: 'sess-1' }, 11))
    expect(s.runs.r1.summary.sessionId).toBe('sess-1')
    s = applyEvent(s, ev({ type: 'run.status', runId: 'r1', status: 'paused', pausedUntil: 5000, pauseReason: 'Usage limit', autoResume: true }, 12), { now: 4000 })
    expect(s.runs.r1.summary).toMatchObject({ status: 'paused', pausedUntil: 5000, pauseReason: 'Usage limit', autoResume: true, endedAt: 4000 })
    s = applyEvent(s, ev({ type: 'run.status', runId: 'r1', status: 'finished', endedBy: 'app', endedWhile: 'waiting' }, 13))
    expect(s.runs.r1.summary).toMatchObject({ status: 'finished', endedBy: 'app', endedWhile: 'waiting' })
    s = applyEvent(s, ev({ type: 'run.title', runId: 'r1', title: 'Add caching' }, 14))
    expect(s.runs.r1.summary.title).toBe('Add caching')
    s = applyEvent(s, ev({ type: 'run.cost', runId: 'r1', totalCostUsd: 0.5 }, 15))
    expect(s.runs.r1.summary.totalCostUsd).toBe(0.5)
    s = applyEvent(s, ev({ type: 'run.usage', runId: 'r1', usage: { costUsd: 0.75, costSource: 'provider' } as never }, 16))
    expect(s.runs.r1.summary.usage?.costUsd).toBe(0.75)
    expect(s.runs.r1.summary.totalCostUsd).toBe(0.75)
    const fin = summary('r1', { status: 'finished', startedAt: 100, endedBy: 'policy', execOutcome: 'completed' as never })
    s = applyEvent(s, ev({ type: 'run.finalized', runId: 'r1', outcome: 'completed' as never, summary: fin }, 17))
    expect(s.runs.r1.summary.endedBy).toBe('policy')
  })

  it('agent.upsert / agent.remove, plan.updated, project.updated', () => {
    let s = liveState()
    const worker: AgentInstance = { ...(record(summary('r1')).agents.root as AgentInstance), id: 'w1', parentId: 'root', name: 'Worker', state: 'thinking' }
    s = applyEvent(s, ev({ type: 'agent.upsert', runId: 'r1', agent: worker }, 11))
    expect(s.runs.r1.agents.w1.state).toBe('thinking')
    s = applyEvent(s, ev({ type: 'agent.remove', runId: 'r1', agentId: 'w1' }, 12))
    expect(s.runs.r1.agents.w1).toBeUndefined()
    const plan = { goal: 'G', steps: [], status: 'active' as const, autoContinues: 0, updatedAt: 1 }
    s = applyEvent(s, ev({ type: 'plan.updated', runId: 'r1', plan }, 13))
    expect(s.runs.r1.plan).toBe(plan)
    const p = { id: 'p1', name: 'One', path: '/work' } as never
    s = { ...s, project: { id: 'p1', name: 'Old', path: '/work' } as never }
    s = applyEvent(s, ev({ type: 'project.updated', runId: 'r1', project: p }, 14))
    expect(s.project?.name).toBe('One')
  })

  it('staffing.updated replaces the run\'s staffing and changes nothing else; a record carries it in', () => {
    let s = liveState()
    const before = s.runs.r1
    const staffing = { goal: 'cost' as const, assignments: [{ roleId: 'r-eng', model: 'haiku', tier: 'fast' as const, source: 'role' as const, at: 1 }] }
    s = applyEvent(s, ev({ type: 'staffing.updated', runId: 'r1', staffing }, 11))
    expect(s.runs.r1.staffing).toBe(staffing)
    expect({ ...s.runs.r1, staffing: undefined }).toEqual({ ...before, staffing: undefined })
    const next = { goal: 'speed' as const, assignments: [] }
    s = applyEvent(s, ev({ type: 'staffing.updated', runId: 'r1', staffing: next }, 12))
    expect(s.runs.r1.staffing).toBe(next)
    // plan.updated still lands beside it.
    const plan = { goal: 'G', steps: [], status: 'active' as const, autoContinues: 0, updatedAt: 1 }
    s = applyEvent(s, ev({ type: 'plan.updated', runId: 'r1', plan }, 13))
    expect(s.runs.r1.plan).toBe(plan)
    expect(s.runs.r1.staffing).toBe(next)
    // A run record (runs:get / snapshot) brings its staffing; a record without one keeps what the state has.
    const r2 = summary('r2', { status: 'finished', startedAt: 200 })
    s = applyRecord(s, { ...record(r2), staffing })
    expect(s.runs.r2.staffing).toBe(staffing)
    s = applyRecord(s, record(r2))
    expect(s.runs.r2.staffing).toBe(staffing)
  })

  it('run.delegation sets the summary and the listed agents', () => {
    let s = liveState()
    const d = { verdict: 'failed' as const, missing: ['policy'], corrected: false, nativeSpawns: 1 }
    s = applyEvent(s, ev({ type: 'run.delegation', runId: 'r1', summary: { failed: 1, corrected: 0, nativeSpawns: 1 }, agents: { root: d } }, 20))
    expect(s.runs.r1.summary.delegation?.failed).toBe(1)
    expect(s.runs.r1.agents.root.delegation).toEqual(d)
  })

  it('log keeps only warn and error, as sanitized notices', () => {
    let s = liveState()
    s = applyEvent(s, ev({ type: 'log', runId: 'r1', level: 'info', message: 'quiet' }, 11))
    s = applyEvent(s, ev({ type: 'log', runId: 'r1', level: 'warn', message: 'careful\x1b]52;c;QUFB\x07 now' }, 12))
    s = applyEvent(s, ev({ type: 'log', runId: 'r1', level: 'error', message: 'broke' }, 13))
    expect(s.notices.map((n) => [n.text, n.tone])).toEqual([
      ['careful now', 'warn'],
      ['broke', 'danger']
    ])
  })

  it('caps the transcript at TUI_TRANSCRIPT_MAX keeping the newest and counts the dropped into omitted', () => {
    let s = liveState()
    for (let i = 0; i < TUI_TRANSCRIPT_MAX + 3; i++) s = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry(`x${i}`) }, 100 + i))
    const t = s.runs.r1.transcript
    expect(t).toHaveLength(TUI_TRANSCRIPT_MAX)
    expect(t[t.length - 1].id).toBe(`x${TUI_TRANSCRIPT_MAX + 2}`)
    expect(s.runs.r1.omitted).toBe(5)
  })

  it('every card kind: request appends in arrival order (cardSeq), resolved removes it and records who decided', () => {
    let s = liveState()
    const q: UserQuestion = { id: 'q1', runId: 'r1', agentId: 'root', question: 'Which?', options: [] } as unknown as UserQuestion
    const pr = { id: 'pp1', runId: 'r1', kind: 'settings', title: 'T', revision: 2 } as unknown as Proposal
    const rr = { id: 'rr1', runId: 'r1', agentId: 'root', rules: [] } as unknown as PermissionRuleRequest
    const mr = { id: 'm1', runId: 'r1', agentId: 'w1', agentName: 'W', branch: 'b', path: '/p', changedFiles: [], stat: '', patch: '', createdAt: 1 } as MergeReview
    const mi = { id: 'i1', runId: 'r1', agentId: 'root' } as unknown as McpInstallRequest
    const reqs: RunEvent[] = [
      { type: 'question.request', runId: 'r1', question: q },
      { type: 'permission.request', runId: 'r1', request: perm('p1') },
      { type: 'proposal.request', runId: 'r1', proposal: pr },
      { type: 'rules.request', runId: 'r1', request: rr },
      { type: 'merge.request', runId: 'r1', review: mr },
      { type: 'mcpInstall.request', runId: 'r1', request: mi }
    ]
    reqs.forEach((e, i) => (s = applyEvent(s, ev(e, 20 + i))))
    expect(s.cardSeq).toBe(6)
    const c = s.runs.r1.cards
    expect([c.questions[0], c.permissions[0], c.proposals[0], c.ruleRequests[0], c.mergeReviews[0], c.mcpInstalls[0]].map((x) => cardArrivalSeq(x))).toEqual([1, 2, 3, 4, 5, 6])
    const by = { surface: 'desktop' as const, reportedPid: 7 }
    const res: RunEvent[] = [
      { type: 'question.resolved', runId: 'r1', questionId: 'q1', answer: { selected: [] } as never, decidedBy: by },
      { type: 'permission.resolved', runId: 'r1', requestId: 'p1', cancelled: true },
      { type: 'proposal.resolved', runId: 'r1', proposalId: 'pp1', decision: {} as never, decidedBy: { surface: 'tui' } },
      { type: 'rules.resolved', runId: 'r1', requestId: 'rr1', decision: {} as never },
      { type: 'merge.resolved', runId: 'r1', reviewId: 'm1', decision: { behavior: 'hold' } },
      { type: 'mcpInstall.resolved', runId: 'r1', requestId: 'i1', outcome: {} as never }
    ]
    res.forEach((e, i) => (s = applyEvent(s, ev(e, 40 + i), { now: 9 })))
    expect(Object.values(s.runs.r1.cards).every((l) => l.length === 0)).toBe(true)
    expect(s.resolved.map((r) => [r.ref.kind, r.ref.requestId, r.ref.revision, r.cancelled, r.decidedBy?.surface])).toEqual([
      ['question', 'q1', 1, false, 'desktop'],
      ['permission', 'p1', 1, true, undefined],
      ['proposal', 'pp1', 2, false, 'tui'],
      ['rules', 'rr1', 1, false, undefined],
      ['merge', 'm1', 1, false, undefined],
      ['mcpInstall', 'i1', 1, false, undefined]
    ])
    expect(s.resolved[0]).toMatchObject({ key: `${HOST}|r1|question|q1|1`, at: 9, decidedBy: by })
  })

  it('caps resolved infos at TUI_RESOLVED_MAX', () => {
    let s = liveState()
    for (let i = 0; i < TUI_RESOLVED_MAX + 5; i++) s = applyEvent(s, ev({ type: 'permission.resolved', runId: 'r1', requestId: `p${i}` }, 50 + i))
    expect(s.resolved).toHaveLength(TUI_RESOLVED_MAX)
    expect(s.resolved[0].ref.requestId).toBe('p5')
  })

  it('a request for an unseen run creates it (the session fetches the summary)', () => {
    let s = liveState()
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'r9', request: perm('p9', 'r9') }, 11), { now: 500 })
    expect(s.runs.r9.cards.permissions.map((c) => c.id)).toEqual(['p9'])
    expect(s.runs.r9.recordLoaded).toBe(false)
  })

  it('never mutates the state it was given', () => {
    const s = liveState()
    const copy = JSON.parse(JSON.stringify(s))
    applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry('e7') }, 11))
    applyEvent(s, ev({ type: 'permission.request', runId: 'r1', request: perm('p1') }, 12))
    expect(JSON.parse(JSON.stringify(s))).toEqual(copy)
  })
})

describe('chain following', () => {
  it('a continuation (resumedFrom = the newest member) extends the chain once its summary is known', () => {
    let s = liveState()
    s = applyEvent(s, ev({ type: 'run.status', runId: 'r1', status: 'finished' }, 11))
    // The successor's first event arrives before its summary: a stub, not yet followed.
    s = applyEvent(s, ev({ type: 'run.status', runId: 'r2', status: 'starting' }, 12), { now: 900 })
    expect(s.activeRunId).toBe('r1')
    s = upsertRunSummary(s, summary('r2', { status: 'starting', startedAt: 900, resumedFrom: 'r1' }))
    expect(s.activeChain).toEqual(['r1', 'r2'])
    expect(s.activeRunId).toBe('r2')
    // A further continuation through a record.
    s = applyRecord(s, record(summary('r3', { status: 'running', startedAt: 1000, resumedFrom: 'r2' })))
    expect(s.activeChain).toEqual(['r1', 'r2', 'r3'])
    expect(s.runOrder).toEqual(['r1', 'r2', 'r3'])
  })

  it('run.moved keeps the run and updates its project', () => {
    let s = liveState()
    s = applyEvent(s, ev({ type: 'run.moved', runId: 'r1', fromProjectId: 'quick', projectId: 'p2' }, 11))
    expect(s.runs.r1.summary.projectId).toBe('p2')
    expect(s.activeRunId).toBe('r1')
  })

  it('setActiveRun takes a chain ending with the run', () => {
    const s = setActiveRun(createInitialState('/w'), 'r3', ['r1', 'r2', 'r3'])
    expect(s.activeChain).toEqual(['r1', 'r2', 'r3'])
    expect(setActiveRun(s, 'r5', ['r1']).activeChain).toEqual(['r5'])
  })
})

describe('applyRecord and applyRunList', () => {
  it('merges a record with events that arrived meanwhile, without duplicates', () => {
    let s = liveState()
    s = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry('e3', 'root', 'x', 5) }, 11))
    const rec = record(summary('r1', { status: 'running', startedAt: 100 }), { transcript: [entry('e2', 'root', 'b', 2)] })
    s = applyRecord(s, rec, { omitted: 1 })
    expect(s.runs.r1.transcript.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(s.runs.r1.omitted).toBeUndefined()
  })

  it('numbers runs by start order from runs:list, keeping runs the list missed', () => {
    let s: TuiState = { ...createInitialState('/w'), project: { id: 'p1' } as never }
    s = upsertRunSummary(s, summary('new', { startedAt: 50 }))
    s = applyRunList(s, [summary('b', { startedAt: 20 }), summary('a', { startedAt: 10 }), summary('other', { projectId: 'p9', startedAt: 1 })])
    expect(s.runOrder).toEqual(['a', 'b', 'new'])
  })
})

describe('agent.partial streams', () => {
  const partial = (s: TuiState, text: string, t: PartialTracker, agentId = 'root'): TuiState => applyEvent(s, { atSeq: 0, event: { type: 'agent.partial', runId: 'r1', agentId, text } }, { partials: t })

  it('an OSC 52 sequence split across two cumulative partials never shows the escape or its payload', () => {
    const t = createPartialTracker()
    let s = partial(liveState(), 'Hello \x1b]52;c;QU', t)
    expect(s.runs.r1.partials.root).toBe('Hello ')
    s = partial(s, 'Hello \x1b]52;c;QUFBQQ==\x07world', t)
    expect(s.runs.r1.partials.root).toBe('Hello world')
    expect(s.runs.r1.partials.root).not.toMatch(/QU|52|\x1b/)
  })

  it('a CSI split at the ESC byte is removed', () => {
    const t = createPartialTracker()
    let s = partial(liveState(), 'abc\x1b', t)
    expect(s.runs.r1.partials.root).toBe('abc')
    s = partial(s, 'abc\x1b[2Jdef', t)
    expect(s.runs.r1.partials.root).toBe('abcdef')
  })

  it('without a tracker the whole text is sanitized fresh (still safe)', () => {
    let s = applyEvent(liveState(), { atSeq: 0, event: { type: 'agent.partial', runId: 'r1', agentId: 'root', text: 'a\x1b]52;c;QU' } })
    expect(s.runs.r1.partials.root).toBe('a')
    s = applyEvent(s, { atSeq: 0, event: { type: 'agent.partial', runId: 'r1', agentId: 'root', text: 'a\x1b]52;c;QUFB\x07b' } })
    expect(s.runs.r1.partials.root).toBe('ab')
  })

  it('a shorter text restarts the stream, "" clears, a transcript entry clears', () => {
    const t = createPartialTracker()
    let s = partial(liveState(), 'first block \x1b]8;;http://x', t)
    expect(s.runs.r1.partials.root).toBe('first block ')
    // A new block: the unterminated OSC of the old one must not swallow it.
    s = partial(s, 'second', t)
    expect(s.runs.r1.partials.root).toBe('second')
    s = partial(s, '', t)
    expect(s.runs.r1.partials.root).toBeUndefined()
    expect(t.size).toBe(0)
    s = partial(s, 'again', t)
    s = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry('e5', 'root', 'again') }, 11), { partials: t })
    expect(s.runs.r1.partials.root).toBeUndefined()
    expect(t.size).toBe(0)
  })

  it('two agents never share sanitizer state', () => {
    const t = createPartialTracker()
    let s = partial(liveState(), 'one \x1b]52;c;', t, 'a1')
    s = partial(s, 'two', t, 'a2')
    expect(s.runs.r1.partials.a2).toBe('two')
    s = partial(s, 'two more', t, 'a2')
    expect(s.runs.r1.partials.a2).toBe('two more')
    expect(s.runs.r1.partials.a1).toBe('one ')
  })

  it('a terminal run.status clears the run partials', () => {
    const t = createPartialTracker()
    let s = partial(liveState(), 'typing', t)
    s = applyEvent(s, ev({ type: 'run.status', runId: 'r1', status: 'finished' }, 11), { partials: t })
    expect(s.runs.r1.partials).toEqual({})
    expect(t.size).toBe(0)
  })
})

describe('addNotice', () => {
  it('sanitizes to one line, increments ids and caps at TUI_NOTICE_MAX', () => {
    let s = createInitialState('/w')
    s = addNotice(s, 'a\x1b[31m red\nline', 'warn', 5)
    expect(s.notices[0]).toEqual({ id: 1, text: 'a red line', tone: 'warn', at: 5 })
    for (let i = 0; i < TUI_NOTICE_MAX + 2; i++) s = addNotice(s, `n${i}`)
    expect(s.notices).toHaveLength(TUI_NOTICE_MAX)
    expect(s.notices[s.notices.length - 1].id).toBe(TUI_NOTICE_MAX + 3)
    expect(addNotice(s, '   ')).toBe(s)
  })
})

describe('applyEvent: agent.compacted (compaction investigation 2026-11-10)', () => {
  it('counts on the agent row and adds one notice per compaction', () => {
    let s = liveState()
    s = applyEvent(s, ev({ type: 'agent.upsert', runId: 'r1', agent: { id: 'root', roleId: null, roleSlug: 'lead', name: 'Lead', parentId: null, spawnToolUseId: null, state: 'thinking', activity: 'Reading', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1 } }, 11))
    s = applyEvent(s, ev({ type: 'agent.compacted', runId: 'r1', agentId: 'root', at: 5, trigger: 'auto' }, 12))
    s = applyEvent(s, ev({ type: 'agent.compacted', runId: 'r1', agentId: 'root', at: 6, trigger: 'auto' }, 13))
    expect(s.runs.r1!.agents.root!.compactions).toBe(2)
    expect(s.notices.map((n) => n.text)).toEqual(['Lead compacted its context (1st time).', 'Lead compacted its context (2nd time).'])
  })
})
