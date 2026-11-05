import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement, Ref } from 'react'
import { flushSync } from 'react-dom'
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import type { KnowledgeGraph as KnowledgeGraphData, KnowledgeInferredResult } from '@shared/types'
import { KNOWLEDGE_KEY_RE } from '@shared/types'
import { applyFilter, itemsOf, kindColor, kindMark, searchRank, type KnowledgeFilter } from '../../lib/knowledge'
import { useReducedMotion } from '../../lib/canvas'
import {
  RecallGate,
  buildNeuralModel,
  cardExcerpt,
  cardPlacement,
  cleanLabel,
  CARD_MAX_HEIGHT,
  CARD_WIDTH,
  computeEmphasis,
  drawnMask,
  extremeNode,
  neighbourLists,
  neighbourTarget,
  radiiOf,
  relationRows,
  safeNodeId,
  sharedNeighbourLine,
  spatialTarget,
  spokenName,
  typeAheadTarget,
  type Direction,
  type NamedSpot,
  type Spot,
  type View
} from '../../lib/knowledgeNeural'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { NeuralCard, type NeuralCardData } from './NeuralCard'
import { NeuralLegend } from './NeuralLegend'
import { NeuralEngine, type EngineHost, type Hit } from './neuralEngine'
import '../../styles/knowledge-neural.css'

/** What KnowledgeView can ask of the graph. */
export interface KnowledgeNeuralHandle {
  /** Move focus to a node's DOM element: this id, else the entry rule (last focused, selected, largest). False when no node can take it. */
  focusNode(id: string | null): boolean
}

/** The contract between KnowledgeView and the neural canvas (docs/design/knowledge-graph-2.md section 1). */
export interface KnowledgeNeuralProps {
  projectId: string
  graph: KnowledgeGraphData
  /** Null until the first answer, or when the read failed: sizes then come from live edges. */
  inferred: KnowledgeInferredResult | null
  /** The list's filter, shared: filtered-out nodes dim and never move. */
  filter: KnowledgeFilter
  /** The "Inferred links" switch: draw every kept pair's inferred link, not only the active node's. */
  showInferred: boolean
  selectedId: string | null
  /** Space on a node selects it; a click on empty space passes null. The panel stays as it is. */
  onSelect: (id: string | null) => void
  /** A click on a node: select it and open the detail panel. Focus stays on the node. */
  onOpenPanel: (id: string) => void
  /** Enter on a node: select it, open the detail panel and send focus to its heading. */
  onOpen: (id: string) => void
  /** "Show as list": switch the view and focus the selected or first row. */
  onShowList: () => void
  /** "Skip to detail": focus the detail heading, or the rail's Show button while the panel is a rail. */
  onSkipToDetail: () => void
  /** The "No items match" state's button (`knowledge-clear-filters`): clear search, kinds and origins. */
  onClearFilters: () => void
  /** Speak through the tab's one polite status region. */
  announce: (text: string) => void
  ref?: Ref<KnowledgeNeuralHandle>
}

const OPTIONS_ALL_UP_TO = 300
const OPTIONS_LARGEST = 50
const TYPE_AHEAD_MS = 500
const CARD_SHOW_MS = 60
const CARD_HIDE_MS = 120

/** The keyed wrapper: a new project starts a new canvas. */
export default function KnowledgeNeural(props: KnowledgeNeuralProps): ReactElement {
  return <NeuralInner key={props.projectId} {...props} />
}

interface OptionProps {
  id: string
  kind: string
  label: string
  radius: number
  total: number
  x: number
  y: number
  active: boolean
  dim: boolean
  selected: boolean
  retired: boolean
  fired: number
  tabbable: boolean
  register: (id: string, el: HTMLLIElement | null) => void
  onFocusOption: (id: string, visible: boolean) => void
  onBlurOption: (id: string) => void
}

const NeuralOption = memo(function NeuralOption(p: OptionProps): ReactElement {
  const safeKind = KNOWLEDGE_KEY_RE.test(p.kind) ? p.kind : undefined
  const r = p.radius
  return (
    <li
      ref={(el) => p.register(p.id, el)}
      role="option"
      data-testid="knowledge-node"
      data-id={safeNodeId(p.id)}
      data-kind={safeKind}
      data-color={safeKind ? kindColor(safeKind) : undefined}
      data-mark={safeKind ? kindMark(safeKind) : undefined}
      data-radius={r.toFixed(1)}
      data-total={p.total}
      data-x={Math.round(p.x)}
      data-y={Math.round(p.y)}
      data-active={p.active}
      data-dim={p.dim}
      data-selected={p.selected}
      data-retired={p.retired}
      data-fired={p.fired}
      aria-selected={p.selected}
      aria-disabled={p.dim || undefined}
      aria-label={p.label}
      tabIndex={p.tabbable ? 0 : -1}
      className="neural-node"
      style={{ left: p.x - r, top: p.y - r, width: r * 2, height: r * 2 }}
      onFocus={(e) => p.onFocusOption(p.id, e.currentTarget.matches(':focus-visible'))}
      onBlur={() => p.onBlurOption(p.id)}
    />
  )
})

function NeuralInner(props: KnowledgeNeuralProps): ReactElement {
  const { projectId, graph, inferred, filter, showInferred, selectedId, onSelect, onOpenPanel, onOpen, onShowList, onSkipToDetail, onClearFilters, announce } = props
  const reduced = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLCanvasElement>(null)
  const pulseRef = useRef<HTMLCanvasElement>(null)
  const nodesRef = useRef<HTMLUListElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<NeuralEngine | null>(null)
  const els = useRef(new Map<string, HTMLLIElement>())

  const [hoverId, setHoverId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [lastFocused, setLastFocused] = useState<string | null>(null)
  const [forceId, setForceId] = useState<string | null>(null)
  const [card, setCard] = useState<{ id: string; instant: boolean } | null>(null)
  const [layoutV, setLayoutV] = useState(0)
  const [arranging, setArranging] = useState(false)
  const [fired, setFired] = useState<ReadonlyMap<string, number>>(new Map())
  const [themeTick, setThemeTick] = useState(0)

  // ---- data
  const model = useMemo(() => buildNeuralModel(graph, inferred, projectId), [graph, inferred, projectId])
  const drawn = useMemo(() => drawnMask(model, filter.showRetired), [model, filter.showRetired])
  const nbrs = useMemo(() => neighbourLists(model, drawn, filter.showRetired), [model, drawn, filter.showRetired])
  const radii = useMemo(() => radiiOf(model.totals, drawn), [model, drawn])
  const drawnCount = useMemo(() => drawn.reduce((s, v) => s + v, 0), [drawn])
  const query = filter.query.trim()
  const kept = useMemo(() => {
    const out = new Uint8Array(model.nodes.length)
    const ids = new Set(applyFilter(itemsOf({ nodes: model.nodes }, []), filter).filter((i) => !query || searchRank(i, query) !== null).map((i) => i.id))
    model.nodes.forEach((n, i) => {
      out[i] = ids.has(n.id) ? 1 : 0
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, filter.kinds, filter.origins, filter.showRetired, query])
  const modelRef = useRef(model)
  modelRef.current = model
  const idx = (id: string | null): number => (id ? (model.index.get(id) ?? -1) : -1)
  const selectedIdx = idx(selectedId)
  const activeIdx = idx(hoverId ?? focusId)
  const dimToken = useMemo(() => {
    void themeTick
    const el = rootRef.current
    const v = el ? Number.parseFloat(getComputedStyle(el).getPropertyValue('--neural-dim-opacity')) : NaN
    return Number.isFinite(v) ? v : 0.22
  }, [themeTick])
  const emphasis = useMemo(
    () => computeEmphasis({ drawn, kept, nbrs, hover: activeIdx, selected: selectedIdx, searching: query !== '', dim: dimToken }),
    [drawn, kept, nbrs, activeIdx, selectedIdx, query, dimToken]
  )
  const emphasisRef = useRef(emphasis)
  emphasisRef.current = emphasis
  const filterRef = useRef(filter)
  filterRef.current = filter
  const propsRef = useRef(props)
  propsRef.current = props

  // ---- card
  const showTimer = useRef(0)
  const hideTimer = useRef(0)
  const cardIdRef = useRef<string | null>(null)
  cardIdRef.current = card?.id ?? null
  const hideCard = useCallback((ms: number): void => {
    window.clearTimeout(showTimer.current)
    window.clearTimeout(hideTimer.current)
    if (ms <= 0) setCard(null)
    else hideTimer.current = window.setTimeout(() => setCard(null), ms)
  }, [])
  const showCard = useCallback((id: string, immediate: boolean): void => {
    window.clearTimeout(hideTimer.current)
    window.clearTimeout(showTimer.current)
    if (cardIdRef.current !== null || immediate) setCard({ id, instant: cardIdRef.current !== null })
    else showTimer.current = window.setTimeout(() => setCard({ id, instant: false }), CARD_SHOW_MS)
  }, [])
  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current)
      window.clearTimeout(hideTimer.current)
    },
    []
  )
  const placeCard = useCallback((): void => {
    const el = cardRef.current
    const engine = engineRef.current
    const stage = stageRef.current
    const id = cardIdRef.current
    if (!el || !engine || !stage || !id) return
    const hit = engine.screenOf(id)
    if (!hit) return
    const box = stage.getBoundingClientRect()
    const place = cardPlacement(hit, { w: CARD_WIDTH, h: Math.min(el.offsetHeight || CARD_MAX_HEIGHT, CARD_MAX_HEIGHT) }, { w: box.width, h: box.height })
    el.style.left = `${Math.round(place.left)}px`
    el.style.top = `${Math.round(place.top)}px`
    el.style.maxHeight = `${Math.floor(Math.min(CARD_MAX_HEIGHT, place.maxHeight))}px`
    el.style.visibility = 'visible'
  }, [])
  const placeRef = useRef(placeCard)
  placeRef.current = placeCard
  useLayoutEffect(() => {
    placeCard()
  }, [card, layoutV, placeCard])

  const cardData = useMemo((): NeuralCardData | null => {
    if (!card) return null
    const i = model.index.get(card.id)
    if (i === undefined || drawn[i] !== 1) return null
    const nd = model.nodes[i]
    return {
      id: safeNodeId(nd.id),
      name: model.names[i],
      kind: KNOWLEDGE_KEY_RE.test(nd.kind) ? nd.kind : 'item',
      retired: !!nd.retired,
      excerpt: cardExcerpt(nd),
      appearance: model.appearances[i],
      rows: relationRows(model, i, drawn, filter.showRetired),
      shared: sharedNeighbourLine(model, i, drawn, filter.showRetired)
    }
  }, [card, model, drawn, filter.showRetired])

  // ---- engine
  const applyView = useCallback((v: View): void => {
    const ul = nodesRef.current
    if (ul) {
      ul.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`
      ul.style.setProperty('--k', String(v.k))
    }
  }, [])

  useEffect(() => {
    const root = rootRef.current
    const stage = stageRef.current
    const field = fieldRef.current
    const pulses = pulseRef.current
    if (!root || !stage || !field || !pulses) return
    let viewRaf = 0
    const host: EngineHost = {
      hover: (hit: Hit | null) => {
        setHoverId(hit ? hit.id : null)
        if (hit) showCard(hit.id, false)
        else hideCard(CARD_HIDE_MS)
      },
      pick: (id) => {
        propsRef.current.onOpenPanel(id)
        requestAnimationFrame(() => focusOptionRef.current(id))
      },
      blank: () => propsRef.current.onSelect(null),
      userMoved: () => hideCard(0),
      view: (v) => {
        applyView(v)
        if (!viewRaf) {
          viewRaf = requestAnimationFrame(() => {
            viewRaf = 0
            placeRef.current()
          })
        }
      },
      arranging: (on) => setArranging(on),
      layout: () => setLayoutV((n) => n + 1)
    }
    const engine = new NeuralEngine(root, stage, field, pulses, host)
    engineRef.current = engine
    const ro = new ResizeObserver(() => {
      const r = stage.getBoundingClientRect()
      engine.resize(r.width, r.height, window.devicePixelRatio || 1)
      const sel = propsRef.current.selectedId
      if (sel) engine.reveal(sel, 200)
    })
    ro.observe(stage)
    const measure = (): void => {
      const r = stage.getBoundingClientRect()
      engine.resize(r.width, r.height, window.devicePixelRatio || 1)
    }
    // A change of device pixel ratio (another monitor, app zoom) does not resize the stage in CSS px.
    window.addEventListener('resize', measure)
    measure()
    setThemeTick((n) => n + 1)
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
      mo.disconnect()
      window.cancelAnimationFrame(viewRaf)
      engine.dispose()
      engineRef.current = null
    }
  }, [applyView, hideCard, showCard])

  useEffect(() => {
    engineRef.current?.setReduced(reduced)
  }, [reduced])

  // The data: new nodes scale in and fire; the rest never moves.
  const prevIds = useRef<Set<string> | null>(null)
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.setData(model, projectId, filter.showRetired)
    const prev = prevIds.current
    prevIds.current = new Set(model.ids)
    if (prev && prev.size > 0) {
      const fresh = model.ids.filter((id) => !prev.has(id))
      if (fresh.length > 0 && fresh.length <= 50) {
        engine.fire(
          fresh.map((id) => model.index.get(id)!),
          fresh
        )
        setFired((m) => bump(m, fresh))
      }
    }
  }, [model, projectId, filter.showRetired])

  useEffect(() => {
    engineRef.current?.setEmphasis(emphasis, selectedIdx, showInferred)
  }, [emphasis, selectedIdx, showInferred, model])

  // Selection from outside (list, deep link) pans into view; any selection spreads along its synapses.
  const prevSelected = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    if (selectedId && selectedId !== prevSelected.current) {
      engine.reveal(selectedId, 300)
      if (prevSelected.current !== undefined) engine.spread(selectedIdx)
    }
    prevSelected.current = selectedId
  }, [selectedId, selectedIdx])

  // Recalls of this project's runs fire the nodes they named (newest 12, one burst per 2 s per run).
  useEffect(() => {
    const api = window.orgai
    if (!api?.onRunEvent) return
    const gate = new RecallGate()
    const timers = new Set<number>()
    const fireIds = (ids: string[]): void => {
      const m = modelRef.current
      const real = ids.filter((id) => m.index.has(id))
      if (real.length === 0) return
      engineRef.current?.fire(
        real.map((id) => m.index.get(id)!),
        real
      )
      setFired((cur) => bump(cur, real))
    }
    const off = api.onRunEvent((e) => {
      if (e.type !== 'knowledge.recalled' || !Array.isArray(e.nodeIds)) return
      const run = useAppStore.getState().runs[e.runId]
      if (run && run.summary.projectId !== projectId) return
      const ids = e.nodeIds.filter((id): id is string => typeof id === 'string').slice(-50)
      const out = gate.push(e.runId, ids, Date.now())
      if ('fire' in out) fireIds(out.fire)
      else {
        const t = window.setTimeout(() => {
          timers.delete(t)
          fireIds(gate.flush(e.runId, Date.now()))
        }, out.wait)
        timers.add(t)
      }
    })
    return () => {
      off()
      for (const t of timers) window.clearTimeout(t)
    }
  }, [projectId])

  // ---- inferred status
  const inferredShown = useMemo(() => {
    let n = 0
    for (const l of model.inferred) if (drawn[l.a] === 1 && drawn[l.b] === 1 && kept[l.a] === 1 && kept[l.b] === 1) n++
    return n
  }, [model, drawn, kept])
  const prevShow = useRef(showInferred)
  useEffect(() => {
    if (prevShow.current === showInferred) return
    prevShow.current = showInferred
    if (showInferred) announce(`Showing ${inferredShown} inferred ${inferredShown === 1 ? 'link' : 'links'}.`)
  }, [showInferred, inferredShown, announce])

  // ---- options
  const positions = useMemo(
    () => engineRef.current?.positionsFor(model) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, layoutV]
  )
  const largest = useMemo(() => {
    const spots: NamedSpot[] = []
    model.nodes.forEach((_, i) => {
      if (kept[i] === 1) spots.push({ id: model.ids[i], name: model.names[i].toLowerCase(), total: model.totals[i], order: i })
    })
    return spots
  }, [model, kept])
  const isKept = (id: string | null): id is string => {
    const i = idx(id)
    return i >= 0 && kept[i] === 1
  }
  const tabStop = isKept(lastFocused) ? lastFocused : isKept(selectedId) ? selectedId : (extremeNode(largest, 'largest') ?? null)
  const renderIdx = useMemo(() => {
    const out: number[] = []
    if (drawnCount <= OPTIONS_ALL_UP_TO) {
      for (let i = 0; i < model.nodes.length; i++) if (drawn[i] === 1) out.push(i)
      return out
    }
    const set = new Set<number>()
    const add = (i: number): void => {
      if (i >= 0 && drawn[i] === 1) set.add(i)
    }
    for (const id of [focusId, selectedId, hoverId, lastFocused, tabStop, forceId]) add(idx(id))
    if (emphasis.active >= 0) for (const j of nbrs[emphasis.active]) add(j)
    const bySize = [...model.nodes.keys()].filter((i) => drawn[i] === 1).sort((a, b) => model.totals[b] - model.totals[a] || a - b)
    for (const i of bySize.slice(0, OPTIONS_LARGEST)) add(i)
    return [...set].sort((a, b) => a - b)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, drawn, drawnCount, focusId, selectedId, hoverId, lastFocused, tabStop, forceId, emphasis.active, nbrs])
  if (drawnCount <= OPTIONS_ALL_UP_TO && forceId !== null) {
    /* every drawn node renders already */
  }
  const spokenCache = useMemo(() => new Map<number, string>(), [model, drawn, filter.showRetired])
  const spokenOf = (i: number): string => {
    let s = spokenCache.get(i)
    if (s === undefined) {
      const rows = relationRows(model, i, drawn, filter.showRetired).slice(0, 3)
      s = spokenName({ name: model.names[i], kind: model.nodes[i].kind, retired: !!model.nodes[i].retired, appearance: model.appearances[i], relations: rows.map((r) => r.text) })
      spokenCache.set(i, s)
    }
    return s
  }

  const register = useCallback((id: string, el: HTMLLIElement | null): void => {
    if (el) els.current.set(id, el)
    else els.current.delete(id)
  }, [])

  const focusOption = useCallback((id: string): boolean => {
    const m = modelRef.current
    const i = m.index.get(id)
    if (i === undefined) return false
    let el = els.current.get(id)
    if (!el) {
      flushSync(() => setForceId(id))
      el = els.current.get(id)
    }
    if (!el) return false
    el.focus({ preventScroll: true })
    return true
  }, [])
  const focusOptionRef = useRef(focusOption)
  focusOptionRef.current = focusOption

  const onFocusOption = useCallback(
    (id: string, visible: boolean): void => {
      setLastFocused(id)
      if (visible) {
        setFocusId(id)
        showCard(id, true)
        engineRef.current?.reveal(id, 200)
      } else setFocusId(null)
    },
    [showCard]
  )
  const onBlurOption = useCallback(
    (_id: string): void => {
      setFocusId(null)
      hideCard(0)
    },
    [hideCard]
  )

  useImperativeHandle(
    props.ref,
    () => ({
      focusNode(id: string | null): boolean {
        const m = modelRef.current
        const em = emphasisRef.current
        const ok = (x: string | null | undefined): x is string => {
          if (!x) return false
          const i = m.index.get(x)
          return i !== undefined && em.kept[i] === 1
        }
        let target: string | null = null
        if (ok(id)) target = id
        else {
          const spots: NamedSpot[] = []
          m.nodes.forEach((n, i) => {
            if (em.kept[i] === 1) spots.push({ id: n.id, name: '', total: m.totals[i], order: i })
          })
          target = ok(lastFocusedRef.current) ? lastFocusedRef.current : ok(propsRef.current.selectedId) ? propsRef.current.selectedId : extremeNode(spots, 'largest')
        }
        return target ? focusOptionRef.current(target) : false
      }
    }),
    []
  )
  const lastFocusedRef = useRef<string | null>(null)
  lastFocusedRef.current = lastFocused

  // ---- keyboard
  const typed = useRef({ text: '', at: 0 })
  const moveTo = (id: string | null): void => {
    if (id) focusOption(id)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const target = (e.target as HTMLElement).closest('[data-testid=knowledge-node]')
    const curId = target?.getAttribute('data-id') ?? null
    const ci = idx(curId)
    const engine = engineRef.current
    if (e.altKey || (e.metaKey && !e.key.startsWith('Arrow'))) return
    const dirs: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }
    const pos = engine?.positionsFor(model)
    if (e.key in dirs) {
      e.preventDefault()
      if (ci < 0 || !pos) return
      const from = { x: pos.x[ci], y: pos.y[ci] }
      const group = e.ctrlKey || e.metaKey ? nbrs[ci] : [...model.nodes.keys()]
      const spots: Spot[] = []
      for (const j of group) if (j !== ci && kept[j] === 1) spots.push({ id: model.ids[j], x: pos.x[j], y: pos.y[j] })
      moveTo((e.ctrlKey || e.metaKey ? neighbourTarget : spatialTarget)(from, spots, dirs[e.key]))
      return
    }
    if (e.ctrlKey || e.metaKey) return
    switch (e.key) {
      case 'Home':
        e.preventDefault()
        moveTo(extremeNode(largest, 'largest'))
        return
      case 'End':
        e.preventDefault()
        moveTo(extremeNode(largest, 'smallest'))
        return
      case ' ':
        e.preventDefault()
        if (curId) onSelect(curId)
        return
      case 'Enter':
        e.preventDefault()
        if (curId) onOpen(curId)
        return
      case '+':
      case '=':
        e.preventDefault()
        engine?.zoomBy(1.25)
        return
      case '-':
        e.preventDefault()
        engine?.zoomBy(0.8)
        return
      case '0':
        e.preventDefault()
        engine?.fitNow()
        return
      case 'Escape':
        if (card) {
          e.preventDefault()
          e.stopPropagation()
          hideCard(0)
        } else if (selectedId) {
          e.preventDefault()
          e.stopPropagation()
          onSelect(null)
        }
        return
      default:
        break
    }
    if (e.key.length === 1 && /\S/.test(e.key)) {
      const now = Date.now()
      const t = typed.current
      t.text = now - t.at > TYPE_AHEAD_MS ? e.key : t.text + e.key
      t.at = now
      moveTo(typeAheadTarget(t.text, largest))
    }
  }

  // ---- states
  const none = drawnCount > 0 && emphasis.lit === 0
  const notesOnly = filter.kinds.length > 0 && filter.kinds.every((k) => k === 'note')
  const noneText = notesOnly ? 'Notes are not drawn in the graph.' : query ? `No items match ${cleanLabel(query).slice(0, 60)}.` : 'No items match these filters.'
  const kindsInUse = useMemo(() => {
    const seen = new Set<string>()
    model.nodes.forEach((n, i) => {
      if (drawn[i] === 1) seen.add(n.kind)
    })
    return [...seen].sort()
  }, [model, drawn])

  return (
    <div ref={rootRef} className="knowledge-neural" data-testid="knowledge-neural">
      <div className="neural-skips">
        <button type="button" className="neural-skip" data-testid="knowledge-skip-list" onClick={onShowList}>
          Show as list
        </button>
        <button type="button" className="neural-skip" data-testid="knowledge-skip-detail" onClick={onSkipToDetail}>
          Skip to detail
        </button>
      </div>
      <div ref={stageRef} className="neural-stage" data-hover={hoverId !== null}>
        <canvas ref={fieldRef} className="neural-canvas" aria-hidden="true" />
        <canvas ref={pulseRef} className="neural-canvas" aria-hidden="true" />
        <ul ref={nodesRef} className="neural-nodes" role="listbox" aria-label="Knowledge graph" data-testid="knowledge-neural-nodes" onKeyDown={onKeyDown}>
          {renderIdx.map((i) => {
            const id = model.ids[i]
            return (
              <NeuralOption
                key={id}
                id={id}
                kind={model.nodes[i].kind}
                label={spokenOf(i)}
                radius={radii[i]}
                total={model.totals[i]}
                x={positions ? positions.x[i] : 0}
                y={positions ? positions.y[i] : 0}
                active={emphasis.near[i] === 1}
                dim={kept[i] !== 1}
                selected={i === selectedIdx}
                retired={!!model.nodes[i].retired}
                fired={fired.get(id) ?? 0}
                tabbable={id === tabStop}
                register={register}
                onFocusOption={onFocusOption}
                onBlurOption={onBlurOption}
              />
            )
          })}
        </ul>
        {cardData && <NeuralCard data={cardData} cardRef={cardRef} instant={card?.instant ?? false} />}
        {none && (
          <div className="neural-none" data-testid="knowledge-neural-none">
            <p>{noneText}</p>
            {notesOnly ? (
              <Button size="sm" onClick={onShowList}>
                Show as list
              </Button>
            ) : (
              <Button size="sm" testId="knowledge-clear-filters" onClick={onClearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        )}
        {arranging && (
          <p className="neural-arranging" data-testid="knowledge-neural-arranging">
            Arranging the graph…
          </p>
        )}
      </div>
      <div className="neural-controls">
        <IconButton icon={ZoomOut} label="Zoom out" testId="knowledge-neural-zoom-out" onClick={() => engineRef.current?.zoomBy(0.8)} />
        <IconButton icon={ZoomIn} label="Zoom in" testId="knowledge-neural-zoom-in" onClick={() => engineRef.current?.zoomBy(1.25)} />
        <IconButton icon={Maximize} label="Fit to view" testId="knowledge-neural-fit" onClick={() => engineRef.current?.fitNow()} />
      </div>
      <NeuralLegend kinds={kindsInUse} />
    </div>
  )
}

function bump(cur: ReadonlyMap<string, number>, ids: readonly string[]): Map<string, number> {
  const next = new Map(cur)
  for (const id of ids) next.set(id, (next.get(id) ?? 0) + 1)
  return next
}
