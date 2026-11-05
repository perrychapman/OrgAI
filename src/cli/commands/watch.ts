/**
 * `orgai watch <runId|R#> [--no-follow]` (cli-spec 6.1, 3.3(4)): stream a run's events to stdout.
 *
 * - Connects with the 'read' scope (clientKind 'cli') and calls runs:subscribe with the chain's newest run,
 *   `followChains` (unless --no-follow) and `includeActiveRunRecord`. The snapshot's activeRun prints its last 20 rows
 *   (text) or one `snapshot` line (stream-json); then every `runs:event` notification prints as it comes.
 * - Text: completed transcript entries prefixed with the run tag and agent name, status changes in statusText words,
 *   decision cards as "Needs you: <kind> <ask> (request <id>)", plan updates. agent.partial is never printed in text;
 *   stream-json passes it through with its atSeq.
 * - The last durable seq is kept; when the socket closes the command reconnects with backoff for up to 30 s and
 *   resubscribes with sinceSeq + hostInstanceId + filterKey (a replay is applied without duplicates; a snapshot
 *   resyncs).
 * - Exits when the followed chain's newest run ends: finished 0, error 1, paused without auto-resume 0 (after the
 *   pause reason). SIGINT / SIGTERM detach: "Detached; the run keeps going." on stderr, exit 0.
 * - No host: a run that is ended in the saved data prints its final state (exit 0); otherwise exit 1.
 *
 * `--output-format json` streams like stream-json (one compact object per line): a stream has no single document.
 */
import type { AgentInstance, PendingCards, RunEvent, RunRecord, RunsEventParams, RunSummary, TranscriptEntry } from '../../shared/types'
import { newestOf } from '../../shared/view/runChains'
import { runIndexMap, runName, runTag } from '../../shared/view/runLabels'
import { statusText } from '../../shared/view/runStatus'
import { RUN_STREAM_RECONNECT_WINDOW_MS, RunStream, type SnapshotResult } from '../client/runStream'
import { parseFlags } from '../flags'
import { emitLine, isJsonOutput, printText, safeLine, styleFor, styleStatus, warn } from '../output'
import { agentLabel, pendingItems, planUpdateLine, recordWithoutImages, statusViewOf, statusWordOfSummary, tailRows, transcriptLine } from '../render'
import { hostlessNote, resolveRunFromSource, warnVersionSkew, type HostlessReason } from '../runRef'
import { CliError, EXIT, HOST_STARTING_WAIT_MS, type CliContext, type CommandFn, type HostClient, type ProjectResolution } from '../types'

export const WATCH_SNAPSHOT_ROWS = 20
/** Give up reconnecting after this long without a successful resubscribe. */
export const WATCH_RECONNECT_WINDOW_MS = RUN_STREAM_RECONNECT_WINDOW_MS

/** Timers, swappable in tests. */
export const watchTimers = {
  sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)),
  now: (): number => Date.now()
}

const HOSTLESS: ReadonlySet<string> = new Set(['no_host', 'starting', 'disabled', 'draining', 'unreachable'])

interface RunState {
  summary: RunSummary
  agents: Record<string, AgentInstance>
  toolNames: Map<string, string>
  word?: string
}

export const runWatch: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { 'no-follow': { type: 'boolean' } })
  if (positionals.length !== 1) throw new CliError('Use: orgai watch <runId-or-R#> [--no-follow]', EXIT.usage)
  const ref = positionals[0]
  const follow = !values['no-follow']
  const json = isJsonOutput(ctx)
  const st = styleFor(ctx)

  const first = await ctx.connect(['read'], { clientKind: 'cli', waitStartingMs: HOST_STARTING_WAIT_MS })
  if (!first.ok) {
    if (!HOSTLESS.has(first.reason)) throw new CliError(first.message || 'Could not connect to the OrgAI host.', first.reason === 'auth_failed' ? EXIT.auth : EXIT.failure)
    return watchHostless(ctx, ref, first.reason as HostlessReason, first.message)
  }

  // Resolve the ref through the live host, then watch the chain's newest member.
  const client: HostClient = first.client
  warnVersionSkew(ctx, client)
  const hostSrc = liveSource(client)
  const resolved = await resolveRunFromSource(ctx, hostSrc, ref).catch((e: unknown) => {
    client.close()
    throw e
  })
  const projectRuns = await hostSrc.runs(resolvedProjectOf(resolved.runs, resolved.runId)).catch(() => resolved.runs)
  const indexRuns = projectRuns.some((r) => r.id === resolved.runId) ? projectRuns : resolved.runs
  const target = (follow ? newestOf(indexRuns, resolved.runId)?.id : undefined) ?? resolved.runId

  const index = runIndexMap(indexRuns.filter((r) => r.projectId === resolvedProjectOf(indexRuns, target)))
  let nextIndex = Math.max(0, ...index.values()) + 1
  const tagOf = (runId: string): string => {
    if (!index.has(runId)) index.set(runId, nextIndex++)
    return runTag(index.get(runId))
  }

  const runs = new Map<string, RunState>()
  const followed = new Set<string>([target])
  let newest = target
  const printed = new Set<string>()
  let finished = false
  let exitCode: number = EXIT.ok

  let resolveDone!: (code: number) => void
  const done = new Promise<number>((r) => (resolveDone = r))
  const finish = (code: number): void => {
    if (finished) return
    finished = true
    exitCode = code
    resolveDone(code)
  }

  const stateOf = (runId: string, seed?: RunSummary): RunState => {
    let s = runs.get(runId)
    if (!s) {
      s = { summary: seed ?? ({ id: runId, projectId: '', kind: 'work', prompt: '', status: 'starting', startedAt: watchTimers.now(), totalCostUsd: 0 } as RunSummary), agents: {}, toolNames: new Map() }
      runs.set(runId, s)
    }
    return s
  }

  /** An agent of this run, else the same agent id in an earlier chain member (a continuation keeps its root). */
  const agentOf = (runId: string, agentId: string): AgentInstance | undefined => {
    const own = runs.get(runId)?.agents[agentId]
    if (own) return own
    for (const id of followed) {
      const a = runs.get(id)?.agents[agentId]
      if (a) return a
    }
    return undefined
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

  /** Print a status line when the word changes; decide whether the watch ends. */
  const onStatus = (runId: string): void => {
    const s = stateOf(runId)
    const word = statusWordOfSummary(s.summary)
    if (word !== s.word) {
      s.word = word
      if (!json) printText(ctx, `${st.dim(tagOf(runId))} ${styleStatus(st, word)}${s.summary.status === 'error' && s.summary.error ? ` ${safeLine(s.summary.error)}` : ''}`)
    }
    checkEnd()
  }

  const checkEnd = (): void => {
    const s = runs.get(newest)
    if (!s) return
    const status = s.summary.status
    if (status === 'finished') finish(EXIT.ok)
    else if (status === 'error') finish(EXIT.failure)
    else if (status === 'paused' && !s.summary.autoResume) {
      if (!json) printText(ctx, `${st.dim(tagOf(newest))} ${safeLine(s.summary.pauseReason ?? 'Paused.')}`)
      finish(EXIT.ok)
    }
  }

  const adopt = (runId: string): void => {
    if (followed.has(runId)) return
    // The host only sends a run we did not subscribe to when it follows the chain: it is the newest member.
    followed.add(runId)
    newest = runId
  }

  const applyEvent = (ev: RunEvent): void => {
    const runId = ev.runId
    if (follow) adopt(runId)
    else if (!followed.has(runId)) return
    const s = stateOf(runId)
    switch (ev.type) {
      case 'run.status': {
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
        onStatus(runId)
        return
      }
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
      case 'permission.request':
      case 'question.request':
      case 'proposal.request':
      case 'rules.request':
      case 'merge.request':
      case 'mcpInstall.request': {
        if (json) return
        const cards = cardOf(ev)
        const items = pendingItems({ ...s.summary, status: 'running' }, cards, s.agents)
        for (const w of items) printText(ctx, `${st.dim(tagOf(runId))} ${st.yellow('Needs you:')} ${safeLine(w.label)} ${st.dim(`(request ${safeLine(w.key)})`)}`)
        return
      }
      default:
        return
    }
  }

  const onRunsEvent = (p: RunsEventParams): void => {
    if (typeof p.seq === 'number') {
      if (json) emitLine(ctx, { type: 'event', seq: p.seq, event: p.event })
    } else if (p.event.type === 'agent.partial') {
      if (follow) adopt(p.event.runId)
      if (json && followed.has(p.event.runId)) emitLine(ctx, { type: 'event', atSeq: p.atSeq, event: p.event })
      return
    } else if (json) emitLine(ctx, { type: 'event', event: p.event })
    applyEvent(p.event)
  }

  /** Apply a snapshot: it resyncs (the first one prints the tail). */
  const applySnapshot = (res: SnapshotResult, firstTime: boolean): void => {
    const snap = res.snapshot
    if (json) {
      const active = snap.activeRun ? recordWithoutImages(snap.activeRun) : undefined
      emitLine(ctx, { type: 'snapshot', hostInstanceId: res.hostInstanceId, seq: res.seq, filterKey: res.filterKey, snapshot: { ...snap, ...(active ? { activeRun: active } : {}) } })
    }
    for (const sum of [...snap.recentEndedRuns, ...snap.liveRuns]) {
      if (!followed.has(sum.id)) {
        // A chain successor the host already follows for us.
        if (follow && sum.resumedFrom && followed.has(sum.resumedFrom)) adopt(sum.id)
        else continue
      }
      stateOf(sum.id, sum).summary = sum
    }
    const active: RunRecord | undefined = snap.activeRun
    if (active && followed.has(active.summary.id)) {
      const s = stateOf(active.summary.id, active.summary)
      s.summary = active.summary
      s.agents = { ...active.agents }
      for (const e of active.transcript) if (e.block.kind === 'tool_use') s.toolNames.set(e.block.id, e.block.name)
      if (firstTime && !json) {
        const name = safeLine(runName(active.summary))
        const waiting = pendingItems(active.summary, snap.pendingCards?.[active.summary.id], active.agents).length > 0
        const word = statusText(statusViewOf({ summary: active.summary, plan: active.plan, agents: active.agents }, waiting))
        printText(ctx, `${st.bold(tagOf(active.summary.id))}  ${styleStatus(st, word)}  ${st.bold(name)}`)
        s.word = statusWordOfSummary(active.summary)
        const rows = tailRows(active.transcript, active.agents, st, WATCH_SNAPSHOT_ROWS, { prefix: st.dim(tagOf(active.summary.id)) })
        for (const l of rows.lines) printText(ctx, l)
        for (const w of pendingItems(active.summary, snap.pendingCards?.[active.summary.id], active.agents)) {
          printText(ctx, `${st.dim(tagOf(active.summary.id))} ${st.yellow('Needs you:')} ${safeLine(w.label)} ${st.dim(`(request ${safeLine(w.key)})`)}`)
        }
      } else if (!firstTime) {
        // Resync: print what we missed, never what we already printed.
        for (const e of active.transcript) printEntry(active.summary.id, e)
      }
      for (const e of active.transcript) printed.add(`${active.summary.id}:${e.id}`)
    }
    // Newest followed run: the one started last.
    let best: RunState | undefined
    for (const id of followed) {
      const s = runs.get(id)
      if (s && (!best || s.summary.startedAt >= best.summary.startedAt)) best = s
    }
    if (best) newest = best.summary.id
    for (const id of followed) if (runs.has(id)) onStatus(id)
  }

  // Interrupts detach without touching the run.
  const offSignal = ctx.signals.onInterrupt(() => {
    if (finished) return
    warn(ctx, 'Detached; the run keeps going.')
    finish(EXIT.ok)
  })

  const stream = new RunStream({
    client,
    connect: () => ctx.connect(['read'], { clientKind: 'cli', waitStartingMs: HOST_STARTING_WAIT_MS }),
    subscribeInput: () => ({ runIds: [...followed], followChains: follow, includeActiveRunRecord: newest }),
    onEvent: onRunsEvent,
    onSnapshot: applySnapshot,
    onGone: () => {
      warn(ctx, 'Lost the connection to the OrgAI host.')
      finish(EXIT.failure)
    },
    stopped: () => finished,
    timers: watchTimers,
    reconnectWindowMs: WATCH_RECONNECT_WINDOW_MS
  })

  try {
    await stream.start()
  } catch (e) {
    offSignal()
    throw e
  }
  const code = await done
  offSignal()
  stream.close()
  return code ?? exitCode
}

/** The project id of a run in a list (empty when unknown). */
function resolvedProjectOf(runs: readonly RunSummary[], id: string): string {
  return runs.find((r) => r.id === id)?.projectId ?? ''
}

/** A minimal ReadSource over a connected client (projects, runs, records); exec and resume use it too. */
export function liveSource(client: HostClient): Parameters<typeof resolveRunFromSource>[1] {
  const newestFirst = (a: RunSummary, b: RunSummary): number => b.startedAt - a.startedAt || b.id.localeCompare(a.id)
  const runs = async (projectId: string): Promise<RunSummary[]> => {
    if (!projectId) return []
    const list = await client.call<RunSummary[]>('runs:list', [projectId])
    return (Array.isArray(list) ? list : []).slice().sort(newestFirst)
  }
  return {
    live: true,
    client,
    hostState: 'ready',
    liveInboxAvailable: true,
    projects: async () => {
      const list = await client.call('projects:list', [])
      return Array.isArray(list) ? list : []
    },
    runs,
    allRuns: async (ids) => {
      const lists = await Promise.all(ids.map((id) => runs(id).catch(() => [] as RunSummary[])))
      const seen = new Set<string>()
      return lists
        .flat()
        .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
        .sort(newestFirst)
    },
    record: async (runId) => (await client.call<RunRecord | null>('runs:get', [runId]).catch(() => null)) ?? null,
    close: () => client.close()
  }
}

/** The one-card PendingCards for a *.request event. */
function cardOf(ev: RunEvent): Partial<PendingCards> {
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
      return {}
  }
}

/** No live host: print the saved final state of an ended run (exit 0), else exit 1. */
async function watchHostless(ctx: CliContext, ref: string, reason: HostlessReason, message: string): Promise<number> {
  const snap = await ctx.readStore()
  const projects = snap.projects
  const resolution: ProjectResolution = ctx.resolveProject(projects)
  if (resolution.error) throw new CliError(resolution.error, EXIT.usage)
  const src = {
    live: false,
    snapshot: snap,
    hostState: snap.hostState,
    liveInboxAvailable: false,
    projects: async () => projects,
    runs: async (id: string) => snap.runs.filter((r) => r.projectId === id),
    allRuns: async (ids: readonly string[]) => snap.runs.filter((r) => ids.includes(r.projectId)),
    record: async (id: string) => snap.readRecord(id),
    close: () => undefined
  }
  const { runId, runs } = await resolveRunFromSource(ctx, src, ref)
  const chainRuns = runs.filter((r) => r.projectId === resolvedProjectOf(runs, runId))
  const target = newestOf(chainRuns.length ? chainRuns : runs, runId)?.id ?? runId
  const rec = snap.readRecord(target)
  const status = rec?.summary.status
  const ended = status === 'finished' || status === 'error' || (status === 'paused' && !rec?.summary.autoResume)
  // Terminal access off: the host is running and may still be running the run, so the saved data proves nothing.
  if (reason === 'disabled') throw new CliError(message || 'Terminal access is turned off in OrgAI.', EXIT.failure)
  if (!rec || !ended) throw new CliError(reason === 'no_host' ? 'No OrgAI host is running.' : hostlessNote(reason, message).replace('; showing saved data.', '.'), EXIT.failure)
  const st = styleFor(ctx)
  const tag = runTag(runIndexMap(chainRuns).get(target))
  if (isJsonOutput(ctx)) {
    emitLine(ctx, { type: 'final', hostState: snap.hostState, liveInboxAvailable: false, record: recordWithoutImages(rec) })
  } else {
    const word = statusText(statusViewOf({ summary: rec.summary, plan: rec.plan, agents: rec.agents }))
    printText(ctx, `${st.bold(tag)}  ${styleStatus(st, word)}  ${st.bold(safeLine(runName(rec.summary)))}`)
    for (const l of tailRows(rec.transcript, rec.agents, st, WATCH_SNAPSHOT_ROWS, { prefix: st.dim(tag) }).lines) printText(ctx, l)
    if (rec.summary.status === 'paused' && rec.summary.pauseReason) printText(ctx, `${st.dim(tag)} ${safeLine(rec.summary.pauseReason)}`)
    ctx.io.stderr.write('No OrgAI host is running; this run has ended.\n')
  }
  return EXIT.ok
}
