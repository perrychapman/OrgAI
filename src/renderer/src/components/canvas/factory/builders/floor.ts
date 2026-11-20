// Floor slab with grid (Factory Floor section 4.6: a plane, two triangles, textured with the repeating grid tile).
import type { BufferGeometry } from 'three'
import { Float32BufferAttribute } from 'three'
import { quad } from './geo'
import { GRID_METRES } from './dataTextures'
import type { FloorRect } from './types'

/**
 * The floor of the hall at y = 0. UVs are world coordinates over the grid tile, so the grid lines fall on multiples of
 * 4 m whatever the rectangle (u grows east, v grows north) and the floor material needs no per-rect texture transform.
 */
export function floorGeometry(rect: FloorRect): BufferGeometry {
  const w = rect.maxX - rect.minX
  const d = rect.maxZ - rect.minZ
  const g = quad(w, d, (rect.minX + rect.maxX) / 2, 0, (rect.minZ + rect.maxZ) / 2)
  const pos = g.getAttribute('position')
  const uv: number[] = []
  for (let i = 0; i < pos.count; i++) uv.push(pos.getX(i) / GRID_METRES, -pos.getZ(i) / GRID_METRES)
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  return g
}
