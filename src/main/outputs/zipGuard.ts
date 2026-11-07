/**
 * ZIP bomb guard for .docx / .xlsx before mammoth / exceljs unzip them into memory. Reads only the End of Central
 * Directory record and the central directory of a Buffer (no inflating). ZIP64 is refused. Pure.
 *
 * Limits: at most ZIP_MAX_ENTRIES entries, at most ZIP_MAX_TOTAL_BYTES of declared uncompressed data, and no entry over
 * 1 MB uncompressed with a compression ratio above ZIP_MAX_RATIO:1. The sizes are the central directory's own claims;
 * a file whose local headers lie is not caught here (the unzip libraries read the central directory as well).
 */
export const ZIP_MAX_ENTRIES = 10_000
export const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024
export const ZIP_MAX_RATIO = 200
const RATIO_FLOOR_BYTES = 1024 * 1024

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const CEN_SIG = 0x02014b50

/** Why this buffer is not safe to unzip, or null. */
export function zipProblem(buf: Buffer): string | null {
  return zipInfo(buf).problem
}

/** The guard's verdict plus the central directory's total uncompressed size (0 when refused early). */
export function zipInfo(buf: Buffer): { problem: string | null; totalBytes: number } {
  let total = 0
  const problem = scan(buf, (t) => (total = t))
  return { problem, totalBytes: total }
}

function scan(buf: Buffer, setTotal: (n: number) => void): string | null {
  if (buf.length < 22) return 'The file is too small to be an Office document.'
  // EOCD sits at the end, followed by at most a 65535-byte comment.
  const from = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      const commentLen = buf.readUInt16LE(i + 20)
      if (i + 22 + commentLen === buf.length) {
        eocd = i
        break
      }
    }
  }
  if (eocd < 0) return 'The file is not a valid ZIP package.'
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) return 'ZIP64 packages are not supported.'
  const disk = buf.readUInt16LE(eocd + 4)
  const cdDisk = buf.readUInt16LE(eocd + 6)
  const entriesHere = buf.readUInt16LE(eocd + 8)
  const entries = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return 'ZIP64 packages are not supported.'
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) return 'Split ZIP packages are not supported.'
  if (entries > ZIP_MAX_ENTRIES) return `The package has more than ${ZIP_MAX_ENTRIES} parts.`
  if (cdOffset + cdSize > eocd) return 'The ZIP directory is damaged.'
  let p = cdOffset
  const end = cdOffset + cdSize
  let total = 0
  for (let n = 0; n < entries; n++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CEN_SIG) return 'The ZIP directory is damaged.'
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    if (csize === 0xffffffff || usize === 0xffffffff) return 'ZIP64 packages are not supported.'
    total += usize
    setTotal(total)
    if (total > ZIP_MAX_TOTAL_BYTES) return 'The package expands to more than 200 MB.'
    if (usize > RATIO_FLOOR_BYTES && (csize === 0 || usize / csize > ZIP_MAX_RATIO)) return 'A part of the package is compressed far beyond a normal ratio.'
    p += 46 + nameLen + extraLen + commentLen
    if (p > end) return 'The ZIP directory is damaged.'
  }
  return null
}
