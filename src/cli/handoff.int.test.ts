/**
 * The app's handoff from a Node host over the real socket (cli-standalone.md 4.4, D8): a pure-Node host of kind 'node'
 * in this process (startInprocHost with hostKind 'node'), the desktop's DesktopHandoff talking to it through
 * connectHost with clientKind 'desktop', and the shutdown coordinator releasing the data folder. The owner's process
 * here is this test process, so "exited" is read as "daemon.json no longer names it". Mock adapter only; no tokens.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DaemonInfo, HostStatusResult, Project, RunSummary } from '../shared/types'
import { DesktopHandoff, type HandoffConnect } from '../main/handoff'
import { readDaemonInfo } from '../main/host/ownership'
import { SettingsStore } from '../main/store/settings'
import { connectHost } from './client/hostClient'
import { startInprocHost, type InprocHost } from './inprocHost'
import { CLI_VERSION } from './version'

let userDataDir: string
let dataDir: string
const started: InprocHost[] = []
let savedMock: string | undefined

beforeEach(() => {
  userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'hoff-')))
  dataDir = join(userDataDir, 'data')
  savedMock = process.env.ORGAI_MOCK
  process.env.ORGAI_MOCK = '1'
})
afterEach(async () => {
  for (const h of started.splice(0)) await h.stop(true).catch(() => {})
  if (savedMock === undefined) delete process.env.ORGAI_MOCK
  else process.env.ORGAI_MOCK = savedMock
  rmSync(userDataDir, { recursive: true, force: true })
})

async function nodeHost(opts: { terminalOff?: boolean } = {}): Promise<InprocHost> {
  if (opts.terminalOff) {
    // The user turned Terminal access off: terminal clients are refused, the app's handoff is not (D8).
    mkdirSync(dataDir, { recursive: true })
    const s = new SettingsStore(dataDir)
    s.set({ ...s.get(), terminalServer: false, terminalServerChosen: true })
  }
  const h = await startInprocHost({
    userDataDir,
    dataDir,
    env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' },
    mock: true,
    overlay: new Map(),
    logging: false,
    startBackground: false,
    hostKind: 'node'
  })
  started.push(h)
  return h
}

function handoff(owner: DaemonInfo): DesktopHandoff {
  return new DesktopHandoff({
    connect: async (timeoutMs): Promise<HandoffConnect> => {
      const r = await connectHost({ dataDir, scopes: ['read', 'configure'], clientKind: 'desktop', clientVersion: '9.9.9-app', cwd: userDataDir, pid: process.pid, connectTimeoutMs: timeoutMs, callTimeoutMs: timeoutMs })
      if (r.ok) return { client: { handoff: r.client.hello.handoff === true, call: (m, p, o) => r.client.call(m, p, o), close: () => r.client.close() } }
      return r.reason === 'draining' ? { draining: true } : { failed: r.message }
    },
    // This process is the owner: it has "exited" once its daemon.json is gone.
    exited: async (o) => readDaemonInfo(dataDir)?.hostInstanceId !== o.hostInstanceId,
    show: () => {},
    exitPollMs: 20,
    windowDelayMs: 50,
    retryMs: 50
  })
}

const until = async (fn: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('handoff from a background host to the app (real socket)', () => {
  it('an idle background host hands over at once, even with Terminal access off and another app version', async () => {
    const h = await nodeHost({ terminalOff: true })
    const owner = readDaemonInfo(dataDir)!
    expect(owner.hostKind).toBe('node')
    // A terminal client is refused (Terminal access off)...
    const cli = await connectHost({ dataDir, scopes: ['read'], clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid })
    expect(cli.ok ? 'connected' : cli.reason).toBe('disabled')
    // ...the app's handoff is not.
    await expect(handoff(owner).run(owner)).resolves.toBe('acquire')
    await h.closed
    expect(existsSync(join(dataDir, 'run', 'daemon.json'))).toBe(false)
  }, 30_000)

  it('a handoff connection reads host.status (with the handoff facts) and nothing else', async () => {
    await nodeHost()
    const r = await connectHost({ dataDir, scopes: ['read', 'configure'], clientKind: 'desktop', clientVersion: '9.9.9-app', cwd: userDataDir, pid: process.pid })
    if (!r.ok) throw new Error(r.message)
    expect(r.client.hello).toMatchObject({ handoff: true, grantedScopes: ['read', 'configure'], hostKind: 'node' })
    const status = await r.client.call<HostStatusResult>('host.status', [])
    expect(status.handoff).toEqual({ workingRuns: 0, waitingRuns: 0, heldRuns: 0, pausedRuns: 0, openCards: 0, terminalSessions: 0 })
    await expect(r.client.call('projects:list', [])).rejects.toMatchObject({ data: { code: 'scope_denied' } })
    await expect(r.client.call('settings:set', [{}])).rejects.toMatchObject({ data: { code: 'scope_denied' } })
    r.client.close()
  }, 30_000)

  it('a background host with an idle run refuses the handoff (waitingRuns), then "Stop them and open" ends the run continuable', async () => {
    const h = await nodeHost()
    const projectDir = join(userDataDir, 'project')
    mkdirSync(projectDir)
    const ctx = { surface: 'inproc' as const, grantedScopes: ['read', 'operate', 'decide', 'configure'] as const }
    const project = (await h.host.dispatcher.invokeRpc('projects:create', [{ name: 'Handoff', path: projectDir, brief: '', mock: true }], { ...ctx, grantedScopes: [...ctx.grantedScopes] })) as Project
    const run = (await h.host.dispatcher.invokeRpc('runs:start', [{ projectId: project.id, prompt: 'Hello', team: 'single' }], { ...ctx, grantedScopes: [...ctx.grantedScopes] })) as RunSummary
    await until(() => h.host.runs.summaryOf(run.id)?.status === 'idle')
    // An idle run keeps no host busy (idle exit would end it), but it blocks the app's handoff.
    expect(h.host.activity.snapshot().counts.liveRuns).toBe(0)
    const owner = readDaemonInfo(dataDir)!
    const flow = handoff(owner)
    const outcome = flow.run(owner)
    await until(() => flow.view()?.kind === 'busy')
    expect(flow.view()!.detail).toContain('1 run waiting for you')
    expect(h.host.shutdown.phase()).toBe('running')
    flow.choose('force')
    await expect(outcome).resolves.toBe('acquire')
    await h.closed
    const ended = h.host.runs.summary(run.id)
    expect(ended?.status).toBe('finished')
    expect(ended?.endedBy).toBe('app')
  }, 60_000)
})
