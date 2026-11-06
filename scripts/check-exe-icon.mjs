#!/usr/bin/env node
// Lists the icon groups embedded in a Windows executable (RT_GROUP_ICON / RT_ICON resources).
//
//   node scripts/check-exe-icon.mjs <path.exe>
//
// Exit 0 when at least one icon group is found, 1 otherwise (or when the file is not a readable PE).
// Reads the file with node:fs only: no shell, no network, no dependencies. Token-free.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const RT_ICON = 3
const RT_GROUP_ICON = 14
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]

function need(buf, offset, length, what) {
  if (!Number.isInteger(offset) || offset < 0 || offset + length > buf.length) {
    throw new Error(`Not a valid PE file: ${what} is outside the file`)
  }
}

/** Parses the PE headers. Returns the section table and the resource directory RVA (0 when there is none). */
export function parsePeHeaders(buf) {
  need(buf, 0, 0x40, 'DOS header')
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('Not a PE file: missing the MZ signature')
  const peOffset = buf.readUInt32LE(0x3c)
  need(buf, peOffset, 24, 'PE header')
  if (buf.readUInt32LE(peOffset) !== 0x00004550) throw new Error('Not a PE file: missing the PE signature')
  const sectionCount = buf.readUInt16LE(peOffset + 6)
  const optSize = buf.readUInt16LE(peOffset + 20)
  const opt = peOffset + 24
  need(buf, opt, Math.min(optSize, 2), 'optional header')
  const magic = buf.readUInt16LE(opt)
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`Unknown optional header magic 0x${magic.toString(16)}`)
  const pe32Plus = magic === 0x20b
  const dirCountAt = opt + (pe32Plus ? 108 : 92)
  const dirsAt = opt + (pe32Plus ? 112 : 96)
  need(buf, dirCountAt, 4, 'data directory count')
  const dirCount = buf.readUInt32LE(dirCountAt)
  let resourceRva = 0
  let resourceSize = 0
  if (dirCount > 2) {
    need(buf, dirsAt + 16, 8, 'resource data directory')
    resourceRva = buf.readUInt32LE(dirsAt + 16)
    resourceSize = buf.readUInt32LE(dirsAt + 20)
  }
  const sectionsAt = opt + optSize
  need(buf, sectionsAt, sectionCount * 40, 'section table')
  const sections = []
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionsAt + i * 40
    sections.push({
      name: buf.toString('latin1', at, at + 8).replace(/\0+$/, ''),
      virtualSize: buf.readUInt32LE(at + 8),
      virtualAddress: buf.readUInt32LE(at + 12),
      rawSize: buf.readUInt32LE(at + 16),
      rawOffset: buf.readUInt32LE(at + 20)
    })
  }
  return { pe32Plus, sections, resourceRva, resourceSize }
}

/** RVA -> file offset through the section table, or null when no section holds it. */
export function rvaToOffset(sections, rva) {
  for (const s of sections) {
    const span = Math.max(s.virtualSize, s.rawSize)
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) return s.rawOffset + (rva - s.virtualAddress)
  }
  return null
}

/** Reads one resource directory level at `base + rel`. Returns [{ id, named, target, isDir }]. */
function readDir(buf, base, rel) {
  const at = base + rel
  need(buf, at, 16, 'resource directory')
  const count = buf.readUInt16LE(at + 12) + buf.readUInt16LE(at + 14)
  if (count > 4096) throw new Error('Resource directory is implausibly large')
  need(buf, at + 16, count * 8, 'resource directory entries')
  const out = []
  for (let i = 0; i < count; i++) {
    const name = buf.readUInt32LE(at + 16 + i * 8)
    const off = buf.readUInt32LE(at + 20 + i * 8)
    out.push({ id: name & 0x7fffffff, named: (name & 0x80000000) !== 0, target: off & 0x7fffffff, isDir: (off & 0x80000000) !== 0 })
  }
  return out
}

/** Every leaf under a resource type: [{ id, bytes: Buffer }] (first language of each name). */
function leavesOfType(buf, base, sections, type) {
  const root = readDir(buf, base, 0)
  const typeEntry = root.find((e) => !e.named && e.id === type && e.isDir)
  if (!typeEntry) return []
  const leaves = []
  for (const nameEntry of readDir(buf, base, typeEntry.target)) {
    if (nameEntry.named || !nameEntry.isDir) continue
    const lang = readDir(buf, base, nameEntry.target).find((e) => !e.isDir)
    if (!lang) continue
    const at = base + lang.target
    need(buf, at, 16, 'resource data entry')
    const dataRva = buf.readUInt32LE(at)
    const size = buf.readUInt32LE(at + 4)
    const off = rvaToOffset(sections, dataRva)
    if (off === null) throw new Error(`Resource data RVA 0x${dataRva.toString(16)} is in no section`)
    need(buf, off, size, 'resource data')
    leaves.push({ id: nameEntry.id, bytes: buf.subarray(off, off + size) })
  }
  return leaves
}

/** 'png', 'bmp' or 'unknown' from the first bytes of an RT_ICON image. */
export function imageFormat(bytes) {
  if (bytes.length >= 4 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'png'
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 40) return 'bmp'
  return 'unknown'
}

/** Parses a PE buffer. Returns { groups: [{ id, entries: [{ width, height, bitCount, bytes, id, format }] }] }. */
export function parseExeIcons(buf) {
  const { sections, resourceRva } = parsePeHeaders(buf)
  if (!resourceRva) return { groups: [] }
  const base = rvaToOffset(sections, resourceRva)
  if (base === null) throw new Error('Not a valid PE file: the resource directory is in no section')
  const images = new Map(leavesOfType(buf, base, sections, RT_ICON).map((l) => [l.id, l.bytes]))
  const groups = []
  for (const leaf of leavesOfType(buf, base, sections, RT_GROUP_ICON)) {
    const d = leaf.bytes
    if (d.length < 6) continue
    const count = d.readUInt16LE(4)
    const entries = []
    for (let i = 0; i < count && 6 + (i + 1) * 14 <= d.length; i++) {
      const at = 6 + i * 14
      const id = d.readUInt16LE(at + 12)
      const image = images.get(id)
      entries.push({
        width: d[at] || 256,
        height: d[at + 1] || 256,
        bitCount: d.readUInt16LE(at + 6),
        bytes: d.readUInt32LE(at + 8),
        id,
        format: image ? imageFormat(image) : 'missing'
      })
    }
    groups.push({ id: leaf.id, entries })
  }
  return { groups }
}

/** Text report for parseExeIcons output. */
export function formatReport(result) {
  if (result.groups.length === 0) return 'No icon group found.'
  const lines = []
  for (const g of result.groups) {
    lines.push(`Icon group ${g.id}: ${g.entries.length} entries`)
    for (const e of g.entries) {
      lines.push(`  ${e.width}x${e.height}  ${e.bitCount}-bit  ${e.bytes} bytes  id ${e.id}  ${e.format}`)
    }
  }
  return lines.join('\n')
}

function main(argv) {
  const file = argv[2]
  if (!file) {
    console.error('Usage: node scripts/check-exe-icon.mjs <path.exe>')
    return 1
  }
  let result
  try {
    result = parseExeIcons(fs.readFileSync(path.resolve(file)))
  } catch (err) {
    console.error(`${file}: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  if (result.groups.length === 0) {
    console.error(`${file}: no icon group (RT_GROUP_ICON) found`)
    return 1
  }
  console.log(formatReport(result))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv)
}
