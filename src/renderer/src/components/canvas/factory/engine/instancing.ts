// Instance pools of the Factory Floor engine (docs/design/factory-floor.md sections 4.6 and 9.2): one InstancedMesh per
// (kit, part key), all parts of a kit sharing the per-instance object matrix (times a per-part local matrix where the
// instance gives one: a robot's pose), shared materials from FactoryMaterials,
// per-instance colours for parts that ask for them. Only instances whose matrix or colour changed are written. The
// LOD band shows the parts listed for it; the engine swaps bands only when a zoom settles.
import { Color, InstancedBufferAttribute, InstancedMesh, Matrix4, type Object3D, type WebGLRenderer } from 'three'
import type { FactoryMaterials, LodBand, ObjectKit, PartSpec } from '../builders/types'

export interface InstanceSpec {
  /** Stable key (a worker id, a segment key): the same key keeps its slot. */
  key: string
  matrix: Matrix4
  /** Per-part colours for parts with instanceColor (missing: white). */
  colours?: Readonly<Record<string, Color>>
  /**
   * Per-part local matrices (a robot's pose, engine/poses.ts): that part's instance matrix is `matrix * parts[key]`.
   * Parts not listed take `matrix` alone.
   */
  parts?: Readonly<Record<string, Matrix4>>
}

const WHITE = new Color(1, 1, 1)
const MIN_CAPACITY = 4

interface PartMesh {
  part: PartSpec
  mesh: InstancedMesh
}

/** Called before every pool mesh renders in the main pass (the engine's draw-call split). */
export type RenderHook = (renderer: WebGLRenderer) => void

export class KitPool {
  readonly kit: ObjectKit
  private readonly parent: Object3D
  private readonly materials: FactoryMaterials
  private readonly hook: RenderHook | undefined
  private parts: PartMesh[] = []
  private capacity = 0
  private readonly slots = new Map<string, number>()
  private keys: string[] = []
  private band: LodBand = 'near'
  private readonly posed = new Matrix4()
  private placed = false
  /** Slice 4: a pool of moving things (carriers, crates in flight): no part casts, whatever the kit says. */
  readonly moving: boolean

  constructor(parent: Object3D, kit: ObjectKit, materials: FactoryMaterials, hook?: RenderHook, capacity = MIN_CAPACITY, moving = false) {
    this.parent = parent
    this.kit = kit
    this.materials = materials
    this.hook = hook
    this.moving = moving
    this.allocate(Math.max(MIN_CAPACITY, capacity))
  }

  get count(): number {
    return this.keys.length
  }

  /** True when any part casts a shadow (a change then needs a shadow-map update). */
  get castsShadow(): boolean {
    return !this.moving && this.kit.parts.some((p) => p.castShadow)
  }

  /** Every mesh of the pool (tests and the engine's material refresh). */
  meshes(): readonly InstancedMesh[] {
    return this.parts.map((p) => p.mesh)
  }

  /**
   * Makes the pool hold exactly `instances`. Returns true when anything visible changed. Removed instances are replaced
   * by the last one (one slot rewritten); matrices and colours are compared before writing.
   */
  set(instances: readonly InstanceSpec[]): boolean {
    let changed = false
    this.placed = false
    const wanted = new Set(instances.map((i) => i.key))
    for (const key of [...this.keys]) {
      if (!wanted.has(key)) {
        this.remove(key)
        changed = true
        this.placed = true
      }
    }
    if (instances.length > this.capacity) this.allocate(Math.max(instances.length, this.capacity * 2))
    for (const inst of instances) {
      let index = this.slots.get(inst.key)
      if (index === undefined) {
        index = this.keys.length
        this.keys.push(inst.key)
        this.slots.set(inst.key, index)
        changed = true
        this.placed = true
        this.write(index, inst, true)
      } else if (this.write(index, inst, false)) changed = true
    }
    if (changed) this.finish()
    return changed
  }

  /** True when the last set() added, removed or moved an instance (not only recoloured one): shadows need an update. */
  get placementChanged(): boolean {
    return this.placed
  }

  /** Shows the parts listed for `band`. Returns true when visibility changed. */
  setLod(band: LodBand): boolean {
    if (band === this.band) return false
    this.band = band
    this.updateVisibility()
    return true
  }

  dispose(): void {
    for (const p of this.parts) {
      this.parent.remove(p.mesh)
      p.mesh.dispose()
    }
    this.parts = []
    this.slots.clear()
    this.keys = []
  }

  private allocate(capacity: number): void {
    const old = this.parts
    this.parts = this.kit.parts.map((part, i) => {
      const mesh = new InstancedMesh(part.geometry, this.materials.get(part.role), capacity)
      mesh.name = `${this.kit.name}:${part.key}`
      mesh.castShadow = part.castShadow && !this.moving
      mesh.receiveShadow = part.receiveShadow
      if (part.instanceColor) mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3)
      const prev = old[i]?.mesh
      if (prev) {
        mesh.instanceMatrix.array.set(prev.instanceMatrix.array.subarray(0, this.keys.length * 16))
        if (prev.instanceColor && mesh.instanceColor) mesh.instanceColor.array.set(prev.instanceColor.array.subarray(0, this.keys.length * 3))
        this.parent.remove(prev)
        prev.dispose()
      }
      if (this.hook) {
        const hook = this.hook
        mesh.onBeforeRender = (renderer) => hook(renderer)
      }
      this.parent.add(mesh)
      return { part, mesh }
    })
    this.capacity = capacity
    this.finish()
  }

  /** Writes one instance; returns whether anything differed. */
  private write(index: number, inst: InstanceSpec, force: boolean): boolean {
    let changed = false
    for (const { part, mesh } of this.parts) {
      const local = inst.parts?.[part.key]
      const src = local ? this.posed.multiplyMatrices(inst.matrix, local).elements : inst.matrix.elements
      const arr = mesh.instanceMatrix.array as Float32Array
      const o = index * 16
      let differs = force
      if (!differs) {
        for (let k = 0; k < 16; k++) {
          if (Math.abs(arr[o + k] - src[k]) > 1e-6) {
            differs = true
            break
          }
        }
      }
      if (differs) {
        arr.set(src, o)
        changed = true
        this.placed = true
      }
      if (part.instanceColor && mesh.instanceColor) {
        const c = inst.colours?.[part.key] ?? WHITE
        const ca = mesh.instanceColor.array as Float32Array
        const co = index * 3
        // The buffer holds float32 values: an exact compare against the Color's doubles would always differ (and every
        // model change would rewrite every colour and render a frame). Same tolerance as the matrices.
        if (force || Math.abs(ca[co] - c.r) > 1e-6 || Math.abs(ca[co + 1] - c.g) > 1e-6 || Math.abs(ca[co + 2] - c.b) > 1e-6) {
          ca[co] = c.r
          ca[co + 1] = c.g
          ca[co + 2] = c.b
          changed = true
        }
      }
    }
    return changed
  }

  private remove(key: string): void {
    const index = this.slots.get(key)
    if (index === undefined) return
    const last = this.keys.length - 1
    if (index !== last) {
      const lastKey = this.keys[last]
      for (const { mesh } of this.parts) {
        const arr = mesh.instanceMatrix.array as Float32Array
        arr.copyWithin(index * 16, last * 16, last * 16 + 16)
        if (mesh.instanceColor) (mesh.instanceColor.array as Float32Array).copyWithin(index * 3, last * 3, last * 3 + 3)
      }
      this.keys[index] = lastKey
      this.slots.set(lastKey, index)
    }
    this.keys.pop()
    this.slots.delete(key)
  }

  private finish(): void {
    const n = this.keys.length
    for (const { mesh } of this.parts) {
      mesh.count = n
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      if (n > 0) {
        mesh.computeBoundingSphere()
        mesh.computeBoundingBox()
      }
    }
    this.updateVisibility()
  }

  private updateVisibility(): void {
    const n = this.keys.length
    for (const { part, mesh } of this.parts) mesh.visible = n > 0 && part.lods.includes(this.band)
  }
}

/** A kit holding only some of another kit's parts (props: paint, vacant, ring and blob each get their own instances). */
export function subKit(kit: ObjectKit, key: string): ObjectKit | null {
  const parts = kit.parts.filter((p) => p.key === key)
  return parts.length ? { name: `${kit.name}.${key}`, parts, anchors: kit.anchors } : null
}
