/**
 * ZIP bomb guard for .docx / .xlsx before mammoth / exceljs unzip them into memory. Reads only the End of Central
 * Directory record and the central directory of a Buffer (no inflating). ZIP64 is refused. Pure.
 *
 * Limits: at most ZIP_MAX_ENTRIES entries, at most ZIP_MAX_TOTAL_BYTES of declared uncompressed data, and no entry over
 * 1 MB uncompressed with a compression ratio above ZIP_MAX_RATIO:1. zipProblem trusts the central directory's claims;
 * zipVerifyEntries then checks the local headers, inflates with a cap, and requires one unambiguous layout (directory
 * ends exactly at the EOCD, no second EOCD signature, local entries tile [0, cdOffset) with no gap, extra or duplicate
 * name), so JSZip (directory reader) and unzipper (local-header reader) see the same entries. Data descriptor entries
 * (flag 0x08) must be deflated, with a signed descriptor right after the declared data, local sizes 0 or the directory's
 * and no descriptor signature inside the data; names are ASCII or flagged UTF-8 and carry no 0x7075 field. The previews
 * read only with JSZip-based readers (mammoth, exceljs load), never the local-header reader.
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
const DESCRIPTOR_SIG = Buffer.from([0x50, 0x4b, 0x07, 0x08])

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

/** Sum of declared uncompressed sizes of the entries whose name `pick` accepts; null when the package is refused. */
export function zipSumSizes(buf: Buffer, pick: (name: string) => boolean): number | null {
  let sum = 0
  const problem = scan(buf, () => {}, (e) => {
    if (pick(e.name)) sum += e.usize
  })
  return problem ? null : sum
}

/** Largest declared uncompressed size among the entries `pick` accepts (0 when none); null when the package is refused. */
export function zipMaxSize(buf: Buffer, pick: (name: string) => boolean): number | null {
  let max = 0
  const problem = scan(buf, () => {}, (e) => {
    if (pick(e.name) && e.usize > max) max = e.usize
  })
  return problem ? null : max
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
  let cdStart = 0
  const problem = scan(buf, () => {}, (e) => entries.push(e), (c) => (cdStart = c))
  if (problem) return problem
  const bad = 'A part of the package does not match its directory.'
  // Entries must tile [0, cdOffset) exactly in local-header order: no unlisted local entry, gap, overlap or leftover
  // bytes for a reader that walks local headers (unzipper) to see something the directory does not list.
  // exceljs strips a leading '/' from entry names, so "/a" and "a" are one name to it.
  const names = new Set<string>()
  const lower = new Set<string>()
  for (const e of entries) {
    const key = e.name.replace(/^\/+/, '')
    if (names.has(key) || lower.has(key.toLowerCase())) return bad
    names.add(key)
    lower.add(key.toLowerCase())
  }
  let pos = 0
  for (const e of [...entries].sort((a, b) => a.localOffset - b.localOffset)) {
    const o = e.localOffset
    if (o !== pos || o + 30 > buf.length) return bad
    const nameEnd = o + 30 + buf.readUInt16LE(o + 26)
    const start = nameEnd + buf.readUInt16LE(o + 28)
    const end = start + e.csize
    pos = end
    if (unicodePathExtra(buf, nameEnd, buf.readUInt16LE(o + 28))) return bad
    if ((buf.readUInt16LE(o + 6) & 0x8) !== 0) {
      // unzipper reads a descriptor entry from wherever its data seems to end (a known local size, or a scan for the
      // signature), so accept one layout only: deflated, local sizes 0 or the directory's, a SIGNED descriptor right after
      // the declared data and no descriptor signature anywhere inside that data.
      if (e.method !== 8 || end + 16 > buf.length) return bad
      const lc = buf.readUInt32LE(o + 18)
      const lu = buf.readUInt32LE(o + 22)
      if (!(lc === 0 && lu === 0) && (lc !== e.csize || lu !== e.usize)) return bad
      if (buf.indexOf(DESCRIPTOR_SIG, start) !== end) return bad
      if (buf.readUInt32LE(end + 8) !== e.csize || buf.readUInt32LE(end + 12) !== e.usize) return bad
      pos = end + 16
    }
  }
  if (pos !== cdStart) return bad
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

/** True when an extra-field block holds a Unicode Path field (0x7075), which JSZip uses to rename the entry. */
function unicodePathExtra(buf: Buffer, at: number, len: number): boolean {
  const end = Math.min(buf.length, at + len)
  let p = at
  while (p + 4 <= end) {
    if (buf.readUInt16LE(p) === 0x7075) return true
    p += 4 + buf.readUInt16LE(p + 2)
  }
  return false
}

const NAME_MISMATCH = 'A part of the package has a name the unzip library could read differently.'

function scan(buf: Buffer, setTotal: (n: number) => void, onEntry?: (e: CenEntry) => void, onLayout?: (cdOffset: number) => void): string | null {
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
  // The unzip libraries read a different directory than a looser parser would (JSZip: last EOCD signature, records until
  // the signature stops matching, shifted offsets; unzipper: local headers only). Accept only an archive every reader
  // reads the same way: the directory ends exactly at the EOCD and no other EOCD signature sits after it.
  if (cdOffset + cdSize !== eocd) return 'The ZIP directory is damaged.'
  for (let i = eocd + 1; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return 'The ZIP directory is damaged.'
  }
  onLayout?.(cdOffset)
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
    if (p + 46 + nameLen + extraLen > end) return 'The ZIP directory is damaged.'
    // JSZip renames an entry from a 0x7075 field and decodes a name as CP437 without bit 11; the guard reads UTF-8.
    if (unicodePathExtra(buf, p + 46 + nameLen, extraLen)) return NAME_MISMATCH
    if ((buf.readUInt16LE(p + 8) & 0x800) === 0) {
      for (let k = p + 46; k < p + 46 + nameLen; k++) if (buf[k] >= 0x80) return NAME_MISMATCH
    }
    if (onEntry) {
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
  if (p !== end) return 'The ZIP directory is damaged.'
  return null
}
