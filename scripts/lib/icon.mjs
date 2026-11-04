// Pure, dependency-free pieces of the OrgAI icon pipeline: a signed-distance rasterizer of the mark (geometry in a
// 512-unit space, matching src/renderer/src/assets/brand/mark.svg), a deterministic PNG encoder and the ICO / ICNS
// containers. Every size is rendered natively from the geometry, never downsampled.
import { deflateSync } from 'node:zlib'

const BASE = 512

const BG = [0x0b, 0x0d, 0x12]
const FROM = [0x7c, 0x5c, 0xff]
const TO = [0x2b, 0xb0, 0xff]

// ---------- signed distance helpers (negative inside) ----------

function roundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hx = (x1 - x0) / 2 - r
  const hy = (y1 - y0) / 2 - r
  const qx = Math.abs(x - cx) - hx
  const qy = Math.abs(y - cy) - hy
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

function circle(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) - r
}

function segment(x, y, ax, ay, bx, by, halfWidth) {
  const px = x - ax
  const py = y - ay
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - dx * t, py - dy * t) - halfWidth
}

const TOP = [256, 168, 60]
const LEFT = [148, 352, 52]
const RIGHT = [364, 352, 52]
const BUS_Y = 262
const LINE = 12

function glyph(x, y) {
  let d = circle(x, y, ...TOP)
  d = Math.min(d, circle(x, y, ...LEFT))
  d = Math.min(d, circle(x, y, ...RIGHT))
  d = Math.min(d, segment(x, y, TOP[0], TOP[1], TOP[0], BUS_Y, LINE))
  d = Math.min(d, segment(x, y, LEFT[0], BUS_Y, RIGHT[0], BUS_Y, LINE))
  d = Math.min(d, segment(x, y, LEFT[0], BUS_Y, LEFT[0], LEFT[1], LINE))
  d = Math.min(d, segment(x, y, RIGHT[0], BUS_Y, RIGHT[0], RIGHT[1], LINE))
  return d
}

// Inner dark cores turn the nodes into rings, which reads better at small sizes.
function cores(x, y) {
  return Math.min(circle(x, y, TOP[0], TOP[1], 24), circle(x, y, LEFT[0], LEFT[1], 20), circle(x, y, RIGHT[0], RIGHT[1], 20))
}

const coverage = (d) => Math.max(0, Math.min(1, 0.5 - d))
const mix = (a, b, t) => a + (b - a) * t

/** The fraction of the canvas the mark fills for the macOS variant. */
export const MAC_INSET = 0.8

/**
 * Renders the mark at `size` x `size` as an RGBA buffer. `inset` is a scale (0 < inset <= 1), `true` meaning
 * MAC_INSET, false or omitted meaning 1: the rounded square and glyph shrink around the centre, leaving a
 * transparent margin.
 */
export function renderIcon(size, { inset = false } = {}) {
  if (!Number.isInteger(size) || size < 1 || size > 4096) throw new Error(`Bad icon size: ${size}`)
  const k = inset === true ? MAC_INSET : inset === false || inset === undefined ? 1 : inset
  if (!(k > 0 && k <= 1)) throw new Error(`Bad inset: ${inset}`)
  const toBase = BASE / size // output pixels -> 512 space
  const toPx = size / BASE // 512-space distance -> output pixels
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Pixel centre in the 512 space, then undo the inset around the centre.
      const px = ((x + 0.5) * toBase - BASE / 2) / k + BASE / 2
      const py = ((y + 0.5) * toBase - BASE / 2) / k + BASE / 2
      const scale = k * toPx
      const bgA = coverage(roundedRect(px, py, 16, 16, BASE - 16, BASE - 16, 104) * scale)
      const fgA = coverage(glyph(px, py) * scale) * (1 - coverage(cores(px, py) * scale))
      const t = Math.max(0, Math.min(1, (px + py - 200) / (2 * BASE - 400)))
      const o = (y * size + x) * 4
      for (let c = 0; c < 3; c++) {
        const fg = mix(FROM[c], TO[c], t)
        rgba[o + c] = Math.round(mix(BG[c], fg, fgA))
      }
      rgba[o + 3] = Math.round(bgA * 255)
    }
  }
  return rgba
}

// ---------- PNG ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** A square 8-bit RGBA PNG. Only IHDR, IDAT and IEND: no timestamp, so the bytes are reproducible. */
export function encodePng(rgba, size) {
  if (rgba.length !== size * size * 4) throw new Error('RGBA buffer does not match the size')
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ---------- ICO ----------

/** images: [{ size, png }]. PNG-in-ICO (Vista and later); a width or height of 256 is stored as 0. */
export function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = 6 + dir.length
  images.forEach(({ size, png }, i) => {
    const o = i * 16
    dir[o] = size >= 256 ? 0 : size
    dir[o + 1] = size >= 256 ? 0 : size
    dir[o + 2] = 0 // palette colours
    dir[o + 3] = 0 // reserved
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bits per pixel
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...images.map((i) => i.png)])
}

// ---------- ICNS ----------

/** Pixel size of each PNG-carrying ICNS type (the @2x types carry twice their nominal size). */
export const ICNS_TYPES = {
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512
}

/** images: [{ type, png }]. Big-endian: 'icns', total length, then type + (8 + data) length + PNG per entry. */
export function encodeIcns(images) {
  const entries = images.map(({ type, png }) => {
    if (!/^[A-Za-z0-9 ]{4}$/.test(type)) throw new Error(`Bad ICNS type: ${type}`)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(8 + png.length, 4)
    return Buffer.concat([head, png])
  })
  const body = Buffer.concat(entries)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}
