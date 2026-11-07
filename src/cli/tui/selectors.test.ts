import { describe, expect, it } from 'vitest'
import type { AgentInstance, MergeReview, PermissionRequest, RunEvent, RunRecord, RunSummary, TranscriptEntry, UserQuestion } from '../../shared/types'
import type { SnapshotResult } from '../client/runStream'
import { project, record, summary } from '../testing/fakeContext'
import {
  agentDetail,
  composerMode,
  failedTurnSentence,
  orgTreeRows,
  partialRows,
  planView,
  statusSummary,
  topCard,
  transcriptRows,
  trayCards,
  worktreeRows
} from './selectors'
import { applyEvent, applyRecord, applySnapshot, createInitialState, setActiveRun, setComposeTarget } from './state'
import type { TuiState } from './types'

const HOST = 'aaaaaaaaaaaa'
const P = project('p1', '/work', { name: 'Shop' })

const snap = (live: RunSummary[], ended: RunSummary[] = [], active?: RunRecord): SnapshotResult => ({
  mode: 'snapshot',
  hostInstanceId: HOST,
  seq: 1,
  filterKey: 'fk',
  snapshot: { liveRuns: live, recentEndedRuns: ended, pendingCards: {}, ...(active ? { activeRun: active } : {}) }
})

let seq = 100
const ev = (event: RunEvent) => ({ seq: ++seq, event })
const perm = (id: string, runId: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ id, runId, agentId: 'root', toolName: 'Bash', input: { command: 'ls' }, summary: 'ls', ...extra })
const agent = (id: string, parentId: string | null, extra: Partial<AgentInstance> = {}): AgentInstance => ({
  id,
  roleId: null,
  roleSlug: id,
  name: id === 'root' ? 'Orchestrator' : 'Worker',
  parentId,
  spawnToolUseId: null,
  state: 'thinking',
  activity: 'Working',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 1,
  ...extra
})
const entry = (id: string, block: TranscriptEntry['block'], extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({ id, agentId: 'root', at: 1, block, ...extra })

function base(): TuiState {
  return { ...createInitialState('/work'), project: P }
}

describe('trayCards', () => {
  it('active chain first, then the project runs; each group by arrival; cardKey, revision default 1, tags and kinds', () => {
    let s = base()
    s = applySnapshot(s, snap([summary('r1', { status: 'running', startedAt: 1 }), summary('r2', { status: 'running', startedAt: 2, kind: 'setup' })]), { activeRunId: 'r2' })
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'r1', request: perm('a', 'r1') }))
    s = applyEvent(s, ev({ type: 'question.request', runId: 'r2', question: { id: 'q', runId: 'r2', agentId: 'root', question: 'Q?', options: [] } as unknown as UserQuestion }))
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'r2', request: perm('b', 'r2', { revision: 3 } as never) }))
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'r1', request: perm('c', 'r1') }))
    const cards = trayCards(s)
    expect(cards.map((c) => c.ref.requestId)).toEqual(['q', 'b', 'a', 'c'])
    // The followed run's cards carry its bare tag; another run's also name it (R2-L2).
    expect(cards.map((c) => c.runTag)).toEqual(['R2', 'R2', 'R1 prompt r1', 'R1 prompt r1'])
    expect(cards[0]).toMatchObject({ kind: 'question', runKind: 'setup', projectKind: 'code', ref: { hostInstanceId: HOST, runId: 'r2', revision: 1 } })
    expect(cards[1].ref.revision).toBe(3)
    expect(cards[1].key).toBe(`${HOST}|r2|permission|b|3`)
    expect(topCard(s)?.ref.requestId).toBe('q')
  })

  it('runs of other projects are left out unless in the active chain', () => {
    let s = base()
    s = applySnapshot(s, snap([summary('r1', { status: 'running' }), summary('x', { status: 'running', projectId: 'p9' })]), { activeRunId: 'r1' })
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'x', request: perm('px', 'x') }))
    expect(trayCards(s)).toEqual([])
  })
})

describe('orgTreeRows', () => {
  it('depth first, root first, children by start; earlier chain members marked earlier under the root', () => {
    let s = base()
    const r1 = summary('r1', { status: 'finished', startedAt: 1, endedAt: 2, sessionId: 's' })
    const r2 = summary('r2', { status: 'running', startedAt: 10, resumedFrom: 'r1', sessionId: 's' })
    s = applyRecord(s, { ...record(r1), agents: { root: agent('root', null, { state: 'done' }), old: agent('old', 'root', { state: 'done', handle: 'old-1' }) } })
    s = applyRecord(s, {
      ...record(r2),
      agents: {
        root: agent('root', null),
        b: agent('b', 'root', { startedAt: 3, handle: 'worker-2' }),
        a: agent('a', 'root', { startedAt: 2, handle: 'worker-1', worktree: { path: '/wt', branch: 'wt-a', status: 'active' } as never }),
        a1: agent('a1', 'a', { startedAt: 4, handle: 'sub\x1b[31m' })
      }
    })
    s = setActiveRun(s, 'r2', ['r1', 'r2'])
    const rows = orgTreeRows(s)
    expect(rows.map((r) => [r.id, r.depth, r.earlier ?? false])).toEqual([
      ['root', 0, false],
      ['r1:old', 1, true],
      ['a', 1, false],
      ['a1', 2, false],
      ['b', 1, false]
    ])
    expect(rows[0]).toMatchObject({ isRoot: true, label: 'Orchestrator', stateWord: 'Thinking' })
    expect(rows[2].worktree).toEqual({ branch: 'wt-a', status: 'active' })
    // A handle with control characters falls back to the role name.
    expect(rows[3].label).toBe('Worker')
  })

  it('cost: unknown is never $0; nothing spent is empty', () => {
    let s = base()
    const r = summary('r1', { status: 'running' })
    s = applyRecord(s, { ...record(r), agents: { root: agent('root', null, { usage: { costUsd: null, costSource: 'unknown' } as never }), w: agent('w', 'root') } })
    s = setActiveRun(s, 'r1')
    const rows = orgTreeRows(s)
    expect(rows[0].costText).toBe('unknown')
    expect(rows[1].costText).toBe('')
  })
})

describe('transcriptRows', () => {
  it('merges the chain oldest first with a divider, maps every block kind, sanitizes text', () => {
    let s = base()
    const r1 = summary('r1', { status: 'finished', startedAt: 1000, endedAt: 2000, sessionId: 's' })
    const r2 = summary('r2', { status: 'running', startedAt: 2000 + 180_000, resumedFrom: 'r1', sessionId: 's' })
    s = applyRecord(s, { ...record(r1), transcript: [entry('u1', { kind: 'user', text: 'Do it' }), entry('t1', { kind: 'text', text: 'Line one\nLine \x1b]52;c;QUFB\x07two' })] })
    s = applyRecord(s, {
      ...record(r2),
      transcript: [
        entry('h0', { kind: 'system', text: 'Continued from run r1' }, { source: 'harness' }),
        entry('tu', { kind: 'tool_use', id: 'call1', name: 'Bash', input: { command: 'npm test' } }),
        entry('tr', { kind: 'tool_result', toolUseId: 'call1', content: 'boom', isError: true }),
        entry('th', { kind: 'thinking', text: 'hmm' }),
        entry('hs', { kind: 'text', text: 'nudge' }, { source: 'harness' })
      ]
    })
    s = setActiveRun(s, 'r2', ['r1', 'r2'])
    const { rows, omitted } = transcriptRows(s)
    expect(omitted).toBe(0)
    expect(rows.map((r) => r.kind)).toEqual(['user', 'text', 'divider', 'tool', 'error', 'thinking', 'harness'])
    expect(rows[1].text).toBe('Line one\nLine two')
    expect(rows[2].text).toBe('Continued 3 min later')
    expect(rows[3].text).toMatch(/npm test/)
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })

  it('omitted adds the members left-out counts', () => {
    let s = base()
    s = applyRecord(s, { ...record(summary('r1', { status: 'running' })), transcript: [entry('a', { kind: 'text', text: 'x' })] }, { omitted: 7 })
    s = setActiveRun(s, 'r1')
    expect(transcriptRows(s).omitted).toBe(7)
  })

  it('partialRows lists non-empty partials of the active run with labels', () => {
    let s = base()
    s = applyRecord(s, { ...record(summary('r1', { status: 'running' })), agents: { root: agent('root', null) } })
    s = setActiveRun(s, 'r1')
    s = applyEvent(s, { atSeq: 1, event: { type: 'agent.partial', runId: 'r1', agentId: 'root', text: 'typing' } })
    expect(partialRows(s)).toEqual([{ key: 'partial|r1|root', runId: 'r1', agentId: 'root', agentLabel: 'Orchestrator', text: 'typing' }])
  })
})

describe('planView and worktreeRows', () => {
  it('plan counts and words', () => {
    let s = base()
    s = applyRecord(s, {
      ...record(summary('r1', { status: 'running' })),
      plan: {
        goal: 'Ship',
        status: 'active',
        autoContinues: 0,
        updatedAt: 1,
        steps: [
          { id: 'p1', title: 'One', status: 'done' },
          { id: 'p2', title: 'Two', status: 'in_progress', owner: 'Dev', note: 'n' },
          { id: 'p3', title: 'Three', status: 'pending' }
        ]
      }
    })
    s = setActiveRun(s, 'r1')
    expect(planView(s)).toMatchObject({ goal: 'Ship', statusWord: 'In progress', done: 1, total: 3 })
    expect(planView(s)?.steps[1]).toEqual({ id: 'p2', title: 'Two', status: 'in_progress', owner: 'Dev', note: 'n' })
    expect(planView(setActiveRun(s, 'none'))).toBeUndefined()
  })

  it('worktree rows carry the open merge review id', () => {
    let s = base()
    s = applySnapshot(s, snap([summary('r1', { status: 'running' })]), { activeRunId: 'r1' })
    s = applyEvent(s, ev({ type: 'agent.upsert', runId: 'r1', agent: agent('w', 'root', { handle: 'w-1', worktree: { path: '/x', branch: 'br', status: 'ready', changedFiles: ['a', 'b'] } as never }) }))
    s = applyEvent(s, ev({ type: 'agent.upsert', runId: 'r1', agent: agent('v', 'root', { startedAt: 5, worktree: { path: '/y', branch: 'br2', status: 'active', mergeTarget: 'parent' } as never }) }))
    s = applyEvent(s, ev({ type: 'merge.request', runId: 'r1', review: { id: 'mr1', runId: 'r1', agentId: 'w', agentName: 'w', branch: 'br', path: '/x', changedFiles: [], stat: '', patch: '', createdAt: 1 } as MergeReview }))
    expect(worktreeRows(s)).toEqual([
      { agentId: 'w', runId: 'r1', label: 'w-1', branch: 'br', status: 'ready', changedFiles: 2, mergeTarget: 'main', reviewId: 'mr1' },
      { agentId: 'v', runId: 'r1', label: 'Worker', branch: 'br2', status: 'active', changedFiles: 0, mergeTarget: 'parent' }
    ])
  })
})

describe('statusSummary', () => {
  it('Needs you with an open card; needsYou counts decisions over live runs', () => {
    let s = base()
    s = applySnapshot(s, snap([summary('r1', { status: 'running', title: 'Add cache' }), summary('r2', { status: 'idle', startedAt: 2000 })]), { activeRunId: 'r1' })
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'r1', request: perm('a', 'r1') }))
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'r2', request: perm('b', 'r2') }))
    const st = statusSummary(s)
    expect(st).toMatchObject({ projectName: 'Shop', runTag: 'R1', runTitle: 'Add cache', statusWord: 'Needs you', tone: 'warn', needsYou: 2, liveRuns: 2, connection: 'live' })
  })

  it('Ended when OrgAI closed; policy and budget read Stopped, never Finished; unknown cost never $0', () => {
    let s = base()
    s = applySnapshot(s, snap([], [summary('r1', { status: 'finished', endedBy: 'app', endedAt: 5 })]), { activeRunId: 'r1' })
    expect(statusSummary(s).statusWord).toBe('Ended when OrgAI closed')
    s = applyEvent(s, ev({ type: 'run.finalized', runId: 'r1', outcome: 'completed' as never, summary: summary('r1', { status: 'finished', endedBy: 'policy', usage: { costUsd: null, costSource: 'unknown' } as never }) }))
    expect(statusSummary(s).statusWord).toBe('Stopped by its exec policy')
    expect(statusSummary(s).costText).toBe('unknown')
    s = applyEvent(s, ev({ type: 'run.finalized', runId: 'r1', outcome: 'budget-exceeded' as never, summary: summary('r1', { status: 'finished', endedBy: 'budget' }) }))
    expect(statusSummary(s).statusWord).toBe('Stopped at its budget limit')
    s = applyEvent(s, ev({ type: 'run.status', runId: 'r1', status: 'error' }))
    expect(statusSummary(s).statusWord).toBe('Failed')
  })

  it('a failed root turn on an idle run reads "Idle · last turn failed" in the danger tone (#29 M5); a plain idle run does not', () => {
    const run = (state: AgentInstance['state']): RunRecord => record(summary('r1', { status: 'idle' }), { agents: { root: agent('root', null, { state }) } })
    let s = applySnapshot(base(), snap([summary('r1', { status: 'idle' })], [], run('error')), { activeRunId: 'r1' })
    expect(statusSummary(s)).toMatchObject({ statusWord: 'Idle · last turn failed', tone: 'danger' })
    s = applySnapshot(base(), snap([summary('r1', { status: 'idle' })], [], run('idle')), { activeRunId: 'r1' })
    expect(statusSummary(s)).toMatchObject({ statusWord: 'Idle', tone: 'dim' })
  })

  it('the bare failure reason becomes a readable sentence in the transcript (#29 M5)', () => {
    expect(failedTurnSentence('during execution')).toBe('The last turn failed (error during execution). Send a message to try again.')
    expect(failedTurnSentence('error_max_turns')).toContain('error max turns')
    expect(failedTurnSentence('Hello there')).toBe('Hello there')
    let s = base()
    s = applySnapshot(s, snap([summary('r1', { status: 'idle' })], [], record(summary('r1', { status: 'idle' }), { transcript: [entry('t1', { kind: 'text', text: 'during execution' })], agents: { root: agent('root', null) } })), { activeRunId: 'r1' })
    expect(transcriptRows(s).rows[0].text).toMatch(/^The last turn failed/)
  })

  it('#29 leftover: the mock [mock:turn-fail] agent (state error, activity "during execution") reads as a sentence in the tree footer and the inspector', () => {
    // mock.ts sets root.activity = 'error_during_execution'.replace(/^error_/, '').replace(/_/g, ' '); the text never enters the transcript.
    const failed = agent('root', null, { state: 'error', activity: 'during execution' })
    let s = applySnapshot(base(), snap([summary('r1', { status: 'idle' })], [], record(summary('r1', { status: 'idle' }), { agents: { root: failed } })), { activeRunId: 'r1' })
    s = applyEvent(s, ev({ type: 'agent.upsert', runId: 'r1', agent: failed }))
    const sentence = 'The last turn failed (error during execution). Send a message to try again.'
    expect(orgTreeRows(s).find((r) => r.kind === 'agent' && r.isRoot)?.activity).toBe(sentence)
    expect(agentDetail(s, 'root')?.activity).toBe(sentence)
    // A normal activity is untouched.
    const ok = applyEvent(s, ev({ type: 'agent.upsert', runId: 'r1', agent: agent('root', null, { activity: 'Reading files' }) }))
    expect(orgTreeRows(ok).find((r) => r.kind === 'agent' && r.isRoot)?.activity).toBe('Reading files')
  })

  it('R2-L2: a card of a run that is not followed names that run; an agent this client has not loaded gets no "An agent" label', () => {
    let s = base()
    s = applySnapshot(s, snap([summary('r1', { status: 'running', startedAt: 1, prompt: 'Build the report' }), summary('r2', { status: 'running', startedAt: 2 })]), { activeRunId: 'r2' })
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'r1', request: perm('a', 'r1', { agentId: 'impl-1' }) }))
    s = applyEvent(s, ev({ type: 'permission.request', runId: 'r2', request: perm('b', 'r2') }))
    const cards = trayCards(s)
    const own = cards.find((c) => c.ref.runId === 'r2')!
    const other = cards.find((c) => c.ref.runId === 'r1')!
    expect(own.runTag).toBe('R2')
    expect(other.runTag).toMatch(/^R1 .*Build the report/)
    expect(other.agentLabel).toBeUndefined()
    expect(JSON.stringify(other)).not.toContain('An agent')
  })

  it('without an active run: no run fields; readOnlyReason and host kind pass through', () => {
    const s = { ...base(), hostKind: 'inproc' as const, readOnlyReason: 'Read only\x1b[2J here' }
    expect(statusSummary(s)).toEqual({ projectName: 'Shop', needsYou: 0, liveRuns: 0, connection: 'connecting', hostKind: 'inproc', readOnlyReason: 'Read only here' })
  })
})

describe('composerMode', () => {
  it('covers readOnly, start, quick, send, continue', () => {
    expect(composerMode({ ...base(), readOnlyReason: 'x' })).toBe('readOnly')
    expect(composerMode(base())).toBe('start')
    expect(composerMode(createInitialState('/w'))).toBe('quick')
    let s = applySnapshot(base(), snap([summary('r1', { status: 'idle' })]), { activeRunId: 'r1' })
    expect(composerMode(s)).toBe('send')
    expect(composerMode(setComposeTarget(s, 'new'))).toBe('start')
    s = applyEvent(s, ev({ type: 'run.status', runId: 'r1', status: 'finished', sessionId: 'sess' }))
    expect(composerMode(s)).toBe('continue')
    // No provider session: cannot continue, so a new run.
    const t = applySnapshot(base(), snap([], [summary('r9', { status: 'finished', endedAt: 1 })]), { activeRunId: 'r9' })
    expect(composerMode(t)).toBe('start')
    // A quick run with no project: open = send.
    const q = applySnapshot(createInitialState('/w'), snap([summary('q1', { status: 'running', projectId: 'quick' })]), { activeRunId: 'q1' })
    expect(composerMode(q)).toBe('send')
  })
})
