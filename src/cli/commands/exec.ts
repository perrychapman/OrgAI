/**
 * `orgai exec [options] [--] [prompt|-]` (alias `orgai -p`) and `orgai resume [runId-or-R#] [--prompt <text> | -]
 * --exec` (cli-spec 4, 6.2).
 *
 * - Flags map to RunOverrides (always `execMode: true`): --permission-mode, --no-auto-continue,
 *   --max-auto-continues, --max-budget / --max-cost (USD, finite >= 0; not both), --allow-unpriced-budget,
 *   --allow-unmerged, --strict-delegation, --goal balanced|speed|cost, --allow-peer-messages, --wait-for-reset, --stall-timeout s, --on-* (decisionPolicy),
 *   --max-auto-denials. Bad values are usage errors (exit 2); a `wait` policy is refused.
 * - The prompt is the positional, else --prompt-file <path|-> (resume: --prompt, --prompt-file), else stdin ('-', or no
 *   positional with a non-TTY stdin); at most 1 MB. Empty: exit 2. Untrusted text belongs in --prompt-file or stdin,
 *   never argv: on Windows the .cmd shim hands arguments to cmd.exe (review M12).
 * - Project: --project, else the folder (cli-spec 4). Inside an OrgAI-managed agent worktree: exit 2 naming the main
 *   checkout. An unregistered folder is exit 2 unless --quick (a Chat run in this folder) or --create-project
 *   (projects:create, needs 'configure').
 * - Scopes 'read' + 'operate', plus 'configure' when creating a project or when the overrides widen the project's
 *   settings (overridesWidening).
 * - The run's chain is followed (runs:subscribe, followChains) until a `run.finalized` for a followed run; the exit
 *   code is EXEC_OUTCOME_EXIT_CODE[outcome]. A snapshot that already carries summary.execOutcome ends at once.
 * - Output: text prints transcript rows, status words, run `log` events of level warn / error and the run-start
 *   `Models:` info line (execLogLine), then `<outcome> · <status> · <cost>`;
 *   json prints one document at the end; stream-json prints every event, then a `result` line.
 * - SIGINT / SIGTERM: the first calls runs:stop on the newest followed run and waits up to 10 s for run.finalized,
 *   then exits 130 / 143; a second signal exits at once.
 * - The in-process host is stopped (force) before the command returns.
 */
import { fstatSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { MAX_AUTO_CONTINUES_LIMIT, projectConnection } from '../../shared/defaults'
import {
  EXEC_OUTCOME_EXIT_CODE,
  MAX_TIMER_DELAY_MS,
  STAFFING_GOALS,
  EFFORTS,
  isEffort,
  isPermissionMode,
  isStaffingGoal,
  isModelTier,
  EVOLVE_STRATEGIES,
  type ConnectionInfo,
  type ProviderModel,
  type AgentInstance,
  type EvolvePostRunResult,
  type EvolveStrategy,
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
  type TeamFilesStatus,
  type TranscriptEntry
} from '../../shared/types'
import { newestContinuable } from '../../shared/view/runChains'
import { runIndexMap, runTag } from '../../shared/view/runLabels'
import { statusText } from '../../shared/view/runStatus'
import { overridesWidening } from '../../main/runtime/runOverrides'
import { EXEC_INPROC, ensureHost, connectFailure, missingScopesError, type EnsuredHost } from '../client/ensureHost'
import { RunStream, defaultRunStreamTimers, type RunStreamTimers, type SnapshotResult } from '../client/runStream'
import { TUI_FLAGS, findCommand } from '../commandTable'
import { parseFlags, type FlagSpec } from '../flags'
import { readStdinText } from '../manage'
import { emit, emitLine, isJsonOutput, note, printText, safe, safeLine, styleFor, styleStatus, warn, type Json } from '../output'
import { agentLabel, costText, eventWithoutImages, pendingItems, planUpdateLine, recordWithoutImages, statusViewOf, statusWordOfSummary, transcriptLine } from '../render'
import { staffingLine } from '../staffingText'
import { pendingTeamFilesLine } from '../approvalText'
import { loadImages } from '../images'
import { compactionLine } from '../../shared/view/compactionText'
import { liveSource, resolveRunFromSource } from '../runRef'
import { CliError, EXIT, HOST_STARTING_WAIT_MS, type CliContext, type CommandFn, type HostCallError, type HostClient } from '../types'
import { intFlag } from './runs'
import { runPausedAction } from './resumeActions'
import { runResumeTui } from './tui'

export const EXEC_STDIN_MAX_BYTES = 1024 * 1024
export const EXEC_STOP_WAIT_MS = 10_000
export const MAX_AUTO_DENIALS_LIMIT = 10_000
/** The longest timer the host can arm (MAX_TIMER_DELAY_MS, about 24.8 days), in whole seconds. */
const MAX_SECONDS = Math.floor(MAX_TIMER_DELAY_MS / 1000)

/** Swappable in tests: stdin, the reconnect timers and the stop wait. */
/** A piped stdin that sends nothing for this long, next to a prompt argument, is ignored (an inherited pipe nobody writes to). */
export const EXEC_STDIN_IDLE_MS = 3000

/** True when stdin is a regular file (`orgai exec "..." < notes.txt`): it always ends, so it is read whole with no idle limit. */
function stdinIsRegularFile(): boolean {
  try {
    return fstatSync(0).isFile()
  } catch {
    return false
  }
}

/**
 * All of a non-TTY stdin next to a prompt argument: '' when it ends empty or sends no byte within `idleMs` (`onIdle` is
 * then called, so the caller can say the input was left out rather than drop it silently). Unlike the prompt-on-stdin
 * read it never waits forever for a pipe nobody writes to. The limit covers only the wait for the first byte, and a
 * regular file has none.
 */
function readOptionalStdin(maxBytes: number, idleMs: number, onIdle?: () => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const s = process.stdin
    const chunks: Buffer[] = []
    let size = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (err?: CliError): void => {
      if (timer) clearTimeout(timer)
      s.off('data', onData)
      s.off('end', onEnd)
      s.off('error', onEnd)
      s.pause()
      if (err) reject(err)
      else resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const onData = (c: Buffer | string): void => {
      if (timer) clearTimeout(timer)
      timer = undefined
      const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c))
      size += b.length
      if (size > maxBytes) return finish(usage('The input on stdin is larger than 1024 KB.'))
      chunks.push(b)
    }
    const onEnd = (): void => finish()
    s.on('data', onData)
    s.on('end', onEnd)
    s.on('error', onEnd)
    if (!stdinIsRegularFile()) {
      timer = setTimeout(() => {
        onIdle?.()
        onEnd()
      }, idleMs)
    }
  })
}

export const execIo = {
  readStdin: (maxBytes: number, opts: { idleMs?: number; onIdle?: () => void } = {}): Promise<string> =>
    opts.idleMs !== undefined ? readOptionalStdin(maxBytes, opts.idleMs, opts.onIdle) : readStdinText(maxBytes, 'The prompt on stdin'),
  timers: defaultRunStreamTimers as RunStreamTimers,
  stopWaitMs: EXEC_STOP_WAIT_MS
}

const usage = (message: string): CliError => new CliError(message, EXIT.usage)

/** A parseFlags spec from a commandTable entry (value flags are strings, the rest booleans). */
function specOf(command: string): FlagSpec {
  const spec: FlagSpec = {}
  for (const f of findCommand(command)?.flags ?? []) {
    spec[f.name] = {
      type: f.takesValue || f.optionalValue ? 'string' : 'boolean',
      ...(f.repeatable ? { multiple: true } : {}),
      ...(f.optionalValue ? { optionalValue: true } : {}),
      ...(f.short ? { short: f.short } : {})
    }
  }
  return spec
}

type Values = Record<string, string | boolean | string[] | undefined>

const strs = (v: Values, name: string): string[] => (Array.isArray(v[name]) ? (v[name] as string[]) : [])

const str = (v: Values, name: string): string | undefined => (typeof v[name] === 'string' ? (v[name] as string) : undefined)

function choice(v: Values, name: string): string | undefined {
  const raw = str(v, name)
  if (raw === undefined) return undefined
  const allowed = findCommand('exec')?.flags.find((f) => f.name === name)?.values ?? findCommand('resume')?.flags.find((f) => f.name === name)?.values
  // Nothing else can answer a card of an orgai run (cli-standalone-default.md 4.3): a policy that waits is refused.
  if (raw === 'wait') throw usage(`--${name} wait is not available: only this terminal could answer, and exec has none. Use ${allowed?.join(', ')}.`)
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
  if (v['strict-delegation'] === true) o.strictDelegation = true
  const goal = str(v, 'goal')
  if (goal !== undefined) {
    if (!isStaffingGoal(goal)) throw usage(`--goal must be one of ${STAFFING_GOALS.join(', ')}.`)
    o.goal = goal
  }
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
  // A partial policy: the host fills the missing choices with DEFAULT_HEADLESS_DECISION_POLICY.
  if (Object.keys(policy).length) o.decisionPolicy = policy as HeadlessDecisionPolicy
  return o
}

/** True when the overrides widen the project's settings (they then need 'configure'). No project: a quick run. */
export function overridesNeedConfigure(project: Project | undefined, o: RunOverrides): boolean {
  const p = project ?? ({ permissionMode: 'default' } as unknown as Project)
  return overridesWidening(p, o).length > 0
}

/**
 * The text of `--prompt-file <path>` (relative to the cwd; a regular file of at most EXEC_STDIN_MAX_BYTES, read as
 * UTF-8, a leading BOM dropped). Untrusted text goes here or on stdin, never on argv: on Windows the `orgai` .cmd shim
 * passes arguments through cmd.exe (review M12). Any read failure is a usage error naming the file.
 */
export function readPromptFile(ctx: CliContext, file: string): string {
  const p = resolve(ctx.cwd, file)
  let size: number
  try {
    const st = statSync(p)
    if (!st.isFile()) throw usage(`--prompt-file: ${safeLine(p)} is not a file.`)
    size = st.size
  } catch (e) {
    if (e instanceof CliError) throw e
    throw usage(`--prompt-file: could not read ${safeLine(p)}: ${safeLine(e instanceof Error ? e.message : String(e))}`)
  }
  if (size > EXEC_STDIN_MAX_BYTES) throw usage('The prompt is larger than 1024 KB.')
  let text: string
  try {
    text = readFileSync(p, 'utf8')
  } catch (e) {
    throw usage(`--prompt-file: could not read ${safeLine(p)}: ${safeLine(e instanceof Error ? e.message : String(e))}`)
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * The prompt: `text` (a positional or --prompt), else `file` (--prompt-file; '-' reads stdin), '-' reads stdin, none
 * reads a non-TTY stdin. The caller refuses giving both. Empty is exit 2.
 */
export async function readPrompt(ctx: CliContext, text: string | undefined, file: string | undefined, emptyMessage: string, combineStdin = false): Promise<string> {
  let prompt: string
  if (file !== undefined && file !== '-') prompt = readPromptFile(ctx, file)
  else if (file === '-' || text === '-' || (text === undefined && !ctx.io.stdinIsTTY)) prompt = await execIo.readStdin(EXEC_STDIN_MAX_BYTES)
  else if (combineStdin && text !== undefined && text.trim() && !ctx.io.stdinIsTTY) {
    // `git diff | orgai exec "review this"`: the argument is the instruction, the piped text its input.
    const piped = await execIo.readStdin(EXEC_STDIN_MAX_BYTES, {
      idleMs: EXEC_STDIN_IDLE_MS,
      onIdle: () =>
        warn(ctx, `Nothing arrived on stdin within ${EXEC_STDIN_IDLE_MS / 1000} s, so it was left out of the prompt. For a slow producer, write its output to a file first: orgai exec "<prompt>" < file`)
    })
    prompt = piped.trim() ? `<stdin>\n${piped.replace(/\n$/, '')}\n</stdin>\n\n${text}` : text
  } else prompt = text ?? ''
  if (Buffer.byteLength(prompt, 'utf8') > EXEC_STDIN_MAX_BYTES) throw usage('The prompt is larger than 1024 KB.')
  if (!prompt.trim()) throw usage(emptyMessage)
  return prompt
}

/** Starting or continuing a run from inside an OrgAI-managed agent worktree is refused (cli-spec 4.2). */
export function refuseManagedWorktree(managed: { mainCheckout: string } | undefined): void {
  if (managed) {
    throw usage(`This folder is an OrgAI agent worktree. Start or continue runs from the main checkout: ${managed.mainCheckout}`)
  }
}

export const UNREGISTERED_MESSAGE =
  'This folder is not an OrgAI project. Use --quick for a Chat run in this folder, --create-project to make it a project, or --project <id-or-folder>.'

/** A host RPC failure as a CliError: a refused input is a usage error, anything else exit 1. */
export function hostFailure(e: unknown): CliError {
  if (e instanceof CliError) return e
  const data = (e as Partial<HostCallError>)?.data
  const message = e instanceof Error ? e.message : String(e)
  return new CliError(message, data?.code === 'bad_request' ? EXIT.usage : EXIT.failure)
}

export async function call<T>(client: HostClient, method: string, params: unknown[]): Promise<T> {
  try {
    return await client.call<T>(method, params, { timeoutMs: 120_000 })
  } catch (e) {
    throw hostFailure(e)
  }
}

/** The connection a command works through; `needConfigure` reconnects with 'configure' added. */
export class Session {
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
    // Names the missing scope.
    const missing = missingScopesError(this.client, [scope])
    if (missing) throw missing
  }

  async needConfigure(): Promise<void> {
    if (this.scopes.includes('configure')) return
    const scopes: HostScope[] = [...this.scopes, 'configure']
    const res = await this.ctx.connect(scopes, { clientKind: 'cli', waitStartingMs: HOST_STARTING_WAIT_MS })
    if (!res.ok) throw connectFailure(res)
    this.base.close()
    this.base = res.client
    this.scopes = scopes
    this.checkGranted('configure')
  }

  /** Close the run follower only (the base connection and an in-process host stay up for the next run of a loop). */
  releaseFollower(): void {
    this.follower?.close()
    this.follower = undefined
  }

  async cleanup(): Promise<void> {
    this.follower?.close()
    this.base.close()
    if (this.inproc) await this.inproc.stop(true).catch((e: unknown) => warn(this.ctx, `Could not stop the in-process host: ${e instanceof Error ? e.message : String(e)}`))
  }
}

/**
 * Write `--output-last-message`: a temporary file beside the destination, then a rename over it, so a symlink or a hard
 * link at the destination is replaced, never written through. An existing destination that is not a regular file (a
 * directory, a device, a link) is refused.
 */
export function writeLastMessage(file: string, text: string): void {
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (existing && !existing.isFile()) throw new Error(existing.isSymbolicLink() ? 'it is a symbolic link' : 'it is not a regular file')
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

export async function openSession(ctx: CliContext, configure: boolean): Promise<Session> {
  const scopes: HostScope[] = configure ? ['read', 'operate', 'configure'] : ['read', 'operate']
  const host = await ensureHost(ctx, scopes, { interactive: false, inproc: EXEC_INPROC })
  const session = new Session(ctx, host, scopes)
  try {
    if (configure) session.checkGranted('configure')
  } catch (e) {
    await session.cleanup()
    throw e
  }
  return session
}

/**
 * cli-parity 3.4: one stderr line (text mode) before a run starts while the project's team files have changes waiting
 * for approval. A failed lookup says nothing: the run's own warning (TeamFilesService.beforeRun) still comes.
 */
export async function noteTeamFiles(ctx: CliContext, client: HostClient, projectId: string): Promise<void> {
  if (isJsonOutput(ctx)) return
  try {
    const list = await client.call<TeamFilesStatus[]>('teamFiles:listAttention', [], { timeoutMs: 30_000 })
    const line = pendingTeamFilesLine(Array.isArray(list) ? list : [], projectId)
    if (line) note(ctx, line)
  } catch {
    // the run's warning covers it
  }
}

/**
 * `--model` of a project run: a tier name (fast, everyday, deep, top) resolves to the model the project's connection maps
 * it to (connections:list tierModels); anything else must be a model id of that connection (models:list). Refused here,
 * before a run exists, with the choices named.
 */
export async function resolveModelSelection(client: HostClient, project: Project, raw: string): Promise<{ model: string; connection: string }> {
  const connection = projectConnection(project)
  const want = raw.trim()
  if (isModelTier(want)) {
    const infos = await call<ConnectionInfo[]>(client, 'connections:list', [])
    const tierModels = (Array.isArray(infos) ? infos : []).find((i) => i.connection.id === connection)?.connection.tierModels
    const model = tierModels?.[want]
    if (!model) throw usage(`--model ${want}: the connection "${safeLine(connection)}" maps no model to the ${want} tier. Use a model id (orgai models list --connection ${safeLine(connection)}).`)
    return { model, connection }
  }
  const models = await call<ProviderModel[]>(client, 'models:list', [{ connection }])
  const list = Array.isArray(models) ? models : []
  if (!list.some((m) => m.id === want && m.connection === connection)) {
    throw usage(`--model ${safeLine(want)}: not a model of the connection "${safeLine(connection)}". Use a tier (fast, everyday, deep, top) or an id from: orgai models list --connection ${safeLine(connection)}`)
  }
  return { model: want, connection }
}

/** `--evolve` (true) or `--evolve=deterministic|hybrid`: what to pass as StartRunInput.evolve, undefined when absent. */
export function evolveFlag(v: Values): true | EvolveStrategy | undefined {
  const raw = v.evolve
  if (raw === undefined || raw === false) return undefined
  if (raw === true) return true
  if (typeof raw === 'string' && (EVOLVE_STRATEGIES as readonly string[]).includes(raw)) return raw as EvolveStrategy
  throw usage(`--evolve takes ${EVOLVE_STRATEGIES.join(' or ')} (attached as --evolve=<strategy>), not "${safeLine(String(raw)).slice(0, 40)}".`)
}

// ---------- orgai exec ----------

export const runExec: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, specOf('exec'))
  const v = values as Values
  const overrides = overridesFromFlags(v)
  if (positionals.length > 1) throw usage('Give the prompt as one argument (quote it), --prompt-file <path>, or - to read it from stdin.')
  const promptFile = str(v, 'prompt-file')
  if (promptFile !== undefined && positionals.length) throw usage('Give the prompt as an argument or with --prompt-file, not both.')
  const quick = v.quick === true
  const create = v['create-project'] === true
  const modelFlag = str(v, 'model')
  const effortFlag = str(v, 'effort')
  const continueRun = v.continue === true
  if (effortFlag !== undefined && !isEffort(effortFlag)) throw usage(`--effort must be one of ${EFFORTS.join(', ')}.`)
  if (quick && (modelFlag !== undefined || effortFlag !== undefined)) throw usage('--model and --effort apply to project runs, not --quick runs.')
  if (continueRun && (quick || create)) throw usage('--continue continues a run of this project; leave out --quick and --create-project.')
  if (continueRun && (modelFlag !== undefined || effortFlag !== undefined)) throw usage('--model and --effort start a new run with those choices; they cannot change a run that --continue continues.')
  if (continueRun && str(v, 'team') !== undefined) throw usage('--team applies to a new run; --continue keeps the run\'s own team.')
  const evolve = evolveFlag(v)
  if (evolve !== undefined && quick) throw usage('--evolve changes the project\'s team; leave out --quick.')
  if (evolve !== undefined && continueRun) throw usage('--evolve applies to a new run; leave out --continue.')
  const quiet = v.quiet === true
  const lastMessageFile = str(v, 'output-last-message')
  const runOutput: RunOutput = { quiet, ...(evolve !== undefined ? { evolve: true } : {}), ...(lastMessageFile !== undefined ? { lastMessageFile: resolve(ctx.cwd, lastMessageFile) } : {}) }
  const team = choice(v, 'team') as 'default' | 'single' | undefined
  if (quick && create) throw usage('Use --quick or --create-project, not both.')
  if (v['allow-edits'] === true && !quick) throw usage('--allow-edits applies to --quick runs only.')
  if (quick && ctx.globals.project !== undefined) throw usage('--quick runs in the current folder; leave out --project.')
  const prompt = await readPrompt(ctx, positionals[0], promptFile, 'Give a prompt: orgai exec "<prompt>", --prompt-file <path>, or - to read it from stdin.', true)
  const images = await loadImages(strs(v, 'image'), ctx.cwd)

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

  // --evolve (the post-run pass changes the team) and --model / --effort (the run's root model and effort) need 'configure'.
  const session = await openSession(ctx, create || evolve !== undefined || modelFlag !== undefined || effortFlag !== undefined)
  return runAndFollow(ctx, session, runOutput, async () => {
    if (quick) {
      if (overridesNeedConfigure(undefined, overrides)) await session.needConfigure()
      return call<RunSummary>(session.client, 'runs:startQuick', [
        { prompt, folder: ctx.cwd, team: team ?? 'single', allowEdits: v['allow-edits'] === true, ...(images.length ? { images } : {}), overrides }
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
      if (!isJsonOutput(ctx) && !quiet) printText(ctx, styleFor(ctx).dim(`Created the project ${safeLine(project.name)}.`))
    }
    if (overridesNeedConfigure(project, overrides)) await session.needConfigure()
    if (continueRun) {
      const runs = await liveSource(session.client).runs(project.id).catch((e: unknown) => {
        throw hostFailure(e)
      })
      const ended = newestContinuable(runs)
      if (!ended) throw usage('This project has no ended work run to continue; start one with: orgai exec "<prompt>"')
      if (!isJsonOutput(ctx) && !quiet) note(ctx, `Continuing run ${safeLine(ended.id)}${ended.title ? ` (${safeLine(ended.title)})` : ''}.`)
      await noteTeamFiles(ctx, session.client, project.id)
      return call<RunSummary>(session.client, 'runs:continue', [{ runId: ended.id, text: prompt, ...(images.length ? { images } : {}), overrides, exec: true }])
    }
    const selection = modelFlag !== undefined ? await resolveModelSelection(session.client, project, modelFlag) : undefined
    await noteTeamFiles(ctx, session.client, project.id)
    return call<RunSummary>(session.client, 'runs:start', [
      {
        projectId: project.id,
        prompt,
        ...(team === 'single' ? { team: 'single' } : {}),
        ...(images.length ? { images } : {}),
        overrides,
        ...(selection ? { modelSelection: selection } : {}),
        ...(effortFlag !== undefined ? { effort: effortFlag } : {}),
        ...(evolve !== undefined ? { evolve } : {})
      }
    ])
  })
}

// ---------- orgai resume --exec ----------

export const runResume: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, specOf('resume'))
  const v = values as Values
  // --now / --cancel-auto-resume act on a paused run (resumeActions.ts); they take no prompt and no exec flags.
  if (v.now === true || v['cancel-auto-resume'] === true) return runPausedAction(ctx, v, positionals)
  if (v.latest === true && positionals.filter((p) => p !== '-').length) throw usage('--latest resumes the newest ended run; leave out the run id.')
  if (v.exec !== true) {
    // Without --exec this is the terminal UI: exec-only flags are a mistake, not something to ignore.
    const tuiOnly = new Set(['prompt', 'exec', 'latest', ...TUI_FLAGS.map((f) => f.name)])
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
  const promptFile = str(v, 'prompt-file')
  if ([flagPrompt !== undefined, promptFile !== undefined, dash.length > 0].filter(Boolean).length > 1) throw usage('Give one of --prompt <text>, --prompt-file <path> or -.')
  const prompt = await readPrompt(ctx, flagPrompt ?? (dash.length ? '-' : undefined), promptFile, 'Give a message to continue with: --prompt "<text>", --prompt-file <path>, or - to read it from stdin.')
  const images = await loadImages(strs(v, 'image'), ctx.cwd)
  if (ctx.globals.project === undefined) refuseManagedWorktree(ctx.resolveProject([]).managedWorktree)

  const session = await openSession(ctx, false)
  return runAndFollow(ctx, session, { quiet: false }, async () => {
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
      const ended = newestContinuable(runs)
      if (!ended) throw usage('This project has no ended work run to resume.')
      runId = ended.id
    }
    const from = runs.find((r) => r.id === runId)
    const project = from ? projects.find((p) => p.id === from.projectId) : undefined
    if (overridesNeedConfigure(project, overrides)) await session.needConfigure()
    if (project) await noteTeamFiles(ctx, session.client, project.id)
    return call<RunSummary>(session.client, 'runs:continue', [{ runId, text: prompt, ...(images.length ? { images } : {}), overrides, exec: true }])
  })
}

/**
 * The text line for a run `log` event, or null when exec does not print it: every warn and error, and of the info
 * logs only the run-start "Models: ..." line (cli-parity 3.1). Sanitized to one line.
 */
export function execLogLine(level: string, message: string, st: ReturnType<typeof styleFor>): string | null {
  const text = safeLine(message)
  if (!text) return null
  if (level === 'warn') return `${st.yellow('Warning:')} ${text}`
  if (level === 'error') return `${st.red('Error:')} ${text}`
  if (level === 'info' && text.startsWith('Models: ')) return `${st.dim('Models:')} ${text.slice('Models: '.length)}`
  return null
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
  'delegation-incomplete': 'Required delegation incomplete',
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
export interface RunOutput {
  /** Text output: only the final answer on stdout (errors and warnings still on stderr). */
  quiet: boolean
  /** Also write the final answer here. */
  lastMessageFile?: string
  /**
   * Team evolution: after the run is finalized, wait for the post-run ratchet pass (org:evolveAfterRun) and report it:
   * an `evolve` member of the json / stream-json result, one stderr line in text mode. The run must have been started
   * with `evolve`, on a session that holds 'configure'.
   */
  evolve?: boolean
  /** The caller prints the result itself (a loop): nothing is printed here, and the transcript is not followed in text. */
  silent?: boolean
  /** The session (and an in-process host) stays up after the run; the caller cleans it up. Only the follower is closed. */
  keepSession?: boolean
  /** Called once with how the run ended (outcome null when it was interrupted or the host went away). */
  onResult?: (r: ExecRunResult) => void
}

/** How one followed run ended, for a caller that runs several (`org evolve loop`). */
export interface ExecRunResult {
  runId: string | null
  outcome: ExecOutcome | null
  exitCode: number
  summary: RunSummary | null
  record: RunRecord | null
  result: string | null
  evolve: EvolvePostRunResult | null | undefined
}

/** The one stderr line `exec --evolve` prints in text mode. */
export function evolveLine(r: EvolvePostRunResult | null | undefined, error?: string): string {
  if (!r) return error ? `Team evolution: the post-run pass failed (${safeLine(error)}).` : 'Team evolution: no post-run pass ran for this run.'
  const parts: string[] = [`ratchet ${r.ratchet}${r.ratchetReason ? ` (${safeLine(r.ratchetReason)})` : ''}`]
  if (r.applied) parts.push(`applied ${safeLine(r.applied.id)} as a trial: ${safeLine(r.applied.summary)} (details: orgai org evolve history; undo: orgai org evolve rollback ${safeLine(r.applied.id)})`)
  else if (r.wasteScore !== undefined) parts.push(`waste score ${r.wasteScore}, no new generation`)
  return `Team evolution: ${parts.join('; ')}.`
}

export async function runAndFollow(ctx: CliContext, session: Session, output: RunOutput, start: () => Promise<RunSummary>): Promise<number> {
  const json = isJsonOutput(ctx)
  const stream = ctx.globals.outputFormat === 'stream-json'
  const st = styleFor(ctx)
  // --quiet changes the text output only; json and stream-json documents are unchanged.
  const silent = output.silent === true
  const quiet = (output.quiet || silent) && !json

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
  const staffed = new Set<string>()
  /** Log lines already printed (a resync snapshot carries the record's logs again). */
  const logged = new Set<string>()
  const printLog = (runId: string, level: string, message: string): void => {
    if (json) return
    const line = execLogLine(level, message, st)
    const key = `${runId}:${level}:${message}`
    if (line === null || logged.has(key)) return
    logged.add(key)
    // --quiet keeps stdout for the answer: progress is dropped, a warning or error goes to stderr.
    if (quiet) {
      if (level === 'warn' || level === 'error') warn(ctx, `${tagOf(runId)} ${message}`)
      return
    }
    printText(ctx, `${st.dim(tagOf(runId))} ${line}`)
  }
  /** `runId:agentId` -> compactions seen in this stream (agent.compacted). */
  const compacted = new Map<string, number>()
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
    if (json || quiet) return
    const line = transcriptLine(e, { st, prefix: st.dim(tagOf(runId)), agentName: (id) => agentLabel(agentOf(runId, id)), toolName: (id) => s.toolNames.get(id) })
    if (line !== null) printText(ctx, line)
  }
  const printStatus = (runId: string): void => {
    const s = stateOf(runId)
    const word = statusWordOfSummary(s.summary)
    if (word === s.word) return
    s.word = word
    if (quiet) {
      if (s.summary.status === 'error' && s.summary.error) warn(ctx, safeLine(s.summary.error))
      return
    }
    if (!json) printText(ctx, `${st.dim(tagOf(runId))} ${styleStatus(st, word)}${s.summary.status === 'error' && s.summary.error ? ` ${safeLine(s.summary.error)}` : ''}`)
  }
  const printCards = (runId: string, cards: Partial<PendingCards> | undefined): void => {
    if (json || !cards) return
    const s = stateOf(runId)
    if (quiet) {
      for (const w of pendingItems({ ...s.summary, status: 'running' }, cards, s.agents)) warn(ctx, `Needs you: ${safeLine(w.label)}`)
      return
    }
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
      let code = signal ? signalCode(signal) : (EXEC_OUTCOME_EXIT_CODE[outcome] ?? EXIT.failure)
      const rec =
        (await session.client.call<RunRecord | null>('runs:get', [summary.id], { timeoutMs: 60_000 }).catch(() => null)) ??
        (lastActive?.summary.id === summary.id ? lastActive : null)
      const state = runs.get(summary.id)
      const status = statusText(statusViewOf({ summary, plan: rec?.plan, agents: rec?.agents ?? state?.agents }))
      const result = lastRootText(rec)
      // The requested file is written before anything reports success: a write that fails makes the command fail.
      if (output.lastMessageFile) {
        try {
          writeLastMessage(output.lastMessageFile, result ?? '')
        } catch (e) {
          warn(ctx, `Could not write ${safeLine(output.lastMessageFile)}: ${safeLine(e instanceof Error ? e.message : String(e))}`)
          if (code === EXIT.ok) code = EXIT.failure
        }
      }
      // Team evolution: the pass RunManager started when the run ended (never started here); a failure is reported, not fatal.
      let evolveResult: EvolvePostRunResult | null | undefined
      let evolveError: string | undefined
      if (output.evolve) {
        try {
          evolveResult = await session.client.call<EvolvePostRunResult | null>('org:evolveAfterRun', [{ runId: summary.id }], { timeoutMs: 10 * 60_000 })
        } catch (e) {
          evolveResult = null
          evolveError = e instanceof Error ? e.message : String(e)
        }
      }
      const doc: Json = {
        runId: summary.id,
        execChainId: chainId ?? summary.overrides?.execChainId ?? execChainId ?? summary.id,
        outcome,
        exitCode: code,
        status,
        summary,
        result,
        ...(output.evolve ? { evolve: (evolveResult ?? { ratchet: 'none', skipped: true, ...(evolveError ? { error: safeLine(evolveError) } : {}) }) as unknown as Json } : {})
      }
      output.onResult?.({ runId: summary.id, outcome, exitCode: code, summary, record: rec, result, evolve: evolveResult })
      if (silent) {
        // The caller prints.
      } else if (stream) emitLine(ctx, { type: 'result', ...doc })
      else if (json) emit(ctx, doc, () => [])
      else if (quiet) {
        // Only the answer on stdout; how the run ended is the exit code, and a failure is said on stderr.
        // Sanitized like every other terminal text (no escape sequences from the model); --output-last-message keeps it raw.
        if (result) printText(ctx, safe(result).replace(/\n+$/, ''))
        if (outcome !== 'completed' && outcome !== 'completed-unplanned') warn(ctx, `${OUTCOME_LABEL[outcome] ?? safeLine(outcome)} (${EXEC_OUTCOME_EXIT_CODE[outcome] ?? EXIT.failure})`)
      } else printText(ctx, `${st.bold(OUTCOME_LABEL[outcome] ?? safeLine(outcome))} · ${styleStatus(st, status)} · ${costText(summary)}`)
      if (output.evolve && !json && !silent) warn(ctx, evolveLine(evolveResult, evolveError))
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
        if (!json && !quiet) printText(ctx, `${st.dim(tagOf(runId))} ${planUpdateLine(ev.plan)}`)
        return
      case 'log':
        printLog(runId, ev.level, ev.message)
        return
      case 'agent.compacted': {
        const key = `${runId}:${ev.agentId}`
        const n = (compacted.get(key) ?? 0) + 1
        compacted.set(key, n)
        if (!json && !quiet) printText(ctx, `${st.dim(tagOf(runId))} ${safeLine(compactionLine(agentOf(runId, ev.agentId)?.name ?? ev.agentId, Math.max(n, agentOf(runId, ev.agentId)?.compactions ?? 0)))}`)
        return
      }
      case 'staffing.updated':
        // One line per staffed report, once; json and stream-json carry the raw event instead.
        if (!json && !quiet) {
          for (const a of ev.staffing.assignments) {
            if (!a.agentId) continue
            const key = `${runId}:${a.agentId}:${a.at}:${a.source}:${a.model}:${a.effort ?? ''}`
            if (staffed.has(key)) continue
            staffed.add(key)
            printText(ctx, `${st.dim(tagOf(runId))} ${staffingLine(agentOf(runId, a.agentId) ? agentLabel(agentOf(runId, a.agentId)) : a.roleId, a)}`)
          }
        }
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
      if (stream && !silent) emitLine(ctx, { type: 'event', atSeq: p.atSeq, event: eventWithoutImages(ev) })
      return
    }
    if (stream && !silent) emitLine(ctx, { type: 'event', ...(typeof p.seq === 'number' ? { seq: p.seq } : {}), event: eventWithoutImages(ev) })
    applyEvent(ev)
  }

  const onSnapshot = (res: SnapshotResult, firstTime: boolean): void => {
    const snap = res.snapshot
    if (stream && !silent) {
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
      for (const l of active.logs ?? []) printLog(active.summary.id, l.level, l.message)
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
      connect: () => ctx.connect(session.scopes, { clientKind: 'cli', waitStartingMs: HOST_STARTING_WAIT_MS }),
      subscribeInput: () => ({ runIds: [...followed], followChains: true, nonInteractive: true, ...(newest ? { includeActiveRunRecord: newest } : {}) }),
      onEvent,
      onSnapshot,
      onGone: () => {
        if (finished) return
        warn(ctx, "The OrgAI host went away; the run's outcome is unknown.")
        done(EXIT.failure)
      },
      stopped: () => finished,
      timers: execIo.timers,
      // A loop reuses the session's connection for its next run: the stream must not close it.
      ...(output.keepSession ? { keepClient: true } : {})
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
  if (output.keepSession) session.releaseFollower()
  else await session.cleanup()
  if (code === -1) throw failure instanceof CliError ? failure : hostFailure(failure)
  if (!finalized) output.onResult?.({ runId: newest ?? null, outcome: null, exitCode: code, summary: null, record: null, result: null, evolve: undefined })
  if (json && !finalized && !silent) {
    // Interrupted (or the host went away) before an outcome: still give scripts a final document.
    const doc: Json = { runId: newest ?? null, execChainId: execChainId ?? null, outcome: null, exitCode: code, status: null, summary: null, result: null }
    if (stream) emitLine(ctx, { type: 'result', ...doc })
    else emit(ctx, doc, () => [])
  }
  return code
}
