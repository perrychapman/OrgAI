// Shared constants and the part constructor for the builders (Factory Floor, docs/design/factory-floor.md section 4).
import type { BufferGeometry } from 'three'
import type { LodBand, PartSpec } from './types'

/** Height of the gantry deck's top surface in metres. The booth, dock and board kits have their origin at this height. */
export const GANTRY_TOP = 1.5
/** Gantry deck extent in z (section 3.1). */
export const GANTRY_MIN_Z = -10
export const GANTRY_MAX_Z = -2
/** Station plate thickness: machines, robots, consoles and stack lights stand on its top at this height. */
export const PLATE_TOP = 0.1

export const ALL_LODS: readonly LodBand[] = ['near', 'mid', 'far']
export const NEAR_MID: readonly LodBand[] = ['near', 'mid']
export const NEAR_ONLY: readonly LodBand[] = ['near']
export const FAR_ONLY: readonly LodBand[] = ['far']

interface PartOptions {
  cast?: boolean
  receive?: boolean
  lods?: readonly LodBand[]
  instanceColor?: boolean
}

/** A part drawn in every LOD that casts and receives shadows unless the options say otherwise. */
export function part(key: string, geometry: BufferGeometry, role: string, options: PartOptions = {}): PartSpec {
  return {
    key,
    geometry,
    role,
    castShadow: options.cast ?? true,
    receiveShadow: options.receive ?? true,
    lods: options.lods ?? ALL_LODS,
    ...(options.instanceColor ? { instanceColor: true } : {})
  }
}
