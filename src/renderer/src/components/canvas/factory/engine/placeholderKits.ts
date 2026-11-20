// Placeholder kits (Scene Engineer, slice 2): plain boxes implementing the builder contract (builders/types.ts) so the
// engine runs and can be measured before the Technical Artist's builders/index.ts `factoryKits` is integrated.
// FactoryCanvas imports this in one line; the integration swaps that line for the real kits. Not art: sizes follow
// section 3.1 and the agreed anchors; colours are section 4.3's starting values.
import {
  AmbientLight,
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  HemisphereLight,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  type BufferGeometry,
  type Material
} from 'three'
import type {
  FactoryKitSource,
  FactoryLighting,
  FactoryMaterials,
  FactoryTheme,
  FactoryTokenColours,
  FloorRect,
  LodBand,
  ObjectKit,
  PartSpec
} from '../builders/types'

const GANTRY_MIN_Z = -10
const GANTRY_MAX_Z = -2
const GANTRY_TOP = 1.5
const WALL_H = 1.2
const WALL_T = 0.3

const ALL: readonly LodBand[] = ['near', 'mid', 'far']
const NEAR_MID: readonly LodBand[] = ['near', 'mid']
const FAR: readonly LodBand[] = ['far']

const PALETTE: Record<FactoryTheme, Record<string, string>> = {
  dark: {
    clear: '#0e1118', floor: '#2a2f3a', wall: '#1f2430', deck: '#3a4252', plate: '#3a4252', machine: '#5a657b', panel: '#7c8aa5',
    belt: '#1b1f27', rollers: '#6b7385', robot: '#c9d1e0', joint: '#3d4556', visor: '#11141a', paint: '#b8932a', vacant: '#6b7385',
    lampOff: '#2f3542', pole: '#3d4556', dock: '#3a4252', board: '#1f2430', booth: '#5a657b', blob: '#000000'
  },
  light: {
    clear: '#eef0f4', floor: '#d6d9df', wall: '#e2e5ea', deck: '#b4bbc7', plate: '#b9c0cc', machine: '#8d97a8', panel: '#6c7689',
    belt: '#3a3f48', rollers: '#9aa2b1', robot: '#3f4a5e', joint: '#c7ceda', visor: '#11141a', paint: '#c99a1a', vacant: '#7d8696',
    lampOff: '#a9b0bc', pole: '#6c7689', dock: '#b4bbc7', board: '#3a3f48', booth: '#8d97a8', blob: '#000000'
  }
}
const LIGHTS: Record<FactoryTheme, { sky: string; ground: string; hemi: number; key: string; keyI: number; ambient: number }> = {
  dark: { sky: '#9fb3d1', ground: '#1a1d24', hemi: 0.55, key: '#ffffff', keyI: 1.4, ambient: 0.15 },
  light: { sky: '#ffffff', ground: '#b9bec8', hemi: 0.9, key: '#fff7ea', keyI: 1.8, ambient: 0.25 }
}
const DIM: Record<FactoryTheme, number> = { dark: 0.55, light: 0.7 }

const STANDARD_ROLES = ['floor', 'wall', 'deck', 'plate', 'machine', 'panel', 'belt', 'rollers', 'robot', 'joint', 'visor', 'pole', 'dock', 'board', 'booth']

function createMaterials(theme: FactoryTheme, tokens: FactoryTokenColours): FactoryMaterials {
  const map = new Map<string, Material>()
  for (const role of STANDARD_ROLES) map.set(role, new MeshStandardMaterial({ roughness: 0.85, metalness: 0.1, flatShading: true }))
  // Lit lamps: unlit white, coloured per instance.
  map.set('lamp', new MeshBasicMaterial({ color: '#ffffff' }))
  map.set('paint', new MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }))
  map.set('vacant', new MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }))
  map.set('ring', new MeshBasicMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))
  map.set('blob', new MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }))
  const apply = (t: FactoryTheme, tok: FactoryTokenColours): void => {
    const p = PALETTE[t]
    for (const [role, m] of map) {
      const colour = role === 'ring' ? tok.accentText : role === 'lamp' ? '#ffffff' : p[role]
      if (colour && 'color' in m) (m as MeshStandardMaterial).color.set(colour)
    }
  }
  apply(theme, tokens)
  return {
    get: (role) => {
      const m = map.get(role)
      if (!m) throw new Error(`No placeholder material for role ${role}`)
      return m
    },
    applyTheme: apply,
    dispose: () => {
      for (const m of map.values()) m.dispose()
      map.clear()
    }
  }
}

function createLighting(theme: FactoryTheme): FactoryLighting {
  const hemi = new HemisphereLight()
  const key = new DirectionalLight()
  const ambient = new AmbientLight('#ffffff')
  const apply = (t: FactoryTheme, dim: 'on' | 'paused' | 'ended'): void => {
    const l = LIGHTS[t]
    const k = dim === 'on' ? 1 : DIM[t]
    hemi.color.set(l.sky)
    hemi.groundColor.set(l.ground)
    hemi.intensity = l.hemi * k
    key.color.set(l.key)
    key.intensity = l.keyI * k
    ambient.intensity = l.ambient * k
  }
  apply(theme, 'on')
  return {
    lights: [hemi, key, ambient],
    key,
    applyTheme: apply,
    dispose: () => {
      hemi.dispose()
      key.dispose()
      ambient.dispose()
    }
  }
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): BufferGeometry {
  return new BoxGeometry(w, h, d).translate(x, y + h / 2, z)
}
function part(key: string, geometry: BufferGeometry, role: string, lods: readonly LodBand[] = ALL, cast = true, extra: Partial<PartSpec> = {}): PartSpec {
  return { key, geometry, role, castShadow: cast, receiveShadow: true, lods, ...extra }
}

function hall(r: FloorRect): ObjectKit {
  const w = r.maxX - r.minX
  const d = r.maxZ - r.minZ
  const cx = (r.minX + r.maxX) / 2
  const cz = (r.minZ + r.maxZ) / 2
  const floor = new PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(cx, 0, cz)
  return {
    name: 'hall',
    parts: [
      part('hall.floor', floor, 'floor', ALL, false),
      part('hall.wall.n', box(w + 2 * WALL_T, WALL_H + GANTRY_TOP, WALL_T, cx, 0, r.minZ - WALL_T / 2), 'wall'),
      part('hall.wall.s', box(w + 2 * WALL_T, WALL_H, WALL_T, cx, 0, r.maxZ + WALL_T / 2), 'wall'),
      part('hall.wall.w', box(WALL_T, WALL_H, d, r.minX - WALL_T / 2, 0, cz), 'wall'),
      part('hall.wall.e', box(WALL_T, WALL_H, d, r.maxX + WALL_T / 2, 0, cz), 'wall'),
      part('hall.deck', box(w, GANTRY_TOP, GANTRY_MAX_Z - GANTRY_MIN_Z, cx, 0, (GANTRY_MIN_Z + GANTRY_MAX_Z) / 2), 'deck')
    ],
    anchors: {
      booth: { x: 7, y: GANTRY_TOP, z: -6, rotY: 0 },
      dock: { x: 17, y: GANTRY_TOP, z: -6, rotY: 0 },
      board: { x: 25, y: GANTRY_TOP, z: -9.5, rotY: 0 }
    }
  }
}

function booth(): ObjectKit {
  return {
    name: 'booth',
    parts: [
      part('booth.base', box(6, 0.2, 4, 0, 0, 0), 'plate'),
      part('booth.desk', box(3, 0.8, 0.8, 0, 0.2, -0.8), 'machine'),
      part('booth.back', box(6, 2.6, 0.2, 0, 0.2, -1.9), 'booth')
    ],
    anchors: {
      robot: { x: 0, y: 0.2, z: 0.4, rotY: Math.PI },
      stackLight: { x: 2.6, y: 0.2, z: -1.5, rotY: 0 },
      nameplate: { x: 0, y: 3.2, z: 0, rotY: 0 }
    }
  }
}

function dock(): ObjectKit {
  return { name: 'dock', parts: [part('dock.platform', box(6, 0.3, 4, 0, 0, 0), 'dock')], anchors: { label: { x: 0, y: 0.6, z: 0, rotY: 0 } } }
}
function board(): ObjectKit {
  return { name: 'board', parts: [part('board.panel', box(6, 3, 0.3, 0, 0, 0), 'board')], anchors: { label: { x: 0, y: 3.4, z: 0, rotY: 0 } } }
}

function station(kind: 'lead' | 'bench'): ObjectKit {
  const p = kind === 'lead' ? 'lead' : 'station'
  const parts = [
    part(`${p}.plate`, box(3, 0.12, 3, 0, 0, 0), 'plate'),
    part(`${p}.console`, box(0.8, 1.1, 0.5, -0.9, 0.12, 0.6), 'panel'),
    part(`${p}.belt`, box(3, 0.45, 1, 0, 0, 2), 'belt'),
    part('belt.rollers', new CylinderGeometry(0.08, 0.08, 1, 8).rotateX(Math.PI / 2).translate(0, 0.5, 2), 'rollers', ['near'])
  ]
  if (kind === 'lead') parts.push(part('lead.desk', box(1.8, 0.8, 0.9, 0.2, 0.12, -0.5), 'machine'))
  return {
    name: `station.${kind}`,
    parts,
    anchors: {
      robot: { x: 0.2, y: 0.12, z: 0.7, rotY: Math.PI },
      machine: { x: 0.2, y: 0.12, z: -0.5, rotY: 0 },
      stackLight: { x: 1.3, y: 0.12, z: -1.3, rotY: 0 },
      nameplate: { x: 0, y: 2.6, z: 0, rotY: 0 }
    }
  }
}

function machine(variant: 0 | 1 | 2 | 3): ObjectKit {
  const h = [1.8, 1.4, 1.2, 1.6][variant]
  const w = [1.4, 1.2, 1.0, 1.8][variant]
  const body = variant === 2 ? new CylinderGeometry(0.5, 0.5, h, 12).translate(0, h / 2, 0) : box(w, h, 1, 0, 0, 0)
  return {
    name: `machine.${variant}`,
    parts: [
      part(`machine.${variant}.body`, body, 'machine', NEAR_MID),
      part(`machine.${variant}.top`, box(w * 0.6, 0.25, 0.6, 0, h, 0), 'panel', NEAR_MID),
      part(`machine.${variant}.far`, box(w, h, 1, 0, 0, 0), 'machine', FAR)
    ]
  }
}

function stackLight(): ObjectKit {
  const lamp = (y: number): BufferGeometry => new CylinderGeometry(0.12, 0.12, 0.18, 12).translate(0, y, 0)
  return {
    name: 'stackLight',
    parts: [
      part('stack.pole', new CylinderGeometry(0.04, 0.04, 1.6, 8).translate(0, 0.8, 0), 'pole'),
      part('lamp.bottom', lamp(1.69), 'lamp', ALL, false, { instanceColor: true }),
      part('lamp.middle', lamp(1.89), 'lamp', ALL, false, { instanceColor: true }),
      part('lamp.top', lamp(2.09), 'lamp', ALL, false, { instanceColor: true })
    ]
  }
}

function robot(): ObjectKit {
  return {
    name: 'robot',
    parts: [
      part('robot.chassis', box(0.7, 0.3, 0.7, 0, 0, 0), 'joint', NEAR_MID, false),
      part('robot.torso', box(0.55, 0.65, 0.4, 0, 0.3, 0), 'robot', NEAR_MID, false),
      part('robot.head', box(0.4, 0.3, 0.35, 0, 1.0, 0), 'robot', NEAR_MID, false),
      part('robot.visor', box(0.32, 0.1, 0.05, 0, 1.12, 0.18), 'visor', NEAR_MID, false),
      part('robot.far.body', box(0.6, 1.3, 0.5, 0, 0, 0), 'robot', FAR, false)
    ]
  }
}

function props(): ObjectKit {
  const flat = (g: BufferGeometry): BufferGeometry => g.rotateX(-Math.PI / 2).translate(0, 0.02, 0)
  return {
    name: 'props',
    parts: [
      part('paint', flat(new PlaneGeometry(1, 1)), 'paint', ALL, false),
      part('vacant', flat(new RingGeometry(1.45 * Math.SQRT2, 1.55 * Math.SQRT2, 4, 1, Math.PI / 4)), 'vacant', ALL, false),
      part('ring', flat(new RingGeometry(1.7, 1.85, 48)), 'ring', ALL, false),
      part('blob', flat(new PlaneGeometry(1, 1)), 'blob', ALL, false)
    ]
  }
}

export const placeholderKits: FactoryKitSource = {
  createMaterials,
  createLighting,
  clearColour: (theme) => PALETTE[theme].clear,
  lampOffColour: (theme) => PALETTE[theme].lampOff,
  hall,
  booth,
  dock,
  board,
  station,
  machine,
  stackLight,
  robot,
  props
}
