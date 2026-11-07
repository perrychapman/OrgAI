/**
 * ZIP bomb guard for .docx / .xlsx before mammoth / exceljs unzip them into memory. Reads only the End of Central
 * Directory record and the central directory of a Buffer (no inflating). ZIP64 is refused. Pure.
 *
 * Limits: at most ZIP_MAX_ENTRIES entries, at most ZIP_MAX_TOTAL_BYTES of declared uncompressed data, and no entry over
 * 1 MB uncompressed with a compression ratio above ZIP_MAX_RATIO:1. The sizes are the central directory's own claims;
 * a file whose local headers lie is not caught here (the unzip libraries read the central directory as well).
 */
import { inflateRawSync } from 'node:zlib'

export const ZIP_MAX_ENTRIES = 10_000
export const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024
export const ZIP_MAX_RATIO = 200
const RATIO_FLOOR_BYTES = 1024 * 1024

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const CEN_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

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

/**
 * Declared uncompressed size of the entry called `name` (exact match, first one wins), or null when the package is
 * refused by the guard or has no such entry. Reads the central directory only.
 */
export function zipEntrySize(buf: Buffer, name: string): number | null {
  let found: number | null = null
  const problem = scan(
    buf,
    () => {},
    (e) => {
      if (found === null && e.name === name) found = e.usize
    }
  )
  return problem ? null : found
}

/** Entry names in central directory order (empty when the package is refused). */
export function zipEntryNames(buf: Buffer): string[] {
  const names: string[] = []
  const problem = scan(buf, () => {}, (e) => names.push(e.name))
  return problem ? [] : names
}

interface CenEntry {
  name: string
  usize: number
  csize: number
  method: number
  flags: number
  localOffset: number
}

/**
 * Inflates every entry with a hard output cap of its declared size, and checks each local header against the central
 * directory, so an entry that lies about its size is refused here instead of expanding inside mammoth / exceljs.
 * Null when every entry holds exactly what the directory declares. Run after zipProblem (it re-runs the same scan).
 */
export function zipVerifyEntries(buf: Buffer): string | null {
  const entries: CenEntry[] = []
  const problem = scan(buf, () => {}, (e) => entries.push(e))
  if (problem) return problem
  const bad = 'A part of the package does not match its directory.'
  for (const e of entries) {
    const o = e.localOffset
    if (o + 30 > buf.length || buf.readUInt32LE(o) !== LOCAL_SIG) return bad
    const flags = buf.readUInt16LE(o + 6)
    const method = buf.readUInt16LE(o + 8)
    const nameLen = buf.readUInt16LE(o + 26)
    const extraLen = buf.readUInt16LE(o + 28)
    if (method !== e.method || (method !== 0 && method !== 8)) return bad
    if (buf.toString('utf8', o + 30, o + 30 + nameLen) !== e.name) return bad
    if ((flags & 0x8) === 0 && (buf.readUInt32LE(o + 18) !== e.csize || buf.readUInt32LE(o + 22) !== e.usize)) return bad
    const start = o + 30 + nameLen + extraLen
    if (start + e.csize > buf.length) return bad
    const data = buf.subarray(start, start + e.csize)
    if (method === 0) {
      if (e.csize !== e.usize) return bad
    } else {
      try {
        const out = inflateRawSync(data, { maxOutputLength: e.usize + 1 })
        if (out.length !== e.usize) return bad
      } catch {
        return bad
      }
    }
  }
  return null
}

function scan(buf: Buffer, setTotal: (n: number) => void, onEntry?: (e: CenEntry) => void): string | null {
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
    if (onEntry && p + 46 + nameLen <= end) {
      onEntry({
        name: buf.toString('utf8', p + 46, p + 46 + nameLen),
        usize,
        csize,
        method: buf.readUInt16LE(p + 10),
        flags: buf.readUInt16LE(p + 8),
        localOffset: buf.readUInt32LE(p + 42)
      })
    }
    total += usize
    setTotal(total)
    if (total > ZIP_MAX_TOTAL_BYTES) return 'The package expands to more than 200 MB.'
    if (usize > RATIO_FLOOR_BYTES && (csize === 0 || usize / csize > ZIP_MAX_RATIO)) return 'A part of the package is compressed far beyond a normal ratio.'
    p += 46 + nameLen + extraLen + commentLen
    if (p > end) return 'The ZIP directory is damaged.'
  }
  return null
}
