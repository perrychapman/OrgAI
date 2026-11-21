/**
 * Team pulse (docs/design/dashboard-usage-redesign/project/components/TeamPulse): the live org chart in miniature as a
 * pure model. Every agent of the open runs is a node on its reporting line (roots side by side, levels down), at most
 * PULSE_MAX_NODES drawn, the rest folded into the caption. A fresh agent-to-agent message becomes a signal that
 * travels the lines between the two. With no open run the pinned project's roles are drawn at rest.
 *
 * No React, no store, no clock of its own: `now` and `since` come in. It imports nothing from Pocket Office or the
 * Factory Floor; the only shared lib it touches is the band's role colour and state words.
 */
import type { AgentInstance, AgentMessage, Project, RunRosterRole } from '@shared/types'
import { bandAgentState, roleColorFor, type BandAgentState } from './dashboardBand'
import { rolesForRun } from './runRoster'

/** Nodes drawn at most; breathing is capped by the same number (motion-design: 12 at once). */
export const PULSE_MAX_NODES = 12
/** Most signals travelling at once. */
export const PULSE_MAX_SIGNALS = 3
/** A pair's signal travels until this long after its last message (two trips of --dur-signal); older messages never replay. */
export const SIGNAL_WINDOW_MS = 4800
/** Trailing recompute interval, as the band's. */
export const PULSE_RECOMPUTE_MS = 250

/** Geometry (viewBox units, 1:1 CSS px at natural size). */
export const SLOT = 32
const RUN_GAP = 20
const PAD = 8
const RADIUS = [11, 9, 7]

export type PulseState = BandAgentState
export type PulseNodeState = PulseState | 'rest'

/** One agent, or one role at rest, as the layout reads it. */
export interface PulseItem {
  id: string
  parentId: string | null
  state: PulseNodeState
  label: string
  /** Role colour (hex or a token reference). Used as fill; never as text. */
  color: string
  /** Sibling and root order (start time, or position in the role list). */
  order: number
}

export interface PulseMessageIn {
  from: string
  to: string | null
  at: number
}

/** One tree: an open run's agents, or the rest team's roles. */
export interface PulseGroup {
  key: string
  items: PulseItem[]
  messages: PulseMessageIn[]
}

export interface PulseNode {
  /** Unique across groups: `${group}:${id}`. */
  key: string
  id: string
  group: string
  state: PulseNodeState
  label: string
  color: string
  x: number
  y: number
  r: number
  depth: number
  /** Breathing stagger index, only on working nodes. */
  breath?: number
}

export interface PulseLine {
  key: string
  /** Parent's role colour. */
  color: string
  d: string
  /** The child's depth: lines trace level by level from the root. */
  level: number
}

export interface PulseSignal {
  key: string
  from: string
  to: string
  /** When the message was sent; the signal is dropped SIGNAL_WINDOW_MS later. */
  at: number
  d: string
}

export interface PulseCaption {
  /** The whole sentence: the visible caption and the picture's text alternative. */
  text: string
  /** Live pictures: "7 agents in 2 runs:", then the parts, then `tail`. Empty for the rest picture. */
  lead: string
  parts: { state: PulseState; text: string }[]
  tail: string
}

export interface PulseModel {
  mode: 'live' | 'rest'
  nodes: PulseNode[]
  lines: PulseLine[]
  signals: PulseSignal[]
  width: number
  height: number
  /** Agents (or roles) not drawn. */
  more: number
  caption: PulseCaption
}

export interface PulseInput {
  /** Open runs that have agents, oldest first. */
  groups: PulseGroup[]
  /** The rest team when no run is open (roles as items), else null. */
  rest: PulseGroup | null
  now: number
  /** Messages sent before this moment never make a signal (the picture was not there to see them). */
  since: number
}

const RANK: Record<PulseNodeState, number> = { waiting: 0, working: 1, failed: 2, idle: 3, done: 4, rest: 5 }

/** The words of each state in the caption. */
const STATE_WORD: Record<PulseState, string> = { working: 'working', waiting: 'needs you', idle: 'idle', done: 'finished', failed: 'failed' }
const STATE_ORDER: readonly PulseState[] = ['working', 'waiting', 'idle', 'done', 'failed']

/** A node's state in words (its tooltip). */
export function pulseStateWord(state: PulseNodeState): string {
  return state === 'rest' ? 'at rest' : STATE_WORD[state]
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

// ---------- Tree ----------

interface Tree {
  group: PulseGroup
  index: number
  root: PulseItem
  parent: Map<string, string | null>
  kids: Map<string, PulseItem[]>
  depth: Map<string, number>
  byId: Map<string, PulseItem>
}

const byOrder = (a: PulseItem, b: PulseItem): number => a.order - b.order || a.id.localeCompare(b.id)

/**
 * One root per tree: the parentless item that came first (else the first item). Items whose parent is missing or
 * whose chain loops hang under the root, so every item has a place. Pure; never mutates `items`.
 */
function treeOf(group: PulseGroup, index: number): Tree | null {
  const items = [...group.items].sort(byOrder)
  if (items.length === 0) return null
  const byId = new Map(items.map((i) => [i.id, i]))
  const root = items.find((i) => i.parentId === null) ?? items[0]
  const reachesRoot = (start: PulseItem): boolean => {
    const seen = new Set<string>([start.id])
    let cur: string | null = start.parentId
    while (cur !== null) {
      if (cur === root.id) return true
      if (!byId.has(cur) || seen.has(cur)) return false
      seen.add(cur)
      cur = byId.get(cur)?.parentId ?? null
    }
    return false
  }
  const parent = new Map<string, string | null>()
  const kids = new Map<string, PulseItem[]>()
  for (const it of items) {
    let p: string | null
    if (it === root) p = null
    else if (it.parentId !== null && it.parentId !== it.id && byId.has(it.parentId) && reachesRoot(it)) p = it.parentId
    else p = root.id
    parent.set(it.id, p)
    if (p !== null) {
      const list = kids.get(p)
      if (list) list.push(it)
      else kids.set(p, [it])
    }
  }
  const depth = new Map<string, number>([[root.id, 0]])
  const stack = [root.id]
  while (stack.length) {
    const id = stack.pop() as string
    for (const c of kids.get(id) ?? []) {
      depth.set(c.id, (depth.get(id) as number) + 1)
      stack.push(c.id)
    }
  }
  return { group, index, root, parent, kids, depth, byId }
}

// ---------- Selection ----------

/** The ids drawn, per tree key: roots first, then by state priority (waiting, working, failed, idle, done), shallow first. */
function select(trees: Tree[], cap: number): Set<string> {
  const chosen = new Set<string>()
  const keyOf = (t: Tree, id: string): string => `${t.group.key}\u0000${id}`
  for (const t of trees) {
    if (chosen.size >= cap) break
    chosen.add(keyOf(t, t.root.id))
  }
  const cands: { t: Tree; it: PulseItem; depth: number }[] = []
  for (const t of trees) {
    if (!chosen.has(keyOf(t, t.root.id))) continue
    for (const it of t.group.items) if (it !== t.root) cands.push({ t, it, depth: t.depth.get(it.id) ?? 1 })
  }
  cands.sort((a, b) => RANK[a.it.state] - RANK[b.it.state] || a.depth - b.depth || a.t.index - b.t.index || byOrder(a.it, b.it))
  for (const { t, it } of cands) {
    if (chosen.size >= cap) break
    const missing: string[] = []
    let cur: string | null = it.id
    while (cur !== null && !chosen.has(keyOf(t, cur))) {
      missing.push(cur)
      cur = t.parent.get(cur) ?? null
    }
    if (chosen.size + missing.length > cap) continue
    for (const id of missing) chosen.add(keyOf(t, id))
  }
  return chosen
}

// ---------- Layout ----------

const radiusAt = (depth: number): number => RADIUS[Math.min(depth, RADIUS.length - 1)]
const rowFor = (levels: number): number => (levels <= 3 ? 44 : levels <= 5 ? 36 : 30)

/** An orthogonal reporting line: down from the parent, across at mid height, down into the child. */
function elbow(px: number, py: number, pr: number, cx: number, cy: number, cr: number, mid: number): string {
  return `M${px} ${py + pr} V${mid} H${cx} V${cy - cr}`
}

/** A signal's path of waypoints: "M x y L x y ...", repeated points dropped. */
function polyline(points: [number, number][]): string {
  const out: [number, number][] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p)
  }
  return out.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ')
}

/** The picture of `input`. Empty when nothing is open and there is no rest team (callers render null). */
export function pulseModel(input: PulseInput): PulseModel | null {
  const live = input.groups.filter((g) => g.items.length > 0)
  const mode = live.length > 0 ? 'live' : 'rest'
  const groups = mode === 'live' ? live : input.rest && input.rest.items.length > 0 ? [input.rest] : []
  if (groups.length === 0) return null
  const trees = groups.map((g, i) => treeOf(g, i)).filter((t): t is Tree => t !== null)

  const chosen = select(trees, PULSE_MAX_NODES)
  const isChosen = (t: Tree, id: string): boolean => chosen.has(`${t.group.key}\u0000${id}`)

  // Tidy tree: leaves take consecutive slots, a parent sits over its first and last drawn child.
  const slotX = new Map<string, number>()
  let cursor = 0
  let first = true
  let levels = 1
  for (const t of trees) {
    if (!isChosen(t, t.root.id)) continue
    if (!first) cursor += RUN_GAP / SLOT
    first = false
    const place = (it: PulseItem): void => {
      const kids = (t.kids.get(it.id) ?? []).filter((k) => isChosen(t, k.id))
      levels = Math.max(levels, (t.depth.get(it.id) ?? 0) + 1)
      if (kids.length === 0) {
        slotX.set(`${t.group.key}\u0000${it.id}`, cursor)
        cursor += 1
        return
      }
      for (const k of kids) place(k)
      const a = slotX.get(`${t.group.key}\u0000${kids[0].id}`) as number
      const b = slotX.get(`${t.group.key}\u0000${kids[kids.length - 1].id}`) as number
      slotX.set(`${t.group.key}\u0000${it.id}`, (a + b) / 2)
    }
    place(t.root)
  }

  const row = rowFor(levels)
  const rMax = RADIUS[0]
  const x0 = PAD + rMax
  const y0 = PAD + rMax
  const nodes: PulseNode[] = []
  const nodeAt = new Map<string, PulseNode>()
  let breath = 0
  const emit = (t: Tree, it: PulseItem): void => {
    const depth = t.depth.get(it.id) ?? 0
    const key = `${t.group.key}\u0000${it.id}`
    const node: PulseNode = {
      key: `${t.group.key}:${it.id}`,
      id: it.id,
      group: t.group.key,
      state: it.state,
      label: it.label,
      color: it.color,
      x: Math.round((x0 + (slotX.get(key) as number) * SLOT) * 2) / 2,
      y: y0 + depth * row,
      r: radiusAt(depth),
      depth,
      ...(it.state === 'working' && breath < PULSE_MAX_NODES ? { breath: breath++ } : {})
    }
    nodes.push(node)
    nodeAt.set(key, node)
    for (const k of t.kids.get(it.id) ?? []) if (isChosen(t, k.id)) emit(t, k)
  }
  for (const t of trees) if (isChosen(t, t.root.id)) emit(t, t.root)

  const lines: PulseLine[] = []
  for (const t of trees) {
    for (const it of t.group.items) {
      if (it === t.root || !isChosen(t, it.id)) continue
      const child = nodeAt.get(`${t.group.key}\u0000${it.id}`) as PulseNode
      const par = nodeAt.get(`${t.group.key}\u0000${t.parent.get(it.id)}`) as PulseNode | undefined
      if (!par) continue
      lines.push({ key: child.key, color: par.color, level: child.depth, d: elbow(par.x, par.y, par.r, child.x, child.y, child.r, par.y + row / 2) })
    }
  }
  lines.sort((a, b) => a.level - b.level || a.key.localeCompare(b.key))

  // Signals: a fresh message between two drawn agents of one run travels up to their common parent and down again.
  const signals: PulseSignal[] = []
  if (mode === 'live') {
    const fresh: { t: Tree; m: PulseMessageIn }[] = []
    for (const t of trees) {
      for (const m of t.group.messages) {
        if (m.to === null || m.to === m.from) continue
        if (m.at < input.since || input.now - m.at > SIGNAL_WINDOW_MS || m.at > input.now + 1000) continue
        if (!isChosen(t, m.from) || !isChosen(t, m.to)) continue
        fresh.push({ t, m })
      }
    }
    fresh.sort((a, b) => b.m.at - a.m.at || a.m.from.localeCompare(b.m.from))
    const pairs = new Set<string>()
    for (const { t, m } of fresh) {
      if (signals.length >= PULSE_MAX_SIGNALS) break
      const to = m.to
      if (to === null) continue
      const pair = `${t.group.key}\u0000${[m.from, to].sort().join('\u0000')}`
      if (pairs.has(pair)) continue
      pairs.add(pair)
      const up = (id: string): string[] => {
        const chain: string[] = []
        let cur: string | null = id
        while (cur !== null) {
          chain.push(cur)
          cur = t.parent.get(cur) ?? null
        }
        return chain
      }
      // One fixed direction per pair (the smaller id first), so a back-and-forth conversation keeps one dot travelling
      // the same way instead of restarting or jumping on every message.
      const [lo, hi] = m.from < to ? [m.from, to] : [to, m.from]
      const a = up(lo)
      const b = up(hi)
      const meet = a.find((id) => b.includes(id))
      if (!meet) continue
      const goUp = a.slice(0, a.indexOf(meet) + 1)
      const goDown = b.slice(0, b.indexOf(meet)).reverse()
      const at = (id: string): PulseNode => nodeAt.get(`${t.group.key}\u0000${id}`) as PulseNode
      const pts: [number, number][] = []
      for (let i = 0; i < goUp.length; i++) {
        const n = at(goUp[i])
        pts.push([n.x, n.y])
        const p = i + 1 < goUp.length ? at(goUp[i + 1]) : null
        if (p) {
          const mid = p.y + row / 2
          pts.push([n.x, mid], [p.x, mid])
        }
      }
      let prev = at(meet)
      for (const id of goDown) {
        const n = at(id)
        const mid = prev.y + row / 2
        pts.push([prev.x, prev.y], [prev.x, mid], [n.x, mid], [n.x, n.y])
        prev = n
      }
      // Keyed by the pair, not the message: a conversation keeps one dot travelling instead of restarting it each message.
      signals.push({ key: `${t.group.key}:${lo}>${hi}`, from: lo, to: hi, at: m.at, d: polyline(pts) })
    }
  }

  let maxX = 0
  let maxY = 0
  for (const n of nodes) {
    maxX = Math.max(maxX, n.x + n.r)
    maxY = Math.max(maxY, n.y + n.r)
  }
  const width = Math.ceil(maxX + PAD)
  const height = Math.ceil(maxY + PAD)

  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const more = total - nodes.length
  return { mode, nodes, lines, signals, width, height, more, caption: captionOf(mode, groups, total, more) }
}

/** The caption sentence, built from the whole of every group (drawn or not), so it stays true when nodes are folded. */
function captionOf(mode: 'live' | 'rest', groups: PulseGroup[], total: number, more: number): PulseCaption {
  if (mode === 'rest') {
    const text = `Your team: ${plural(total, 'role', 'roles')}${more > 0 ? `, +${more} more not drawn` : ''}. Nothing is running.`
    return { text, lead: text, parts: [], tail: '' }
  }
  const counts: Record<PulseState, number> = { working: 0, waiting: 0, idle: 0, done: 0, failed: 0 }
  for (const g of groups) for (const it of g.items) if (it.state !== 'rest') counts[it.state]++
  const lead = `${plural(total, 'agent', 'agents')} in ${plural(groups.length, 'run', 'runs')}:`
  const parts = STATE_ORDER.filter((s) => counts[s] > 0).map((s) => ({ state: s, text: `${counts[s]} ${STATE_WORD[s]}` }))
  const tail = more > 0 ? `+${more} more not drawn.` : ''
  const body = `${lead} ${parts.map((p) => p.text).join(', ')}.`
  return { text: tail ? `${body} ${tail}` : body, lead, parts, tail }
}

// ---------- From store state ----------

/** What the pulse reads of one open run (a reduced view of RunState). */
export interface PulseRunSource {
  id: string
  projectId: string
  startedAt: number
  roster?: RunRosterRole[]
  agents: Record<string, AgentInstance>
  messages?: readonly AgentMessage[]
}

/** The agent's label on the node's tooltip: its name, else its handle. */
function agentTitle(a: AgentInstance): string {
  return a.name || a.handle || a.roleSlug || a.id
}

/**
 * Input for pulseModel from store state: open runs (already filtered to live, known-project runs) oldest first, the rest
 * project's roles, the clock and the moment the pulse mounted.
 */
export function pulseInput(
  runs: readonly PulseRunSource[],
  projects: readonly Project[],
  virtualProjects: Partial<Record<string, Project>>,
  restProjectId: string | null,
  now: number,
  since: number
): PulseInput {
  const projectOf = (id: string): Project | undefined => projects.find((p) => p.id === id) ?? virtualProjects[id]
  const groups: PulseGroup[] = [...runs]
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
    .map((r) => {
      const project = projectOf(r.projectId)
      const source = { roles: rolesForRun(r.roster, project?.roles) }
      const items: PulseItem[] = Object.values(r.agents).map((a) => ({
        id: a.id,
        parentId: a.parentId,
        state: bandAgentState(a.state),
        label: agentTitle(a),
        color: roleColorFor(source, a.roleId, a.roleSlug),
        order: a.startedAt
      }))
      return { key: r.id, items, messages: (r.messages ?? []).map((m) => ({ from: m.from, to: m.to, at: m.at })) }
    })
    .filter((g) => g.items.length > 0)
  const rp = restProjectId ? projects.find((p) => p.id === restProjectId) : undefined
  const rest: PulseGroup | null =
    rp && rp.roles.length > 0
      ? {
          key: `rest:${rp.id}`,
          messages: [],
          items: rp.roles.map((r, i) => ({ id: r.id, parentId: r.reportsTo, state: 'rest' as const, label: r.name, color: r.color || 'var(--text-tertiary)', order: i }))
        }
      : null
  return { groups, rest, now, since }
}
