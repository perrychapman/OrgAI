/**
 * Pure view-model selectors over TuiState (W4-T1). Every string a row carries is sanitized here (safe / safeLine from
 * output.ts, or sanitizeTty), so the panes render them as plain text. Words come from the shared view models only:
 * status from statusText (render.ts statusWordOf), names from agentLabel / runName, costs from costView, the needs-you
 * count from decisionCount (cli-spec 2 item 4).
 */
import type { AgentInstance, AgentState, CardKind, RunSummary, TranscriptEntry } from '../../shared/types'
import { agentCostInput, costView, runCostInput, sumCosts } from '../../shared/view/cost'
import { normalizeParents } from '../../shared/view/agentTree'
import { foldFinished, isSettledAt } from '../../shared/view/foldFinished'
import { decisionCount, type WaitRun } from '../../shared/view/needsYou'
import { canContinueIn, isOpenStatus } from '../../shared/view/runChains'
import { runName, runTag } from '../../shared/view/runLabels'
import { settleEndedAgents, type RunTone } from '../../shared/view/runStatus'
import { humanizeToolResult, humanizeToolUse, mergeChainFeed } from '../../shared/view/transcriptRows'
import { safe, safeLine } from '../output'
import { agentLabel, imageLabel, pendingItems, statusViewOf, toolNamesOf } from '../render'
import { statusText } from '../../shared/view/runStatus'
import { CARD_BUCKETS, cardArrivalSeq } from './state'
import {
  cardKey,
  type CardRef,
  type ComposerMode,
  type OrgTreeRow,
  type PartialRow,
  type PlanView,
  type StatusSummary,
  type Tone,
  type TranscriptRow,
  type TrayCard,
  type TuiRun,
  type TuiState,
  type WorktreeRow
} from './types'

// ---------- Shared helpers ----------

/** "R3" for a run (its place in the project's runOrder, oldest = R1), "R?" while unknown. */
export function runTagOf(s: TuiState, runId: string): string {
  const at = s.runOrder.indexOf(runId)
  return runTag(at >= 0 ? at + 1 : undefined)
}

/** The active chain's runs the state holds, oldest first. */
export function chainRuns(s: TuiState): TuiRun[] {
  return s.activeChain.map((id) => s.runs[id]).filter((r): r is TuiRun => !!r)
}

export function activeRun(s: TuiState): TuiRun | undefined {
  return s.activeRunId ? s.runs[s.activeRunId] : undefined
}

function waitRunOf(r: TuiRun): WaitRun {
  return {
    summary: r.summary,
    agents: r.agents,
    permissions: r.cards.permissions,
    proposals: r.cards.proposals,
    questions: r.cards.questions,
    ruleRequests: r.cards.ruleRequests,
    mergeReviews: r.cards.mergeReviews,
    mcpInstalls: r.cards.mcpInstalls,
    plan: r.plan
  }
}

/** Open decisions of one run (cards of an open run). */
function openDecisions(r: TuiRun): number {
  return pendingItems(r.summary, r.cards, r.agents).length
}

const RUN_TONE: Record<RunTone, Tone> = {
  'is-running': 'running',
  warn: 'warn',
  idle: 'dim',
  paused: 'warn',
  ok: 'ok',
  danger: 'danger',
  stopped: 'dim'
}

const AGENT_STATE_WORD: Record<AgentState, string> = {
  starting: 'Starting',
  thinking: 'Thinking',
  tool: 'Using a tool',
  waiting: 'Needs you',
  delegating: 'Delegating',
  idle: 'Idle',
  done: 'Finished',
  error: 'Failed'
}

const ACTIVITY_MAX = 120

function clipLine(s: string, max: number): string {
  const cs = [...s]
  return cs.length > max ? `${cs.slice(0, max - 1).join('')}…` : s
}

// ---------- Decision tray ----------

const CARD_KINDS = Object.keys(CARD_BUCKETS) as CardKind[]

function cardsOfRun(s: TuiState, run: TuiRun): TrayCard[] {
  const out: TrayCard[] = []
  const projectKind = s.project && run.summary.projectId === s.project.id ? (s.project.kind === 'engagement' ? 'engagement' : 'code') : undefined
  const tag = runTagOf(s, run.summary.id)
  for (const kind of CARD_KINDS) {
    const list = run.cards[CARD_BUCKETS[kind]] as { id: string; revision?: number }[]
    for (const card of list ?? []) {
      const ref: CardRef = { hostInstanceId: s.hostInstanceId ?? '', runId: run.summary.id, requestId: card.id, kind, revision: card.revision ?? 1 }
      const rawAgent = (card as { agentId?: unknown }).agentId
      const agentId = typeof rawAgent === 'string' ? rawAgent : undefined
      out.push({
        key: cardKey(ref),
        ref,
        runTag: tag,
        ...(agentId ? { agentId, agentLabel: agentLabel(run.agents[agentId]) } : {}),
        runKind: run.summary.kind,
        ...(projectKind ? { projectKind } : {}),
        arrivedSeq: cardArrivalSeq(card) ?? 0,
        kind,
        card
      } as TrayCard)
    }
  }
  return out
}

/**
 * Every open card, the active chain's first, then the project's other runs; within each group by arrival
 * (cardSeq), across kinds, so a later card never takes the top of the tray.
 */
export function trayCards(s: TuiState): TrayCard[] {
  const chain = new Set(s.activeChain)
  const pid = s.project?.id
  const byArrival = (a: TrayCard, b: TrayCard): number => a.arrivedSeq - b.arrivedSeq || a.key.localeCompare(b.key)
  const first: TrayCard[] = []
  const rest: TrayCard[] = []
  for (const run of Object.values(s.runs)) {
    if (chain.has(run.summary.id)) first.push(...cardsOfRun(s, run))
    else if (pid === undefined || run.summary.projectId === pid) rest.push(...cardsOfRun(s, run))
  }
  return [...first.sort(byArrival), ...rest.sort(byArrival)]
}

export function topCard(s: TuiState): TrayCard | undefined {
  return trayCards(s)[0]
}

// ---------- Org tree ----------

/** How the tree folds finished agents (F1). Without options nothing folds. */
export interface OrgTreeOptions {
  /** Hide finished agents (the app's default; the TUI's `h`). */
  collapse?: boolean
  /** Expanded group keys: a visible agent's id or an earlier-session key; a number is when it was expanded. */
  expanded?: Readonly<Record<string, boolean | number>>
  /** The clock for the settle grace (tests pass it; the App passes its own `now`). */
  now?: number
}

/** Does the role name add anything beside the label? ("implementer-1" already says Implementer.) */
function roleAdds(label: string, role: string): boolean {
  const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]/g, '')
  const r = norm(role)
  if (!r) return false
  return !norm(label).includes(r.slice(0, Math.min(5, r.length)))
}

/** The chip a worktree earns on its agent's row: files changed while it is open, else the state that needs a look. */
function worktreeChipOf(wt: NonNullable<AgentInstance['worktree']>): string | undefined {
  switch (wt.status) {
    case 'review':
      return 'review'
    case 'conflict':
      return 'conflict'
    case 'held':
      return 'held'
    case 'active':
    case 'merging':
    case 'waiting-children': {
      const n = Array.isArray(wt.changedFiles) ? wt.changedFiles.length : 0
      return n > 0 ? `${n}f` : undefined
    }
    default:
      return undefined
  }
}

const GROUP_NAMES_MAX = 6

function groupRow(runId: string, depth: number, members: AgentInstance[], over: Partial<OrgTreeRow>): OrgTreeRow {
  const failed = members.filter((m) => m.state === 'error').length
  const cost = costView(sumCosts(members.map((m) => agentCostInput(m))))
  const names = members.slice(0, GROUP_NAMES_MAX).map((m) => agentLabel(m))
  const more = members.length > GROUP_NAMES_MAX ? `, +${members.length - GROUP_NAMES_MAX} more` : ''
  return {
    id: `group:${runId}:${over.groupKey ?? ''}`,
    runId,
    depth,
    label: `${members.length} done`,
    role: '',
    state: failed === members.length ? 'error' : 'done',
    stateWord: failed > 0 ? `(${failed} failed)` : '',
    activity: `${names.join(', ')}${more}`,
    costText: cost.empty ? '' : cost.text,
    isRoot: false,
    kind: 'group',
    count: members.length,
    failed,
    ...over
  }
}

function treeOf(
  run: TuiRun,
  depth0: number,
  earlier: boolean,
  skipRoot: boolean,
  opts: OrgTreeOptions = {},
  waiting: Readonly<Record<string, string[]>> = {}
): OrgTreeRow[] {
  const agents = settleEndedAgents(run.summary, run.agents)
  const list = Object.values(agents)
  const ids = new Set(list.map((a) => a.id))
  const runId = run.summary.id
  const earlierGroupKey = `earlier:${runId}`
  const expanded = opts.expanded ?? {}

  // Earlier sessions are over: with Hide finished on, one "N done" row until the user opens it.
  if (earlier && opts.collapse && !expanded[earlierGroupKey]) {
    const rest = list.filter((a) => !(skipRoot && a.parentId === null)).sort((x, y) => x.startedAt - y.startedAt || x.id.localeCompare(y.id))
    if (rest.length === 0) return []
    return [groupRow(runId, depth0, rest, { earlier: true, groupKey: earlierGroupKey, members: rest.map((a) => `${runId}:${a.id}`), id: `group:${earlierGroupKey}` })]
  }

  // The fold (shared with the app): settled = done or failed, worktree settled, past the grace, never an agent with an open card.
  let hidden = new Map<string, AgentInstance[]>()
  let visibleIds: Set<string> | undefined
  if (!earlier && opts.collapse) {
    const now = opts.now ?? Date.now()
    const result = foldFinished({
      agents: normalizeParents(list),
      isSettled: (a) => isSettledAt(a, now) && (waiting[a.id]?.length ?? 0) === 0,
      expanded,
      collapse: true
    })
    hidden = result.groups
    visibleIds = new Set(result.visibleAgents.map((a) => a.id))
  }
  const children = new Map<string | null, AgentInstance[]>()
  for (const a of list) {
    const key = a.parentId !== null && ids.has(a.parentId) ? a.parentId : null
    const arr = children.get(key) ?? []
    arr.push(a)
    children.set(key, arr)
  }
  for (const arr of children.values()) arr.sort((x, y) => x.startedAt - y.startedAt || x.id.localeCompare(y.id))
  const out: OrgTreeRow[] = []
  const seen = new Set<string>()
  const shown = (a: AgentInstance): boolean => visibleIds === undefined || visibleIds.has(a.id)
  const rowId = (a: AgentInstance): string => (earlier ? `${runId}:${a.id}` : a.id)
  const walk = (a: AgentInstance, depth: number, parent?: string): void => {
    if (seen.has(a.id) || depth > 50 || !shown(a)) return
    seen.add(a.id)
    const cost = costView(agentCostInput(a))
    const role = safeLine(a.name)
    const label = agentLabel(a)
    const open = earlier ? 0 : (waiting[a.id]?.length ?? 0)
    const chip = a.worktree ? worktreeChipOf(a.worktree) : undefined
    out.push({
      id: rowId(a),
      runId,
      depth,
      label,
      role,
      state: a.state,
      stateWord: AGENT_STATE_WORD[a.state] ?? safeLine(a.state),
      activity: clipLine(safeLine(a.activity), ACTIVITY_MAX),
      costText: cost.empty ? '' : cost.text,
      isRoot: a.parentId === null,
      kind: 'agent',
      ...(roleAdds(label, role) ? {} : { roleShown: false }),
      ...(parent ? { parentId: parent } : {}),
      ...(earlier ? { earlier: true, earlierKey: earlierGroupKey } : {}),
      ...(open > 0 ? { waiting: open } : {}),
      ...(chip ? { worktreeChip: chip } : {}),
      ...(a.worktree ? { worktree: { branch: safeLine(a.worktree.branch), status: a.worktree.status } } : {})
    })
    for (const c of children.get(a.id) ?? []) walk(c, depth + 1, rowId(a))
    const folded = hidden.get(a.id)
    if (folded && folded.length > 0) {
      out.push(groupRow(runId, depth + 1, folded, { groupKey: a.id, members: folded.map((m) => m.id), parentId: rowId(a) }))
    }
  }
  const roots = children.get(null) ?? []
  for (const r of roots) {
    if (skipRoot && r.parentId === null) {
      seen.add(r.id)
      for (const c of children.get(r.id) ?? []) walk(c, depth0)
    } else walk(r, depth0)
  }
  // A parent cycle: what is left is listed flat.
  for (const a of list) if (!seen.has(a.id)) walk(a, depth0)
  return out
}

/**
 * The active run's agents depth first (root first, reports by start order). Reports of earlier chain members follow
 * the root, under it, marked `earlier` (their ids are prefixed with the run id; the shared root is not repeated).
 */
export function orgTreeRows(s: TuiState, opts: OrgTreeOptions = {}): OrgTreeRow[] {
  const run = activeRun(s)
  if (!run) return []
  const waiting = cardsByAgent(s)
  const own = treeOf(run, 0, false, false, opts, waiting)
  const earlier = chainRuns(s)
    .filter((r) => r.summary.id !== run.summary.id)
    .flatMap((r) => treeOf(r, 1, true, true, opts))
  if (earlier.length === 0) return own
  const rootAt = own.findIndex((r) => r.isRoot)
  if (rootAt < 0) return [...earlier, ...own]
  return [...own.slice(0, rootAt + 1), ...earlier, ...own.slice(rootAt + 1)]
}

/**
 * Open decision cards of the active run by the agent they are about, as tray card keys in tray order. Every card kind
 * carries an agentId (checked from types.ts); one naming an agent the run does not have is attributed to the root.
 */
export function cardsByAgent(s: TuiState): Record<string, string[]> {
  const run = activeRun(s)
  if (!run) return {}
  const root = Object.values(run.agents).find((a) => a.parentId === null)?.id
  const out: Record<string, string[]> = {}
  for (const c of trayCards(s)) {
    if (c.ref.runId !== run.summary.id) continue
    const id = c.agentId && run.agents[c.agentId] ? c.agentId : root
    if (id === undefined) continue
    ;(out[id] ??= []).push(c.key)
  }
  return out
}

/** The row to select now: the selected id itself, else the "N done" row that folded it, else undefined. */
export function resolveSelectedRow(rows: readonly OrgTreeRow[], id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  if (rows.some((r) => r.id === id)) return id
  return rows.find((r) => r.kind === 'group' && r.members?.includes(id))?.id
}

/** The expanded-group key Left should fold for a row: the row's own, else its nearest expanded ancestor's. */
export function collapseTarget(rows: readonly OrgTreeRow[], id: string, expanded: Readonly<Record<string, boolean | number>>): string | undefined {
  const byId = new Map(rows.map((r) => [r.id, r]))
  let cur = byId.get(id)
  if (cur?.kind === 'group') return undefined
  for (let hops = 0; cur && hops < 60; hops++) {
    if (!cur.earlier && expanded[cur.id]) return cur.id
    if (cur.earlierKey && expanded[cur.earlierKey]) return cur.earlierKey
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return undefined
}

export { treeCounts } from './treeRows'

// ---------- Transcript ----------

function entryRow(e: TranscriptEntry, runId: string, who: string, toolName: (id: string) => string | undefined): TranscriptRow | null {
  const key = `${runId}|${e.id}`
  const harness = e.source === 'harness'
  const base = { key, runId, agentId: e.agentId, agentLabel: who, at: e.at }
  const b = e.block
  switch (b.kind) {
    case 'text': {
      const text = safe(b.text).trim()
      return text ? { ...base, kind: harness ? 'harness' : 'text', text, ...(harness ? { tone: 'dim' as const } : {}) } : null
    }
    case 'thinking': {
      const text = safe(b.text).trim()
      return text ? { ...base, kind: 'thinking', text, tone: 'dim' } : null
    }
    case 'tool_use':
      return { ...base, kind: 'tool', text: safeLine(humanizeToolUse(b.name, b.input).label), tone: 'dim' }
    case 'tool_result': {
      const row = humanizeToolResult(toolName(b.toolUseId), b.content, b.isError)
      if (!row) return null
      const failed = b.isError || !!row.failed
      return { ...base, kind: failed ? 'error' : 'result', text: safeLine(row.label), tone: failed ? 'danger' : 'dim' }
    }
    case 'user': {
      const text = safe(b.text).trim()
      const imgs = (b.images ?? []).map((i) => imageLabel(i))
      const body = [text, ...imgs].filter(Boolean).join(' ')
      if (harness) return body ? { ...base, kind: 'harness', text: body, tone: 'dim' } : null
      return { ...base, kind: 'user', text: body || '(empty message)' }
    }
    case 'system': {
      const text = safe(b.text).trim()
      return text ? { ...base, kind: harness ? 'harness' : 'system', text, tone: 'dim' } : null
    }
    default:
      return null
  }
}

/** The active chain's transcripts merged oldest first, one divider per continuation; `omitted` counts left-out entries. */
export function transcriptRows(s: TuiState): { rows: TranscriptRow[]; omitted: number } {
  const members = chainRuns(s)
  if (members.length === 0) return { rows: [], omitted: 0 }
  const feed = mergeChainFeed(members.map((r) => ({ summary: r.summary, entries: r.transcript })))
  let omitted = members.reduce((n, r) => n + (r.omitted ?? 0), 0)
  const entries = feed.flatMap((x) => (x.kind === 'entry' ? [x.entry] : []))
  const tools = toolNamesOf(entries)
  const rows: TranscriptRow[] = []
  for (const item of feed) {
    if (item.kind === 'omitted') omitted += item.count
    else if (item.kind === 'divider') {
      rows.push({ key: `divider|${item.divider.runId}`, runId: item.divider.runId, kind: 'divider', text: safeLine(item.divider.label), tone: 'dim' })
    } else {
      const agents = s.runs[item.runId]?.agents ?? {}
      const row = entryRow(item.entry, item.runId, agentLabel(agents[item.entry.agentId]), (id) => tools.get(id))
      if (row) rows.push(row)
    }
  }
  return { rows, omitted }
}

/** The active run's streaming partials (non-empty), agents in start order. */
export function partialRows(s: TuiState): PartialRow[] {
  const run = activeRun(s)
  if (!run) return []
  const out: PartialRow[] = []
  for (const [agentId, text] of Object.entries(run.partials)) {
    if (!text) continue
    out.push({ key: `partial|${run.summary.id}|${agentId}`, runId: run.summary.id, agentId, agentLabel: agentLabel(run.agents[agentId]), text })
  }
  const started = (id: string): number => run.agents[id]?.startedAt ?? 0
  return out.sort((a, b) => started(a.agentId) - started(b.agentId) || a.agentId.localeCompare(b.agentId))
}

// ---------- Plan and worktrees ----------

const PLAN_WORD: Record<string, string> = { active: 'In progress', done: 'Complete', blocked: 'Blocked' }

export function planView(s: TuiState): PlanView | undefined {
  const plan = activeRun(s)?.plan
  if (!plan || !Array.isArray(plan.steps)) return undefined
  const steps = plan.steps.map((st) => ({
    id: safeLine(st.id),
    title: safeLine(st.title),
    status: st.status,
    ...(st.owner ? { owner: safeLine(st.owner) } : {}),
    ...(st.note ? { note: safeLine(st.note) } : {})
  }))
  return {
    goal: safeLine(plan.goal),
    statusWord: PLAN_WORD[plan.status] ?? safeLine(plan.status),
    done: plan.steps.filter((st) => st.status === 'done').length,
    total: plan.steps.length,
    steps
  }
}

export function worktreeRows(s: TuiState): WorktreeRow[] {
  const run = activeRun(s)
  if (!run) return []
  return Object.values(run.agents)
    .filter((a) => !!a.worktree)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
    .map((a) => {
      const wt = a.worktree!
      const review = run.cards.mergeReviews.find((m) => m.agentId === a.id)
      return {
        agentId: a.id,
        runId: run.summary.id,
        label: agentLabel(a),
        branch: safeLine(wt.branch),
        status: wt.status,
        changedFiles: Array.isArray(wt.changedFiles) ? wt.changedFiles.length : 0,
        mergeTarget: wt.mergeTarget === 'parent' ? 'parent' : 'main',
        ...(review ? { reviewId: review.id } : {})
      }
    })
}

// ---------- Status bar and composer ----------

export function statusSummary(s: TuiState): StatusSummary {
  const live = Object.values(s.runs).filter((r) => isOpenStatus(r.summary.status))
  const out: StatusSummary = {
    needsYou: decisionCount(live.map(waitRunOf)),
    liveRuns: live.length,
    connection: s.connection,
    ...(s.project ? { projectName: safeLine(s.project.name) } : {}),
    ...(s.hostKind ? { hostKind: s.hostKind } : {}),
    ...(s.readOnlyReason ? { readOnlyReason: safeLine(s.readOnlyReason) } : {})
  }
  const run = activeRun(s)
  if (!run) return out
  const view = statusViewOf({ summary: run.summary, plan: run.plan, agents: run.agents }, openDecisions(run) > 0, s.project)
  const chain = chainRuns(s)
  const cost = costView(chain.length > 1 ? sumCosts(chain.map((r) => runCostInput(r.summary))) : runCostInput(run.summary))
  return {
    ...out,
    runTag: runTagOf(s, run.summary.id),
    runTitle: safeLine(runName(run.summary)),
    statusWord: statusText(view),
    tone: RUN_TONE[view.tone] ?? 'dim',
    costText: cost.text
  }
}

/** Whether the active run is the newest of its chain and may be continued. */
function continuable(s: TuiState, run: TuiRun): boolean {
  const chain: RunSummary[] = chainRuns(s).map((r) => r.summary)
  return canContinueIn(chain.length > 0 ? chain : [run.summary], run.summary.id)
}

export function composerMode(s: TuiState): ComposerMode {
  if (s.readOnlyReason) return 'readOnly'
  const fresh: ComposerMode = s.project ? 'start' : 'quick'
  const run = activeRun(s)
  if (!run || s.composeTarget === 'new') return fresh
  if (isOpenStatus(run.summary.status)) return 'send'
  return continuable(s, run) ? 'continue' : fresh
}
