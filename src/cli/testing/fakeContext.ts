/**
 * A CliContext for unit tests: in-memory io, a scriptable fake HostClient, a fake read-only store, a fake launcher
 * and inproc handle, and signals the test fires by hand. Nothing here touches the network, spawns a process or
 * spends tokens.
 */
import type { DaemonInfo, HostRpcError, HostStatusResult, Project, RpcHelloResult, RunRecord, RunSummary } from '../../shared/types'
import type {
  CliContext,
  CliGlobals,
  ConnectResult,
  HostCallError,
  HostClient,
  HostLauncher,
  InprocHostHandle,
  ProjectResolution,
  ReadOnlySnapshot
} from '../types'

export type Answer = (params: unknown) => unknown

/** A HostClient whose answers are scripted per method; notifications and closes are pushed by the test. */
export class FakeHostClient implements HostClient {
  readonly hello: RpcHelloResult
  readonly daemon: DaemonInfo
  readonly calls: { method: string; params: unknown }[] = []
  closed = false
  private notes = new Set<(m: string, p: unknown) => void>()
  private closes = new Set<(err?: Error) => void>()

  constructor(
    public answers: Record<string, Answer> = {},
    opts: { hello?: Partial<RpcHelloResult>; daemon?: Partial<DaemonInfo> } = {}
  ) {
    this.hello = {
      protocolVersion: 1,
      hostInstanceId: 'aaaaaaaaaaaa',
      hostKind: 'desktop',
      appVersion: '0.0.0-test',
      dataDir: '/data/data',
      mock: true,
      grantedScopes: ['read'],
      hostProof: '0'.repeat(64),
      ...opts.hello
    }
    this.daemon = { hostInstanceId: this.hello.hostInstanceId, pid: 4242, endpoint: '/tmp/x.sock', state: 'ready', startedAt: 1, ...opts.daemon }
  }

  async call<T = unknown>(method: string, params?: unknown[] | Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params })
    if (this.closed) throw new Error('The connection to the OrgAI host closed.')
    const a = this.answers[method]
    if (!a) throw rpcError({ code: 'unknown_channel', message: `No fake answer for ${method}` })
    return (await a(params)) as T
  }

  onNotification(fn: (method: string, params: unknown) => void): () => void {
    this.notes.add(fn)
    return () => this.notes.delete(fn)
  }

  onClose(fn: (err?: Error) => void): () => void {
    this.closes.add(fn)
    return () => this.closes.delete(fn)
  }

  close(): void {
    this.closed = true
  }

  /** The host pushes a notification. */
  push(method: string, params: unknown): void {
    for (const fn of [...this.notes]) fn(method, params)
  }

  /** The socket closes from the host's side. */
  hostClose(err?: Error): void {
    this.closed = true
    for (const fn of [...this.closes]) fn(err)
  }

  /** Calls of one method. */
  callsOf(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params)
  }
}

/** A JSON-RPC error answer as HostClient.call rejects with it. */
export function rpcError(data: HostRpcError): HostCallError {
  const e = new Error(data.message) as HostCallError
  e.data = data
  return e
}

export function noHost(message = 'No OrgAI host is running.'): ConnectResult {
  return { ok: false, reason: 'no_host', message }
}

export interface FakeStore {
  hostState?: ReadOnlySnapshot['hostState']
  daemon?: DaemonInfo
  projects?: Project[]
  runs?: RunSummary[]
  records?: Record<string, RunRecord>
}

export interface FakeContextOptions {
  globals?: Partial<CliGlobals>
  cwd?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  columns?: number
  paths?: { userDataDir: string; dataDir: string }
  /** Each connect() call takes the next entry (the last one repeats); a FakeHostClient means ok. */
  connect?: (FakeHostClient | ConnectResult)[]
  store?: FakeStore
  /** Override project resolution; default: --project by id or path, else the deepest project containing cwd. */
  resolveProject?: (projects: Project[]) => ProjectResolution
  launcher?: Partial<HostLauncher>
  inproc?: () => Promise<InprocHostHandle>
  /** io.stdinIsTTY (default false). */
  stdinIsTTY?: boolean
}

export interface FakeContext {
  ctx: CliContext
  out(): string
  err(): string
  /** Fire SIGINT / SIGTERM at the registered listeners. */
  signal(sig: 'SIGINT' | 'SIGTERM'): void
  connectCalls: { scopes: string[]; opts?: unknown }[]
  launcherCalls: { method: string; args: unknown }[]
  signalListeners(): number
}

export function project(id: string, path: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name: extra.name ?? id,
    path,
    brief: '',
    provider: { id: 'mock', label: 'Mock', auth: { mode: 'subscription' } },
    permissionMode: 'default',
    roles: [],
    ...extra
  } as unknown as Project
}

export function summary(id: string, extra: Partial<RunSummary> = {}): RunSummary {
  return { id, projectId: 'p1', kind: 'work', prompt: `prompt ${id}`, status: 'finished', startedAt: 1000, totalCostUsd: 0, ...extra }
}

export function record(s: RunSummary, extra: Partial<RunRecord> = {}): RunRecord {
  const root = {
    id: 'root',
    roleId: null,
    roleSlug: 'orchestrator',
    name: 'Orchestrator',
    parentId: null,
    spawnToolUseId: null,
    state: 'done',
    activity: 'Finished',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    startedAt: s.startedAt
  }
  return { summary: s, agents: { root } as RunRecord['agents'], transcript: [], logs: [], ...extra }
}

export function hostStatus(extra: Partial<HostStatusResult> = {}): HostStatusResult {
  return {
    protocolVersion: 1,
    hostInstanceId: 'aaaaaaaaaaaa',
    hostKind: 'desktop',
    state: 'ready',
    appVersion: '0.0.0-test',
    dataDir: '/data/data',
    mock: true,
    pid: 4242,
    startedAt: Date.now() - 60_000,
    activity: {
      counts: { liveRuns: 0, pausedAutoResumes: 0, inFlightRpcMutations: 0, activeWorktreeOps: 0, backgroundTasks: 0, activeOAuthFlows: 0, interactiveClients: 0 },
      total: 0,
      idle: true,
      state: 'ready'
    },
    ...extra
  }
}

function defaultResolve(globals: CliGlobals, cwd: string, projects: Project[]): ProjectResolution {
  if (globals.project) {
    const hit = projects.filter((p) => p.id === globals.project || p.path === globals.project)
    if (hit.length === 1) return { project: hit[0], via: 'flag' }
    return { via: 'flag', error: `No project matches --project ${globals.project}.` }
  }
  const sep = (p: string): string => (p.endsWith('/') ? p : `${p}/`)
  const inside = projects.filter((p) => cwd === p.path || cwd.startsWith(sep(p.path))).sort((a, b) => b.path.length - a.path.length)
  return inside[0] ? { project: inside[0], via: 'cwd' } : { via: 'none' }
}

export function fakeContext(o: FakeContextOptions = {}): FakeContext {
  let stdout = ''
  let stderr = ''
  const globals: CliGlobals = { host: 'auto', outputFormat: 'text', color: false, secretEnv: [], ...o.globals }
  const listeners = new Set<(sig: 'SIGINT' | 'SIGTERM') => void>()
  const connectCalls: FakeContext['connectCalls'] = []
  const launcherCalls: FakeContext['launcherCalls'] = []
  const queue = [...(o.connect ?? [noHost()])]
  const store = o.store ?? {}
  const cwd = o.cwd ?? '/work'
  const launcher: HostLauncher = {
    resolve: () => {
      launcherCalls.push({ method: 'resolve', args: undefined })
      return o.launcher?.resolve ? o.launcher.resolve() : { command: '/bin/orgai-app', args: [], source: 'dev' }
    },
    spawn: (args) => {
      launcherCalls.push({ method: 'spawn', args })
      return o.launcher?.spawn ? o.launcher.spawn(args) : { pid: 999 }
    },
    // A read of daemon.json; not recorded in launcherCalls.
    current: () => (o.launcher?.current ? o.launcher.current() : null),
    waitForReady: async (args) => {
      launcherCalls.push({ method: 'waitForReady', args })
      return o.launcher?.waitForReady ? o.launcher.waitForReady(args) : null
    },
    waitForGone: async (args) => {
      launcherCalls.push({ method: 'waitForGone', args })
      return o.launcher?.waitForGone ? o.launcher.waitForGone(args) : true
    }
  }
  const ctx: CliContext = {
    globals,
    paths: o.paths ?? { userDataDir: '/data', dataDir: '/data/data' },
    env: o.env ?? {},
    cwd,
    platform: o.platform ?? 'darwin',
    io: {
      stdout: { write: (s: string) => ((stdout += s), true), isTTY: false, columns: o.columns ?? 100 },
      stderr: { write: (s: string) => ((stderr += s), true), isTTY: false },
      stdinIsTTY: o.stdinIsTTY ?? false
    },
    version: '0.0.0-test',
    connect: async (scopes, opts) => {
      connectCalls.push({ scopes: [...scopes], opts })
      const next = queue.length > 1 ? queue.shift()! : queue[0]
      return next instanceof FakeHostClient ? { ok: true, client: next } : next
    },
    readStore: async () => {
      const records = store.records ?? {}
      return {
        hostState: store.hostState ?? 'stopped',
        liveInboxAvailable: false,
        ...(store.daemon ? { daemon: store.daemon } : {}),
        projects: store.projects ?? [],
        runs: [...(store.runs ?? [])].sort((a, b) => b.startedAt - a.startedAt),
        readRecord: (id: string) => records[id] ?? null
      }
    },
    resolveProject: (projects) => (o.resolveProject ? o.resolveProject(projects) : defaultResolve(globals, cwd, projects)),
    launcher,
    startInproc: async () => {
      if (!o.inproc) throw new Error('no inproc host in this test')
      return o.inproc()
    },
    signals: {
      onInterrupt: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      }
    }
  }
  return {
    ctx,
    out: () => stdout,
    err: () => stderr,
    signal: (sig) => {
      for (const fn of [...listeners]) fn(sig)
    },
    connectCalls,
    launcherCalls,
    signalListeners: () => listeners.size
  }
}

/** A fake `--host inproc` handle: records stop() calls; `closed` resolves on the first stop. */
export function fakeInproc(status: Partial<HostStatusResult> = {}): InprocHostHandle & { stops: boolean[] } {
  const stops: boolean[] = []
  let resolveClosed!: () => void
  const closed = new Promise<void>((r) => (resolveClosed = r))
  return {
    stops,
    closed,
    status: () => hostStatus({ hostKind: 'inproc', ...status }),
    stop: async (force: boolean) => {
      stops.push(force)
      resolveClosed()
    }
  }
}

/** Wait for pending promise callbacks (and a macrotask). */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
