/** Image type by magic bytes and pixel size from the header, for png / jpeg / gif / webp. Pure; never throws. */

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp'

export function sniffImage(head: Buffer): ImageType | null {
  if (head.length >= 8 && head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg'
  if (head.length >= 6 && (head.toString('latin1', 0, 6) === 'GIF87a' || head.toString('latin1', 0, 6) === 'GIF89a')) return 'gif'
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

/** Pixel size read from the header, or null when it cannot be read (the caller then assumes 4:3). */
export function imageSize(buf: Buffer, type: ImageType | null = sniffImage(buf)): { w: number; h: number } | null {
  try {
    let w = 0
    let h = 0
    if (type === 'png') {
      if (buf.length < 24) return null
      w = buf.readUInt32BE(16)
      h = buf.readUInt32BE(20)
    } else if (type === 'gif') {
      if (buf.length < 10) return null
      w = buf.readUInt16LE(6)
      h = buf.readUInt16LE(8)
    } else if (type === 'jpeg') {
      let p = 2
      while (p + 9 < buf.length) {
        if (buf[p] !== 0xff) {
          p++
          continue
        }
        const m = buf[p + 1]
        if (m === 0xff) {
          p++
          continue
        }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          p += 2
          continue
        }
        const len = buf.readUInt16BE(p + 2)
        // SOF0..SOF15 except DHT (c4), JPG (c8), DAC (cc)
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          h = buf.readUInt16BE(p + 5)
          w = buf.readUInt16BE(p + 7)
          break
        }
        if (len < 2) return null
        p += 2 + len
      }
    } else if (type === 'webp') {
      const fourcc = buf.toString('latin1', 12, 16)
      if (fourcc === 'VP8 ' && buf.length >= 30) {
        w = buf.readUInt16LE(26) & 0x3fff
        h = buf.readUInt16LE(28) & 0x3fff
      } else if (fourcc === 'VP8L' && buf.length >= 25) {
        const b = buf.readUInt32LE(21)
        w = (b & 0x3fff) + 1
        h = ((b >> 14) & 0x3fff) + 1
      } else if (fourcc === 'VP8X' && buf.length >= 30) {
        w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1
        h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1
      }
    }
    return w > 0 && h > 0 && w <= 1_000_000 && h <= 1_000_000 ? { w, h } : null
  } catch {
    return null
  }
}
