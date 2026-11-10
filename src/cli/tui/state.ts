/**
 * TUI state reducer (W4-T1): snapshots and runs:event params into TuiState. Pure and immutable (every update returns a
 * new state object and never mutates the old one); no I/O, no React.
 *
 * Two pieces of state live beside TuiState rather than in it, because they are not plain data:
 * - The per-(runId, agentId) stream sanitizers behind agent.partial (`PartialTracker`, one per session, passed to
 *   applyEvent). agent.partial is CUMULATIVE text (the whole block so far; '' clears): when the new raw text extends
 *   the previous one only the delta is fed to that stream's TtySanitizer, so an escape sequence split across two
 *   partials is still removed; anything else (a new block, a shorter text) restarts the stream. Without a tracker the
 *   whole text is sanitized fresh each time (also safe, just quadratic).
 * - The arrival order of decision cards (`cardArrivalSeq`): a WeakMap keyed by the card object, which this reducer
 *   never copies, so the tray can order cards by arrival across kinds and runs.
 */
import type {
  AgentInstance,
  CardKind,
  PendingCards,
  Project,
  RunEvent,
  RunRecord,
  RunsEventParams,
  RunSummary,
  TranscriptEntry
} from '../../shared/types'
import { applyRunDelegation } from '../../shared/delegationView'
import { statusEventEndFacts } from '../../shared/view/runChains'
import type { SnapshotResult } from '../client/runStream'
import { safeLine } from '../output'
import { StreamSanitizers, sanitizeTty } from './sanitizeTty'
import {
  cardKey,
  TUI_NOTICE_MAX,
  TUI_RESOLVED_MAX,
  TUI_MESSAGES_MAX,
  TUI_TRANSCRIPT_MAX,
  type ConnectionState,
  type ComposeTarget,
  type ResolvedCardInfo,
  type Tone,
  type TuiRun,
  type TuiState
} from './types'

// ---------- Partial streams ----------

/** The sanitized display text of every agent's streaming partial, kept outside the immutable state. */
export interface PartialTracker {
  /** Feed the agent's cumulative raw text; returns the sanitized text to display ('' clears). */
  update(runId: string, agentId: string, raw: string): string
  /** Drop one agent's stream (a completed transcript entry, agent.remove). */
  clear(runId: string, agentId: string): void
  /** Drop every stream of a run (it ended, or a snapshot resync replaced it). */
  clearRun(runId: string): void
  /** Number of streams held (tests). */
  readonly size: number
}

const streamKey = (runId: string, agentId: string): string => `${runId}\u0000${agentId}`

export function createPartialTracker(): PartialTracker {
  const sanitizers = new StreamSanitizers()
  const last = new Map<string, { raw: string; display: string }>()
  const drop = (key: string): void => {
    last.delete(key)
    sanitizers.drop(key)
  }
  return {
    update(runId, agentId, raw) {
      const key = streamKey(runId, agentId)
      const text = typeof raw === 'string' ? raw : ''
      if (text === '') {
        drop(key)
        return ''
      }
      const prev = last.get(key)
      // Extend only while the stream's sanitizer still holds the parser state of everything before (it may have been
      // evicted by StreamSanitizers' cap); otherwise restart and sanitize the whole text fresh.
      if (prev && text.startsWith(prev.raw) && sanitizers.has(key)) {
        const display = prev.display + sanitizers.for(key).write(text.slice(prev.raw.length))
        last.set(key, { raw: text, display })
        return display
      }
      drop(key)
      const display = sanitizers.for(key).write(text)
      last.set(key, { raw: text, display })
      // Keep the map within the sanitizers' own cap: a stream they evicted restarts anyway.
      if (last.size > sanitizers.size) for (const k of last.keys()) if (!sanitizers.has(k)) last.delete(k)
      return display
    },
    clear(runId, agentId) {
      drop(streamKey(runId, agentId))
    },
    clearRun(runId) {
      const prefix = `${runId}\u0000`
      for (const k of [...last.keys()]) if (k.startsWith(prefix)) drop(k)
    },
    get size() {
      return last.size
    }
  }
}

// ---------- Cards ----------

/** The PendingCards bucket of each card kind. */
export const CARD_BUCKETS: Record<CardKind, keyof PendingCards> = {
  permission: 'permissions',
  question: 'questions',
  proposal: 'proposals',
  rules: 'ruleRequests',
  merge: 'mergeReviews',
  mcpInstall: 'mcpInstalls'
}

/** Kinds in the order a snapshot's cards are numbered (the needs-you order: blocking kinds first). */
export const CARD_KIND_ORDER: readonly CardKind[] = ['rules', 'question', 'proposal', 'merge', 'permission', 'mcpInstall']

const arrival = new WeakMap<object, number>()

/** The cardSeq a card got when it arrived (undefined for a card this reducer never saw). */
export function cardArrivalSeq(card: object): number | undefined {
  return arrival.get(card)
}

export function emptyCards(): PendingCards {
  return { permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] }
}

type AnyCard = { id: string; revision?: number }

function bucketOf(cards: PendingCards, kind: CardKind): AnyCard[] {
  return cards[CARD_BUCKETS[kind]] as AnyCard[]
}

function withBucket(cards: PendingCards, kind: CardKind, list: AnyCard[]): PendingCards {
  return { ...cards, [CARD_BUCKETS[kind]]: list } as PendingCards
}

/** The card a *.request event carries, or null. */
function requestOf(e: RunEvent): { kind: CardKind; card: AnyCard } | null {
  switch (e.type) {
    case 'permission.request':
      return { kind: 'permission', card: e.request }
    case 'question.request':
      return { kind: 'question', card: e.question }
    case 'proposal.request':
      return { kind: 'proposal', card: e.proposal }
    case 'rules.request':
      return { kind: 'rules', card: e.request }
    case 'merge.request':
      return { kind: 'merge', card: e.review }
    case 'mcpInstall.request':
      return { kind: 'mcpInstall', card: e.request }
    default:
      return null
  }
}

/** The card a *.resolved event closes, or null. */
function resolvedOf(e: RunEvent): { kind: CardKind; id: string; cancelled: boolean; decidedBy?: ResolvedCardInfo['decidedBy'] } | null {
  switch (e.type) {
    case 'permission.resolved':
      return { kind: 'permission', id: e.requestId, cancelled: !!e.cancelled, decidedBy: e.decidedBy }
    case 'question.resolved':
      return { kind: 'question', id: e.questionId, cancelled: !!e.cancelled, decidedBy: e.decidedBy }
    case 'proposal.resolved':
      return { kind: 'proposal', id: e.proposalId, cancelled: !!e.cancelled, decidedBy: e.decidedBy }
    case 'rules.resolved':
      return { kind: 'rules', id: e.requestId, cancelled: !!e.cancelled, decidedBy: e.decidedBy }
    case 'merge.resolved':
      return { kind: 'merge', id: e.reviewId, cancelled: !!e.cancelled, decidedBy: e.decidedBy }
    case 'mcpInstall.resolved':
      return { kind: 'mcpInstall', id: e.requestId, cancelled: !!e.cancelled, decidedBy: e.decidedBy }
    default:
      return null
  }
}

// ---------- Helpers ----------

const OPEN_STATUSES = new Set(['starting', 'running', 'idle', 'stopping'])
const TERMINAL_STATUSES = new Set(['finished', 'error', 'paused'])

function newRun(summary: RunSummary): TuiRun {
  return { summary, agents: {}, transcript: [], partials: {}, cards: emptyCards(), recordLoaded: false }
}

/** A placeholder summary for a run the state has not seen yet (the session fetches the real one). */
function stubSummary(s: TuiState, runId: string, now: number): RunSummary {
  const projectId = s.project?.id ?? (s.activeRunId ? s.runs[s.activeRunId]?.summary.projectId : undefined) ?? ''
  return { id: runId, projectId, kind: 'work', prompt: '', status: 'starting', startedAt: now, totalCostUsd: 0 }
}

/** The project whose runs runOrder numbers: the project, else the active run's (quick runs). */
function orderProjectId(s: TuiState): string | undefined {
  return s.project?.id ?? (s.activeChain[0] ? s.runs[s.activeChain[0]]?.summary.projectId : undefined)
}

/** Insert ids into runOrder by start time (ids whose start is unknown count as older). */
function withOrder(s: TuiState, add: readonly RunSummary[]): string[] {
  const pid = orderProjectId(s)
  let order = s.runOrder
  for (const r of add) {
    if (pid !== undefined && r.projectId !== pid) continue
    if (order.includes(r.id)) continue
    const startOf = (id: string): number => s.runs[id]?.summary.startedAt ?? add.find((x) => x.id === id)?.startedAt ?? -Infinity
    let at = order.length
    while (at > 0 && startOf(order[at - 1]) > r.startedAt) at--
    order = [...order.slice(0, at), r.id, ...order.slice(at)]
  }
  return order
}

/** Entries appended without duplicates (by id), capped at TUI_TRANSCRIPT_MAX keeping the newest. */
function appendEntries(run: TuiRun, entries: readonly TranscriptEntry[]): TuiRun {
  const seen = new Set(run.transcript.map((e) => e.id))
  const add = entries.filter((e) => e && typeof e.id === 'string' && !seen.has(e.id) && (seen.add(e.id), true))
  if (add.length === 0) return run
  return capped({ ...run, transcript: [...run.transcript, ...add] })
}

function capped(run: TuiRun): TuiRun {
  const over = run.transcript.length - TUI_TRANSCRIPT_MAX
  if (over <= 0) return run
  return { ...run, transcript: run.transcript.slice(over), omitted: (run.omitted ?? 0) + over }
}

function withoutPartial(run: TuiRun, agentId: string): TuiRun {
  if (!(agentId in run.partials)) return run
  const partials = { ...run.partials }
  delete partials[agentId]
  return { ...run, partials }
}

function putRun(s: TuiState, run: TuiRun): TuiState {
  return { ...s, runs: { ...s.runs, [run.summary.id]: run } }
}

/**
 * Chain following: while a run in the state continues the newest member of activeChain (`resumedFrom`), it joins the
 * chain and becomes the active run.
 */
function followSuccessors(s: TuiState): TuiState {
  let out = s
  for (let hops = 0; hops < 50; hops++) {
    const newest = out.activeChain[out.activeChain.length - 1]
    if (!newest) return out
    const next = Object.values(out.runs).find((r) => r.summary.resumedFrom === newest && !out.activeChain.includes(r.summary.id))
    if (!next) return out
    out = { ...out, activeChain: [...out.activeChain, next.summary.id], activeRunId: next.summary.id, composeTarget: 'active' }
  }
  return out
}

/**
 * Merge a run record's transcript into what the state holds: the record's entries win; kept entries it does not have
 * lead it when they are older than its first entry (the host left them out) and follow it otherwise (events that
 * arrived after the record was read). No entry id appears twice.
 */
function mergeTranscript(kept: readonly TranscriptEntry[], record: readonly TranscriptEntry[]): { entries: TranscriptEntry[]; lead: number } {
  const ids = new Set(record.map((e) => e.id))
  const firstAt = record.length > 0 ? record[0].at : Infinity
  const extra = kept.filter((e) => !ids.has(e.id))
  const lead = extra.filter((e) => e.at < firstAt)
  const tail = extra.filter((e) => e.at >= firstAt)
  const seen = new Set<string>()
  const entries = [...lead, ...record, ...tail].filter((e) => !seen.has(e.id) && (seen.add(e.id), true))
  return { entries, lead: lead.length }
}

// ---------- Public reducer ----------

export function createInitialState(folder: string): TuiState {
  return {
    connection: 'connecting',
    folder,
    runs: {},
    runOrder: [],
    activeChain: [],
    composeTarget: 'active',
    notices: [],
    resolved: [],
    cardSeq: 0
  }
}

export interface ApplyOptions {
  /** The session's partial streams (agent.partial). */
  partials?: PartialTracker
  /** Epoch ms for resolved-card infos, stub runs and end times (default Date.now()). */
  now?: number
}

/**
 * A runs:subscribe snapshot: the snapshot's runs replace theirs (summary and cards), runs it no longer lists that are
 * still open in the state are dropped (unless in the active chain), cards it does not list are gone, and the active
 * run's record (when included) is merged without duplicating transcript entries.
 */
export function applySnapshot(s: TuiState, res: SnapshotResult, opts: { activeRunId?: string } & ApplyOptions = {}): TuiState {
  const snap = res.snapshot
  const listed = [...(snap.liveRuns ?? []), ...(snap.recentEndedRuns ?? [])].filter((r) => r && typeof r.id === 'string')
  const listedIds = new Set(listed.map((r) => r.id))
  const runs: Record<string, TuiRun> = {}
  for (const [id, run] of Object.entries(s.runs)) {
    if (listedIds.has(id)) continue
    // An open run the host no longer lists ended while we were away; its stale status must not linger.
    if (OPEN_STATUSES.has(run.summary.status) && !s.activeChain.includes(id) && id !== opts.activeRunId) continue
    runs[id] = Object.values(run.cards).every((l) => l.length === 0) ? run : { ...run, cards: emptyCards() }
  }
  let seq = s.cardSeq
  for (const summary of listed) {
    const prev = s.runs[summary.id]
    const incoming = snap.pendingCards?.[summary.id]
    let cards = emptyCards()
    if (incoming) {
      for (const kind of CARD_KIND_ORDER) {
        const list = ((incoming[CARD_BUCKETS[kind]] ?? []) as AnyCard[]).filter((c) => c && typeof c.id === 'string')
        for (const c of list) {
          const old = prev ? bucketOf(prev.cards, kind).find((x) => x.id === c.id) : undefined
          const oldSeq = old ? arrival.get(old) : undefined
          arrival.set(c, oldSeq ?? ++seq)
        }
        cards = withBucket(cards, kind, list)
      }
    }
    opts.partials?.clearRun(summary.id)
    runs[summary.id] = prev ? { ...prev, summary, cards, partials: {} } : { ...newRun(summary), cards }
  }
  if (s.hostInstanceId && s.hostInstanceId !== res.hostInstanceId) {
    for (const [id, run] of Object.entries(runs)) if (run.messages?.length) runs[id] = { ...run, messages: [] }
  }
  let out: TuiState = { ...s, runs, hostInstanceId: res.hostInstanceId, lastSeq: res.seq, cardSeq: seq, connection: 'live' }
  if (opts.activeRunId && out.activeRunId !== opts.activeRunId) out = setActiveRun(out, opts.activeRunId)
  out = { ...out, runOrder: withOrder(out, listed) }
  if (snap.activeRun) out = applyRecord(out, snap.activeRun, { omitted: snap.activeRunOmitted, partials: opts.partials })
  return followSuccessors(out)
}

/**
 * A run record (snapshot activeRun or runs:get): summary, agents, plan and staffing replaced, transcript merged by entry id,
 * recordLoaded set. `omitted` is the count of oldest entries the host left out. With `preferLive` (a runs:get answer
 * for a run the events already touched) the agents the state holds win over the record's.
 */
export function applyRecord(s: TuiState, rec: RunRecord, opts: { omitted?: number; partials?: PartialTracker; preferLive?: boolean } = {}): TuiState {
  if (!rec || !rec.summary || typeof rec.summary.id !== 'string') return s
  const id = rec.summary.id
  const prev = s.runs[id] ?? newRun(rec.summary)
  const { entries, lead } = mergeTranscript(prev.transcript, Array.isArray(rec.transcript) ? rec.transcript : [])
  const hostOmitted = typeof opts.omitted === 'number' && opts.omitted > 0 ? opts.omitted : 0
  const omitted = Math.max(0, hostOmitted - lead)
  const run: TuiRun = capped({
    ...prev,
    summary: rec.summary,
    // preferLive (a runs:get answer racing pushed events): agents the events already updated keep their newer copy.
    agents: opts.preferLive ? { ...(rec.agents ?? {}), ...prev.agents } : (rec.agents ?? {}),
    transcript: entries,
    ...(rec.plan ? { plan: rec.plan } : {}),
    ...(rec.staffing ? { staffing: rec.staffing } : {}),
    omitted: omitted || undefined,
    recordLoaded: true
  })
  if (!run.omitted) delete run.omitted
  let out = putRun(s, run)
  out = { ...out, runOrder: withOrder(out, [rec.summary]) }
  return followSuccessors(out)
}

/** A run summary from a host answer (runs:start, runs:continue, runs:get, runs:list): replaces the run's summary. */
export function upsertRunSummary(s: TuiState, summary: RunSummary): TuiState {
  if (!summary || typeof summary.id !== 'string') return s
  const prev = s.runs[summary.id]
  let out = putRun(s, prev ? { ...prev, summary } : newRun(summary))
  out = { ...out, runOrder: withOrder(out, [summary]) }
  return followSuccessors(out)
}

/** A runs:list answer for the project: numbers every run (R1 = oldest) without loading them. */
export function applyRunList(s: TuiState, list: readonly RunSummary[]): TuiState {
  const pid = orderProjectId(s)
  const mine = list.filter((r) => r && typeof r.id === 'string' && (pid === undefined || r.projectId === pid))
  const sorted = [...mine].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)).map((r) => r.id)
  const listed = new Set(sorted)
  const base: TuiState = { ...s, runOrder: sorted }
  // Runs the state knows that the list missed (started since): inserted by start time, unknown ones appended.
  const known = s.runOrder.filter((id) => !listed.has(id) && s.runs[id]).map((id) => s.runs[id].summary)
  const order = withOrder(base, known)
  return { ...base, runOrder: [...order, ...s.runOrder.filter((id) => !listed.has(id) && !s.runs[id])] }
}

/** Focus a run: `chain` (oldest first, ending with runId) or just [runId]. */
export function setActiveRun(s: TuiState, runId: string, chain?: readonly string[]): TuiState {
  const ids = chain && chain.length > 0 && chain[chain.length - 1] === runId ? [...chain] : [runId]
  return followSuccessors({ ...s, activeChain: ids, activeRunId: runId, composeTarget: 'active' })
}

/** Nothing focused: the composer starts a new run. */
export function clearActiveRun(s: TuiState): TuiState {
  return { ...s, activeChain: [], activeRunId: undefined, composeTarget: 'new' }
}

export function setComposeTarget(s: TuiState, t: ComposeTarget): TuiState {
  return s.composeTarget === t ? s : { ...s, composeTarget: t }
}

export function setConnection(s: TuiState, c: ConnectionState): TuiState {
  return s.connection === c ? s : { ...s, connection: c }
}

export function setProject(s: TuiState, project: Project | undefined): TuiState {
  return { ...s, project }
}

/** One runs:event (pushed or replayed). */
export function applyEvent(s: TuiState, p: RunsEventParams, opts: ApplyOptions = {}): TuiState {
  const e = p?.event
  if (!e || typeof e !== 'object' || typeof e.runId !== 'string') return s
  const now = opts.now ?? Date.now()
  let out: TuiState = typeof p.seq === 'number' && (s.lastSeq === undefined || p.seq > s.lastSeq) ? { ...s, lastSeq: p.seq } : s

  switch (e.type) {
    case 'log':
      if (e.level === 'warn' || e.level === 'error') return addNotice(out, e.message, e.level === 'error' ? 'danger' : 'warn', now)
      // The run-start models line (cli-parity 3.1) is the one info log worth a notice.
      if (e.level === 'info' && typeof e.message === 'string' && e.message.startsWith('Models: ')) return addNotice(out, e.message, undefined, now)
      return out
    case 'project.updated':
      return out.project && e.project && out.project.id === e.project.id ? { ...out, project: e.project } : out
    case 'usage.status':
      return out
    default:
      break
  }

  const existing = out.runs[e.runId]
  if (!existing && (e.type === 'agent.partial' || e.type === 'agent.remove' || e.type === 'agent.message')) return out
  let run: TuiRun = existing ?? newRun(stubSummary(out, e.runId, now))
  const summary = run.summary

  switch (e.type) {
    case 'run.status': {
      const next: RunSummary = { ...summary, status: e.status }
      if (e.sessionId) next.sessionId = e.sessionId
      if (e.error) next.error = e.error
      if (e.pausedUntil !== undefined) next.pausedUntil = e.pausedUntil
      if (e.pauseReason !== undefined) next.pauseReason = e.pauseReason
      if (e.autoResume !== undefined) next.autoResume = e.autoResume
      Object.assign(next, statusEventEndFacts(e))
      if (TERMINAL_STATUSES.has(e.status) && next.endedAt === undefined) next.endedAt = now
      run = { ...run, summary: next }
      if (TERMINAL_STATUSES.has(e.status) && Object.keys(run.partials).length > 0) {
        opts.partials?.clearRun(e.runId)
        run = { ...run, partials: {} }
      }
      break
    }
    case 'run.finalized':
      if (e.summary && e.summary.id === e.runId) run = { ...run, summary: e.summary }
      break
    case 'run.title':
      run = { ...run, summary: { ...summary, title: e.title } }
      break
    case 'run.moved':
      run = { ...run, summary: { ...summary, projectId: e.projectId } }
      break
    case 'run.model':
      // The root's live model (a model switch): the status bar and the inspector read summary.modelSelection.
      if (!e.selection || typeof e.selection.model !== 'string' || typeof e.selection.connection !== 'string') return out
      run = { ...run, summary: { ...summary, modelSelection: { model: e.selection.model, connection: e.selection.connection } } }
      break
    case 'agent.upsert':
      if (!e.agent || typeof e.agent.id !== 'string') return out
      run = { ...run, agents: { ...run.agents, [e.agent.id]: e.agent } }
      break
    case 'agent.remove': {
      const agents: Record<string, AgentInstance> = { ...run.agents }
      delete agents[e.agentId]
      opts.partials?.clear(e.runId, e.agentId)
      run = withoutPartial({ ...run, agents }, e.agentId)
      break
    }
    case 'transcript':
      if (!e.entry || typeof e.entry.id !== 'string') return out
      run = appendEntries(run, [e.entry])
      opts.partials?.clear(e.runId, e.entry.agentId)
      run = withoutPartial(run, e.entry.agentId)
      break
    case 'agent.partial': {
      const text = opts.partials ? opts.partials.update(e.runId, e.agentId, e.text) : typeof e.text === 'string' ? sanitizeTty(e.text) : ''
      if (text === '') run = withoutPartial(run, e.agentId)
      else if (run.partials[e.agentId] === text) return out
      else run = { ...run, partials: { ...run.partials, [e.agentId]: text } }
      break
    }
    case 'plan.updated':
      run = { ...run, plan: e.plan }
      break
    case 'staffing.updated':
      run = { ...run, staffing: e.staffing }
      break
    case 'run.delegation': {
      const applied = applyRunDelegation(run.summary, run.agents, e)
      run = { ...run, summary: applied.summary, agents: applied.agents }
      break
    }
    case 'agent.message': {
      // Keep only a bounded, sanitized preview; full content remains in the transcript.
      if (typeof e.from !== 'string' || e.from === '') return out
      const rec = {
        from: e.from,
        to: typeof e.to === 'string' ? e.to : null,
        toHandle: typeof e.toHandle === 'string' ? safeLine(e.toHandle).slice(0, 80) : '',
        at: typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : now,
        text: typeof e.text === 'string' ? safeLine(e.text).slice(0, 200) : ''
      }
      if (run.messages?.some(m => m.from === rec.from && m.to === rec.to && m.toHandle === rec.toHandle && m.at === rec.at && m.text === rec.text)) return out
      run = { ...run, messages: [...(run.messages ?? []), rec].slice(-TUI_MESSAGES_MAX) }
      break
    }
    case 'run.usage':
      run = {
        ...run,
        summary: { ...summary, usage: e.usage, ...(typeof e.usage?.costUsd === 'number' ? { totalCostUsd: e.usage.costUsd } : {}) }
      }
      break
    case 'run.cost':
      if (typeof e.totalCostUsd === 'number' && Number.isFinite(e.totalCostUsd)) run = { ...run, summary: { ...summary, totalCostUsd: e.totalCostUsd } }
      break
    default: {
      const req = requestOf(e)
      if (req) {
        if (!req.card || typeof req.card.id !== 'string') return out
        const list = bucketOf(run.cards, req.kind)
        const at = list.findIndex((c) => c.id === req.card.id)
        if (at >= 0) {
          const kept = arrival.get(list[at])
          if (kept === undefined) out = { ...out, cardSeq: out.cardSeq + 1 }
          arrival.set(req.card, kept ?? out.cardSeq)
          run = { ...run, cards: withBucket(run.cards, req.kind, list.map((c, i) => (i === at ? req.card : c))) }
        } else {
          const seq = out.cardSeq + 1
          arrival.set(req.card, seq)
          out = { ...out, cardSeq: seq }
          run = { ...run, cards: withBucket(run.cards, req.kind, [...list, req.card]) }
        }
        break
      }
      const res = resolvedOf(e)
      if (res) {
        const list = bucketOf(run.cards, res.kind)
        const card = list.find((c) => c.id === res.id)
        if (card) run = { ...run, cards: withBucket(run.cards, res.kind, list.filter((c) => c.id !== res.id)) }
        const ref = { hostInstanceId: out.hostInstanceId ?? '', runId: e.runId, requestId: res.id, kind: res.kind, revision: card?.revision ?? 1 }
        const info: ResolvedCardInfo = { key: cardKey(ref), ref, cancelled: res.cancelled, ...(res.decidedBy ? { decidedBy: res.decidedBy } : {}), at: now }
        out = { ...out, resolved: [...out.resolved, info].slice(-TUI_RESOLVED_MAX) }
        break
      }
      // Other events (run.message, skill.used ...) change nothing the TUI keeps.
      return out
    }
  }

  out = putRun(out, run)
  if (!existing || summary !== run.summary) out = { ...out, runOrder: withOrder(out, [run.summary]) }
  return followSuccessors(out)
}

/** A notice (sanitized to one line), capped at TUI_NOTICE_MAX keeping the newest. */
export function addNotice(s: TuiState, text: string, tone?: Tone, now?: number): TuiState {
  const line = safeLine(text)
  if (!line) return s
  const id = (s.notices[s.notices.length - 1]?.id ?? 0) + 1
  const notice = { id, text: line, ...(tone ? { tone } : {}), at: now ?? Date.now() }
  return { ...s, notices: [...s.notices, notice].slice(-TUI_NOTICE_MAX) }
}
