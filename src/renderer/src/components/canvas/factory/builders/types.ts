// Factory Floor builder contract (docs/design/factory-floor.md sections 4 and 10.2, slice 2). The Technical Artist owns
// builders/*.ts (shapes, materials, palette use, lights); the Scene Engineer's engine and engine/instancing.ts place the
// parts (where, how many, which LOD). Builders never decide placement; the engine never decides colour or shape.
// Change this file only by agreement between the two (and tell the UI Lead).
import type { BufferGeometry, Light, Material } from 'three'

export type FactoryTheme = 'dark' | 'light'

/** Section 4.5: near ppm >= 24, mid 12 to 24, far below 12. */
export type LodBand = 'near' | 'mid' | 'far'

/**
 * One material per palette role, shared by every mesh of that role (section 9.2). Builders may add roles; the engine
 * only looks materials up by the `role` named on a part.
 */
export type MaterialRole = string

/**
 * One repeated part of an object, in the object's local frame: origin at the object's footprint centre on the floor
 * (y = 0), +x east, +z south (the station front faces south, towards the camera), +y up, metres.
 * The engine makes one InstancedMesh per (kit, part key, LOD) and sets each instance's matrix to
 * objectMatrix * part.matrix (part.matrix is baked into the geometry when absent).
 */
export interface PartSpec {
  /** Stable within its kit, e.g. 'plate', 'console', 'robot.head'. */
  key: string
  geometry: BufferGeometry
  role: MaterialRole
  castShadow: boolean
  receiveShadow: boolean
  /** LOD bands this part is drawn in. A part listed for no band is never drawn. */
  lods: readonly LodBand[]
  /** Per-instance colour: the engine sets instanceColor (lamps lit with a status token colour). */
  instanceColor?: boolean
}

/** A point in an object's local frame where the engine attaches something else (a robot, a stack light, a label). */
export interface Anchor {
  x: number
  y: number
  z: number
  /** Rotation about +y in radians (0 faces south, towards the camera). */
  rotY: number
}

/** A set of parts drawn together for one placed object (a station, a robot, a machine variant, a stack light). */
export interface ObjectKit {
  name: string
  parts: PartSpec[]
  /**
   * Attachment points. Station kits name at least 'robot', 'machine', 'stackLight' and 'nameplate' (label anchor,
   * top of the tallest part); the booth names 'robot', 'stackLight' and 'nameplate'; dock and board name 'label'.
   */
  anchors?: Record<string, Anchor>
}

/** Axis-aligned floor rectangle in metres (same shape as lib/factory/types Bounds). */
export interface FloorRect {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

/**
 * Everything the engine needs from the builders. The Technical Artist exports one instance as `factoryKits` from
 * builders/index.ts; the engine receives it through its options so it can be swapped (the Scene Engineer's own
 * placeholder kits until the two branches are integrated). Geometry is built once per engine call and disposed by the
 * engine's registry; kits never hold global state.
 */
export interface FactoryKitSource {
  createMaterials(theme: FactoryTheme, tokens: FactoryTokenColours): FactoryMaterials
  createLighting(theme: FactoryTheme): FactoryLighting
  /** Renderer clear colour per theme (close to --surface-0). */
  clearColour(theme: FactoryTheme): string
  /** Colour an unlit stack-light lamp gets through instanceColor. */
  lampOffColour(theme: FactoryTheme): string
  /** Hall shell for these bounds: floor slab with grid, walls and pillars, gantry deck (z -10 to -2), stairs, railing. */
  hall(hall: FloorRect): ObjectKit
  /** Origin at the booth centre (7, -6), on the gantry deck's top surface. */
  booth(): ObjectKit
  dock(): ObjectKit
  board(): ObjectKit
  /** 3 x 3 m station (plate, console, outfeed belt, rollers near only); 'lead' swaps the machine for a dispatch desk and line plate. */
  station(kind: 'lead' | 'bench'): ObjectKit
  /** Machine silhouettes 0 press, 1 arm, 2 spindle, 3 frame; far LOD is the bounding block with the top profile. */
  machine(variant: 0 | 1 | 2 | 3): ObjectKit
  /** Pole plus 'lamp.top', 'lamp.middle', 'lamp.bottom' parts with instanceColor. */
  stackLight(): ObjectKit
  /** Wheeled robot about 1.4 m tall in its rest pose; near parts and a far 120-triangle capsule-with-visor. */
  robot(): ObjectKit
  /** Flat props: 'paint' (1 x 1 m unit quad the engine scales along route segments), 'vacant' outline, 'ring' selection ring. */
  props(): ObjectKit
}

/** Shared materials for one engine. `applyTheme` updates colours in place (no rebuild, section 4.3). */
export interface FactoryMaterials {
  get(role: MaterialRole): Material
  applyTheme(theme: FactoryTheme, tokens: FactoryTokenColours): void
  dispose(): void
}

/** Status token colours read by the engine through getComputedStyle (section 4.3: lamps and the selection ring). */
export interface FactoryTokenColours {
  success: string
  warning: string
  danger: string
  accentText: string
}

/** Lights of the hall (section 4.2). The engine adds `lights` to the scene and points the shadow camera at the hall. */
export interface FactoryLighting {
  lights: Light[]
  /** The key DirectionalLight that casts shadows. */
  key: Light
  applyTheme(theme: FactoryTheme, dim: 'on' | 'paused' | 'ended'): void
  dispose(): void
}
