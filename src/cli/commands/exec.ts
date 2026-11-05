/**
 * `orgai exec [options] [--] [prompt|-]` (alias `orgai -p`) and `orgai resume [runId-or-R#] [--prompt <text> | -]
 * --exec` (cli-spec 4, 6.2).
 *
 * - Flags map to RunOverrides (always `execMode: true`): --permission-mode, --no-auto-continue,
 *   --max-auto-continues, --max-budget / --max-cost (USD, finite >= 0; not both), --allow-unpriced-budget,
 *   --allow-unmerged, --allow-peer-messages, --wait-for-reset, --stall-timeout s, --on-* (decisionPolicy),
 *   --max-auto-denials, --wait-timeout s, --human-grace s. Bad values are usage errors (exit 2).
 * - The prompt is the positional, else stdin ('-', or no positional with a non-TTY stdin; at most 1 MB). Empty: exit 2.
 * - Project: --project, else the folder (cli-spec 4). Inside an OrgAI-managed agent worktree: exit 2 naming the main
 *   checkout. An unregistered folder is exit 2 unless --quick (a Chat run in this folder) or --create-project
 *   (projects:create, needs 'configure').
 * - Scopes 'read' + 'operate', plus 'configure' when creating a project or when the overrides widen the project's
 *   settings (overridesWidening).
 * - The run's chain is followed (runs:subscribe, followChains) until a `run.finalized` for a followed run; the exit
 *   code is EXEC_OUTCOME_EXIT_CODE[outcome]. A snapshot that already carries summary.execOutcome ends at once.
 * - Output: text prints transcript rows and status words like `orgai watch`, then `<outcome> · <status> · <cost>`;
 *   json prints one document at the end; stream-json prints every event, then a `result` line.
 * - SIGINT / SIGTERM: the first calls runs:stop on the newest followed run and waits up to 10 s for run.finalized,
 *   then exits 130 / 143; a second signal exits at once.
 * - --host inproc: the in-process host is stopped (force) before the command returns.
 */
import { basename } from 'node:path'
import { MAX_AUTO_CONTINUES_LIMIT } from '../../shared/defaults'
import {
  EXEC_OUTCOME_EXIT_CODE,
  MAX_TIMER_DELAY_MS,
  isPermissionMode,
  type AgentInstance,
  type ExecOutcome,
  type HeadlessDecisionPolicy,
  type HostScope,
  type PendingCards,
  type Project,
  type RunEvent,
  type RunOverrides,
  type RunRecord,
  type RunsEventParams,
  type RunSummary,
  type TranscriptEntry
} from '../../shared/types'
import { isOpenStatus } from '../../shared/view/runChains'
import { runIndexMap, runTag } from '../../shared/view/runLabels'
import { statusText } from '../../shared/view/runStatus'
import { overridesWidening } from '../../main/runtime/runOverrides'
import { ensureHost, connectFailure, type EnsuredHost } from '../client/ensureHost'
import { RunStream, defaultRunStreamTimers, type RunStreamTimers, type SnapshotResult } from '../client/runStream'
import { TUI_FLAGS, findCommand } from '../commandTable'
import { parseFlags, type FlagSpec } from '../flags'
import { readStdinText } from '../manage'
import { emit, emitLine, isJsonOutput, note, printText, safeLine, styleFor, styleStatus, warn, type Json } from '../output'
import { agentLabel, costText, pendingItems, planUpdateLine, recordWithoutImages, statusViewOf, statusWordOfSummary, transcriptLine } from '../render'
import { resolveRunFromSource, warnVersionSkew } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn, type HostCallError, type HostClient } from '../types'
import { intFlag } from './runs'
import { runResumeTui } from './tui'
import { liveSource } from './watch'

export const EXEC_STDIN_MAX_BYTES = 1024 * 1024
export const EXEC_STOP_WAIT_MS = 10_000
export const MAX_AUTO_DENIALS_LIMIT = 10_000
/** The longest timer the host can arm (MAX_TIMER_DELAY_MS, about 24.8 days), in whole seconds. */
const MAX_SECONDS = Math.floor(MAX_TIMER_DELAY_MS / 1000)

/** Swappable in tests: stdin, the reconnect timers and the stop wait. */
export const execIo = {
  readStdin: (maxBytes: number): Promise<string> => readStdinText(maxBytes, 'The prompt on stdin'),
  timers: defaultRunStreamTimers as RunStreamTimers,
  stopWaitMs: EXEC_STOP_WAIT_MS
}

const usage = (message: string): CliError => new CliError(message, EXIT.usage)

/** A parseFlags spec from a commandTable entry (value flags are strings, the rest booleans). */
function specOf(command: string): FlagSpec {
  const spec: FlagSpec = {}
  for (const f of findCommand(command)?.flags ?? []) spec[f.name] = { type: f.takesValue ? 'string' : 'boolean', ...(f.short ? { short: f.short } : {}) }
  return spec
}

type Values = Record<string, string | boolean | string[] | undefined>

const str = (v: Values, name: string): string | undefined => (typeof v[name] === 'string' ? (v[name] as string) : undefined)

function choice(v: Values, name: string): string | undefined {
  const raw = str(v, name)
  if (raw === undefined) return undefined
  const allowed = findCommand('exec')?.flags.find((f) => f.name === name)?.values ?? findCommand('resume')?.flags.find((f) => f.name === name)?.values
  if (allowed && !allowed.includes(raw)) throw usage(`--${name} must be one of ${allowed.join(', ')}.`)
  return raw
}

/** A finite number >= 0 (digits with an optional fraction), else a usage error. */
function amount(name: string, raw: string, what: string): number {
  const t = raw.trim()
  if (!/^\d+(\.\d+)?$/.test(t)) throw usage(`--${name} needs ${what}.`)
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) throw usage(`--${name} needs ${what}.`)
  return n
}

function secondsMs(name: string, raw: string | undefined, positive = false): number | undefined {
  if (raw === undefined) return undefined
  const s = amount(name, raw, positive ? 'a number of seconds above 0' : 'a number of seconds (0 or more)')
  if (positive && s <= 0) throw usage(`--${name} needs a number of seconds above 0.`)
  if (s > MAX_SECONDS) throw usage(`--${name} must be at most ${MAX_SECONDS} seconds.`)
  return Math.round(s * 1000)
}

/** RunOverrides from the exec flags (cli-spec 6.2(1)); `execMode` is always true. */
export function overridesFromFlags(v: Values): RunOverrides {
  const o: RunOverrides = { execMode: true }
  const mode = str(v, 'permission-mode')
  if (mode !== undefined) {
    if (!isPermissionMode(mode)) throw usage(`--permission-mode must be one of ${findCommand('exec')?.flags.find((f) => f.name === 'permission-mode')?.values?.join(', ')}.`)
    o.permissionMode = mode
  }
  if (v['no-auto-continue'] === true) o.autoContinue = false
  if (str(v, 'max-auto-continues') !== undefined) o.maxAutoContinues = intFlag('max-auto-continues', str(v, 'max-auto-continues'), 0, MAX_AUTO_CONTINUES_LIMIT)
  const budget = str(v, 'max-budget')
  const cost = str(v, 'max-cost')
  if (budget !== undefined && cost !== undefined) throw usage('Give --max-budget or --max-cost, not both (they are the same).')
  const cap = budget ?? cost
  if (cap !== undefined) o.maxBudgetUsd = amount(budget !== undefined ? 'max-budget' : 'max-cost', cap, 'an amount in USD (0 or more)')
  if (v['allow-unpriced-budget'] === true) o.allowUnpricedBudget = true
  if (v['allow-unmerged'] === true) o.allowUnmerged = true
  if (v['allow-peer-messages'] === true) o.allowPeerMessages = true
  if (v['wait-for-reset'] === true) o.waitForReset = true
  const stall = secondsMs('stall-timeout', str(v, 'stall-timeout'), true)
  if (stall !== undefined) o.execStallTimeoutMs = stall

  const policy: Partial<HeadlessDecisionPolicy> = {}
  const pick = <K extends 'permission' | 'rules' | 'mcpInstall' | 'question' | 'proposal' | 'merge'>(key: K, flag: string): void => {
    const c = choice(v, flag)
    if (c !== undefined) policy[key] = c as HeadlessDecisionPolicy[K]
  }
  pick('permission', 'on-permission')
  pick('rules', 'on-rules')
  pick('mcpInstall', 'on-mcp-install')
  pick('question', 'on-question')
  pick('proposal', 'on-proposal')
  pick('merge', 'on-merge')
  if (str(v, 'max-auto-denials') !== undefined) policy.maxAutoDenials = intFlag('max-auto-denials', str(v, 'max-auto-denials'), 0, MAX_AUTO_DENIALS_LIMIT)
  const wait = secondsMs('wait-timeout', str(v, 'wait-timeout'))
  if (wait !== undefined) policy.waitTimeoutMs = wait
  const grace = secondsMs('human-grace', str(v, 'human-grace'))
  if (grace !== undefined) policy.humanGraceMs = grace
  // A partial policy: the host fills the missing choices with DEFAULT_HEADLESS_DECISION_POLICY.
  if (Object.keys(policy).length) o.decisionPolicy = policy as HeadlessDecisionPolicy
  return o
}

/** True when the overrides widen the project's settings (they then need 'configure'). No project: a quick run. */
export function overridesNeedConfigure(project: Project | undefined, o: RunOverrides): boolean {
  const p = project ?? ({ permissionMode: 'default' } as unknown as Project)
  return overridesWidening(p, o).length > 0
}

/** The prompt: `text` (a positional or --prompt), '-' reads stdin, none reads a non-TTY stdin. Empty is exit 2. */
async function readPrompt(ctx: CliContext, text: string | undefined, emptyMessage: string): Promise<string> {
  let prompt: string
  if (text === '-' || (text === undefined && !ctx.io.stdinIsTTY)) prompt = await execIo.readStdin(EXEC_STDIN_MAX_BYTES)
  else prompt = text ?? ''
  if (Buffer.byteLength(prompt, 'utf8') > EXEC_STDIN_MAX_BYTES) throw usage('The prompt is larger than 1024 KB.')
  if (!prompt.trim()) throw usage(emptyMessage)
  return prompt
}

/** Starting or continuing a run from inside an OrgAI-managed agent worktree is refused (cli-spec 4.2). */
function refuseManagedWorktree(managed: { mainCheckout: string } | undefined): void {
  if (managed) {
    throw usage(`This folder is an OrgAI agent worktree. Start or continue runs from the main checkout: ${managed.mainCheckout}`)
  }
}

export const UNREGISTERED_MESSAGE =
  'This folder is not an OrgAI project. Use --quick for a Chat run in this folder, --create-project to make it a project, or --project <id-or-folder>.'

/** A host RPC failure as a CliError: a refused input is a usage error, anything else exit 1. */
function hostFailure(e: unknown): CliError {
  if (e instanceof CliError) return e
  const data = (e as Partial<HostCallError>)?.data
  const message = e instanceof Error ? e.message : String(e)
  return new CliError(message, data?.code === 'bad_request' ? EXIT.usage : EXIT.failure)
}

async function call<T>(client: HostClient, method: string, params: unknown[]): Promise<T> {
  try {
    return await client.call<T>(method, params, { timeoutMs: 120_000 })
  } catch (e) {
    throw hostFailure(e)
  }
}

/** The connection a command works through; `needConfigure` reconnects with 'configure' added. */
class Session {
  scopes: HostScope[]
  readonly inproc: EnsuredHost['inproc']
  private base: HostClient
  /** Once a run is followed: the follower's client (replaced after a reconnect). */
  private follower: RunStream | undefined

  constructor(
    private readonly ctx: CliContext,
    host: EnsuredHost,
    scopes: HostScope[]
  ) {
    this.base = host.client
    this.inproc = host.inproc
    this.scopes = scopes
  }

  get client(): HostClient {
    return this.follower?.client ?? this.base
  }

  follow(stream: RunStream): void {
    this.follower = stream
  }

  checkGranted(scope: HostScope): void {
    const granted = this.client.hello.grantedScopes
    if (Array.isArray(granted) && !granted.includes(scope)) {
      throw new CliError(`The OrgAI host did not grant the '${scope}' access this needs.`, EXIT.failure)
    }
  }

  async needConfigure(): Promise<void> {
    if (this.scopes.includes('configure')) return
    const scopes: HostScope[] = [...this.scopes, 'configure']
    const res = await this.ctx.connect(scopes, { clientKind: 'cli', waitStartingMs: 2000 })
    if (!res.ok) throw connectFailure(res)
    this.base.close()
    this.base = res.client
    this.scopes = scopes
    this.checkGranted('configure')
  }

  async cleanup(): Promise<void> {
    this.follower?.close()
    this.base.close()
    if (this.inproc) await this.inproc.stop(true).catch((e: unknown) => warn(this.ctx, `Could not stop the in-process host: ${e instanceof Error ? e.message : String(e)}`))
  }
}

async function openSession(ctx: CliContext, configure: boolean): Promise<Session> {
  const scopes: HostScope[] = configure ? ['read', 'operate', 'configure'] : ['read', 'operate']
  const host = await ensureHost(ctx, scopes, { interactive: false })
  const session = new Session(ctx, host, scopes)
  warnVersionSkew(ctx, host.client)
  if (host.started && host.inproc === undefined) note(ctx, 'Started the OrgAI host in the background.')
  try {
    if (configure) session.checkGranted('configure')
  } catch (e) {
    await session.cleanup()
    throw e
  }
  return session
}

// ---------- orgai exec ----------

export const runExec: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, specOf('exec'))
  const v = values as Values
  const overrides = overridesFromFlags(v)
  if (positionals.length > 1) throw usage('Give the prompt as one argument (quote it), or - to read it from stdin.')
  const quick = v.quick === true
  const create = v['create-project'] === true
  const team = choice(v, 'team') as 'default' | 'single' | undefined
  if (quick && create) throw usage('Use --quick or --create-project, not both.')
  if (v['allow-edits'] === true && !quick) throw usage('--allow-edits applies to --quick runs only.')
  if (quick && ctx.globals.project !== undefined) throw usage('--quick runs in the current folder; leave out --project.')
  const prompt = await readPrompt(ctx, positionals[0], 'Give a prompt: orgai exec "<prompt>", or - to read it from stdin.')

  // cwd checks before any host is started: an agent worktree, and (while no host runs) an unregistered folder.
  if (ctx.globals.project === undefined) refuseManagedWorktree(ctx.resolveProject([]).managedWorktree)
  if (!quick) {
    const snap = await ctx.readStore().catch(() => undefined)
    if (snap && snap.hostState === 'stopped') {
      const res = ctx.resolveProject(snap.projects)
      if (res.error) throw usage(res.error)
      refuseManagedWorktree(res.managedWorktree)
      if (!res.project && !create) throw usage(UNREGISTERED_MESSAGE)
    }
  }

  const session = await openSession(ctx, create)
  return runAndFollow(ctx, session, async () => {
    if (quick) {
      if (overridesNeedConfigure(undefined, overrides)) await session.needConfigure()
      return call<RunSummary>(session.client, 'runs:startQuick', [
        { prompt, folder: ctx.cwd, team: team ?? 'single', allowEdits: v['allow-edits'] === true, overrides }
      ])
    }
    const projects = await call<Project[]>(session.client, 'projects:list', [])
    const res = ctx.resolveProject(Array.isArray(projects) ? projects : [])
    if (res.error) throw usage(res.error)
    refuseManagedWorktree(res.managedWorktree)
    let project = res.project
    if (!project) {
      if (!create) throw usage(UNREGISTERED_MESSAGE)
      project = await call<Project>(session.client, 'projects:create', [
        { name: basename(ctx.cwd) || 'Project', path: ctx.cwd, brief: '', mock: ctx.env.ORGAI_MOCK === '1' }
      ])
      if (!isJsonOutput(ctx)) printText(ctx, styleFor(ctx).dim(`Created the project ${safeLine(project.name)}.`))
    }
    if (overridesNeedConfigure(project, overrides)) await session.needConfigure()
    return call<RunSummary>(session.client, 'runs:start', [{ projectId: project.id, prompt, ...(team === 'single' ? { team: 'single' } : {}), overrides }])
  })
}

// ---------- orgai resume --exec ----------

export const runResume: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, specOf('resume'))
  const v = values as Values
  if (v.exec !== true) {
    // Without --exec this is the terminal UI: exec-only flags are a mistake, not something to ignore.
    const tuiOnly = new Set(['prompt', 'exec', ...TUI_FLAGS.map((f) => f.name)])
    const execOnly = (findCommand('resume')?.flags ?? []).find((f) => !tuiOnly.has(f.name) && v[f.name] !== undefined)
    if (execOnly) throw usage(`--${execOnly.name} needs --exec (without it, resume opens the terminal UI).`)
    return runResumeTui(ctx, args)
  }
  for (const f of TUI_FLAGS) if (v[f.name] !== undefined) throw usage(`--${f.name} applies to the terminal UI, not to --exec.`)
  const overrides = overridesFromFlags(v)
  const dash = positionals.filter((p) => p === '-')
  const refs = positionals.filter((p) => p !== '-')
  if (refs.length > 1 || dash.length > 1) throw usage('Use: orgai resume [runId-or-R#] [--prompt <text> | -] --exec')
  const flagPrompt = str(v, 'prompt')
  if (flagPrompt !== undefined && dash.length) throw usage('Give --prompt <text> or -, not both.')
  const prompt = await readPrompt(ctx, flagPrompt ?? (dash.length ? '-' : undefined), 'Give a message to continue with: --prompt "<text>", or - to read it from stdin.')
  if (ctx.globals.project === undefined) refuseManagedWorktree(ctx.resolveProject([]).managedWorktree)

  const session = await openSession(ctx, false)
  return runAndFollow(ctx, session, async () => {
    const src = liveSource(session.client)
    let runId: string
    let runs: RunSummary[]
    let projects: Project[]
    if (refs[0] !== undefined) {
      const r = await resolveRunFromSource(ctx, src, refs[0]).catch((e: unknown) => {
        throw hostFailure(e)
      })
      refuseManagedWorktree(r.resolution.managedWorktree)
      runId = r.runId
      runs = r.runs
      projects = r.projects
    } else {
      projects = await src.projects().catch((e: unknown) => {
        throw hostFailure(e)
      })
      const res = ctx.resolveProject(projects)
      if (res.error) throw usage(res.error)
      refuseManagedWorktree(res.managedWorktree)
      if (!res.project) throw usage('This folder is not an OrgAI project; give a run id, or pass --project.')
      runs = await src.runs(res.project.id).catch((e: unknown) => {
        throw hostFailure(e)
      })
      const ended = runs.find((r) => !isOpenStatus(r.status))
      if (!ended) throw usage('This project has no ended run to resume.')
      runId = ended.id
    }
    const from = runs.find((r) => r.id === runId)
    const project = from ? projects.find((p) => p.id === from.projectId) : undefined
    if (overridesNeedConfigure(project, overrides)) await session.needConfigure()
    return call<RunSummary>(session.client, 'runs:continue', [{ runId, text: prompt, overrides, exec: true }])
  })
}

// ---------- Following ----------

interface RunState {
  summary: RunSummary
  agents: Record<string, AgentInstance>
  toolNames: Map<string, string>
  word?: string
}

/** A short word per outcome for the text summary line. */
export const OUTCOME_LABEL: Record<ExecOutcome, string> = {
  completed: 'Completed',
  'completed-unplanned': 'Completed',
  'unmerged-conflicts': 'Unmerged conflicts',
  blocked: 'Blocked',
  'incomplete-plan': 'Plan not finished',
  'needs-decision': 'Needs a decision',
  'budget-exceeded': 'Budget reached',
  'rate-limited': 'Usage limit reached',
  'auth-error': 'Sign-in failed',
  failed: 'Failed',
  stalled: 'Stalled',
  interrupted: 'Interrupted'
}

const signalCode = (sig: 'SIGINT' | 'SIGTERM'): number => (sig === 'SIGTERM' ? EXIT.sigterm : EXIT.sigint)

/** The root agent's last text (never a harness row): the run's answer. */
export function lastRootText(rec: Pick<RunRecord, 'agents' | 'transcript'> | null | undefined): string | null {
  if (!rec) return null
  const rootId = Object.values(rec.agents ?? {}).find((a) => a.parentId === null)?.id ?? 'root'
  for (let i = rec.transcript.length - 1; i >= 0; i--) {
    const e = rec.transcript[i]
    if (e.agentId === rootId && e.block.kind === 'text' && e.source !== 'harness' && e.block.text.trim()) return e.block.text
  }
  return null
}

/** The one-card PendingCards for a *.request event. */
function cardOf(ev: RunEvent): Partial<PendingCards> | undefined {
  switch (ev.type) {
    case 'permission.request':
      return { permissions: [ev.request] }
    case 'question.request':
      return { questions: [ev.question] }
    case 'proposal.request':
      return { proposals: [ev.proposal] }
    case 'rules.request':
      return { ruleRequests: [ev.request] }
    case 'merge.request':
      return { mergeReviews: [ev.review] }
    case 'mcpInstall.request':
      return { mcpInstalls: [ev.request] }
    default:
      return undefined
  }
}

/**
 * Start the run (signals already armed), follow its chain until run.finalized and print the result. Always cleans
 * up the session (and an inproc host).
 */
async function runAndFollow(ctx: CliContext, session: Session, start: () => Promise<RunSummary>): Promise<number> {
  const json = isJsonOutput(ctx)
  const stream = ctx.globals.outputFormat === 'stream-json'
  const st = styleFor(ctx)

  let finished = false
  /** A run.finalized (or a final snapshot) was seen and printed. */
  let finalized = false
  let signal: 'SIGINT' | 'SIGTERM' | undefined
  let resolveExit!: (code: number) => void
  const exit = new Promise<number>((r) => (resolveExit = r))
  const done = (code: number): void => {
    if (finished) return
    finished = true
    resolveExit(code)
  }

  const runs = new Map<string, RunState>()
  const followed = new Set<string>()
  let newest: string | undefined
  let execChainId: string | undefined
  let follower: RunStream | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  let index = new Map<string, number>()
  let nextIndex = 1
  const printed = new Set<string>()
  let lastActive: RunRecord | undefined

  const tagOf = (runId: string): string => {
    if (!index.has(runId)) index.set(runId, nextIndex++)
    return runTag(index.get(runId))
  }
  const stateOf = (runId: string, seed?: RunSummary): RunState => {
    let s = runs.get(runId)
    if (!s) {
      s = { summary: seed ?? ({ id: runId, projectId: '', kind: 'work', prompt: '', status: 'starting', startedAt: Date.now(), totalCostUsd: 0 } as RunSummary), agents: {}, toolNames: new Map() }
      runs.set(runId, s)
    }
    return s
  }
  const agentOf = (runId: string, agentId: string): AgentInstance | undefined => {
    const own = runs.get(runId)?.agents[agentId]
    if (own) return own
    for (const id of followed) {
      const a = runs.get(id)?.agents[agentId]
      if (a) return a
    }
    return undefined
  }
  const adopt = (runId: string): void => {
    if (followed.has(runId)) return
    // The host sends a run we did not subscribe to only when it follows the chain: it is the newest member.
    followed.add(runId)
    newest = runId
  }

  const requestStop = (): void => {
    const target = newest
    if (!target) return
    session.client.call('runs:stop', [target], { timeoutMs: EXEC_STOP_WAIT_MS }).catch((e: unknown) => {
      if (!finished) warn(ctx, `Could not stop the run: ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  const printEntry = (runId: string, e: TranscriptEntry): void => {
    if (printed.has(`${runId}:${e.id}`)) return
    printed.add(`${runId}:${e.id}`)
    const s = stateOf(runId)
    if (e.block.kind === 'tool_use') s.toolNames.set(e.block.id, e.block.name)
    if (json) return
    const line = transcriptLine(e, { st, prefix: st.dim(tagOf(runId)), agentName: (id) => agentLabel(agentOf(runId, id)), toolName: (id) => s.toolNames.get(id) })
    if (line !== null) printText(ctx, line)
  }
  const printStatus = (runId: string): void => {
    const s = stateOf(runId)
    const word = statusWordOfSummary(s.summary)
    if (word === s.word) return
    s.word = word
    if (!json) printText(ctx, `${st.dim(tagOf(runId))} ${styleStatus(st, word)}${s.summary.status === 'error' && s.summary.error ? ` ${safeLine(s.summary.error)}` : ''}`)
  }
  const printCards = (runId: string, cards: Partial<PendingCards> | undefined): void => {
    if (json || !cards) return
    const s = stateOf(runId)
    for (const w of pendingItems({ ...s.summary, status: 'running' }, cards, s.agents)) {
      printText(ctx, `${st.dim(tagOf(runId))} ${st.yellow('Needs you:')} ${safeLine(w.label)} ${st.dim(`(request ${safeLine(w.key)})`)}`)
    }
  }

  /** The run ended: print the result (json / stream-json / text) and resolve the exit code. */
  const finalize = (outcome: ExecOutcome, summary: RunSummary, chainId: string | undefined): void => {
    if (finished) return
    finished = true
    finalized = true
    if (stopTimer) clearTimeout(stopTimer)
    void (async () => {
      const code = signal ? signalCode(signal) : (EXEC_OUTCOME_EXIT_CODE[outcome] ?? EXIT.failure)
      const rec =
        (await session.client.call<RunRecord | null>('runs:get', [summary.id], { timeoutMs: 60_000 }).catch(() => null)) ??
        (lastActive?.summary.id === summary.id ? lastActive : null)
      const state = runs.get(summary.id)
      const status = statusText(statusViewOf({ summary, plan: rec?.plan, agents: rec?.agents ?? state?.agents }))
      const result = lastRootText(rec)
      const doc: Json = { runId: summary.id, execChainId: chainId ?? summary.overrides?.execChainId ?? execChainId ?? summary.id, outcome, exitCode: code, status, summary, result }
      if (stream) emitLine(ctx, { type: 'result', ...doc })
      else if (json) emit(ctx, doc, () => [])
      else printText(ctx, `${st.bold(OUTCOME_LABEL[outcome] ?? safeLine(outcome))} · ${styleStatus(st, status)} · ${costText(summary)}`)
      resolveExit(code)
    })()
  }

  const applyEvent = (ev: RunEvent): void => {
    const runId = ev.runId
    adopt(runId)
    const s = stateOf(runId)
    switch (ev.type) {
      case 'run.finalized':
        s.summary = ev.summary
        finalize(ev.outcome, ev.summary, ev.execChainId)
        return
      case 'run.status':
        s.summary = {
          ...s.summary,
          status: ev.status,
          ...(ev.error !== undefined ? { error: ev.error } : {}),
          ...(ev.pausedUntil !== undefined ? { pausedUntil: ev.pausedUntil } : {}),
          ...(ev.pauseReason !== undefined ? { pauseReason: ev.pauseReason } : {}),
          ...(ev.autoResume !== undefined ? { autoResume: ev.autoResume } : {}),
          ...(ev.endedBy !== undefined ? { endedBy: ev.endedBy } : {}),
          ...(ev.endedWhile !== undefined ? { endedWhile: ev.endedWhile } : {})
        }
        printStatus(runId)
        return
      case 'run.title':
        s.summary = { ...s.summary, title: ev.title }
        return
      case 'agent.upsert':
        s.agents[ev.agent.id] = ev.agent
        return
      case 'transcript':
        printEntry(runId, ev.entry)
        return
      case 'plan.updated':
        if (!json) printText(ctx, `${st.dim(tagOf(runId))} ${planUpdateLine(ev.plan)}`)
        return
      default:
        printCards(runId, cardOf(ev))
    }
  }

  const onEvent = (p: RunsEventParams): void => {
    if (finished) return
    const ev = p.event
    if (typeof p.seq !== 'number' && ev.type === 'agent.partial') {
      adopt(ev.runId)
      if (stream) emitLine(ctx, { type: 'event', atSeq: p.atSeq, event: ev })
      return
    }
    if (stream) emitLine(ctx, { type: 'event', ...(typeof p.seq === 'number' ? { seq: p.seq } : {}), event: ev })
    applyEvent(ev)
  }

  const onSnapshot = (res: SnapshotResult, firstTime: boolean): void => {
    const snap = res.snapshot
    if (stream) {
      const active = snap.activeRun ? recordWithoutImages(snap.activeRun) : undefined
      emitLine(ctx, { type: 'snapshot', hostInstanceId: res.hostInstanceId, seq: res.seq, filterKey: res.filterKey, snapshot: { ...snap, ...(active ? { activeRun: active } : {}) } })
    }
    const seen: RunSummary[] = []
    for (const sum of [...snap.recentEndedRuns, ...snap.liveRuns, ...(snap.activeRun ? [snap.activeRun.summary] : [])]) {
      if (!followed.has(sum.id)) {
        if (sum.resumedFrom && followed.has(sum.resumedFrom)) adopt(sum.id)
        else continue
      }
      stateOf(sum.id, sum).summary = sum
      seen.push(sum)
    }
    const active = snap.activeRun
    if (active && followed.has(active.summary.id)) {
      lastActive = active
      const s = stateOf(active.summary.id, active.summary)
      s.agents = { ...active.agents }
      // Every row the run wrote so far (it started a moment ago); a resync prints only what was missed.
      for (const e of active.transcript) printEntry(active.summary.id, e)
      if (firstTime) printCards(active.summary.id, snap.pendingCards?.[active.summary.id])
    }
    // Newest followed run: the one started last.
    let best: RunState | undefined
    for (const id of followed) {
      const s = runs.get(id)
      if (s && (!best || s.summary.startedAt >= best.summary.startedAt)) best = s
    }
    if (best) newest = best.summary.id
    for (const id of followed) if (runs.has(id)) printStatus(id)
    // The run finished before we subscribed: its summary already carries the outcome.
    const final = seen.find((sum) => sum.execOutcome !== undefined && sum.id === newest) ?? seen.find((sum) => sum.execOutcome !== undefined)
    if (final?.execOutcome) finalize(final.execOutcome, final, final.overrides?.execChainId)
  }

  const offSignal = ctx.signals.onInterrupt((sig) => {
    if (finished) return
    if (signal) {
      warn(ctx, 'Exiting without waiting for the run to end.')
      done(signalCode(sig))
      return
    }
    signal = sig
    warn(ctx, 'Stopping the run... (press Ctrl+C again to exit now)')
    requestStop()
    stopTimer = setTimeout(() => {
      if (finished) return
      warn(ctx, `The run did not confirm its end within ${Math.round(execIo.stopWaitMs / 1000)} s.`)
      done(signalCode(sig))
    }, execIo.stopWaitMs)
  })

  const work = (async (): Promise<void> => {
    const started = await start()
    if (finished) return
    followed.add(started.id)
    newest = started.id
    execChainId = started.overrides?.execChainId ?? started.id
    stateOf(started.id, started)
    try {
      const list = await session.client.call<RunSummary[]>('runs:list', [started.projectId], { timeoutMs: 30_000 })
      if (Array.isArray(list)) {
        index = runIndexMap(list.filter((r) => r.projectId === started.projectId))
        nextIndex = Math.max(0, ...index.values()) + 1
      }
    } catch {
      // Tags fall back to R1, R2... in the order runs appear.
    }
    if (finished) return
    // A signal that came while the run was starting stops it now.
    if (signal) requestStop()
    follower = new RunStream({
      client: session.client,
      connect: () => ctx.connect(session.scopes, { clientKind: 'cli', waitStartingMs: 2000 }),
      subscribeInput: () => ({ runIds: [...followed], followChains: true, nonInteractive: true, ...(newest ? { includeActiveRunRecord: newest } : {}) }),
      onEvent,
      onSnapshot,
      onGone: () => {
        if (finished) return
        warn(ctx, "The OrgAI host went away; the run's outcome is unknown.")
        done(EXIT.failure)
      },
      stopped: () => finished,
      timers: execIo.timers
    })
    // The reconnects replace the client; runs:stop and runs:get go through the current one.
    session.follow(follower)
    try {
      await follower.start()
    } catch (e) {
      throw new CliError(`Could not follow the run: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
    }
  })()

  let failure: unknown
  work.catch((e: unknown) => {
    failure = e
    if (!finished) {
      finished = true
      resolveExit(-1)
    }
  })

  const code = await exit
  if (stopTimer) clearTimeout(stopTimer)
  offSignal()
  await session.cleanup()
  if (code === -1) throw failure instanceof CliError ? failure : hostFailure(failure)
  if (json && !finalized) {
    // Interrupted (or the host went away) before an outcome: still give scripts a final document.
    const doc: Json = { runId: newest ?? null, execChainId: execChainId ?? null, outcome: null, exitCode: code, status: null, summary: null, result: null }
    if (stream) emitLine(ctx, { type: 'result', ...doc })
    else emit(ctx, doc, () => [])
  }
  return code
}
