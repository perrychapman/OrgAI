// Builds every Factory Floor kit in node (three needs no GL context for geometry and materials) and checks the budgets of
// docs/design/factory-floor.md sections 4.6 and 9.1, the material roles, the anchors the engine reads and the shapes.
import { Box3, Color, MeshBasicMaterial, MeshStandardMaterial, type BufferGeometry } from 'three'
import { describe, expect, it } from 'vitest'
import { FACTORY_PALETTE } from '../../../../lib/factory/palette'
import { triangles } from './geo'
import { factoryKits, KEY_DIRECTION, MATERIAL_ROLES } from './index'
import { boardLampPosition } from './board'
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
    expect(MATERIAL_ROLES.length).toBeLessThanOrEqual(32)
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
    for (const kit of [stack, board]) {
      for (const p of kit.parts.filter((x) => x.role === 'lamp')) expect(p.instanceColor, p.key).toBe(true)
    }
    for (const kit of all) for (const p of kit.parts) if (p.instanceColor) expect(p.role).toBe('lamp')
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
    for (const role of ['paint', 'vacant', 'ring', 'blob']) expect(m.get(role).polygonOffset, role).toBe(true)
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
    console.log([...all.map(row), `frame at 40 agents near: ${frameTris} triangles`].join('\n'))
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

  it('a station stays inside its 3 m plate plus the belt strip to the south', () => {
    for (const kit of [bench, lead]) {
      const b = kitBounds(kit, 'near')
      expect(b.min.x).toBeGreaterThanOrEqual(-1.5 - 1e-6)
      expect(b.max.x).toBeLessThanOrEqual(1.5 + 1e-6)
      expect(b.min.z).toBeGreaterThanOrEqual(-1.5 - 1e-6)
      expect(b.max.z).toBeLessThanOrEqual(2.5 + 1e-6)
    }
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
