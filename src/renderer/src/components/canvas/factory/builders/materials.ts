// Shared materials, one per palette role (Factory Floor sections 4.3, 9.2). `applyTheme` recolours them in place.
// Flat-shaded standard materials for faceted parts, smooth ones for round parts (metalness 0 to 0.2); lamps, screens,
// the selection ring, the vacant outline and the blob shadow are unlit basic materials.
import {
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type DataTexture,
  type Material
} from 'three'
import { FACTORY_PALETTE, type FactoryRoleColours } from '../../../../lib/factory/palette'
import { createBlobTexture, createGridTexture, repaintGridTexture } from './dataTextures'
import type { FactoryMaterials, FactoryTheme, FactoryTokenColours, MaterialRole } from './types'

type Kind = 'flat' | 'smooth' | 'basic'

interface RoleDef {
  /** Palette key; absent for roles whose colour is not in the role table. */
  colour?: keyof FactoryRoleColours
  kind: Kind
  roughness?: number
  metalness?: number
}

/** Every role the builders name on a part. */
const ROLES: Record<string, RoleDef> = {
  floor: { colour: 'floor', kind: 'flat', roughness: 0.95, metalness: 0 },
  wall: { colour: 'wall', kind: 'flat', roughness: 0.9, metalness: 0.05 },
  deck: { colour: 'deck', kind: 'flat', roughness: 0.8, metalness: 0.15 },
  deckEdge: { colour: 'deckEdge', kind: 'flat', roughness: 0.7, metalness: 0.1 },
  rail: { colour: 'rail', kind: 'flat', roughness: 0.55, metalness: 0.2 },
  booth: { colour: 'booth', kind: 'flat', roughness: 0.7, metalness: 0.15 },
  boothTrim: { colour: 'boothTrim', kind: 'flat', roughness: 0.6, metalness: 0.2 },
  glass: { colour: 'glass', kind: 'smooth', roughness: 0.15, metalness: 0.1 },
  screen: { colour: 'screen', kind: 'basic' },
  plate: { colour: 'plate', kind: 'flat', roughness: 0.85, metalness: 0.1 },
  console: { colour: 'console', kind: 'flat', roughness: 0.65, metalness: 0.15 },
  machine: { colour: 'machine', kind: 'flat', roughness: 0.6, metalness: 0.2 },
  machinePanel: { colour: 'machinePanel', kind: 'flat', roughness: 0.55, metalness: 0.2 },
  belt: { colour: 'belt', kind: 'flat', roughness: 0.95, metalness: 0 },
  rollers: { colour: 'rollers', kind: 'smooth', roughness: 0.5, metalness: 0.2 },
  dock: { colour: 'dock', kind: 'flat', roughness: 0.85, metalness: 0.1 },
  dockSlot: { colour: 'dockSlot', kind: 'flat', roughness: 0.95, metalness: 0 },
  hazard: { colour: 'hazard', kind: 'flat', roughness: 0.8, metalness: 0 },
  bollard: { colour: 'bollard', kind: 'smooth', roughness: 0.7, metalness: 0.05 },
  boardPanel: { colour: 'boardPanel', kind: 'flat', roughness: 0.5, metalness: 0.1 },
  pole: { colour: 'pole', kind: 'smooth', roughness: 0.6, metalness: 0.2 },
  'robot.body': { colour: 'robotBody', kind: 'flat', roughness: 0.55, metalness: 0.1 },
  'robot.base': { colour: 'robotBase', kind: 'flat', roughness: 0.7, metalness: 0.15 },
  'robot.joint': { colour: 'robotJoint', kind: 'smooth', roughness: 0.6, metalness: 0.2 },
  'robot.visor': { colour: 'robotVisor', kind: 'smooth', roughness: 0.2, metalness: 0.2 },
  'robot.wheel': { colour: 'robotWheel', kind: 'smooth', roughness: 0.9, metalness: 0 },
  /** Far-LOD capsule: unlit (a few pixels wide, so lighting must not decide its contrast against the floor). */
  'robot.far': { colour: 'robotFar', kind: 'basic' },
  crate: { colour: 'crate', kind: 'flat', roughness: 0.8, metalness: 0 },
  /** Slice 4 carriers: the work-order tote and the tool part are faceted, the message capsule is round. */
  tote: { colour: 'tote', kind: 'flat', roughness: 0.75, metalness: 0.05 },
  capsule: { colour: 'capsule', kind: 'smooth', roughness: 0.4, metalness: 0.1 },
  part: { colour: 'part', kind: 'flat', roughness: 0.6, metalness: 0.2 },
  /** Slice 6: the carriers' contrasting second tone (tote liner, capsule band). */
  carrierBand: { colour: 'carrierBand', kind: 'flat', roughness: 0.6, metalness: 0.05 },
  paint: { colour: 'paint', kind: 'flat', roughness: 0.9, metalness: 0 },
  /** Dark marks printed on a paint decal (the lead's line plate): offset further than the paint. */
  paintMark: { colour: 'belt', kind: 'flat', roughness: 0.9, metalness: 0 },
  vacant: { colour: 'vacant', kind: 'basic' },
  /** Lit lamps and the board lamps: white unlit; the engine multiplies it by instanceColor. */
  lamp: { kind: 'basic' },
  /** Selection ring: colour comes from the accent token, not the palette. */
  ring: { kind: 'basic' },
  /** Moving things' ground shadow: black, alpha from a radial DataTexture. */
  blob: { colour: 'blob', kind: 'basic' }
}

export const MATERIAL_ROLES: readonly MaterialRole[] = Object.keys(ROLES)

/**
 * Blob shadow strength (material opacity) per theme. Slice 4: black on the dark floor (#272c37) at 0.38 was nearly
 * invisible under a capsule or tote in flight, so dark takes a stronger value; on the pale light floor 0.38 reads as is.
 */
const BLOB_OPACITY: Record<FactoryTheme, number> = { dark: 0.62, light: 0.4 }

export function createMaterials(theme: FactoryTheme, tokens: FactoryTokenColours): FactoryMaterials {
  const palette0 = FACTORY_PALETTE[theme]
  const materials = new Map<MaterialRole, Material>()
  const textures: DataTexture[] = []

  const grid = createGridTexture(palette0.roles.floor, palette0.gridFaint, palette0.gridStrong)
  textures.push(grid)
  const blobTexture = createBlobTexture()
  textures.push(blobTexture)

  for (const [role, def] of Object.entries(ROLES)) {
    let m: Material
    if (def.kind === 'basic') {
      m = new MeshBasicMaterial({ color: '#ffffff' })
    } else {
      m = new MeshStandardMaterial({
        color: '#ffffff',
        flatShading: def.kind === 'flat',
        roughness: def.roughness ?? 0.8,
        metalness: def.metalness ?? 0.1
      })
    }
    m.name = `factory.${role}`
    materials.set(role, m)
  }

  // Role-specific state that does not change with the theme.
  const std = (role: string): MeshStandardMaterial => materials.get(role) as MeshStandardMaterial
  const basic = (role: string): MeshBasicMaterial => materials.get(role) as MeshBasicMaterial
  std('floor').map = grid
  const glass = std('glass')
  glass.transparent = true
  glass.opacity = 0.32
  glass.depthWrite = false
  glass.side = DoubleSide
  // Flat floor decals sit 2 cm above the floor; polygon offset keeps them from z-fighting at distance.
  for (const role of ['paint', 'paintMark', 'vacant', 'ring', 'blob']) {
    const m = materials.get(role)!
    m.polygonOffset = true
    m.polygonOffsetFactor = -2
    m.polygonOffsetUnits = -4
  }
  const blob = basic('blob')
  blob.map = blobTexture
  blob.transparent = true
  blob.depthWrite = false
  basic('ring').depthWrite = false
  const mark = materials.get('paintMark')!
  mark.polygonOffsetFactor = -4
  mark.polygonOffsetUnits = -8

  const applyTheme = (next: FactoryTheme, nextTokens: FactoryTokenColours): void => {
    const p = FACTORY_PALETTE[next]
    for (const [role, def] of Object.entries(ROLES)) {
      if (def.colour) (materials.get(role) as MeshBasicMaterial).color.set(p.roles[def.colour])
    }
    // The floor's colour lives in the grid tile; its material colour stays white so the tile shows as painted.
    ;(materials.get('floor') as MeshStandardMaterial).color.set('#ffffff')
    repaintGridTexture(grid, p.roles.floor, p.gridFaint, p.gridStrong)
    basic('ring').color.set(nextTokens.accentText)
    basic('blob').opacity = BLOB_OPACITY[next]
  }
  applyTheme(theme, tokens)

  return {
    get(role: MaterialRole): Material {
      const m = materials.get(role)
      if (!m) throw new Error(`factory: unknown material role "${role}"`)
      return m
    },
    applyTheme,
    dispose(): void {
      for (const m of materials.values()) m.dispose()
      for (const t of textures) t.dispose()
      materials.clear()
    }
  }
}
