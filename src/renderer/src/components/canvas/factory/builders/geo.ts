// Small procedural geometry helpers shared by the builders (Factory Floor, docs/design/factory-floor.md section 4.1).
// Everything is built in the object's local frame in metres (+x east, +z south, +y up) and returned non-indexed with
// position, normal and uv attributes, so any list of pieces can be merged into one part (one draw call per part).
// Box, tapered box and chamfered box are faceted (use a flat-shaded role); cylinders and spheres carry smooth normals
// (use a smooth role). Boxes and cylinders are placed by their BOTTOM centre (y is the underside), spheres by centre.
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Matrix4,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  Vector3
} from 'three'

function flat(g: BufferGeometry): BufferGeometry {
  return g.index ? g.toNonIndexed() : g
}

/** Triangle count of a geometry (indexed or not). */
export function triangles(g: BufferGeometry): number {
  const count = g.index ? g.index.count : g.getAttribute('position').count
  return Math.floor(count / 3)
}

/** Translates (and optionally rotates about +y, then x, then z) a geometry in place and returns it. */
export function place(g: BufferGeometry, x = 0, y = 0, z = 0, rotY = 0, rotX = 0, rotZ = 0): BufferGeometry {
  const m = new Matrix4()
  if (rotY || rotX || rotZ) {
    m.makeRotationY(rotY)
    if (rotX) m.multiply(new Matrix4().makeRotationX(rotX))
    if (rotZ) m.multiply(new Matrix4().makeRotationZ(rotZ))
  }
  m.setPosition(x, y, z)
  g.applyMatrix4(m)
  return g
}

/** Merges geometries into one non-indexed geometry. Every input needs position, normal and uv. */
export function merge(list: BufferGeometry[]): BufferGeometry {
  const parts = list.map(flat)
  const total = parts.reduce((n, g) => n + g.getAttribute('position').count, 0)
  const position = new Float32Array(total * 3)
  const normal = new Float32Array(total * 3)
  const uv = new Float32Array(total * 2)
  let v = 0
  for (const g of parts) {
    const p = g.getAttribute('position')
    const n = g.getAttribute('normal')
    const t = g.getAttribute('uv')
    position.set(p.array as ArrayLike<number>, v * 3)
    normal.set(n.array as ArrayLike<number>, v * 3)
    if (t) uv.set(t.array as ArrayLike<number>, v * 2)
    v += p.count
  }
  for (const g of parts) g.dispose()
  for (const g of list) g.dispose()
  const out = new BufferGeometry()
  out.setAttribute('position', new Float32BufferAttribute(position, 3))
  out.setAttribute('normal', new Float32BufferAttribute(normal, 3))
  out.setAttribute('uv', new Float32BufferAttribute(uv, 2))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

/** Axis-aligned box w (x) by h (y) by d (z), underside at y, centred on (x, z). 12 triangles. */
export function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): BufferGeometry {
  return place(flat(new BoxGeometry(w, h, d)), x, y + h / 2, z)
}

/**
 * Frustum with a rectangular base wBot by dBot and top wTop by dTop (12 triangles), underside at y, centred on (x, z).
 */
export function taper(wBot: number, dBot: number, wTop: number, dTop: number, h: number, x = 0, y = 0, z = 0): BufferGeometry {
  const b = [
    [-wBot / 2, 0, -dBot / 2],
    [wBot / 2, 0, -dBot / 2],
    [wBot / 2, 0, dBot / 2],
    [-wBot / 2, 0, dBot / 2]
  ]
  const t = [
    [-wTop / 2, h, -dTop / 2],
    [wTop / 2, h, -dTop / 2],
    [wTop / 2, h, dTop / 2],
    [-wTop / 2, h, dTop / 2]
  ]
  // Quads as (a, b, c, d) counter-clockwise seen from outside.
  const quads: number[][][] = [
    [t[0], t[3], t[2], t[1]], // top
    [b[0], b[1], b[2], b[3]], // bottom
    [b[3], b[2], t[2], t[3]], // south (+z)
    [b[1], b[0], t[0], t[1]], // north (-z)
    [b[2], b[1], t[1], t[2]], // east (+x)
    [b[0], b[3], t[3], t[0]] // west (-x)
  ]
  const pos: number[] = []
  for (const [a, bb, c, d] of quads) pos.push(...a, ...bb, ...c, ...a, ...c, ...d)
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3))
  g.setAttribute('uv', new Float32BufferAttribute(new Array((pos.length / 3) * 2).fill(0), 2))
  g.computeVertexNormals()
  return place(g, x, y, z)
}

/**
 * Box with its four vertical edges chamfered by c (an octagonal prism): w by d footprint, height h, 28 triangles.
 * Underside at y, centred on (x, z).
 */
export function chamfer(w: number, h: number, d: number, c: number, x = 0, y = 0, z = 0): BufferGeometry {
  const hw = w / 2
  const hd = d / 2
  const s = new Shape()
  s.moveTo(-hw + c, -hd)
  s.lineTo(hw - c, -hd)
  s.lineTo(hw, -hd + c)
  s.lineTo(hw, hd - c)
  s.lineTo(hw - c, hd)
  s.lineTo(-hw + c, hd)
  s.lineTo(-hw, hd - c)
  s.lineTo(-hw, -hd + c)
  s.closePath()
  const g = new ExtrudeGeometry(s, { depth: h, bevelEnabled: false, steps: 1 })
  // Shape y -> world -z, extrusion z -> world +y.
  g.rotateX(-Math.PI / 2)
  return place(flat(g), x, y, z)
}

/** Vertical cylinder (axis +y) with underside at y. `open` leaves out both caps. */
export function cyl(rTop: number, rBot: number, h: number, segments: number, x = 0, y = 0, z = 0, open = false): BufferGeometry {
  return place(flat(new CylinderGeometry(rTop, rBot, h, segments, 1, open)), x, y + h / 2, z)
}

/** Cylinder lying along x (rollers, wheels), centred on (x, y, z). */
export function cylX(r: number, length: number, segments: number, x = 0, y = 0, z = 0): BufferGeometry {
  const g = flat(new CylinderGeometry(r, r, length, segments, 1, false))
  g.rotateZ(Math.PI / 2)
  return place(g, x, y, z)
}

/** Sphere centred on (x, y, z). */
export function ball(r: number, wSeg: number, hSeg: number, x = 0, y = 0, z = 0): BufferGeometry {
  return place(flat(new SphereGeometry(r, wSeg, hSeg)), x, y, z)
}

/** Flat quad in the XZ plane facing up, w by d, centred on (x, z) at height y. Two triangles. */
export function quad(w: number, d: number, x = 0, y = 0, z = 0, rotY = 0): BufferGeometry {
  const g = flat(new PlaneGeometry(w, d))
  g.rotateX(-Math.PI / 2)
  return place(g, x, y, z, rotY)
}

/** A strut between two points with a square section of side t (12 triangles). */
export function strut(a: [number, number, number], b: [number, number, number], t: number): BufferGeometry {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dz = b[2] - a[2]
  const len = Math.hypot(dx, dy, dz)
  const g = flat(new BoxGeometry(t, len, t))
  // Rotate +y onto the direction vector.
  const m = new Matrix4()
  const up = [0, 1, 0]
  const dir = [dx / len, dy / len, dz / len]
  const axis = [up[1] * dir[2] - up[2] * dir[1], up[2] * dir[0] - up[0] * dir[2], up[0] * dir[1] - up[1] * dir[0]]
  const sin = Math.hypot(axis[0], axis[1], axis[2])
  const cos = up[0] * dir[0] + up[1] * dir[1] + up[2] * dir[2]
  if (sin > 1e-6) {
    const angle = Math.atan2(sin, cos)
    m.makeRotationAxis(new Vector3(axis[0] / sin, axis[1] / sin, axis[2] / sin), angle)
  } else if (cos < 0) m.makeRotationX(Math.PI)
  g.applyMatrix4(m)
  return place(g, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
}

/**
 * Upright parallelogram in the XY plane at depth z facing +z (south): its edge at y0 spans x .. x + w, its edge at y1
 * (y1 > y0) is shifted by `skew` along x. Two triangles. Diagonal hazard stripes and chevrons on a front face.
 */
export function paraV(x: number, w: number, y0: number, y1: number, skew: number, z = 0): BufferGeometry {
  const g = new BufferGeometry()
  const a = [x, y0, z]
  const b = [x + w, y0, z]
  const c = [x + w + skew, y1, z]
  const d = [x + skew, y1, z]
  g.setAttribute('position', new Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3))
  g.setAttribute('uv', new Float32BufferAttribute(new Array(12).fill(0), 2))
  g.computeVertexNormals()
  return g
}

/**
 * Flat parallelogram in the XZ plane facing up at height y: its edge at z0 spans x .. x + w, its edge at z1 (z1 > z0) is
 * shifted by `skew` (diagonal hazard stripes). Two triangles.
 */
export function para(x: number, w: number, z0: number, z1: number, skew: number, y = 0): BufferGeometry {
  const g = new BufferGeometry()
  const a = [x, y, z0]
  const b = [x + w, y, z0]
  const c = [x + w + skew, y, z1]
  const d = [x + skew, y, z1]
  g.setAttribute('position', new Float32BufferAttribute([...a, ...d, ...c, ...a, ...c, ...b], 3))
  g.setAttribute('uv', new Float32BufferAttribute(new Array(12).fill(0), 2))
  g.computeVertexNormals()
  return g
}
