import { describe, expect, it } from 'vitest'
import type { AgentInstance, AgentUsage, RunUsage } from '../../shared/types'
import { project, record, summary } from '../testing/fakeContext'
import { applyRecord, createInitialState, setActiveRun } from './state'
import type { TuiState } from './types'
import { usageText } from './usageText'

const P = project('p1', '/work', { name: 'Shop' })

const usage = (over: Partial<AgentUsage> = {}): AgentUsage => ({
  tokens: { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0 },
  models: [{ model: 'sonnet-4-5', tokens: { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0 }, costUsd: 0.05, priceSource: 'builtin' }],
  costUsd: 0.05,
  costSource: 'computed',
  turns: 3,
  toolCalls: 5,
  retries: 0,
  ...over
})

const agent = (id: string, parentId: string | null, extra: Partial<AgentInstance> = {}): AgentInstance => ({
  id,
  roleId: null,
  roleSlug: id === 'root' ? 'orchestrator' : 'writer',
  name: id === 'root' ? 'Orchestrator' : 'Writer',
  parentId,
  spawnToolUseId: null,
  state: 'done',
  activity: '',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 1,
  ...extra
})

const runUsage = (over: Partial<RunUsage> = {}): RunUsage =>
  ({
    tokens: { input: 1500, output: 300, cacheRead: 3000, cacheWrite: 0 },
    costUsd: 0.07,
    costSource: 'computed',
    models: [],
    roles: [
      { roleId: null, roleSlug: 'orchestrator', roleName: 'Orchestrator', agents: 1, tokens: { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0 }, costUsd: 0.05, costSource: 'computed', turns: 3, toolCalls: 5, retries: 0, agentWallMs: 1, agentsWithoutResult: 0, noResultTokens: 0, models: [] },
      { roleId: null, roleSlug: 'writer', roleName: 'Writer', agents: 1, tokens: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.02, costSource: 'computed', turns: 2, toolCalls: 4, retries: 0, agentWallMs: 1, agentsWithoutResult: 0, noResultTokens: 0, models: [] }
    ],
    wallMs: 90_000,
    turns: 5,
    toolCalls: 9,
    retries: 0,
    agents: 2,
    agentsWithoutResult: 0,
    noResultTokens: 0,
    nudges: 0,
    waitingMs: 0,
    limitHoldMs: 0,
    idleMs: 0,
    updatedAt: 1,
    ...over
  }) as RunUsage

function chain(): TuiState {
  let s: TuiState = { ...createInitialState('/work'), project: P }
  const first = { ...summary('a', { startedAt: 1 }), usage: runUsage() }
  const second = { ...summary('b', { startedAt: 2, resumedFrom: 'a' }), usage: runUsage({ costUsd: 0.03, wallMs: 30_000 }) }
  s = applyRecord(s, { ...record(first), agents: { root: agent('root', null, { usage: usage() }), w: agent('w', 'root', { handle: 'writer-1', usage: usage({ tokens: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 }, turns: 2, toolCalls: 4, costUsd: 0.02 }) }) } })
  s = applyRecord(s, { ...record(second), agents: { root: agent('root', null, { usage: usage() }) } })
  return setActiveRun(s, 'b', ['a', 'b'])
}

describe('usageText (F11)', () => {
  it('sums the whole chain: cost, wall time, tokens, work, then By agent and By role', () => {
    const t = usageText(chain())
    expect(t).toContain('Usage for R2 and the 1 run before it (one conversation)')
    expect(t).toContain('Cost        $0.10')
    expect(t).toContain('Wall time   2m 00s')
    expect(t).toMatch(/Tokens\s+9\.0k in \/ 600 out/)
    expect(t).toContain('cache hit')
    expect(t).toContain('By agent')
    expect(t).toContain('writer-1 (Writer)')
    expect(t).toContain('By role')
    expect(t).toMatch(/Orchestrator\s+2\s/)
  })

  it('a single run says no chain; no run says what to do', () => {
    let s: TuiState = { ...createInitialState('/work'), project: P }
    expect(usageText(s)).toContain('No run is open')
    s = applyRecord(s, { ...record({ ...summary('a'), usage: runUsage() }), agents: { root: agent('root', null, { usage: usage() }) } })
    s = setActiveRun(s, 'a')
    const t = usageText(s)
    expect(t.split('\n')[0]).toBe('Usage for R1')
    expect(t).not.toContain('one conversation')
  })

  it('an unknown cost reads unknown, never $0', () => {
    let s: TuiState = { ...createInitialState('/work'), project: P }
    const u = usage({ costUsd: null, costSource: 'unknown', models: [{ model: 'mystery-1', tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, costUsd: null, priceSource: 'unknown' }] })
    s = applyRecord(s, {
      ...record({ ...summary('a'), usage: runUsage({ costUsd: null, costSource: 'unknown', models: u.models, roles: [] }) }),
      agents: { root: agent('root', null, { usage: u }) }
    })
    s = setActiveRun(s, 'a')
    const t = usageText(s)
    expect(t).toContain('Cost        unknown')
    expect(t).not.toContain('$0')
    expect(t).toContain('No price for mystery-1')
    // Roles come from the agents when the run carries none.
    expect(t).toMatch(/Orchestrator\s+1\s/)
  })

  it('a partly priced sum is a lower bound', () => {
    let s: TuiState = { ...createInitialState('/work'), project: P }
    s = applyRecord(s, { ...record({ ...summary('a'), usage: runUsage({ costUsd: 0.4, costPartial: true }) }), agents: { root: agent('root', null, { usage: usage() }) } })
    s = setActiveRun(s, 'a')
    expect(usageText(s)).toContain('$0.40+ (a lower bound')
  })

  it('names are one sanitized line; agents without usage are approximate', () => {
    let s: TuiState = { ...createInitialState('/work'), project: P }
    s = applyRecord(s, { ...record(summary('a')), agents: { root: agent('root', null, { name: 'Bad\x1b]0;pwn\x07Name', inputTokens: 40, outputTokens: 4 }) } })
    s = setActiveRun(s, 'a')
    const t = usageText(s)
    expect(t).not.toContain('\x1b')
    expect(t).toContain('BadName')
    expect(t).toContain('~ approximate')
    expect(t).toContain('no usage numbers yet')
  })
})
