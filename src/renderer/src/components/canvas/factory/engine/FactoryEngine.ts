// Factory Floor engine (docs/design/factory-floor.md sections 2, 4.2, 4.3, 9.2). Non-React: owns the WebGLRenderer, the
// scene graph and the render-on-demand loop. Slice 1: the empty hall (floor slab, walls, gantry deck, booth
// placeholder), lights, theme switch, a fixed camera fit, visibility stop, context-loss stop and restore, disposal and
// the numbers for the test state. Layout constants and camera maths move to lib/factory in slice 2.
import {
  AmbientLight,
  BoxGeometry,
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  LinearFilter,
  LinearMipmapLinearFilter,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  Vector3,
  WebGLRenderer,
  type BufferGeometry,
  type Material,
  type Texture
} from 'three'
import type { Bounds, Vec2 } from '../../../../lib/factory/types'
import { factorySession } from '../../../../lib/factory/capability'
import { p95, type FactoryLoop, type FactoryPerf, type FactoryQuality, type FactoryView } from '../../../../lib/factory/snapshot'

export type FactoryTheme = 'dark' | 'light'

/** Section 3.3, one agent or none: the hall is 30 x 12 m (x 0 to 30, z -10 to 2). Slice 2's layout replaces it. */
export const EMPTY_HALL: Bounds = { minX: 0, maxX: 30, minZ: -10, maxZ: 2 }
/** Section 3.1: the booth is fixed at (7, -6), 6 x 4 m; the gantry deck spans z -10 to -2. */
export const BOOTH_CENTER: Vec2 = { x: 7, z: -6 }
const BOOTH_W = 6
const BOOTH_D = 4
const BOOTH_H = 2.6
const GANTRY_MIN_Z = -10
const GANTRY_MAX_Z = -2
const GANTRY_H = 1.5
const WALL_H = 1.2
const WALL_T = 0.3

/** Section 2. */
const FOV_DEG = 28
const PITCH_DEG = 55
export const PPM_MIN = 7
export const PPM_MAX = 60
const FIT_PPM_MAX = 32
const FIT_PADDING = 0.08

/**
 * Section 4.3 values for the roles slice 1 draws. The Technical Artist's palette module (slice 2) replaces this table.
 * Ambient is not in the table ("a low level"): 0.15 dark, 0.25 light, to be tuned on screenshots.
 */
const PALETTE: Record<FactoryTheme, {
  clear: string
  floor: string
  gridFaint: string
  gridStrong: string
  wall: string
  deck: string
  booth: string
  sky: string
  ground: string
  hemi: number
  key: string
  keyIntensity: number
  ambient: number
}> = {
  dark: {
    clear: '#0e1118', floor: '#2a2f3a', gridFaint: '#323845', gridStrong: '#3b4250', wall: '#1f2430', deck: '#3a4252',
    booth: '#5a657b', sky: '#9fb3d1', ground: '#1a1d24', hemi: 0.55, key: '#ffffff', keyIntensity: 1.4, ambient: 0.15
  },
  light: {
    clear: '#eef0f4', floor: '#d6d9df', gridFaint: '#cbcfd6', gridStrong: '#bfc4cc', wall: '#e2e5ea', deck: '#b4bbc7',
    booth: '#8d97a8', sky: '#ffffff', ground: '#b9bec8', hemi: 0.9, key: '#fff7ea', keyIntensity: 1.8, ambient: 0.25
  }
}

/**
 * Key light direction: from the north-west, pointing down and south-east (section 4.2's words). The spec's vector
 * (-0.45, -1, 0.35) points south-west; its x sign is taken as a typo and flipped (recorded in the report).
 */
const KEY_DIRECTION = new Vector3(0.45, -1, 0.35).normalize()

/** Grid texture: 64 px covers 4 x 4 m, a faint line each metre and a strong one each 4 m. */
const GRID_PX = 64
const GRID_METRES = 4

const FRAME_RING = 120

export interface FactoryEngineOptions {
  quality: FactoryQuality
  theme: FactoryTheme
  /** performance.now() when the scene mounted, for firstFrameMs. */
  mountedAt: number
  /** Called after every rendered frame and on loop state changes. */
  onChange?: () => void
}

export interface FactoryEngineStats {
  loop: FactoryLoop
  frames: number
  view: FactoryView
  perf: FactoryPerf | null
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export class FactoryEngine {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(FOV_DEG, 1, 0.5, 600)
  private readonly geometries = new Set<BufferGeometry>()
  private readonly materials = new Set<Material>()
  private readonly textures = new Set<Texture>()
  private readonly options: FactoryEngineOptions
  private theme: FactoryTheme
  private readonly quality: FactoryQuality

  private readonly hemi = new HemisphereLight()
  private readonly key = new DirectionalLight()
  private readonly ambient = new AmbientLight('#ffffff')
  private readonly gridData = new Uint8Array(GRID_PX * GRID_PX * 4)
  private readonly gridTexture: DataTexture
  private readonly floorMat: MeshStandardMaterial
  private readonly wallMat: MeshStandardMaterial
  private readonly deckMat: MeshStandardMaterial
  private readonly boothMat: MeshStandardMaterial
  private booth: Mesh | null = null
  private hall: Bounds = EMPTY_HALL
  private hallMeshes: Mesh[] = []

  private width = 1
  private height = 1
  private view: FactoryView = { ppm: 20, targetX: 15, targetZ: -4 }
  private userMoved = false

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
  private shadowFrame = false
  private callsAtMainPass = -1
  private trianglesAtMainPass = 0
  /** The next frame recompiles programs (after a context restore). */
  private compileFrame = false
  private readonly gpu: string | undefined

  constructor(canvas: HTMLCanvasElement, options: FactoryEngineOptions) {
    this.options = options
    this.theme = options.theme
    this.quality = options.quality
    // Throws when no context can be made; the caller shows the no-WebGL2 floor plan.
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: options.quality === 'high',
      alpha: false,
      stencil: false,
      powerPreference: 'default',
      preserveDrawingBuffer: false
    })
    try {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    this.renderer.setPixelRatio(options.quality === 'high' ? Math.min(dpr, 1.5) : 1)
    const shadows = options.quality !== 'minimal'
    this.renderer.shadowMap.enabled = shadows
    this.renderer.shadowMap.type = PCFShadowMap
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = shadows

    this.gpu = this.readGpu()

    this.gridTexture = new DataTexture(this.gridData, GRID_PX, GRID_PX, RGBAFormat)
    this.gridTexture.colorSpace = SRGBColorSpace
    this.gridTexture.wrapS = RepeatWrapping
    this.gridTexture.wrapT = RepeatWrapping
    this.gridTexture.magFilter = LinearFilter
    this.gridTexture.minFilter = LinearMipmapLinearFilter
    this.gridTexture.generateMipmaps = true
    this.gridTexture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy())
    this.textures.add(this.gridTexture)

    this.floorMat = this.material({ color: '#ffffff', map: this.gridTexture, roughness: 0.95, metalness: 0 })
    this.wallMat = this.material({ roughness: 0.9, metalness: 0.05 })
    this.deckMat = this.material({ roughness: 0.8, metalness: 0.15, flatShading: true })
    this.boothMat = this.material({ roughness: 0.7, metalness: 0.2, flatShading: true })

    this.key.castShadow = shadows
    if (shadows) {
      const size = options.quality === 'high' ? 2048 : 1024
      this.key.shadow.mapSize.set(size, size)
      this.key.shadow.bias = -0.0005
      this.key.shadow.normalBias = 0.02
    }
    this.scene.add(this.hemi, this.key, this.key.target, this.ambient)

    this.applyTheme()
    this.buildHall()
    } catch (error) {
      // Setup failed part-way: release everything at once so a failed engine never holds a GPU context.
      for (const g of this.geometries) g.dispose()
      for (const m of this.materials) m.dispose()
      for (const t of this.textures) t.dispose()
      this.renderer.dispose()
      this.renderer.forceContextLoss()
      throw error
    }
    // Engines constructed and not yet disposed (the leak check, section 9.1); counted only once setup succeeded.
    factorySession.engines++
  }

  // ---- public API ----

  setTheme(theme: FactoryTheme): void {
    if (theme === this.theme || this.disposed) return
    this.theme = theme
    this.applyTheme()
    this.requestFrame()
  }

  /** The booth placeholder shows once the run has a root (section 8: no root, empty hall with the gantry). */
  setBooth(on: boolean): void {
    if (!this.booth || this.booth.visible === on) return
    this.booth.visible = on
    this.renderer.shadowMap.needsUpdate = this.renderer.shadowMap.enabled
    this.requestFrame()
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    if (!this.userMoved) this.view = this.fitView()
    this.applyCamera()
    this.requestFrame()
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
   * After webglcontextrestored: three has re-created its GL state; mark every uploaded resource dirty so geometry,
   * textures, programs and the shadow map are rebuilt from the current scene, then render one frame.
   */
  rebuild(): void {
    if (this.disposed) return
    this.lost = false
    this.compileFrame = true
    for (const t of this.textures) t.needsUpdate = true
    for (const m of this.materials) m.needsUpdate = true
    this.renderer.shadowMap.needsUpdate = this.renderer.shadowMap.enabled
    // Re-apply the clear colour, grid and lights: the slice 1 screenshot after a restore showed a black clear colour.
    this.applyTheme()
    this.requestFrame()
  }

  getView(): FactoryView {
    return { ...this.view }
  }

  /** Sets the camera (zoom buttons); marks the view as moved by the user so a resize does not refit. */
  setView(view: FactoryView): void {
    this.view = { ppm: MathUtils.clamp(view.ppm, PPM_MIN, PPM_MAX), targetX: view.targetX, targetZ: view.targetZ }
    this.userMoved = true
    this.applyCamera()
    this.requestFrame()
  }

  zoomBy(factor: number): void {
    this.setView({ ...this.view, ppm: this.view.ppm * factor })
  }

  fit(): void {
    this.userMoved = false
    this.view = this.fitView()
    this.applyCamera()
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
    return { loop, frames: this.frames, view: { ...this.view }, perf }
  }

  /** Cancels the loop, frees every geometry, material and texture, then the renderer and its context. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    for (const g of this.geometries) g.dispose()
    for (const m of this.materials) m.dispose()
    for (const t of this.textures) t.dispose()
    this.key.shadow.map?.dispose()
    this.key.dispose()
    this.hemi.dispose()
    this.ambient.dispose()
    this.geometries.clear()
    this.materials.clear()
    this.textures.clear()
    this.scene.clear()
    this.renderer.dispose()
    // Frees the context at once (Chromium caps live contexts per page); a lost context has nothing left to free.
    if (!this.lost) this.renderer.forceContextLoss()
    factorySession.engines = Math.max(0, factorySession.engines - 1)
  }

  // ---- internals ----

  private material(params: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial {
    const m = new MeshStandardMaterial(params)
    this.materials.add(m)
    return m
  }

  private geometry<T extends BufferGeometry>(g: T): T {
    this.geometries.add(g)
    return g
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
    this.shadowFrame = this.renderer.shadowMap.enabled && this.renderer.shadowMap.needsUpdate
    this.callsAtMainPass = -1
    this.trianglesAtMainPass = 0
    this.renderer.render(this.scene, this.camera)
    const t1 = performance.now()
    const info = this.renderer.info.render
    // Main pass only: what was counted before the floor (drawn first) belongs to the shadow pass.
    const shadowPart = this.shadowFrame && this.callsAtMainPass >= 0
    if (shadowPart) this.shadowCalls = this.callsAtMainPass
    this.drawCalls = info.calls - (shadowPart ? this.callsAtMainPass : 0)
    this.triangles = info.triangles - (shadowPart ? this.trianglesAtMainPass : 0)
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

  private applyTheme(): void {
    const p = PALETTE[this.theme]
    this.renderer.setClearColor(p.clear, 1)
    this.paintGrid(p.floor, p.gridFaint, p.gridStrong)
    this.wallMat.color.set(p.wall)
    this.deckMat.color.set(p.deck)
    this.boothMat.color.set(p.booth)
    this.hemi.color.set(p.sky)
    this.hemi.groundColor.set(p.ground)
    this.hemi.intensity = p.hemi
    this.key.color.set(p.key)
    this.key.intensity = p.keyIntensity
    this.ambient.intensity = p.ambient
  }

  private paintGrid(floor: string, faint: string, strong: string): void {
    const [fr, fg, fb] = hexToRgb(floor)
    const [ar, ag, ab] = hexToRgb(faint)
    const [sr, sg, sb] = hexToRgb(strong)
    const perMetre = GRID_PX / GRID_METRES
    for (let y = 0; y < GRID_PX; y++) {
      for (let x = 0; x < GRID_PX; x++) {
        const i = (y * GRID_PX + x) * 4
        const isStrong = x === 0 || y === 0
        const isFaint = x % perMetre === 0 || y % perMetre === 0
        const [r, g, b] = isStrong ? [sr, sg, sb] : isFaint ? [ar, ag, ab] : [fr, fg, fb]
        this.gridData[i] = r
        this.gridData[i + 1] = g
        this.gridData[i + 2] = b
        this.gridData[i + 3] = 255
      }
    }
    this.gridTexture.needsUpdate = true
  }

  private buildHall(): void {
    const h = this.hall
    const w = h.maxX - h.minX
    const d = h.maxZ - h.minZ
    const cx = (h.minX + h.maxX) / 2
    const cz = (h.minZ + h.maxZ) / 2

    const floorGeo = this.geometry(new PlaneGeometry(w, d))
    const floor = new Mesh(floorGeo, this.floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.set(cx, 0, cz)
    floor.receiveShadow = true
    // Drawn first in the main pass: the calls counted before it are the shadow pass's.
    floor.renderOrder = -1
    floor.onBeforeRender = (renderer) => {
      if (this.callsAtMainPass >= 0) return
      this.callsAtMainPass = renderer.info.render.calls
      this.trianglesAtMainPass = renderer.info.render.triangles
    }
    this.gridTexture.repeat.set(w / GRID_METRES, d / GRID_METRES)
    // Grid lines on world multiples of 4 m (u grows east from minX; v grows north from maxZ).
    this.gridTexture.offset.set(frac(h.minX / GRID_METRES), frac(-h.maxZ / GRID_METRES))

    const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, mat: Material): Mesh => {
      const m = new Mesh(this.geometry(new BoxGeometry(sx, sy, sz)), mat)
      m.position.set(x, y, z)
      m.castShadow = true
      m.receiveShadow = true
      return m
    }
    const walls = [
      box(w + 2 * WALL_T, WALL_H, WALL_T, cx, WALL_H / 2, h.minZ - WALL_T / 2, this.wallMat),
      box(w + 2 * WALL_T, WALL_H, WALL_T, cx, WALL_H / 2, h.maxZ + WALL_T / 2, this.wallMat),
      box(WALL_T, WALL_H, d, h.minX - WALL_T / 2, WALL_H / 2, cz, this.wallMat),
      box(WALL_T, WALL_H, d, h.maxX + WALL_T / 2, WALL_H / 2, cz, this.wallMat)
    ]
    const gantryD = GANTRY_MAX_Z - GANTRY_MIN_Z
    const deck = box(w, GANTRY_H, gantryD, cx, GANTRY_H / 2, (GANTRY_MIN_Z + GANTRY_MAX_Z) / 2, this.deckMat)
    const booth = box(BOOTH_W, BOOTH_H, BOOTH_D, BOOTH_CENTER.x, GANTRY_H + BOOTH_H / 2, BOOTH_CENTER.z, this.boothMat)
    booth.visible = false
    this.booth = booth

    this.hallMeshes = [floor, ...walls, deck, booth]
    this.scene.add(...this.hallMeshes)
    this.fitShadow()
    this.view = this.fitView()
    this.applyCamera()
  }

  /** Orthographic shadow box around the hall plus 2 m, along the key light. */
  private fitShadow(): void {
    const h = this.hall
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

  /**
   * Minimal fit (slice 1): the hall with 8 percent padding on each side, ppm clamped to 7..32, target at its centre.
   * At the target, one metre east spans H / (2 d tan(fov / 2)) px; one metre north is foreshortened by sin(pitch).
   */
  private fitView(): FactoryView {
    const b = this.hall
    const usableW = this.width * (1 - 2 * FIT_PADDING)
    const usableH = this.height * (1 - 2 * FIT_PADDING)
    const ppmX = usableW / (b.maxX - b.minX)
    const ppmZ = usableH / ((b.maxZ - b.minZ) * Math.sin(MathUtils.degToRad(PITCH_DEG)))
    const ppm = MathUtils.clamp(Math.min(ppmX, ppmZ), PPM_MIN, FIT_PPM_MAX)
    return { ppm, targetX: (b.minX + b.maxX) / 2, targetZ: (b.minZ + b.maxZ) / 2 }
  }

  private applyCamera(): void {
    const { ppm, targetX, targetZ } = this.view
    const distance = this.height / (2 * ppm * Math.tan(MathUtils.degToRad(FOV_DEG / 2)))
    const pitch = MathUtils.degToRad(PITCH_DEG)
    this.camera.position.set(targetX, distance * Math.sin(pitch), targetZ + distance * Math.cos(pitch))
    this.camera.lookAt(targetX, 0, targetZ)
    this.camera.near = Math.max(0.5, distance * 0.1)
    this.camera.far = distance * 4 + 200
    this.camera.updateProjectionMatrix()
  }
}

function frac(n: number): number {
  return n - Math.floor(n)
}

function push(ring: number[], value: number): void {
  ring.push(value)
  if (ring.length > FRAME_RING) ring.shift()
}
