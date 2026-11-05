/**
 * Pure view-model selectors over TuiState (W4-T1). Every string a row carries is sanitized here (safe / safeLine from
 * output.ts, or sanitizeTty), so the panes render them as plain text. Words come from the shared view models only:
 * status from statusText (render.ts statusWordOf), names from agentLabel / runName, costs from costView, the needs-you
 * count from decisionCount (cli-spec 2 item 4).
 */
import type { AgentInstance, AgentState, CardKind, RunSummary, TranscriptEntry } from '../../shared/types'
import { agentCostInput, costView, runCostInput, sumCosts } from '../../shared/view/cost'
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
      out.push({
        key: cardKey(ref),
        ref,
        runTag: tag,
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

function treeOf(run: TuiRun, depth0: number, earlier: boolean, skipRoot: boolean): OrgTreeRow[] {
  const agents = settleEndedAgents(run.summary, run.agents)
  const list = Object.values(agents)
  const ids = new Set(list.map((a) => a.id))
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
  const runId = run.summary.id
  const walk = (a: AgentInstance, depth: number): void => {
    if (seen.has(a.id) || depth > 50) return
    seen.add(a.id)
    const cost = costView(agentCostInput(a))
    out.push({
      id: earlier ? `${runId}:${a.id}` : a.id,
      runId,
      depth,
      label: agentLabel(a),
      role: safeLine(a.name),
      state: a.state,
      stateWord: AGENT_STATE_WORD[a.state] ?? safeLine(a.state),
      activity: clipLine(safeLine(a.activity), ACTIVITY_MAX),
      costText: cost.empty ? '' : cost.text,
      isRoot: a.parentId === null,
      ...(earlier ? { earlier: true } : {}),
      ...(a.worktree ? { worktree: { branch: safeLine(a.worktree.branch), status: a.worktree.status } } : {})
    })
    for (const c of children.get(a.id) ?? []) walk(c, depth + 1)
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
export function orgTreeRows(s: TuiState): OrgTreeRow[] {
  const run = activeRun(s)
  if (!run) return []
  const own = treeOf(run, 0, false, false)
  const earlier = chainRuns(s)
    .filter((r) => r.summary.id !== run.summary.id)
    .flatMap((r) => treeOf(r, 1, true, true))
  if (earlier.length === 0) return own
  const rootAt = own.findIndex((r) => r.isRoot)
  if (rootAt < 0) return [...earlier, ...own]
  return [...own.slice(0, rootAt + 1), ...earlier, ...own.slice(rootAt + 1)]
}

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
