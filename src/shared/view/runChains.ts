import type { RunEndedBy, RunStatus, RunSummary } from '@shared/types'

/**
 * Session chains. Continuing a run starts a new run that resumes the old run's provider session, so the new run
 * has `resumedFrom` = old id and (once init arrives) the same `sessionId`. A chain is the set of runs linked by
 * either; only its newest member may be continued.
 */

export type ChainSummary = Pick<RunSummary, 'id' | 'startedAt' | 'status'> & Partial<Pick<RunSummary, 'sessionId' | 'resumedFrom' | 'projectId' | 'modelSelection'>>

const OPEN: ReadonlySet<RunStatus> = new Set<RunStatus>(['starting', 'running', 'idle', 'stopping'])
const CONTINUABLE: ReadonlySet<RunStatus> = new Set<RunStatus>(['finished', 'error', 'paused'])

/** Run is open: a live session still taking work or messages. */
export const isOpenStatus = (status: RunStatus): boolean => OPEN.has(status)

/** Members of the run's session chain, oldest first. Includes the run itself; empty when the id is unknown. */
export function chainOf<T extends ChainSummary>(runs: readonly T[], id: string): T[] {
  const start = runs.find((r) => r.id === id)
  if (!start) return []
  const members = new Set<string>([id])
  const queue: T[] = [start]
  while (queue.length > 0) {
    const cur = queue.pop() as T
    for (const r of runs) {
      if (members.has(r.id)) continue
      const linked =
        (cur.sessionId !== undefined && r.sessionId === cur.sessionId) || r.resumedFrom === cur.id || cur.resumedFrom === r.id
      if (linked) {
        members.add(r.id)
        queue.push(r)
      }
    }
  }
  return runs.filter((r) => members.has(r.id)).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

/** How many fetch rounds `loadChain` walks back along `resumedFrom` before it stops. */
export const CHAIN_WALK_MAX_HOPS = 50

/** How many of a chain's newest members a chain load fetches before the user asks for earlier ones ("Load earlier sessions"). */
export const CHAIN_EAGER_MEMBERS = 10

/** How many run records a chain load fetches at once. */
export const CHAIN_FETCH_CONCURRENCY = 4

/**
 * The run ids a chain load should fetch next: the newest `limit` known chain members (the run alone when it is
 * unknown) and, while that window is not full, every unknown `resumedFrom` target of them, minus `skip` (already
 * fetched or tried). Empty means the walk is done.
 */
export function chainIdsToLoad<T extends ChainSummary>(runs: readonly T[], id: string, skip: ReadonlySet<string>, limit: number = CHAIN_EAGER_MEMBERS): string[] {
  const members = chainOf(runs, id)
  const known = new Set(members.map((m) => m.id))
  const window = members.length > 0 ? members.slice(-Math.max(1, limit)) : [{ id } as ChainSummary]
  const out = new Set<string>()
  // The viewed run is always loaded, even when it is not among the newest members.
  out.add(id)
  for (const m of window) {
    out.add(m.id)
    if (m.resumedFrom && !known.has(m.resumedFrom) && window.length < limit) out.add(m.resumedFrom)
  }
  return [...out].filter((x) => !skip.has(x))
}

/** How many known chain members are older than the eager window `limit` and not loaded yet (the "Load earlier sessions" count). */
export function earlierMembersToLoad<T extends ChainSummary>(chain: readonly T[], loaded: (id: string) => boolean, limit: number): number {
  return chain.slice(0, Math.max(0, chain.length - limit)).filter((m) => !loaded(m.id)).length
}

/** Runs `fn` over `items` with at most `size` calls in flight at once; resolves when all settled (rejections are swallowed). */
export async function runBatched<T>(items: readonly T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item).catch(() => undefined)
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, size), items.length) }, worker))
}

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(['finished', 'error', 'paused'])
const END_FIELDS = ['endedBy', 'endedWhile', 'endedWithApp', 'endedAt', 'error'] as const

/**
 * A live run's summary may lack how it ended (older main processes send run.status without `endedBy`, and `error`,
 * `endedWithApp` come only from the record). When the persisted `row` has those fields and the run is terminal, returns the summary with them adopted; null when nothing differs. A live status
 * never adopts: main sets `endedBy` while the status is still 'stopping'.
 */
export function adoptEndFacts(summary: RunSummary, row: Partial<RunSummary>): RunSummary | null {
  if (!TERMINAL.has(summary.status)) return null
  let next: RunSummary | null = null
  for (const f of END_FIELDS) {
    const v = row[f]
    if (v === undefined || summary[f] === v) continue
    next = { ...(next ?? summary), [f]: v }
  }
  return next
}

/**
 * The end facts a run.status event carries (`endedBy`, `endedWhile`): taken on 'finished' / 'error', and on 'stopping'
 * only when `endedBy` is 'user' (End session). Other statuses, or an event without them, give {}.
 */
export function statusEventEndFacts(e: { status: RunStatus; endedBy?: RunEndedBy; endedWhile?: 'working' | 'waiting' }): { endedBy?: RunEndedBy; endedWhile?: 'working' | 'waiting' } {
  const terminal = e.status === 'finished' || e.status === 'error'
  if (!terminal && !(e.status === 'stopping' && e.endedBy === 'user')) return {}
  return { ...(e.endedBy ? { endedBy: e.endedBy } : {}), ...(terminal && e.endedWhile ? { endedWhile: e.endedWhile } : {}) }
}

/** The chain's newest member. */
export function newestOf<T extends ChainSummary>(runs: readonly T[], id: string): T | undefined {
  const chain = chainOf(runs, id)
  return chain[chain.length - 1]
}

/** The run that continued this one, from an already computed chain (oldest first). */
export function continuedByIn<T extends ChainSummary>(chain: readonly T[], id: string): T | undefined {
  const direct = chain.find((r) => r.resumedFrom === id)
  if (direct) return direct
  const i = chain.findIndex((r) => r.id === id)
  return i >= 0 ? chain[i + 1] : undefined
}

/** The run that continued this one (the next chain member), when this run is not the newest. */
export function continuedBy<T extends ChainSummary>(runs: readonly T[], id: string): T | undefined {
  return continuedByIn(chainOf(runs, id), id)
}

/** The run this one continues (its direct predecessor), when that record is known. */
export function predecessorOf<T extends ChainSummary>(runs: readonly T[], id: string): T | undefined {
  const run = runs.find((r) => r.id === id)
  if (!run?.resumedFrom) return undefined
  return runs.find((r) => r.id === run.resumedFrom)
}

/** canContinue from an already computed chain (oldest first). */
export function canContinueIn<T extends ChainSummary>(chain: readonly T[], id: string): boolean {
  const run = chain.find((r) => r.id === id)
  if (!run || (!run.sessionId && !run.modelSelection) || !CONTINUABLE.has(run.status)) return false
  return chain[chain.length - 1]?.id === id
}

/** Continue is offered only on the chain's newest member, once it stopped and has a provider session. */
export function canContinue<T extends ChainSummary>(runs: readonly T[], id: string): boolean {
  return canContinueIn(chainOf(runs, id), id)
}

interface CountedRun {
  summary: ChainSummary
  permissions?: readonly unknown[]
  proposals?: readonly unknown[]
  questions?: readonly unknown[]
  ruleRequests?: readonly unknown[]
  mergeReviews?: readonly unknown[]
  mcpInstalls?: readonly unknown[]
  plan?: { status: string }
}

/** An open run that is waiting for the user: an unanswered card, a question, a permission request or a blocked plan. */
export const needsYou = (r: CountedRun): boolean =>
  isOpenStatus(r.summary.status) &&
  ((r.permissions?.length ?? 0) +
    (r.proposals?.length ?? 0) +
    (r.questions?.length ?? 0) +
    (r.ruleRequests?.length ?? 0) +
    (r.mergeReviews?.length ?? 0) +
    (r.mcpInstalls?.length ?? 0) >
    0 ||
    r.plan?.status === 'blocked')

/** Open runs and runs that need the user, per project. */
export function projectCounts(runs: readonly CountedRun[], projectId: string): { open: number; needsYou: number } {
  let open = 0
  let waiting = 0
  for (const r of runs) {
    if (r.summary.projectId !== projectId) continue
    if (isOpenStatus(r.summary.status)) open++
    if (needsYou(r)) waiting++
  }
  return { open, needsYou: waiting }
}

/** Short relative time such as "just now", "5 min ago", "3 h ago", "2 d ago". */
export function relativeTime(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/** Parses a "Session already open" refusal from runs.continue; returns the live run's id. */
export function sessionOpenRunId(message: string): string | null {
  if (!/Session already open/i.test(message)) return null
  return /run (run_[A-Za-z0-9_-]+)/.exec(message)?.[1] ?? null
}

// ---------- One conversation per session chain (docs/design/ux-review-continue.md, model 1-6) ----------

type EndSummary = ChainSummary & Partial<Pick<RunSummary, 'endedAt' | 'endedWithApp' | 'title' | 'prompt' | 'error' | 'team'>> & { endedBy?: RunEndedBy; endedWhile?: 'working' | 'waiting' }

/** The chain's key: its oldest member's id. Stable across continues, so a chain tab or a chain view keeps its identity. */
export function chainKeyOf<T extends ChainSummary>(runs: readonly T[], id: string): string {
  return chainOf(runs, id)[0]?.id ?? id
}

/** One conversation: its members oldest first, the first (names it) and the newest (status, composer, sends). */
export interface ChainGroup<T extends ChainSummary> {
  key: string
  members: T[]
  first: T
  newest: T
}

/**
 * Every chain among `runs`, each run in exactly one group. Groups are ordered by their newest member's start, newest
 * first (History order); members inside a group oldest first.
 */
export function chainGroups<T extends ChainSummary>(runs: readonly T[]): ChainGroup<T>[] {
  // Union-find over the same links chainOf follows (shared sessionId, resumedFrom): linear in the run count, because
  // the tab selectors run on every store change.
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
    let cur = id
    while (cur !== root) {
      const next = parent.get(cur) as string
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const r of runs) if (!parent.has(r.id)) parent.set(r.id, r.id)
  const bySession = new Map<string, string>()
  for (const r of runs) {
    if (r.resumedFrom && parent.has(r.resumedFrom)) union(r.id, r.resumedFrom)
    if (r.sessionId !== undefined) {
      const other = bySession.get(r.sessionId)
      if (other !== undefined) union(r.id, other)
      else bySession.set(r.sessionId, r.id)
    }
  }
  const byRoot = new Map<string, T[]>()
  const seen = new Set<string>()
  for (const r of runs) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const root = find(r.id)
    const list = byRoot.get(root)
    if (list) list.push(r)
    else byRoot.set(root, [r])
  }
  const groups: ChainGroup<T>[] = []
  for (const list of byRoot.values()) {
    const members = list.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
    groups.push({ key: members[0].id, members, first: members[0], newest: members[members.length - 1] })
  }
  return groups.sort((a, b) => b.newest.startedAt - a.newest.startedAt || a.key.localeCompare(b.key))
}

/** When the run last did anything: its end, else its start. */
export const lastActivityAt = (r: Pick<RunSummary, 'startedAt'> & Partial<Pick<RunSummary, 'endedAt'>>): number => r.endedAt ?? r.startedAt

/** "right away", "3 min later", "2 h later", "4 d later" for the gap between two chain members. */
export function gapLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 45) return 'right away'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min later`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h later`
  return `${Math.round(h / 24)} d later`
}

/** The quiet divider row where a continuation starts in the merged feed. `title` holds the exact time. */
export interface ContinuationDivider {
  runId: string
  label: string
  title: string
}

const cutByApp = (s: EndSummary): boolean => s.endedBy === 'app' || (s.endedBy === undefined && !!s.endedWithApp)

/**
 * The divider before `member` (a chain member with a predecessor `prev`): "Continued after OrgAI closed" when the
 * earlier session was cut by OrgAI closing, else "Continued 3 min later" (gap from the earlier session's end).
 */
export function continuationDivider(prev: EndSummary, member: EndSummary): ContinuationDivider {
  const label = cutByApp(prev) ? 'Continued after OrgAI closed' : `Continued ${gapLabel(member.startedAt - lastActivityAt(prev))}`
  return { runId: member.id, label, title: `Continued ${new Date(member.startedAt).toLocaleString()}` }
}

/** What Send does on the chain's newest ended member and how the composer says it (model 3 and 6). */
export interface EndedComposerCopy {
  mode: 'continue' | 'new'
  /** The mode line above the field. */
  modeLabel: string
  placeholder: string
  /** A warning-tone notice above the field, plain text (cut by OrgAI closing). */
  notice?: string
}

const clipReason = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')
  return one.length > 160 ? one.slice(0, 159) + '…' : one
}

/**
 * Copy for an ended run's composer. `continuable` is canContinue (newest member, a session id, ended). `cutWhile` is
 * lib/runStatus cutWhile of the record as loaded (before settling); 'working' when unknown (a clean quit settles
 * the agents before saving, so only a crash leaves the trace). `errorShown`: the view's danger Banner shows the error.
 */
export function endedComposerCopy(
  summary: EndSummary & Pick<RunSummary, 'status'>,
  opts: { continuable: boolean; cutWhile?: 'working' | 'waiting'; now?: number; errorShown?: boolean }
): EndedComposerCopy {
  if (!opts.continuable) return { mode: 'new', modeLabel: 'This run cannot be continued (no saved session).', placeholder: 'Describe the task' }
  const now = opts.now ?? Date.now()
  const placeholder = summary.team === 'single' ? 'Message the assistant' : 'Message the orchestrator'
  const ended = `Session ended ${relativeTime(lastActivityAt(summary), now)}. Send to continue with its memory.`
  if (summary.status === 'error') {
    // The danger Banner above already says why (L4): the mode line then leaves the reason out.
    const reason = opts.errorShown ? '' : clipReason(summary.error ?? '')
    return { mode: 'continue', modeLabel: `This run failed${reason ? `: ${reason}` : ''}. Send to try again with its memory.`, placeholder }
  }
  if (cutByApp(summary)) {
    return {
      mode: 'continue',
      modeLabel: ended,
      placeholder: 'Pick up where it was cut off',
      notice: `OrgAI closed while this run was ${(summary.endedWhile ?? opts.cutWhile) === 'waiting' ? 'waiting for you' : 'working'}. Send to pick up where it stopped.`
    }
  }
  return { mode: 'continue', modeLabel: ended, placeholder }
}
