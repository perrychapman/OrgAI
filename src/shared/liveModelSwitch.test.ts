import { describe, expect, it } from 'vitest'
import type { ProviderModel, RunSummary } from './types'
import { modelSwitchOutcome, resolveModelChoice, tiersOfModel } from './liveModelSwitch'

const m = (id: string, connection = 'anthropic', extra: Partial<ProviderModel> = {}): ProviderModel =>
  ({ id, label: id, connection, family: 'claude', adapter: connection === 'openai' ? 'codex' : 'claude', source: 'builtin', ...extra }) as ProviderModel
const catalog = [m('claude-opus-5-5'), m('claude-sonnet-5-5'), m('gpt-6', 'openai'), m('shared'), m('shared', 'openai'), m('only-openai', 'openai')]

describe('resolveModelChoice', () => {
  it('resolves a tier through the connection mapping, case folded', () => {
    expect(resolveModelChoice('DEEP', { catalog, connection: 'anthropic', tierModels: { deep: 'claude-opus-5-5' } })).toEqual({ model: catalog[0], tier: 'deep' })
  })

  it('names the tier when nothing in the catalog maps to it', () => {
    const r = resolveModelChoice('fast', { catalog, connection: 'anthropic', tierModels: { fast: 'gone-model', top: 'gone-model', deep: 'gone-model', everyday: 'gone-model' } })
    expect(r).toEqual({ error: expect.stringContaining('fast tier (gone-model is not in its catalog)') })
  })

  it('prefers the run connection, then a single other connection; refuses ambiguous and unknown ids', () => {
    expect(resolveModelChoice('shared', { catalog, connection: 'openai' })).toEqual({ model: catalog[4] })
    expect(resolveModelChoice('only-openai', { catalog, connection: 'anthropic' })).toEqual({ model: catalog[5] })
    expect(resolveModelChoice('missing', { catalog, connection: 'anthropic' })).toEqual({ error: expect.stringContaining('not available on a connected connection') })
    expect(resolveModelChoice('shared', { catalog: catalog.filter((x) => x.id === 'shared'), connection: 'proxy-12345678' })).toEqual({ error: expect.stringContaining('several connections') })
    expect(resolveModelChoice('gpt-6', { catalog, connection: 'anthropic', only: 'anthropic' })).toEqual({ error: 'Model gpt-6 is not available on anthropic.' })
    expect(resolveModelChoice('  ', { catalog, connection: 'anthropic' })).toEqual({ error: 'Name a tier or a model id.' })
  })
})

describe('modelSwitchOutcome', () => {
  const run = (extra: Partial<RunSummary> = {}): RunSummary => ({ id: 'r1', status: 'idle', modelSelection: { model: 'x', connection: 'anthropic' }, ...extra }) as RunSummary
  const sel = { id: 'new', connection: 'anthropic' as const }
  it('reads applied, saved for the next message, a refusal (with handoff wish) and a moved conversation', () => {
    expect(modelSwitchOutcome({ run: run(), applied: true }, 'r1', sel)).toEqual({ kind: 'applied' })
    expect(modelSwitchOutcome({ run: run({ status: 'finished', modelSelection: { model: 'new', connection: 'anthropic' } }), applied: false }, 'r1', sel)).toEqual({ kind: 'next' })
    expect(modelSwitchOutcome({ run: run(), applied: false, reason: 'End this session, then select the model and send a message to continue with a transcript handoff.' }, 'r1', sel)).toMatchObject({ kind: 'refused', wantsHandoff: true })
    expect(modelSwitchOutcome({ run: run(), applied: false }, 'r1', sel)).toEqual({ kind: 'refused', reason: 'The model could not be changed.' })
    expect(modelSwitchOutcome({ run: run({ id: 'r2' }), applied: false, reason: 'The conversation has continued; select the model again.' }, 'r1', sel)).toEqual({ kind: 'moved', reason: 'The conversation has continued; select the model again.' })
  })
})

describe('tiersOfModel', () => {
  it('lists every tier mapped to the id', () => {
    expect(tiersOfModel('a', { top: 'a', deep: 'a', fast: 'b' })).toEqual(['top', 'deep'])
    expect(tiersOfModel('a', undefined)).toEqual([])
  })
})
