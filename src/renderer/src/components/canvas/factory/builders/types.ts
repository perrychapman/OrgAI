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
 * builders/index.ts; the engine receives it through its options so it can be swapped (FactoryCanvas passes
 * `factoryKits`; tests may pass their own). Geometry is built once per engine call and disposed by the
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

  // ---- Slice 3: state props (section 1.4 static end states, 4.4, 4.6). Optional until the Technical Artist lands them;
  // the engine skips a missing kit. Each is placed by the engine at a station kit anchor (below), or at the origin of
  // the station frame where none is named; geometry is in that anchor's frame (origin on the surface it stands on,
  // front +z). All are static (cast shadows where section 4.2 allows: shutter, fence, barrier; crates use a blob).
  //
  // Station kit anchors added in slice 3 (both 'lead' and 'bench'; the booth names those it supports):
  //   'shutter'        where shutter() goes: over the machine (bench) or the dispatch desk (lead)
  //   'barrier'        where barrier() goes: across the station front (south edge of the plate)
  //   'pad'            the outfeed pad: where the agent's own crate sits (merging, review, waiting-children)
  //   'hold'           the hold pad beside the station (conflict striped, held plain); holdPad() goes here
  //   'inbox'          where crates merged INTO this station from its reports sit ('parent-pad'); the engine offsets
  //                    further crates by `CRATE_PITCH` east then south (up to 4 drawn, a count is DOM only)
  //   'robot'          (exists) console pose; 'robot.machine', 'robot.dispatch' (lead only), 'robot.rest' (beside the
  //                    station, idle), 'robot.dock' (docked spot, finished). rotY gives the facing for that pose.
  // Dock: 'slot.0'..'slot.8' (exist) for crates. Board: 'lamp.0'..'lamp.11' (exist) for boardLamp() instances.

  /** Roll-down shutter, lowered (end state), sized to cover the machine or desk. */
  shutter?(): ObjectKit
  /** Striped barrier, down (end state), spanning the station front. Stripes are geometry, not texture. */
  barrier?(): ObjectKit
  /** Low mesh fence enclosing the station plate on its west, north and east sides (an isolated work cell). */
  fence?(): ObjectKit
  /** One crate, origin at its bottom centre. */
  crate?(): ObjectKit
  /** Hold pad on the floor beside the station; `striped` adds hazard stripes (merge conflict). */
  holdPad?(striped: boolean): ObjectKit
  /**
   * One plan-board step lamp in the board frame, origin at a `lamp.i` anchor, facing the panel normal. One part with
   * `instanceColor` (the lens); slice 3's board() no longer carries the merged 'board.lamps' part.
   */
  boardLamp?(): ObjectKit
  /** Lens colour for a plan step lamp per step state (lit pending is off; blocked uses the warning token). */
  boardLampColour?(theme: FactoryTheme, state: 'pending' | 'active' | 'done' | 'blocked' | 'skipped', tokens: FactoryTokenColours): string
}

/** Spacing between crates on an 'inbox' pad, metres. */
export const CRATE_PITCH = 0.8

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
