import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { MarkerType, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type NodeChange, type NodeMouseHandler } from '@xyflow/react'
import type { KnowledgeGraph as KnowledgeGraphData } from '@shared/types'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Switch } from '../ui/Switch'
import { CanvasBackdrop } from '../canvas/CanvasBackdrop'
import { CanvasMinimap } from '../canvas/CanvasMinimap'
import { CANVAS_EDGE_TYPES } from '../canvas/RadialEdge'
import { STATION_CORNER_RADIUS, STATION_LINE_WIDTH } from '../../lib/canvasShapes'
import { fitOptions } from '../../lib/canvasFit'
import { EDGE_TYPE, HEX_GAP, HEX_TILE, edgeStroke, ringStepFor, useCanvasOptions, useNodeDims, useReducedMotion } from '../../lib/canvas'
import { layoutCanvas } from '../../lib/layout'
import { useCssVar } from '../../lib/useCssVar'
import { keyWords, kindColor, kindLabel, type KnowledgeFilter } from '../../lib/knowledge'
import {
  DEFAULT_GRAPH_DEPTH,
  EMPTY_GRAPH_TEXT,
  GRAPH_DEPTHS,
  drawnAnnouncement,
  drawnGraph,
  drawnNeighbours,
  factCount,
  filteredNodeIds,
  graphCentreId,
  groupSpokenName,
  isRetiredGroupId,
  knowledgeNodeSize,
  layoutItems,
  legendEntries,
  needsShowAllConfirm,
  neighbourInDirection,
  nodeCountsLine,
  nodeSpokenName,
  relationTexts,
  retiredGroupId,
  retiredGroupSize,
  showAllWarning,
  topologyKey,
  type ArrowDirection,
  type GraphDepth
} from '../../lib/knowledgeGraph'
import { KnowledgeGraphNode, type KnowledgeFlowNode } from './KnowledgeGraphNode'
import { KnowledgeRetiredGroupNode, type KnowledgeRetiredFlowNode } from './KnowledgeRetiredGroupNode'
import { KnowledgeGraphEdge, type KnowledgeEdgeData, type KnowledgeEdgeKind } from './KnowledgeGraphEdge'
import { KnowledgeGraphLegend } from './KnowledgeGraphLegend'
import '../../styles/knowledge-graph.css'

/**
 * The Knowledge tab's Graph view (docs/design/knowledge.md section 5): a React Flow canvas of the selected item's
 * neighbourhood, sharing the list's filter and selection. The props are the contract between KnowledgeView (the list,
 * detail pane and view switch) and this component; depth, "Show all" and the legend are its own state.
 */
export interface KnowledgeGraphProps {
  projectId: string
  graph: KnowledgeGraphData
  /** The list's filter (kinds, origins, showRetired, query), applied before layout. */
  filter: KnowledgeFilter
  /** The selection the list, the detail pane and the graph share (a node id; a note id or null = no centre). */
  selectedId: string | null
  onSelect: (id: string | null) => void
  /** Enter on a node (or a double click): open the detail pane with focus on its heading. */
  onOpen: (id: string) => void
  /** DOM ids the "Skip to list" / "Skip to detail" links target. */
  listDomId: string
  detailDomId: string
  /** Speak through the tab's one polite status region. */
  announce: (text: string) => void
}

const nodeTypes = { knowledge: KnowledgeGraphNode, 'knowledge-retired': KnowledgeRetiredGroupNode }
const edgeTypes = { ...CANVAS_EDGE_TYPES, knowledge: KnowledgeGraphEdge }
type CanvasNode = KnowledgeFlowNode | KnowledgeRetiredFlowNode

const ZOOM_MS = 150
const FIT_MS = 300
const DEPTH_OPTIONS = GRAPH_DEPTHS.map((d) => ({ value: String(d) as `${GraphDepth}`, label: String(d) }))

/** Groups expanded this session, per project: a view switch or another project keeps them until OrgAI restarts. */
const expandedByProject = new Map<string, Set<string>>()
function expandedFor(projectId: string): Set<string> {
  let set = expandedByProject.get(projectId)
  if (!set) {
    set = new Set()
    expandedByProject.set(projectId, set)
  }
  return set
}

const ARROWS: Record<string, ArrowDirection> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

export default function KnowledgeGraph(props: KnowledgeGraphProps): ReactElement {
  return (
    <ReactFlowProvider>
      <GraphInner {...props} />
    </ReactFlowProvider>
  )
}

function GraphInner({ projectId, graph, filter, selectedId, onSelect, onOpen, listDomId, detailDomId, announce }: KnowledgeGraphProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const options = useCanvasOptions()
  const reducedMotion = useReducedMotion()
  const reducedRef = useRef(reducedMotion)
  reducedRef.current = reducedMotion
  const nodeDims = useNodeDims()
  const edgeMix = useCssVar('--canvas-edge-role-mix')
  const edgeInk = useCssVar('--canvas-edge-ink')
  const groupEdgeColor = useCssVar('--canvas-edge-group')
  const labelColor = useCssVar('--text-secondary')
  const labelBg = useCssVar('--surface-1')

  const [depth, setDepth] = useState<GraphDepth>(DEFAULT_GRAPH_DEPTH)
  const [showAll, setShowAll] = useState(false)
  const [confirmedAll, setConfirmedAll] = useState(false)
  const [expandedTick, setExpandedTick] = useState(0)
  const expanded = expandedFor(projectId)

  const radial = options.layout === 'radial'
  const station = options.nodeStyle === 'station'
  const edgeKind: KnowledgeEdgeKind = radial ? 'radial' : EDGE_TYPE[options.edges]
  const nodeSize = useMemo(() => knowledgeNodeSize(options.nodeStyle, options.layout), [options.nodeStyle, options.layout])
  const groupSize = useMemo(() => retiredGroupSize(options.nodeStyle, options.layout), [options.nodeStyle, options.layout])
  const roundedCorners = useMemo(() => (station && options.edges === 'orthogonal' && !radial ? { pathOptions: { borderRadius: STATION_CORNER_RADIUS } } : {}), [station, options.edges, radial])

  // Kind colours are stable over the whole graph (retired kinds included), so a filter never recolours a node.
  const kindsInUse = useMemo(() => [...new Set(graph.nodes.map((n) => n.kind))], [graph.nodes])
  const colorOf = useCallback((kind: string): string => kindColor(kind, kindsInUse), [kindsInUse])

  const centreId = graphCentreId(graph, selectedId)
  const filteredCount = useMemo(() => filteredNodeIds(graph, filter).length, [graph, filter])
  const warn = showAll && needsShowAllConfirm(filteredCount) && !confirmedAll
  // The confirmation holds while "Show all" stays on; turning it off asks again next time.
  useEffect(() => {
    if (!showAll) setConfirmedAll(false)
  }, [showAll])

  const drawn = useMemo(
    () => drawnGraph({ graph, selectedId, depth, showAll: showAll && !warn, filter, expanded }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, selectedId, depth, showAll, warn, filter, expandedTick, projectId]
  )
  const empty = !showAll && !centreId

  // The layout, node style and topology decide where nodes sit and when to refit.
  const layoutKey = `${topologyKey(drawn)}#${options.layout}#${options.nodeStyle}`
  const placed = useMemo(
    () =>
      layoutCanvas(options.layout, layoutItems(drawn, nodeSize, groupSize), {
        nodesep: 40,
        ranksep: 90,
        ringStep: ringStepFor(options.nodeStyle),
        ...(options.nodeStyle === 'hex' ? { honeycomb: { width: HEX_TILE.width, height: HEX_TILE.height, gap: HEX_GAP } } : {})
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey]
  )
  const positions = placed.positions
  const rings = radial && options.nodeStyle !== 'hex' && drawn.nodes.length > 1 ? placed.rings : undefined

  const toggleGroup = useCallback(
    (parentId: string) => {
      const set = expandedFor(projectId)
      const group = drawn.groups.find((g) => g.parentId === parentId)
      if (set.has(parentId)) set.delete(parentId)
      else set.add(parentId)
      setExpandedTick((t) => t + 1)
      if (group) {
        const parent = graph.nodes.find((n) => n.id === parentId)
        announce(`Showing ${group.members.length === 1 ? '1 retired item' : `${group.members.length} retired items`} under ${parent?.name ?? 'the item'}.`)
      }
    },
    [projectId, drawn.groups, graph.nodes, announce]
  )

  const nodes: CanvasNode[] = useMemo(() => {
    const items: CanvasNode[] = drawn.nodes.map((n) => {
      const facts = factCount(n, filter.showRetired)
      const relations = relationTexts(graph, n.id, filter.showRetired)
      const label = kindLabel(n.kind)
      const counts = nodeCountsLine(facts, relations.length)
      return {
        id: n.id,
        type: 'knowledge' as const,
        position: positions[n.id] ?? { x: 0, y: 0 },
        selected: n.id === selectedId,
        draggable: false,
        initialWidth: nodeSize.width,
        initialHeight: nodeSize.height,
        ...(nodeDims.dims[n.id] ? { measured: nodeDims.dims[n.id] } : {}),
        ariaLabel: nodeSpokenName(n, facts, relations),
        data: {
          name: n.name,
          kindLabel: label,
          color: colorOf(n.kind),
          counts,
          retired: !!n.retired,
          centre: n.id === drawn.centreId,
          tip: [n.name, `${label}${n.retired ? ' · Retired' : ''}`, counts, ...relations].join('\n')
        }
      }
    })
    const groups: CanvasNode[] = drawn.groups.map((g) => {
      const parent = graph.nodes.find((n) => n.id === g.parentId)
      const id = retiredGroupId(g.parentId)
      return {
        id,
        type: 'knowledge-retired' as const,
        position: positions[id] ?? { x: 0, y: 0 },
        selected: false,
        selectable: false,
        draggable: false,
        initialWidth: groupSize.width,
        initialHeight: groupSize.height,
        ...(nodeDims.dims[id] ? { measured: nodeDims.dims[id] } : {}),
        ariaLabel: groupSpokenName(g.members.length, parent?.name ?? 'the item'),
        data: {
          parentId: g.parentId,
          parentName: parent?.name ?? 'the item',
          count: g.members.length,
          color: colorOf(parent?.kind ?? ''),
          tip: g.members.map((m) => m.name).join('\n'),
          onToggle: toggleGroup
        }
      }
    })
    return [...items, ...groups]
  }, [drawn, graph, filter.showRetired, positions, selectedId, nodeSize, groupSize, nodeDims.dims, colorOf, toggleGroup])

  const edges: Edge[] = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const relationEdges: Edge[] = drawn.edges.map((e) => {
      const from = byId.get(e.from)
      const to = byId.get(e.to)
      const color = edgeStroke(colorOf(from?.kind ?? ''), edgeMix, edgeInk)
      const words = keyWords(e.relation)
      const retired = !!e.retired || !!from?.retired || !!to?.retired
      const sentence = `${from?.name ?? '(removed)'} ${words} ${to?.name ?? '(removed)'}`
      const data: KnowledgeEdgeData = { kind: edgeKind, label: words, title: e.note ? `${sentence}\n${e.note}` : sentence }
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'knowledge',
        ariaLabel: sentence,
        className: retired ? 'knowledge-edge-retired' : undefined,
        data,
        ...(station ? roundedCorners : {}),
        style: station
          ? { stroke: color, strokeWidth: STATION_LINE_WIDTH, strokeLinecap: 'round', strokeLinejoin: 'round', ...(retired ? { strokeDasharray: '2 10', opacity: 0.7 } : {}) }
          : { stroke: color, strokeWidth: 1.6, ...(retired ? { strokeDasharray: '4 4', opacity: 0.7 } : {}) },
        markerEnd: station ? undefined : { type: MarkerType.ArrowClosed, color },
        labelStyle: { fill: labelColor, fontSize: 11 },
        labelBgStyle: { fill: labelBg },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 4
      }
    })
    const groupEdges: Edge[] = drawn.groups.map((g) => {
      const parent = byId.get(g.parentId)
      const id = retiredGroupId(g.parentId)
      const title = `${g.members.length === 1 ? '1 retired item' : `${g.members.length} retired items`} under ${parent?.name ?? 'the item'}`
      const data: KnowledgeEdgeData = { kind: edgeKind, title }
      const base = { id: `e-${id}`, source: g.parentId, target: id, type: 'knowledge', ariaLabel: title, data, className: 'knowledge-edge-retired' }
      if (!station) return { ...base, style: { stroke: groupEdgeColor, strokeWidth: 1.4, strokeDasharray: '4 4' } }
      const color = edgeStroke(colorOf(parent?.kind ?? ''), edgeMix, edgeInk)
      return { ...base, style: { stroke: color, strokeWidth: STATION_LINE_WIDTH, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, opacity: 0.7 }, ...roundedCorners }
    })
    return [...relationEdges, ...groupEdges]
  }, [drawn, graph.nodes, colorOf, edgeMix, edgeInk, edgeKind, station, roundedCorners, labelColor, labelBg, groupEdgeColor])

  const fitOpts = useCallback(
    (duration: number) =>
      fitOptions({
        stageHeight: stageRef.current?.clientHeight ?? 1000,
        radial: options.layout === 'radial',
        nodeStyle: options.nodeStyle,
        duration
      }),
    [options.layout, options.nodeStyle]
  )
  const stageShown = (): boolean => (stageRef.current?.clientHeight ?? 0) >= 8

  // Layout changes (depth, filter, selection, canvas settings) re-fit once; instant under reduced motion (rec 19).
  const lastKey = useRef('')
  useEffect(() => {
    if (empty || layoutKey === lastKey.current) return undefined
    lastKey.current = layoutKey
    const t = window.setTimeout(() => {
      if (!stageShown()) return
      void fitView(fitOpts(reducedRef.current ? 0 : FIT_MS))
    }, 60)
    return () => window.clearTimeout(t)
  }, [layoutKey, empty, fitView, fitOpts])

  // Re-fit when the stage changes size (window, sidebar, side panel), skipping the first measure.
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    let t: ReturnType<typeof setTimeout> | undefined
    let first = true
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false
        return
      }
      clearTimeout(t)
      t = setTimeout(() => {
        if (!stageShown()) return
        void fitView(fitOpts(reducedRef.current ? 0 : ZOOM_MS))
      }, 100)
    })
    ro.observe(el)
    return () => {
      clearTimeout(t)
      ro.disconnect()
    }
  }, [fitView, fitOpts])

  // Controlled nodes: keep React Flow's measured sizes for the minimap; Enter / Space on a focused node arrive as a
  // 'select' change (React Flow's own key handler) and select like a click. Group nodes never select.
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      nodeDims.apply(changes as NodeChange[])
      const picked = changes.find((c) => c.type === 'select' && c.selected && !isRetiredGroupId(c.id))
      if (picked && picked.type === 'select' && picked.id !== selectedId) onSelect(picked.id)
    },
    [nodeDims.apply, onSelect, selectedId]
  )

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback(
    (_e, node) => {
      if (isRetiredGroupId(node.id)) {
        toggleGroup(node.id.slice('retired:'.length))
        return
      }
      if (node.id !== selectedId) onSelect(node.id)
    },
    [onSelect, selectedId, toggleGroup]
  )
  const onNodeDoubleClick: NodeMouseHandler<CanvasNode> = useCallback(
    (_e, node) => {
      if (isRetiredGroupId(node.id)) return
      onOpen(node.id)
    },
    [onOpen]
  )

  const focusNode = (id: string): void => {
    rootRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.focus()
  }

  // Keyboard on the canvas: Enter opens, Space selects, Ctrl+Arrow follows a relation to the nearest neighbour that
  // way (rec 17), + / - zoom and 0 fits. Buttons inside a node keep their keys (the group's chevron stops them).
  const onRootKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>): void => {
    const target = e.target as HTMLElement
    const onNode = target.classList.contains('react-flow__node')
    const nodeId = onNode ? target.getAttribute('data-id') : null
    if (nodeId && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      e.stopPropagation()
      if (isRetiredGroupId(nodeId)) {
        toggleGroup(nodeId.slice('retired:'.length))
        return
      }
      if (nodeId !== selectedId) onSelect(nodeId)
      if (e.key === 'Enter') onOpen(nodeId)
      return
    }
    if (nodeId && (e.ctrlKey || e.metaKey) && ARROWS[e.key]) {
      const next = neighbourInDirection(positions, nodeId, drawnNeighbours(edges.map((x) => ({ from: x.source, to: x.target })), nodeId), ARROWS[e.key])
      if (next) {
        e.preventDefault()
        e.stopPropagation()
        focusNode(next)
      }
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (target.closest('input, textarea, select, button, [role=dialog]')) return
    if (e.key === '+' || e.key === '=') void zoomIn({ duration: reducedMotion ? 0 : ZOOM_MS })
    else if (e.key === '-' || e.key === '_') void zoomOut({ duration: reducedMotion ? 0 : ZOOM_MS })
    else if (e.key === '0' && stageShown()) void fitView(fitOpts(reducedMotion ? 0 : ZOOM_MS))
  }

  const skipTo = (domId: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault()
    const el = document.getElementById(domId)
    if (!el) return
    if (!el.hasAttribute('tabindex') && !(el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLAnchorElement)) el.tabIndex = -1
    el.focus()
  }

  const legend = useMemo(() => legendEntries(drawn, kindsInUse), [drawn, kindsInUse])

  const changeDepth = (value: string): void => {
    const d = Number(value) as GraphDepth
    if (!GRAPH_DEPTHS.includes(d)) return
    setDepth(d)
    announce(`Depth ${d}. ${drawnAnnouncement(drawnGraph({ graph, selectedId, depth: d, showAll: showAll && !warn, filter, expanded }))}`)
  }
  const changeShowAll = (on: boolean): void => {
    setShowAll(on)
    if (on && needsShowAllConfirm(filteredCount)) {
      announce(showAllWarning(filteredCount))
      return
    }
    announce(drawnAnnouncement(drawnGraph({ graph, selectedId, depth, showAll: on, filter, expanded })))
  }
  const confirmAll = (): void => {
    setConfirmedAll(true)
    announce(drawnAnnouncement(drawnGraph({ graph, selectedId, depth, showAll: true, filter, expanded })))
  }
  const keepNeighbourhood = (): void => {
    setShowAll(false)
    announce(drawnAnnouncement(drawnGraph({ graph, selectedId, depth, showAll: false, filter, expanded })))
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('[data-testid=knowledge-graph-all]')?.focus())
  }

  return (
    <div className="knowledge-graph" data-testid="knowledge-graph" data-drawn={drawn.nodes.length} data-depth={depth} data-all={showAll ? 'true' : 'false'} ref={rootRef} onKeyDownCapture={onRootKeyDownCapture}>
      <div className="knowledge-graph-toolbar" data-testid="knowledge-graph-toolbar">
        <a href={`#${listDomId}`} className="skip-link knowledge-skip" data-testid="knowledge-skip-list" onClick={skipTo(listDomId)}>
          Skip to list
        </a>
        <a href={`#${detailDomId}`} className="skip-link knowledge-skip" data-testid="knowledge-skip-detail" onClick={skipTo(detailDomId)}>
          Skip to detail
        </a>
        <span className="knowledge-graph-depth" data-testid="knowledge-graph-depth">
          <span className="toolbar-note" aria-hidden="true">
            Depth
          </span>
          <SegmentedControl label="Depth" value={String(depth) as `${GraphDepth}`} options={DEPTH_OPTIONS} onChange={changeDepth} />
        </span>
        <span className="knowledge-graph-all">
          <span className="toolbar-note" aria-hidden="true">
            Show all
          </span>
          <Switch label="Show all" checked={showAll} onChange={changeShowAll} testId="knowledge-graph-all" />
        </span>
        <span className="canvas-tools knowledge-graph-tools">
          <span className="zoom-group" role="group" aria-label="Graph zoom">
            <IconButton icon={ZoomOut} label="Zoom out" size="sm" testId="knowledge-graph-zoom-out" onClick={() => void zoomOut({ duration: reducedMotion ? 0 : ZOOM_MS })} />
            <IconButton icon={ZoomIn} label="Zoom in" size="sm" testId="knowledge-graph-zoom-in" onClick={() => void zoomIn({ duration: reducedMotion ? 0 : ZOOM_MS })} />
            <IconButton icon={Maximize} label="Fit to view" size="sm" testId="knowledge-graph-fit" onClick={() => stageShown() && void fitView(fitOpts(reducedMotion ? 0 : ZOOM_MS))} />
          </span>
          <KnowledgeGraphLegend entries={legend} nodeStyle={options.nodeStyle} />
        </span>
      </div>
      <div className="knowledge-graph-stage" ref={stageRef}>
        {warn ? (
          <div className="knowledge-graph-message" data-testid="knowledge-graph-warn" role="group" aria-label="Show all">
            <p className="panel-note">{showAllWarning(filteredCount)}</p>
            <div className="knowledge-graph-message-actions">
              <Button size="sm" variant="primary" onClick={confirmAll} testId="knowledge-graph-warn-confirm">
                Show all
              </Button>
              <Button size="sm" onClick={keepNeighbourhood} testId="knowledge-graph-warn-keep">
                Keep the neighbourhood
              </Button>
            </div>
          </div>
        ) : empty ? (
          <div className="knowledge-graph-message" data-testid="knowledge-graph-empty">
            <p className="panel-note">{EMPTY_GRAPH_TEXT}</p>
            <div className="knowledge-graph-message-actions">
              <Button size="sm" onClick={() => changeShowAll(true)} testId="knowledge-graph-empty-all">
                Show all
              </Button>
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            data-layout={options.layout}
            onNodesChange={onNodesChange}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onInit={() => {
              window.setTimeout(() => {
                if (stageShown()) void fitView(fitOpts(0))
              }, 30)
            }}
            aria-label="Knowledge graph"
            fitView
            fitViewOptions={fitOpts(0)}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            elementsSelectable
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            zoomOnDoubleClick={false}
            deleteKeyCode={null}
          >
            <CanvasBackdrop rings={rings} />
            <CanvasMinimap ariaLabel="Knowledge graph minimap" />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}
