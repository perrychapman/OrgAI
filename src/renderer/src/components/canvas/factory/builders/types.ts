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

/** A set of parts drawn together for one placed object (a station, a robot, a machine variant, a stack light). */
export interface ObjectKit {
  name: string
  parts: PartSpec[]
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
