/**
 * Pure view-model selectors over TuiState (W4-T1). Every string a row carries is sanitized here (safe / safeLine from
 * output.ts, or sanitizeTty), so the panes render them as plain text. Words come from the shared view models only:
 * status from statusText (render.ts statusWordOf), names from agentLabel / runName, costs from costView, the needs-you
 * count from decisionCount (cli-spec 2 item 4).
 */
import { DELEGATION_BADGE_SHORT, delegationBadges } from '../../shared/delegationView'
import { VIRTUAL_PROJECT_IDS, type AgentInstance, type AgentState, type CardKind, type RunSummary, type TranscriptEntry, type UsageStatus } from '../../shared/types'
import { agentCostInput, costView, formatDuration, formatTokens, runCostInput, sumCosts } from '../../shared/view/cost'
import { normalizeParents } from '../../shared/view/agentTree'
import { foldFinished, isSettledAt } from '../../shared/view/foldFinished'
import { decisionCount, type WaitRun } from '../../shared/view/needsYou'
import { canContinueIn, isOpenStatus } from '../../shared/view/runChains'
import { runName, runTag } from '../../shared/view/runLabels'
import { settleEndedAgents, type RunTone } from '../../shared/view/runStatus'
import { humanizeToolResult, humanizeToolUse, mergeChainFeed } from '../../shared/view/transcriptRows'
import { commandSummary, isCompoundCommand } from './streamRows'
import { roleRepresentatives, withTeamRows } from './teamRows'
import { agentIdentityTone } from './identity'
import { safe, safeLine } from '../output'
import { latestByAgent, latestForStep, liveModelOf, modelsUsedBy, rootModelOf, runConnections, staffingLabel, staffingReason, stepRanText } from '../staffingText'
import { readyCount, stepFlows, usesGraph } from './planGraph'
import { isWorkingAgentState } from './activity'
import { agentLabel, imageLabel, mediaLabel, pendingItems, resultPartsLabel, statusViewOf, toolNamesOf } from '../render'
import { autoContinueState, statusText } from '../../shared/view/runStatus'
import { DEFAULT_MAX_AUTO_CONTINUES } from '../../shared/types'
import { CARD_BUCKETS, cardArrivalSeq } from './state'
import {
  cardKey,
  type CardRef,
  TUI_TRAFFIC_MS,
  type ComposerMode,
  type InspectorView,
  type OrgTreeRow,
  type PeerCount,
  type RunChip,
  type RunMessageRec,
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
  // A card of a run the user is not following names that run ("R3 Build the report"), so it is not mistaken for the followed one (R2-L2).
  const foreign = !s.activeChain.includes(run.summary.id)
  const name = foreign ? clipLine(safeLine(runName(run.summary)), 24) : ''
  const tag = `${runTagOf(s, run.summary.id)}${name ? ` ${name}` : ''}`
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
        // An agent of another run is not loaded here, so it has no name to give: no label rather than "An agent" (the card's
        // run is named instead). In the followed run an unknown agent keeps the generic label.
        ...(agentId ? { agentId, ...(foreign && !run.agents[agentId] ? {} : { agentLabel: agentLabel(run.agents[agentId]) }) } : {}),
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
  includeRoles?: boolean
  persistentAgents?: ReadonlySet<string>
  /** Hide finished agents (the app's default; the TUI's `h`). */
  collapse?: boolean
  /** Expanded group keys: a visible agent's id or an earlier-session key; a number is when it was expanded. */
  expanded?: Readonly<Record<string, boolean | number>>
  /** The clock for the settle grace and the traffic mark (tests pass it; the App passes its own `now`). */
  now?: number
  /** Root the tree at this agent (F7); ignored when the agent is not in the run. Earlier sessions are left out. */
  rootId?: string
}

/** Message counts of one agent (F6): per peer, newest peer first; `recent` = traffic in the last TUI_TRAFFIC_MS. */
export interface AgentTraffic {
  out: PeerCount[]
  in: PeerCount[]
  recent: boolean
}

interface PeerAcc {
  key: string
  label: string
  count: number
  last: number
}

function bump(list: PeerAcc[], key: string, label: string, at: number): void {
  const hit = list.find((p) => p.key === key)
  if (hit) {
    hit.count += 1
    hit.last = Math.max(hit.last, at)
  } else list.push({ key, label, count: 1, last: at })
}

/** Per agent id: who it messaged and who messaged it, from the run's kept messages. Counts only, labels sanitized. */
export function trafficByAgent(run: TuiRun, now: number): Map<string, AgentTraffic> {
  const raw = new Map<string, { out: PeerAcc[]; in: PeerAcc[]; recent: boolean }>()
  const slot = (id: string) => {
    let v = raw.get(id)
    if (!v) raw.set(id, (v = { out: [], in: [], recent: false }))
    return v
  }
  const labelOf = (id: string | null, handle: string): string => (id !== null && run.agents[id] ? agentLabel(run.agents[id]) : safeLine(handle) || 'someone')
  for (const m of run.messages ?? ([] as RunMessageRec[])) {
    const recent = now - m.at <= TUI_TRAFFIC_MS
    const from = slot(m.from)
    bump(from.out, m.to ?? `handle:${m.toHandle}`, labelOf(m.to, m.toHandle), m.at)
    if (recent) from.recent = true
    if (m.to !== null) {
      const to = slot(m.to)
      bump(to.in, m.from, labelOf(m.from, ''), m.at)
      if (recent) to.recent = true
    }
  }
  const out = new Map<string, AgentTraffic>()
  const fin = (l: PeerAcc[]): PeerCount[] => [...l].sort((a, b) => b.last - a.last).map((p) => ({ label: p.label, count: p.count }))
  for (const [id, v] of raw) out.set(id, { out: fin(v.out), in: fin(v.in), recent: v.recent })
  return out
}

/** The agent and everything under it (ids), for the subtree focus and its transcript filter. */
export function subtreeIds(agents: Readonly<Record<string, AgentInstance>>, rootId: string): Set<string> {
  const out = new Set<string>()
  if (!agents[rootId]) return out
  const kids = new Map<string, string[]>()
  for (const a of Object.values(agents)) {
    if (!a.parentId) continue
    const list = kids.get(a.parentId) ?? []
    list.push(a.id)
    kids.set(a.parentId, list)
  }
  const stack = [rootId]
  while (stack.length > 0 && out.size < 5000) {
    const id = stack.pop()!
    if (out.has(id)) continue
    out.add(id)
    for (const k of kids.get(id) ?? []) stack.push(k)
  }
  return out
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

/** Words for a screen reader: "1 decision open", "3 decisions open". */
export const waitingWords = (n: number): string => `${n} decision${n === 1 ? '' : 's'} open`

/** Words for a worktree chip: "2f" -> "2 files changed" ("1 file changed"); the state chips are already words. */
export function worktreeChipWords(chip: string): string {
  const m = /^(\d+)f$/.exec(chip)
  if (!m) return chip
  const n = Number(m[1])
  return `${n} file${n === 1 ? '' : 's'} changed`
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
  waiting: Readonly<Record<string, string[]>> = {},
  traffic: ReadonlyMap<string, AgentTraffic> = new Map()
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
      isSettled: (a) => !opts.persistentAgents?.has(a.id) && isSettledAt(a, now) && (waiting[a.id]?.length ?? 0) === 0,
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
  const zoomRoot = !earlier && opts.rootId !== undefined && ids.has(opts.rootId) ? opts.rootId : undefined
  const shown = (a: AgentInstance): boolean => visibleIds === undefined || visibleIds.has(a.id) || a.id === zoomRoot
  const rowId = (a: AgentInstance): string => (earlier ? `${runId}:${a.id}` : a.id)
  const walk = (a: AgentInstance, depth: number, parent?: string): void => {
    if (seen.has(a.id) || depth > 50 || !shown(a)) return
    seen.add(a.id)
    const cost = costView(agentCostInput(a))
    const role = safeLine(a.name)
    const label = agentLabel(a)
    const open = earlier ? 0 : (waiting[a.id]?.length ?? 0)
    const chip = a.worktree ? worktreeChipOf(a.worktree) : undefined
    const firstBadge = delegationBadges(a.delegation)[0]
    const delegationBadge = firstBadge ? DELEGATION_BADGE_SHORT[firstBadge] : undefined
    const tr = earlier ? undefined : traffic.get(a.id)
    const fullActivity = failedTurnSentence(safeLine(a.activity))
    const activity = clipLine(fullActivity, ACTIVITY_MAX)
    out.push({
      id: rowId(a),
      runId,
      depth,
      label,
      role,
      state: a.state,
      stateWord: AGENT_STATE_WORD[a.state] ?? safeLine(a.state),
      activity,
      activityIsCompound: isCompoundCommand(a.activity) || activity !== fullActivity,
      costText: cost.empty ? '' : cost.text,
      isRoot: a.parentId === null,
      kind: 'agent',
      ...(roleAdds(label, role) ? {} : { roleShown: false }),
      ...(parent ? { parentId: parent } : {}),
      ...(earlier ? { earlier: true, earlierKey: earlierGroupKey } : {}),
      ...(open > 0 ? { waiting: open } : {}),
      ...(chip ? { worktreeChip: chip } : {}),
      ...(delegationBadge ? { delegationBadge } : {}),
      ...(tr && tr.out.length > 0 ? { msgOut: tr.out } : {}),
      ...(tr && tr.in.length > 0 ? { msgIn: tr.in } : {}),
      ...(tr?.recent ? { traffic: true } : {}),
      ...(a.worktree ? { worktree: { branch: safeLine(a.worktree.branch), status: a.worktree.status } } : {})
    })
    for (const c of children.get(a.id) ?? []) walk(c, depth + 1, rowId(a))
    const folded = hidden.get(a.id)
    if (folded && folded.length > 0) {
      out.push(groupRow(runId, depth + 1, folded, { groupKey: a.id, members: folded.map((m) => m.id), parentId: rowId(a) }))
    }
  }
  const roots = zoomRoot !== undefined ? list.filter((a) => a.id === zoomRoot) : (children.get(null) ?? [])
  for (const r of roots) {
    if (skipRoot && r.parentId === null) {
      seen.add(r.id)
      for (const c of children.get(r.id) ?? []) walk(c, depth0)
    } else walk(r, depth0)
  }
  // A parent cycle: what is left is listed flat (not when the tree is rooted at one agent).
  if (zoomRoot === undefined) for (const a of list) if (!seen.has(a.id)) walk(a, depth0)
  return out
}

/**
 * The active run's agents depth first (root first, reports by start order). Reports of earlier chain members follow
 * the root, under it, marked `earlier` (their ids are prefixed with the run id; the shared root is not repeated).
 */
export function orgTreeRows(s: TuiState, opts: OrgTreeOptions = {}): OrgTreeRow[] {
  const run = activeRun(s)
  const roles = opts.includeRoles ? s.project?.roles ?? [] : []
  if (!run) return withTeamRows([], roles, [], '')
  const agents = Object.values(run.agents)
  const options = { ...opts, persistentAgents: new Set(roleRepresentatives(roles, agents).values()) }
  const waiting = cardsByAgent(s)
  const paletteRoles = s.project?.roles ?? []
  const staffed = latestByAgent(run.staffing)
  const multi = runConnections(run.summary, run.agents).length > 0
  let own: OrgTreeRow[] = treeOf(run, 0, false, false, options, waiting, trafficByAgent(run, opts.now ?? Date.now())).map(row => {
    const agent = run.agents[row.id]
    const pick = row.kind !== 'group' ? staffed.get(row.id) : undefined
    // Model per agent (cli-parity 3.1): the assignment's model, else the live one; the label keeps tier and effort apart so the row can cut the id first.
    const model = row.kind === 'group' || !agent ? '' : pick?.model ? safeLine(pick.model) : liveModelOf(agent)
    const on = multi && agent && row.kind !== 'group' ? safeLine(agent.connection ?? run.summary.connection ?? '') : ''
    return {
      ...row,
      identityTone: agentIdentityTone(paletteRoles, agent),
      ...(pick ? { staffing: staffingLabel({ tier: pick.tier, model: '', effort: pick.effort }), staffingPick: { ...(pick.tier ? { tier: pick.tier } : {}), ...(pick.effort ? { effort: pick.effort } : {}) } } : {}),
      ...(model ? { model } : {}),
      ...(on ? { connection: on } : {})
    }
  })
  if (opts.rootId !== undefined && run.agents[opts.rootId]) return own
  own = withTeamRows(own, roles, agents, run.summary.id)
  const earlier = chainRuns(s)
    .filter((r) => r.summary.id !== run.summary.id)
    .flatMap((r) => treeOf(r, 1, true, true, opts).map(row => ({ ...row, identityTone: agentIdentityTone(paletteRoles, r.agents[row.id.slice(r.summary.id.length + 1)]) })))
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

/** SDK failure subtypes as the adapters word them in a row ("error_during_execution" -> "during execution"). */
const FAILED_TURN_REASONS = new Set(['during execution', 'max turns', 'max budget usd', 'max structured output retries'])

/** The sentence for a bare failure reason; any other text is returned unchanged. */
export function failedTurnSentence(text: string): string {
  const t = text.trim().toLowerCase().replace(/^error[_ ]/, '').replace(/_/g, ' ')
  return FAILED_TURN_REASONS.has(t) ? `The last turn failed (error ${t}). Send a message to try again.` : text
}

// Entries survive streaming updates; clean each bounded result once, not on every App repaint.
const resultDetails = new WeakMap<TranscriptEntry, { content: string; text: string }>()
function resultDetail(entry: TranscriptEntry, content: string): string {
  const previous = resultDetails.get(entry)
  if (previous?.content === content) return previous.text
  const text = safe(content.slice(0, 4000) + (content.length > 4000 ? '\n… (output truncated)' : ''))
  resultDetails.set(entry, { content, text })
  return text
}

function entryRow(e: TranscriptEntry, runId: string, who: string, toolName: (id: string) => string | undefined): TranscriptRow | null {
  const key = `${runId}|${e.id}`
  const harness = e.source === 'harness'
  const base = { key, runId, agentId: e.agentId, agentLabel: who, at: e.at }
  const b = e.block
  switch (b.kind) {
    case 'text': {
      const text = failedTurnSentence(safe(b.text).trim())
      return text ? { ...base, kind: harness ? 'harness' : 'text', text, ...(harness ? { tone: 'dim' as const } : {}) } : null
    }
    case 'thinking': {
      const text = safe(b.text).trim()
      return text ? { ...base, kind: 'thinking', text, tone: 'dim' } : null
    }
    case 'tool_use': {
      const view = humanizeToolUse(b.name, b.input)
      const input = b.input && typeof b.input === 'object' ? b.input as Record<string, unknown> : {}
      const command = (b.name === 'Bash' || b.name === 'PowerShell') && typeof input.command === 'string' ? input.command : undefined
      const summary = command === undefined ? view.label : `Ran ${commandSummary(command)}`
      const pendingSummary = command === undefined ? undefined : safeLine(`Command: ${commandSummary(command)}`)
      const detail = command === undefined ? `${view.label}\n${view.details}` : `Command: ${command}`
      return { ...base, kind: 'tool', toolUseId: b.id, text: safeLine(view.label), summary: safeLine(summary), pendingSummary, detail: safe(detail), tone: 'dim' }
    }
    case 'tool_result': {
      const row = humanizeToolResult(toolName(b.toolUseId), b.content, b.isError)
      const parts = resultPartsLabel(b.parts)
      if (!row && !parts) return null
      const failed = b.isError || !!row?.failed
      return { ...base, kind: failed ? 'error' : 'result', toolUseId: b.toolUseId, text: parts || safeLine(row!.label), detail: resultDetail(e, parts || b.content), tone: failed ? 'danger' : 'dim' }
    }
    case 'media':
      return { ...base, kind: harness ? 'harness' : 'text', text: mediaLabel(b.media), ...(harness ? { tone: 'dim' as const } : {}) }
    case 'user': {
      const text = safe(b.text).trim()
      const imgs = (b.images ?? []).map((i) => imageLabel(i))
      const body = [text, ...imgs].filter(Boolean).join(' ')
      if (harness) return body ? { ...base, kind: 'harness', text: body, tone: 'dim' } : null
      return { ...base, kind: 'user', text: body || '(empty message)' }
    }
    case 'system': {
      const text = failedTurnSentence(safe(b.text).trim())
      return text ? { ...base, kind: harness ? 'harness' : 'system', text, tone: 'dim' } : null
    }
    default:
      return null
  }
}

/** Which agents' rows a transcript keeps (F4 one agent, F7 a subtree); dividers drop out of a filtered feed. */
export interface TranscriptFilter {
  agentIds?: ReadonlySet<string>
}

/** The active chain's transcripts merged oldest first, one divider per continuation; `omitted` counts left-out entries. */
export function transcriptRows(s: TuiState, filter: TranscriptFilter = {}): { rows: TranscriptRow[]; omitted: number } {
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
      if (row) rows.push({ ...row, identityTone: agentIdentityTone(s.project?.roles ?? [], agents[item.entry.agentId]) })
    }
  }
  const only = filter.agentIds
  if (only) return { rows: rows.filter((r) => r.agentId !== undefined && only.has(r.agentId)), omitted }
  return { rows, omitted }
}

/** The active run's streaming partials (non-empty), agents in start order. */
export function partialRows(s: TuiState, filter: TranscriptFilter = {}): PartialRow[] {
  const run = activeRun(s)
  if (!run) return []
  const out: PartialRow[] = []
  for (const [agentId, text] of Object.entries(run.partials)) {
    if (!text || (filter.agentIds && !filter.agentIds.has(agentId))) continue
    out.push({ key: `partial|${run.summary.id}|${agentId}`, runId: run.summary.id, agentId, agentLabel: agentLabel(run.agents[agentId]), identityTone: agentIdentityTone(s.project?.roles ?? [], run.agents[agentId]), text })
  }
  const started = (id: string): number => run.agents[id]?.startedAt ?? 0
  return out.sort((a, b) => started(a.agentId) - started(b.agentId) || a.agentId.localeCompare(b.agentId))
}

// ---------- Agent inspector (F4) ----------

/** The facts the inspector shows for one agent of the active run; a fact the agent does not have is left out. */
export function agentDetail(s: TuiState, agentId: string, now: number = Date.now()): InspectorView | undefined {
  const run = activeRun(s)
  const a = run?.agents[agentId]
  if (!run || !a) return undefined
  const u = a.usage
  const promptTokens = u ? u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite : a.inputTokens
  const outTokens = u ? u.tokens.output : a.outputTokens
  const spent = promptTokens > 0 || outTokens > 0
  const cost = costView(agentCostInput(a))
  const model = liveModelOf(a)
  const used = modelsUsedBy(a)
  const on = runConnections(run.summary, run.agents).length > 0 ? safeLine(a.connection ?? run.summary.connection ?? '') : ''
  const end = a.endedAt ?? now
  const traffic = trafficByAgent(run, now).get(agentId)
  const wt = a.worktree
  const staffed = latestByAgent(run.staffing).get(agentId)
  return {
    id: a.id,
    runId: run.summary.id,
    label: agentLabel(a),
    role: safeLine(a.name),
    state: a.state,
    stateWord: AGENT_STATE_WORD[a.state] ?? safeLine(a.state),
    ...(model ? { model } : {}),
    ...(used.length > 1 ? { models: used } : {}),
    ...(on ? { connection: on } : {}),
    ...(a.startedAt > 0 && end >= a.startedAt ? { wall: formatDuration(end - a.startedAt) } : {}),
    ...(spent ? { tokensIn: formatTokens(promptTokens), tokensOut: formatTokens(outTokens) } : {}),
    ...(cost.empty ? {} : { cost: cost.text }),
    ...(u && u.turns > 0 ? { turns: u.turns } : {}),
    ...(u && u.toolCalls > 0 ? { toolCalls: u.toolCalls } : {}),
    ...(a.activity ? { activity: clipLine(failedTurnSentence(safeLine(a.activity)), ACTIVITY_MAX) } : {}),
    ...(wt
      ? { worktree: { branch: safeLine(wt.branch), status: wt.status, files: Array.isArray(wt.changedFiles) ? wt.changedFiles.length : 0, mergeTarget: wt.mergeTarget === 'parent' ? ('parent' as const) : ('main' as const) } }
      : {}),
    waiting: cardsByAgent(s)[agentId]?.length ?? 0,
    msgOut: traffic?.out ?? [],
    msgIn: traffic?.in ?? [],
    ...(staffed ? { staffing: { label: staffingLabel(staffed), reason: staffingReason(staffed), model: safeLine(staffed.model) } } : {})
  }
}

// ---------- Plan and worktrees ----------

const PLAN_WORD: Record<string, string> = { active: 'In progress', done: 'Complete', blocked: 'Blocked' }

export function planView(s: TuiState): PlanView | undefined {
  const run = activeRun(s)
  const plan = run?.plan
  if (!run || !plan || !Array.isArray(plan.steps)) return undefined
  const graph = usesGraph(plan.steps)
  const flows = graph ? stepFlows(plan.steps) : undefined
  const titleOf = new Map(plan.steps.map((st) => [st.id, safeLine(st.title)]))
  const steps = plan.steps.map((st) => {
    const f = flows?.get(st.id)
    return {
      id: safeLine(st.id),
      title: safeLine(st.title),
      status: st.status,
      ...(st.owner ? { owner: safeLine(st.owner) } : {}),
      ...(st.note ? { note: safeLine(st.note) } : {}),
      ...(f ? { flow: f.state === 'waiting' ? { state: f.state, on: f.on.map((id) => titleOf.get(id) ?? safeLine(id)) } : { state: f.state } } : {}),
      ...(graph && st.staff ? { staff: stepRanText(st.staff, latestForStep(run.staffing, st.id)) } : {})
    }
  })
  return {
    runId: run.summary.id,
    continued: !!run.summary.resumedFrom,
    status: plan.status,
    startedAt: run.summary.startedAt,
    runStatus: run.summary.status,
    waiting: decisionCount([waitRunOf(run)]) > 0,
    goal: safeLine(plan.goal),
    statusWord: PLAN_WORD[plan.status] ?? safeLine(plan.status),
    done: plan.steps.filter((st) => st.status === 'done').length,
    total: plan.steps.length,
    steps,
    ...(graph ? { graph: true } : {})
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

/** The project's live runs oldest first, as chips (F8): `*` marks the followed run, `!` one with an open decision. */
export function runChips(s: TuiState): RunChip[] {
  const pid = s.project?.id
  return s.runOrder
    .map((id) => s.runs[id])
    .filter((r): r is TuiRun => !!r && isOpenStatus(r.summary.status) && (pid === undefined || r.summary.projectId === pid))
    .map((r) => ({ tag: runTagOf(s, r.summary.id), runId: r.summary.id, followed: r.summary.id === s.activeRunId, needsYou: openDecisions(r) > 0 }))
}

/** The live run before / after the followed one (wrapping), for `[` and `]`; undefined when no other run is live. */
export function adjacentLiveRun(s: TuiState, dir: 1 | -1): RunChip | undefined {
  const chips = runChips(s)
  const others = chips.filter((c) => !c.followed)
  if (others.length === 0) return undefined
  const at = chips.findIndex((c) => c.followed)
  if (at < 0) return dir === 1 ? chips[0] : chips[chips.length - 1]
  return chips[(at + dir + chips.length) % chips.length]
}

/** Whether a run offers the Org retrospective (the app's offersRetro): an ended work run of a real project, never a Chat or assistant run. */
export function offersRetro(summary: Pick<RunSummary, 'kind' | 'quick' | 'projectId' | 'status'> & Partial<Pick<RunSummary, 'team'>>): boolean {
  return summary.kind === 'work' && summary.team !== 'single' && !summary.quick && !(VIRTUAL_PROJECT_IDS as readonly string[]).includes(summary.projectId) && (summary.status === 'finished' || summary.status === 'error')
}

/** The plan windows as "5h 42% · 7d 18%" (whole percent); undefined before a report or when neither window has a figure. */
export function windowText(u: UsageStatus | undefined): string | undefined {
  if (!u || !u.available) return undefined
  const parts: string[] = []
  const pct = (w: { utilization: number | null } | undefined): string | undefined =>
    w && typeof w.utilization === 'number' && Number.isFinite(w.utilization) ? `${Math.round(Math.min(100, Math.max(0, w.utilization)))}%` : undefined
  const five = pct(u.windows?.fiveHour)
  const seven = pct(u.windows?.sevenDay)
  if (five) parts.push(`5h ${five}`)
  if (seven) parts.push(`7d ${seven}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

export function statusSummary(s: TuiState): StatusSummary {
  const live = Object.values(s.runs).filter((r) => isOpenStatus(r.summary.status))
  const chips = runChips(s)
  const out: StatusSummary = {
    needsYou: decisionCount(live.map(waitRunOf)),
    liveRuns: live.length,
    ...(chips.length > 0 ? { runChips: chips } : {}),
    connection: s.connection,
    ...(s.project ? { projectName: safeLine(s.project.name) } : {}),
    ...(s.hostKind ? { hostKind: s.hostKind } : {}),
    ...(s.readOnlyReason ? { readOnlyReason: safeLine(s.readOnlyReason) } : {})
  }
  const windows = windowText(s.planUsage)
  if (windows) out.windowText = windows
  const run = activeRun(s)
  if (!run) return out
  const graph = !!run.plan && Array.isArray(run.plan.steps) && usesGraph(run.plan.steps)
  if (graph || (run.staffing?.assignments.length ?? 0) > 0) {
    const working = Object.values(run.agents).filter((a) => isWorkingAgentState(a.state)).length
    const ready = graph ? readyCount(run.plan!.steps) : 0
    if (working > 0) out.working = working
    if (ready > 0) out.readySteps = ready
  }
  const view = statusViewOf({ summary: run.summary, plan: run.plan, agents: run.agents }, openDecisions(run) > 0, s.project)
  if (run.plan) {
    const auto = autoContinueState({ status: run.summary.status, plan: run.plan, autoContinue: s.project?.autoContinue, maxAutoContinues: s.project?.maxAutoContinues, kind: run.summary.kind }, DEFAULT_MAX_AUTO_CONTINUES)
    out.autoText = s.project?.autoContinue === false ? 'auto-continue off' : `auto ${auto.count}/${auto.max}`
  }
  const chain = chainRuns(s)
  const cost = costView(chain.length > 1 ? sumCosts(chain.map((r) => runCostInput(r.summary))) : runCostInput(run.summary))
  // A failed root turn leaves the run idle (it takes another message): say so instead of a plain Idle (issue #29 M5).
  const root = Object.values(run.agents).find((a) => a.parentId === null)
  const failedTurn = run.summary.status === 'idle' && root?.state === 'error'
  const rootModel = rootModelOf(run.summary, run.agents)
  return {
    ...out,
    runTag: runTagOf(s, run.summary.id),
    runTitle: safeLine(runName(run.summary)),
    ...(rootModel ? { rootModel } : {}),
    statusWord: failedTurn ? `${statusText(view)} · last turn failed` : statusText(view),
    tone: failedTurn ? 'danger' : (RUN_TONE[view.tone] ?? 'dim'),
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
