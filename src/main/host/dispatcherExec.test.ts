import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_IPC, IPC } from '@shared/types'
import type { DecisionOutcome, HostScope, Project, RunSummary } from '@shared/types'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'

// The dispatcher must load and run without Electron (cli-spec 3.1.1).
vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host dispatcher')
})
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '/logs/main.log', logsDir: () => '/logs' }))

const { HostDispatcher } = await import('./dispatcher')
const { HostRpcFailure } = await import('./registry')
const { project: makeProject } = await import('../runtime/testHelpers')
type HostServices = import('./types').HostServices
type RpcInvokeContext = import('./types').RpcInvokeContext
type InvokeContext = import('./types').InvokeContext

const DESKTOP: InvokeContext = { surface: 'desktop', senderId: 1 }
const rpc = (scopes: HostScope[], over: Partial<RpcInvokeContext> = {}): RpcInvokeContext => ({ surface: 'socket', grantedScopes: scopes, ...over })
const OPERATE = rpc(['read', 'operate'])
const CONFIGURE = rpc(['read', 'operate', 'configure'])

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-dispatcher-exec-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const outcome = (requestId: string): DecisionOutcome => ({ status: 'applied', runId: 'run_1', requestId, effectiveDecision: 'x' })

function setup(stored: Project[] = [makeProject({ id: 'proj_a', permissionMode: 'acceptEdits', autoContinue: false, maxBudgetUsd: 2 })]) {
  const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: dir, set: vi.fn() }
  const summary: RunSummary = { id: 'run_1', projectId: 'proj_a', kind: 'work', prompt: 'p', status: 'finished', startedAt: 1, totalCostUsd: 0 }
  const runs = {
    list: vi.fn(() => [] as RunSummary[]),
    summary: vi.fn((id: string) => (id === 'run_1' ? summary : undefined)),
    start: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'run_new' }) as RunSummary),
    continueRun: vi.fn(async (..._args: unknown[]) => ({ id: 'run_next' }) as RunSummary),
    send: vi.fn(),
    decide: vi.fn((_r: string, id: string, _d?: unknown, _o?: unknown) => outcome(id)),
    decideRules: vi.fn((_r: string, id: string, _d?: unknown, _o?: unknown) => outcome(id)),
    decideProposal: vi.fn((_r: string, id: string, _d?: unknown, _o?: unknown) => outcome(id)),
    answerQuestion: vi.fn((_r: string, id: string, _d?: unknown, _o?: unknown) => outcome(id)),
    decideMerge: vi.fn((_r: string, id: string, _d?: unknown, _o?: unknown) => outcome(id)),
    answerMcpInstall: vi.fn((_r: string, id: string, _d?: unknown, _o?: unknown) => outcome(id)),
    findDecision: vi.fn((id: string) => ({ status: 'pending', requestId: id, runId: 'run_1', projectId: 'proj_a', kind: 'permission', revision: 3 }))
  }
  const quickProject = makeProject({ id: 'quick', permissionMode: 'default' })
  const quick = {
    displayProject: () => makeProject({ id: 'quick', roles: [] }),
    // Like QuickRunService.start: the check sees the quick project, its answer becomes allowWidening.
    start: vi.fn(async (input: { overrides?: unknown }, opts?: { checkOverrides?: (p: Project) => boolean }) => {
      const allowWidening = input.overrides ? (opts?.checkOverrides?.(quickProject) ?? false) : false
      return { id: 'run_quick', allowWidening } as unknown as RunSummary
    })
  }
  const services: HostServices = {
    projects: { get: (id: string) => stored.find((p) => p.id === id) ?? null, list: () => stored } as never,
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
    quick: quick as never,
    templates: { list: () => [] } as never
  }
  return { d: new HostDispatcher(services), runs, quick }
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

describe('runs:start overrides (cli-spec 2 item 2, 6.2(1))', () => {
  it('the desktop surface keeps only a valid goal and drops every other override', async () => {
    const { d, runs } = setup()
    const wide = { permissionMode: 'bypassPermissions', maxBudgetUsd: 1000, strictDelegation: true, execMode: true, autoContinue: true }
    await d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides: { ...wide, goal: 'cost' } }], DESKTOP)
    expect(runs.start).toHaveBeenCalledWith(expect.objectContaining({ overrides: { goal: 'cost' }, allowWidening: false }))
    await d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides: wide }], DESKTOP)
    expect(runs.start.mock.calls[1][0]).not.toHaveProperty('overrides')
    await expect(d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides: { goal: 'fastest' } }], DESKTOP)).rejects.toMatchObject({ code: 'bad_request' })
    expect(runs.start).toHaveBeenCalledTimes(2)
  })

  it('the desktop surface drops overrides without a goal (the renderer never sets them)', async () => {
    const { d, runs } = setup()
    await d.invoke(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides: { permissionMode: 'bypassPermissions' } }], DESKTOP)
    const arg = runs.start.mock.calls[0][0] as Record<string, unknown>
    expect(arg).not.toHaveProperty('overrides')
    expect(arg).not.toHaveProperty('allowWidening')
  })

  it("a socket 'operate' client gets narrowing overrides passed with allowWidening false", async () => {
    const { d, runs } = setup()
    const overrides = { permissionMode: 'default', autoContinue: false, maxBudgetUsd: 1, execMode: true }
    await d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides }], OPERATE)
    expect(runs.start).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'go', overrides, allowWidening: false }))
  })

  it("widening without 'configure' is scope_denied naming the fields; with 'configure' it passes with allowWidening true", async () => {
    const { d, runs } = setup()
    const overrides = { permissionMode: 'bypassPermissions', autoContinue: true, maxBudgetUsd: 5 }
    const err = await failure(d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides }], OPERATE))
    expect(err.code).toBe('scope_denied')
    expect(err.message).toBe('These run options need the configure scope: permissionMode, autoContinue, maxBudgetUsd.')
    expect(runs.start).not.toHaveBeenCalled()
    await d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides }], CONFIGURE)
    expect(runs.start).toHaveBeenCalledWith(expect.objectContaining({ overrides, allowWidening: true }))
  })

  it('allowPeerMessages needs configure', async () => {
    const { d, runs } = setup()
    const err = await failure(d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides: { allowPeerMessages: true } }], OPERATE))
    expect(err.code).toBe('scope_denied')
    expect(err.message).toContain('allowPeerMessages')
    await d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides: { allowPeerMessages: false } }], OPERATE)
    expect(runs.start).toHaveBeenCalledTimes(1)
  })

  it('bad overrides are bad_request over RPC', async () => {
    const { d, runs } = setup()
    const err = await failure(d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go', overrides: { permissionMode: 'yolo' } }], CONFIGURE))
    expect(err.code).toBe('bad_request')
    expect(runs.start).not.toHaveBeenCalled()
  })

  it('without overrides the call shape is unchanged', async () => {
    const { d, runs } = setup()
    await d.invokeRpc(IPC.runsStart, [{ projectId: 'proj_a', prompt: 'go' }], CONFIGURE)
    expect(runs.start.mock.calls[0][0]).not.toHaveProperty('allowWidening')
  })
})

describe('runs:continue overrides and exec', () => {
  it('passes overrides, exec and allowWidening as the options', async () => {
    const { d, runs } = setup()
    await d.invokeRpc(IPC.runsContinue, [{ runId: 'run_1', text: 'more', exec: true, overrides: { maxBudgetUsd: 1 } }], OPERATE)
    expect(runs.continueRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'proj_a' }), 'run_1', 'more', undefined, {
      overrides: { maxBudgetUsd: 1 },
      exec: true,
      allowWidening: false
    })
  })

  it('exec alone passes with the caller scope', async () => {
    const { d, runs } = setup()
    await d.invokeRpc(IPC.runsContinue, [{ runId: 'run_1', text: 'more', exec: true }], CONFIGURE)
    expect(runs.continueRun.mock.calls[0][4]).toEqual({ exec: true, allowWidening: true })
  })

  it('checks widening against the project the run continues as', async () => {
    const { d, runs } = setup()
    const err = await failure(d.invokeRpc(IPC.runsContinue, [{ runId: 'run_1', text: 'more', overrides: { maxBudgetUsd: 3 } }], OPERATE))
    expect(err.code).toBe('scope_denied')
    expect(err.message).toContain('maxBudgetUsd')
    expect(runs.continueRun).not.toHaveBeenCalled()
  })

  it('the desktop drops overrides and exec and passes only { desktop: true }; a plain RPC continue keeps four arguments', async () => {
    const { d, runs } = setup()
    await d.invoke(IPC.runsContinue, [{ runId: 'run_1', text: 'more', exec: true, overrides: { permissionMode: 'bypassPermissions' } }], DESKTOP)
    await d.invokeRpc(IPC.runsContinue, [{ runId: 'run_1', text: 'more' }], OPERATE)
    expect(runs.continueRun.mock.calls[0]).toHaveLength(5)
    expect(runs.continueRun.mock.calls[0][4]).toEqual({ desktop: true })
    expect(runs.continueRun.mock.calls[1]).toHaveLength(4)
  })

  it('runs:send never forwards overrides', async () => {
    const { d, runs } = setup()
    await d.invokeRpc(IPC.runsSend, [{ runId: 'run_1', text: 'hi', overrides: { permissionMode: 'bypassPermissions' } }], OPERATE)
    expect(runs.send).toHaveBeenCalledWith('run_1', 'hi', undefined)
  })
})

describe('runs:startQuick overrides', () => {
  it('checks through QuickRunService against the quick project', async () => {
    const { d, quick } = setup()
    const ok = (await d.invokeRpc(IPC.runsStartQuick, [{ prompt: 'hi', overrides: { permissionMode: 'plan' } }], OPERATE)) as { allowWidening: boolean }
    expect(ok.allowWidening).toBe(false)
    expect(quick.start.mock.calls[0][0]).toMatchObject({ overrides: { permissionMode: 'plan' } })
    const err = await failure(d.invokeRpc(IPC.runsStartQuick, [{ prompt: 'hi', overrides: { permissionMode: 'acceptEdits' } }], OPERATE))
    expect(err.code).toBe('scope_denied')
    expect(err.message).toContain('permissionMode')
    const wide = (await d.invokeRpc(IPC.runsStartQuick, [{ prompt: 'hi', overrides: { permissionMode: 'acceptEdits' } }], CONFIGURE)) as { allowWidening: boolean }
    expect(wide.allowWidening).toBe(true)
  })

  it('the desktop drops them and calls start with the input only', async () => {
    const { d, quick } = setup()
    await d.invoke(IPC.runsStartQuick, [{ prompt: 'hi', overrides: { permissionMode: 'plan' } }], DESKTOP)
    expect(quick.start).toHaveBeenCalledWith({ prompt: 'hi', team: 'single', allowEdits: false })
  })
})

describe('decision channels: expectedRevision, decidedBy and the DecisionOutcome (cli-spec 3.4(4), 5.3)', () => {
  const cases: Array<[string, keyof ReturnType<typeof setup>['runs'], Record<string, unknown>, string]> = [
    [IPC.runsDecide, 'decide', { runId: 'run_1', requestId: 'req_p', decision: { behavior: 'allow', scope: 'once' } }, 'req_p'],
    [IPC.permissionsDecideRequest, 'decideRules', { runId: 'run_1', requestId: 'req_r', decision: { behavior: 'grant', scope: 'run' } }, 'req_r'],
    [IPC.setupDecide, 'decideProposal', { runId: 'run_1', proposalId: 'prop_1', decision: { behavior: 'approve' } }, 'prop_1'],
    [IPC.setupAnswer, 'answerQuestion', { runId: 'run_1', questionId: 'q_1', answer: { selected: ['A'] } }, 'q_1'],
    [IPC.mergesDecide, 'decideMerge', { runId: 'run_1', reviewId: 'mr_1', decision: { behavior: 'hold' } }, 'mr_1'],
    [IPC.mcpAnswerInstall, 'answerMcpInstall', { runId: 'run_1', requestId: 'inst_1', decision: { approved: false } }, 'inst_1']
  ]
  const DECIDE: HostScope[] = ['read', 'decide']

  it.each(cases)('%s from a cli client passes expectedRevision and returns the outcome over invokeRpc', async (channel, method, input, id) => {
    const { d, runs } = setup()
    const out = await d.invokeRpc(channel, [{ ...input, expectedRevision: 4 }], rpc(DECIDE))
    expect(out).toEqual(outcome(id))
    const call = (runs[method] as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('run_1')
    expect(call[1]).toBe(id)
    expect(call[3]).toEqual({ expectedRevision: 4, decidedBy: { surface: 'cli' } })
  })

  it.each(cases)('%s from a tui client reports its pid', async (channel, method, input) => {
    const { d, runs } = setup()
    await d.invokeRpc(channel, [input], rpc(DECIDE, { clientKind: 'tui', pid: 4242 }))
    expect((runs[method] as ReturnType<typeof vi.fn>).mock.calls[0][3]).toEqual({ decidedBy: { surface: 'tui', reportedPid: 4242 } })
  })

  it.each(cases)('%s from the desktop is decided by the desktop', async (channel, method, input, id) => {
    const { d, runs } = setup()
    const out = d.invoke(channel, [{ ...input, expectedRevision: 0 }], DESKTOP)
    expect(out).toEqual(outcome(id))
    expect((runs[method] as ReturnType<typeof vi.fn>).mock.calls[0][3]).toEqual({ expectedRevision: 0, decidedBy: { surface: 'desktop' } })
  })

  it('an inproc client without a kind counts as cli', async () => {
    const { d, runs } = setup()
    await d.invokeRpc(IPC.runsDecide, [cases[0][2]], { surface: 'inproc', grantedScopes: DECIDE })
    expect(runs.decide.mock.calls[0][3]).toEqual({ decidedBy: { surface: 'cli' } })
  })

  it('a bad expectedRevision is bad_request', async () => {
    const { d, runs } = setup()
    const err = await failure(d.invokeRpc(IPC.runsDecide, [{ ...cases[0][2], expectedRevision: -2 }], rpc(DECIDE)))
    expect(err.code).toBe('bad_request')
    expect(runs.decide).not.toHaveBeenCalled()
  })

  it("decisions need the 'decide' scope", async () => {
    const { d } = setup()
    const err = await failure(d.invokeRpc(IPC.runsDecide, [cases[0][2]], OPERATE))
    expect(err.code).toBe('scope_denied')
  })
})

describe('runs:findDecision', () => {
  it("answers RunManager's lookup with the 'read' scope", async () => {
    const { d, runs } = setup()
    await expect(d.invokeRpc(HOST_IPC.runsFindDecision, ['req_p'], rpc(['read']))).resolves.toEqual({
      status: 'pending',
      requestId: 'req_p',
      runId: 'run_1',
      projectId: 'proj_a',
      kind: 'permission',
      revision: 3
    })
    expect(runs.findDecision).toHaveBeenCalledWith('req_p')
  })

  it('refuses a malformed id', async () => {
    const { d, runs } = setup()
    await expect(d.invokeRpc(HOST_IPC.runsFindDecision, ['../x'], rpc(['read']))).rejects.toBeTruthy()
    expect(runs.findDecision).not.toHaveBeenCalled()
  })
})
