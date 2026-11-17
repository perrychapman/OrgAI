/**
 * Schedules on a booted host with the mock adapter (no tokens): the dispatcher's surface rules and the real start
 * paths (RunManager.start for a team target, QuickRunService.start for an ask target).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEDULES_IPC } from '@shared/types'
import type { RunSummary, Schedule, ScheduleHistoryEntry, SchedulesChangedEvent } from '@shared/types'
import { bootOrgAIHost, type OrgAIHost } from '../host/bootstrap'

let root: string
let dataDir: string
let host: OrgAIHost | undefined
const pushes: SchedulesChangedEvent[] = []

function boot(): OrgAIHost {
  host = bootOrgAIHost({
    env: { userDataDir: root, logsDir: join(root, 'logs'), appVersion: '9.9.9-test', isPackaged: false },
    dataDir,
    hostKind: 'desktop',
    ownership: { info: { hostInstanceId: 'abcdef012345', pid: 1, endpoint: '/tmp/x.sock', state: 'starting', startedAt: 1, hostKind: 'desktop' }, markReady: () => true, markDraining: () => true, release: () => {} },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    openExternal: () => {},
    desktop: { openRunWindow: () => {}, schedulesChanged: (e) => pushes.push(e) },
    mock: true,
    startBackground: false,
    housekeeping: { sweepStaleSkillDirs: () => {} },
    processEnv: {},
    homeDir: join(root, 'home')
  })
  return host
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-sched-boot-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  pushes.length = 0
})

afterEach(async () => {
  if (host) {
    await host.runs.stopAll({ reason: 'quit' }).catch(() => {})
    host.dispose()
  }
  host = undefined
  rmSync(root, { recursive: true, force: true })
})

const desktop = { surface: 'desktop' as const }

describe('schedules on a booted mock host', () => {
  it('a team schedule starts through RunManager with the schedule, mode and budget on the run', async () => {
    const h = boot()
    const folder = join(root, 'repo')
    mkdirSync(folder)
    const project = h.services.projects.create({ name: 'Mock', path: folder, brief: '', setupKind: 'existing', mock: true }, h.settings.get(), { mockAvailable: true })
    const saved = (await h.dispatcher.invoke(SCHEDULES_IPC.schedulesSave, [{ name: 'Nightly', prompt: 'hello', target: { kind: 'team', projectId: project.id }, timing: { kind: 'daily', time: '00:00' }, permissionMode: 'plan', budgetUsd: 2 }], desktop)) as Schedule
    expect(pushes.at(-1)).toEqual({ scheduleIds: [saved.id] })
    const entry = (await h.dispatcher.invoke(SCHEDULES_IPC.schedulesRunNow, [saved.id], desktop)) as ScheduleHistoryEntry
    expect(entry).toMatchObject({ result: 'started', trigger: 'manual', projectId: project.id })
    const run = h.runs.summary(entry.runId!) as RunSummary
    expect(run).toMatchObject({ scheduleId: saved.id, scheduleName: 'Nightly', permissionMode: 'plan', conversationBudgetUsd: 2, prompt: 'hello' })
    const list = (await h.dispatcher.invoke(SCHEDULES_IPC.schedulesList, [], desktop)) as Schedule[]
    expect(list[0].lastEntry).toMatchObject({ result: 'started', runId: run.id })
    // The overlap rule on the real run: it is still live, so the next fire is skipped.
    const again = (await h.dispatcher.invoke(SCHEDULES_IPC.schedulesRunNow, [saved.id], desktop)) as ScheduleHistoryEntry
    expect(again.reason).toBe('previous-running')
  })

  it('review L3 / L4: a scheduled run records min(schedule cap, project cap) as its conversation budget, also with no schedule cap', async () => {
    const h = boot()
    const folder = join(root, 'repo')
    mkdirSync(folder)
    const created = h.services.projects.create({ name: 'Mock', path: folder, brief: '', setupKind: 'existing', mock: true }, h.settings.get(), { mockAvailable: true })
    const project = h.services.projects.update(created.id, (p) => ({ ...p, maxBudgetUsd: 5 }))
    const timing = { kind: 'daily' as const, time: '00:00' }
    const noCap = h.services.schedules!.save({ name: 'No cap', prompt: 'hello', target: { kind: 'team', projectId: project.id }, timing })
    const high = h.services.schedules!.save({ name: 'High cap', prompt: 'hello', target: { kind: 'team', projectId: project.id }, timing, budgetUsd: 8 })
    const a = await h.services.schedules!.runNow(noCap.id)
    const b = await h.services.schedules!.runNow(high.id)
    expect(h.runs.summary(a.runId!)).toMatchObject({ conversationBudgetUsd: 5 })
    expect(h.runs.summary(b.runId!)).toMatchObject({ conversationBudgetUsd: 5 })
  })

  it('review recheck H-new: a mock run that ends its turn records finished and resets the failure count', async () => {
    const h = boot()
    // A Chat (ask) run: the mock answers in one turn without a card (the mock team demo raises cards).
    const saved = h.services.schedules!.save({ name: 'Ask', prompt: 'hello', target: { kind: 'ask' }, timing: { kind: 'interval', everyMinutes: 60 } })
    ;(h.services.schedules as unknown as { deps: { store: { update(fn: (d: { schedules: { consecutiveFailures: number }[] }) => void): void } } }).deps.store.update((d) => {
      d.schedules[0].consecutiveFailures = 2
    })
    const entry = await h.services.schedules!.runNow(saved.id)
    expect(entry.result).toBe('started')
    await vi.waitFor(() => expect(h.services.schedules!.get(saved.id)?.lastEntry?.outcome).toBe('finished'), { timeout: 20_000, interval: 200 })
    expect(h.services.schedules!.get(saved.id)?.consecutiveFailures).toBe(0)
    expect(h.runs.summary(entry.runId!)?.status).toBe('idle')
  }, 30_000)

  it('review L8: only the desktop host wires the schedule harness hooks', () => {
    const hooks = (x: OrgAIHost): unknown => (x.runs as unknown as { options: { schedules?: unknown } }).options.schedules
    expect(hooks(boot())).toBeDefined()
    host!.dispose()
    host = bootOrgAIHost({
      env: { userDataDir: root, logsDir: join(root, 'logs'), appVersion: '9.9.9-test', isPackaged: false },
      dataDir: join(root, 'data2'),
      hostKind: 'desktop',
      ownership: { info: { hostInstanceId: 'abcdef012346', pid: 1, endpoint: '/tmp/y.sock', state: 'starting', startedAt: 1, hostKind: 'desktop' }, markReady: () => true, markDraining: () => true, release: () => {} },
      safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
      openExternal: () => {},
      mock: true,
      startBackground: false,
      housekeeping: { sweepStaleSkillDirs: () => {} },
      processEnv: {},
      homeDir: join(root, 'home')
    })
    expect(hooks(host)).toBeUndefined()
  })

  it('an ask schedule starts a Chat run marked with the schedule', async () => {
    const h = boot()
    const saved = h.services.schedules!.save({ name: 'Ask', prompt: 'hi there', target: { kind: 'ask' }, timing: { kind: 'interval', everyMinutes: 60 } })
    const entry = await h.services.schedules!.runNow(saved.id)
    expect(entry.result).toBe('started')
    const run = h.runs.summary(entry.runId!) as RunSummary
    expect(run.quick).toBeDefined()
    expect(run).toMatchObject({ scheduleId: saved.id, scheduleName: 'Ask' })
  })

  it('a refused start choice (a mode a Chat run cannot take) records a failed start, not a run', async () => {
    const h = boot()
    const saved = h.services.schedules!.save({ name: 'Ask', prompt: 'hi', target: { kind: 'ask' }, timing: { kind: 'interval', everyMinutes: 60 }, modelSelection: { model: 'no-such-model', connection: 'anthropic' } })
    const entry = await h.services.schedules!.runNow(saved.id)
    expect(entry).toMatchObject({ result: 'failed', reason: 'start-refused' })
    expect(entry.runId).toBeUndefined()
  })

  it('only the desktop may save, remove, enable or run; list and history are readable everywhere', async () => {
    const h = boot()
    const saved = h.services.schedules!.save({ name: 'Ask', prompt: 'hi', target: { kind: 'ask' }, timing: { kind: 'interval', everyMinutes: 60 } })
    const all = ['read', 'operate', 'decide', 'configure'] as const
    for (const surface of ['socket', 'inproc'] as const) {
      const ctx = { surface, grantedScopes: [...all] }
      await expect(h.dispatcher.invokeRpc(SCHEDULES_IPC.schedulesSave, [{ name: 'x', prompt: 'y', target: { kind: 'ask' }, timing: { kind: 'interval', everyMinutes: 60 } }], ctx)).rejects.toMatchObject({ code: 'scope_denied' })
      await expect(h.dispatcher.invokeRpc(SCHEDULES_IPC.schedulesRemove, [saved.id], ctx)).rejects.toMatchObject({ code: 'scope_denied' })
      await expect(h.dispatcher.invokeRpc(SCHEDULES_IPC.schedulesSetEnabled, [{ id: saved.id, enabled: false }], ctx)).rejects.toMatchObject({ code: 'scope_denied' })
      await expect(h.dispatcher.invokeRpc(SCHEDULES_IPC.schedulesRunNow, [saved.id], ctx)).rejects.toMatchObject({ code: 'scope_denied' })
      const listed = (await h.dispatcher.invokeRpc(SCHEDULES_IPC.schedulesList, [], { surface, grantedScopes: ['read'] })) as Schedule[]
      expect(listed.map((s) => s.id)).toEqual([saved.id])
      expect(await h.dispatcher.invokeRpc(SCHEDULES_IPC.schedulesHistory, [saved.id], { surface, grantedScopes: ['read'] })).toEqual([])
    }
    expect(h.services.schedules!.list()).toHaveLength(1)
    expect(h.runs.list('quick')).toHaveLength(0)
  })
})
