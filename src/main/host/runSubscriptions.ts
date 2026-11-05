/**
 * runs:subscribe (cli-spec 3.3(4).1 and .3): input validation, the filter key, the run filter with chain following,
 * and the snapshot XOR replay result. Electron-free, relative imports only. The socket server owns delivery; this
 * module decides what matches.
 */
import { createHash } from 'node:crypto'
import { VIRTUAL_PROJECT_IDS } from '../../shared/types'
import type { PendingCards, RunEvent, RunRecord, RunSummary, RunsSubscribeInput, RunsSubscribeResult, SequencedHostEvent } from '../../shared/types'
import { CHAIN_WALK_MAX_HOPS } from '../../shared/view/runChains'
import { scrubImages } from './eventJournal'
import { HostRpcFailure } from './registry'

/** Runs ended this recently are in a snapshot's recentEndedRuns. */
export const RECENT_ENDED_MS = 10 * 60 * 1000
/** Caps on a subscription's id lists. */
export const SUBSCRIBE_MAX_IDS = 500
const ID_MAX_CHARS = 200

/** What a subscription reads of RunManager (RunManager fits). */
export interface RunsView {
  liveRuns(): RunSummary[]
  pendingCards(runId: string): PendingCards
  get(runId: string): RunRecord | null
  list(projectId: string): RunSummary[]
  /** A live run's summary. */
  summaryOf(runId: string): RunSummary | undefined
  /** A live or stored run's summary. */
  summary(runId: string): RunSummary | null
}

export interface JournalView {
  readonly currentSeq: number
  since(seq: number): SequencedHostEvent[] | 'evicted'
}

const bad = (m: string): HostRpcFailure => new HostRpcFailure('bad_request', m)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function idList(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (!Array.isArray(v)) throw bad(`runs:subscribe ${name} must be an array of ids`)
  if (v.length > SUBSCRIBE_MAX_IDS) throw bad(`runs:subscribe ${name} may list at most ${SUBSCRIBE_MAX_IDS} ids`)
  const out = new Set<string>()
  for (const id of v) {
    if (typeof id !== 'string' || id === '' || id.length > ID_MAX_CHARS) throw bad(`runs:subscribe ${name} must hold non-empty id strings`)
    out.add(id)
  }
  return [...out].sort()
}

function optString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v === '' || v.length > ID_MAX_CHARS) throw bad(`runs:subscribe ${name} must be a non-empty string`)
  return v
}

/** A cleaned RunsSubscribeInput (id lists deduped and sorted). Throws HostRpcFailure bad_request. */
export function parseRunsSubscribeInput(raw: unknown): RunsSubscribeInput {
  if (raw === undefined || raw === null) return {}
  if (!isObj(raw)) throw bad('runs:subscribe takes one object')
  const out: RunsSubscribeInput = {}
  const projectIds = idList(raw.projectIds, 'projectIds')
  const runIds = idList(raw.runIds, 'runIds')
  if (projectIds) out.projectIds = projectIds
  if (runIds) out.runIds = runIds
  const active = optString(raw.includeActiveRunRecord, 'includeActiveRunRecord')
  if (active) out.includeActiveRunRecord = active
  if (raw.followChains !== undefined && raw.followChains !== null) {
    if (typeof raw.followChains !== 'boolean') throw bad('runs:subscribe followChains must be a boolean')
    out.followChains = raw.followChains
  }
  if (raw.sinceSeq !== undefined && raw.sinceSeq !== null) {
    if (typeof raw.sinceSeq !== 'number' || !Number.isSafeInteger(raw.sinceSeq) || raw.sinceSeq < 0) throw bad('runs:subscribe sinceSeq must be a non-negative integer')
    out.sinceSeq = raw.sinceSeq
  }
  const filterKey = optString(raw.filterKey, 'filterKey')
  if (filterKey) out.filterKey = filterKey
  const hostInstanceId = optString(raw.hostInstanceId, 'hostInstanceId')
  if (hostInstanceId) out.hostInstanceId = hostInstanceId
  return out
}

/** First 16 hex chars of sha256 over the canonical filter: { projectIds, runIds, followChains, includeActiveRunRecord }. */
export function filterKeyOf(input: RunsSubscribeInput): string {
  const canonical = JSON.stringify([
    ['projectIds', input.projectIds ? [...new Set(input.projectIds)].sort() : null],
    ['runIds', input.runIds ? [...new Set(input.runIds)].sort() : null],
    ['followChains', input.followChains === true],
    ['includeActiveRunRecord', input.includeActiveRunRecord ?? null]
  ])
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

/**
 * The listed runs plus every known successor (a summary whose resumedFrom chain leads to a listed run), walking
 * runs.list over the projects of the listed runs, at most CHAIN_WALK_MAX_HOPS hops.
 */
export function followedRunsOf(runIds: readonly string[], view: RunsView): Set<string> {
  const followed = new Set(runIds)
  const projects = new Set<string>()
  for (const id of runIds) {
    const s = view.summaryOf(id) ?? view.summary(id)
    if (s) projects.add(s.projectId)
  }
  const children = new Map<string, string[]>()
  const addChild = (s: RunSummary): void => {
    if (!s.resumedFrom) return
    const list = children.get(s.resumedFrom) ?? []
    if (!list.includes(s.id)) list.push(s.id)
    children.set(s.resumedFrom, list)
  }
  for (const p of projects) for (const s of safeList(view, p)) addChild(s)
  for (const s of view.liveRuns()) addChild(s)
  let frontier = [...runIds]
  for (let hop = 0; hop < CHAIN_WALK_MAX_HOPS && frontier.length > 0; hop++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const child of children.get(id) ?? []) {
        if (followed.has(child)) continue
        followed.add(child)
        next.push(child)
      }
    }
    frontier = next
  }
  return followed
}

function safeList(view: RunsView, projectId: string): RunSummary[] {
  try {
    return view.list(projectId)
  } catch {
    return []
  }
}

/** One socket's run filter. matches() applies the chain-following rules, so call it once per event, in order. */
export class RunSubscription {
  readonly input: RunsSubscribeInput
  readonly filterKey: string
  readonly followed: Set<string>
  private readonly projectIds: ReadonlySet<string> | undefined
  private readonly empty: boolean

  constructor(
    input: RunsSubscribeInput,
    private readonly view: RunsView
  ) {
    this.input = input
    this.filterKey = filterKeyOf(input)
    this.projectIds = input.projectIds ? new Set(input.projectIds) : undefined
    this.empty = input.projectIds === undefined && input.runIds === undefined
    this.followed = input.followChains ? followedRunsOf(input.runIds ?? [], view) : new Set(input.runIds ?? [])
  }

  /** Counts toward the host's interactiveClients (cli-spec 3.2(4)). */
  get interactive(): boolean {
    return this.input.includeActiveRunRecord !== undefined
  }

  private projectOf(runId: string): string | undefined {
    return (this.view.summaryOf(runId) ?? this.view.summary(runId) ?? undefined)?.projectId
  }

  /** A summary (snapshot rows) matches without touching the followed set. */
  matchesSummary(s: RunSummary): boolean {
    return this.empty || this.followed.has(s.id) || (this.projectIds?.has(s.projectId) ?? false)
  }

  /** Does this event go to the subscriber? Durable events may grow the followed set first (followChains). */
  matches(event: RunEvent, durable = event.type !== 'agent.partial'): boolean {
    if (event.runId === '') {
      if (event.type === 'project.updated') return this.empty || (this.projectIds?.has(event.project.id) ?? false)
      return this.empty
    }
    const runId = event.runId
    const follow = durable && this.input.followChains === true
    if (follow && event.type === 'run.status' && !this.followed.has(runId)) {
      const s = this.view.summaryOf(runId) ?? this.view.summary(runId)
      if (s?.resumedFrom && this.followed.has(s.resumedFrom)) this.followed.add(runId)
    }
    let matched = this.empty || this.followed.has(runId)
    if (!matched && this.projectIds) {
      const p = this.projectOf(runId)
      matched = p !== undefined && this.projectIds.has(p)
      if (!matched && event.type === 'run.moved') matched = this.projectIds.has(event.fromProjectId) || this.projectIds.has(event.projectId)
    }
    if (matched && follow && event.type === 'run.moved') this.followed.add(runId)
    return matched
  }
}

export interface SubscribeDeps {
  view: RunsView
  journal: JournalView
  hostInstanceId: string
  /** Stored project ids (every project when the filter names none). */
  storedProjectIds(): string[]
  now?: () => number
}

/**
 * Build the result synchronously: replay when the client's hostInstanceId and filterKey match ours and sinceSeq is
 * still in the ring, else a snapshot. The returned subscription has applied every replayed event's follow rules.
 */
export function subscribeRuns(input: RunsSubscribeInput, deps: SubscribeDeps): { result: RunsSubscribeResult; subscription: RunSubscription } {
  const sub = new RunSubscription(input, deps.view)
  const { journal, hostInstanceId, view } = deps
  if (input.sinceSeq !== undefined && input.hostInstanceId === hostInstanceId && input.filterKey === sub.filterKey && input.sinceSeq <= journal.currentSeq) {
    const stored = journal.since(input.sinceSeq)
    if (stored !== 'evicted') {
      const events = stored.filter((e) => sub.matches(e.event, true))
      return {
        result: { mode: 'replay', hostInstanceId, fromSeq: input.sinceSeq, toSeq: journal.currentSeq, filterKey: sub.filterKey, events },
        subscription: sub
      }
    }
  }
  const liveRuns = view.liveRuns().filter((s) => sub.matchesSummary(s))
  const pendingCards: Record<string, PendingCards> = {}
  for (const s of liveRuns) pendingCards[s.id] = view.pendingCards(s.id)
  const now = (deps.now ?? Date.now)()
  const liveIds = new Set(liveRuns.map((s) => s.id))
  const projects = new Set<string>()
  if (input.projectIds || input.runIds) {
    for (const p of input.projectIds ?? []) projects.add(p)
    for (const id of sub.followed) {
      const s = view.summaryOf(id) ?? view.summary(id)
      if (s) projects.add(s.projectId)
    }
  } else {
    for (const p of deps.storedProjectIds()) projects.add(p)
    for (const p of VIRTUAL_PROJECT_IDS) projects.add(p)
  }
  const recentEndedRuns: RunSummary[] = []
  const seen = new Set<string>()
  for (const p of projects) {
    for (const s of safeList(view, p)) {
      if (seen.has(s.id) || liveIds.has(s.id)) continue
      seen.add(s.id)
      if (typeof s.endedAt !== 'number' || now - s.endedAt > RECENT_ENDED_MS || !sub.matchesSummary(s)) continue
      recentEndedRuns.push(s)
    }
  }
  recentEndedRuns.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const snapshot: Extract<RunsSubscribeResult, { mode: 'snapshot' }>['snapshot'] = { liveRuns, pendingCards, recentEndedRuns }
  if (input.includeActiveRunRecord) {
    const rec = view.get(input.includeActiveRunRecord)
    if (rec) snapshot.activeRun = scrubImages(rec)
  }
  return { result: { mode: 'snapshot', hostInstanceId, seq: journal.currentSeq, filterKey: sub.filterKey, snapshot }, subscription: sub }
}
