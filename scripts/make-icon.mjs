// Renders the OrgAI app icon to build/icon.png (512x512 RGBA) without dependencies.
// A dark rounded square with an org-chart glyph (one node feeding two) in a purple-to-blue gradient.
// electron-builder converts build/icon.png to ICO/ICNS itself (it needs >= 256x256), so only the PNG is written.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const SIZE = 512
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')

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

// ---------- the glyph ----------

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

// ---------- rasterize ----------

const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5
    const py = y + 0.5
    const bgA = coverage(roundedRect(px, py, 16, 16, SIZE - 16, SIZE - 16, 104))
    const fgA = coverage(glyph(px, py)) * (1 - coverage(cores(px, py)))
    const t = Math.max(0, Math.min(1, (px + py - 200) / (2 * SIZE - 400)))
    const fg = FROM.map((c, i) => mix(c, TO[i], t))
    const color = BG.map((c, i) => mix(c, fg[i], fgA))
    const o = (y * SIZE + x) * 4
    rgba[o] = Math.round(color[0])
    rgba[o + 1] = Math.round(color[1])
    rgba[o + 2] = Math.round(color[2])
    rgba[o + 3] = Math.round(bgA * 255)
  }
}

// ---------- PNG encoder ----------

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

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, png)
console.log(`Wrote ${OUT} (${SIZE}x${SIZE}, ${png.length} bytes)`)
