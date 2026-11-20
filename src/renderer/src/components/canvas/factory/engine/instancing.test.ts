import { describe, expect, it } from 'vitest'
import { BoxGeometry, Color, Group, Matrix4, MeshBasicMaterial, type Material } from 'three'
import { KitPool, subKit } from './instancing'
import type { FactoryMaterials, ObjectKit } from '../builders/types'

function materials(): FactoryMaterials {
  const m = new Map<string, Material>()
  return {
    get: (role) => {
      let x = m.get(role)
      if (!x) m.set(role, (x = new MeshBasicMaterial()))
      return x
    },
    applyTheme: () => {},
    dispose: () => m.forEach((x) => x.dispose())
  }
}

const kit: ObjectKit = {
  name: 'k',
  parts: [
    { key: 'body', geometry: new BoxGeometry(1, 1, 1), role: 'a', castShadow: true, receiveShadow: true, lods: ['near', 'mid'] },
    { key: 'far', geometry: new BoxGeometry(1, 1, 1), role: 'a', castShadow: true, receiveShadow: true, lods: ['far'] },
    { key: 'lamp', geometry: new BoxGeometry(1, 1, 1), role: 'b', castShadow: false, receiveShadow: false, lods: ['near', 'mid', 'far'], instanceColor: true }
  ]
}
const at = (x: number): Matrix4 => new Matrix4().makeTranslation(x, 0, 0)
const xs = (pool: KitPool): number[] => {
  const mesh = pool.meshes()[0]
  return Array.from({ length: mesh.count }, (_, i) => mesh.instanceMatrix.array[i * 16 + 12])
}

describe('KitPool', () => {
  it('a moving pool (slice 4 carriers) never casts, whatever the kit says', () => {
    const still = new KitPool(new Group(), kit, materials())
    const moving = new KitPool(new Group(), kit, materials(), undefined, 4, true)
    expect(still.castsShadow).toBe(true)
    expect(moving.castsShadow).toBe(false)
    expect(moving.meshes().every((m) => !m.castShadow)).toBe(true)
    // Growing the pool re-creates the meshes: still no casters.
    moving.set(Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, matrix: at(i) })))
    expect(moving.meshes().every((m) => !m.castShadow && m.count === 9)).toBe(true)
  })

  it('one InstancedMesh per part, sharing the per-instance matrix', () => {
    const parent = new Group()
    const pool = new KitPool(parent, kit, materials())
    expect(parent.children).toHaveLength(3)
    expect(pool.set([{ key: 'a', matrix: at(1) }, { key: 'b', matrix: at(2) }])).toBe(true)
    for (const mesh of pool.meshes()) expect(mesh.count).toBe(2)
    expect(xs(pool)).toEqual([1, 2])
    expect(pool.meshes()[1].instanceMatrix.array[16 + 12]).toBe(2)
  })

  it('reports no change when nothing changed, and keeps slots stable by key', () => {
    const pool = new KitPool(new Group(), kit, materials())
    pool.set([{ key: 'a', matrix: at(1) }, { key: 'b', matrix: at(2) }])
    expect(pool.set([{ key: 'b', matrix: at(2) }, { key: 'a', matrix: at(1) }])).toBe(false)
    expect(xs(pool)).toEqual([1, 2])
    expect(pool.set([{ key: 'a', matrix: at(5) }, { key: 'b', matrix: at(2) }])).toBe(true)
    expect(xs(pool)).toEqual([5, 2])
  })

  it('removal moves the last instance into the freed slot', () => {
    const pool = new KitPool(new Group(), kit, materials())
    pool.set([{ key: 'a', matrix: at(1) }, { key: 'b', matrix: at(2) }, { key: 'c', matrix: at(3) }])
    pool.set([{ key: 'b', matrix: at(2) }, { key: 'c', matrix: at(3) }])
    expect(xs(pool)).toEqual([3, 2])
    expect(pool.count).toBe(2)
  })

  it('grows past its capacity and keeps what it held', () => {
    const parent = new Group()
    const pool = new KitPool(parent, kit, materials(), undefined, 4)
    const many = Array.from({ length: 41 }, (_, i) => ({ key: `w${i}`, matrix: at(i) }))
    pool.set(many.slice(0, 3))
    pool.set(many)
    expect(xs(pool)).toEqual(many.map((_, i) => i))
    expect(parent.children).toHaveLength(3)
  })

  it('writes per-instance colours only for instanceColor parts and detects colour changes', () => {
    const pool = new KitPool(new Group(), kit, materials())
    const red = new Color(1, 0, 0)
    pool.set([{ key: 'a', matrix: at(1), colours: { lamp: red } }])
    const lamp = pool.meshes()[2]
    expect(Array.from(lamp.instanceColor!.array.slice(0, 3))).toEqual([1, 0, 0])
    expect(pool.meshes()[0].instanceColor).toBeNull()
    expect(pool.set([{ key: 'a', matrix: at(1), colours: { lamp: red } }])).toBe(false)
    expect(pool.set([{ key: 'a', matrix: at(1), colours: { lamp: new Color(0, 1, 0) } }])).toBe(true)
    expect(Array.from(lamp.instanceColor!.array.slice(0, 3))).toEqual([0, 1, 0])
  })

  it('shows the parts of the current LOD band only, and nothing when empty', () => {
    const pool = new KitPool(new Group(), kit, materials())
    const vis = (): boolean[] => pool.meshes().map((m) => m.visible)
    expect(vis()).toEqual([false, false, false])
    pool.set([{ key: 'a', matrix: at(1) }])
    expect(vis()).toEqual([true, false, true])
    expect(pool.setLod('far')).toBe(true)
    expect(vis()).toEqual([false, true, true])
    expect(pool.setLod('far')).toBe(false)
    pool.setLod('mid')
    expect(vis()).toEqual([true, false, true])
  })

  it('multiplies a part by its per-instance local matrix (poses) and only that part', () => {
    const pool = new KitPool(new Group(), kit, materials())
    const lift = new Matrix4().makeTranslation(0, 2, 0)
    pool.set([{ key: 'a', matrix: at(1), parts: { body: lift } }])
    const [body, far] = pool.meshes()
    expect(Array.from(body.instanceMatrix.array.slice(12, 15))).toEqual([1, 2, 0])
    expect(Array.from(far.instanceMatrix.array.slice(12, 15))).toEqual([1, 0, 0])
    expect(pool.set([{ key: 'a', matrix: at(1), parts: { body: lift } }])).toBe(false)
    expect(pool.set([{ key: 'a', matrix: at(1) }])).toBe(true)
    expect(Array.from(body.instanceMatrix.array.slice(12, 15))).toEqual([1, 0, 0])
  })

  it('placementChanged tells a move or a removal from a recolour', () => {
    const pool = new KitPool(new Group(), kit, materials())
    pool.set([{ key: 'a', matrix: at(1), colours: { lamp: new Color(1, 0, 0) } }])
    expect(pool.placementChanged).toBe(true)
    expect(pool.set([{ key: 'a', matrix: at(1), colours: { lamp: new Color(0, 1, 0) } }])).toBe(true)
    expect(pool.placementChanged).toBe(false)
    pool.set([{ key: 'a', matrix: at(2), colours: { lamp: new Color(0, 1, 0) } }])
    expect(pool.placementChanged).toBe(true)
    pool.set([])
    expect(pool.placementChanged).toBe(true)
  })

  it('a kit with no parts (a state prop the kit source does not build yet) holds keys and draws nothing', () => {
    const parent = new Group()
    const pool = new KitPool(parent, { name: 'missing', parts: [] }, materials())
    pool.set([{ key: 'a', matrix: at(1) }])
    expect(parent.children).toHaveLength(0)
    expect(pool.castsShadow).toBe(false)
  })

  it('dispose removes its meshes; subKit picks one part', () => {
    const parent = new Group()
    const pool = new KitPool(parent, kit, materials())
    pool.dispose()
    expect(parent.children).toHaveLength(0)
    expect(subKit(kit, 'lamp')?.parts.map((p) => p.key)).toEqual(['lamp'])
    expect(subKit(kit, 'nope')).toBeNull()
  })
})
