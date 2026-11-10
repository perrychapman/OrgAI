import { describe, expect, it } from 'vitest'
import type { ConnectionId, ProviderModel } from '@shared/types'
import { compareModelIds, newerInFamily, parseModelVersion, runModelLogs, type RunModelsInput } from './runModels'

describe('parseModelVersion', () => {
  it('reads family, version and snapshot date', () => {
    expect(parseModelVersion('claude-opus-4-1-20250805')).toEqual({ family: 'claude-opus', version: [4, 1], date: 20250805 })
    expect(parseModelVersion('claude-opus-5-5')).toEqual({ family: 'claude-opus', version: [5, 5] })
    expect(parseModelVersion('claude-sonnet-5-5[1m]')).toEqual({ family: 'claude-sonnet', version: [5, 5] })
    expect(parseModelVersion('gpt-6.1-sol')).toEqual({ family: 'gpt-sol', version: [6, 1] })
    expect(parseModelVersion('claude-3-5-sonnet-20241022')).toEqual({ family: 'claude-sonnet', version: [3, 5], date: 20241022 })
    expect(parseModelVersion('anthropic/claude-haiku-4-5')).toEqual({ family: 'claude-haiku', version: [4, 5] })
    expect(parseModelVersion('us.anthropic.claude-opus-5-5')).toEqual({ family: 'claude-opus', version: [5, 5] })
    expect(parseModelVersion('claude-opus-4-1@20250805')).toEqual({ family: 'claude-opus', version: [4, 1], date: 20250805 })
    expect(parseModelVersion('gpt-4o-2024-08-06')).toBeUndefined()
  })

  it('has no version for aliases and odd ids', () => {
    expect(parseModelVersion('opus')).toBeUndefined()
    expect(parseModelVersion('sonnet[1m]')).toBeUndefined()
    expect(parseModelVersion('')).toBeUndefined()
    expect(parseModelVersion('42')).toBeUndefined()
  })
})

describe('compareModelIds', () => {
  it('orders versions within a family', () => {
    expect(compareModelIds('claude-opus-5-5', 'claude-opus-4-1-20250805')).toBeGreaterThan(0)
    expect(compareModelIds('claude-opus-4-1-20250805', 'claude-opus-5-5')).toBeLessThan(0)
    expect(compareModelIds('claude-opus-4-1', 'claude-opus-4-20250514')).toBeGreaterThan(0)
    expect(compareModelIds('gpt-6.1-sol', 'gpt-6-sol')).toBeGreaterThan(0)
    expect(compareModelIds('claude-sonnet-4-5', 'claude-3-5-sonnet-20241022')).toBeGreaterThan(0)
  })

  it('treats a context marker or a missing date as the same version', () => {
    expect(compareModelIds('claude-sonnet-5-5[1m]', 'claude-sonnet-5-5')).toBe(0)
    expect(compareModelIds('claude-opus-4-1-20250805', 'claude-opus-4-1')).toBe(0)
    expect(compareModelIds('claude-opus-4-1-20250901', 'claude-opus-4-1-20250805')).toBeGreaterThan(0)
  })

  it('cannot tell across families or without a version', () => {
    expect(compareModelIds('claude-opus-5-5', 'claude-sonnet-5-5')).toBeUndefined()
    expect(compareModelIds('gpt-6.1-sol', 'gpt-6.1')).toBeUndefined()
    expect(compareModelIds('opus', 'claude-opus-5-5')).toBeUndefined()
  })

  it('newerInFamily picks the newest newer id', () => {
    expect(newerInFamily('claude-opus-4-1-20250805', ['claude-opus-4-1-20250805', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-6'])).toBe('claude-opus-5-5')
    expect(newerInFamily('claude-opus-5-5', ['claude-opus-4-1', 'claude-opus-5-5'])).toBeUndefined()
    expect(newerInFamily('opus', ['claude-opus-5-5'])).toBeUndefined()
  })
})

const model = (connection: ConnectionId, id: string, source: ProviderModel['source'] = 'discovered') => ({ id, connection, source })
const names: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI' }

function input(over: Partial<RunModelsInput> = {}): RunModelsInput {
  return {
    roles: [
      { id: 'lead', model: 'claude-opus-5-5', tier: 'deep' },
      { id: 'eng', model: 'claude-sonnet-5-5', tier: 'everyday' },
      { id: 'eng2', model: 'claude-sonnet-5-5', tier: 'everyday' }
    ],
    connectionOf: () => 'anthropic',
    catalog: () => [model('anthropic', 'claude-opus-5-5'), model('anthropic', 'claude-sonnet-5-5'), model('anthropic', 'opus', 'builtin'), model('openai', 'gpt-6.1-sol')],
    connectionName: (id) => names[id] ?? id,
    ...over
  }
}

describe('runModelLogs', () => {
  it('names each tier once, most capable first, with the connection', () => {
    expect(runModelLogs(input())).toEqual([{ level: 'info', message: 'Models: deep = claude-opus-5-5, everyday = claude-sonnet-5-5 (Anthropic)' }])
  })

  it('lists exact-id roles by id and groups by connection', () => {
    const logs = runModelLogs(
      input({
        roles: [
          { id: 'eng', model: 'claude-sonnet-5-5', tier: 'everyday' },
          { id: 'lead', model: 'claude-opus-5-5', tier: 'deep' },
          { id: 'x', model: 'claude-haiku-4-5' },
          { id: 'cx', model: 'gpt-6.1-sol', tier: 'fast' },
          { id: 'in', model: 'inherit' }
        ],
        connectionOf: (id) => (id === 'cx' ? 'openai' : 'anthropic')
      })
    )
    expect(logs).toEqual([{ level: 'info', message: 'Models: deep = claude-opus-5-5, everyday = claude-sonnet-5-5, claude-haiku-4-5 (Anthropic); fast = gpt-6.1-sol (OpenAI)' }])
  })

  it('warns once for an older family member, a built-in fallback and a failed discovery', () => {
    const logs = runModelLogs(
      input({
        roles: [
          { id: 'lead', model: 'claude-opus-4-1-20250805', tier: 'deep' },
          { id: 'eng', model: 'opus', tier: 'everyday' },
          { id: 'cx', model: 'gpt-6.1-sol', tier: 'fast' }
        ],
        connectionOf: (id) => (id === 'cx' ? 'openai' : 'anthropic'),
        catalog: () => [model('anthropic', 'claude-opus-4-1-20250805'), model('anthropic', 'claude-opus-5-5'), model('anthropic', 'opus', 'builtin'), model('openai', 'gpt-6.1-sol')],
        modelsError: (id) => (id === 'openai' ? 'Request timed out' : undefined)
      })
    )
    expect(logs).toHaveLength(2)
    expect(logs[0]).toEqual({ level: 'info', message: 'Models: deep = claude-opus-4-1-20250805, everyday = opus (Anthropic); fast = gpt-6.1-sol (OpenAI)' })
    expect(logs[1]).toEqual({
      level: 'warn',
      message:
        'Model check: deep = claude-opus-4-1-20250805 is not the newest of its family on Anthropic (claude-opus-5-5 is listed); everyday = opus is a built-in fallback, not a model discovered on Anthropic; model discovery last failed on OpenAI (Request timed out), so fast may be out of date. Run orgai models refresh, or map the tier with orgai connections tier anthropic or orgai connections tier openai.'
    })
  })

  it('does not warn when it cannot tell, for exact-id roles or for models outside the catalog', () => {
    const logs = runModelLogs(
      input({
        roles: [
          { id: 'a', model: 'claude-opus-4-1', tier: 'deep' },
          { id: 'b', model: 'claude-opus-4-1-20250805' },
          { id: 'c', model: 'my-custom-model', tier: 'fast' }
        ],
        catalog: () => [model('anthropic', 'claude-opus-4-1'), model('anthropic', 'claude-opus-4-1-20250805'), model('anthropic', 'claude-opus-5-5')]
      })
    )
    // 'a' is older than claude-opus-5-5 (warns); 'b' has no tier; 'c' is not in the catalog.
    expect(logs[1]?.message).toContain('deep = claude-opus-4-1 is not the newest')
    expect(logs[1]?.message).not.toContain('my-custom-model')
    expect(logs[1]?.message).not.toContain('= claude-opus-4-1-20250805')
  })

  it('reports nothing when every role inherits, and never throws', () => {
    expect(runModelLogs(input({ roles: [{ id: 'a', model: 'inherit' }] }))).toEqual([])
    expect(
      runModelLogs(
        input({
          connectionName: () => {
            throw new Error('boom')
          }
        })
      )
    ).toEqual([])
    expect(
      runModelLogs(
        input({
          catalog: () => {
            throw new Error('boom')
          }
        })
      )
    ).toEqual([])
  })
})
