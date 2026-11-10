import { describe, expect, it, vi } from 'vitest'
import type { PendingCards, ProviderModel, RunRecord, RunSummary } from '@shared/types'
import { filterLiveModels, liveModelLabel, liveModelOptions, modelKey, modelSwitchBlock, needsModelHandoff, performModelSwitch, waitForModelBoundary } from './liveModelSwitch'

describe('live model switch', () => {
  it('shows the actual model and connection', () => {
    expect(liveModelLabel('model-id', 'anthropic')).toBe('model-id via Anthropic')
  })

  it('offers concrete ids only from the selected connection, without duplicates', () => {
    const models = [
      { id: 'a', label: 'Alpha', connection: 'anthropic' },
      { id: 'a', label: 'Alpha', connection: 'anthropic' },
      { id: 'b', label: 'b', connection: 'openai' }
    ] as ProviderModel[]
    expect(liveModelOptions(models, 'anthropic')).toEqual([{ value: 'a', label: 'Alpha (a)' }])
  })
})

const summary = (status: RunSummary['status'] = 'idle'): RunSummary => ({ id: 'run', status, connection: 'anthropic', modelAdapter: 'claude', modelSelection: { model: 'old', connection: 'anthropic' } } as RunSummary)
const record = (status: RunSummary['status'] = 'idle'): RunRecord => ({ summary: summary(status), agents: {}, transcript: [], logs: [] })
const emptyCards = (): PendingCards => ({ permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] })
const selected = { id: 'new', label: 'New', connection: 'anthropic', adapter: 'claude' } as ProviderModel
function fixture(status: RunSummary['status'] = 'idle') {
  let current = record(status)
  const api = {
    read: vi.fn(async () => current), cards: vi.fn(async () => emptyCards()), live: vi.fn(async (): Promise<RunSummary[]> => []),
    interrupt: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    switch: vi.fn(async () => ({ run: current.summary, applied: true }))
  }
  const input = { run: current.summary, selected, handoff: false, api, confirm: vi.fn(async () => true), valid: () => true, pause: vi.fn(async () => {}), stopped: vi.fn() }
  return { api, input, set: (next: RunRecord) => { current = next } }
}

describe('model switch sequencing', () => {
  it('keeps identical ids on different connections and searches friendly names, ids and connection names', () => {
    const models = [{ ...selected, id: 'same', label: 'Friendly' }, { ...selected, id: 'same', label: 'Friendly', connection: 'openai' }, { ...selected, id: 'same', label: 'Duplicate' }] as ProviderModel[]
    expect(filterLiveModels(models, '', (id) => id)).toHaveLength(2)
    expect(filterLiveModels(models, 'friendly', (id) => id)).toHaveLength(2)
    expect(filterLiveModels(models, 'openai', (id) => id)).toHaveLength(1)
    expect(modelKey('openai', 'same')).not.toBe(modelKey('anthropic', 'same'))
  })
  it('requires handoff for cross connection and same connection cross adapter', () => {
    expect(needsModelHandoff(summary(), { ...selected, adapter: 'codex' })).toBe(true)
    expect(needsModelHandoff(summary(), { ...selected, connection: 'openai' })).toBe(true)
    expect(needsModelHandoff({ ...summary(), modelAdapter: 'mock' }, { ...selected, adapter: 'codex' })).toBe(false)
  })
  it('waits reliably for delayed idle and interrupts only once before switching', async () => {
    const f = fixture('running')
    let waits = 0
    f.input.pause.mockImplementation(async () => { if (++waits === 3) f.set(record('idle')) })
    await performModelSwitch(f.input)
    expect(waits).toBe(3)
    expect(f.api.interrupt).toHaveBeenCalledTimes(1)
    expect(f.api.switch).toHaveBeenCalledTimes(1)
    expect(f.api.stop).not.toHaveBeenCalled()
  })
  it('blocks cards and active reports before interrupt or stop; terminal error reports are safe', async () => {
    const f = fixture('running')
    f.api.cards.mockResolvedValue({ ...emptyCards(), permissions: [{}] } as PendingCards)
    await expect(performModelSwitch(f.input)).rejects.toThrow('open decisions')
    expect(f.api.interrupt).not.toHaveBeenCalled()
    const r = record()
    r.agents.report = { parentId: 'root', state: 'thinking' } as RunRecord['agents'][string]
    expect(modelSwitchBlock(r, emptyCards())).toContain('active reports')
    r.agents.report.state = 'error'
    expect(modelSwitchBlock(r, emptyCards())).toBeNull()
    f.api.cards.mockResolvedValue(emptyCards())
    f.set({ ...r, summary: summary('running'), agents: { report: { ...r.agents.report, state: 'thinking' } } })
    f.input.handoff = true
    await expect(performModelSwitch(f.input)).rejects.toThrow('active reports')
    expect(f.api.stop).not.toHaveBeenCalled()
  })
  it('times out without mutating again', async () => {
    const read = vi.fn(async () => record('running'))
    await expect(waitForModelBoundary(read, false, async () => {}, 3)).rejects.toThrow('safe boundary')
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('does not stop or switch when confirmation is cancelled', async () => {
    const f = fixture()
    f.input.handoff = true
    f.input.confirm.mockResolvedValue(false)
    expect(await performModelSwitch(f.input)).toBeNull()
    expect(f.api.stop).not.toHaveBeenCalled()
    expect(f.api.switch).not.toHaveBeenCalled()
  })
  it('recovers after stop succeeded and apply failed without stopping again', async () => {
    const f = fixture()
    f.input.handoff = true
    f.api.stop.mockImplementation(async () => { f.set(record('finished')) })
    f.api.switch.mockRejectedValueOnce(new Error('catalog changed'))
    await expect(performModelSwitch(f.input)).rejects.toThrow('catalog changed')
    expect(f.input.stopped).toHaveBeenCalledTimes(1)
    f.input.run = summary('finished')
    await performModelSwitch(f.input)
    expect(f.api.stop).toHaveBeenCalledTimes(1)
    expect(f.api.switch).toHaveBeenCalledTimes(2)
  })
  it('refuses newly running work, changed drafts sent elsewhere and successor sessions', async () => {
    const f = fixture()
    f.set(record('running'))
    await expect(performModelSwitch(f.input)).rejects.toThrow('state changed')
    expect(f.api.interrupt).not.toHaveBeenCalled()
    f.set(record())
    f.input.handoff = true
    f.input.confirm.mockImplementation(async () => { const r = record(); r.transcript = [{ id: 'new', at: 1, agentId: 'root', block: { kind: 'user', text: 'new work' } }]; f.set(r); return true })
    await expect(performModelSwitch(f.input)).rejects.toThrow('changed elsewhere')
    expect(f.api.stop).not.toHaveBeenCalled()
    f.api.live.mockResolvedValue([{ ...summary(), id: 'successor', resumedFrom: 'run' }])
    await expect(performModelSwitch(f.input)).rejects.toThrow('latest session')
  })
  it('cancels dismissed or navigated operations before subsequent mutation', async () => {
    const f = fixture('running')
    let valid = true
    f.input.valid = () => valid
    f.api.interrupt.mockImplementation(async () => { f.set(record('idle')); valid = false })
    await expect(performModelSwitch(f.input)).rejects.toThrow('cancelled')
    expect(f.api.switch).not.toHaveBeenCalled()
    expect(f.api.stop).not.toHaveBeenCalled()
  })
})
