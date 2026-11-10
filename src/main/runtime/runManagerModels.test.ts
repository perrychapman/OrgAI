import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProviderModel, RunEvent } from '@shared/types'
import { RunManager, type RunManagerOptions } from './runManager'
import type { RuntimeAdapter } from './types'
import { RunStore } from '../store/runs'
import type { SetupService } from '../setup/service'
import { project as makeProject, role } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

/** The run-start models line (cli-parity 3.1, runModels.ts) as RunManager emits it. */

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-rmm-'))
  mkdirSync(join(dir, 'repo'))
  events = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const adapter: RuntimeAdapter = {
  id: 'claude',
  complete: async () => '',
  start: async (ctx) => {
    ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running' })
    return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
  }
}

const entry = (id: string, source: ProviderModel['source'] = 'discovered'): ProviderModel => ({ id, label: id, connection: 'anthropic', family: 'claude', adapter: 'claude', source })

function claudeProject(): Project {
  return makeProject({
    path: join(dir, 'repo'),
    provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection: 'anthropic' },
    roles: [
      role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng'], model: 'claude-opus-4-1-20250805', tier: 'deep' }),
      role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', reportsTo: 'r-lead', model: 'claude-sonnet-5-5', tier: 'everyday' })
    ]
  })
}

function manager(options: RunManagerOptions, adapters: ConstructorParameters<typeof RunManager>[0] = { claude: adapter }): RunManager {
  return new RunManager(adapters, (e) => void events.push(e), new RunStore(join(dir, 'data')), {} as SetupService, () => 100, options)
}

const logs = (runId: string) => events.filter((e): e is Extract<RunEvent, { type: 'log' }> => e.type === 'log' && e.runId === runId)

describe('RunManager run-start models line', () => {
  it('logs the Models line and one warning for a stale tier, with the remedy', async () => {
    const m = manager({ catalog: () => [entry('claude-opus-4-1-20250805'), entry('claude-opus-5-5'), entry('claude-sonnet-5-5')], modelsError: () => undefined })
    const run = await m.start({ project: claudeProject(), prompt: 'go' })
    const lines = logs(run.id)
    expect(lines.find((l) => l.level === 'info' && l.message.startsWith('Models: '))?.message).toBe('Models: deep = claude-opus-4-1-20250805, everyday = claude-sonnet-5-5 (Anthropic)')
    const warn = lines.filter((l) => l.level === 'warn' && l.message.startsWith('Model check: '))
    expect(warn).toHaveLength(1)
    expect(warn[0]!.message).toContain('deep = claude-opus-4-1-20250805 is not the newest of its family on Anthropic (claude-opus-5-5 is listed)')
    expect(warn[0]!.message).toContain('orgai models refresh')
    expect(warn[0]!.message).toContain('orgai connections tier anthropic')
    await m.stopAll()
  })

  it('warns on a failed discovery and stays quiet when everything is current', async () => {
    const m = manager({ catalog: () => [entry('claude-opus-4-1-20250805'), entry('claude-sonnet-5-5')], modelsError: () => 'HTTP 503' })
    const run = await m.start({ project: claudeProject(), prompt: 'go' })
    expect(logs(run.id).find((l) => l.level === 'warn')?.message).toContain('model discovery last failed on Anthropic (HTTP 503)')
    await m.stopAll()
    events = []
    const quiet = manager({ catalog: () => [entry('claude-opus-4-1-20250805'), entry('claude-sonnet-5-5')] })
    const run2 = await quiet.start({ project: claudeProject(), prompt: 'go' })
    expect(logs(run2.id).some((l) => l.message.startsWith('Models: '))).toBe(true)
    expect(logs(run2.id).some((l) => l.message.startsWith('Model check: '))).toBe(false)
    await quiet.stopAll()
  })

  it('never throws into run start when the catalog read fails', async () => {
    let calls = 0
    // The first catalog reads (adapter choice) succeed; the models line's read throws and is swallowed.
    const m = manager({
      catalog: () => {
        if (++calls > 1) throw new Error('boom')
        return []
      }
    })
    const run = await m.start({ project: claudeProject(), prompt: 'go' })
    expect(logs(run.id).some((l) => l.message.startsWith('Models: '))).toBe(false)
    await m.stopAll()
  })
})
