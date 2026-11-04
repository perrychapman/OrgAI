import { describe, expect, it } from 'vitest'
import { ICNS_TYPES, encodeIcns, encodeIco, encodePng, renderIcon } from '../../../scripts/lib/icon.mjs'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const png = (size: number, inset = false): Buffer => encodePng(renderIcon(size, { inset }), size)
const alphaAt = (rgba: Buffer, size: number, x: number, y: number): number => rgba[(y * size + x) * 4 + 3]

describe('icon pipeline', () => {
  it('encodes an ICO whose directory parses back to the written sizes and offsets', () => {
    const sizes = [16, 32, 256]
    const images = sizes.map((size) => ({ size, png: png(size) }))
    const ico = encodeIco(images)
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(3)
    let offset = 6 + 16 * 3
    sizes.forEach((size, i) => {
      const e = 6 + i * 16
      expect(ico[e]).toBe(size === 256 ? 0 : size)
      expect(ico[e + 1]).toBe(size === 256 ? 0 : size)
      expect(ico.readUInt16LE(e + 4)).toBe(1)
      expect(ico.readUInt16LE(e + 6)).toBe(32)
      expect(ico.readUInt32LE(e + 8)).toBe(images[i].png.length)
      expect(ico.readUInt32LE(e + 12)).toBe(offset)
      expect(ico.subarray(offset, offset + 8).equals(SIG)).toBe(true)
      offset += images[i].png.length
    })
    expect(offset).toBe(ico.length)
  })

  it('encodes an ICNS with magic, total length and PNG entries', () => {
    const types = ['icp4', 'ic07', 'ic10']
    const images = types.map((type) => ({ type, png: png(Math.min(ICNS_TYPES[type], 64)) }))
    const icns = encodeIcns(images)
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    let pos = 8
    for (const img of images) {
      expect(icns.subarray(pos, pos + 4).toString('ascii')).toBe(img.type)
      const len = icns.readUInt32BE(pos + 4)
      expect(len).toBe(8 + img.png.length)
      expect(icns.subarray(pos + 8, pos + 16).equals(SIG)).toBe(true)
      pos += len
    }
    expect(pos).toBe(icns.length)
  })

  it('knows the eleven ICNS slots', () => {
    expect(Object.keys(ICNS_TYPES)).toHaveLength(11)
    expect(ICNS_TYPES.ic10).toBe(1024)
    expect(ICNS_TYPES.ic14).toBe(512)
  })

  it('renders a 16 px icon with an opaque centre and transparent corners', () => {
    const rgba = renderIcon(16)
    expect(rgba.length).toBe(16 * 16 * 4)
    expect(alphaAt(rgba, 16, 8, 8)).toBe(255)
    expect(alphaAt(rgba, 16, 0, 0)).toBe(0)
    expect(alphaAt(rgba, 16, 15, 15)).toBe(0)
  })

  it('leaves a transparent margin in the inset variant where the full one is opaque', () => {
    const size = 128
    const full = renderIcon(size, { inset: false })
    const inset = renderIcon(size, { inset: true })
    // Mid-edge pixel: inside the full rounded square (margin 4 px), outside the 80% one (margin ~16 px).
    expect(alphaAt(full, size, 64, 8)).toBe(255)
    expect(alphaAt(inset, size, 64, 8)).toBe(0)
    expect(alphaAt(inset, size, 64, 64)).toBe(255)
  })

  it('encodes PNG deterministically with matching IHDR dimensions', () => {
    const a = png(48)
    const b = png(48)
    expect(a.equals(b)).toBe(true)
    expect(a.subarray(0, 8).equals(SIG)).toBe(true)
    expect(a.subarray(12, 16).toString('ascii')).toBe('IHDR')
    expect(a.readUInt32BE(16)).toBe(48)
    expect(a.readUInt32BE(20)).toBe(48)
    expect(a.includes(Buffer.from('tIME'))).toBe(false)
  })
})
