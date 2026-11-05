import { keyWords, kindMark } from '../../lib/knowledge'
import {
  LOD_SPECS,
  MIN_SCREEN_RADIUS,
  boundsOf,
  cutLabel,
  drawnMask,
  edgeDrawn,
  fitView,
  initLayout,
  layoutFromPositions,
  layoutKey,
  lodFor,
  neighbourLists,
  panIntoView,
  parseStoredLayout,
  pickLabels,
  placeNew,
  positionsOf,
  prng,
  radiiOf,
  seedOf,
  serializeLayout,
  stepLayout,
  zoomAt,
  type Emphasis,
  type LabelCandidate,
  type LayoutState,
  type Lod,
  type NeuralModel,
  type PlacedLabel,
  type View
} from '../../lib/knowledgeNeural'
import { mixRgb, readNeuralTheme, rgbCss, type NeuralTheme, type Rgb } from './neuralColors'

/**
 * The draw loop of the neural canvas (docs/design/knowledge-graph-2.md sections 1.3-1.6). Two stacked canvases: the
 * field (wash, synapses, nodes, names) and, above it, the pulses. Everything is drawn from typed arrays; React only
 * hears about hover, clicks and a few attributes, never about a frame. One requestAnimationFrame loop runs while
 * something moves and is cancelled when nothing does.
 */

export interface Hit {
  id: string
  /** Screen position and radius inside the stage. */
  x: number
  y: number
  r: number
}

export interface EngineHost {
  hover(hit: Hit | null): void
  pick(id: string): void
  blank(): void
  /** The user panned or zoomed: hide the card. */
  userMoved(): void
  /** Any change of the view (to move the DOM options). */
  view(v: View): void
  arranging(on: boolean): void
  /** Positions are final (or just changed): refresh the DOM options. */
  layout(): void
}

const AMBIENT_EVERY_MS = 1400
const FIRE_MS = 900
const FIRE_STATIC_MS = 2000
const SPREAD_MS = 450
const NEW_MS = 400
const RADIUS_EASE_MS = 300
const GHOST_MS = 200
const DRIFT_PX = 2.5
const LABEL_DEBOUNCE_MS = 150
const GRID = 80
const FONT_SIZE = 12

interface Pulse {
  edge: number
  /** True when it runs from edge.a to edge.b. */
  forward: boolean
  t0: number
  dur: number
  kind: 'ambient' | 'fire' | 'spread'
  /** Spread pulses: the node that flashes and sends one pulse on when this one arrives. */
  chain: boolean
}
interface Ring {
  idx: number
  t0: number
  dur: number
  kind: 'fire' | 'flash'
}
interface Ghost {
  x: number
  y: number
  r: number
  rgb: Rgb
  t0: number
}

const easeOut = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3
const easeInOut = (t: number): number => {
  const c = Math.min(1, Math.max(0, t))
  return c < 0.5 ? 2 * c * c : 1 - (-2 * c + 2) ** 2 / 2
}

export class NeuralEngine {
  private readonly ctxA: CanvasRenderingContext2D
  private readonly ctxB: CanvasRenderingContext2D
  private w = 0
  private h = 0
  private dpr = 1
  private theme: NeuralTheme
  private reduced = false
  private visible = true
  private focused = true
  private disposed = false

  private projectId = ''
  private model: NeuralModel | null = null
  private n = 0
  private drawn: Uint8Array = new Uint8Array(0)
  private showRetired = false
  private nbrs: number[][] = []
  private totalsMax = 0
  private lod: Lod = 'full'
  private emphasis: Emphasis | null = null
  private showInferred = false
  private selected = -1

  // layout
  private lay: LayoutState | null = null
  private px = new Float64Array(0)
  private py = new Float64Array(0)
  private rad = new Float64Array(0)
  private radT = new Float64Array(0)
  private radFrom = new Float64Array(0)
  private radT0 = 0
  private born = new Float64Array(0)
  private phase = new Float64Array(0)
  private topSize = new Uint8Array(0)
  private edgeList: number[] = []
  private settledOnce = false
  private layoutWatch = 0
  private arrangeTimer = 0
  private arrangeShown = false
  private slice = 0

  // view
  private v: View = { x: 0, y: 0, k: 1 }
  private autoFit = true
  private anim: { from: View; to: View; t0: number; dur: number } | null = null

  // screen cache
  private sx = new Float32Array(0)
  private sy = new Float32Array(0)
  private sr = new Float32Array(0)
  private gridCells = new Map<number, number[]>()
  private labels: PlacedLabel[] = []
  private labelsDirty = true
  private labelTimer = 0
  private measureCache = new Map<string, number>()

  // effects
  private pulses: Pulse[] = []
  private rings: Ring[] = []
  private ghosts: Ghost[] = []
  private lastAmbient = 0
  private rnd = prng(1)
  private fireRng = prng(2)
  private spreadBudget = 0
  private staticFireTimer = 0

  // loop
  private raf = 0
  private inFrame = false
  private animating = false
  private frames = 0
  private lastDraw = 0
  private dirtyA = true
  private dirtyB = true
  private inputDirty = false
  private hoverIdx = -1
  private pointer: { x: number; y: number } | null = null
  private drag: { id: number; x: number; y: number; vx: number; vy: number; moved: boolean } | null = null
  private inferredDrawn = 0
  private firedCount = 0
  private firedIds: string[] = []
  private attrCache = new Map<string, string>()
  private disposers: (() => void)[] = []
  private fieldGrad: { key: string; g: CanvasGradient } | null = null
  private sprites = new Map<string, HTMLCanvasElement>()

  constructor(
    private readonly root: HTMLElement,
    private readonly stage: HTMLElement,
    field: HTMLCanvasElement,
    pulses: HTMLCanvasElement,
    private readonly host: EngineHost
  ) {
    const a = field.getContext('2d')
    const b = pulses.getContext('2d')
    if (!a || !b) throw new Error('canvas unavailable')
    this.ctxA = a
    this.ctxB = b
    this.cvA = field
    this.cvB = pulses
    this.theme = readNeuralTheme(root)
    this.reduced = false
    document.addEventListener('visibilitychange', this.onVisible)
    window.addEventListener('focus', this.onFocus)
    window.addEventListener('blur', this.onFocus)
    this.visible = document.visibilityState !== 'hidden'
    this.focused = document.hasFocus()
    this.disposers.push(
      () => document.removeEventListener('visibilitychange', this.onVisible),
      () => window.removeEventListener('focus', this.onFocus),
      () => window.removeEventListener('blur', this.onFocus)
    )
    // Pointer and wheel on the stage.
    const down = (e: PointerEvent): void => this.pointerDown(e)
    const move = (e: PointerEvent): void => this.pointerMove(e)
    const up = (e: PointerEvent): void => this.pointerUp(e)
    const leave = (): void => {
      this.pointer = null
      if (!this.drag && this.hoverIdx >= 0) this.setHover(-1)
    }
    const wheel = (e: WheelEvent): void => this.wheel(e)
    stage.addEventListener('pointerdown', down)
    stage.addEventListener('pointermove', move)
    stage.addEventListener('pointerup', up)
    stage.addEventListener('pointercancel', up)
    stage.addEventListener('pointerleave', leave)
    stage.addEventListener('wheel', wheel, { passive: false })
    this.disposers.push(
      () => stage.removeEventListener('pointerdown', down),
      () => stage.removeEventListener('pointermove', move),
      () => stage.removeEventListener('pointerup', up),
      () => stage.removeEventListener('pointercancel', up),
      () => stage.removeEventListener('pointerleave', leave),
      () => stage.removeEventListener('wheel', wheel)
    )
    // Theme: read again on a data-theme change (also the system theme through the cascade).
    const mo = new MutationObserver(() => this.refreshTheme())
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = (): void => this.refreshTheme()
    mq.addEventListener('change', onScheme)
    const fc = window.matchMedia('(forced-colors: active)')
    fc.addEventListener('change', onScheme)
    this.disposers.push(() => mo.disconnect(), () => mq.removeEventListener('change', onScheme), () => fc.removeEventListener('change', onScheme))
  }

  private readonly cvA: HTMLCanvasElement
  private readonly cvB: HTMLCanvasElement

  // ------------------------------------------------------------ public

  dispose(): void {
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    window.clearTimeout(this.layoutWatch)
    window.clearTimeout(this.labelTimer)
    window.clearTimeout(this.arrangeTimer)
    window.clearTimeout(this.staticFireTimer)
    for (const d of this.disposers) d()
    this.disposers = []
  }

  setReduced(on: boolean): void {
    if (this.reduced === on) return
    this.reduced = on
    if (on) {
      this.pulses = []
      this.rings = this.rings.filter((r) => r.kind === 'fire')
      this.ghosts = []
      this.anim = null
      this.rad.set(this.radT)
      this.born.fill(0)
      // Turned on mid-settle: the frame loop no longer steps the layout, so the off-screen slicer takes over.
      if (this.lay && !this.lay.settled) this.startArranging()
    }
    this.dirtyA = true
    this.dirtyB = true
    this.kick()
  }

  resize(w: number, h: number, dpr: number): void {
    const sameDpr = dpr === this.dpr
    if (w === this.w && h === this.h && sameDpr) return
    this.w = Math.max(0, Math.round(w))
    this.h = Math.max(0, Math.round(h))
    this.dpr = dpr
    for (const cv of [this.cvA, this.cvB]) {
      cv.width = Math.max(1, Math.round(this.w * dpr))
      cv.height = Math.max(1, Math.round(this.h * dpr))
    }
    this.fieldGrad = null
    if (this.autoFit && this.n > 0 && this.w > 0) {
      this.fit(false)
      if (this.settledOnce) this.autoFit = false
    }
    this.labelsDirty = true
    this.dirtyA = true
    this.dirtyB = true
    this.kick()
    this.writeAttrs()
  }

  /** The graph arrived or changed: positions of known nodes never move; new ones are placed with the rest pinned. */
  setData(model: NeuralModel, projectId: string, showRetired: boolean): void {
    const first = this.model === null
    const prevModel = this.model
    const prevPos = this.currentPositions()
    const prevKinds = new Map<string, string>()
    if (prevModel) prevModel.nodes.forEach((nd) => prevKinds.set(nd.id, nd.kind))
    const wasUnsettled = !!this.lay && !this.lay.settled
    // Pulses and rings point at edge and node indexes of the old model: pulses end here, rings follow their node.
    this.pulses = []
    if (prevModel && this.rings.length > 0) {
      this.rings = this.rings.flatMap((r) => {
        const at = model.index.get(prevModel.ids[r.idx])
        return at === undefined ? [] : [{ ...r, idx: at }]
      })
    } else this.rings = []
    this.projectId = projectId
    this.model = model
    this.showRetired = showRetired
    const n = model.nodes.length
    // Ghosts: removed nodes fade out where they were.
    if (prevModel && !this.reduced) {
      const now = performance.now()
      for (const [id, p] of prevPos) {
        if (model.index.has(id)) continue
        const kind = prevKinds.get(id) ?? 'person'
        this.ghosts.push({ x: p.x, y: p.y, r: this.radOf(id, prevModel), rgb: this.theme.node(kind), t0: now })
      }
    }
    this.n = n
    this.drawn = drawnMask(model, showRetired)
    this.nbrs = neighbourLists(model, this.drawn, showRetired)
    this.rnd = prng(seedOf(`${projectId}:ambient`))
    this.fireRng = prng(seedOf(`${projectId}:fire`))
    // radii
    const oldRad = new Map<string, number>()
    if (prevModel) prevModel.ids.forEach((id, i) => oldRad.set(id, this.rad[i]))
    const radT = radiiOf(model.totals, this.drawn)
    this.radT = Float64Array.from(radT)
    this.rad = Float64Array.from(radT.map((r, i) => oldRad.get(model.ids[i]) ?? r))
    this.radFrom = Float64Array.from(this.rad)
    this.radT0 = performance.now()
    if (this.reduced) this.rad.set(this.radT)
    this.totalsMax = 0
    for (let i = 0; i < n; i++) if (this.drawn[i] === 1 && model.totals[i] > this.totalsMax) this.totalsMax = model.totals[i]
    const drawnCount = this.drawn.reduce((s, v) => s + v, 0)
    this.lod = lodFor(drawnCount)
    // layout
    const links = model.edges.map((e) => [model.ids[e.a], model.ids[e.b]] as const)
    const known = new Map<string, { x: number; y: number }>()
    for (const id of model.ids) {
      const p = prevPos.get(id)
      if (p) known.set(id, p)
    }
    if (first || known.size === 0 || wasUnsettled) {
      const stored = first || known.size === 0 ? parseStoredLayout(this.readStored()) : new Map<string, { x: number; y: number }>()
      for (const id of model.ids) {
        const p = stored.get(id)
        if (p && !known.has(id)) known.set(id, p)
      }
    }
    this.born = new Float64Array(n)
    const needInit = known.size === 0 || wasUnsettled
    if (needInit) {
      this.lay = initLayout({ ids: model.ids, links, radii: radT, seed: projectId })
      this.settledOnce = false
      this.autoFit = this.autoFit || first
    } else {
      const ids = model.ids.filter((id) => known.has(id))
      const base = layoutFromPositions({ ids, links, radii: ids.map((id) => radT[model.index.get(id)!]), seed: projectId }, known)
      const fresh = model.ids.filter((id) => !known.has(id))
      this.lay =
        fresh.length > 0
          ? placeNew(
              base,
              fresh.map((id) => ({ id, r: radT[model.index.get(id)!] })),
              links,
              projectId
            )
          : base
      if (fresh.length > 0) {
        const now = performance.now()
        for (const id of fresh) this.born[model.index.get(id)!] = this.reduced ? 0 : now
      }
    }
    this.syncPositions()
    if (this.lay.settled && !first && !needInit && this.px.length === this.n && model.ids.some((id) => !known.has(id))) this.writeStored()
    this.buildEdges()
    this.buildDrift()
    this.buildGrid()
    this.labelsDirty = true
    this.dirtyA = true
    this.dirtyB = true
    if (!this.lay!.settled) this.startArranging()
    else {
      this.settledOnce = true
      this.finishArranging()
    }
    if (this.autoFit && this.w > 0 && this.settledOnce) {
      this.fit(false)
      this.autoFit = false
    }
    this.writeAttrs()
    this.host.layout()
    this.kick()
  }

  setEmphasis(e: Emphasis, selected: number, showInferred: boolean): void {
    this.emphasis = e
    this.selected = selected
    this.showInferred = showInferred
    this.labelsDirty = true
    this.dirtyA = true
    this.writeAttrs()
    this.kick()
  }

  /** Scale a node in, flash it and send pulses along its synapses (new nodes, `knowledge.recalled`). */
  fire(idx: number[], ids: string[]): void {
    const now = performance.now()
    for (const i of idx) {
      if (i < 0 || i >= this.n || this.drawn[i] !== 1) continue
      this.rings.push({ idx: i, t0: now, dur: this.reduced ? FIRE_STATIC_MS : FIRE_MS, kind: 'fire' })
      if (!this.reduced) {
        let sent = 0
        for (const ei of this.edgeList) {
          const e = this.model!.edges[ei]
          if (e.a !== i && e.b !== i) continue
          this.pulses.push({ edge: ei, forward: e.a === i, t0: now + sent * 90, dur: 700, kind: 'fire', chain: false })
          if (++sent >= 3) break
        }
      }
    }
    this.firedCount += idx.length
    this.firedIds = [...this.firedIds, ...ids].slice(-12)
    if (this.reduced) {
      window.clearTimeout(this.staticFireTimer)
      this.staticFireTimer = window.setTimeout(() => {
        this.rings = this.rings.filter((r) => performance.now() - r.t0 < r.dur)
        this.dirtyB = true
        this.kick()
      }, FIRE_STATIC_MS + 30)
    }
    this.dirtyB = true
    this.writeAttrs()
    this.kick()
  }

  /** Activation spread from a selected node along up to 12 of its recorded synapses. */
  spread(idx: number): void {
    if (this.reduced || !this.model || idx < 0 || this.drawn[idx] !== 1) return
    const now = performance.now()
    const mine = this.edgeList.filter((ei) => {
      const e = this.model!.edges[ei]
      return e.a === idx || e.b === idx
    })
    mine.sort((p, q) => this.otherTotal(q, idx) - this.otherTotal(p, idx))
    this.spreadBudget = 12
    for (const ei of mine.slice(0, 12)) {
      const e = this.model.edges[ei]
      this.pulses.push({ edge: ei, forward: e.a === idx, t0: now, dur: SPREAD_MS, kind: 'spread', chain: true })
    }
    this.dirtyB = true
    this.kick()
  }

  fit(animate: boolean): void {
    if (!this.model || this.n === 0 || this.w <= 0) return
    const pts: { x: number; y: number; r: number }[] = []
    for (let i = 0; i < this.n; i++) if (this.drawn[i] === 1) pts.push({ x: this.px[i], y: this.py[i], r: this.rad[i] + 4 })
    const target = fitView(boundsOf(pts), { w: this.w, h: this.h })
    this.moveTo(target, animate)
  }

  /** The Fit to view button: animated, and the view is the user's from here on. */
  fitNow(): void {
    this.autoFit = false
    this.host.userMoved()
    this.fit(true)
  }

  zoomBy(factor: number): void {
    this.autoFit = false
    this.host.userMoved()
    const target = zoomAt(this.v, this.v.k * factor, this.w / 2, this.h / 2)
    this.moveTo(target, true)
  }

  /** Bring a node within 48 px of the inside of the stage with the smallest pan. */
  /** The stage's corner moved in the window by minus (dx, dy): move the view the same way, so nodes hold still on screen. */
  offsetView(dx: number, dy: number): void {
    this.anim = null
    this.setView({ x: this.v.x + dx, y: this.v.y + dy, k: this.v.k })
  }

  reveal(id: string, ms: number): void {
    if (!this.model) return
    const i = this.model.index.get(id)
    if (i === undefined || this.drawn[i] !== 1 || this.w <= 0) return
    const to = panIntoView(this.anim ? this.anim.to : this.v, { x: this.px[i], y: this.py[i], r: this.rad[i] }, { w: this.w, h: this.h })
    if (to !== this.v && (to.x !== this.v.x || to.y !== this.v.y)) {
      this.autoFit = false
      this.moveTo(to, ms > 0, ms)
    }
  }

  getView(): View {
    return this.v
  }

  /** Screen position (stage coordinates) and radius of a node, for the card and the focus ring. */
  screenOf(id: string): Hit | null {
    if (!this.model) return null
    const i = this.model.index.get(id)
    if (i === undefined || this.drawn[i] !== 1) return null
    return { id, x: this.px[i] * this.v.k + this.v.x, y: this.py[i] * this.v.k + this.v.y, r: Math.max(this.rad[i] * this.v.k, MIN_SCREEN_RADIUS) }
  }

  /** World positions in model order, only for the model the engine holds. */
  positionsFor(model: NeuralModel): { x: Float64Array; y: Float64Array } | null {
    return this.model === model ? { x: this.px, y: this.py } : null
  }

  radiusTarget(i: number): number {
    return this.radT[i] ?? 0
  }

  isSettled(): boolean {
    return !!this.lay && this.lay.settled
  }

  // ------------------------------------------------------------ theme and focus

  private refreshTheme(): void {
    if (this.disposed) return
    this.theme = readNeuralTheme(this.root)
    this.sprites.clear()
    this.fieldGrad = null
    this.dirtyA = true
    this.dirtyB = true
    this.kick()
  }

  private readonly onVisible = (): void => {
    this.visible = document.visibilityState !== 'hidden'
    this.focused = document.hasFocus()
    this.dirtyA = true
    this.kick()
    this.writeAttrs()
  }

  private readonly onFocus = (): void => {
    this.focused = document.hasFocus()
    this.dirtyA = true
    this.kick()
  }

  // ------------------------------------------------------------ data helpers

  private readStored(): string | null {
    try {
      return window.localStorage.getItem(layoutKey(this.projectId))
    } catch {
      return null
    }
  }

  private writeStored(): void {
    if (!this.lay || !this.model) return
    try {
      window.localStorage.setItem(layoutKey(this.projectId), serializeLayout(this.currentPositions()))
    } catch {
      /* storage full or blocked: the layout is just recomputed next time */
    }
  }

  private currentPositions(): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>()
    if (!this.model) return out
    for (let i = 0; i < this.model.ids.length && i < this.px.length; i++) out.set(this.model.ids[i], { x: this.px[i], y: this.py[i] })
    return out
  }

  private radOf(id: string, model: NeuralModel): number {
    const i = model.index.get(id)
    return i === undefined ? 8 : (this.rad[i] ?? 8)
  }

  private otherTotal(ei: number, node: number): number {
    const e = this.model!.edges[ei]
    return this.model!.totals[e.a === node ? e.b : e.a]
  }

  /** Copies the layout's positions (in the layout's own order) into the model-ordered arrays. */
  private syncPositions(): void {
    const model = this.model
    const lay = this.lay
    if (!model || !lay) return
    if (this.px.length !== this.n) {
      this.px = new Float64Array(this.n)
      this.py = new Float64Array(this.n)
    }
    if (lay.ids === model.ids || (lay.ids.length === model.ids.length && lay.ids.every((id, i) => id === model.ids[i]))) {
      this.px.set(lay.x)
      this.py.set(lay.y)
    } else {
      const at = new Map<string, number>()
      lay.ids.forEach((id, i) => at.set(id, i))
      for (let i = 0; i < this.n; i++) {
        const j = at.get(model.ids[i])
        if (j !== undefined) {
          this.px[i] = lay.x[j]
          this.py[i] = lay.y[j]
        }
      }
    }
  }

  private buildEdges(): void {
    const model = this.model!
    this.edgeList = []
    model.edges.forEach((e, i) => {
      if (edgeDrawn(e, this.drawn, this.showRetired)) this.edgeList.push(i)
    })
  }

  private buildDrift(): void {
    const model = this.model!
    this.phase = new Float64Array(this.n * 4)
    for (let i = 0; i < this.n; i++) {
      const s = seedOf(`${this.projectId}:${model.ids[i]}`)
      const r = prng(s)
      this.phase[i * 4] = r() * Math.PI * 2
      this.phase[i * 4 + 1] = r() * Math.PI * 2
      this.phase[i * 4 + 2] = 11000 + r() * 8000
      this.phase[i * 4 + 3] = 11000 + r() * 8000
    }
    const order = [...Array(this.n).keys()].filter((i) => this.drawn[i] === 1).sort((a, b) => model.totals[b] - model.totals[a] || a - b)
    this.topSize = new Uint8Array(this.n)
    const top = Math.max(LOD_SPECS.medium.halos, LOD_SPECS.medium.drift)
    for (const i of order.slice(0, top)) this.topSize[i] = 1
  }

  private buildGrid(): void {
    this.gridCells = new Map()
    for (let i = 0; i < this.n; i++) {
      if (this.drawn[i] !== 1) continue
      const key = this.cellKey(Math.floor(this.px[i] / GRID), Math.floor(this.py[i] / GRID))
      const list = this.gridCells.get(key)
      if (list) list.push(i)
      else this.gridCells.set(key, [i])
    }
  }

  private cellKey(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768)
  }

  // ------------------------------------------------------------ layout stepping

  private startArranging(): void {
    this.arrangeShown = false
    window.clearTimeout(this.arrangeTimer)
    if (this.reduced) {
      this.arrangeTimer = window.setTimeout(() => {
        if (this.lay && !this.lay.settled) {
          this.arrangeShown = true
          this.host.arranging(true)
        }
      }, 200)
      this.sliceOffscreen()
    }
    this.kick()
  }

  /** Reduced motion: compute in slices off-screen with timers, never with animation frames. */
  private sliceOffscreen(): void {
    window.clearTimeout(this.layoutWatch)
    this.layoutWatch = window.setTimeout(() => {
      if (this.disposed || !this.lay) return
      stepLayout(this.lay, 8)
      if (this.lay.settled) {
        this.afterSettle()
      } else this.sliceOffscreen()
    }, 0)
  }

  private afterSettle(): void {
    this.syncPositions()
    this.buildGrid()
    this.settledOnce = true
    this.writeStored()
    this.finishArranging()
    if (this.autoFit && this.w > 0) this.fit(false)
    this.autoFit = false
    this.labelsDirty = true
    this.dirtyA = true
    this.writeAttrs()
    this.host.layout()
    this.kick()
  }

  private finishArranging(): void {
    window.clearTimeout(this.arrangeTimer)
    if (this.arrangeShown) this.host.arranging(false)
    this.arrangeShown = false
  }

  // ------------------------------------------------------------ view

  private setView(v: View): void {
    this.v = v
    this.host.view(v)
    this.dirtyA = true
    this.inputDirty = true
    this.scheduleLabels()
    this.kick()
  }

  private moveTo(target: View, animate: boolean, ms = 300): void {
    if (!animate || this.reduced) {
      this.anim = null
      this.setView(target)
      return
    }
    this.anim = { from: this.v, to: target, t0: performance.now(), dur: ms }
    this.kick()
  }

  private scheduleLabels(): void {
    window.clearTimeout(this.labelTimer)
    this.labelTimer = window.setTimeout(() => {
      this.labelsDirty = true
      this.dirtyA = true
      this.kick()
    }, LABEL_DEBOUNCE_MS)
  }

  // ------------------------------------------------------------ pointer

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.stage.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !e.isPrimary) return
    // Buttons laid over the stage (Clear filters, Show as list) keep their own clicks.
    if (e.target instanceof Element && e.target.closest('button, a, input, [role=button]')) return
    const p = this.local(e)
    this.drag = { id: e.pointerId, x: p.x, y: p.y, vx: this.v.x, vy: this.v.y, moved: false }
    try {
      this.stage.setPointerCapture(e.pointerId)
    } catch {
      /* not capturable */
    }
  }

  private pointerMove(e: PointerEvent): void {
    const p = this.local(e)
    this.pointer = p
    const d = this.drag
    if (d && d.id === e.pointerId) {
      const dx = p.x - d.x
      const dy = p.y - d.y
      if (!d.moved && Math.hypot(dx, dy) >= 4) {
        d.moved = true
        this.autoFit = false
        this.anim = null
        this.host.userMoved()
        if (this.hoverIdx >= 0) this.setHover(-1)
      }
      if (d.moved) this.setView({ k: this.v.k, x: d.vx + dx, y: d.vy + dy })
      return
    }
    this.updateHover(p)
  }

  private pointerUp(e: PointerEvent): void {
    const d = this.drag
    if (!d || d.id !== e.pointerId) return
    this.drag = null
    try {
      this.stage.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (e.type === 'pointercancel' || d.moved) return
    const p = this.local(e)
    const i = this.hitTest(p.x, p.y)
    if (i >= 0 && this.model) this.host.pick(this.model.ids[i])
    else this.host.blank()
  }

  private wheel(e: WheelEvent): void {
    if (this.w <= 0 || !this.model) return
    e.preventDefault()
    const p = this.local(e)
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    const factor = Math.exp(-e.deltaY * unit * 0.0015)
    this.autoFit = false
    this.anim = null
    this.host.userMoved()
    if (this.hoverIdx >= 0) this.setHover(-1)
    this.setView(zoomAt(this.v, this.v.k * factor, p.x, p.y))
  }

  private setHover(i: number): void {
    this.hoverIdx = i
    if (i < 0 || !this.model) {
      this.host.hover(null)
      return
    }
    const hit = this.screenOf(this.model.ids[i])
    this.host.hover(hit)
  }

  private updateHover(p: { x: number; y: number }): void {
    if (!this.model) return
    // The current node holds until the pointer is over r + 6 px away and on another node.
    if (this.hoverIdx >= 0) {
      const cur = this.screenOf(this.model.ids[this.hoverIdx])
      if (cur && Math.hypot(p.x - cur.x, p.y - cur.y) <= cur.r + 6) {
        const next = this.hitTest(p.x, p.y)
        if (next < 0 || next === this.hoverIdx) return
      }
    }
    const i = this.hitTest(p.x, p.y)
    if (i !== this.hoverIdx) this.setHover(i)
  }

  /** The kept, drawn node under a screen point (hit radius max(r, 8) px), nearest centre first; -1 for none. */
  hitTest(sx: number, sy: number): number {
    const em = this.emphasis
    const k = this.v.k
    const wx = (sx - this.v.x) / k
    const wy = (sy - this.v.y) / k
    const reach = Math.max(34, 8 / k) + 2
    const x0 = Math.floor((wx - reach) / GRID)
    const x1 = Math.floor((wx + reach) / GRID)
    const y0 = Math.floor((wy - reach) / GRID)
    const y1 = Math.floor((wy + reach) / GRID)
    let best = -1
    let bestScore = Infinity
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.gridCells.get(this.cellKey(cx, cy))
        if (!list) continue
        for (const i of list) {
          if (em && em.kept[i] !== 1) continue
          const dx = (this.px[i] - wx) * k
          const dy = (this.py[i] - wy) * k
          const d = Math.hypot(dx, dy)
          const hit = Math.max(this.rad[i] * k, 8)
          if (d > hit) continue
          const score = d / hit
          if (score < bestScore) {
            bestScore = score
            best = i
          }
        }
      }
    }
    return best
  }

  // ------------------------------------------------------------ loop

  private tierSpec() {
    return LOD_SPECS[this.lod]
  }

  /** Drift and ambient pulses run only in a visible, focused window without reduced motion. */
  private ambientOn(): boolean {
    return !this.reduced && this.visible && this.focused && this.w > 0 && this.h > 0 && this.n > 0
  }

  private busy(): boolean {
    if (this.w <= 0 || this.h <= 0 || !this.visible || this.n === 0) return false
    if (this.reduced) return false
    return (
      !!this.anim ||
      (!!this.lay && !this.lay.settled) ||
      this.pulses.length > 0 ||
      this.rings.length > 0 ||
      this.ghosts.length > 0 ||
      this.easing() ||
      (this.ambientOn() && (this.tierSpec().drift > 0 || (this.tierSpec().ambient > 0 && this.edgeList.length > 0)))
    )
  }

  private easing(): boolean {
    const now = performance.now()
    if (now - this.radT0 < RADIUS_EASE_MS + 40) return true
    for (let i = 0; i < this.born.length; i++) if (this.born[i] > 0 && now - this.born[i] < NEW_MS + 40) return true
    return false
  }

  /** Ask for a frame (once) when something needs drawing. */
  kick(): void {
    if (this.disposed || this.raf || this.inFrame) return
    if (this.w <= 0 || this.h <= 0 || !this.visible) {
      this.setAnimating(false)
      return
    }
    if (!this.dirtyA && !this.dirtyB && !this.busy()) {
      this.setAnimating(false)
      return
    }
    // Reduced motion: nothing is drawn until the layout has settled off-screen.
    if (this.reduced && this.lay && !this.lay.settled) return
    this.raf = requestAnimationFrame((ts) => this.frame(ts))
  }

  private setAnimating(on: boolean): void {
    if (this.animating === on) return
    this.animating = on
    this.writeAttrs()
  }

  private frame(ts: number): void {
    this.raf = 0
    if (this.disposed) return
    const continuous = this.busy()
    // Frame cap for continuous animation; input-driven draws are not capped.
    const interval = 1000 / this.tierSpec().fps
    if (continuous && !this.inputDirty && ts - this.lastDraw < interval - 2 && !this.dirtyA) {
      this.raf = requestAnimationFrame((t) => this.frame(t))
      return
    }
    this.lastDraw = ts
    this.inputDirty = false
    this.inFrame = true
    const now = performance.now()
    try {
      this.frameBody(now)
    } finally {
      // A draw that throws must not leave kick() refusing every later frame.
      this.inFrame = false
    }
    if (this.frames % 10 === 0) this.writeAttrs()
    if (this.busy()) {
      this.setAnimating(true)
      this.raf = requestAnimationFrame((t) => this.frame(t))
    } else {
      this.setAnimating(false)
      this.writeAttrs()
    }
  }

  private frameBody(now: number): void {
    // layout slice
    if (this.lay && !this.lay.settled && !this.reduced) {
      stepLayout(this.lay, 8)
      this.syncPositions()
      this.dirtyA = true
      if (this.autoFit && this.w > 0) this.fit(false)
      if (this.lay.settled) {
        this.buildGrid()
        this.settledOnce = true
        this.writeStored()
        if (this.autoFit && this.w > 0) this.fit(false)
        this.autoFit = false
        this.labelsDirty = true
        this.writeAttrs()
        this.host.layout()
      }
    }
    // view animation
    if (this.anim) {
      const t = (now - this.anim.t0) / this.anim.dur
      const e = easeInOut(t)
      const { from, to } = this.anim
      this.v = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e }
      this.host.view(this.v)
      this.dirtyA = true
      if (t >= 1) {
        this.v = to
        this.host.view(to)
        this.anim = null
        this.scheduleLabels()
      }
    }
    // radii easing
    if (now - this.radT0 < RADIUS_EASE_MS + 40) {
      const e = easeOut((now - this.radT0) / RADIUS_EASE_MS)
      for (let i = 0; i < this.n; i++) this.rad[i] = this.radFrom[i] + (this.radT[i] - this.radFrom[i]) * e
      this.dirtyA = true
    }
    // ambient pulses
    if (this.ambientOn() && this.tierSpec().ambient > 0 && this.edgeList.length > 0 && now - this.lastAmbient >= AMBIENT_EVERY_MS) {
      this.lastAmbient = now
      this.spawnAmbient(now)
    }
    // drift needs the field redrawn
    const driftOn = this.ambientOn() && this.tierSpec().drift > 0
    if (driftOn) this.dirtyA = true
    if (this.ghosts.length || this.easingBorn(now)) this.dirtyA = true
    if (this.dirtyA) {
      this.updateScreen(now, driftOn)
      this.drawField(now)
      this.dirtyA = false
      this.dirtyB = true
    } else if (this.pulses.length || this.rings.length) {
      this.updateScreen(now, driftOn)
    }
    if (this.dirtyB || this.pulses.length || this.rings.length) {
      this.drawPulses(now)
      this.dirtyB = false
    }
    this.frames++
  }

  private easingBorn(now: number): boolean {
    for (let i = 0; i < this.born.length; i++) if (this.born[i] > 0 && now - this.born[i] < NEW_MS + 40) return true
    return false
  }

  // ------------------------------------------------------------ attributes

  /** Writes the root's data-* (changes only). */
  writeAttrs(): void {
    const em = this.emphasis
    const set = (k: string, v: string): void => {
      if (this.attrCache.get(k) === v) return
      this.attrCache.set(k, v)
      this.root.setAttribute(k, v)
    }
    set('data-drawn', String(this.drawn.reduce((s, v) => s + v, 0)))
    set('data-edges', String(this.edgeList.length))
    set('data-lit', String(em ? em.lit : this.drawn.reduce((s, v) => s + v, 0)))
    set('data-lod', this.lod)
    set('data-settled', String(!!this.lay && this.lay.settled))
    set('data-animating', String(this.animating))
    set('data-frames', String(this.frames))
    set('data-fired', String(this.firedCount))
    set('data-fired-ids', this.firedIds.join(','))
    set('data-inferred', String(this.inferredDrawn))
    set('data-zoom', this.v.k.toFixed(2))
  }

  // ------------------------------------------------------------ screen cache and drawing

  private updateScreen(now: number, driftOn: boolean): void {
    const n = this.n
    if (this.sx.length !== n) {
      this.sx = new Float32Array(n)
      this.sy = new Float32Array(n)
      this.sr = new Float32Array(n)
    }
    const { x, y, k } = this.v
    const spec = this.tierSpec()
    for (let i = 0; i < n; i++) {
      let ox = 0
      let oy = 0
      if (driftOn && this.drawn[i] === 1 && (spec.drift === Infinity || this.topSize[i] === 1)) {
        ox = DRIFT_PX * Math.sin((now / this.phase[i * 4 + 2]) * Math.PI * 2 + this.phase[i * 4])
        oy = DRIFT_PX * Math.sin((now / this.phase[i * 4 + 3]) * Math.PI * 2 + this.phase[i * 4 + 1])
      }
      this.sx[i] = this.px[i] * k + x + ox
      this.sy[i] = this.py[i] * k + y + oy
      let scale = 1
      const b = this.born[i]
      if (b > 0) scale = easeOut((now - b) / NEW_MS)
      this.sr[i] = Math.max(this.rad[i] * k * scale, MIN_SCREEN_RADIUS * scale)
    }
  }

  private onScreen(i: number, pad = 0): boolean {
    return this.sx[i] > -pad && this.sx[i] < this.w + pad && this.sy[i] > -pad && this.sy[i] < this.h + pad
  }

  private sprite(c: Rgb, light: boolean): HTMLCanvasElement {
    const key = `${c.r},${c.g},${c.b},${light ? 1 : 0}`
    let s = this.sprites.get(key)
    if (s) return s
    s = document.createElement('canvas')
    s.width = 96
    s.height = 96
    const g = s.getContext('2d')!
    const grad = g.createRadialGradient(48, 48, 0, 48, 48, 48)
    grad.addColorStop(0, rgbCss(c, 1))
    grad.addColorStop(light ? 0.5 : 0.35, rgbCss(c, light ? 0.55 : 0.5))
    grad.addColorStop(1, rgbCss(c, 0))
    g.fillStyle = grad
    g.fillRect(0, 0, 96, 96)
    this.sprites.set(key, s)
    return s
  }

  private measure(text: string): number {
    let w = this.measureCache.get(text)
    if (w === undefined) {
      this.ctxA.font = `${FONT_SIZE}px ${this.theme.font}`
      w = this.ctxA.measureText(text).width
      if (this.measureCache.size > 5000) this.measureCache.clear()
      this.measureCache.set(text, w)
    }
    return w
  }

  private activeEdgeIndexes(): { active: number[]; count: number } {
    const em = this.emphasis
    const out: number[] = []
    if (!em || em.active < 0 || !this.model) return { active: out, count: 0 }
    for (const ei of this.edgeList) {
      const e = this.model.edges[ei]
      if (e.a === em.active || e.b === em.active) out.push(ei)
    }
    return { active: out, count: out.length }
  }

  private controlPoint(ei: number, curved: boolean): { cx: number; cy: number } {
    const e = this.model!.edges[ei]
    const ax = this.sx[e.a]
    const ay = this.sy[e.a]
    const bx = this.sx[e.b]
    const by = this.sy[e.b]
    const mx = (ax + bx) / 2
    const my = (ay + by) / 2
    if (!curved) return { cx: mx, cy: my }
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy) || 1
    const off = e.bend * 0.08 * len
    return { cx: mx - (dy / len) * off, cy: my + (dx / len) * off }
  }

  private drawField(now: number): void {
    const ctx = this.ctxA
    const th = this.theme
    const model = this.model
    const { w, h, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.setLineDash([])
    ctx.fillStyle = rgbCss(th.field)
    ctx.fillRect(0, 0, w, h)
    const gkey = `${w}x${h}:${rgbCss(th.glow)}:${rgbCss(th.field)}`
    if (!this.fieldGrad || this.fieldGrad.key !== gkey) {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.65)
      g.addColorStop(0, rgbCss(th.glow))
      g.addColorStop(1, rgbCss(th.field))
      this.fieldGrad = { key: gkey, g }
    }
    ctx.fillStyle = this.fieldGrad.g
    ctx.fillRect(0, 0, w, h)
    if (!model || this.n === 0) {
      this.inferredDrawn = 0
      return
    }
    const em = this.emphasis
    const spec = this.tierSpec()
    const curved = spec.curved
    const alpha = em?.alpha
    const dim = th.dim
    const factorOf = (a: number): number => (a >= 0.99 ? 1 : a <= dim + 0.001 ? dim : a * 0.85)

    // ---- ghosts (removed nodes fading)
    if (this.ghosts.length) {
      this.ghosts = this.ghosts.filter((g) => now - g.t0 < GHOST_MS)
      for (const g of this.ghosts) {
        ctx.globalAlpha = 1 - (now - g.t0) / GHOST_MS
        ctx.fillStyle = rgbCss(g.rgb)
        ctx.beginPath()
        ctx.arc(g.x * this.v.k + this.v.x, g.y * this.v.k + this.v.y, Math.max(g.r * this.v.k, MIN_SCREEN_RADIUS), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    // ---- synapses
    const buckets = new Map<number, Path2D>()
    const bucket = (key: number): Path2D => {
      let p = buckets.get(key)
      if (!p) {
        p = new Path2D()
        buckets.set(key, p)
      }
      return p
    }
    const active = em && em.active >= 0 ? em.active : -1
    const activePath = new Path2D()
    let activeCount = 0
    const labelEdges: number[] = []
    for (const ei of this.edgeList) {
      const e = model.edges[ei]
      const ax = this.sx[e.a]
      const ay = this.sy[e.a]
      const bx = this.sx[e.b]
      const by = this.sy[e.b]
      if ((ax < 0 && bx < 0) || (ax > w && bx > w) || (ay < 0 && by < 0) || (ay > h && by > h)) continue
      const isActive = active >= 0 && (e.a === active || e.b === active)
      let path: Path2D
      if (isActive) {
        path = activePath
        activeCount++
        labelEdges.push(ei)
      } else if (this.lod === 'low') {
        path = bucket(e.retired ? 1 : 0)
      } else {
        const f = alpha ? Math.min(alpha[e.a], alpha[e.b]) : 1
        path = bucket(Math.round(factorOf(f) * 20) * 2 + (e.retired ? 1 : 0))
      }
      path.moveTo(ax, ay)
      if (curved) {
        const c = this.controlPoint(ei, true)
        path.quadraticCurveTo(c.cx, c.cy, bx, by)
      } else path.lineTo(bx, by)
    }
    ctx.lineWidth = 1
    ctx.strokeStyle = rgbCss(th.synapse)
    for (const [key, path] of buckets) {
      if (this.lod === 'low') {
        ctx.globalAlpha = key === 1 ? 0.1 : 0.2
      } else {
        const f = Math.floor(key / 2) / 20
        ctx.globalAlpha = th.synapseOpacity * f * (key % 2 === 1 ? 0.35 : 1)
      }
      ctx.stroke(path)
    }
    if (activeCount > 0) {
      ctx.globalAlpha = 0.9
      ctx.lineWidth = 1.5
      ctx.strokeStyle = rgbCss(th.active)
      ctx.stroke(activePath)
    }

    // ---- inferred links
    this.inferredDrawn = 0
    if (model.inferred.length && em) {
      const p = new Path2D()
      let count = 0
      for (const l of model.inferred) {
        if (this.drawn[l.a] !== 1 || this.drawn[l.b] !== 1 || em.kept[l.a] !== 1 || em.kept[l.b] !== 1) continue
        if (!this.showInferred && !(active >= 0 && (l.a === active || l.b === active))) continue
        count++
        p.moveTo(this.sx[l.a], this.sy[l.a])
        p.lineTo(this.sx[l.b], this.sy[l.b])
      }
      this.inferredDrawn = count
      if (count > 0) {
        ctx.globalAlpha = 0.7
        ctx.lineWidth = 1
        ctx.setLineDash([2, 5])
        ctx.strokeStyle = rgbCss(th.inferred)
        ctx.stroke(p)
        ctx.setLineDash([])
      }
    }
    ctx.globalAlpha = 1

    // ---- recorded relation words on the active node's synapses
    ctx.font = `${FONT_SIZE}px ${th.font}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (active >= 0 && this.v.k >= 1 && activeCount > 0 && activeCount <= 8) {
      ctx.lineJoin = 'round'
      ctx.lineWidth = 3
      for (const ei of labelEdges) {
        const e = model.edges[ei]
        const c = this.controlPoint(ei, curved)
        const mx = 0.25 * this.sx[e.a] + 0.5 * c.cx + 0.25 * this.sx[e.b]
        const my = 0.25 * this.sy[e.a] + 0.5 * c.cy + 0.25 * this.sy[e.b]
        const word = keyWords(e.relation)
        ctx.strokeStyle = rgbCss(th.field)
        ctx.strokeText(word, mx, my)
        ctx.fillStyle = rgbCss(th.textSecondary)
        ctx.fillText(word, mx, my)
      }
    }

    // ---- nodes: dimmed first, emphasised last
    const order: number[] = []
    for (let i = 0; i < this.n; i++) if (this.drawn[i] === 1 && this.onScreen(i, 80)) order.push(i)
    order.sort((a, b) => (alpha ? alpha[a] - alpha[b] : 0) || this.sr[a] - this.sr[b])
    const dark = th.dark
    for (const i of order) {
      const nd = model.nodes[i]
      const a0 = alpha ? alpha[i] : 1
      const retired = !!nd.retired
      const a = a0 * (retired ? 0.45 : 1)
      const rgb = th.node(nd.kind)
      const x = this.sx[i]
      const y = this.sy[i]
      const r = this.sr[i]
      const near = !!em && em.near[i] === 1
      const wantHalo = spec.halos === Infinity || near || this.topSize[i] === 1
      if (wantHalo && r >= 3 && a0 > dim + 0.001 && spec.halos !== 0) {
        const hr = r * (dark ? 2.4 : 1.8)
        ctx.globalAlpha = th.haloOpacity * a * (dark ? 1.6 : 1.2)
        ctx.globalCompositeOperation = th.composite
        ctx.drawImage(this.sprite(rgb, !dark), x - hr, y - hr, hr * 2, hr * 2)
        ctx.globalCompositeOperation = 'source-over'
      }
      ctx.globalAlpha = a
      const mark = kindMark(nd.kind)
      if (mark === 'solid') {
        ctx.fillStyle = rgbCss(rgb)
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
        if (dark && r >= 5) {
          ctx.globalAlpha = a * 0.55
          ctx.fillStyle = rgbCss(mixRgb(rgb, { r: 255, g: 255, b: 255 }, 0.55))
          ctx.beginPath()
          ctx.arc(x, y, r * 0.45, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = a
        } else if (!dark && r >= 4) {
          ctx.lineWidth = 1
          ctx.strokeStyle = rgbCss(mixRgb(rgb, { r: 0, g: 0, b: 0 }, 0.4))
          ctx.stroke()
        }
      } else {
        const lw = Math.max(2, r * 0.28)
        ctx.lineWidth = lw
        ctx.strokeStyle = rgbCss(rgb)
        ctx.beginPath()
        ctx.arc(x, y, Math.max(1, r - lw / 2), 0, Math.PI * 2)
        ctx.stroke()
        if (mark === 'ring-dot') {
          ctx.fillStyle = rgbCss(rgb)
          ctx.beginPath()
          ctx.arc(x, y, r * 0.35, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      if (retired) {
        ctx.globalAlpha = a0 * 0.7
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.strokeStyle = rgbCss(rgb)
        ctx.beginPath()
        ctx.arc(x, y, r + 3, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }
      const isSel = i === this.selected
      const isMatch = !!em && em.searching && em.kept[i] === 1
      if (isSel || isMatch) {
        ctx.globalAlpha = 1
        ctx.lineWidth = 2
        ctx.strokeStyle = rgbCss(rgb)
        ctx.beginPath()
        ctx.arc(x, y, r + 3 + 1, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1

    // ---- names
    if (this.labelsDirty) this.computeLabels()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3
    for (const l of this.labels) {
      const i = model.index.get(l.id)
      if (i === undefined || this.drawn[i] !== 1) continue
      const x = Math.max(2, Math.min(this.sx[i] - l.w / 2, this.w - l.w - 2))
      const y = this.sy[i] + this.sr[i] + 3
      ctx.globalAlpha = Math.max(alpha ? alpha[i] : 1, 0.85) * (model.nodes[i].retired ? 0.6 : 1)
      ctx.strokeStyle = rgbCss(th.field)
      ctx.strokeText(l.text, x, y + 11)
      ctx.fillStyle = rgbCss(th.textPrimary)
      ctx.fillText(l.text, x, y + 11)
    }
    ctx.globalAlpha = 1
  }

  private computeLabels(): void {
    this.labelsDirty = false
    const model = this.model
    if (!model) return
    const em = this.emphasis
    const cands: LabelCandidate[] = []
    for (let i = 0; i < this.n; i++) {
      if (this.drawn[i] !== 1 || !this.onScreen(i, 20)) continue
      const kept = !em || em.kept[i] === 1
      // Hover shows names for the target and its neighbours only; a selection keeps the rest legible.
      const dimmed = !!em && (em.mode === 'hover' ? em.alpha[i] < 0.99 : em.alpha[i] < 0.5)
      cands.push({ id: model.ids[i], x: this.sx[i], y: this.sy[i], r: this.sr[i], total: model.totals[i], order: i, text: cutLabel(model.names[i]), quiet: !kept || dimmed })
    }
    const must: string[] = []
    const priority: string[] = []
    if (em && em.active >= 0) must.push(model.ids[em.active])
    if (this.selected >= 0 && this.drawn[this.selected] === 1) must.push(model.ids[this.selected])
    if (em && em.searching) {
      const matches: number[] = []
      for (let i = 0; i < this.n; i++) if (em.kept[i] === 1) matches.push(i)
      matches.sort((a, b) => model.totals[b] - model.totals[a] || a - b)
      for (const i of matches.slice(0, 60)) priority.push(model.ids[i])
    }
    const focus = em && em.active >= 0 ? em.active : this.selected
    if (focus >= 0) {
      const near = [...this.nbrs[focus]].sort((a, b) => model.totals[b] - model.totals[a] || a - b).slice(0, 12)
      for (const i of near) priority.push(model.ids[i])
    }
    this.labels = pickLabels({ candidates: cands, stage: { w: this.w, h: this.h }, zoom: this.v.k, measure: (t) => this.measure(t), must, priority })
  }

  // ------------------------------------------------------------ pulses and rings (the top canvas)

  private pulsePoint(p: Pulse, t: number): { x: number; y: number } | null {
    const model = this.model!
    const e = model.edges[p.edge]
    if (!e) return null
    const from = p.forward ? e.a : e.b
    const to = p.forward ? e.b : e.a
    const ax = this.sx[from]
    const ay = this.sy[from]
    const bx = this.sx[to]
    const by = this.sy[to]
    let c = { cx: (ax + bx) / 2, cy: (ay + by) / 2 }
    if (this.tierSpec().curved) {
      const raw = this.controlPoint(p.edge, true)
      c = raw
    }
    const u = 1 - t
    return { x: u * u * ax + 2 * u * t * c.cx + t * t * bx, y: u * u * ay + 2 * u * t * c.cy + t * t * by }
  }

  private spawnAmbient(now: number): void {
    const model = this.model!
    const limit = this.tierSpec().ambient
    this.pulses = this.pulses.filter((p) => p.kind !== 'ambient' || now - p.t0 < p.dur)
    if (this.pulses.filter((p) => p.kind === 'ambient').length >= limit) return
    const em = this.emphasis
    // weighted by the larger nodes at the ends
    let sum = 0
    const cand: { ei: number; wgt: number }[] = []
    for (const ei of this.edgeList) {
      const e = model.edges[ei]
      if (e.retired) continue
      if (em && (em.kept[e.a] !== 1 || em.kept[e.b] !== 1)) continue
      const wgt = 1 + model.totals[e.a] + model.totals[e.b]
      sum += wgt
      cand.push({ ei, wgt })
    }
    if (!cand.length) return
    let pick = this.rnd() * sum
    let chosen = cand[cand.length - 1].ei
    for (const c of cand) {
      pick -= c.wgt
      if (pick <= 0) {
        chosen = c.ei
        break
      }
    }
    const e = model.edges[chosen]
    const len = Math.hypot(this.sx[e.a] - this.sx[e.b], this.sy[e.a] - this.sy[e.b])
    const dur = Math.max(1400, Math.min(2200, 1400 + len * 2))
    this.pulses.push({ edge: chosen, forward: this.rnd() < 0.5, t0: now, dur, kind: 'ambient', chain: false })
  }

  private drawPulses(now: number): void {
    const ctx = this.ctxB
    const th = this.theme
    const { w, h, dpr } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, w, h)
    const model = this.model
    if (!model || this.n === 0) return
    ctx.lineCap = 'round'
    const live: Pulse[] = []
    const added: Pulse[] = []
    for (const p of this.pulses) {
      const dt = now - p.t0
      if (dt < 0) {
        live.push(p)
        continue
      }
      const t = dt / p.dur
      if (t >= 1) {
        if (p.chain && this.spreadBudget > 0) {
          const e = model.edges[p.edge]
          if (!e) continue
          const node = p.forward ? e.b : e.a
          this.rings.push({ idx: node, t0: now, dur: 360, kind: 'flash' })
          // one pulse on, along the node's largest other synapse
          let best = -1
          let bestTotal = -1
          for (const ei of this.edgeList) {
            const o = model.edges[ei]
            if (ei === p.edge || (o.a !== node && o.b !== node)) continue
            const tot = model.totals[o.a === node ? o.b : o.a]
            if (tot > bestTotal) {
              bestTotal = tot
              best = ei
            }
          }
          if (best >= 0) {
            this.spreadBudget--
            const o = model.edges[best]
            added.push({ edge: best, forward: o.a === node, t0: now, dur: SPREAD_MS, kind: 'spread', chain: false })
          }
        }
        continue
      }
      live.push(p)
      const eased = p.kind === 'spread' ? t : t
      const head = this.pulsePoint(p, eased)
      if (!head) continue
      const e = model.edges[p.edge]
      const len = Math.max(1, Math.hypot(this.sx[e.a] - this.sx[e.b], this.sy[e.a] - this.sy[e.b]))
      const tailT = Math.min(eased, 18 / len)
      const fade = Math.min(1, Math.min(eased * 6, (1 - eased) * 6))
      ctx.globalCompositeOperation = th.composite
      const steps = 5
      let prev = head
      for (let s = 1; s <= steps; s++) {
        const pt = this.pulsePoint(p, eased - (tailT * s) / steps)
        if (!pt) break
        ctx.globalAlpha = fade * (1 - s / (steps + 1)) * 0.7
        ctx.lineWidth = 2.4 * (1 - s / (steps + 2))
        ctx.strokeStyle = rgbCss(th.pulse)
        ctx.beginPath()
        ctx.moveTo(prev.x, prev.y)
        ctx.lineTo(pt.x, pt.y)
        ctx.stroke()
        prev = pt
      }
      ctx.globalAlpha = fade
      ctx.fillStyle = rgbCss(th.pulse)
      ctx.beginPath()
      ctx.arc(head.x, head.y, 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
    }
    this.pulses = [...live, ...added]
    // rings
    const keep: Ring[] = []
    for (const g of this.rings) {
      const t = (now - g.t0) / g.dur
      if (t >= 1) continue
      keep.push(g)
      if (g.idx >= this.n) continue
      const x = this.sx[g.idx]
      const y = this.sy[g.idx]
      const r = this.sr[g.idx]
      ctx.strokeStyle = rgbCss(th.pulse)
      if (this.reduced) {
        ctx.globalAlpha = 1
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(x, y, r + 5, 0, Math.PI * 2)
        ctx.stroke()
        continue
      }
      const grow = g.kind === 'fire' ? 14 : 6
      const e = easeOut(t)
      ctx.globalAlpha = (1 - t) * (g.kind === 'fire' ? 0.9 : 0.7)
      ctx.lineWidth = g.kind === 'fire' ? 2 : 1.5
      ctx.beginPath()
      ctx.arc(x, y, r + 2 + grow * e, 0, Math.PI * 2)
      ctx.stroke()
    }
    this.rings = keep
    ctx.globalAlpha = 1
  }
}
