// Factory Floor engine (docs/design/factory-floor.md sections 2, 4, 9.2). Non-React: owns the WebGLRenderer, the scene
// graph and the render-on-demand loop. It draws the floor the pure layout describes (hall, booth, dock, board, stations,
// machines, stack lights, robots, routes, vacant outlines, selection ring) from a FactoryKitSource, with one
// InstancedMesh per kit part (engine/instancing.ts). It never decides where things are (lib/factory/layout.ts), how the
// camera looks (lib/factory/camera.ts) or what things look like (builders/). Slice 3: every live state in its static
// end state (engine/floorInstances.ts: poses, lamps, shutter, barrier, fence, crates, board lamps; hall dim here). Each
// change renders one frame; nothing moves until slice 4's cues.
import { Box3, Color, Matrix4, type BufferGeometry, type DirectionalLight, PCFShadowMap, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three'
import type { FloorModel, Lamp } from '../../../../lib/factory/types'
import { factorySession } from '../../../../lib/factory/capability'
import { p95, type FactoryLoop, type FactoryPerf, type FactoryQuality } from '../../../../lib/factory/snapshot'
import { cameraPose, FOV_DEG, lodBand, type CameraView, type LodBand } from '../../../../lib/factory/camera'
import { GANTRY_TOP } from '../../../../lib/factory/layout'
import type { FactoryKitSource, FactoryLighting, FactoryMaterials, FactoryTheme, FactoryTokenColours, FloorRect, ObjectKit } from '../builders/types'
import { KitPool, subKit, type InstanceSpec } from './instancing'
import { floorInstances, KIT_NAMES, type BoardLampState, type EngineFloor, type KitName } from './floorInstances'
import { PoseLibrary } from './poses'

export type { FactoryTheme } from '../builders/types'
export type { EngineFloor } from './floorInstances'

/**
 * Key light direction: from the north-west, pointing down and south-east (section 4.2's words; the spec's vector has its
 * x sign flipped, recorded in slice 1).
 */
const KEY_DIRECTION = new Vector3(0.45, -1, 0.35).normalize()
const FRAME_RING = 120
/** LOD swaps wait until the zoom has been still this long (section 4.5: "only when a zoom settles"). */
const LOD_SETTLE_MS = 180
const BOARD_STATES: readonly BoardLampState[] = ['pending', 'active', 'done', 'blocked', 'skipped']

export interface FactoryEngineOptions {
  quality: FactoryQuality
  theme: FactoryTheme
  kits: FactoryKitSource
  /** Status token colours (lamps, selection ring); read again on every theme change. */
  tokens(): FactoryTokenColours
  /** performance.now() when the scene mounted, for firstFrameMs. */
  mountedAt: number
  /** Called after every rendered frame and on loop state changes. */
  onChange?: () => void
}

export interface FactoryEngineStats {
  loop: FactoryLoop
  frames: number
  perf: FactoryPerf | null
  /** LOD band in use. */
  lod: LodBand
}

/** World heights of the drawn objects' tops and label anchors (camera fit, mirror boxes, nameplates). */
export interface KitHeights {
  boothTop: number
  stationTop: number
  dockTop: number
  boardTop: number
  /** Nameplate anchor heights (world y). */
  boothPlate: number
  stationPlate: number
  /** Floor extent of a station kit (plate, belt, props) about its centre, union of lead and bench. */
  stationExtent: { minX: number; maxX: number; minZ: number; maxZ: number }
}

const IDENTITY = new Matrix4()

function kitBox(kit: ObjectKit): Box3 {
  const box = new Box3()
  for (const p of kit.parts) {
    if (!p.geometry.boundingBox) p.geometry.computeBoundingBox()
    box.union(p.geometry.boundingBox!)
  }
  return box
}
function kitTop(kit: ObjectKit): number {
  const box = kitBox(kit)
  return box.isEmpty() ? 0 : Math.max(0, box.max.y)
}

export class FactoryEngine {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(FOV_DEG, 1, 0.5, 600)
  private readonly options: FactoryEngineOptions
  private readonly kits: FactoryKitSource
  private theme: FactoryTheme
  private readonly quality: FactoryQuality
  private readonly materials: FactoryMaterials
  private readonly lighting: FactoryLighting
  private readonly key: DirectionalLight
  /** Every geometry the kits built for this engine (disposed with it). */
  private readonly geometries = new Set<BufferGeometry>()
  private readonly kitCache = new Map<KitName, ObjectKit>()
  private readonly pools = new Map<KitName, KitPool>()
  private hallPool: KitPool | null = null
  private hallKey = ''
  private floor: EngineFloor | null = null
  private readonly lampColours: Record<Lamp, Color> = { off: new Color(), running: new Color(), 'needs-you': new Color(), failed: new Color() }
  private readonly boardColours = new Map<BoardLampState, Color>(BOARD_STATES.map((s) => [s, new Color()]))
  /** Hall light level applied to the lighting (section 4.3: paused and ended dim). */
  private hall: FloorModel['hall'] = 'on'
  private poses: PoseLibrary | null = null

  private width = 1
  private height = 1
  private view: CameraView = { ppm: 20, targetX: 15, targetZ: -4 }
  private band: LodBand
  private lodTimer: ReturnType<typeof setTimeout> | null = null

  private raf = 0
  private visible = true
  private lost = false
  private disposed = false
  private frames = 0
  private lastFrameAt = 0
  private readonly frameMs: number[] = []
  private readonly intervalMs: number[] = []
  private firstFrameMs = -1
  private drawCalls = 0
  private shadowCalls = 0
  private triangles = 0
  private callsAtMainPass = -1
  private trianglesAtMainPass = 0
  /** The next frame recompiles programs (after a context restore). */
  private compileFrame = false
  private readonly gpu: string | undefined

  constructor(canvas: HTMLCanvasElement, options: FactoryEngineOptions) {
    this.options = options
    this.kits = options.kits
    this.theme = options.theme
    this.quality = options.quality
    // Minimal quality (software WebGL) draws the far LOD at every zoom (section 9.2).
    this.band = options.quality === 'minimal' ? 'far' : 'near'
    // Throws when no context can be made; the caller shows the no-WebGL2 floor plan.
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: options.quality === 'high',
      alpha: false,
      stencil: false,
      powerPreference: 'default',
      preserveDrawingBuffer: false
    })
    let materials: FactoryMaterials | null = null
    let lighting: FactoryLighting | null = null
    try {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
      this.renderer.setPixelRatio(options.quality === 'high' ? Math.min(dpr, 1.5) : 1)
      const shadows = options.quality !== 'minimal'
      this.renderer.shadowMap.enabled = shadows
      this.renderer.shadowMap.type = PCFShadowMap
      this.renderer.shadowMap.autoUpdate = false
      this.renderer.shadowMap.needsUpdate = shadows
      this.gpu = this.readGpu()

      const tokens = options.tokens()
      materials = this.kits.createMaterials(this.theme, tokens)
      lighting = this.kits.createLighting(this.theme)
      this.materials = materials
      this.lighting = lighting
      this.key = lighting.key as DirectionalLight
      this.key.castShadow = shadows
      if (shadows) {
        const size = options.quality === 'high' ? 2048 : 1024
        this.key.shadow.mapSize.set(size, size)
        this.key.shadow.bias = -0.0005
        this.key.shadow.normalBias = 0.02
      }
      for (const l of lighting.lights) this.scene.add(l)
      if (!this.scene.children.includes(this.key)) this.scene.add(this.key)
      this.scene.add(this.key.target)
      this.buildPools()
      // Hall shell for the empty floor until the first setFloor.
      this.ensureHall({ minX: 0, maxX: 30, minZ: -10, maxZ: 2 })
      this.applyTheme(tokens)
    } catch (error) {
      // Setup failed part-way: release everything at once so a failed engine never holds a GPU context.
      for (const pool of this.pools.values()) pool.dispose()
      for (const g of this.geometries) g.dispose()
      materials?.dispose()
      lighting?.dispose()
      this.renderer.dispose()
      this.renderer.forceContextLoss()
      throw error
    }
    // Engines constructed and not yet disposed (the leak check, section 9.1); counted only once setup succeeded.
    factorySession.engines++
  }

  // ---- public API ----

  /** World heights of the kits' tops and label anchors (built once). */
  heights(): KitHeights {
    const booth = this.kit('booth')
    const sb = kitBox(this.kit('bench')).union(kitBox(this.kit('lead')))
    const extent = sb.isEmpty()
      ? { minX: -1.5, maxX: 1.5, minZ: -1.5, maxZ: 2.5 }
      : { minX: Math.min(-1.5, sb.min.x), maxX: Math.max(1.5, sb.max.x), minZ: Math.min(-1.5, sb.min.z), maxZ: Math.max(1.5, sb.max.z) }
    const stationTop = Math.max(kitTop(this.kit('bench')), kitTop(this.kit('lead')), ...[0, 1, 2, 3].map((v) => kitTop(this.kit(`machine${v}` as KitName)) + (this.kit('bench').anchors?.machine?.y ?? 0)), kitTop(this.kit('stack')) + (this.kit('bench').anchors?.stackLight?.y ?? 0), kitTop(this.kit('robot')))
    return {
      boothTop: GANTRY_TOP + Math.max(kitTop(booth), kitTop(this.kit('stack')) + (booth.anchors?.stackLight?.y ?? 0)),
      stationTop,
      dockTop: GANTRY_TOP + kitTop(this.kit('dock')),
      boardTop: GANTRY_TOP + kitTop(this.kit('board')),
      boothPlate: GANTRY_TOP + (booth.anchors?.nameplate?.y ?? kitTop(booth)),
      stationPlate: this.kit('bench').anchors?.nameplate?.y ?? stationTop,
      stationExtent: extent
    }
  }

  setTheme(theme: FactoryTheme): void {
    if (theme === this.theme || this.disposed) return
    this.theme = theme
    this.applyTheme(this.options.tokens())
    this.requestFrame()
  }

  /** The floor to draw. Only pools whose instances changed are written; static changes refresh the shadow map. */
  setFloor(floor: EngineFloor): void {
    if (this.disposed) return
    this.floor = floor
    if (this.syncFloor()) this.requestFrame()
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.renderer.setSize(w, h, false)
    this.applyCamera()
    this.requestFrame()
  }

  /** The camera view (owned by the scene's camera controller). LOD follows once the zoom settles. */
  setView(view: CameraView): void {
    if (this.disposed) return
    this.view = { ...view }
    this.applyCamera()
    this.scheduleLod()
    this.requestFrame()
  }

  /** Renders a pending frame now (same frame as the DOM mirror's camera update). */
  flush(): void {
    if (!this.raf) return
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.frame(performance.now())
  }

  /** Document visible and stage on screen. Hidden stops the loop; becoming visible renders one frame. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    if (!visible) this.cancel()
    else this.requestFrame()
    this.options.onChange?.()
  }

  /** The context was lost: stop at once (restore comes through rebuild()). */
  setContextLost(): void {
    this.lost = true
    this.cancel()
    this.options.onChange?.()
  }

  /**
   * After webglcontextrestored: three has re-created its GL state; mark every material and the shadow map dirty so
   * programs, buffers and textures are rebuilt from the current scene, re-apply the theme, then render one frame.
   */
  rebuild(): void {
    if (this.disposed) return
    this.lost = false
    this.compileFrame = true
    this.scene.traverse((o) => {
      const m = (o as { material?: { needsUpdate: boolean } | { needsUpdate: boolean }[] }).material
      if (Array.isArray(m)) for (const x of m) x.needsUpdate = true
      else if (m) m.needsUpdate = true
      const im = o as { instanceMatrix?: { needsUpdate: boolean }; instanceColor?: { needsUpdate: boolean } | null }
      if (im.instanceMatrix) im.instanceMatrix.needsUpdate = true
      if (im.instanceColor) im.instanceColor.needsUpdate = true
    })
    this.renderer.shadowMap.needsUpdate = this.renderer.shadowMap.enabled
    this.applyTheme(this.options.tokens())
    this.requestFrame()
  }

  /** Schedules one frame unless one is pending; does nothing while hidden, lost or disposed. */
  requestFrame(): void {
    if (this.disposed || this.lost || !this.visible || this.raf) return
    this.raf = requestAnimationFrame((t) => this.frame(t))
    this.options.onChange?.()
  }

  stats(): FactoryEngineStats {
    const loop: FactoryLoop = this.disposed || this.lost || !this.visible ? 'stopped' : this.raf ? 'running' : 'idle'
    let perf: FactoryPerf | null = null
    if (this.frames > 0 && !this.disposed) {
      const mem = this.renderer.info.memory
      perf = {
        drawCalls: this.drawCalls,
        shadowCalls: this.shadowCalls,
        triangles: this.triangles,
        geometries: mem.geometries,
        textures: mem.textures,
        frameP95Ms: p95(this.frameMs),
        intervalP95Ms: p95(this.intervalMs),
        firstFrameMs: this.firstFrameMs,
        ...(this.gpu ? { gpu: this.gpu } : {})
      }
    }
    return { loop, frames: this.frames, perf, lod: this.band }
  }

  /** Cancels the loop and the LOD timer, frees every pool, geometry, material and texture, then the renderer and its context. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    if (this.lodTimer) clearTimeout(this.lodTimer)
    this.lodTimer = null
    for (const pool of this.pools.values()) pool.dispose()
    this.pools.clear()
    this.hallPool?.dispose()
    this.hallPool = null
    for (const g of this.geometries) g.dispose()
    this.geometries.clear()
    this.materials.dispose()
    this.key.shadow.map?.dispose()
    this.lighting.dispose()
    this.scene.clear()
    this.renderer.dispose()
    // Frees the context at once (Chromium caps live contexts per page); a lost context has nothing left to free.
    if (!this.lost) this.renderer.forceContextLoss()
    factorySession.engines = Math.max(0, factorySession.engines - 1)
  }

  // ---- internals ----

  private register(kit: ObjectKit): ObjectKit {
    for (const p of kit.parts) this.geometries.add(p.geometry)
    return kit
  }

  private kit(name: KitName): ObjectKit {
    const cached = this.kitCache.get(name)
    if (cached) return cached
    let kit: ObjectKit | null
    const k = this.kits
    switch (name) {
      case 'booth': kit = k.booth(); break
      case 'dock': kit = k.dock(); break
      case 'board': kit = k.board(); break
      case 'lead': kit = k.station('lead'); break
      case 'bench': kit = k.station('bench'); break
      case 'machine0': kit = k.machine(0); break
      case 'machine1': kit = k.machine(1); break
      case 'machine2': kit = k.machine(2); break
      case 'machine3': kit = k.machine(3); break
      case 'stack': kit = k.stackLight(); break
      case 'robot': kit = k.robot(); break
      // Slice 3 state props: optional in the kit contract; a missing kit is an empty one (nothing drawn).
      case 'shutter': kit = k.shutter?.() ?? null; break
      case 'barrier': kit = k.barrier?.() ?? null; break
      case 'fence': kit = k.fence?.() ?? null; break
      case 'crate': kit = k.crate?.() ?? null; break
      case 'holdPad': kit = k.holdPad?.(false) ?? null; break
      case 'holdPadStriped': kit = k.holdPad?.(true) ?? null; break
      case 'boardLamp': kit = k.boardLamp?.() ?? null; break
      default: {
        // Props: one kit per part so each gets its own instances. Built once; the parts share one props() call.
        const props = this.register(k.props())
        for (const key of ['paint', 'vacant', 'ring', 'blob'] as const) this.kitCache.set(key, subKit(props, key) ?? { name: `props.${key}`, parts: [] })
        for (const p of props.parts) if (!['paint', 'vacant', 'ring', 'blob'].includes(p.key)) p.geometry.dispose()
        return this.kitCache.get(name)!
      }
    }
    if (!kit) kit = { name, parts: [] }
    this.register(kit)
    this.kitCache.set(name, kit)
    return kit
  }

  private buildPools(): void {
    const hook = (renderer: WebGLRenderer): void => {
      if (this.callsAtMainPass >= 0) return
      this.callsAtMainPass = renderer.info.render.calls
      this.trianglesAtMainPass = renderer.info.render.triangles
    }
    for (const name of KIT_NAMES) {
      const pool = new KitPool(this.scene, this.kit(name), this.materials, hook)
      pool.setLod(this.band)
      this.pools.set(name, pool)
    }
    const robot = this.kit('robot')
    this.poses = new PoseLibrary(robot.anchors, robot.parts.map((p) => p.key))
    this.drawHook = hook
  }

  private drawHook: ((renderer: WebGLRenderer) => void) | null = null

  private ensureHall(hall: FloorRect): boolean {
    const key = `${hall.minX},${hall.maxX},${hall.minZ},${hall.maxZ}`
    if (key === this.hallKey && this.hallPool) return false
    this.hallKey = key
    if (this.hallPool) {
      for (const p of this.hallPool.kit.parts) {
        p.geometry.dispose()
        this.geometries.delete(p.geometry)
      }
      this.hallPool.dispose()
    }
    const kit = this.register(this.kits.hall(hall))
    this.hallPool = new KitPool(this.scene, kit, this.materials, this.drawHook ?? undefined, 1)
    this.hallPool.setLod(this.band)
    this.hallPool.set([{ key: 'hall', matrix: IDENTITY }])
    this.fitShadow(hall)
    return true
  }

  /** Writes every pool from the current floor; returns true when anything changed. */
  private syncFloor(): boolean {
    const floor = this.floor
    if (!floor) return false
    const { layout } = floor.model
    let changed = this.ensureHall(layout.hall)
    let shadow = changed
    // Hall dim (section 4.3): lights only, one frame, no rebuild.
    if (floor.model.hall !== this.hall) {
      this.hall = floor.model.hall
      this.lighting.applyTheme(this.theme, this.hall)
      changed = true
    }
    const lists = floorInstances(floor, {
      kit: (name) => this.kit(name),
      top: (name) => kitTop(this.kit(name)),
      band: this.band,
      lamps: this.lampColours,
      boardLamp: (state) => this.boardColours.get(state) ?? this.lampColours.off,
      poses: this.poses!
    })
    for (const [name, list] of Object.entries(lists) as [KitName, InstanceSpec[]][]) {
      const pool = this.pools.get(name)
      if (!pool) continue
      if (pool.set(list)) {
        changed = true
        // A colour change (lamps) never moves a shadow; a placed, moved or removed caster does.
        if (pool.castsShadow && pool.placementChanged) shadow = true
      }
    }
    if (shadow) this.renderer.shadowMap.needsUpdate = this.renderer.shadowMap.enabled
    return changed
  }

  private readGpu(): string | undefined {
    try {
      const gl = this.renderer.getContext()
      const ext = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null
      const value = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null
      return typeof value === 'string' && value ? value.slice(0, 200) : undefined
    } catch {
      return undefined
    }
  }

  private cancel(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private frame(now: number): void {
    this.raf = 0
    if (this.disposed || this.lost || !this.visible) return
    const t0 = performance.now()
    const shadowFrame = this.renderer.shadowMap.enabled && this.renderer.shadowMap.needsUpdate
    this.callsAtMainPass = -1
    this.trianglesAtMainPass = 0
    this.renderer.render(this.scene, this.camera)
    const t1 = performance.now()
    const info = this.renderer.info.render
    // Main pass only: what was counted before the first pool mesh's onBeforeRender belongs to the shadow pass.
    const before = this.callsAtMainPass >= 0 ? this.callsAtMainPass : 0
    if (shadowFrame) this.shadowCalls = before
    this.drawCalls = info.calls - before
    this.triangles = info.triangles - (this.callsAtMainPass >= 0 ? this.trianglesAtMainPass : 0)
    this.frames++
    // The first frame after a build compiles every program; it is reported as firstFrameMs, not as a frame time.
    if (this.firstFrameMs < 0) this.firstFrameMs = t1 - this.options.mountedAt
    else if (!this.compileFrame) push(this.frameMs, t1 - t0)
    this.compileFrame = false
    // An interval counts only between frames of one continuous run (an on-demand pause is not a long frame).
    if (this.lastFrameAt && now - this.lastFrameAt < 100) push(this.intervalMs, now - this.lastFrameAt)
    this.lastFrameAt = now
    this.options.onChange?.()
  }

  private applyTheme(tokens: FactoryTokenColours): void {
    this.renderer.setClearColor(this.kits.clearColour(this.theme), 1)
    this.materials.applyTheme(this.theme, tokens)
    this.lighting.applyTheme(this.theme, this.hall)
    this.lampColours.off.set(this.kits.lampOffColour(this.theme))
    this.lampColours.running.set(tokens.success)
    this.lampColours['needs-you'].set(tokens.warning)
    this.lampColours.failed.set(tokens.danger)
    // Plan step lamps: the kit's colour per state, else pending and skipped off, active and done success, blocked warning.
    for (const state of BOARD_STATES) {
      const fromKit = this.kits.boardLampColour?.(this.theme, state, tokens)
      const fallback = state === 'blocked' ? this.lampColours['needs-you'] : state === 'active' || state === 'done' ? this.lampColours.running : this.lampColours.off
      const c = this.boardColours.get(state)!
      if (fromKit) c.set(fromKit)
      else c.copy(fallback)
    }
    // Lamp instance colours follow the token values of the new theme.
    this.syncFloor()
  }

  private scheduleLod(): void {
    if (this.quality === 'minimal') return
    const band = lodBand(this.view.ppm)
    if (band === this.band) {
      if (this.lodTimer) clearTimeout(this.lodTimer)
      this.lodTimer = null
      return
    }
    // First view: apply at once (nothing on screen to swap yet).
    if (this.frames === 0) {
      this.applyLod(band)
      return
    }
    if (this.lodTimer) clearTimeout(this.lodTimer)
    this.lodTimer = setTimeout(() => {
      this.lodTimer = null
      if (this.disposed) return
      this.applyLod(lodBand(this.view.ppm))
      this.requestFrame()
    }, LOD_SETTLE_MS)
  }

  private applyLod(band: LodBand): void {
    this.band = band
    for (const pool of this.pools.values()) pool.setLod(band)
    this.hallPool?.setLod(band)
    // Stack-light scale depends on the band.
    this.syncFloor()
  }

  /** Orthographic shadow box around the hall plus 2 m, along the key light (section 4.2). */
  private fitShadow(h: FloorRect): void {
    const cx = (h.minX + h.maxX) / 2
    const cz = (h.minZ + h.maxZ) / 2
    const radius = Math.hypot(h.maxX - h.minX, h.maxZ - h.minZ) / 2 + 2
    const distance = radius + 10
    this.key.target.position.set(cx, 0, cz)
    this.key.position.set(cx - KEY_DIRECTION.x * distance, -KEY_DIRECTION.y * distance, cz - KEY_DIRECTION.z * distance)
    const cam = this.key.shadow.camera
    cam.left = -radius
    cam.right = radius
    cam.top = radius
    cam.bottom = -radius
    cam.near = 0.5
    cam.far = distance + radius + 4
    cam.updateProjectionMatrix()
    this.key.target.updateMatrixWorld()
    this.renderer.shadowMap.needsUpdate = this.renderer.shadowMap.enabled
  }

  private applyCamera(): void {
    const stage = { width: this.width, height: this.height, projection: 'perspective' as const }
    const pose = cameraPose(this.view, stage)
    this.camera.aspect = this.width / this.height
    this.camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    this.camera.lookAt(pose.target.x, pose.target.y, pose.target.z)
    this.camera.near = Math.max(0.5, pose.distance * 0.1)
    this.camera.far = pose.distance * 4 + 200
    this.camera.updateProjectionMatrix()
  }
}

function push(ring: number[], value: number): void {
  ring.push(value)
  if (ring.length > FRAME_RING) ring.shift()
}
