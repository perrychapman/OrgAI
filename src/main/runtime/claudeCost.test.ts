import { describe, expect, it } from 'vitest'
import type { ModelPrice } from '@shared/types'
import { ClaudeSession } from './claude'
import { fakeCtx, orgChart, project } from './testHelpers'
import type { RunConnection } from './types'

const pricing: Record<string, ModelPrice> = { 'gpt-x': { inputPerToken: 0.000001, outputPerToken: 0.000005 } }

type Ev = { type: string; totalCostUsd?: number; agent?: { costUsd: number } }

function session(connection: RunConnection | undefined) {
  const roles = orgChart()
  const ctx = fakeCtx({ project: project({ roles }), roles, connection })
  const s = new ClaudeSession(ctx) as unknown as { handle(m: unknown): void }
  return { s, ctx, events: ctx.events as unknown as Ev[] }
}
const assistant = (id: string, model: string, input: number, output: number) => ({
  type: 'assistant',
  uuid: id,
  parent_tool_use_id: null,
  message: { id, model, content: [], usage: { input_tokens: input, output_tokens: output } }
})
const result = (total: number, modelUsage: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  result: 'ok',
  total_cost_usd: total,
  modelUsage,
  is_error: false,
  usage: {}
})
const costs = (events: Ev[]) => events.filter((e) => e.type === 'run.cost').map((e) => e.totalCostUsd)
const rootCost = (events: Ev[]) => [...events].reverse().find((e) => e.type === 'agent.upsert')?.agent?.costUsd

describe('LiteLLM cost estimates', () => {
  it('prices agents and the run total live from the pricing map, ignoring a zero CLI total', () => {
    const { s, events } = session({ connection: 'litellm', adapter: 'claude', env: {}, pricing })
    s.handle(assistant('m1', 'gpt-x', 1000, 200))
    expect(rootCost(events)).toBeCloseTo(0.002, 9)
    expect(costs(events)).toEqual([expect.closeTo(0.002, 9)])
    s.handle(result(0))
    expect(costs(events).at(-1)).toBeCloseTo(0.002, 9)
  })

  it('falls back to CLI rates for a model without a price', () => {
    const { s, events } = session({ connection: 'litellm', adapter: 'claude', env: {}, pricing })
    s.handle(assistant('m1', 'other', 100, 0))
    s.handle(
      result(0.5, { other: { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 } })
    )
    expect(costs(events).at(-1)).toBeCloseTo(0.5, 9)
    expect(rootCost(events)).toBeCloseTo(0.5, 9)
  })

  it('leaves anthropic and unpriced LiteLLM on the CLI total', () => {
    const conns: RunConnection[] = [
      { connection: 'anthropic', adapter: 'claude', env: {}, pricing },
      { connection: 'litellm', adapter: 'claude', env: {} }
    ]
    for (const c of conns) {
      const { s, events } = session(c)
      s.handle(assistant('m1', 'gpt-x', 1000, 200))
      expect(costs(events)).toEqual([])
      s.handle(result(0.7))
      expect(costs(events)).toEqual([0.7])
    }
  })
})
