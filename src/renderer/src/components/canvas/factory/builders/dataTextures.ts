// Procedural DataTextures (Factory Floor section 4.6: no image files, only small generated textures).
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace
} from 'three'

/** The grid tile is 64 px for 4 x 4 m: a faint line each metre, a strong one at the tile edge (every 4 m). */
export const GRID_PX = 64
export const GRID_METRES = 4
export const BLOB_PX = 32

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Fills RGBA bytes of the grid tile (pure, so tests can read it back). */
export function paintGridPixels(data: Uint8Array, floor: string, faint: string, strong: string): void {
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
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
}

/** The floor's repeating grid tile (sRGB, repeat wrapping, mipmapped). Repainted in place on a theme change. */
export function createGridTexture(floor: string, faint: string, strong: string, maxAnisotropy = 4): DataTexture {
  const data = new Uint8Array(GRID_PX * GRID_PX * 4)
  paintGridPixels(data, floor, faint, strong)
  const t = new DataTexture(data, GRID_PX, GRID_PX, RGBAFormat)
  t.colorSpace = SRGBColorSpace
  t.wrapS = RepeatWrapping
  t.wrapT = RepeatWrapping
  t.magFilter = LinearFilter
  t.minFilter = LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = Math.min(4, maxAnisotropy)
  t.needsUpdate = true
  return t
}

export function repaintGridTexture(t: DataTexture, floor: string, faint: string, strong: string): void {
  paintGridPixels(t.image.data as unknown as Uint8Array, floor, faint, strong)
  t.needsUpdate = true
}

/** Alpha of the blob shadow at normalised radius r (0 centre, 1 edge): a smooth falloff to zero. */
export function blobAlpha(r: number): number {
  if (r >= 1) return 0
  const k = 1 - r * r
  return k * k
}

/** White RGBA with a radial alpha falloff: multiplied by a black material colour it becomes a soft ground shadow. */
export function createBlobTexture(): DataTexture {
  const data = new Uint8Array(BLOB_PX * BLOB_PX * 4)
  const c = (BLOB_PX - 1) / 2
  for (let y = 0; y < BLOB_PX; y++) {
    for (let x = 0; x < BLOB_PX; x++) {
      const r = Math.hypot(x - c, y - c) / (BLOB_PX / 2)
      const i = (y * BLOB_PX + x) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = Math.round(255 * blobAlpha(r))
    }
  }
  const t = new DataTexture(data, BLOB_PX, BLOB_PX, RGBAFormat)
  t.wrapS = ClampToEdgeWrapping
  t.wrapT = ClampToEdgeWrapping
  t.magFilter = LinearFilter
  t.minFilter = LinearFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}
