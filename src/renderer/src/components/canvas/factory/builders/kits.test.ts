// Builds every Factory Floor kit in node (three needs no GL context for geometry and materials) and checks the budgets of
// docs/design/factory-floor.md sections 4.6 and 9.1, the material roles, the anchors the engine reads and the shapes.
import { Box3, Color, MeshBasicMaterial, MeshStandardMaterial, type BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import { FACTORY_PALETTE, contrastRatio, relativeLuminance } from '../../../../lib/factory/palette'
import { triangles } from './geo'
import { factoryKits, KEY_DIRECTION, MATERIAL_ROLES } from './index'
import { boardLampPosition } from './board'
import { CRATE_PITCH } from './types'
import type { FactoryTokenColours, FloorRect, LodBand, ObjectKit } from './types'

const TOKENS: FactoryTokenColours = { success: '#22c58b', warning: '#f5a524', danger: '#ff6b6b', accentText: '#a592ff' }
const HALL: FloorRect = { minX: 0, maxX: 38, minZ: -10, maxZ: 29 }
const BANDS: LodBand[] = ['near', 'mid', 'far']
const VARIANTS = [0, 1, 2, 3] as const

const hall = factoryKits.hall(HALL)
const booth = factoryKits.booth()
const dock = factoryKits.dock()
const board = factoryKits.board()
const bench = factoryKits.station('bench')
const lead = factoryKits.station('lead')
const machines = VARIANTS.map((v) => factoryKits.machine(v))
const stack = factoryKits.stackLight()
const robot = factoryKits.robot()
const props = factoryKits.props()
const all: ObjectKit[] = [hall, booth, dock, board, bench, lead, ...machines, stack, robot, props]

/** Triangles of a kit drawn in one LOD band. */
function tris(kit: ObjectKit, band: LodBand): number {
  return kit.parts.filter((p) => p.lods.includes(band)).reduce((n, p) => n + triangles(p.geometry), 0)
}
function partTris(kit: ObjectKit, key: string): number {
  const p = kit.parts.find((x) => x.key === key)
  if (!p) throw new Error(`no part ${key} in ${kit.name}`)
  return triangles(p.geometry)
}
function bounds(g: BufferGeometry): Box3 {
  g.computeBoundingBox()
  return g.boundingBox!.clone()
}
function kitBounds(kit: ObjectKit, band: LodBand): Box3 {
  const b = new Box3()
  for (const p of kit.parts) if (p.lods.includes(band)) b.union(bounds(p.geometry))
  return b
}

describe('kit structure', () => {
  it('names every kit and gives each part a unique key within its kit', () => {
    for (const kit of all) {
      expect(kit.name.length).toBeGreaterThan(0)
      const keys = kit.parts.map((p) => p.key)
      expect(new Set(keys).size, kit.name).toBe(keys.length)
    }
    expect(new Set(all.map((k) => k.name)).size).toBe(all.length)
  })

  it('has non-empty finite geometry with position, normal and uv, and at least one LOD per part', () => {
    for (const kit of all) {
      for (const p of kit.parts) {
        const id = `${kit.name}/${p.key}`
        expect(p.lods.length, id).toBeGreaterThan(0)
        for (const l of p.lods) expect(BANDS, id).toContain(l)
        const pos = p.geometry.getAttribute('position')
        expect(pos.count, id).toBeGreaterThan(0)
        expect(pos.count % 3, id).toBe(0)
        expect(p.geometry.getAttribute('normal'), id).toBeDefined()
        expect(p.geometry.getAttribute('uv'), id).toBeDefined()
        for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) throw new Error(`${id}: non-finite position`)
      }
    }
  })

  it('draws something in every LOD band', () => {
    for (const kit of all) {
      if (kit.name === 'props') continue
      for (const band of BANDS) expect(tris(kit, band), `${kit.name} ${band}`).toBeGreaterThan(0)
    }
  })
})

describe('material roles', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`every part role resolves in createMaterials (${theme})`, () => {
      const m = factoryKits.createMaterials(theme, TOKENS)
      for (const kit of all) for (const p of kit.parts) expect(() => m.get(p.role), `${kit.name}/${p.key} ${p.role}`).not.toThrow()
      m.dispose()
    })
  }

  it('creates one shared material per role, flat or smooth, with metalness 0 to 0.2', () => {
    const m = factoryKits.createMaterials('dark', TOKENS)
    // 34 in slice 3, plus the tote, capsule and part roles of slice 4.
    expect(MATERIAL_ROLES.length).toBeLessThanOrEqual(40)
    for (const role of MATERIAL_ROLES) {
      const mat = m.get(role)
      expect(m.get(role)).toBe(mat)
      if (mat instanceof MeshStandardMaterial) {
        expect(mat.metalness, role).toBeGreaterThanOrEqual(0)
        expect(mat.metalness, role).toBeLessThanOrEqual(0.2)
      }
    }
    m.dispose()
  })

  it('throws on an unknown role', () => {
    const m = factoryKits.createMaterials('dark', TOKENS)
    expect(() => m.get('nope')).toThrow()
    m.dispose()
  })

  it('lamps are white unlit materials so instanceColor shows the status token as is', () => {
    const m = factoryKits.createMaterials('dark', TOKENS)
    const lamp = m.get('lamp')
    expect(lamp).toBeInstanceOf(MeshBasicMaterial)
    expect((lamp as MeshBasicMaterial).color.getHexString()).toBe('ffffff')
    for (const kit of [stack, factoryKits.boardLamp!(), factoryKits.crate!()]) {
      for (const p of kit.parts.filter((x) => x.role === 'lamp')) expect(p.instanceColor, p.key).toBe(true)
    }
    // Slice 4: the console screen is the one other instanceColor part (the engine multiplies its colour by a grey level).
    for (const kit of all) for (const p of kit.parts) if (p.instanceColor) expect(p.role, `${kit.name}/${p.key}`).toBe(p.screen ? 'screen' : 'lamp')
    m.dispose()
  })

  it('applyTheme recolours in place and the ring follows the accent token', () => {
    const m = factoryKits.createMaterials('dark', TOKENS)
    const body = m.get('robot.body') as MeshStandardMaterial
    const ring = m.get('ring') as MeshBasicMaterial
    expect(body.color.getHexString()).toBe(new Color(FACTORY_PALETTE.dark.roles.robotBody).getHexString())
    expect(ring.color.getHexString()).toBe(new Color(TOKENS.accentText).getHexString())
    m.applyTheme('light', { ...TOKENS, accentText: '#4f33d6' })
    expect(m.get('robot.body')).toBe(body)
    expect(body.color.getHexString()).toBe(new Color(FACTORY_PALETTE.light.roles.robotBody).getHexString())
    expect(ring.color.getHexString()).toBe(new Color('#4f33d6').getHexString())
    m.dispose()
  })

  it('decals use polygon offset and the glass is transparent without writing depth', () => {
    const m = factoryKits.createMaterials('light', TOKENS)
    for (const role of ['paint', 'paintMark', 'vacant', 'ring', 'blob']) expect(m.get(role).polygonOffset, role).toBe(true)
    const glass = m.get('glass')
    expect(glass.transparent).toBe(true)
    expect(glass.depthWrite).toBe(false)
    m.dispose()
  })
})

describe('lighting, clear colour and lamps', () => {
  it('has a hemisphere, one shadowed directional key and an ambient light, dimmed by state', () => {
    const l = factoryKits.createLighting('dark')
    expect(l.lights.length).toBe(3)
    expect(l.key.castShadow).toBe(true)
    expect(l.lights.filter((x) => x.castShadow).length).toBe(1)
    const on = l.key.intensity
    l.applyTheme('dark', 'paused')
    expect(l.key.intensity).toBeLessThan(on)
    const paused = l.key.intensity
    l.applyTheme('dark', 'ended')
    expect(l.key.intensity).toBeLessThanOrEqual(paused)
    l.applyTheme('light', 'on')
    expect(l.key.intensity).toBeCloseTo(FACTORY_PALETTE.light.light.keyIntensity)
    l.dispose()
  })

  it('lights from the north-west, pointing down and south-east', () => {
    expect(KEY_DIRECTION.x).toBeGreaterThan(0)
    expect(KEY_DIRECTION.y).toBeLessThan(0)
    expect(KEY_DIRECTION.z).toBeGreaterThan(0)
    expect(KEY_DIRECTION.length()).toBeCloseTo(1)
  })

  it('exposes clear and lamp-off colours per theme', () => {
    expect(factoryKits.clearColour('dark')).toBe(FACTORY_PALETTE.dark.clear)
    expect(factoryKits.clearColour('light')).toBe(FACTORY_PALETTE.light.clear)
    expect(factoryKits.lampOffColour('dark')).toBe(FACTORY_PALETTE.dark.lampOff)
    expect(factoryKits.lampOffColour('light')).toBe(FACTORY_PALETTE.light.lampOff)
  })
})

describe('triangle budgets (section 4.6)', () => {
  it('hall: floor 2, walls and pillars 400, gantry 1500', () => {
    expect(partTris(hall, 'hall.floor')).toBe(2)
    expect(partTris(hall, 'hall.walls')).toBeLessThanOrEqual(400)
    expect(partTris(hall, 'hall.deck') + partTris(hall, 'hall.edge') + partTris(hall, 'hall.rail')).toBeLessThanOrEqual(1500)
  })
  it('booth 2500, dock 800, board 600', () => {
    expect(tris(booth, 'near')).toBeLessThanOrEqual(2500)
    expect(tris(dock, 'near')).toBeLessThanOrEqual(800)
    expect(tris(board, 'near')).toBeLessThanOrEqual(600)
  })
  it('station: bench plate, console and belt 700; lead adds a 500 desk and plate', () => {
    expect(tris(bench, 'near')).toBeLessThanOrEqual(400 + 300)
    expect(tris(lead, 'near')).toBeLessThanOrEqual(400 + 300 + 500)
    expect(partTris(bench, 'belt.body') + partTris(bench, 'belt.rollers')).toBeLessThanOrEqual(300)
  })
  it('machines 900 each near, far a simple block', () => {
    for (const m of machines) {
      expect(tris(m, 'near'), m.name).toBeLessThanOrEqual(900)
      expect(tris(m, 'far'), m.name).toBeLessThanOrEqual(60)
      expect(tris(m, 'far'), m.name).toBeLessThan(tris(m, 'near'))
    }
  })
  it('stack light 200', () => {
    expect(tris(stack, 'near')).toBeLessThanOrEqual(200)
  })
  it('robot 1200 near and mid, at most 120 far', () => {
    expect(tris(robot, 'near')).toBeLessThanOrEqual(1200)
    expect(tris(robot, 'mid')).toBeLessThanOrEqual(1200)
    expect(tris(robot, 'far')).toBeLessThanOrEqual(120)
  })
  it('flat props: ring 64, vacant outline 32, paint and blob 2', () => {
    expect(partTris(props, 'ring')).toBeLessThanOrEqual(64)
    expect(partTris(props, 'vacant')).toBeLessThanOrEqual(32)
    expect(partTris(props, 'paint')).toBe(2)
    expect(partTris(props, 'blob')).toBe(2)
  })

  it('mid and far never draw more than near', () => {
    for (const kit of all) {
      expect(tris(kit, 'mid'), kit.name).toBeLessThanOrEqual(tris(kit, 'near'))
      expect(tris(kit, 'far'), kit.name).toBeLessThanOrEqual(tris(kit, 'near'))
    }
  })
})

describe('frame budget at 40 agents, near zoom (section 9.1)', () => {
  // 1 booth + 6 leads + 33 benches (the booth's agent counts among the 40), each worker with a robot and stack light;
  // machines spread over all four variants; a hall of 6 rows; every prop kind in use.
  const benches = 33
  const leads = 6
  const workers = 40
  const frameTris =
    tris(hall, 'near') +
    tris(booth, 'near') +
    tris(dock, 'near') +
    tris(board, 'near') +
    benches * tris(bench, 'near') +
    leads * tris(lead, 'near') +
    machines.reduce((n, m) => n + Math.ceil(benches / 4) * tris(m, 'near'), 0) +
    workers * (tris(robot, 'near') + tris(stack, 'near')) +
    40 * (partTris(props, 'ring') + partTris(props, 'blob'))

  it('stays within 250,000 triangles', () => {
    expect(frameTris).toBeLessThanOrEqual(250_000)
  })

  it('stays within 120 draw calls with room left for cues (at most 90 from the kits)', () => {
    // One InstancedMesh per (kit, part) in the current LOD; all four machine variants present.
    const drawn = [hall, booth, dock, board, bench, lead, ...machines, stack, robot, props]
    const calls = drawn.reduce((n, k) => n + k.parts.filter((p) => p.lods.includes('near')).length, 0)
    expect(calls).toBeLessThanOrEqual(90)
  })

  it('stays within 40 shadow calls', () => {
    const casters = all.reduce((n, k) => n + k.parts.filter((p) => p.castShadow && p.lods.includes('near')).length, 0)
    expect(casters).toBeLessThanOrEqual(40)
  })

  it('robots cast no shadow (blob shadows instead)', () => {
    for (const p of robot.parts) expect(p.castShadow, p.key).toBe(false)
  })

  it('records the numbers', () => {
    // Printed so the report can quote them; not an assertion.
    const row = (k: ObjectKit): string => `${k.name}: near ${tris(k, 'near')}, mid ${tris(k, 'mid')}, far ${tris(k, 'far')}, parts ${k.parts.length}`
    // eslint-disable-next-line no-console
    console.log([...all.map(row), ...stateKits.map(row), `frame at 40 agents near: ${frameTris} triangles`].join('\n'))
  })
})

describe('anchors the engine reads', () => {
  it('stations carry robot, machine, stackLight and nameplate anchors', () => {
    for (const kit of [bench, lead]) {
      for (const a of ['robot', 'machine', 'stackLight', 'nameplate']) expect(kit.anchors?.[a], `${kit.name} ${a}`).toBeDefined()
    }
  })

  it('the nameplate anchor is above the tallest part of the station and its attachments', () => {
    const top = Math.max(
      kitBounds(bench, 'near').max.y,
      kitBounds(lead, 'near').max.y,
      ...machines.map((m) => 0.1 + kitBounds(m, 'near').max.y),
      0.1 + kitBounds(stack, 'near').max.y,
      0.1 + kitBounds(robot, 'near').max.y
    )
    expect(bench.anchors!.nameplate.y).toBeGreaterThan(top)
    expect(lead.anchors!.nameplate.y).toBeGreaterThan(top)
  })

  it('the booth names robot, stackLight and nameplate; dock and board name a label', () => {
    for (const a of ['robot', 'stackLight', 'nameplate']) expect(booth.anchors?.[a], a).toBeDefined()
    expect(dock.anchors?.label).toBeDefined()
    expect(board.anchors?.label).toBeDefined()
    expect(board.anchors?.['lamp.11']).toBeDefined()
    expect(dock.anchors?.['slot.8']).toBeDefined()
  })

  it('the hall names the deck-top anchors of the booth, dock and board', () => {
    expect(hall.anchors?.booth).toMatchObject({ x: 7, y: 1.5, z: -6 })
    expect(hall.anchors?.dock).toMatchObject({ x: 17, y: 1.5, z: -6 })
    expect(hall.anchors?.board).toMatchObject({ x: 25, y: 1.5, z: -9.5 })
  })

  it('the robot lists the joint pivots poses rotate about', () => {
    for (const a of ['pivot.head', 'pivot.shoulder.l', 'pivot.shoulder.r', 'pivot.elbow.l', 'pivot.elbow.r']) expect(robot.anchors?.[a], a).toBeDefined()
  })

  it('stack light parts are lamp.top, lamp.middle and lamp.bottom with the top lamp highest', () => {
    const y = (key: string): number => bounds(stack.parts.find((p) => p.key === key)!.geometry).min.y
    expect(y('lamp.top')).toBeGreaterThan(y('lamp.middle'))
    expect(y('lamp.middle')).toBeGreaterThan(y('lamp.bottom'))
  })

  it('props name paint, vacant, ring and blob', () => {
    expect(props.parts.map((p) => p.key).sort()).toEqual(['blob', 'paint', 'ring', 'vacant'])
  })
})

describe('shapes', () => {
  it('the robot is about 1.4 m tall and fits a 1.2 x 0.9 m footprint (arms out)', () => {
    const b = kitBounds(robot, 'near')
    expect(b.max.y).toBeGreaterThan(1.35)
    expect(b.max.y).toBeLessThan(1.45)
    expect(b.min.y).toBeGreaterThanOrEqual(0)
    expect(b.max.x - b.min.x).toBeLessThan(1.2)
    expect(b.max.z - b.min.z).toBeLessThan(0.9)
    const far = kitBounds(robot, 'far')
    expect(far.max.y).toBeGreaterThan(1.2)
    expect(far.max.y).toBeLessThan(1.45)
  })

  it('machines fit the 1.5 x 1.2 m footprint and stay under 1.9 m', () => {
    for (const m of machines) {
      for (const band of ['near', 'far'] as const) {
        const b = kitBounds(m, band)
        expect(b.max.x - b.min.x, `${m.name} ${band} width`).toBeLessThanOrEqual(1.51)
        expect(b.max.z - b.min.z, `${m.name} ${band} depth`).toBeLessThanOrEqual(1.21)
        expect(b.max.y, `${m.name} ${band} height`).toBeLessThanOrEqual(1.9)
        expect(b.min.y).toBeGreaterThan(-1e-6)
      }
    }
  })

  it('the four machines have different silhouettes', () => {
    const sig = machines.map((m) => {
      const b = kitBounds(m, 'near')
      return [b.max.x - b.min.x, b.max.y, b.max.z - b.min.z, tris(m, 'near')].map((n) => n.toFixed(2)).join('/')
    })
    expect(new Set(sig).size).toBe(4)
  })

  it('a station stays inside its 3 m plate plus the belt strip to the south (the lead plaque reaches into the aisle)', () => {
    for (const kit of [bench, lead]) {
      const b = kitBounds(kit, 'near')
      expect(b.min.x).toBeGreaterThanOrEqual(-1.5 - 1e-6)
      expect(b.max.x).toBeLessThanOrEqual(1.5 + 1e-6)
      expect(b.min.z).toBeGreaterThanOrEqual(-1.5 - 1e-6)
    }
    expect(kitBounds(bench, 'near').max.z).toBeLessThanOrEqual(2.5 + 1e-6)
    // The lead's line plate stays out of the route paint (local z 4.0 +- 0.125) and the inbox.
    expect(kitBounds(lead, 'near').max.z).toBeLessThan(3.75)
  })

  it('the booth fills 6 x 4 m from the deck top, the dock 6 x 4 m', () => {
    const b = kitBounds(booth, 'near')
    expect(b.max.x - b.min.x).toBeCloseTo(6, 1)
    expect(b.max.z - b.min.z).toBeCloseTo(4, 1)
    expect(b.min.y).toBeGreaterThan(-1e-6)
    const d = kitBounds(dock, 'near')
    expect(d.max.x - d.min.x).toBeCloseTo(6, 1)
    expect(d.max.z - d.min.z).toBeCloseTo(4, 1)
  })

  it('the board panel leans clear of the north wall and the lamps sit on its face', () => {
    const b = kitBounds(board, 'near')
    // The origin is 0.5 m south of the wall's inner face (z -10); nothing may reach past it.
    expect(b.min.z).toBeGreaterThan(-0.5)
    for (let i = 0; i < 12; i++) {
      const p = boardLampPosition(i)
      expect(Math.abs(p.x)).toBeLessThan(3)
    }
  })

  it('the hall is for the rectangle it is given: gantry z -10 to -2 at 1.5 m, floor spans the rectangle', () => {
    const floor = bounds(hall.parts.find((p) => p.key === 'hall.floor')!.geometry)
    expect(floor.min.x).toBe(HALL.minX)
    expect(floor.max.x).toBe(HALL.maxX)
    expect(floor.min.z).toBe(HALL.minZ)
    expect(floor.max.z).toBe(HALL.maxZ)
    const deck = bounds(hall.parts.find((p) => p.key === 'hall.deck')!.geometry)
    expect(deck.min.z).toBeCloseTo(-10 - 0, 5)
    expect(deck.max.y).toBeCloseTo(1.5, 5)
    const bigger = factoryKits.hall({ ...HALL, maxX: 70 })
    expect(bounds(bigger.parts.find((p) => p.key === 'hall.floor')!.geometry).max.x).toBe(70)
  })

  it('floor UVs are world coordinates over the 4 m grid tile', () => {
    const g = hall.parts.find((p) => p.key === 'hall.floor')!.geometry
    const pos = g.getAttribute('position')
    const uv = g.getAttribute('uv')
    for (let i = 0; i < pos.count; i++) {
      expect(uv.getX(i)).toBeCloseTo(pos.getX(i) / 4)
      expect(uv.getY(i)).toBeCloseTo(-pos.getZ(i) / 4)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Slice 3: state props, station anchors, the conveyor, the lead's silhouette, the far robot.
// ---------------------------------------------------------------------------------------------------------------------

const shutter = factoryKits.shutter!()
const barrier = factoryKits.barrier!()
const fence = factoryKits.fence!()
const crate = factoryKits.crate!()
const holdPlain = factoryKits.holdPad!(false)
const holdStriped = factoryKits.holdPad!(true)
const boardLamp = factoryKits.boardLamp!()
const stateKits: ObjectKit[] = [shutter, barrier, fence, crate, holdPlain, holdStriped, boardLamp]

/** Axis-aligned XZ rectangle. */
interface Rect {
  x0: number
  x1: number
  z0: number
  z1: number
}
const rectAt = (cx: number, cz: number, w: number, d: number): Rect => ({ x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 })
const overlaps = (a: Rect, b: Rect): boolean => a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.z0 < b.z1 - 1e-6 && b.z0 < a.z1 - 1e-6
const within = (a: Rect, o: Rect): boolean => a.x0 >= o.x0 - 1e-6 && a.x1 <= o.x1 + 1e-6 && a.z0 >= o.z0 - 1e-6 && a.z1 <= o.z1 + 1e-6
/** Rect of a kit part's geometry placed at an anchor (no rotation). */
function partRect(kit: ObjectKit, key: string, at = { x: 0, z: 0 }): Rect {
  const b = bounds(kit.parts.find((p) => p.key === key)!.geometry)
  return { x0: b.min.x + at.x, x1: b.max.x + at.x, z0: b.min.z + at.z, z1: b.max.z + at.z }
}
// Chassis of the robot (0.76 x 0.66 m) is the footprint rule; arms in a pose are the engine's business.
const ROBOT_FOOT = { w: 0.76, d: 0.66 }
const CRATE_FOOT = { w: 0.7, d: 0.56 }
const GAP: Rect = { x0: 1.5, x1: 2.5, z0: -1.5, z1: 2.5 }
const PLATE_RECT: Rect = { x0: -1.5, x1: 1.5, z0: -1.5, z1: 1.5 }
/** The conveyor: frames to x 0.1 +- 0.455, belt z 0.4 to 2.1, the bin to 2.5. */
const BELT_RECT: Rect = { x0: -0.36, x1: 0.56, z0: 0.4, z1: 2.5 }
const anchorsOf = (k: ObjectKit): Record<string, { x: number; y: number; z: number; rotY: number }> => k.anchors!
const foot = (k: ObjectKit, name: string, f: { w: number; d: number }): Rect => rectAt(anchorsOf(k)[name].x, anchorsOf(k)[name].z, f.w, f.d)

describe('slice 3 state kits', () => {
  it('every optional kit builds and is exported on factoryKits', () => {
    for (const k of ['shutter', 'barrier', 'fence', 'crate', 'holdPad', 'boardLamp', 'boardLampColour'] as const) expect(factoryKits[k], k).toBeTypeOf('function')
  })

  it('has unique kit names and part keys, finite geometry, and roles that resolve', () => {
    expect(new Set([...all, ...stateKits].map((k) => k.name)).size).toBe(all.length + stateKits.length)
    for (const theme of ['dark', 'light'] as const) {
      const m = factoryKits.createMaterials(theme, TOKENS)
      for (const kit of stateKits) {
        const keys = kit.parts.map((p) => p.key)
        expect(new Set(keys).size, kit.name).toBe(keys.length)
        for (const p of kit.parts) {
          expect(() => m.get(p.role), `${kit.name}/${p.key}`).not.toThrow()
          const pos = p.geometry.getAttribute('position')
          expect(pos.count % 3, `${kit.name}/${p.key}`).toBe(0)
          expect(p.geometry.getAttribute('normal')).toBeDefined()
          expect(p.geometry.getAttribute('uv')).toBeDefined()
          for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) throw new Error(`${kit.name}/${p.key}: non-finite position`)
        }
      }
      m.dispose()
    }
  })

  it('triangle budgets: shutter 150, barrier 120, fence 300, crate 60, boardLamp 60, hold pads 40', () => {
    expect(tris(shutter, 'near')).toBeLessThanOrEqual(150)
    expect(tris(barrier, 'near')).toBeLessThanOrEqual(120)
    expect(tris(fence, 'near')).toBeLessThanOrEqual(300)
    expect(tris(crate, 'near')).toBeLessThanOrEqual(60)
    expect(tris(boardLamp, 'near')).toBeLessThanOrEqual(60)
    expect(tris(holdPlain, 'near')).toBeLessThanOrEqual(40)
    expect(tris(holdStriped, 'near')).toBeLessThanOrEqual(40)
    for (const k of stateKits) for (const band of BANDS) expect(tris(k, band), `${k.name} ${band}`).toBeGreaterThan(0)
  })

  it('shutter, barrier and fence cast shadows; the crate and pads use blob or none', () => {
    for (const k of [shutter, barrier, fence]) expect(k.parts.some((p) => p.castShadow), k.name).toBe(true)
    for (const k of [crate, holdPlain, holdStriped, boardLamp]) for (const p of k.parts) expect(p.castShadow, `${k.name}/${p.key}`).toBe(false)
  })

  it('crate: origin at the bottom centre, a lamp part with instanceColor, off-lamp readable', () => {
    const b = kitBounds(crate, 'near')
    expect(b.min.y).toBeCloseTo(0, 5)
    expect(b.min.x).toBeCloseTo(-b.max.x, 2)
    expect(b.min.z).toBeCloseTo(-b.max.z, 2)
    expect(b.max.x - b.min.x).toBeLessThanOrEqual(0.8 - 0.02)
    const lamp = crate.parts.find((p) => p.key === 'crate.lamp')!
    expect(lamp.instanceColor).toBe(true)
    expect(lamp.role).toBe('lamp')
    expect(bounds(lamp.geometry).min.y).toBeGreaterThanOrEqual(0.4)
    expect(crate.parts.filter((p) => p.instanceColor).length).toBe(1)
  })

  it('boardLamp is a lens part and a check-mark part, both with instanceColor, lying on the panel normal at its anchor', () => {
    expect(boardLamp.parts.map((p) => p.key)).toEqual(['boardLamp.lens', 'lamp.mark'])
    expect(boardLamp.parts[0]).toMatchObject({ key: 'boardLamp.lens', role: 'lamp', instanceColor: true })
    expect(boardLamp.parts[1]).toMatchObject({ key: 'lamp.mark', role: 'lamp', instanceColor: true })
    const b = bounds(boardLamp.parts[0].geometry)
    // Centred on the anchor, within 0.25 m of it in every direction.
    expect(Math.abs(b.min.x + b.max.x)).toBeLessThan(1e-3)
    expect(b.max.x).toBeLessThan(0.25)
    // The lens axis is the panel normal (0, 0.52, 0.85): its depth runs mostly along z and y, not x.
    expect(b.max.y).toBeLessThan(0.25)
    expect(b.max.z).toBeLessThan(0.25)
  })

  it('board() no longer carries a merged lamp part and keeps lamp.0 to lamp.11 with rotY 0', () => {
    expect(board.parts.map((p) => p.key).sort()).toEqual(['board.frame', 'board.panel'])
    for (let i = 0; i < 12; i++) {
      const a = board.anchors![`lamp.${i}`]
      expect(a, `lamp.${i}`).toBeDefined()
      expect(a.rotY).toBe(0)
      const p = boardLampPosition(i)
      expect(a).toMatchObject({ x: p.x, y: p.y, z: p.z })
    }
  })

  it('hold pads: plain has a paint outline, striped has hazard stripes as geometry', () => {
    expect(holdPlain.parts.map((p) => p.key).sort()).toEqual(['hold.edge', 'hold.pad'])
    expect(holdStriped.parts.map((p) => p.key).sort()).toEqual(['hold.pad', 'hold.stripes'])
    expect(holdStriped.parts.find((p) => p.key === 'hold.stripes')!.role).toBe('hazard')
    for (const k of [holdPlain, holdStriped]) {
      const b = kitBounds(k, 'near')
      expect(b.max.x - b.min.x).toBeLessThanOrEqual(1.0 - 0.05)
      expect(b.max.z - b.min.z).toBeLessThanOrEqual(1.0 - 0.05)
      expect(b.min.y).toBeGreaterThanOrEqual(-1e-6)
    }
  })

  it('barrier: stripes are hazard geometry, the arm spans the plate front over the belt', () => {
    expect(barrier.parts.find((p) => p.key === 'barrier.stripes')!.role).toBe('hazard')
    const b = kitBounds(barrier, 'near')
    expect(b.min.x).toBeGreaterThanOrEqual(-1.6)
    expect(b.max.x).toBeLessThanOrEqual(1.6)
    // The arm clears the belt frames (top 0.34 m) and the posts do not block the gap east of the plate.
    expect(bounds(barrier.parts[0].geometry).max.y).toBeGreaterThan(0.6)
    const stripes = bounds(barrier.parts.find((p) => p.key === 'barrier.stripes')!.geometry)
    expect(stripes.min.y).toBeGreaterThanOrEqual(0.5)
  })

  it('shutter covers a bench machine of every variant and the lead desk with its header, and clears the console and stack light', () => {
    const s = kitBounds(shutter, 'near')
    const a = anchorsOf(bench).shutter
    const world = { x0: s.min.x + a.x, x1: s.max.x + a.x, z0: s.min.z + a.z, z1: s.max.z + a.z }
    const m = anchorsOf(bench).machine
    for (const mk of machines) {
      const mb = kitBounds(mk, 'near')
      expect(within({ x0: mb.min.x + m.x, x1: mb.max.x + m.x, z0: mb.min.z + m.z, z1: mb.max.z + m.z }, world), mk.name).toBe(true)
      expect(mb.max.y + m.y).toBeLessThanOrEqual(a.y + s.max.y + 1e-6)
    }
    // The lead desk and the header board (the 'station.rim' part carries the header, the plate rim included).
    const header = bounds(lead.parts.find((p) => p.key === 'station.rim')!.geometry)
    expect(header.max.y).toBeLessThanOrEqual(a.y + s.max.y)
    // Not over the console (x -1.45..-0.75) nor the stack light (base reaches x 0.96).
    expect(world.x0).toBeGreaterThanOrEqual(-0.75 - 1e-6)
    expect(world.x1).toBeLessThanOrEqual(anchorsOf(bench).stackLight.x - 0.24 + 1e-6)
    expect(world.z1).toBeLessThan(BELT_RECT.z0)
    expect(s.min.y).toBeGreaterThanOrEqual(-1e-6)
  })

  it('fence: west, north and east on the plate edge, front open, clear of the stack light', () => {
    const b = kitBounds(fence, 'near')
    expect(b.min.x).toBeGreaterThanOrEqual(-1.6)
    expect(b.max.x).toBeLessThanOrEqual(1.6)
    expect(b.min.z).toBeGreaterThanOrEqual(-1.6)
    expect(b.max.z).toBeLessThanOrEqual(1.5 + 1e-6)
    expect(b.min.y).toBeGreaterThanOrEqual(0.1 - 1e-6)
    const pos = fence.parts[0].geometry.getAttribute('position')
    // Every north-edge vertex is on the plate's north side; none sits on the front (z > 1.5) or in the stack light's footprint.
    let north = 0
    for (let i = 0; i < pos.count; i++) {
      if (pos.getZ(i) < -1.4) north++
      if (Math.abs(pos.getZ(i)) < 0.25 && pos.getX(i) > 0) expect(pos.getX(i), 'stack light clearance').toBeGreaterThanOrEqual(1.2 + 0.19)
    }
    expect(north).toBeGreaterThan(20)
  })
})

describe('slice 3 station anchors', () => {
  const NAMES = ['shutter', 'barrier', 'pad', 'hold', 'inbox', 'robot.machine', 'robot.rest', 'robot.dock']

  it('lead and bench name every slice 3 anchor, finite, with robot.dispatch on the lead only', () => {
    for (const kit of [bench, lead]) {
      for (const n of NAMES) {
        const a = anchorsOf(kit)[n]
        expect(a, `${kit.name} ${n}`).toBeDefined()
        for (const v of [a.x, a.y, a.z, a.rotY]) expect(Number.isFinite(v)).toBe(true)
      }
    }
    expect(anchorsOf(lead)['robot.dispatch']).toBeDefined()
    expect(anchorsOf(bench)['robot.dispatch']).toBeUndefined()
  })

  it('the booth names inbox, pad, hold and its two robot spots; the old ones stay', () => {
    for (const n of ['inbox', 'pad', 'hold', 'robot.rest', 'robot.dock', 'robot', 'stackLight', 'nameplate']) expect(anchorsOf(booth)[n], n).toBeDefined()
  })

  it('robots face the camera at rest and dock, and face their work at the machine and the desk', () => {
    expect(anchorsOf(bench)['robot.rest'].rotY).toBe(0)
    expect(anchorsOf(bench)['robot.dock'].rotY).toBe(0)
    // North (rotY pi) or north-east: the forward vector (sin, cos) has a negative z.
    expect(Math.cos(anchorsOf(bench)['robot.machine'].rotY)).toBeLessThan(0)
    expect(Math.cos(anchorsOf(lead)['robot.dispatch'].rotY)).toBeLessThan(0)
  })

  for (const kit of [bench, lead]) {
    it(`${kit.name}: nothing overlaps the station's own parts, the neighbouring slot or the route paint`, () => {
      const rest = foot(kit, 'robot.rest', ROBOT_FOOT)
      const dock = foot(kit, 'robot.dock', ROBOT_FOOT)
      const pad = foot(kit, 'pad', CRATE_FOOT)
      const hold = rectAt(anchorsOf(kit).hold.x, anchorsOf(kit).hold.z, 0.9, 0.9)
      const machineSpot = foot(kit, 'robot.machine', { w: 0.7, d: 0.7 })
      // Inside the 1 m gap (dock, hold) or the station's own belt strip (rest, pad), never on the belt or in the next slot.
      expect(within(dock, GAP), 'dock in the gap').toBe(true)
      expect(within(hold, GAP), 'hold in the gap').toBe(true)
      expect(overlaps(dock, hold), 'dock and hold apart').toBe(false)
      for (const r of [rest, pad]) {
        expect(r.z0, 'belt strip').toBeGreaterThanOrEqual(1.5 - 1e-6)
        expect(r.z1).toBeLessThanOrEqual(2.5 + 1e-6)
        expect(overlaps(r, BELT_RECT)).toBe(false)
      }
      expect(overlaps(rest, pad)).toBe(false)
      expect(overlaps(machineSpot, BELT_RECT), 'machine spot off the belt').toBe(false)
      // Floor-level stand-ins stay off the plate edge (plate is x, z -1.5..1.5) except through the gap.
      expect(overlaps(rest, PLATE_RECT)).toBe(false)
      expect(overlaps(pad, PLATE_RECT)).toBe(false)
      // The barrier arm (z 1.57..1.67) and its feet (to x 1.55) stay out of the idle robot, the pad and the dock robot.
      const arm: Rect = { x0: -1.55, x1: 1.55, z0: 1.55, z1: 1.69 }
      for (const r of [rest, pad]) expect(overlaps(r, arm)).toBe(false)
      expect(overlaps(dock, { x0: 1.35, x1: 1.55, z0: 1.48, z1: 1.76 })).toBe(false)
      // Inbox crates: 2 x 2 at CRATE_PITCH east then south, below the belt strip, clear of the paint (z 3.75 to 4.25, x up to 0.125).
      const ia = anchorsOf(kit).inbox
      for (let i = 0; i < 4; i++) {
        const c = rectAt(ia.x + (i % 2) * CRATE_PITCH, ia.z + Math.floor(i / 2) * CRATE_PITCH, CRATE_FOOT.w, CRATE_FOOT.d)
        expect(c.z0, `inbox ${i} below the belt strip`).toBeGreaterThanOrEqual(2.5)
        expect(c.x0, `inbox ${i} east of the route paint`).toBeGreaterThan(0.25)
        expect(c.x1, `inbox ${i} inside the gap east`).toBeLessThanOrEqual(2.5)
        expect(overlaps(c, rest)).toBe(false)
        expect(overlaps(c, pad)).toBe(false)
      }
    })
  }

  it('the lead plaque does not overlap the inbox crates or the route paint; the rim sits on the plate', () => {
    const plaque = partRect(lead, 'station.plaque')
    const ia = anchorsOf(lead).inbox
    for (let i = 0; i < 4; i++) expect(overlaps(plaque, rectAt(ia.x + (i % 2) * CRATE_PITCH, ia.z + Math.floor(i / 2) * CRATE_PITCH, 0.7, 0.56))).toBe(false)
    expect(plaque.z0).toBeGreaterThanOrEqual(2.5)
    expect(plaque.z1).toBeLessThan(3.75)
    expect(plaque.x0).toBeGreaterThanOrEqual(-1.5)
    expect(overlaps(plaque, foot(lead, 'robot.rest', ROBOT_FOOT))).toBe(false)
    const rim = bounds(lead.parts.find((p) => p.key === 'station.rim')!.geometry)
    expect(rim.min.x).toBeGreaterThanOrEqual(-1.5)
    expect(rim.max.x).toBeLessThanOrEqual(1.5)
  })

  it('booth crates and pads stay on the deck between the booth and the dock, off the stack light', () => {
    const stackRect = rectAt(anchorsOf(booth).stackLight.x, anchorsOf(booth).stackLight.z, 0.5, 0.5)
    const ia = anchorsOf(booth).inbox
    const rects: Rect[] = [
      foot(booth, 'pad', CRATE_FOOT),
      rectAt(anchorsOf(booth).hold.x, anchorsOf(booth).hold.z, 0.9, 0.9)
    ]
    for (let i = 0; i < 4; i++) rects.push(rectAt(ia.x + (i % 2) * CRATE_PITCH, ia.z + Math.floor(i / 2) * CRATE_PITCH, 0.7, 0.56))
    for (const [i, r] of rects.entries()) {
      expect(r.x0, `rect ${i} east of the booth`).toBeGreaterThanOrEqual(3.0)
      expect(r.x1, `rect ${i} west of the dock (x 10 in the booth frame)`).toBeLessThanOrEqual(6.9)
      expect(r.z0, `rect ${i} on the deck`).toBeGreaterThanOrEqual(-2)
      expect(r.z1).toBeLessThanOrEqual(2.9)
      expect(overlaps(r, stackRect), `rect ${i} stack light`).toBe(false)
      for (let j = i + 1; j < rects.length; j++) expect(overlaps(r, rects[j]), `rect ${i} vs ${j}`).toBe(false)
    }
    // Rest and dock are inside the booth (x -3..3, z -2..2).
    for (const n of ['robot.rest', 'robot.dock']) {
      const r = foot(booth, n, ROBOT_FOOT)
      expect(within(r, { x0: -2.8, x1: 2.8, z0: -2, z1: 1.8 }), n).toBe(true)
    }
  })
})

describe('slice 3 conveyor and lead silhouette', () => {
  it('the conveyor has side frames in the console role and no evenly spaced rollers: only two end drums', () => {
    const drums = bench.parts.find((p) => p.key === 'belt.rollers')!
    // Two ten-sided drums: 80 triangles; the slice 2 rollers were a dozen cylinders.
    expect(triangles(drums.geometry)).toBeLessThanOrEqual(100)
    const d = bounds(drums.geometry)
    // Both drums lie across the belt (long in x, short in y and z) and sit at its two ends.
    expect(d.max.x - d.min.x).toBeGreaterThan(0.7)
    expect(d.max.y - d.min.y).toBeLessThan(0.2)
    expect(d.max.z - d.min.z).toBeGreaterThan(1.5)
    const belt = bounds(bench.parts.find((p) => p.key === 'belt.body')!.geometry)
    // One continuous belt slab: wide and long, thin.
    expect(belt.max.x - belt.min.x).toBeGreaterThan(0.7)
    expect(belt.max.z - belt.min.z).toBeGreaterThan(1.4)
  })

  it('the lead has a yellow rim, a header board and a line plate the bench does not', () => {
    const keys = (k: ObjectKit): string[] => k.parts.map((p) => p.key)
    for (const key of ['station.rim', 'station.plaque', 'station.plaque.mark']) {
      expect(keys(lead), key).toContain(key)
      expect(keys(bench), key).not.toContain(key)
    }
    expect(lead.parts.find((p) => p.key === 'station.rim')!.role).toBe('hazard')
    // Visible in every LOD: far still shows the rim and the plate.
    for (const key of ['station.rim', 'station.plaque']) expect(lead.parts.find((p) => p.key === key)!.lods).toContain('far')
  })

  it('the lead is taller than a bench body line at its back (header board) and wider in yellow', () => {
    const rim = bounds(lead.parts.find((p) => p.key === 'station.rim')!.geometry)
    expect(rim.max.y).toBeGreaterThan(1.7)
    expect(tris(lead, 'near')).toBeGreaterThan(tris(bench, 'near'))
  })
})

describe('boardLampColour', () => {
  const LIGHT_TOKENS: FactoryTokenColours = { success: '#0f8a56', warning: '#b45f06', danger: '#c62828', accentText: '#4f33d6' }
  const lum = (h: string): number => relativeLuminance(h)
  for (const [theme, tokens] of [['dark', TOKENS], ['light', LIGHT_TOKENS]] as const) {
    it(`${theme}: pending and skipped are the off colour, active is success, blocked is warning`, () => {
      const c = (s: 'pending' | 'active' | 'done' | 'blocked' | 'skipped'): string => factoryKits.boardLampColour!(theme, s, tokens)
      // Dark: the stack light's off colour; light: that colour sunk towards the dark panel (see board.ts).
      if (theme === 'dark') expect(c('pending')).toBe(factoryKits.lampOffColour(theme))
      expect(c('skipped')).toBe(c('pending'))
      expect(c('active')).toBe(tokens.success)
      expect(c('blocked')).toBe(tokens.warning)
      for (const s of ['pending', 'active', 'done', 'blocked', 'skipped'] as const) expect(c(s)).toMatch(/^#[0-9a-f]{6}$/i)
    })

    it(`${theme}: done differs from active by lightness (at least 1.6:1), and every lit state reads against the panel`, () => {
      const c = (s: 'pending' | 'active' | 'done' | 'blocked' | 'skipped'): string => factoryKits.boardLampColour!(theme, s, tokens)
      expect(contrastRatio(c('done'), c('active'))).toBeGreaterThanOrEqual(1.6)
      expect(new Set([c('pending'), c('active'), c('done'), c('blocked')]).size).toBe(4)
      const panel = FACTORY_PALETTE[theme].roles.boardPanel
      for (const s of ['active', 'done', 'blocked'] as const) expect(contrastRatio(c(s), panel), s).toBeGreaterThanOrEqual(2.8)
      // Off lamps stay readable as lamps against the panel but lower than any lit state.
      expect(contrastRatio(c('pending'), panel)).toBeGreaterThanOrEqual(1.5)
      expect(lum(c('pending'))).toBeLessThan(lum(c('active')))
    })
  }
})

describe('slice 3 far robot', () => {
  it('the far capsule is unlit with its own role and wider than the old 0.6 m capsule', () => {
    const far = robot.parts.find((p) => p.key === 'robot.far.body')!
    expect(far.role).toBe('robot.far')
    expect(far.lods).toEqual(['far'])
    const m = factoryKits.createMaterials('dark', TOKENS)
    expect(m.get('robot.far')).toBeInstanceOf(MeshBasicMaterial)
    const b = bounds(far.geometry)
    expect(b.max.x - b.min.x).toBeGreaterThanOrEqual(0.7)
    m.applyTheme('light', TOKENS)
    expect((m.get('robot.far') as MeshBasicMaterial).color.getHexString()).toBe(new Color(FACTORY_PALETTE.light.roles.robotFar).getHexString())
    m.dispose()
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Slice 4: carriers, machine strokes, the console screen, the board check mark, the hall dim blend, joints.
// ---------------------------------------------------------------------------------------------------------------------

const tote = factoryKits.tote!()
const capsule = factoryKits.capsule!()
const toolPart = factoryKits.part!()
const carriers: ObjectKit[] = [tote, capsule, toolPart]
const STROKES: Record<number, { key: string; kind: string; amount: number }[]> = {
  0: [{ key: 'machine.0.head', kind: 'translateY', amount: -0.3 }],
  1: [
    { key: 'machine.1.arm', kind: 'rotateY', amount: (40 * Math.PI) / 180 },
    { key: 'machine.1.arm.panel', kind: 'rotateY', amount: (40 * Math.PI) / 180 }
  ],
  2: [{ key: 'machine.2.spindle', kind: 'rotateY', amount: 2 * Math.PI }],
  3: [{ key: 'machine.3.carriage', kind: 'translateX', amount: 0.6 }]
}

describe('slice 4 carriers', () => {
  it('are exported on factoryKits with unique kit names and part keys, finite geometry and roles that resolve', () => {
    for (const k of ['tote', 'capsule', 'part', 'boardLampMarkColour'] as const) expect(factoryKits[k], k).toBeTypeOf('function')
    expect(new Set([...all, ...stateKits, ...carriers].map((k) => k.name)).size).toBe(all.length + stateKits.length + carriers.length)
    for (const theme of ['dark', 'light'] as const) {
      const m = factoryKits.createMaterials(theme, TOKENS)
      for (const kit of carriers) {
        const keys = kit.parts.map((p) => p.key)
        expect(new Set(keys).size, kit.name).toBe(keys.length)
        for (const p of kit.parts) {
          expect(() => m.get(p.role), `${kit.name}/${p.key}`).not.toThrow()
          const pos = p.geometry.getAttribute('position')
          expect(pos.count % 3, `${kit.name}/${p.key}`).toBe(0)
          expect(p.geometry.getAttribute('normal')).toBeDefined()
          expect(p.geometry.getAttribute('uv')).toBeDefined()
          for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i])) throw new Error(`${kit.name}/${p.key}: non-finite position`)
        }
      }
      m.dispose()
    }
  })

  it('triangle budgets: tote 80, capsule 120, part 12', () => {
    expect(tris(tote, 'near')).toBeLessThanOrEqual(80)
    expect(tris(capsule, 'near')).toBeLessThanOrEqual(120)
    expect(tris(toolPart, 'near')).toBeLessThanOrEqual(12)
  })

  it('cast no shadow (the engine gives them a blob), are drawn in every band, except the part, which is never drawn far', () => {
    for (const k of carriers) for (const p of k.parts) expect(p.castShadow, `${k.name}/${p.key}`).toBe(false)
    for (const k of [tote, capsule]) for (const band of BANDS) expect(tris(k, band), `${k.name} ${band}`).toBeGreaterThan(0)
    expect(tris(toolPart, 'near')).toBeGreaterThan(0)
    expect(tris(toolPart, 'mid')).toBeGreaterThan(0)
    expect(tris(toolPart, 'far')).toBe(0)
  })

  // Slice 6 made the travellers about 20 percent larger than slice 4's (0.7 x 0.35 x 0.5 tote, 0.5 m capsule, 0.25 m part).
  it('tote: origin at the bottom centre, about 0.84 x 0.4 x 0.6 m, with a contrasting liner part', () => {
    const b = kitBounds(tote, 'near')
    expect(b.min.y).toBeCloseTo(0, 5)
    expect(b.min.x).toBeCloseTo(-b.max.x, 3)
    expect(b.min.z).toBeCloseTo(-b.max.z, 3)
    expect(b.max.x - b.min.x).toBeCloseTo(0.84, 2)
    expect(b.max.z - b.min.z).toBeCloseTo(0.6, 2)
    expect(b.max.y).toBeGreaterThan(0.35)
    expect(b.max.y).toBeLessThanOrEqual(0.42)
    expect(tote.parts.find((p) => p.key === 'tote.body')!.role).toBe('tote')
    expect(tote.parts.find((p) => p.key === 'tote.liner')!.role).toBe('carrierBand')
  })

  it('capsule: lies east-west, 0.64 m long, resting on its origin (bottom centre), a contrasting band at the middle', () => {
    const b = kitBounds(capsule, 'near')
    expect(b.max.x - b.min.x).toBeCloseTo(0.64, 2)
    expect(b.max.z - b.min.z).toBeLessThan(0.35)
    expect(b.max.y - b.min.y).toBeLessThan(0.35)
    expect(b.min.y).toBeCloseTo(0, 5)
    expect(b.min.x).toBeCloseTo(-b.max.x, 3)
    const band = bounds(capsule.parts.find((p) => p.key === 'capsule.band')!.geometry)
    expect(Math.abs(band.min.x + band.max.x)).toBeLessThan(1e-3)
    expect(band.max.x - band.min.x).toBeLessThan(0.15)
    expect(capsule.parts.find((p) => p.key === 'capsule.body')!.role).toBe('capsule')
    expect(capsule.parts.find((p) => p.key === 'capsule.band')!.role).toBe('carrierBand')
  })

  it('part: about 0.3 m across (the belt is 0.9 m wide), origin at the bottom centre', () => {
    const b = kitBounds(toolPart, 'near')
    expect(b.max.x - b.min.x).toBeCloseTo(0.3, 2)
    expect(b.min.y).toBeCloseTo(0, 5)
    expect(b.max.y).toBeLessThan(0.25)
    expect(toolPart.parts[0].role).toBe('part')
  })

  it('carriers add no draw calls: the same parts per kit as slice 4 (tote 2, capsule 2, part 1) and the band is one shared role', () => {
    expect(tote.parts).toHaveLength(2)
    expect(capsule.parts).toHaveLength(2)
    expect(toolPart.parts).toHaveLength(1)
    expect(MATERIAL_ROLES.filter((r) => r === 'carrierBand')).toHaveLength(1)
  })

  it('carrier materials take the section 4.3 colours in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      const m = factoryKits.createMaterials(theme, TOKENS)
      const r = FACTORY_PALETTE[theme].roles
      for (const [role, hex] of [['tote', r.tote], ['capsule', r.capsule], ['part', r.part], ['carrierBand', r.carrierBand]] as const) {
        expect((m.get(role) as MeshStandardMaterial).color.getHexString(), `${theme} ${role}`).toBe(new Color(hex).getHexString())
      }
      m.dispose()
    }
    // Slice 6 values (slice 4: dark #5b6b8c / #d8dde8 / #9aa2b1, light #6c7c9c / #ffffff / #7d8696).
    expect(FACTORY_PALETTE.dark.roles).toMatchObject({ tote: '#c9a6ff', capsule: '#4fd6f6', part: '#f1f4fb', carrierBand: '#0b0e14' })
    expect(FACTORY_PALETTE.light.roles).toMatchObject({ tote: '#5a2bb5', capsule: '#046b8c', part: '#f1f4fb', carrierBand: '#ffffff' })
  })

  it('the blob shadow is stronger on the dark floor than on the light one and follows applyTheme', () => {
    const dark = factoryKits.createMaterials('dark', TOKENS)
    const light = factoryKits.createMaterials('light', TOKENS)
    expect(dark.get('blob').opacity).toBeGreaterThan(light.get('blob').opacity)
    expect(dark.get('blob').opacity).toBeGreaterThanOrEqual(0.5)
    expect(light.get('blob').opacity).toBeLessThanOrEqual(0.45)
    dark.applyTheme('light', TOKENS)
    expect(dark.get('blob').opacity).toBe(light.get('blob').opacity)
    dark.dispose()
    light.dispose()
  })
})

describe('slice 4 machine strokes', () => {
  for (const v of VARIANTS) {
    it(`variant ${v}: the moving sub-part carries its stroke, casts no shadow and is drawn near and mid only`, () => {
      const m = machines[v]
      const moving = m.parts.filter((p) => p.stroke)
      expect(moving.map((p) => p.key).sort()).toEqual(STROKES[v].map((s) => s.key).sort())
      for (const s of STROKES[v]) {
        const p = m.parts.find((x) => x.key === s.key)!
        expect(p.stroke!.kind, s.key).toBe(s.kind)
        expect(p.stroke!.amount, s.key).toBeCloseTo(s.amount, 5)
        expect(p.castShadow, s.key).toBe(false)
        expect(p.lods, s.key).toEqual(['near', 'mid'])
      }
      // The static body still casts, and the far block is one part with no stroke.
      expect(m.parts.find((p) => p.key === `${m.name}.body`)!.castShadow).toBe(true)
      expect(m.parts.find((p) => p.key === `${m.name}.far`)!.stroke).toBeUndefined()
      expect(m.parts.find((p) => p.key === `${m.name}.far`)!.lods).toEqual(['far'])
    })
  }

  it('keeps each machine within 900 triangles near and 60 far, and the far block unchanged', () => {
    for (const m of machines) {
      expect(tris(m, 'near'), m.name).toBeLessThanOrEqual(900)
      expect(tris(m, 'far'), m.name).toBeLessThanOrEqual(60)
    }
    // Slice 3 far blocks: three boxes, four boxes, three boxes, three boxes (12 triangles each).
    expect(machines.map((m) => tris(m, 'far'))).toEqual([36, 48, 36, 36])
  })

  it('a stroke at its full amount stays inside the footprint (1.5 x 1.2 m) and the portal posts', () => {
    const arm = machines[1].parts.find((p) => p.key === 'machine.1.arm')!
    expect(arm.stroke!.pivot).toEqual({ x: -0.2, y: 0, z: 0 })
    expect(machines[2].parts.find((p) => p.key === 'machine.2.spindle')!.stroke!.pivot).toBeUndefined()
    // The head sinks into the tower (still above the plate) and the carriage ends between the portal posts (x +-0.58).
    const head = bounds(machines[0].parts.find((p) => p.key === 'machine.0.head')!.geometry)
    expect(head.min.y - 0.3).toBeGreaterThan(0.5)
    const carriage = bounds(machines[3].parts.find((p) => p.key === 'machine.3.carriage')!.geometry)
    expect(carriage.min.x).toBeGreaterThanOrEqual(-0.58)
    expect(carriage.max.x + 0.6).toBeLessThanOrEqual(0.58)
    // The arm swung 40 degrees about its pivot (towards -z, away from the belt): the tip's far side, plus the machine's
    // own offset (z -0.45 in the station frame), stays on the plate (z >= -1.45).
    const ab = bounds(arm.geometry)
    const swung = Math.sin((40 * Math.PI) / 180) * (ab.max.x - -0.2) + 0.15
    expect(swung + 0.45).toBeLessThanOrEqual(1.45)
    expect(ab.max.x - -0.2).toBeLessThanOrEqual(1.0)
    // The spindle's key lugs sweep a circle within the footprint.
    const sb = bounds(machines[2].parts.find((p) => p.key === 'machine.2.spindle')!.geometry)
    expect(Math.max(sb.max.x, -sb.min.x, sb.max.z, -sb.min.z)).toBeLessThanOrEqual(0.63)
  })

  it('the spindle collars carry lugs off the axis (a turn is visible only with one)', () => {
    const sb = bounds(machines[2].parts.find((p) => p.key === 'machine.2.spindle')!.geometry)
    // Collar radius 0.52; the lug reaches past it on x at the lower collar and on z at the upper one.
    expect(sb.max.x).toBeGreaterThan(0.55)
    expect(sb.max.z).toBeGreaterThan(0.55)
  })
})

describe('slice 4 console screen', () => {
  it('the screen part is flagged, takes instanceColor and sits in an unlit screen material, near and mid only', () => {
    for (const kit of [bench, lead]) {
      const s = kit.parts.find((p) => p.key === 'station.screen')!
      expect(s.screen).toBe(true)
      expect(s.instanceColor).toBe(true)
      expect(s.role).toBe('screen')
      expect(s.lods).toEqual(['near', 'mid'])
      expect(s.castShadow).toBe(false)
      // No other part is a screen.
      expect(kit.parts.filter((p) => p.screen).length).toBe(1)
    }
    const m = factoryKits.createMaterials('dark', TOKENS)
    expect(m.get('screen')).toBeInstanceOf(MeshBasicMaterial)
    m.dispose()
  })

  for (const theme of ['dark', 'light'] as const) {
    it(`${theme}: the screen colour still reads lit against the console casing at the dimmest glow (0.7, linear)`, () => {
      const r = FACTORY_PALETTE[theme].roles
      const c = new Color(r.screen).multiplyScalar(0.7)
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
      const casing = relativeLuminance(r.console)
      expect((lum + 0.05) / (casing + 0.05)).toBeGreaterThanOrEqual(1.8)
      // And the bright end is the palette colour itself.
      expect(contrastRatio(r.screen, r.console)).toBeGreaterThanOrEqual(2.5)
    })
  }
})

describe('slice 4 board check mark', () => {
  const LIGHT_TOKENS: FactoryTokenColours = { success: '#0f8a56', warning: '#b45f06', danger: '#c62828', accentText: '#4f33d6' }
  const mark = boardLamp.parts.find((p) => p.key === 'lamp.mark')!
  const lens = boardLamp.parts.find((p) => p.key === 'boardLamp.lens')!

  it('boardLamp stays within 60 triangles with the mark, and the mark lies on the lens face', () => {
    expect(tris(boardLamp, 'near')).toBeLessThanOrEqual(60)
    expect(triangles(mark.geometry)).toBeGreaterThan(0)
    const l = bounds(lens.geometry)
    const b = bounds(mark.geometry)
    // Inside the lens footprint in x, centred on it, and not further than 1 cm off the lens in any direction.
    expect(b.min.x).toBeGreaterThan(l.min.x)
    expect(b.max.x).toBeLessThan(l.max.x)
    expect(Math.abs((b.min.x + b.max.x) / 2)).toBeLessThan(0.05)
    expect(b.max.y).toBeLessThanOrEqual(l.max.y + 0.01)
    expect(b.max.z).toBeLessThanOrEqual(l.max.z + 0.01)
    expect(mark.castShadow).toBe(false)
  })

  for (const [theme, tokens] of [['dark', TOKENS], ['light', LIGHT_TOKENS]] as const) {
    it(`${theme}: the mark reads only on done: dark on the lens when done, the lens colour itself otherwise`, () => {
      const lensC = (s: 'pending' | 'active' | 'done' | 'blocked' | 'skipped'): string => factoryKits.boardLampColour!(theme, s, tokens)
      const markC = (s: 'pending' | 'active' | 'done' | 'blocked' | 'skipped'): string => factoryKits.boardLampMarkColour!(theme, s, tokens)
      expect(contrastRatio(markC('done'), lensC('done'))).toBeGreaterThanOrEqual(7)
      for (const s of ['pending', 'active', 'blocked', 'skipped'] as const) expect(markC(s), s).toBe(lensC(s))
      for (const s of ['pending', 'active', 'done', 'blocked', 'skipped'] as const) expect(markC(s)).toMatch(/^#[0-9a-f]{6}$/i)
    })
  }
})

describe('slice 4 hall dim blend', () => {
  const levels = (l: ReturnType<typeof factoryKits.createLighting>): number[] => [l.key.intensity, ...l.lights.map((x) => x.intensity)]
  const states = ['on', 'paused', 'ended'] as const

  for (const theme of ['dark', 'light'] as const) {
    it(`${theme}: t 0 equals the from state and t 1 equals applyTheme(to) for every pair`, () => {
      const a = factoryKits.createLighting(theme)
      const b = factoryKits.createLighting(theme)
      expect(a.applyBlend).toBeTypeOf('function')
      for (const from of states) {
        for (const to of states) {
          a.applyBlend!(theme, from, to, 1)
          b.applyTheme(theme, to)
          expect(levels(a), `${from}->${to} t1`).toEqual(levels(b))
          a.applyBlend!(theme, from, to, 0)
          b.applyTheme(theme, from)
          expect(levels(a), `${from}->${to} t0`).toEqual(levels(b))
        }
      }
      a.dispose()
      b.dispose()
    })

    it(`${theme}: the midpoint is between the endpoints, t is clamped and a NaN counts as done`, () => {
      const l = factoryKits.createLighting(theme)
      l.applyTheme(theme, 'on')
      const on = l.key.intensity
      l.applyTheme(theme, 'paused')
      const paused = l.key.intensity
      l.applyBlend!(theme, 'on', 'paused', 0.5)
      expect(l.key.intensity).toBeLessThan(on)
      expect(l.key.intensity).toBeGreaterThan(paused)
      expect(l.key.intensity).toBeCloseTo((on + paused) / 2, 6)
      l.applyBlend!(theme, 'on', 'paused', 7)
      expect(l.key.intensity).toBeCloseTo(paused, 9)
      l.applyBlend!(theme, 'on', 'paused', -3)
      expect(l.key.intensity).toBeCloseTo(on, 9)
      l.applyBlend!(theme, 'on', 'paused', Number.NaN)
      expect(l.key.intensity).toBeCloseTo(paused, 9)
      l.dispose()
    })
  }

  it('the light hall dims as much as the dark one in relative terms (at least 25 percent in sRGB at paused)', () => {
    // sRGB of the lit floor scales with the light multiplier in linear light; the light theme's floor is lit to about
    // 0.56 linear (measured on screenshots: 197 of 255), the dark one to about 0.02 (39 of 255).
    const srgb = (lin: number): number => (lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055)
    const drop = (lin: number, k: number): number => 1 - srgb(lin * k) / srgb(lin)
    const dark = FACTORY_PALETTE.dark.light
    const light = FACTORY_PALETTE.light.light
    expect(drop(0.56, light.dimPaused)).toBeGreaterThanOrEqual(0.25)
    expect(drop(0.02, dark.dimPaused)).toBeGreaterThanOrEqual(0.25)
    // And neither is crushed: ended keeps a third of the light at least.
    expect(dark.dimEnded).toBeGreaterThanOrEqual(0.5)
    expect(light.dimEnded).toBeGreaterThanOrEqual(0.3)
  })
})

describe('slice 4 robot joints and hands', () => {
  it('the hand is a larger mitten than slice 3 (at least 0.18 m across) and the arms still fit the 1.2 m rest width', () => {
    const lower = bounds(robot.parts.find((p) => p.key === 'robot.arm.l.lower')!.geometry)
    // The hand box sits at the end of the forearm: its lowest 0.18 m of height, x extent 0.2.
    const sizes = new Set<number>()
    const pos = robot.parts.find((p) => p.key === 'robot.arm.l.lower')!.geometry.getAttribute('position')
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) < 0.26 + 1e-6) sizes.add(Math.round(pos.getX(i) * 1000))
    const xs = [...sizes]
    expect((Math.max(...xs) - Math.min(...xs)) / 1000).toBeGreaterThanOrEqual(0.18)
    expect(lower.min.y).toBeGreaterThanOrEqual(0.2)
    const b = kitBounds(robot, 'near')
    expect(b.max.x - b.min.x).toBeLessThan(1.2)
  })

  it('both arms mirror each other', () => {
    const l = bounds(robot.parts.find((p) => p.key === 'robot.arm.l.lower')!.geometry)
    const r = bounds(robot.parts.find((p) => p.key === 'robot.arm.r.lower')!.geometry)
    expect(l.min.x).toBeCloseTo(-r.max.x, 4)
    expect(l.max.x).toBeCloseTo(-r.min.x, 4)
  })
})
