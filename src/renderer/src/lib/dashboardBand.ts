/**
 * The Dashboard's Right now band as a pure model (docs/design/dashboard-2.md section 6): which runs, which agent rows,
 * the caps and their priority, tree order, depth, reporting-line facts and the accessible names. No React, no store.
 */
import type { AgentInstance, AgentState, Project, RunPlan, RunSummary } from '@shared/types'
import { isVirtualProjectId } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { agentLabel, hasLiveDescendant, normalizeParents } from '@shared/view/agentTree'
import { isSettledAt } from './foldFinished'
import { nodeActivity, isWorkingAgent, worktreeLabel } from './agentActivity'
import { locationLabel, runKindLabel } from './assistants'
import { oneLine } from '@shared/view/decisionTitle'
import { runCostInput } from './cost'
import { elapsedLabel, planStepLabel } from './dashboard'
import { runName } from './runLabels'
import { statusOfRun, statusText, type RunStatusView } from './runStatus'

/** The neutral role colour, as the canvas resolves it (LiveRunView NEUTRAL_ROLE_TOKEN). */
export const NEUTRAL_ROLE_COLOR = 'var(--text-tertiary)'
/** Rows are drawn at most this deep; deeper agents sit here with "under <parent>". */
export const BAND_MAX_DEPTH = 3
/** Trailing recompute interval of the band's snapshot (spec 6.8). */
export const BAND_RECOMPUTE_MS = 250

export type BandGroup = 'working' | 'waiting' | 'idle'
export type BandAgentState = 'working' | 'waiting' | 'idle' | 'done' | 'failed'

export interface BandCaps {
  bandRuns: number
  bandAgents: number
  bandAgentsPerRun: number
}

/** What the band reads of one open run (a reduced view of the store's RunState). */
export interface BandRunIn {
  summary: RunSummary
  plan?: RunPlan
  agents: Record<string, AgentInstance>
  /** `waitingItems(run).length`. */
  decisions: number
}

export interface BandAgentRow {
  kind: 'agent'
  id: string
  label: string
  role: string
  state: BandAgentState
  stateWord: string
  activity: string
  /** Displayed depth, 1..BAND_MAX_DEPTH. */
  depth: number
  /** The parent's label when the real depth is past BAND_MAX_DEPTH. */
  under?: string
  worktree?: string
  color: string
  /** The parent's role colour (the reporting line). */
  lineColor: string
  /** Index of this row among working marks (the breathing stagger), set only for working rows. */
  breath?: number
  /** Reporting-line facts: levels whose line continues past this row, and whether this row ends its parent's line. */
  through: number[]
  last: boolean
}
export interface BandMoreRow {
  kind: 'more'
  count: number
  depth: 1
  through: number[]
  last: boolean
}
export interface BandDoneRow {
  kind: 'done'
  count: number
  failed: number
  depth: 1
  through: number[]
  last: boolean
}
export type BandRow = BandAgentRow | BandMoreRow | BandDoneRow

export interface BandRun {
  id: string
  projectId: string
  projectLabel: string
  summary: RunSummary
  startedAt: number
  group: BandGroup
  status: RunStatusView
  word: string
  name: string
  chip?: string
  planStep: string | null
  /** Line 2 without the Needs you suffix. */
  line2: string
  decisions: number
  suffix: string
  rootId: string | null
  rootColor: string
  rows: BandRow[]
}

export interface BandProject {
  id: string
  label: string
  client?: string
  runs: BandRun[]
}

export interface BandModel {
  counts: Record<BandGroup, number>
  total: number
  projects: BandProject[]
  shownRuns: number
  hiddenRuns: number
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function bandAgentState(state: AgentState): BandAgentState {
  if (isWorkingAgent(state)) return 'working'
  if (state === 'waiting') return 'waiting'
  if (state === 'done') return 'done'
  if (state === 'error') return 'failed'
  return 'idle'
}

/** The canvas legend's words. */
export const BAND_STATE_WORD: Record<BandAgentState, string> = {
  working: 'Working',
  waiting: 'Needs you',
  idle: 'Idle',
  done: 'Finished',
  failed: 'Failed'
}

const PRIORITY: Record<BandAgentState, number> = { waiting: 0, working: 1, idle: 2, done: 3, failed: 3 }
const GROUP_RANK: Record<BandGroup, number> = { working: 0, waiting: 1, idle: 2 }

/** The role colour as the canvas resolves it: the project's role colour by id, else by slug, else neutral. */
export function roleColorFor(project: Pick<Project, 'roles'> | undefined, roleId: string | null, slug: string): string {
  const roles = project?.roles ?? []
  return roles.find((r) => r.id === roleId)?.color ?? roles.find((r) => r.slug === slug)?.color ?? NEUTRAL_ROLE_COLOR
}

/** The run's orchestrator: the parentless agent that started first. */
export function rootOf(agents: readonly AgentInstance[]): AgentInstance | undefined {
  let root: AgentInstance | undefined
  for (const a of agents) if (a.parentId === null && (!root || a.startedAt < root.startedAt)) root = a
  return root
}

interface Candidate {
  agent: AgentInstance
  state: BandAgentState
  depth: number
  realDepth: number
  parent?: AgentInstance
}

/** Tree order (parent before children, siblings by startedAt) of every non-root agent with its real depth. */
export function treeOrder(all: readonly AgentInstance[]): { agent: AgentInstance; realDepth: number; parent?: AgentInstance }[] {
  const agents = normalizeParents([...all])
  const root = rootOf(agents)
  const byId = new Map(agents.map((a) => [a.id, a]))
  const kids = new Map<string, AgentInstance[]>()
  const tops: AgentInstance[] = []
  for (const a of agents) {
    if (a.parentId === null) {
      if (a !== root) tops.push(a)
      continue
    }
    const list = kids.get(a.parentId)
    if (list) list.push(a)
    else kids.set(a.parentId, [a])
  }
  const byStart = (x: AgentInstance, y: AgentInstance): number => x.startedAt - y.startedAt || x.id.localeCompare(y.id)
  const out: { agent: AgentInstance; realDepth: number; parent?: AgentInstance }[] = []
  const seen = new Set<string>()
  const walk = (a: AgentInstance, depth: number, parent?: AgentInstance): void => {
    if (seen.has(a.id)) return
    seen.add(a.id)
    out.push({ agent: a, realDepth: depth, ...(parent ? { parent } : {}) })
    for (const c of (kids.get(a.id) ?? []).sort(byStart)) walk(c, depth + 1, a)
  }
  if (root) for (const c of (kids.get(root.id) ?? []).sort(byStart)) walk(c, 1, root)
  for (const t of tops.sort(byStart)) walk(t, 1, root)
  // Anything left over (a parent that was never reached) still shows, at depth 1.
  for (const a of [...agents].sort(byStart)) if (a !== root && !seen.has(a.id) && byId.has(a.id)) walk(a, 1, root)
  return out
}

export interface BandAgentsResult {
  rows: BandAgentRow[]
  /** Live agents that did not fit. */
  more: number
  /** Settled agents (done or failed) not shown. */
  done: number
  failed: number
  /** Agents whose rows were kept (counts against the total cap). */
  kept: number
}

/**
 * The agent rows of one run (spec 6.4). Never the root. A done or failed agent shows only inside its grace or while a
 * report under it is live; the rest are counted. Over `share` rows, kept by priority waiting > working > idle > done and
 * shown in tree order.
 */
export function bandAgents(allAgents: readonly AgentInstance[], now: number, share: number, project?: Pick<Project, 'roles'>): BandAgentsResult {
  const agents = normalizeParents([...allAgents])
  const settled = (a: AgentInstance): boolean => isSettledAt(a, now)
  const cands: Candidate[] = []
  let done = 0
  let failed = 0
  for (const t of treeOrder(agents)) {
    const a = t.agent
    const st = bandAgentState(a.state)
    if ((st === 'done' || st === 'failed') && settled(a) && !hasLiveDescendant(agents, a.id, settled)) {
      done++
      if (st === 'failed') failed++
      continue
    }
    cands.push({ agent: a, state: st, depth: Math.min(t.realDepth, BAND_MAX_DEPTH), realDepth: t.realDepth, ...(t.parent ? { parent: t.parent } : {}) })
  }
  const room = Math.max(0, share)
  let kept = cands
  if (cands.length > room) {
    const keepIdx = new Set(
      cands
        .map((c, i) => ({ i, p: PRIORITY[c.state] }))
        .sort((x, y) => x.p - y.p || x.i - y.i)
        .slice(0, room)
        .map((x) => x.i)
    )
    kept = cands.filter((_, i) => keepIdx.has(i))
  }
  const rows: BandAgentRow[] = kept.map((c) => {
    const a = c.agent
    const wt = a.worktree && ['conflict', 'review', 'held'].includes(a.worktree.status) ? worktreeLabel(a.worktree) : undefined
    return {
      kind: 'agent',
      id: a.id,
      label: agentLabel(a),
      role: a.name,
      state: c.state,
      stateWord: BAND_STATE_WORD[c.state],
      activity: nodeActivity(a, { isRoot: false }),
      depth: c.depth,
      ...(c.realDepth > BAND_MAX_DEPTH && c.parent ? { under: agentLabel(c.parent) } : {}),
      ...(wt ? { worktree: wt } : {}),
      color: roleColorFor(project, a.roleId, a.roleSlug),
      lineColor: c.parent ? roleColorFor(project, c.parent.roleId, c.parent.roleSlug) : NEUTRAL_ROLE_COLOR,
      through: [],
      last: true
    }
  })
  return { rows, more: cands.length - kept.length, done, failed, kept: kept.length }
}

/** Fill `through` and `last` on a finished row list (summary rows included, at depth 1). */
export function markLines(rows: BandRow[]): BandRow[] {
  return rows.map((r, i) => {
    const nextAtOrAbove = (level: number): number | undefined => {
      for (let j = i + 1; j < rows.length; j++) if (rows[j].depth <= level) return rows[j].depth
      return undefined
    }
    const through: number[] = []
    for (let level = 1; level < r.depth; level++) if (nextAtOrAbove(level) === level) through.push(level)
    const last = nextAtOrAbove(r.depth) !== r.depth
    return { ...r, through, last }
  })
}

/** Which of the three groups a run belongs to (spec 6.2). */
export function groupOf(status: RunStatusView, decisions: number): BandGroup {
  if (decisions > 0) return 'waiting'
  return status.word === 'Running' ? 'working' : 'idle'
}

/** The plan's current step: the first in progress, else the first pending. */
export function currentStep(plan: RunPlan | undefined): string | undefined {
  const steps = plan?.steps ?? []
  const s = steps.find((x) => x.status === 'in_progress') ?? steps.find((x) => x.status === 'pending')
  return s ? oneLine(s.title, 120) : undefined
}

export function decisionsSuffix(n: number): string {
  return n > 0 ? ` · ${plural(n, 'decision', 'decisions')} in Needs you` : ''
}

export interface BandOptions {
  showAllRuns?: boolean
}

/** Projects > runs > rows plus counts (spec 6.8). */
export function bandModel(
  runs: readonly BandRunIn[],
  projects: readonly Project[],
  virtualProjects: Partial<Record<string, Project>>,
  now: number,
  caps: BandCaps,
  opts: BandOptions = {}
): BandModel {
  const projectOf = (id: string): Project | undefined => projects.find((p) => p.id === id) ?? (isVirtualProjectId(id) ? virtualProjects[id] : undefined)
  const counts: Record<BandGroup, number> = { working: 0, waiting: 0, idle: 0 }
  const built = runs.map((r) => {
    const project = projectOf(r.summary.projectId)
    const status = statusOfRun({ summary: r.summary, plan: r.plan, agents: r.agents }, project, r.decisions > 0)
    const group = groupOf(status, r.decisions)
    counts[group]++
    return { r, project, status, group }
  })
  const ordered = built.sort(
    (a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group] || b.r.summary.startedAt - a.r.summary.startedAt || a.r.summary.id.localeCompare(b.r.summary.id)
  )
  const limit = opts.showAllRuns ? ordered.length : caps.bandRuns
  const shown = ordered.slice(0, limit)
  let remaining = caps.bandAgents
  const out: BandRun[] = shown.map(({ r, project, status, group }) => {
    const list = Object.values(r.agents)
    const root = rootOf(list)
    const res = bandAgents(list, now, Math.min(caps.bandAgentsPerRun, remaining), project)
    remaining = Math.max(0, remaining - res.kept)
    let working = 0
    const agentRows = res.rows.map((a) => (a.state === 'working' ? { ...a, breath: working++ } : a))
    const rows: BandRow[] = [...agentRows]
    if (res.more > 0) rows.push({ kind: 'more', count: res.more, depth: 1, through: [], last: true })
    if (res.done > 0) rows.push({ kind: 'done', count: res.done, failed: res.failed, depth: 1, through: [], last: true })
    const step = group === 'working' ? currentStep(r.plan) : undefined
    return {
      id: r.summary.id,
      projectId: r.summary.projectId,
      projectLabel: locationLabel(r.summary.projectId, projects),
      summary: r.summary,
      startedAt: r.summary.startedAt,
      group,
      status,
      word: statusText(status),
      name: runName(r.summary),
      ...(isVirtualProjectId(r.summary.projectId) || r.summary.quick || r.summary.kind !== 'work' || r.summary.team === 'single' ? { chip: runKindLabel(r.summary) } : {}),
      planStep: planStepLabel(r.plan),
      line2: step ?? (root ? nodeActivity(root, { isRoot: true }) : ''),
      decisions: r.decisions,
      suffix: decisionsSuffix(r.decisions),
      rootId: root?.id ?? null,
      rootColor: roleColorFor(project, root?.roleId ?? null, root?.roleSlug ?? ''),
      rows: markLines(rows)
    }
  })
  // Group by project, most urgent run first, then newest start.
  const byProject = new Map<string, BandProject>()
  for (const run of out) {
    let p = byProject.get(run.projectId)
    if (!p) {
      const project = projectOf(run.projectId)
      const client = project && projectKindOf(project) === 'engagement' && project.client ? project.client : undefined
      p = { id: run.projectId, label: run.projectLabel, ...(client ? { client } : {}), runs: [] }
      byProject.set(run.projectId, p)
    }
    p.runs.push(run)
  }
  return { counts, total: runs.length, projects: [...byProject.values()], shownRuns: out.length, hiddenRuns: runs.length - out.length }
}

/** "2 working · 1 waiting for you · 1 idle", empty parts left out. */
export function countParts(counts: Record<BandGroup, number>): { group: BandGroup; text: string }[] {
  const parts: { group: BandGroup; text: string }[] = []
  if (counts.working > 0) parts.push({ group: 'working', text: `${counts.working} working` })
  if (counts.waiting > 0) parts.push({ group: 'waiting', text: `${counts.waiting} waiting for you` })
  if (counts.idle > 0) parts.push({ group: 'idle', text: `${counts.idle} idle` })
  return parts
}

/** The empty line (spec 6.7). */
export function emptyLine(paused: number): string {
  return paused > 0 ? `Nothing is running. ${paused} paused, see Paused.` : 'Nothing is running.'
}

export function moreRunsLabel(hidden: number): string {
  return `Show ${hidden} more ${hidden === 1 ? 'run' : 'runs'}`
}

export function moreAgentsText(n: number): string {
  return n === 1 ? '1 more agent' : `${n} more agents`
}

export function doneText(n: number, failed: number): string {
  return failed > 0 ? `${n} done, ${failed} failed` : `${n} done`
}

/** Spec 6.3 accessible name of a run header. */
export function runHeadName(run: BandRun, cost: string, now: number): string {
  const parts = [`${run.word}: ${run.name}`, run.projectLabel]
  const line = `${run.line2}${run.suffix}`.trim()
  if (line) parts.push(line)
  if (run.planStep) parts.push(run.planStep)
  if (cost) parts.push(`cost ${cost}`)
  parts.push(`open for ${elapsedLabel(run.startedAt, now)}`)
  return parts.join(', ')
}

/** Spec 6.4 accessible name of an agent row. */
export function agentRowName(row: BandAgentRow, runNameText: string): string {
  const role = row.role && row.role !== row.label ? `${row.role}, ` : ''
  return `${row.label}, ${role}${row.stateWord}: ${row.activity}${row.under ? `, under ${row.under}` : ''}. Opens in ${runNameText}.`
}

/** Stable text of everything the band draws from one input, so an unrelated store event renders nothing. */
export function bandSignature(runs: readonly BandRunIn[], projects: readonly Project[], virtualProjects: Partial<Record<string, Project>>): string {
  const proj = (p: Project): string => `${p.id}|${p.name}|${p.client ?? ''}|${p.kind ?? ''}|${p.autoContinue ?? ''}|${p.maxAutoContinues ?? ''}|${p.roles.map((r) => `${r.id}:${r.slug}:${r.color ?? ''}`).join(',')}`
  const parts: string[] = [projects.map(proj).join(';'), Object.values(virtualProjects).map((p) => (p ? proj(p) : '')).join(';')]
  for (const r of runs) {
    const s = r.summary
    parts.push(
      [
        s.id, s.projectId, s.status, s.kind, s.title ?? '', s.prompt ?? '', s.startedAt, s.quick ? 'q' : '', s.team ?? '', s.endedBy ?? '', s.endedWithApp ? 'a' : '',
        JSON.stringify(runCostInput(s)), r.decisions, r.plan ? `${r.plan.status}/${r.plan.steps.map((x) => `${x.status}:${x.title}`).join('|')}` : '',
        Object.values(r.agents)
          .map((a) => [a.id, a.parentId ?? '', a.state, a.activity, a.handle ?? '', a.name, a.roleId ?? '', a.roleSlug, a.worktree?.status ?? '', a.worktree?.mergeTarget ?? '', a.startedAt, a.endedAt ?? '', a.usage?.producedNothing ? 'n' : '', a.result ? 'r' : ''].join('~'))
          .join('^')
      ].join('\u0001')
    )
  }
  return parts.join('\u0002')
}
