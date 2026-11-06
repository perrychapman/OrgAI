/**
 * ux-review-tui-org.md F4 (inspector facts and the one-agent transcript), F6 (message counts from reducer events),
 * F7 (subtree focus), F8 (run chips, adjacent live run) and F12 (offersRetro), over the pure reducer and selectors.
 */
import { describe, expect, it } from 'vitest'
import type { AgentInstance, RunEvent, TranscriptEntry } from '../../shared/types'
import { project, record, summary } from '../testing/fakeContext'
import { adjacentLiveRun, agentDetail, offersRetro, orgTreeRows, partialRows, runChips, statusSummary, subtreeIds, trafficByAgent, transcriptRows } from './selectors'
import { applyEvent, applyRecord, createInitialState, setActiveRun } from './state'
import { TUI_MESSAGES_MAX, TUI_TRAFFIC_MS, type TuiState } from './types'

const P = project('p1', '/work', { name: 'Shop' })
const NOW = 5_000_000

const agent = (id: string, parentId: string | null, extra: Partial<AgentInstance> = {}): AgentInstance => ({
  id,
  roleId: null,
  roleSlug: id,
  name: 'Worker',
  parentId,
  spawnToolUseId: null,
  state: 'thinking',
  activity: '',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 1,
  ...extra
})

const AGENTS: Record<string, AgentInstance> = {
  root: agent('root', null, { name: 'Orchestrator', state: 'delegating' }),
  lead: agent('lead', 'root', { name: 'Lead', handle: 'mock-lead', startedAt: 2, activity: 'Reviewing' }),
  w1: agent('w1', 'root', { name: 'Writer', handle: 'writer-1', startedAt: 3 }),
  r1: agent('r1', 'lead', { name: 'Reporter', handle: 'mock-lead-report-1', startedAt: 4 })
}

function base(agents: Record<string, AgentInstance> = AGENTS, entries: TranscriptEntry[] = []): TuiState {
  let s: TuiState = { ...createInitialState('/work'), project: P }
  s = applyRecord(s, { ...record(summary('run1', { status: 'running' })), agents, transcript: entries })
  return setActiveRun(s, 'run1')
}

let seq = 0
const message = (s: TuiState, from: string, to: string | null, toHandle: string, at: number): TuiState =>
  applyEvent(s, { seq: ++seq, event: { type: 'agent.message', runId: 'run1', from, to, toHandle, text: 'SECRET TEXT', at } as RunEvent })

const entry = (id: string, agentId: string, block: TranscriptEntry['block']): TranscriptEntry => ({ id, agentId, at: 1, block }) as TranscriptEntry

describe('agent.message in the reducer (F6)', () => {
  it('keeps who messaged whom and when, never the text', () => {
    const s = message(base(), 'w1', 'lead', 'mock-lead', NOW)
    const rec = s.runs.run1.messages
    expect(rec).toEqual([{ from: 'w1', to: 'lead', toHandle: 'mock-lead', at: NOW }])
    expect(JSON.stringify(s.runs.run1)).not.toContain('SECRET TEXT')
  })

  it('keeps the newest TUI_MESSAGES_MAX and ignores junk and unknown runs', () => {
    let s = base()
    for (let i = 0; i < TUI_MESSAGES_MAX + 25; i++) s = message(s, 'w1', 'lead', 'mock-lead', NOW + i)
    expect(s.runs.run1.messages).toHaveLength(TUI_MESSAGES_MAX)
    expect(s.runs.run1.messages?.[0].at).toBe(NOW + 25)
    expect(applyEvent(s, { seq: ++seq, event: { type: 'agent.message', runId: 'nope', from: 'a', to: null, toHandle: 'x', text: '', at: 1 } as RunEvent }).runs).toBe(s.runs)
    expect(message(s, '', null, 'x', 1).runs).toBe(s.runs)
    expect(s.runs.run1.messages?.every((m) => typeof m.toHandle === 'string')).toBe(true)
  })

  it('a message to a handle that is not an agent counts for the sender only', () => {
    const s = message(base(), 'w1', null, 'the user\x1b[31m', NOW)
    const t = trafficByAgent(s.runs.run1, NOW)
    expect(t.get('w1')?.out).toEqual([{ label: 'the user', count: 1 }])
    expect(t.get('lead')).toBeUndefined()
  })
})

describe('message counts on the rows (F6)', () => {
  it('per peer counts, newest peer first, and the traffic mark for the last 10 s', () => {
    let s = base()
    s = message(s, 'w1', 'lead', 'mock-lead', NOW - 60_000)
    s = message(s, 'w1', 'r1', 'mock-lead-report-1', NOW - 1000)
    s = message(s, 'w1', 'r1', 'mock-lead-report-1', NOW - 500)
    s = message(s, 'lead', 'w1', 'writer-1', NOW - 20_000)
    const rows = orgTreeRows(s, { now: NOW })
    const w1 = rows.find((r) => r.id === 'w1')!
    expect(w1.msgOut).toEqual([
      { label: 'mock-lead-report-1', count: 2 },
      { label: 'mock-lead', count: 1 }
    ])
    expect(w1.msgIn).toEqual([{ label: 'mock-lead', count: 1 }])
    expect(w1.traffic).toBe(true)
    expect(rows.find((r) => r.id === 'lead')?.traffic).toBeUndefined()
    expect(rows.find((r) => r.id === 'r1')?.traffic).toBe(true)
    expect(rows.find((r) => r.id === 'root')?.msgOut).toBeUndefined()
    const later = orgTreeRows(s, { now: NOW + TUI_TRAFFIC_MS + 5000 })
    expect(later.some((r) => r.traffic)).toBe(false)
    // The counts stay after the mark fades.
    expect(later.find((r) => r.id === 'w1')?.msgOut).toHaveLength(2)
  })
})

describe('subtree focus (F7)', () => {
  it('roots the tree at one agent, depth 0, with folding applied inside', () => {
    const rows = orgTreeRows(base(), { rootId: 'lead' })
    expect(rows.map((r) => [r.id, r.depth])).toEqual([
      ['lead', 0],
      ['r1', 1]
    ])
    const done = { ...AGENTS, r1: { ...AGENTS.r1, state: 'done' as const, endedAt: 1 } }
    const folded = orgTreeRows(base(done), { rootId: 'lead', collapse: true, now: NOW })
    expect(folded.map((r) => [r.kind, r.label])).toEqual([
      ['agent', 'mock-lead'],
      ['group', '1 done']
    ])
  })

  it('an unknown root shows the whole tree; a folded root is still the root', () => {
    expect(orgTreeRows(base(), { rootId: 'gone' }).map((r) => r.id)).toEqual(['root', 'lead', 'r1', 'w1'])
    const done = { ...AGENTS, lead: { ...AGENTS.lead, state: 'done' as const, endedAt: 1 }, r1: { ...AGENTS.r1, state: 'done' as const, endedAt: 1 } }
    const rows = orgTreeRows(base(done), { rootId: 'lead', collapse: true, now: NOW })
    expect(rows[0]).toMatchObject({ id: 'lead', depth: 0 })
  })

  it('subtreeIds collects the agent and everything under it', () => {
    expect([...subtreeIds(AGENTS, 'lead')].sort()).toEqual(['lead', 'r1'])
    expect([...subtreeIds(AGENTS, 'root')].sort()).toEqual(['lead', 'r1', 'root', 'w1'])
    expect(subtreeIds(AGENTS, 'nobody').size).toBe(0)
  })

  it('filters the transcript and the partials to the agent ids; dividers drop out', () => {
    const entries = [
      entry('e1', 'root', { kind: 'text', text: 'root says hi' }),
      entry('e2', 'lead', { kind: 'text', text: 'lead says hi' }),
      entry('e3', 'r1', { kind: 'thinking', text: 'report thinks' })
    ]
    let s = base(AGENTS, entries)
    s = applyEvent(s, { seq: ++seq, event: { type: 'agent.partial', runId: 'run1', agentId: 'r1', text: 'streaming' } as RunEvent })
    const all = transcriptRows(s)
    expect(all.rows.map((r) => r.agentId)).toEqual(['root', 'lead', 'r1'])
    const some = transcriptRows(s, { agentIds: subtreeIds(AGENTS, 'lead') })
    expect(some.rows.map((r) => r.text)).toEqual(['lead says hi', 'report thinks'])
    expect(partialRows(s, { agentIds: new Set(['lead']) })).toEqual([])
    expect(partialRows(s, { agentIds: new Set(['r1']) }).map((p) => p.text)).toEqual(['streaming'])
  })
})

describe('agentDetail (F4)', () => {
  it('has the facts the agent has and leaves the rest out', () => {
    const s = base()
    const bare = agentDetail(s, 'w1', NOW)!
    expect(bare).toMatchObject({ label: 'writer-1', role: 'Writer', stateWord: 'Thinking', waiting: 0, msgOut: [], msgIn: [] })
    for (const k of ['model', 'tokensIn', 'tokensOut', 'cost', 'turns', 'toolCalls', 'activity', 'worktree'] as const) expect(bare[k]).toBeUndefined()
    expect(agentDetail(s, 'nobody', NOW)).toBeUndefined()
  })

  it('model, wall time, tokens, cost, turns and tool calls from the agent and its usage', () => {
    const rich = agent('w1', 'root', {
      name: 'Writer',
      handle: 'writer-1',
      startedAt: NOW - 134_000,
      model: 'sonnet-4-5',
      activity: 'Wants to run: npm test\x1b]0;x\x07',
      costUsd: 0.03,
      worktree: { path: '/wt', branch: 'worktree-agent-w1', status: 'active', baseRef: 'x', mergeTarget: 'main', changedFiles: ['a', 'b'] } as never,
      usage: {
        tokens: { input: 1000, output: 300, cacheRead: 500, cacheWrite: 100 },
        models: [{ model: 'sonnet-4-5', tokens: { input: 1000, output: 300, cacheRead: 500, cacheWrite: 100 }, costUsd: 0.03, priceSource: 'builtin' }],
        costUsd: 0.03,
        costSource: 'computed',
        turns: 4,
        toolCalls: 9,
        retries: 0
      } as never
    })
    let s = base({ ...AGENTS, w1: rich })
    s = message(s, 'w1', 'lead', 'mock-lead', NOW)
    s = message(s, 'lead', 'w1', 'writer-1', NOW)
    const d = agentDetail(s, 'w1', NOW)!
    expect(d).toMatchObject({
      model: 'sonnet-4-5',
      wall: '2m 14s',
      tokensIn: '1.6k',
      tokensOut: '300',
      cost: '$0.03',
      turns: 4,
      toolCalls: 9,
      activity: 'Wants to run: npm test',
      worktree: { branch: 'worktree-agent-w1', status: 'active', files: 2, mergeTarget: 'main' },
      msgOut: [{ label: 'mock-lead', count: 1 }],
      msgIn: [{ label: 'mock-lead', count: 1 }]
    })
  })

  it('an unpriced agent reads unknown, never $0', () => {
    const u = agent('w1', 'root', { usage: { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, models: [], costUsd: null, costSource: 'unknown', turns: 1, toolCalls: 0, retries: 0 } as never })
    expect(agentDetail(base({ ...AGENTS, w1: u }), 'w1', NOW)?.cost).toBe('unknown')
  })
})

describe('run chips and neighbours (F8)', () => {
  function twoRuns(): TuiState {
    let s: TuiState = { ...createInitialState('/work'), project: P }
    s = applyRecord(s, { ...record(summary('a', { status: 'running', startedAt: 1 })) })
    s = applyRecord(s, { ...record(summary('b', { status: 'idle', startedAt: 2 })) })
    s = applyRecord(s, { ...record(summary('c', { status: 'finished', startedAt: 3 })) })
    s = applyRecord(s, { ...record(summary('d', { status: 'running', startedAt: 4 })) })
    return setActiveRun(s, 'a')
  }

  it('lists the live runs oldest first; the followed one is marked, finished ones are left out', () => {
    expect(runChips(twoRuns()).map((c) => [c.tag, c.followed, c.needsYou])).toEqual([
      ['R1', true, false],
      ['R2', false, false],
      ['R4', false, false]
    ])
    expect(statusSummary(twoRuns()).runChips).toHaveLength(3)
  })

  it('flags a run with an open decision', () => {
    let s = twoRuns()
    s = applyEvent(s, { seq: ++seq, event: { type: 'permission.request', runId: 'd', request: { id: 'p', runId: 'd', agentId: 'root', toolName: 'Bash', input: {}, summary: 'x' } } as RunEvent })
    expect(runChips(s).find((c) => c.tag === 'R4')?.needsYou).toBe(true)
  })

  it('adjacentLiveRun wraps and is undefined with no other live run', () => {
    const s = twoRuns()
    expect(adjacentLiveRun(s, 1)?.tag).toBe('R2')
    expect(adjacentLiveRun(s, -1)?.tag).toBe('R4')
    expect(adjacentLiveRun(base(), 1)).toBeUndefined()
  })
})

describe('offersRetro (F12)', () => {
  it('an ended work run of a real project; not chats, single runs, assistants or open runs', () => {
    const run = { kind: 'work', projectId: 'p1', status: 'finished' } as const
    expect(offersRetro(run)).toBe(true)
    expect(offersRetro({ ...run, status: 'error' })).toBe(true)
    expect(offersRetro({ ...run, status: 'running' })).toBe(false)
    expect(offersRetro({ ...run, status: 'idle' })).toBe(false)
    expect(offersRetro({ ...run, team: 'single' })).toBe(false)
    expect(offersRetro({ ...run, projectId: 'quick' })).toBe(false)
    expect(offersRetro({ ...run, kind: 'setup' })).toBe(false)
    expect(offersRetro({ ...run, quick: { folder: '/x' } as never })).toBe(false)
  })
})
