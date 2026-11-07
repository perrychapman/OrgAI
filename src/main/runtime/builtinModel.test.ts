import { describe, expect, it } from 'vitest'
import { builtinModels } from '@shared/defaults'
import type { ProviderModel } from '@shared/types'
import { resolveBuiltinModel, type BuiltinModelContext } from './builtinModel'

const lite = (id: string, family: ProviderModel['family'], tier?: ProviderModel['tier']): ProviderModel => ({
  id,
  label: id,
  connection: 'litellm',
  family,
  adapter: family === 'claude' ? 'claude' : 'codex',
  source: 'discovered',
  ...(tier ? { tier } : {})
})

const catalog: ProviderModel[] = [
  ...builtinModels('anthropic'),
  ...builtinModels('openai'),
  lite('us.anthropic.claude-opus-5-5', 'claude', 'deep'),
  lite('us.anthropic.claude-haiku-4-5', 'claude', 'fast'),
  lite('us.openai.gpt-5', 'openai', 'deep'),
  lite('us.openai.gpt-5-mini', 'openai', 'everyday')
]

const anthropic: BuiltinModelContext = { connection: 'anthropic', adapter: 'claude', catalog, tierModels: { top: 'fable', deep: 'opus', everyday: 'sonnet', fast: 'haiku' } }
const liteClaude: BuiltinModelContext = {
  connection: 'litellm',
  adapter: 'claude',
  catalog,
  tierModels: { deep: 'us.anthropic.claude-opus-5-5', fast: 'us.anthropic.claude-haiku-4-5', everyday: 'us.openai.gpt-5-mini' }
}
const liteCodex: BuiltinModelContext = { ...liteClaude, adapter: 'codex', root: { model: 'us.openai.gpt-5' } }

describe('resolveBuiltinModel', () => {
  it('keeps the default deep tier on anthropic, silently', () => {
    expect(resolveBuiltinModel(undefined, 'Setup model', anthropic)).toEqual({ model: 'opus', tier: 'deep' })
    expect(resolveBuiltinModel('deep', 'Setup model', anthropic)).toEqual({ model: 'opus', tier: 'deep' })
  })

  it('uses a valid choice on anthropic: an alias or a full Claude id', () => {
    expect(resolveBuiltinModel('sonnet', 'Setup model', anthropic)).toEqual({ model: 'sonnet', tier: 'everyday' })
    expect(resolveBuiltinModel('claude-sonnet-4-5', 'Setup model', anthropic)).toEqual({ model: 'claude-sonnet-4-5', tier: 'everyday' })
  })

  it('maps an alias to the LiteLLM tier model', () => {
    expect(resolveBuiltinModel('haiku', 'Setup model', liteClaude)).toEqual({ model: 'us.anthropic.claude-haiku-4-5', tier: 'fast' })
    expect(resolveBuiltinModel('opus', 'Setup model', liteClaude)).toEqual({ model: 'us.anthropic.claude-opus-5-5', tier: 'deep' })
  })

  it('accepts a discovered LiteLLM model of the run family', () => {
    expect(resolveBuiltinModel('us.openai.gpt-5-mini', 'Setup model', liteCodex)).toEqual({ model: 'us.openai.gpt-5-mini', tier: 'everyday' })
  })

  it('falls back to the deep tier with one warning for a wrong-family choice', () => {
    const r = resolveBuiltinModel('us.openai.gpt-5-mini', 'MCP assistant model', liteClaude)
    expect(r.model).toBe('us.anthropic.claude-opus-5-5')
    expect(r.tier).toBe('deep')
    expect(r.warning).toBe(
      'App setting "MCP assistant model" is us.openai.gpt-5-mini, which this run cannot use on the proxy connection (Claude adapter); using the deep tier (us.anthropic.claude-opus-5-5).'
    )
    // The proxy's own name, when RunManager passes it.
    expect(resolveBuiltinModel('us.openai.gpt-5-mini', 'MCP assistant model', { ...liteClaude, connection: 'proxy-aaaa1111', connectionName: 'Team gateway' }).warning).toMatch(/on the Team gateway connection/)
    // An alias whose tier maps to the other family also falls back.
    expect(resolveBuiltinModel('sonnet', 'Setup model', liteClaude).warning).toMatch(/using the deep tier/)
  })

  it('falls back for an unknown model', () => {
    const r = resolveBuiltinModel('no-such-model', 'Setup model', liteClaude)
    expect(r.model).toBe('us.anthropic.claude-opus-5-5')
    expect(r.warning).toMatch(/App setting "Setup model" is no-such-model/)
    expect(resolveBuiltinModel('gpt-9', 'Setup model', anthropic)).toMatchObject({ model: 'opus', tier: 'deep', warning: expect.stringContaining('Anthropic connection') })
  })

  it("uses the orchestrator's model when the deep tier is on the other family", () => {
    // LiteLLM project whose root is a GPT model: the deep tier is a Claude model, so the default resolves to the root.
    expect(resolveBuiltinModel('deep', 'Setup model', liteCodex)).toEqual({ model: 'us.openai.gpt-5' })
    const r = resolveBuiltinModel('us.anthropic.claude-haiku-4-5', 'Setup model', liteCodex)
    expect(r.model).toBe('us.openai.gpt-5')
    expect(r.warning).toMatch(/using the orchestrator's model \(us\.openai\.gpt-5\)/)
    expect(resolveBuiltinModel(undefined, 'Setup model', { ...liteCodex, root: undefined })).toEqual({ model: 'inherit' })
  })

  it('maps tiers on the OpenAI connection', () => {
    const openai: BuiltinModelContext = { connection: 'openai', adapter: 'codex', catalog, tierModels: { deep: 'gpt-5', fast: 'gpt-5-nano' } }
    expect(resolveBuiltinModel('opus', 'Setup model', openai)).toEqual({ model: 'gpt-5', tier: 'deep' })
    expect(resolveBuiltinModel('gpt-5-mini', 'Setup model', openai)).toEqual({ model: 'gpt-5-mini', tier: 'everyday' })
  })

  it('maps a tier name through tierModels (anthropic included) and uses the builtin alias only when unmapped', () => {
    expect(resolveBuiltinModel('everyday', 'Setup model', { ...anthropic, tierModels: { everyday: 'claude-sonnet-9' } })).toEqual({ model: 'claude-sonnet-9', tier: 'everyday' })
    expect(resolveBuiltinModel('fast', 'Setup model', { ...anthropic, tierModels: {} })).toEqual({ model: 'haiku', tier: 'fast' })
  })

  it('falls back to inherit, never opus, when nothing maps; the default never warns', () => {
    expect(resolveBuiltinModel('deep', 'Setup model', { connection: 'litellm', adapter: 'claude', catalog: [], tierModels: {} })).toEqual({ model: 'inherit' })
    expect(resolveBuiltinModel('deep', 'Setup model', liteCodex).warning).toBeUndefined()
  })

  it('passes the setting through on the mock adapter', () => {
    expect(resolveBuiltinModel('sonnet', 'Setup model', { ...anthropic, adapter: 'mock' })).toEqual({ model: 'sonnet', tier: 'everyday' })
  })

  describe('fallbackTier (the Chat assistant)', () => {
    const chat = { ...anthropic, fallbackTier: 'everyday' as const }

    it('defaults to deep when unset, and to the fallback tier when the setting is missing', () => {
      expect(resolveBuiltinModel(undefined, 'Chat model', anthropic)).toEqual({ model: 'opus', tier: 'deep' })
      expect(resolveBuiltinModel(undefined, 'Chat model', chat)).toEqual({ model: 'sonnet', tier: 'everyday' })
      expect(resolveBuiltinModel('', 'Chat model', chat)).toEqual({ model: 'sonnet', tier: 'everyday' })
    })

    it('keeps the fallback tier silent and honours a valid choice', () => {
      expect(resolveBuiltinModel('everyday', 'Chat model', chat).warning).toBeUndefined()
      expect(resolveBuiltinModel('deep', 'Chat model', chat)).toEqual({ model: 'opus', tier: 'deep' })
    })

    it('falls back to the everyday tier, with one warning naming the setting, for an unusable choice', () => {
      const r = resolveBuiltinModel('gpt-5', 'Chat model', chat)
      expect(r).toMatchObject({ model: 'sonnet', tier: 'everyday' })
      expect(r.warning).toContain('"Chat model" is gpt-5')
      expect(r.warning).toContain('the everyday tier (sonnet)')
    })

    it('uses the orchestrator model when the connection maps no everyday tier', () => {
      const noTier: BuiltinModelContext = { connection: 'litellm', adapter: 'claude', catalog: [], tierModels: {}, fallbackTier: 'everyday', root: { model: 'claude-x', tier: 'deep' } }
      expect(resolveBuiltinModel('gpt-5', 'Chat model', noTier)).toMatchObject({ model: 'claude-x', warning: expect.stringContaining("orchestrator's model") })
    })
  })
})
