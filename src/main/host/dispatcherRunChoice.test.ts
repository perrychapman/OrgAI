import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/types'
import type { HostScope, Project, RunSummary } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

// The dispatcher must load and run without Electron (cli-spec 3.1.1).
vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host dispatcher')
})
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '/logs/main.log', logsDir: () => '/logs' }))

const { HostDispatcher, isMutatingChannel } = await import('./dispatcher')
const { HostRpcFailure } = await import('./registry')
const { project: makeProject } = await import('../runtime/testHelpers')
type HostServices = import('./types').HostServices
type RpcInvokeContext = import('./types').RpcInvokeContext
type InvokeContext = import('./types').InvokeContext

const DESKTOP: InvokeContext = { surface: 'desktop', senderId: 1 }
const rpc = (scopes: HostScope[], surface: 'socket' | 'inproc' = 'socket'): RpcInvokeContext => ({ surface, grantedScopes: scopes })
const ALL: HostScope[] = ['read', 'operate', 'decide', 'configure']

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-dispatcher-choice-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const stored = [makeProject({ id: 'proj_a' })]
  const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: dir, set: vi.fn() }
  const summary: RunSummary = { id: 'run_1', projectId: 'proj_a', kind: 'work', prompt: 'p', status: 'finished', startedAt: 1, totalCostUsd: 0 }
  const runs = {
    summary: vi.fn((id: string) => (id === 'run_1' ? summary : undefined)),
    start: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'run_new' }) as RunSummary),
    continueRun: vi.fn(async (..._args: unknown[]) => ({ id: 'run_next' }) as RunSummary),
    resumeNow: vi.fn(async (..._args: unknown[]) => ({ id: 'run_1' }) as RunSummary),
    setPermissionMode: vi.fn(async (_input: unknown) => ({ run: summary, applied: true }))
  }
  const services: HostServices = {
    projects: { get: (id: string) => stored.find((p: Project) => p.id === id) ?? null, list: () => stored } as never,
    runs: runs as never,
    setup: {} as never,
    maintenance: {} as never,
    settings: settings as never,
    connections: { effectiveSettings: () => settings.get(), effectiveDefault: () => 'anthropic' } as never,
    mcp: {} as never,
    adapterIds: ['mock'],
    harnessProject: () => makeProject({ id: 'harness', roles: [] }),
    importer: {} as never,
    skills: {} as never,
    skillEvaluation: {} as never,
    capabilities: {} as never,
    quick: {} as never,
    templates: { list: () => [] } as never
  }
  return { d: new HostDispatcher(services), runs }
}

async function failure(p: Promise<unknown>): Promise<InstanceType<typeof HostRpcFailure>> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(HostRpcFailure)
    return e as InstanceType<typeof HostRpcFailure>
  }
  throw new Error('expected a HostRpcFailure')
}

const CHOICE = { modelSelection: { model: 'claude-opus', connection: 'anthropic' }, effort: 'high', permissionMode: 'plan' }

describe('runs:start per-run root choices', () => {
  it('the desktop passes userChoice with all three fields', async () => {
    const { d, runs } = setup()
    await d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', ...CHOICE }], DESKTOP)
    expect(runs.start.mock.calls[0][0]).toMatchObject({ userChoice: CHOICE })
  })

  it('the desktop passes only the keys present', async () => {
    const { d, runs } = setup()
    await d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', effort: 'low' }], DESKTOP)
    await d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', permissionMode: 'dontAsk', modelSelection: null }], DESKTOP)
    expect(runs.start.mock.calls[0][0].userChoice).toEqual({ effort: 'low' })
    expect(runs.start.mock.calls[1][0].userChoice).toEqual({ permissionMode: 'dontAsk' })
  })

  it('the desktop without the fields sends no userChoice key', async () => {
    const { d, runs } = setup()
    await d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go' }], DESKTOP)
    expect(runs.start.mock.calls[0][0]).not.toHaveProperty('userChoice')
  })

  it('a desktop start with a bad value is bad_request and starts nothing', async () => {
    const { d, runs } = setup()
    await expect(d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', effort: 'extreme' }], DESKTOP)).rejects.toMatchObject({ code: 'bad_request' })
    expect(runs.start).not.toHaveBeenCalled()
  })

  it('a socket client with any of the fields is refused, naming them', async () => {
    const { d, runs } = setup()
    const err = await failure(d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', ...CHOICE }], rpc(ALL, 'socket')))
    expect(err.code).toBe('bad_request')
    expect(err.message).toBe('These run options are available in the desktop app and the terminal UI only: modelSelection, effort, permissionMode.')
    const one = await failure(d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', permissionMode: 'plan' }], rpc(ALL, 'socket')))
    expect(one.message).toBe('These run options are available in the desktop app and the terminal UI only: permissionMode.')
    expect(runs.start).not.toHaveBeenCalled()
  })

  it('an in-process client without configure may not choose them (they can raise spend or widen the run)', async () => {
    const { d, runs } = setup()
    await expect(d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', effort: 'high' }], rpc(['read', 'operate'], 'inproc'))).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', permissionMode: 'bypassPermissions' }], rpc(['read', 'operate'], 'inproc'))).rejects.toMatchObject({ code: 'scope_denied' })
    expect(runs.start).not.toHaveBeenCalled()
  })

  it('the in-process client (terminal UI, exec) may choose them: they reach RunManager as userChoice', async () => {
    const { d, runs } = setup()
    await d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', ...CHOICE }], rpc(ALL, 'inproc'))
    expect(runs.start.mock.calls[0][0]).toMatchObject({ userChoice: CHOICE })
    await expect(d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', effort: 'extreme' }], rpc(ALL, 'inproc'))).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('a socket client without the fields is unchanged (no userChoice, overrides rules as before)', async () => {
    const { d, runs } = setup()
    await d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides: { permissionMode: 'default' } }], rpc(['read', 'operate']))
    const arg = runs.start.mock.calls[0][0]
    expect(arg).not.toHaveProperty('userChoice')
    expect(arg).toMatchObject({ overrides: { permissionMode: 'default' }, allowWidening: false })
    await d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', modelSelection: null, effort: null, permissionMode: null }], rpc(['read', 'operate'], 'inproc'))
    expect(runs.start.mock.calls[1][0]).not.toHaveProperty('userChoice')
  })
})

describe('runs:continue and runs:resumeNow desktop flag', () => {
  it('continue passes { desktop: true } on the desktop only', async () => {
    const { d, runs } = setup()
    await d.invoke(IPC.runsContinue, [{ runId: 'run_1', text: 'more' }], DESKTOP)
    expect(runs.continueRun.mock.calls[0][4]).toEqual({ desktop: true })
    await d.invokeRpc(IPC.runsContinue, [{ runId: 'run_1', text: 'more' }], rpc(['read', 'operate']))
    await d.invokeRpc(IPC.runsContinue, [{ runId: 'run_1', text: 'more', exec: true }], rpc(['read', 'operate', 'configure'], 'inproc'))
    expect(runs.continueRun.mock.calls[1]).toHaveLength(4)
    expect(runs.continueRun.mock.calls[2][4]).not.toHaveProperty('desktop')
  })

  it('a plain in-process continue carries a chosen permission mode only with configure, never with allowWidening', async () => {
    const { d, runs } = setup()
    await d.invokeRpc(IPC.runsContinue, [{ runId: 'run_1', text: 'more' }], rpc(['read', 'operate', 'configure'], 'inproc'))
    // The desktop-equivalent flag trusts only the permissionModeChosen carry; stored overrides re-clamp to the project.
    expect(runs.continueRun.mock.calls[0][4]).toEqual({ desktop: true })
    expect(runs.continueRun.mock.calls[0][4]).not.toHaveProperty('allowWidening')
    await d.invokeRpc(IPC.runsContinue, [{ runId: 'run_1', text: 'more' }], rpc(['read', 'operate'], 'inproc'))
    expect(runs.continueRun.mock.calls[1]).toHaveLength(4)
  })

  it('resumeNow passes { desktop: true } on the desktop only', async () => {
    const { d, runs } = setup()
    await d.invoke(IPC.runsResumeNow, ['run_1'], DESKTOP)
    expect(runs.resumeNow).toHaveBeenLastCalledWith('run_1', { desktop: true })
    await d.invokeRpc(IPC.runsResumeNow, ['run_1'], rpc(['read', 'operate']))
    expect(runs.resumeNow).toHaveBeenLastCalledWith('run_1')
    await d.invokeRpc(IPC.runsResumeNow, ['run_1'], rpc(['read', 'operate'], 'inproc'))
    expect(runs.resumeNow).toHaveBeenLastCalledWith('run_1')
  })
})

describe('runs:setPermissionMode', () => {
  it('is a mutating channel', () => {
    expect(isMutatingChannel(IPC.runsSetPermissionMode)).toBe(true)
  })

  it('the desktop delegates the rebuilt input and returns the result', async () => {
    const { d, runs } = setup()
    const out = await d.invoke(IPC.runsSetPermissionMode, [{ runId: 'run_1', mode: 'plan', extra: 1 }], DESKTOP)
    expect(runs.setPermissionMode).toHaveBeenCalledWith({ runId: 'run_1', mode: 'plan' })
    expect(out).toMatchObject({ applied: true })
  })

  it('the desktop with a bad mode is bad_request and changes nothing', async () => {
    const { d, runs } = setup()
    await expect(Promise.resolve().then(() => d.invoke(IPC.runsSetPermissionMode, [{ runId: 'run_1', mode: 'yolo' }], DESKTOP))).rejects.toMatchObject({ code: 'bad_request' })
    expect(runs.setPermissionMode).not.toHaveBeenCalled()
  })

  it("a socket client holding every scope is refused with the handler's scope_denied", async () => {
    const { d, runs } = setup()
    const err = await failure(d.invokeRpc(IPC.runsSetPermissionMode, [{ runId: 'run_1', mode: 'plan' }], rpc(ALL, 'socket')))
    expect(err.code).toBe('scope_denied')
    expect(err.message).toBe("Changing a run's permission mode is available in the desktop app and the terminal UI only.")
    expect(runs.setPermissionMode).not.toHaveBeenCalled()
  })

  it('the in-process client holding configure changes the mode; without configure the gate refuses it', async () => {
    const { d, runs } = setup()
    await d.invokeRpc(IPC.runsSetPermissionMode, [{ runId: 'run_1', mode: 'plan', extra: 1 }], rpc(ALL, 'inproc'))
    expect(runs.setPermissionMode).toHaveBeenCalledWith({ runId: 'run_1', mode: 'plan' })
    const err = await failure(d.invokeRpc(IPC.runsSetPermissionMode, [{ runId: 'run_1', mode: 'plan' }], rpc(['read', 'operate'], 'inproc')))
    expect(err.code).toBe('scope_denied')
  })

  it('the handler refuses before parsing: a malformed input from a socket client is still scope_denied', async () => {
    const { d } = setup()
    const err = await failure(d.invokeRpc(IPC.runsSetPermissionMode, [{ runId: 5, mode: 'yolo' }], rpc(ALL)))
    expect(err.code).toBe('scope_denied')
    expect(err.message).toBe("Changing a run's permission mode is available in the desktop app and the terminal UI only.")
  })

  it("a client without the 'configure' scope is refused at the gate", async () => {
    const { d, runs } = setup()
    const err = await failure(d.invokeRpc(IPC.runsSetPermissionMode, [{ runId: 'run_1', mode: 'plan' }], rpc(['read', 'operate'])))
    expect(err.code).toBe('scope_denied')
    expect(err.message).toContain("needs the 'configure' scope")
    expect(runs.setPermissionMode).not.toHaveBeenCalled()
  })
})
