/**
 * The app opening while another host owns the data folder (Wave 7, docs/design/cli-standalone.md 4.4): the desktop's
 * side of the handoff from a Node host, and the wait for an inproc owner. Electron-free: index.ts supplies the
 * connection, the liveness check and the small wait window through DesktopHandoffDeps, so every step is unit-tested.
 *
 * - Owner 'inproc' (someone's terminal): never stopped. The window says OrgAI's data is in use by the orgai command in a
 *   terminal and offers "Open when it ends" and "Quit".
 * - Owner 'node': host.stop({ force: false, handoff: true }) over a 'desktop' connection (the handoff grant).
 *   - stopping: wait for the process to exit, showing a window only if that takes more than HANDOFF_WINDOW_DELAY_MS.
 *   - refused: the window lists what is still going on (handoffBlockers, refusedBecause and host.status `handoff`) with
 *     "Open when they finish" (re-asks every HANDOFF_RETRY_MS), "Stop them and open" (host.stop({ force: true }); the
 *     user confirmed, so once that request is sent a late answer or a closed connection counts as stopping and the
 *     exit poll decides) and "Quit". An empty handoffBlockers is a host that could not read its run state and refused.
 *   - no answer within HANDOFF_ANSWER_TIMEOUT_MS to the first, non-forced stop, or an owner without the handoff grant
 *     (older than Wave 7): 'unavailable' (index.ts shows the existing busy-folder message with the
 *     `orgai daemon stop --force` hint).
 * - The exit poll (ownerExitCheck) runs a signal probe per poll and re-reads the start time only every
 *   HANDOFF_START_TIME_RECHECK_MS.
 * - Any other owner kind: 'unavailable'.
 * - 'acquire' only once the owner's process has exited (pid plus start time, processInfo.ts), never on its word; the
 *   caller then takes ownership as usual and, losing the race to another contender, runs this again for the new owner.
 */
import type { ActivityLeaseKind, DaemonInfo, HostHandoffBlocker, HostHandoffFacts, HostStatusResult, HostStopResult } from '../shared/types'
import { processLivenessCachedAsync, type LiveProcessDepsAsync } from './host/processInfo'
import { HANDOFF_ANSWER_TIMEOUT_MS, HANDOFF_RETRY_MS, HANDOFF_WINDOW_DELAY_MS } from './host/shutdown'

/**
 * How long the handoff trusts an answer about the owner's start time while it waits. Every exit poll still runs the
 * cheap signal-0 probe (a pid the OS reports gone is exited at once); only re-reading the start time (darwin `ps`,
 * win32 PowerShell, processInfo.ts) waits this long, so an hour-long wait for the orgai command starts PowerShell about
 * 120 times, not on every 250 ms poll. The start time only matters if the owner's pid were reused between two polls.
 */
export const HANDOFF_START_TIME_RECHECK_MS = 30_000

export type HandoffChoice = 'wait' | 'force' | 'quit'
export type HandoffOutcome = 'acquire' | 'quit' | 'unavailable'

/** What the small wait window shows. Buttons are in order; each maps to one choice. */
export interface HandoffView {
  kind: 'inproc' | 'inproc-waiting' | 'stopping' | 'busy' | 'busy-waiting'
  message: string
  detail: string
  buttons: { label: string; choice: HandoffChoice }[]
}

/** The connection a handoff needs: the verified hello's handoff grant, and calls with a timeout. */
export interface HandoffClient {
  /** RpcHelloResult.handoff: false (or absent) for an owner older than Wave 7. */
  readonly handoff: boolean
  call<T = unknown>(method: string, params?: unknown[] | Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>
  close(): void
}

/** connect()'s answer: a client, the owner is already shutting down, or no usable answer. */
export type HandoffConnect = { client: HandoffClient } | { draining: true } | { failed: string }

export interface DesktopHandoffDeps {
  /** Connect to the owner with clientKind 'desktop' (requested scopes read + configure) within timeoutMs. */
  connect(timeoutMs: number): Promise<HandoffConnect>
  /** True once the owner's process has exited (pid plus start time; processInfo.ts). Never rejects. */
  exited(owner: DaemonInfo): Promise<boolean>
  /** Show or update the wait window; undefined hides it. */
  show(view: HandoffView | undefined): void
  sleep?: (ms: number) => Promise<void>
  /** How often the owner's exit is checked. Default 250 ms. */
  exitPollMs?: number
  windowDelayMs?: number
  retryMs?: number
  answerTimeoutMs?: number
  log?: (m: string) => void
}

const BLOCKER_WORDS: Record<HostHandoffBlocker, [string, string]> = {
  workingRuns: ['run working', 'runs working'],
  waitingRuns: ['run waiting for you', 'runs waiting for you'],
  heldRuns: ['run paused by you or a usage limit', 'runs paused by you or a usage limit'],
  pausedRuns: ['run waiting to resume', 'runs waiting to resume'],
  openCards: ['decision open', 'decisions open']
}

const LEASE_WORDS: Partial<Record<ActivityLeaseKind, [string, string]>> = {
  activeOAuthFlows: ['sign-in in progress', 'sign-ins in progress'],
  activeWorktreeOps: ['repository operation', 'repository operations'],
  backgroundTasks: ['background task', 'background tasks'],
  inFlightRpcMutations: ['change being saved', 'changes being saved'],
  interactiveClients: ['terminal session attached', 'terminal sessions attached']
}

const count = (n: number, words: [string, string]): string => `${n} ${n === 1 ? words[0] : words[1]}`

/**
 * The lines of the busy window: what blocks the handoff (the run facts first, then the leases the run facts do not
 * already cover), plus attached terminal sessions from host.status. Pure; exported for tests.
 */
export function busyLines(stop: HostStopResult, facts?: HostHandoffFacts): string[] {
  const lines: string[] = []
  // The refusal's own blockers, else the status facts.
  const runFacts: Partial<Record<HostHandoffBlocker, number>> = stop.handoffBlockers ?? facts ?? {}
  let named = false
  for (const k of Object.keys(BLOCKER_WORDS) as HostHandoffBlocker[]) {
    const n = runFacts[k]
    if (typeof n === 'number' && n > 0) {
      lines.push(count(n, BLOCKER_WORDS[k]))
      named = true
    }
  }
  const leases = stop.refusedBecause ?? {}
  for (const [k, n] of Object.entries(leases) as [ActivityLeaseKind, number][]) {
    if (typeof n !== 'number' || n <= 0) continue
    // Live runs and resumes are what the run facts above name; only without them are the leases shown.
    if (k === 'liveRuns' || k === 'pausedAutoResumes') {
      if (!named) lines.push(count(n, BLOCKER_WORDS[k === 'liveRuns' ? 'workingRuns' : 'pausedRuns']))
      continue
    }
    const words = LEASE_WORDS[k]
    if (words) lines.push(count(n, words))
  }
  const sessions = facts?.terminalSessions ?? 0
  if (sessions > 0 && !leases.interactiveClients) lines.push(count(sessions, ['terminal session connected', 'terminal sessions connected']))
  // A handoff refusal with no counts: the host could not read its run state, so it refused rather than end runs unseen.
  if (lines.length === 0 && stop.handoffBlockers && !named) lines.push('runs the background host could not count')
  return lines
}

/** The wait window's contents per state. Pure; exported for tests. */
export function handoffView(kind: HandoffView['kind'], lines: string[] = []): HandoffView {
  const list = lines.length ? `\n\nStill going: ${lines.join(', ')}.` : ''
  switch (kind) {
    case 'inproc':
      return {
        kind,
        message: 'The orgai command in a terminal is using OrgAI\'s data.',
        detail: 'OrgAI can open as soon as that command ends. OrgAI never stops it for you.',
        buttons: [
          { label: 'Wait, then open', choice: 'wait' },
          { label: 'Quit', choice: 'quit' }
        ]
      }
    case 'inproc-waiting':
      return {
        kind,
        message: 'OrgAI will open when the orgai command ends.',
        detail: 'You can also end it yourself with Ctrl+C in its terminal.',
        buttons: [{ label: 'Quit', choice: 'quit' }]
      }
    case 'stopping':
      return {
        kind,
        message: 'Waiting for the background host to stop.',
        detail: 'It is finishing a save. OrgAI opens as soon as it stops.',
        buttons: [{ label: 'Quit', choice: 'quit' }]
      }
    case 'busy':
      return {
        kind,
        message: 'OrgAI is still working in the background.',
        detail: `A background host you started from a terminal is using OrgAI's data and still has work to do.${list}\n\nStopping it ends those runs. They show "Ended when OrgAI closed" and can be continued. Connected terminals are disconnected.`,
        buttons: [
          { label: 'Wait, then open', choice: 'wait' },
          { label: 'Stop and open', choice: 'force' },
          { label: 'Quit', choice: 'quit' }
        ]
      }
    case 'busy-waiting':
      return {
        kind,
        message: 'OrgAI will open when the background work finishes.',
        detail: `OrgAI checks every few seconds.${list}`,
        buttons: [
          { label: 'Stop and open', choice: 'force' },
          { label: 'Quit', choice: 'quit' }
        ]
      }
  }
}

type Attempt =
  | { kind: 'stopping' }
  | { kind: 'busy'; stop: HostStopResult; facts?: HostHandoffFacts }
  | { kind: 'unavailable'; reason: string }

type Event = { kind: 'exited' } | { kind: 'choice'; choice: HandoffChoice } | { kind: 'tick' }

/**
 * One handoff run per owner. index.ts feeds the window's buttons to choose() and re-shows view() on second-instance
 * and activate (the wait window is the only window while it runs).
 */
export class DesktopHandoff {
  private current: HandoffView | undefined
  private choices: HandoffChoice[] = []
  private wake: (() => void) | undefined
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: DesktopHandoffDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => globalThis.setTimeout(r, ms)))
  }

  /** A button of the wait window. */
  choose(choice: HandoffChoice): void {
    this.choices.push(choice)
    const w = this.wake
    this.wake = undefined
    w?.()
  }

  /** What the wait window shows now (undefined: no window). */
  view(): HandoffView | undefined {
    return this.current
  }

  async run(owner: DaemonInfo): Promise<HandoffOutcome> {
    try {
      if (owner.hostKind === 'inproc') return await this.waitForInproc(owner)
      if (owner.hostKind !== 'node') return 'unavailable'
      return await this.handOverNode(owner)
    } finally {
      this.setView(undefined)
    }
  }

  private setView(view: HandoffView | undefined): void {
    this.current = view
    try {
      this.deps.show(view)
    } catch (e) {
      this.log(`Handoff: the wait window failed: ${(e as Error)?.message ?? String(e)}`)
    }
  }

  private async waitForInproc(owner: DaemonInfo): Promise<HandoffOutcome> {
    if (await this.deps.exited(owner)) return 'acquire'
    this.setView(handoffView('inproc'))
    for (;;) {
      const ev = await this.next(owner, Infinity)
      if (ev.kind === 'exited') return 'acquire'
      if (ev.kind === 'choice' && ev.choice === 'quit') return 'quit'
      if (ev.kind === 'choice' && ev.choice === 'wait') this.setView(handoffView('inproc-waiting'))
      // 'force' is not offered for an inproc owner; ignored.
    }
  }

  private async handOverNode(owner: DaemonInfo): Promise<HandoffOutcome> {
    let attempt = await this.tryStop({ force: false, handoff: true })
    if (attempt.kind === 'unavailable') {
      // An owner that went away meanwhile is not a refusal.
      if (await this.deps.exited(owner)) return 'acquire'
      this.log(`Handoff: the background host did not hand over (${attempt.reason}).`)
      return 'unavailable'
    }
    if (attempt.kind === 'stopping') return this.waitForExit(owner, false)
    let waiting = false
    /** The newest refusal, for the window's lines. */
    let busy = attempt
    this.setView(handoffView('busy', busyLines(busy.stop, busy.facts)))
    for (;;) {
      const ev = await this.next(owner, waiting ? (this.deps.retryMs ?? HANDOFF_RETRY_MS) : Infinity)
      if (ev.kind === 'exited') return 'acquire'
      if (ev.kind === 'choice' && ev.choice === 'quit') return 'quit'
      if (ev.kind === 'choice' && ev.choice === 'force') {
        // The user confirmed in this window: runs end through stopAll({ reason: 'quit' }) and stay continuable. The
        // window says so at once: a forced host.stop answers only after the whole drain.
        this.setView(handoffView('stopping'))
        const forced = await this.tryStop({ force: true })
        if (forced.kind === 'stopping') return this.waitForExit(owner, true)
        if (await this.deps.exited(owner)) return 'acquire'
        if (forced.kind === 'unavailable') {
          this.log(`Handoff: the forced stop got no answer (${forced.reason}).`)
          return 'unavailable'
        }
        busy = forced
        this.setView(handoffView(waiting ? 'busy-waiting' : 'busy', busyLines(busy.stop, busy.facts)))
        continue
      }
      if (ev.kind === 'choice' && ev.choice === 'wait') {
        waiting = true
        this.setView(handoffView('busy-waiting', busyLines(busy.stop, busy.facts)))
        continue
      }
      if (ev.kind === 'tick') {
        attempt = await this.tryStop({ force: false, handoff: true })
        if (attempt.kind === 'stopping') return this.waitForExit(owner, true)
        if (attempt.kind === 'unavailable') {
          if (await this.deps.exited(owner)) return 'acquire'
          // A missed retry is not fatal: keep the window and try again.
          this.log(`Handoff: a retry got no answer (${attempt.reason}); trying again.`)
          continue
        }
        busy = attempt
        this.setView(handoffView('busy-waiting', busyLines(busy.stop, busy.facts)))
      }
    }
  }

  /** The owner is stopping: wait for its process to exit, with a window once that takes longer than the delay. */
  private async waitForExit(owner: DaemonInfo, showNow: boolean): Promise<HandoffOutcome> {
    if (showNow) this.setView(handoffView('stopping'))
    else {
      const delay = this.deps.windowDelayMs ?? HANDOFF_WINDOW_DELAY_MS
      const first = await this.next(owner, delay)
      if (first.kind === 'exited') return 'acquire'
      if (first.kind === 'choice' && first.choice === 'quit') return 'quit'
      this.setView(handoffView('stopping'))
    }
    for (;;) {
      const ev = await this.next(owner, Infinity)
      if (ev.kind === 'exited') return 'acquire'
      if (ev.kind === 'choice' && ev.choice === 'quit') return 'quit'
    }
  }

  /** One stop attempt over a fresh handoff connection (the host closes it when it drains). */
  private async tryStop(input: { force: boolean; handoff?: boolean }): Promise<Attempt> {
    const timeoutMs = this.deps.answerTimeoutMs ?? HANDOFF_ANSWER_TIMEOUT_MS
    let conn: HandoffConnect
    try {
      conn = await this.deps.connect(timeoutMs)
    } catch (e) {
      conn = { failed: (e as Error)?.message ?? String(e) }
    }
    if ('draining' in conn) return { kind: 'stopping' }
    if ('failed' in conn) return { kind: 'unavailable', reason: conn.failed }
    const client = conn.client
    let sent = false
    try {
      if (!client.handoff) return { kind: 'unavailable', reason: 'the owner does not offer the app hand-off' }
      sent = true
      const stop = await client.call<HostStopResult>('host.stop', [{ force: input.force, ...(input.handoff ? { handoff: true } : {}) }], { timeoutMs })
      if (stop && stop.stopping === true) return { kind: 'stopping' }
      if (!stop || typeof stop !== 'object') return { kind: 'unavailable', reason: 'host.stop answered nothing usable' }
      let facts: HostHandoffFacts | undefined
      try {
        facts = (await client.call<HostStatusResult>('host.status', [], { timeoutMs })).handoff
      } catch {
        facts = undefined
      }
      return { kind: 'busy', stop, ...(facts ? { facts } : {}) }
    } catch (e) {
      const data = (e as { data?: { code?: unknown } })?.data
      if (data?.code === 'host_draining') return { kind: 'stopping' }
      // A forced host.stop answers only once its drain is done (stopAll for up to 3 s, then every writer, bounded only by
      // the hard limit), and the host closes its connections as it stops. Once the user confirmed and the request went
      // out, no answer in time (or a closed connection) means it is stopping: the exit poll decides, never a refusal.
      // A coded answer (scope_denied, bad_request, ...) is a real refusal.
      if (input.force && sent && typeof data?.code !== 'string') {
        this.log(`Handoff: the forced stop has not answered yet (${(e as Error)?.message ?? String(e)}); waiting for the host to exit.`)
        return { kind: 'stopping' }
      }
      return { kind: 'unavailable', reason: (e as Error)?.message ?? String(e) }
    } finally {
      try {
        client.close()
      } catch {
        // already closed
      }
    }
  }

  /** The next event: a choice (queued ones first), the owner's exit (polled), or a tick after `ms`. */
  private async next(owner: DaemonInfo, ms: number): Promise<Event> {
    const pollMs = this.deps.exitPollMs ?? 250
    let waited = 0
    for (;;) {
      const queued = this.choices.shift()
      if (queued) return { kind: 'choice', choice: queued }
      if (await this.deps.exited(owner)) return { kind: 'exited' }
      if (waited >= ms) return { kind: 'tick' }
      const step = Math.min(pollMs, ms - waited)
      await Promise.race([this.sleep(step), new Promise<void>((r) => (this.wake = r))])
      this.wake = undefined
      waited += step
    }
  }

  private log(m: string): void {
    this.deps.log?.(m)
  }
}

/** processInfo.ts Liveness: 'dead', 'same' (the recorded process) or 'unconfirmed' (pid exists, start not comparable). */
export type OwnerLiveness = 'dead' | 'same' | 'unconfirmed'

/**
 * Has the owner's process exited (4.4 step 6)? 'dead' by pid plus start time is; 'same' is not; an 'unconfirmed' pid
 * (it exists but its start time could not be compared: maybe a stranger that reused it) counts as exited only once
 * daemon.json no longer names that host instance (it released). Never rejects (a throw counts as not exited yet).
 */
export async function ownerHasExited(
  owner: DaemonInfo,
  deps: { liveness(pid: number, startTime?: string): OwnerLiveness | Promise<OwnerLiveness>; currentOwner(): DaemonInfo | null }
): Promise<boolean> {
  try {
    const live = await deps.liveness(owner.pid, owner.processStartTime)
    if (live === 'dead') return true
    if (live === 'same') return false
    return deps.currentOwner()?.hostInstanceId !== owner.hostInstanceId
  } catch {
    return false
  }
}

/**
 * The handoff's `exited` check (DesktopHandoffDeps.exited) for index.ts: {@link ownerHasExited} over the cached
 * liveness (processInfo.ts processLivenessCachedAsync with {@link HANDOFF_START_TIME_RECHECK_MS}), so a wait of hours
 * runs the cheap signal probe per poll and reads the start time at most once per recheck interval. `deps` are for tests.
 */
export function ownerExitCheck(
  currentOwner: () => DaemonInfo | null,
  deps: LiveProcessDepsAsync & { now?: () => number; recheckMs?: number } = {}
): (owner: DaemonInfo) => Promise<boolean> {
  const opts = { recheckMs: HANDOFF_START_TIME_RECHECK_MS, ...deps }
  return (owner) => ownerHasExited(owner, { liveness: (pid, start) => processLivenessCachedAsync(pid, start, opts), currentOwner })
}

// ---------- The wait window's page (no preload, no script: links only) ----------

/** The scheme of the wait window's buttons; index.ts intercepts navigations to it and never loads it. */
export const HANDOFF_CHOICE_SCHEME = 'orgai-handoff:'

const escapeHtml = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * The wait window's HTML for a view: text escaped, each button a link to `orgai-handoff:<choice>` (JavaScript stays off
 * in that window). `dark` picks the colours. Pure; exported for tests.
 */
export function handoffPageHtml(view: HandoffView, dark: boolean): string {
  const bg = dark ? '#16181d' : '#f7f7f8'
  const fg = dark ? '#e8e9ed' : '#1b1d22'
  const muted = dark ? '#a3a7b3' : '#4f5562'
  const accent = dark ? '#7aa2ff' : '#2f5bd3'
  const detail = view.detail
    .split(/\n\n+/)
    .map((para) => escapeHtml(para).replace(/\n/g, '<br>'))
    .join('</p><p>')
  const buttons = view.buttons
    .map((b, i) => `<a class="btn${i === 0 ? ' primary' : ''}" href="${HANDOFF_CHOICE_SCHEME}${b.choice}">${escapeHtml(b.label)}</a>`)
    .join('')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>OrgAI</title><style>
body{margin:0;padding:24px;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:${bg};color:${fg}}
h1{font-size:15px;font-weight:600;margin:0 0 10px}p{margin:0 0 10px;color:${muted}}.row{margin-top:18px}
.row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.btn{display:inline-block;padding:6px 14px;border-radius:6px;border:1px solid ${muted};color:${fg};text-decoration:none}
.btn.primary{background:${accent};border-color:${accent};color:#fff}
.btn:focus-visible{outline:2px solid ${accent};outline-offset:2px}
</style></head><body><h1>${escapeHtml(view.message)}</h1><p>${detail}</p><div class="row">${buttons}</div></body></html>`
}

/** The choice a wait-window navigation names, or undefined for anything else. Pure; exported for tests. */
export function handoffChoiceOf(url: string): HandoffChoice | undefined {
  if (typeof url !== 'string' || !url.startsWith(HANDOFF_CHOICE_SCHEME)) return undefined
  const rest = url.slice(HANDOFF_CHOICE_SCHEME.length).replace(/^\/+/, '')
  return rest === 'wait' || rest === 'force' || rest === 'quit' ? rest : undefined
}

/** The message index.ts shows when the owner cannot hand over (no answer, or older than Wave 7). Pure. */
export function handoffUnavailableText(owner: DaemonInfo, runDir?: string): { title: string; detail: string } {
  const who =
    owner.hostKind === 'node' ? 'a background host started from a terminal'
    : owner.hostKind === 'inproc' ? 'the orgai command in a terminal'
    : 'another OrgAI'
  return {
    title: 'OrgAI is already running',
    detail: `OrgAI's data folder is in use by ${who} (pid ${owner.pid}), which did not hand it over.\n\nStop it with \`orgai daemon stop --force\` (that ends its runs; they can be continued), then start OrgAI again.${runDir ? `\n\nIf you are sure nothing is running, delete the folder ${runDir} and start OrgAI again.` : ''}`
  }
}
