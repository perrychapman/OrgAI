import { describe, expect, it } from 'vitest'
import type { AgentInstance } from '@shared/types'
import { chainCanvas, earlierKey, type ChainMemberView } from './chainView'

const agent = (id: string, parentId: string | null, over: Partial<AgentInstance> = {}): AgentInstance => ({
  id,
  roleId: null,
  roleSlug: id,
  name: id,
  parentId,
  spawnToolUseId: null,
  state: 'done',
  activity: 'Finished',
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  startedAt: 1,
  ...over
})

const member = (id: string, status: 'finished' | 'running', agents: AgentInstance[]): ChainMemberView => ({
  summary: { id, status, endedAt: status === 'finished' ? 10 : undefined },
  agents: Object.fromEntries(agents.map((a) => [a.id, a]))
})

describe('chainCanvas', () => {
  it('returns a single member as is, settled when it ended', () => {
    const m = member('r1', 'finished', [agent('root', null, { state: 'idle', activity: 'Waiting for you' }), agent('a', 'root', { state: 'thinking', activity: 'Thinking…' })])
    const c = chainCanvas([m])
    expect(c.earlier).toEqual([])
    expect(c.agents.map((a) => a.activity)).not.toContain('Thinking…')
    expect(c.agents.find((a) => a.id === 'a')?.activity).toBe('Stopped')
  })

  it('sums the root across members and folds earlier reports into one group', () => {
    const r1 = member('r1', 'finished', [
      agent('root', null, { inputTokens: 100, outputTokens: 10, costUsd: 0.5, usage: { tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, models: [], costUsd: 0.5, costSource: 'provider', turns: 1, toolCalls: 0, retries: 0 } }),
      agent('a', 'root'),
      agent('b', 'a')
    ])
    const r2 = member('r2', 'running', [
      agent('root', null, { state: 'thinking', activity: 'Thinking…', inputTokens: 50, outputTokens: 5, costUsd: 0.25, usage: { tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 }, models: [], costUsd: 0.25, costSource: 'provider', turns: 1, toolCalls: 0, retries: 0 } })
    ])
    const c = chainCanvas([r1, r2])
    const root = c.agents.find((a) => a.id === 'root')!
    expect(root.inputTokens).toBe(150)
    expect(root.outputTokens).toBe(15)
    expect(root.usage?.costUsd).toBeCloseTo(0.75)
    expect(root.activity).toBe('Thinking…')
    expect(c.earlier).toHaveLength(1)
    expect(c.earlier[0].key).toBe(earlierKey('r1'))
    expect(c.earlier[0].label).toBe('Earlier: 2 agents')
    expect(c.earlier[0].agents.map((a) => [a.id, a.parentId])).toEqual([
      ['r1/a', 'root'],
      ['r1/b', 'r1/a']
    ])
    expect(c.origin.get('r1/b')).toEqual({ runId: 'r1', agentId: 'b' })
  })

  it('never turns an unknown cost into $0', () => {
    const unknown = { tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, models: [], costUsd: null, costSource: 'unknown' as const, turns: 1, toolCalls: 0, retries: 0 }
    const r1 = member('r1', 'finished', [agent('root', null, { usage: unknown })])
    const r2 = member('r2', 'finished', [agent('root', null, { usage: unknown })])
    expect(chainCanvas([r1, r2]).agents[0].usage?.costUsd).toBeNull()
  })

  it('settles earlier reports so none says Thinking, and omits members without reports', () => {
    const r1 = member('r1', 'finished', [agent('root', null), agent('a', 'root', { state: 'thinking', activity: 'Thinking…' })])
    const r2 = member('r2', 'finished', [agent('root', null)])
    const r3 = member('r3', 'finished', [agent('root', null)])
    const c = chainCanvas([r1, r2, r3])
    expect(c.earlier.map((g) => g.runId)).toEqual(['r1'])
    expect(c.earlier[0].agents[0].activity).toBe('Stopped')
    expect(c.earlier[0].agents[0].state).toBe('done')
  })
})
