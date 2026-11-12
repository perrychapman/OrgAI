/**
 * The TUI's host connection and session (W4-T1, cli-spec 3.3(4), 5.1, 5.2).
 *
 * - connectTuiHost: ensureHost with scopes read / operate / decide / configure and clientKind 'tui' (the host counts the socket as
 *   an interactive client). 'configure' is held on that one connection (createProject, promote, folder trust).
 * - openTuiSession: one RunStream (runs:subscribe with followChains, never nonInteractive) feeding the pure reducer
 *   in state.ts; listeners are notified at most once per 16 ms. Runs the state has not seen (an auto-resume, another
 *   window's run) are fetched with runs:get; earlier chain members (up to 5) are fetched after a focus.
 *
 * Electron-free; relative imports only.
 */
import {
  VIRTUAL_PROJECT_IDS,
  type AppSettings,
  type ConnectionInfo,
  type FolderConfigReview,
  type TeamFilesStatus,
  type CardKind,
  type ConnectionId,
  type DecisionOutcome,
  type EvolutionHistory,
  type EvolveAnalyzeInput,
  type EvolveAnalyzeResult,
  type EvolveApplyInput,
  type EvolveApplyResult,
  type EvolveRollbackInput,
  type EvolveRollbackResult,
  EVOLVE_IPC,
  type HostKind,
  type HostScope,
  type PermissionMode,
  type Project,
  type ProjectCreateInput,
  type ProjectPathCheck,
  type ProviderModel,
  type QuickRunPromoteResult,
  type RunOverrides,
  type RunRecord,
  type RunSummary,
  type RunOutput,
  type RunTeam,
  type SetRunPermissionModeResult,
  type SwitchRunModelResult,
  type WorktreeDiff
} from '../../shared/types'
import { chainOf, isOpenStatus, newestOf, runBatched } from '../../shared/view/runChains'
import { connectFailure, ENSURE_HOST_STARTING_WAIT_MS, ensureHost, type EnsuredHost } from '../client/ensureHost'
import { RunStream, type RunStreamTimers } from '../client/runStream'
import { safeLine } from '../output'
import { recordWithoutImages } from '../render'
import { CliError, EXIT, type CliContext, type ConnectResult, type HostCallError, type HostClient, type InprocHostHandle } from '../types'
import { overridesNeedConfigure } from '../commands/exec'
import { loadModelCatalog, switchRunModel } from '../modelSwitch'
import { composerMode, offersRetro } from './selectors'
import { approvalItems, waitingNotice, type ApprovalItem } from './approvals'
import { projectKindOf } from '../../shared/defaults'
import {
  addNotice,
  applyEvent,
  applyRecord,
  applyRunList,
  applySnapshot,
  clearActiveRun,
  createInitialState,
  createPartialTracker,
  setActiveRun,
  setComposeTarget,
  setConnection,
  setProject,
  upsertRunSummary
} from './state'
import { hintStore, type TuiConfigApi } from './configApi'
import type {
  ComposeTarget,
  DecisionCall,
  OpenTuiSessionOptions,
  StagedRunOptions,
  Tone,
  TuiHostConnection,
  TuiSessionApi,
  TuiState
} from './types'

export const TUI_SCOPES: readonly HostScope[] = ['read', 'operate', 'decide', 'configure']
/** Kept for older importers: the TUI's one connection now holds 'configure' itself. */
export const TUI_CONFIGURE_SCOPES: readonly HostScope[] = TUI_SCOPES
/** How long a decision call may take (a proposal approval applies changes before it answers). */
export const TUI_DECIDE_TIMEOUT_MS = 120_000
/** Listeners are notified at most this often. */
export const TUI_NOTIFY_MS = 16
/** Earlier chain members fetched after a focus. */
export const TUI_EARLIER_MEMBERS = 5
export const HOST_GONE_NOTICE = 'Lost the connection to the OrgAI host. Quit and start orgai again to reconnect.'

/** A host call's rejection as a plain Error with a sanitized one-line message (the host's message when it sent one). */
export function hostError(e: unknown): Error {
  const data = (e as Partial<HostCallError> | undefined)?.data
  const message = data?.message ?? (e instanceof Error ? e.message : String(e))
  const err = new Error(safeLine(message) || 'The OrgAI host refused the request.') as Error & { code?: string }
  if (data?.code) err.code = data.code
  return err
}

const codeOf = (e: unknown): string | undefined => (e as Partial<HostCallError> | undefined)?.data?.code

// ---------- Connection ----------

export interface ConnectTuiOptions {
}

class TuiConnection implements TuiHostConnection {
  /**
   * The one read / operate / decide client every session's stream and call goes through. The connection owns it and
   * every client a stream's reconnect brings (`reconnect` adopts it as the new base and closes the old one), so a
   * session switch never closes a socket the next session uses (streams are built with keepClient: () => true).
   */
  private base: HostClient
  private follower: RunStream | undefined
  readonly inproc: InprocHostHandle

  constructor(
    private readonly ctx: CliContext,
    host: EnsuredHost
  ) {
    this.base = host.client
    this.inproc = host.inproc
  }

  /** The client calls go through (a stream's reconnect replaces it). */
  get client(): HostClient {
    return this.base
  }

  get hello(): HostClient['hello'] {
    return this.client.hello
  }

  get userDataDir(): string {
    return this.ctx.paths.userDataDir
  }

  /** A fresh connection with the same scopes (RunStream reconnects); on success it becomes the shared client. */
  async reconnect(): Promise<ConnectResult> {
    const res = await this.ctx.connect([...TUI_SCOPES], { clientKind: 'tui', waitStartingMs: ENSURE_HOST_STARTING_WAIT_MS })
    if (res.ok && res.client !== this.base) {
      const previous = this.base
      this.base = res.client
      previous.close()
    }
    return res
  }

  /** The newest session's stream; returns the one it replaced (restored when that session fails to start). */
  follow(stream: RunStream | undefined): RunStream | undefined {
    const previous = this.follower
    this.follower = stream
    return previous
  }

  /** A closing session lets go of its stream (a newer session's stream stays followed). */
  unfollow(stream: RunStream): void {
    if (this.follower === stream) this.follower = undefined
  }

  async projects(): Promise<Project[]> {
    const list = await this.client.call<Project[]>('projects:list', []).catch((e: unknown) => {
      throw hostError(e)
    })
    return Array.isArray(list) ? list : []
  }

  async checkPath(path: string): Promise<ProjectPathCheck> {
    return this.client.call<ProjectPathCheck>('projects:checkPath', [path]).catch((e: unknown) => {
      throw hostError(e)
    })
  }

  /**
   * Runs `fn` on the shared client, which holds 'configure' (TUI_SCOPES). Refused with exit 1 when the host did not
   * grant it (an older host that has no 'configure' for the 'tui' client kind).
   */
  private async withConfigure<T>(fn: (client: HostClient) => Promise<T>): Promise<T> {
    const granted = this.client.hello.grantedScopes
    if (Array.isArray(granted) && !granted.includes('configure')) {
      throw new CliError("The OrgAI host did not grant the 'configure' access this needs.", EXIT.failure)
    }
    return fn(this.client)
  }

  async createProject(input: ProjectCreateInput): Promise<Project> {
    return this.withConfigure((client) =>
      client.call<Project>('projects:create', [input]).catch((e: unknown) => {
        throw hostError(e)
      })
    )
  }

  /** One call with 'configure' (run options that widen the project's settings; exec's Session.needConfigure). */
  async callConfigured<T>(method: string, params: unknown[]): Promise<T> {
    const granted = this.client.hello.grantedScopes
    if (!Array.isArray(granted) || granted.includes('configure')) {
      return this.client.call<T>(method, params).catch((e: unknown) => {
        throw hostError(e)
      })
    }
    const res = await this.ctx.connect([...TUI_CONFIGURE_SCOPES], { clientKind: 'tui', waitStartingMs: ENSURE_HOST_STARTING_WAIT_MS })
    if (!res.ok) throw connectFailure(res)
    try {
      const nextGranted = res.client.hello.grantedScopes
      if (Array.isArray(nextGranted) && !nextGranted.includes('configure')) {
        throw new CliError("The OrgAI host did not grant the 'configure' access this needs.", EXIT.failure)
      }
      return await res.client.call<T>(method, params).catch((e: unknown) => {
        throw hostError(e)
      })
    } finally {
      res.client.close()
    }
  }

  async startSetup(projectId: string): Promise<RunSummary> {
    return this.client.call<RunSummary>('setup:start', [{ projectId }]).catch((e: unknown) => {
      throw hostError(e)
    })
  }

  async close(opts: { stopInproc?: boolean } = {}): Promise<void> {
    this.follower?.close()
    this.follower = undefined
    this.base.close()
    if (opts.stopInproc && this.inproc) await this.inproc.stop(true)
  }
}

export async function connectTuiHost(ctx: CliContext, opts: ConnectTuiOptions = {}): Promise<TuiHostConnection> {
  const host = await ensureHost(ctx, [...TUI_SCOPES], { clientKind: 'tui' })
  return new TuiConnection(ctx, host)
}

// ---------- Session ----------

/** Test seams (timers); the shell passes nothing. */
export interface TuiSessionInternals {
  /** Schedules a listener notification (default: setTimeout TUI_NOTIFY_MS, unref'd). */
  schedule?: (fn: () => void) => void
  timers?: RunStreamTimers
  now?: () => number
}

const IGNORED_FOR_FETCH = new Set(['log', 'usage.status', 'project.updated'])

/** A decision host answer as a DecisionOutcome (decide.ts asOutcome): an empty answer counts as applied. */
function asOutcome(raw: unknown, requestId: string, runId: string, sent: string): DecisionOutcome {
  if (raw && typeof raw === 'object' && typeof (raw as DecisionOutcome).status === 'string') {
    const o = raw as DecisionOutcome
    if (['applied', 'already-resolved', 'stale-revision', 'cancelled', 'not-found'].includes(o.status)) return { ...o, requestId: o.requestId || requestId }
  }
  return { status: 'applied', runId, requestId, effectiveDecision: sent }
}

const CHANNEL_KIND: Record<DecisionCall['channel'], CardKind> = {
  'runs:decide': 'permission',
  'permissions:decideRequest': 'rules',
  'setup:decide': 'proposal',
  'setup:answer': 'question',
  'merges:decide': 'merge',
  'mcp:answerInstall': 'mcpInstall'
}

/** The effective decision word a payload asks for (the fallback for a host that answers nothing). */
function sentWord(call: DecisionCall): string {
  const kind = CHANNEL_KIND[call.channel]
  const d = (call.payload.decision ?? {}) as { behavior?: unknown; approved?: unknown }
  if (kind === 'question') return 'answer'
  if (kind === 'mcpInstall') return d.approved === true ? 'allow' : 'deny'
  return typeof d.behavior === 'string' ? d.behavior : 'applied'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export async function openTuiSession(conn: TuiHostConnection, opts: OpenTuiSessionOptions, internals: TuiSessionInternals = {}): Promise<TuiSessionApi> {
  const now = internals.now ?? Date.now
  const tracker = createPartialTracker()
  const listeners = new Set<() => void>()
  let closed = false
  let stream: RunStream | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduled = false

  let state: TuiState = {
    ...createInitialState(opts.folder),
    hostInstanceId: conn.hello.hostInstanceId,
    hostKind: conn.hello.hostKind,
    ...(opts.project ? { project: opts.project } : {}),
    ...(opts.readOnlyReason ? { readOnlyReason: opts.readOnlyReason } : {})
  }

  const fire = (): void => {
    scheduled = false
    timer = undefined
    if (closed) return
    for (const l of [...listeners]) l()
  }
  const schedule =
    internals.schedule ??
    ((fn: () => void): void => {
      timer = setTimeout(fn, TUI_NOTIFY_MS)
      ;(timer as { unref?: () => void }).unref?.()
    })
  const notify = (): void => {
    if (scheduled || closed) return
    scheduled = true
    schedule(fire)
  }
  const set = (next: TuiState): void => {
    if (next === state) return
    state = next
    notify()
  }

  const client = (): HostClient => stream?.client ?? conn.client
  const call = async <T>(method: string, params: unknown[], o?: { timeoutMs?: number }): Promise<T> => {
    try {
      return await client().call<T>(method, params, o)
    } catch (e) {
      throw hostError(e)
    }
  }

  // ----- Runs the state does not know yet -----
  const fetched = new Set<string>()
  const fetchRun = (runId: string): void => {
    if (fetched.has(runId) || closed) return
    fetched.add(runId)
    void call<RunRecord | null>('runs:get', [runId])
      .then((rec) => {
        if (closed || !rec || typeof rec !== 'object' || !rec.summary) return
        set(applyRecord(state, recordWithoutImages(rec), { partials: tracker, preferLive: true }))
      })
      .catch(() => {
        fetched.delete(runId)
      })
  }

  // ----- Chains -----
  const runsOf = async (projectId: string): Promise<RunSummary[]> => {
    const list = await call<RunSummary[]>('runs:list', [projectId]).catch(() => [] as RunSummary[])
    return Array.isArray(list) ? list : []
  }
  /** The run's project's runs (the run's summary, else the project, else every project and virtual id searched). */
  const listWith = async (runId: string): Promise<RunSummary[]> => {
    const known = state.runs[runId]?.summary.projectId || state.project?.id
    if (known) {
      const list = await runsOf(known)
      if (list.some((r) => r.id === runId)) return list
    }
    const projects = await conn.projects().catch(() => [] as Project[])
    for (const pid of [...projects.map((p) => p.id), ...VIRTUAL_PROJECT_IDS]) {
      if (pid === known) continue
      const list = await runsOf(pid)
      if (list.some((r) => r.id === runId)) return list
    }
    return []
  }

  const loadEarlier = (chain: readonly string[]): void => {
    const earlier = chain.slice(0, -1).slice(-TUI_EARLIER_MEMBERS).filter((id) => !state.runs[id]?.recordLoaded)
    if (earlier.length === 0) return
    void runBatched(earlier, 4, async (id) => {
      const rec = await call<RunRecord | null>('runs:get', [id])
      if (closed || !rec || !rec.summary) return
      fetched.add(id)
      set(applyRecord(state, recordWithoutImages(rec), { partials: tracker }))
    })
  }

  /** Focus the chain of `runId` (its newest member), oldest first. */
  const focusChain = async (runId: string, list?: RunSummary[]): Promise<string[]> => {
    const runs = list ?? (await listWith(runId))
    const newest = newestOf(runs, runId)
    const chain = newest ? chainOf(runs, newest.id).map((r) => r.id) : [runId]
    const pid = state.project?.id
    if (pid && runs.some((r) => r.projectId === pid)) set(applyRunList(state, runs))
    set(setActiveRun(state, chain[chain.length - 1], chain))
    return chain
  }

  // ----- Subscription -----
  const subscribeInput = (): { projectIds?: string[]; runIds?: string[]; includeActiveRunRecord?: string; followChains: boolean } => {
    const pid = state.project?.id
    const active = state.activeRunId
    const activePid = active ? state.runs[active]?.summary.projectId : undefined
    const outside = active !== undefined && (!pid || (activePid !== undefined && activePid !== pid))
    return {
      ...(pid ? { projectIds: [pid] } : {}),
      // Without a project only the focused run (none: nothing); a focused run of another project is added too.
      ...(!pid ? { runIds: active ? [active] : [] } : outside ? { runIds: [active] } : {}),
      ...(active ? { includeActiveRunRecord: active } : {}),
      followChains: true
    }
  }

  const pickDefault = (): string | undefined => {
    const pid = state.project?.id
    const live = Object.values(state.runs)
      .filter((r) => (!pid || r.summary.projectId === pid) && isOpenStatus(r.summary.status))
      .sort((a, b) => a.summary.startedAt - b.summary.startedAt)
    const waiting = live.find((r) => Object.values(r.cards).some((l) => l.length > 0))
    return (waiting ?? live[live.length - 1])?.summary.id
  }

  // Focus before subscribing when a run was named.
  let initialList: RunSummary[] | undefined
  if (opts.project) initialList = await runsOf(opts.project.id)
  if (initialList) state = applyRunList(state, initialList)
  if (opts.runId) {
    const list = initialList?.some((r) => r.id === opts.runId) ? initialList : await listWith(opts.runId)
    await focusChain(opts.runId, list)
  } else if (!opts.project) {
    state = clearActiveRun(state)
  }

  const c = conn instanceof TuiConnection ? conn : undefined
  stream = new RunStream({
    client: conn.client,
    // The connection (and every client a reconnect brings, adopted by TuiConnection.reconnect) is shared with later
    // sessions (onboarding, project switches): the stream closes none of them; only runTui closes the connection.
    keepClient: c ? () => true : true,
    connect: () => (c ? c.reconnect() : Promise.resolve({ ok: false, reason: 'unreachable', message: 'No reconnect for this connection.' } as ConnectResult)),
    subscribeInput,
    onEvent: (p) => {
      const e = p?.event
      const id = e && typeof e.runId === 'string' ? e.runId : undefined
      const unknown = id !== undefined && !state.runs[id] && !IGNORED_FOR_FETCH.has(e.type)
      set(applyEvent(state, p, { partials: tracker, now: now() }))
      if (unknown && state.runs[id]) fetchRun(id)
    },
    onSnapshot: (res) => {
      set(applySnapshot(state, res, { activeRunId: state.activeRunId, partials: tracker, now: now() }))
      if (res.snapshot.activeRun) fetched.add(res.snapshot.activeRun.summary.id)
    },
    onGone: () => {
      set(addNotice(setConnection(state, 'gone'), HOST_GONE_NOTICE, 'danger', now()))
    },
    onReconnecting: () => set(setConnection(state, 'reconnecting')),
    onSubscribed: () => set(setConnection(state, 'live')),
    stopped: () => closed,
    ...(internals.timers ? { timers: internals.timers } : {})
  })
  const own = stream
  const previousFollower = c?.follow(own)
  try {
    await stream.start()
  } catch (e) {
    if (c) {
      c.unfollow(own)
      if (previousFollower) c.follow(previousFollower)
    }
    throw hostError(e)
  }
  set(setConnection(state, 'live'))

  const focusRun = async (runId: string, list?: RunSummary[]): Promise<void> => {
    const chain = await focusChain(runId, list)
    await stream?.resubscribe().catch((e: unknown) => {
      throw hostError(e)
    })
    loadEarlier(chain)
  }

  if (opts.runId) loadEarlier(state.activeChain)
  else if (opts.project) {
    const pick = pickDefault()
    if (pick) await focusRun(pick, initialList)
    else set(clearActiveRun(state))
  }

  const activeId = (): string => {
    const id = state.activeRunId
    if (!id) throw new Error('No run is open.')
    return id
  }
  const projectIdOf = (runId?: string): string => {
    const pid = (runId ? state.runs[runId]?.summary.projectId : undefined) || state.project?.id || (state.activeRunId ? state.runs[state.activeRunId]?.summary.projectId : undefined)
    if (!pid) throw new Error('No project is open.')
    return pid
  }

  /**
   * A call that starts or continues a run: with run options that widen the project's settings it goes through a
   * separate 'configure' connection (as exec asks for it), else the shared one.
   */
  const startCall = <T>(method: string, params: unknown[], overrides: RunOverrides | undefined, project: Project | undefined): Promise<T> =>
    overrides && conn.callConfigured && overridesNeedConfigure(project, overrides) ? conn.callConfigured<T>(method, params) : call<T>(method, params)
  const withOverrides = (o: RunOverrides | undefined): { overrides?: RunOverrides } => (o && Object.keys(o).length ? { overrides: o } : {})

  /** Focus a run the host just started or continued (its summary first, so following and tags know it). */
  const adopt = async (summary: RunSummary, chain?: string[]): Promise<RunSummary> => {
    if (!summary || typeof summary.id !== 'string') throw new Error('The OrgAI host did not return the run.')
    fetched.add(summary.id)
    set(upsertRunSummary(state, summary))
    if (state.activeRunId !== summary.id) set(setActiveRun(state, summary.id, chain ? [...chain, summary.id] : undefined))
    await stream?.resubscribe().catch((e: unknown) => {
      throw hostError(e)
    })
    return summary
  }

  // Read-only /approvals (read scope): every project's pending team files, and this code project's folder config.
  const waitingItems = async (): Promise<ApprovalItem[]> => {
    const attention = await call<TeamFilesStatus[]>('teamFiles:listAttention', [])
    const p = state.project
    const folderConfig = p && projectKindOf(p) === 'code' ? await call<FolderConfigReview>('projects:folderConfig', [p.id]).catch(() => undefined) : undefined
    return approvalItems(Array.isArray(attention) ? attention : [], p ? { id: p.id, name: p.name, ...(folderConfig ? { folderConfig } : {}) } : undefined)
  }

  // /team and /settings (cli-parity 3.7): reads on the shared client, writes on a one-call 'configure' connection.
  const write = <T>(method: string, params: unknown[]): Promise<T> => (conn.callConfigured ? conn.callConfigured<T>(method, params) : call<T>(method, params))
  const firstOpen = conn.userDataDir ? hintStore(conn.userDataDir) : undefined
  const config: TuiConfigApi = {
    async project(id) {
      const p = await call<Project | null>('projects:get', [id])
      if (!p || typeof p !== 'object') throw new Error('That project is gone.')
      return p
    },
    async saveProject(p) {
      const saved = await write<Project>('projects:save', [p])
      if (saved && state.project?.id === saved.id) set(setProject(state, saved))
      return saved
    },
    async projects() {
      const list = await call<Project[]>('projects:list', [])
      return Array.isArray(list) ? list : []
    },
    async connections() {
      const list = await call<ConnectionInfo[]>('connections:list', [])
      return Array.isArray(list) ? list : []
    },
    async models(connection) {
      const list = await call<ProviderModel[]>('models:list', connection ? [{ connection }] : [])
      return Array.isArray(list) ? list : []
    },
    async settings() {
      const s = await call<Partial<AppSettings>>('settings:get', [])
      return s && typeof s === 'object' ? s : {}
    },
    setSetting: (patch) => write<Partial<AppSettings>>('settings:set', [patch]),
    async updateConnection(connection) {
      const info = await write<ConnectionInfo>('connections:update', [connection])
      // The host remapped the roles on that connection: the open project follows.
      const id = state.project?.id
      if (id) {
        const p = await call<Project | null>('projects:get', [id]).catch(() => null)
        if (p && typeof p === 'object' && state.project?.id === p.id) set(setProject(state, p))
      }
      return info
    },
    ...(firstOpen ? { firstOpen } : {})
  }

  // Choices for the next run this session starts (/model, /effort, /mode, /goal when no run is followed). One-shot: a
  // start that succeeded used them all, a continuation used the goal (the only one it carries), so they are dropped
  // then. A failed call keeps them for the retry.
  let staged: StagedRunOptions = {}
  const mergedOverrides = (over: RunOverrides | undefined): RunOverrides | undefined => {
    const base: RunOverrides = { ...(staged.goal ? { goal: staged.goal } : {}), ...(over ?? {}) }
    return Object.keys(base).length ? base : undefined
  }

  function doSwitchModel(selected: ProviderModel, opts: { confirm(): Promise<boolean> }): Promise<Awaited<ReturnType<typeof switchRunModel>>>
  function doSwitchModel(selection: { model: string; connection?: ConnectionId }): Promise<SwitchRunModelResult>
  async function doSwitchModel(
    selectedOrSelection: ProviderModel | { model: string; connection?: ConnectionId },
    opts?: { confirm(): Promise<boolean> }
  ): Promise<Awaited<ReturnType<typeof switchRunModel>> | SwitchRunModelResult> {
    const runId = activeId()
    if (opts !== undefined) {
      const out = await switchRunModel(call, runId, selectedOrSelection as ProviderModel, opts)
      // The run.model event updates the status bar; the summary also carries the selection kept for the next message.
      if (out.run && out.run.id !== runId) await adopt(out.run, [...state.activeChain])
      else if (out.run?.id === runId) set(upsertRunSummary(state, out.run))
      return out
    }
    const selection = selectedOrSelection as { model: string; connection?: ConnectionId }
    const res = await call<SwitchRunModelResult>('runs:switchModel', [
      { runId, expectedRunId: runId, model: selection.model, ...(selection.connection ? { connection: selection.connection } : {}) }
    ])
    // A provider handoff answers a successor run: follow it (never send anything).
    if (res?.run && res.run.id !== runId) await adopt(res.run, [...state.activeChain])
    else if (res?.run) set(upsertRunSummary(state, { ...state.runs[runId]?.summary, ...res.run }))
    return res
  }

  const api: TuiSessionApi = {
    config,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get hostKind(): HostKind {
      return state.hostKind ?? conn.hello.hostKind
    },
    get hostInstanceId(): string {
      return state.hostInstanceId ?? conn.hello.hostInstanceId
    },
    focusRun: (runId) => focusRun(runId),
    setComposeTarget(t: ComposeTarget) {
      set(setComposeTarget(state, t))
    },
    async submitPrompt(text, o = {}) {
      if (typeof text !== 'string' || text.trim() === '') throw new Error('Type a message first.')
      const mode = composerMode(state)
      switch (mode) {
        case 'readOnly':
          throw new Error(safeLine(state.readOnlyReason) || 'This session is read-only.')
        case 'send':
          await call('runs:send', [{ runId: activeId(), text }])
          return undefined
        case 'continue': {
          const from = activeId()
          const chain = [...state.activeChain]
          const eff = mergedOverrides(o.overrides)
          const next = await startCall<RunSummary>('runs:continue', [{ runId: from, text, ...withOverrides(eff) }], eff, state.project)
          if (staged.goal) {
            const { goal: _used, ...rest } = staged
            staged = rest
          }
          return adopt(next, chain)
        }
        case 'start': {
          const projectId = state.project?.id
          if (!projectId) throw new Error('No project is open.')
          const eff = mergedOverrides(o.overrides)
          const next = await startCall<RunSummary>(
            'runs:start',
            [
              {
                projectId,
                prompt: text,
                ...(o.team ? { team: o.team } : {}),
                ...(staged.model ? { modelSelection: staged.model } : {}),
                ...(staged.effort ? { effort: staged.effort } : {}),
                ...(staged.permissionMode ? { permissionMode: staged.permissionMode } : {}),
                ...withOverrides(eff)
              }
            ],
            eff,
            state.project
          )
          staged = {}
          return adopt(next)
        }
        case 'quick':
          return api.startQuick({ prompt: text, allowEdits: false, ...(o.team ? { team: o.team } : {}), ...withOverrides(o.overrides) })
      }
    },
    async startQuick(input: { prompt: string; allowEdits: boolean; team?: RunTeam; overrides?: RunOverrides }) {
      if (typeof input.prompt !== 'string' || input.prompt.trim() === '') throw new Error('Type a message first.')
      const next = await startCall<RunSummary>(
        'runs:startQuick',
        [{ prompt: input.prompt, folder: state.folder, team: input.team ?? 'single', allowEdits: input.allowEdits === true, ...withOverrides(input.overrides) }],
        input.overrides,
        undefined
      )
      return adopt(next)
    },
    modelCatalog: () => loadModelCatalog(call),
    approvals: {
      list: () => waitingItems(),
      waiting: async () => waitingNotice(await waitingItems())
    },
    switchModel: doSwitchModel,
    async resumeNow() {
      const from = activeId()
      const chain = [...state.activeChain]
      const next = await call<RunSummary>('runs:resumeNow', [from])
      return next && next.id !== from ? adopt(next, chain) : adopt(next)
    },
    async cancelAutoResume() {
      await call('runs:cancelAutoResume', [activeId()])
    },
    async interrupt() {
      await call('runs:interrupt', [activeId()])
    },
    async stop() {
      await call('runs:stop', [activeId()])
    },
    async decide(dc: DecisionCall) {
      const p = dc.payload ?? {}
      const runId = str(p.runId)
      const requestId = str(p.requestId) || str(p.proposalId) || str(p.questionId) || str(p.reviewId)
      const raw = await call<unknown>(dc.channel, [p], { timeoutMs: TUI_DECIDE_TIMEOUT_MS })
      return asOutcome(raw, requestId, runId, sentWord(dc))
    },
    async worktreeDiff(branch: string): Promise<WorktreeDiff> {
      return call<WorktreeDiff>('maintenance:diff', [{ projectId: projectIdOf(state.activeRunId), branch }])
    },
    async listOutputs() {
      const list = await call<RunOutput[]>('outputs:list', [projectIdOf(state.activeRunId)])
      return Array.isArray(list) ? list : []
    },
    async listRuns() {
      const list = await call<RunSummary[]>('runs:list', [projectIdOf()])
      const out = Array.isArray(list) ? list : []
      if (state.project && out.some((r) => r.projectId === state.project?.id)) set(applyRunList(state, out))
      return out
    },
    async startRetro(runId?: string) {
      const id = runId ?? activeId()
      const run = state.runs[id]?.summary
      if (!run) throw new Error('Open the run first.')
      if (!offersRetro(run)) throw new Error('An Org retrospective looks back at an ended work run of a project.')
      const started = await call<RunSummary>('setup:retro', [{ projectId: run.projectId, runId: id }], { timeoutMs: TUI_DECIDE_TIMEOUT_MS })
      return adopt(started)
    },
    getStaged: () => ({ ...staged }),
    stage(patch) {
      const next: StagedRunOptions = { ...staged }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete (next as Record<string, unknown>)[k]
        else (next as Record<string, unknown>)[k] = v
      }
      staged = next
    },
    async listModels(connection?: ConnectionId): Promise<ProviderModel[]> {
      const list = await call<ProviderModel[]>('models:list', [connection ? { connection } : {}])
      return Array.isArray(list) ? list : []
    },
    async setPermissionMode(mode: PermissionMode) {
      const runId = activeId()
      const res = await call<SetRunPermissionModeResult>('runs:setPermissionMode', [{ runId, mode }])
      if (res?.run && res.run.id === runId) set(upsertRunSummary(state, { ...state.runs[runId]?.summary, ...res.run }))
      return res
    },
    async promoteQuick(name: string) {
      return call<QuickRunPromoteResult>('runs:promoteQuick', [{ runId: activeId(), name }])
    },
    async evolveAnalyze(input) {
      return call<EvolveAnalyzeResult>(EVOLVE_IPC.orgEvolveAnalyze, [input], { timeoutMs: TUI_DECIDE_TIMEOUT_MS })
    },
    async evolveHistory(projectId) {
      return call<EvolutionHistory>(EVOLVE_IPC.orgEvolveHistory, [{ projectId }])
    },
    async evolveApply(input) {
      const res = await call<EvolveApplyResult>(EVOLVE_IPC.orgEvolveApply, [input], { timeoutMs: TUI_DECIDE_TIMEOUT_MS })
      if (res?.project && state.project?.id === res.project.id) set(setProject(state, res.project))
      return res
    },
    async evolveRollback(input) {
      const res = await call<EvolveRollbackResult>(EVOLVE_IPC.orgEvolveRollback, [input], { timeoutMs: TUI_DECIDE_TIMEOUT_MS })
      if (res?.project && state.project?.id === res.project.id) set(setProject(state, res.project))
      return res
    },
    async resync() {
      await stream?.resubscribe().catch((e: unknown) => {
        throw hostError(e)
      })
    },
    notify(text: string, tone?: Tone) {
      set(addNotice(state, text, tone, now()))
    },
    /** Closes this session's stream only; the shared connection (and an in-process host) is closed by runTui. */
    async close() {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      listeners.clear()
      stream?.close()
      c?.unfollow(own)
    }
  }
  return api
}
