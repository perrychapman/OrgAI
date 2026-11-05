import { afterEach, describe, expect, it } from 'vitest'
import type { Project, RunSummary } from '../../shared/types'
import type { TuiHostConnection, TuiLaunch } from '../tui/types'
import { fakeContext, FakeHostClient, project, rpcError, summary, type Answer } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { interactiveDeps, prepareInteractive, runInteractiveRun, type InteractiveRunSpec } from './interactive'

const realDeps = { ...interactiveDeps }
afterEach(() => Object.assign(interactiveDeps, realDeps))

const SPEC: InteractiveRunSpec = { channel: 'setup:start', input: { projectId: 'p1' }, label: 'Architect setup', noTtyMessage: 'Needs a terminal.' }

function conn(answers: Record<string, Answer>, projects: Project[] = [project('p1', '/work/app')]): TuiHostConnection & { client: FakeHostClient } {
  const client = new FakeHostClient(answers)
  return {
    client,
    hello: client.hello,
    started: false,
    projects: async () => projects,
    checkPath: async () => ({ exists: true, isDirectory: true, isGitRepo: false, suggestedName: 'x', empty: false }),
    createProject: async () => projects[0],
    startSetup: async () => summary('run_x'),
    close: async () => undefined
  }
}

async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(CliError)
    return e as CliError
  }
  throw new Error('expected a CliError')
}

describe('runInteractiveRun', () => {
  it('no terminal is exit 2 with the spec message, before the TUI', async () => {
    let launched = false
    interactiveDeps.launchTui = async () => ((launched = true), 0)
    const f = fakeContext({ stdinIsTTY: true })
    const e = await caught(runInteractiveRun(f.ctx, SPEC))
    expect(e).toMatchObject({ exitCode: EXIT.usage, message: 'Needs a terminal.' })
    expect(launched).toBe(false)
  })

  it('refuses a managed agent worktree', async () => {
    const f = fakeContext({ stdinIsTTY: true, resolveProject: () => ({ via: 'none', managedWorktree: { mainCheckout: '/work/main' } }) })
    f.ctx.io.stdout.isTTY = true
    const e = await caught(runInteractiveRun(f.ctx, SPEC))
    expect(e.exitCode).toBe(EXIT.usage)
    expect(e.message).toContain('/work/main')
  })

  it('launches the TUI with the flags and returns its code; prepare starts the run', async () => {
    const f = fakeContext({ stdinIsTTY: true })
    f.ctx.io.stdout.isTTY = true
    let launch: TuiLaunch | undefined
    const c = conn({ 'setup:start': () => summary('run_setup', { projectId: 'p1', kind: 'setup', status: 'starting' }) })
    interactiveDeps.launchTui = async (_ctx, flags, prepare) => {
      expect(flags).toEqual({ inline: true, screenReader: false })
      launch = await prepare(c)
      return 130
    }
    expect(await runInteractiveRun(f.ctx, SPEC, { inline: true })).toBe(130)
    expect(c.client.callsOf('setup:start')).toEqual([[{ projectId: 'p1' }]])
    expect(launch).toMatchObject({ runId: 'run_setup', project: { id: 'p1' }, exitWhenEnded: true, stopOnQuit: true, title: 'Architect setup' })
  })
})

describe('prepareInteractive', () => {
  it('opens a virtual-project run without a project', async () => {
    const c = conn({ 'mcp:startAssist': () => summary('run_mcp', { projectId: 'harness', kind: 'mcp-assist' } as Partial<RunSummary>) })
    const l = await prepareInteractive(c, { channel: 'mcp:startAssist', input: { library: true }, label: 'MCP assistant', noTtyMessage: '' })
    expect(l).toEqual({ runId: 'run_mcp', exitWhenEnded: true, stopOnQuit: true, title: 'MCP assistant' })
  })

  it('maps a host refusal through hostError', async () => {
    const c = conn({ 'setup:start': () => Promise.reject(rpcError({ code: 'bad_request', message: 'Project not found' })) })
    const e = await caught(prepareInteractive(c, SPEC))
    expect(e).toMatchObject({ exitCode: EXIT.usage, message: 'Project not found' })
  })

  it('a non-run answer is exit 1', async () => {
    const c = conn({ 'setup:start': () => null })
    expect((await caught(prepareInteractive(c, SPEC))).exitCode).toBe(EXIT.failure)
  })
})
