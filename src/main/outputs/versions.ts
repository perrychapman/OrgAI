import { createHash, randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { OUTPUT_FILE_MAX_BYTES, OUTPUT_ID_RE, OUTPUT_VERSIONS_BYTES_MAX, OUTPUT_VERSIONS_MAX } from '@shared/types'
import { projectDataDir } from '../store/projectData'
import { readRegularCapped } from './paths'
import type { OutputVersionMeta, StoredOutput } from './store'

/**
 * Version snapshots: `<data>/projects/<id>/outputs/<outputId>/v<n>.<ext>`. Names are generated here only (the output id
 * is validated with OUTPUT_ID_RE before any join, the extension is cut to [A-Za-z0-9]). Every write goes through a temp
 * file and a rename; no step follows a link inside the data folder.
 */

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Snapshot extension (no dot) for a file path: the final extension when it is plain, else 'bin'. */
export function snapshotExt(file: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(basename(file))
  return m ? m[1].toLowerCase() : 'bin'
}

/** `<data>/projects/<id>/outputs/<outputId>`; throws for a malformed output id. */
export function outputDataDir(dataDir: string, projectId: string, outputId: string): string {
  if (typeof outputId !== 'string' || !OUTPUT_ID_RE.test(outputId)) throw new Error("That output is not in this project's list.")
  return join(projectDataDir(dataDir, projectId), 'outputs', outputId)
}

export function snapshotPath(dataDir: string, projectId: string, outputId: string, n: number, ext: string): string {
  if (!Number.isInteger(n) || n < 1 || !/^[A-Za-z0-9]{1,10}$/.test(ext)) throw new Error('That version is not valid.')
  return join(outputDataDir(dataDir, projectId, outputId), `v${n}.${ext}`)
}

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** Create the output's data folder after checking every component is a plain folder, not a link. */
export function ensureOutputDataDir(dataDir: string, projectId: string, outputId: string): string {
  const dir = outputDataDir(dataDir, projectId, outputId)
  const base = projectDataDir(dataDir, projectId)
  for (const d of [base, join(base, 'outputs'), dir]) {
    const st = lstatOrNull(d)
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("OrgAI's data folder for this output is not a plain folder.")
    } else mkdirSync(d, { recursive: d === base })
  }
  return dir
}

/** Write a snapshot atomically (tmp + rename). */
export function writeSnapshot(dataDir: string, projectId: string, outputId: string, n: number, ext: string, bytes: Buffer): string {
  const dir = ensureOutputDataDir(dataDir, projectId, outputId)
  const file = snapshotPath(dataDir, projectId, outputId, n, ext)
  const st = lstatOrNull(file)
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new Error("A version file in OrgAI's data folder is not a plain file.")
  const tmp = join(dir, `.v${n}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, bytes, { flag: 'wx' })
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e instanceof Error ? e : new Error(String(e))
  }
  return file
}

/** The snapshot's bytes, or null when it is missing or not a plain file. */
export function readSnapshot(dataDir: string, projectId: string, outputId: string, n: number, ext: string): Buffer | null {
  try {
    const p = snapshotPath(dataDir, projectId, outputId, n, ext)
    const st = lstatSync(p)
    if (!st.isFile() || st.isSymbolicLink()) return null
    return readRegularCapped(p, OUTPUT_FILE_MAX_BYTES, { dev: st.dev, ino: st.ino })
  } catch {
    return null
  }
}

export function removeSnapshot(dataDir: string, projectId: string, outputId: string, n: number, ext: string): void {
  try {
    const p = snapshotPath(dataDir, projectId, outputId, n, ext)
    const st = lstatOrNull(p)
    if (st && !st.isDirectory()) unlinkSync(p)
  } catch {
    /* already gone */
  }
}

/** Remove an output's whole data folder (snapshots, notes, revisions). A link is unlinked, never followed. */
export function removeOutputData(dataDir: string, projectId: string, outputId: string): void {
  try {
    const dir = outputDataDir(dataDir, projectId, outputId)
    const st = lstatOrNull(dir)
    if (!st) return
    if (st.isSymbolicLink()) unlinkSync(dir)
    else rmSync(dir, { recursive: true, force: true })
  } catch {
    /* nothing to clean or not removable */
  }
}

export interface PrunedVersion {
  outputId: string
  n: number
  ext: string
}

export interface PruneOptions {
  versionsMax?: number
  bytesMax?: number
}

/**
 * Apply the version caps in place over a project's entries. A version is droppable unless it is v1, the current
 * (highest) version or labelled. Per output the oldest droppable go first past `versionsMax`; then across the whole
 * project the oldest droppable (by createdAt) go until the byte total fits `bytesMax`. Entries that lost a version get
 * versionsPruned and their derived fields refreshed by the caller (applyVersionFields). Returns what was dropped, so
 * the caller can delete the snapshot files after the index is saved.
 */
export function pruneVersions(entries: StoredOutput[], opts: PruneOptions = {}): PrunedVersion[] {
  const versionsMax = opts.versionsMax ?? OUTPUT_VERSIONS_MAX
  const bytesMax = opts.bytesMax ?? OUTPUT_VERSIONS_BYTES_MAX
  const dropped: PrunedVersion[] = []
  const droppable = (o: StoredOutput, v: OutputVersionMeta): boolean => v.n !== 1 && !v.label && v.n !== o.versions[o.versions.length - 1]?.n
  const drop = (o: StoredOutput, v: OutputVersionMeta): void => {
    o.versions = o.versions.filter((x) => x.n !== v.n)
    o.versionsPruned = true
    dropped.push({ outputId: o.id, n: v.n, ext: v.ext })
  }
  for (const o of entries) {
    while (o.versions.length > versionsMax) {
      const v = o.versions.find((x) => droppable(o, x))
      if (!v) break
      drop(o, v)
    }
  }
  let total = entries.reduce((s, o) => s + o.versions.reduce((t, v) => t + v.bytes, 0), 0)
  if (total > bytesMax) {
    const all: { o: StoredOutput; v: OutputVersionMeta }[] = []
    for (const o of entries) for (const v of o.versions) all.push({ o, v })
    all.sort((a, b) => a.v.createdAt - b.v.createdAt || a.v.n - b.v.n)
    for (const { o, v } of all) {
      if (total <= bytesMax) break
      if (!droppable(o, v)) continue
      drop(o, v)
      total -= v.bytes
    }
  }
  return dropped
}

export const VERSION_STORAGE_FULL = "OrgAI's version storage for this project is full. Delete or remove outputs to make room."

export class VersionStorageFullError extends Error {
  constructor() {
    super(VERSION_STORAGE_FULL)
    this.name = 'VersionStorageFullError'
  }
}

/** Bytes of every stored version in a project. */
export function versionBytesTotal(entries: readonly StoredOutput[]): number {
  return entries.reduce((s, o) => s + o.versions.reduce((t, v) => t + v.bytes, 0), 0)
}

/**
 * Would `extra` more bytes of snapshots fit after pruning everything prunable? Simulated on copies (nothing is
 * changed). `forId` names the entry the bytes become a version of; without it they are a new entry's v1. Throws
 * VersionStorageFullError when the project would still be over `bytesMax`.
 */
export function assertVersionRoom(entries: readonly StoredOutput[], extra: number, forId?: string, bytesMax: number = OUTPUT_VERSIONS_BYTES_MAX, nowMs: number = Date.now()): void {
  const fake = (n: number): OutputVersionMeta => ({ n, source: 'agent', createdAt: nowMs, title: '', bytes: extra, digest: '', ext: 'bin' })
  const copies = entries.map((o) => ({ ...o, versions: [...o.versions] }))
  const target = forId ? copies.find((o) => o.id === forId) : undefined
  if (target) target.versions.push(fake(Math.max(target.version ?? 1, ...target.versions.map((v) => v.n)) + 1))
  else copies.push({ id: '\u0000new', versions: [fake(1)] } as unknown as StoredOutput)
  pruneVersions(copies, { bytesMax })
  if (versionBytesTotal(copies) > bytesMax) throw new VersionStorageFullError()
}
