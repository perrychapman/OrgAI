import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type { AgentInstance, AgentState } from '@shared/types'
import { ROLE_COLORS } from '@shared/defaults'
import { EDGE_TYPE, HEX_GAP, HEX_TILE, agentNodeSize, edgeStroke, groupNodeSize, handlesFor, reportingLineRole, ringStepFor, type CanvasOptions } from './canvas'
import { STATION_CORNER_RADIUS, STATION_LINE_WIDTH, messageSides, msgHandleId, type PlacedBox } from './canvasShapes'
import { layoutCanvas, type RingGuides } from './layout'

/**
 * The fixed sample org chart the App settings canvas preview draws (docs/design/canvas-themes.md 7.1): an orchestrator
 * (working), a working lead, a reviewer waiting for you, a finished and a failed report, a "2 done" group and one
 * message from the waiting reviewer to the orchestrator. Pure: it builds React Flow nodes and edges for a given set of
 * canvas options; the preview component supplies the resolved token colours.
 */

/** Resolved colours the edges need (React Flow cannot take var()). */
export interface SampleInks {
  /** --canvas-edge-role-mix, a number 0-100 or '85%'. */
  edgeMix: number | string
  /** --canvas-edge-ink as hex. */
  edgeInk: string
  /** --canvas-edge-group. */
  groupEdge: string
  /** --edge-message. */
  message: string
  /** --canvas-edge-done-opacity as a number. */
  doneOpacity?: number
}

export interface SampleGraph {
  nodes: Node[]
  edges: Edge[]
  rings?: RingGuides
}

interface SampleAgent {
  id: string
  name: string
  slug: string
  parentId: string | null
  state: AgentState
  activity: string
  color: string
  done?: boolean
}

const AGENTS: SampleAgent[] = [
  { id: 'sample-root', name: 'Orchestrator', slug: 'orchestrator', parentId: null, state: 'delegating', activity: 'Delegating the work', color: ROLE_COLORS[0] },
  { id: 'sample-lead', name: 'Lead', slug: 'lead', parentId: 'sample-root', state: 'tool', activity: 'Running the tests', color: ROLE_COLORS[1] },
  { id: 'sample-reviewer', name: 'Reviewer', slug: 'reviewer', parentId: 'sample-root', state: 'waiting', activity: 'Waiting for you', color: ROLE_COLORS[2] },
  { id: 'sample-writer', name: 'Writer', slug: 'writer', parentId: 'sample-lead', state: 'done', activity: 'Finished', color: ROLE_COLORS[3], done: true },
  { id: 'sample-tester', name: 'Tester', slug: 'tester', parentId: 'sample-lead', state: 'error', activity: 'Failed', color: ROLE_COLORS[4] }
]

/** The two folded reports under the reviewer. */
const GROUP_PARENT = 'sample-reviewer'
const GROUP_NODE_ID = `group:${GROUP_PARENT}`

function instance(a: SampleAgent, index: number): AgentInstance {
  const base = 1_700_000_000_000
  return {
    id: a.id,
    roleId: a.slug,
    roleSlug: a.slug,
    name: a.name,
    parentId: a.parentId,
    spawnToolUseId: null,
    state: a.state,
    activity: a.activity,
    model: 'sonnet',
    inputTokens: 12_000 + index * 3_000,
    outputTokens: 2_400 + index * 600,
    costUsd: 0,
    startedAt: base,
    ...(a.done || a.state === 'error' ? { endedAt: base + 90_000 } : {})
  }
}

function foldedAgents(): AgentInstance[] {
  const base = 1_700_000_000_000
  return [0, 1].map((i) => ({
    id: `sample-folded-${i}`,
    roleId: 'helper',
    roleSlug: 'helper',
    name: `Helper ${i + 1}`,
    parentId: GROUP_PARENT,
    spawnToolUseId: null,
    state: 'done' as const,
    activity: 'Finished',
    inputTokens: 4_000,
    outputTokens: 800,
    costUsd: 0,
    startedAt: base,
    endedAt: base + 60_000
  }))
}

const WORKING: ReadonlySet<AgentState> = new Set<AgentState>(['starting', 'thinking', 'tool', 'delegating'])

/** Nodes, edges and ring guides of the sample for the given canvas options. */
export function buildSample(opts: Pick<CanvasOptions, 'layout' | 'nodeStyle' | 'edges'>, inks: SampleInks): SampleGraph {
  const agentSize = agentNodeSize(opts.nodeStyle, opts.layout)
  const groupSize = groupNodeSize(opts.nodeStyle, opts.layout)
  const station = opts.nodeStyle === 'station'
  const result = layoutCanvas(opts.layout, [
    ...AGENTS.map((a) => ({ id: a.id, parentId: a.parentId, width: agentSize.width, height: agentSize.height })),
    { id: GROUP_NODE_ID, parentId: GROUP_PARENT, width: groupSize.width, height: groupSize.height }
  ], {
    ringStep: ringStepFor(opts.nodeStyle),
    ...(opts.nodeStyle === 'hex' ? { honeycomb: { width: HEX_TILE.width, height: HEX_TILE.height, gap: HEX_GAP } } : {})
  })
  const at = (id: string): { x: number; y: number } => result.positions[id] ?? { x: 0, y: 0 }
  const colorOf = (id: string): string => AGENTS.find((a) => a.id === id)?.color ?? ROLE_COLORS[0]
  const agents = AGENTS.map(instance)

  const nodes: Node[] = [
    ...AGENTS.map((a, i) => ({
      id: a.id,
      type: 'agent',
      position: at(a.id),
      width: agentSize.width,
      height: agentSize.height,
      draggable: false,
      selectable: false,
      focusable: false,
      connectable: false,
      data: { agent: agents[i], color: a.color, isRoot: a.parentId === null }
    })),
    {
      id: GROUP_NODE_ID,
      type: 'done-group',
      position: at(GROUP_NODE_ID),
      width: groupSize.width,
      height: groupSize.height,
      draggable: false,
      selectable: false,
      focusable: false,
      connectable: false,
      data: { parentId: GROUP_PARENT, parentName: 'Reviewer', agents: foldedAgents(), color: colorOf(GROUP_PARENT), onToggle: () => undefined }
    }
  ]

  const type = opts.layout === 'radial' ? 'radial' : EDGE_TYPE[opts.edges]
  const doneOpacity = inks.doneOpacity ?? 0.8
  const corners = station && opts.edges === 'orthogonal' && opts.layout !== 'radial' ? { pathOptions: { borderRadius: STATION_CORNER_RADIUS } } : {}
  const reporting: Edge[] = AGENTS.filter((a) => a.parentId).map((a) => {
    const stroke = edgeStroke(reportingLineRole(opts.nodeStyle, colorOf(a.parentId as string), a.color), inks.edgeMix, inks.edgeInk)
    const live = WORKING.has(a.state)
    const finished = a.state === 'done'
    if (station) {
      return {
        id: `e-${a.parentId}-${a.id}`,
        source: a.parentId as string,
        target: a.id,
        type,
        selectable: false,
        focusable: false,
        style: { stroke, strokeWidth: STATION_LINE_WIDTH, strokeLinecap: 'round', strokeLinejoin: 'round', ...(finished ? { opacity: doneOpacity } : {}) },
        ...corners
      }
    }
    return {
      id: `e-${a.parentId}-${a.id}`,
      source: a.parentId as string,
      target: a.id,
      type,
      selectable: false,
      focusable: false,
      animated: live,
      style: {
        stroke,
        strokeWidth: live ? 2.2 : finished ? 1.4 : 1.6,
        ...(live ? { strokeDasharray: '6 4' } : {}),
        ...(finished ? { opacity: inks.doneOpacity ?? 0.8 } : {})
      },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke }
    }
  })
  const group: Edge = {
    id: `e-${GROUP_PARENT}-${GROUP_NODE_ID}`,
    source: GROUP_PARENT,
    target: GROUP_NODE_ID,
    type,
    selectable: false,
    focusable: false,
    style: station
      ? { stroke: edgeStroke(colorOf(GROUP_PARENT), inks.edgeMix, inks.edgeInk), strokeWidth: STATION_LINE_WIDTH, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: doneOpacity }
      : { stroke: inks.groupEdge, strokeWidth: 1.4, strokeDasharray: '4 4' },
    ...(station ? corners : {})
  }
  // The sides facing each other, as the Live canvas picks them; the reviewer reports to the orchestrator, so the
  // message takes the axis the reporting line does not use.
  const box = (id: string, size: { width: number; height: number }): PlacedBox => ({ ...at(id), width: size.width, height: size.height })
  const sides = messageSides(box(GROUP_PARENT, agentSize), box('sample-root', agentSize), handlesFor(opts.layout).source === 'bottom' ? 'y' : 'x')
  const message: Edge = {
    id: 'msg-sample-reviewer-sample-root',
    source: GROUP_PARENT,
    target: 'sample-root',
    sourceHandle: msgHandleId('out', sides.out),
    targetHandle: msgHandleId('in', sides.in),
    type,
    selectable: false,
    focusable: false,
    className: 'msg-edge',
    data: { message: true },
    style: { stroke: inks.message, strokeWidth: 1.8, strokeDasharray: '2 5', strokeLinecap: 'round' },
    markerEnd: { type: MarkerType.ArrowClosed, color: inks.message }
  }
  return { nodes, edges: [...reporting, group, message], ...(result.rings ? { rings: result.rings } : {}) }
}

/** Ids of the sample's nodes in draw order (agents, then the group); for tests. */
export const SAMPLE_NODE_COUNT = AGENTS.length + 1
