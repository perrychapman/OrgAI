import { randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { OutputKind, OutputVersionSource, RunOutput } from '@shared/types'
import {
  OUTPUTS_MAX,
  OUTPUT_DESCRIPTION_MAX_CHARS,
  OUTPUT_ID_RE,
  OUTPUT_KINDS,
  OUTPUT_PATH_MAX_CHARS,
  OUTPUT_REVISION_ID_RE,
  OUTPUT_TITLE_MAX_CHARS,
  OUTPUT_VERSIONS_MAX,
  OUTPUT_VERSION_LABEL_MAX_CHARS
} from '@shared/types'
import { isSafeId } from '@shared/defaults'
import { hiddenCharIn } from '../capabilities/sanitize'
import { log } from '../log'
import { pathKey } from '../quick/scratch'
import { atomicWrite, ensurePlainDir, projectDataDir, readPlain } from '../store/projectData'

/**
 * The outputs index: `<data>/projects/<id>/outputs.json` = { version: 2, outputs: [...] } (no `missing`). Format 1 files
 * (no version fields) still load: each entry reads as version 1 with an empty `versions` list, and the v1 snapshot is
 * made lazily by the service. Reads drop junk entry by entry; a file that exists but is not a { version: 1 | 2, outputs: [] }
 * JSON object reads as empty and refuses every write (never overwritten), like store/knowledge.ts.
 */

const INDEX_MAX_BYTES = 16 * 1024 * 1024

export function outputsFile(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), 'outputs.json')
}

export function newOutputId(): string {
  return `out_${randomBytes(8).toString('hex')}`
}

/** The small record kept per version in the index (the OutputVersion shape minus the derived note counts). */
export interface OutputVersionMeta {
  n: number
  source: OutputVersionSource
  createdAt: number
  runId?: string
  agentId?: string
  role?: string
  title: string
  label?: string
  bytes: number
  digest: string
  answers?: string
  restoredFrom?: number
  /** Snapshot extension (no dot): the file is `v<n>.<ext>`. */
  ext: string
}

/** What the index stores: a RunOutput plus its version records and the last stat seen of the file. */
export interface StoredOutput extends RunOutput {
  versions: OutputVersionMeta[]
  /** size / mtime of the file when it was last captured or written by OrgAI (external-change detection). */
  stat?: { size: number; mtimeMs: number }
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
const posInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x < 1e9

function short(x: unknown, max: number, min = 1): string | undefined {
  return typeof x === 'string' && x.length >= min && x.length <= max && !hiddenCharIn(x) ? x : undefined
}

const SOURCES: readonly OutputVersionSource[] = ['agent', 'edit', 'external', 'restore']
const HEX64 = /^[0-9a-f]{64}$/

export function cleanVersionMeta(x: unknown): OutputVersionMeta | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const v = x as Record<string, unknown>
  if (!posInt(v.n) || !SOURCES.includes(v.source as OutputVersionSource) || !finite(v.createdAt) || !finite(v.bytes)) return undefined
  const title = short(v.title, OUTPUT_TITLE_MAX_CHARS)
  const ext = typeof v.ext === 'string' && /^[A-Za-z0-9]{1,10}$/.test(v.ext) ? v.ext : undefined
  if (!title || !ext || typeof v.digest !== 'string' || !HEX64.test(v.digest)) return undefined
  const out: OutputVersionMeta = { n: v.n, source: v.source as OutputVersionSource, createdAt: v.createdAt, title, bytes: v.bytes, digest: v.digest, ext }
  const runId = short(v.runId, 200)
  if (runId) out.runId = runId
  const agentId = short(v.agentId, 200)
  if (agentId) out.agentId = agentId
  const role = short(v.role, 200)
  if (role) out.role = role
  const label = short(v.label, OUTPUT_VERSION_LABEL_MAX_CHARS)
  if (label) out.label = label
  if (typeof v.answers === 'string' && OUTPUT_REVISION_ID_RE.test(v.answers)) out.answers = v.answers
  if (posInt(v.restoredFrom)) out.restoredFrom = v.restoredFrom
  return out
}

/** The RunOutput fields derived from the version list (the current version is the highest n). */
export function applyVersionFields(o: StoredOutput): StoredOutput {
  if (!o.versions.length) return o
  const cur = o.versions[o.versions.length - 1]
  o.version = cur.n
  o.versionCount = o.versions.length
  o.contentDigest = cur.digest
  o.current = { source: cur.source, at: cur.createdAt }
  if (cur.runId) o.current.runId = cur.runId
  if (cur.agentId) o.current.agentId = cur.agentId
  if (cur.role) o.current.role = cur.role
  return o
}

/** One stored entry validated field by field; undefined when junk. */
export function cleanOutput(x: unknown, projectId: string): StoredOutput | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string' || !OUTPUT_ID_RE.test(o.id)) return undefined
  if (typeof o.kind !== 'string' || !OUTPUT_KINDS.includes(o.kind as OutputKind)) return undefined
  if (o.source !== 'produced' && o.source !== 'registered') return undefined
  const title = short(o.title, OUTPUT_TITLE_MAX_CHARS)
  const fileName = short(o.fileName, 255)
  const path = short(o.path, OUTPUT_PATH_MAX_CHARS)
  const relPath = short(o.relPath, OUTPUT_PATH_MAX_CHARS)
  const runId = short(o.runId, 200)
  if (!title || !fileName || !path || !relPath || !runId || !isAbsolute(path)) return undefined
  if (!finite(o.bytes) || !finite(o.createdAt)) return undefined
  const out: StoredOutput = {
    id: o.id,
    projectId,
    runId,
    kind: o.kind as OutputKind,
    title,
    fileName,
    path,
    relPath,
    bytes: o.bytes,
    createdAt: o.createdAt,
    source: o.source,
    version: 1,
    versionCount: 1,
    openNoteCount: 0,
    versions: []
  }
  if (o.agentId !== undefined) {
    const a = short(o.agentId, 200)
    if (a) out.agentId = a
  }
  if (o.role !== undefined) {
    const r = short(o.role, 200)
    if (r) out.role = r
  }
  if (o.description !== undefined) {
    if (typeof o.description === 'string' && o.description.length <= OUTPUT_DESCRIPTION_MAX_CHARS && !hiddenCharIn(o.description, { prose: true })) {
      if (o.description) out.description = o.description
    }
  }
  if (o.updatedAt !== undefined && finite(o.updatedAt)) out.updatedAt = o.updatedAt
  if (Array.isArray(o.versions)) {
    const seen = new Set<number>()
    const metas: OutputVersionMeta[] = []
    for (const m of o.versions.slice(0, OUTPUT_VERSIONS_MAX + 20)) {
      const c = cleanVersionMeta(m)
      if (c && !seen.has(c.n)) {
        seen.add(c.n)
        metas.push(c)
      }
    }
    metas.sort((a, b) => a.n - b.n)
    out.versions = metas
  }
  if (posInt(o.version) && !out.versions.length) out.version = o.version
  if (posInt(o.versionCount) && !out.versions.length) out.versionCount = o.versionCount
  if (typeof o.contentDigest === 'string' && HEX64.test(o.contentDigest) && !out.versions.length) out.contentDigest = o.contentDigest
  if (finite(o.openNoteCount) && Number.isInteger(o.openNoteCount) && o.openNoteCount < 100000) out.openNoteCount = o.openNoteCount
  if (o.versionsPruned === true) out.versionsPruned = true
  if (o.stat && typeof o.stat === 'object') {
    const s = o.stat as Record<string, unknown>
    if (finite(s.size) && finite(s.mtimeMs)) out.stat = { size: s.size, mtimeMs: s.mtimeMs }
  }
  return applyVersionFields(out)
}

type Loaded = { outputs: StoredOutput[]; state: 'missing' | 'ok' | 'unreadable' }

export function unreadableMessage(file: string): string {
  return `The outputs list could not be read (damaged or too large); nothing was saved. Fix or remove ${file}.`
}

export interface OutputStoreHooks {
  /** Entries dropped past OUTPUTS_MAX: the caller removes their data folders. */
  onDropped?: (projectId: string, ids: string[]) => void
}

export interface OutputStore {
  list(projectId: string): StoredOutput[]
  get(projectId: string, id: string): StoredOutput | undefined
  byPath(projectId: string, path: string): StoredOutput | undefined
  /** Adds an entry (id and projectId filled in); drops the oldest past OUTPUTS_MAX. */
  add(projectId: string, entry: Omit<StoredOutput, 'id' | 'projectId' | 'versions'> & { id?: string; versions?: OutputVersionMeta[] }): StoredOutput
  /** Replaces fields of an existing entry (id, projectId, createdAt, runId, source kept). Version-derived fields follow `versions` when it is given. */
  update(projectId: string, id: string, patch: Partial<Omit<StoredOutput, 'id' | 'projectId' | 'createdAt' | 'runId' | 'source'>>): StoredOutput | undefined
  /** Replaces whole entries in one write (pruning across outputs). Unknown ids are ignored. */
  updateMany(projectId: string, entries: StoredOutput[]): void
  remove(projectId: string, id: string): boolean
}

export function createOutputStore(dataDir: string, hooks: OutputStoreHooks = {}): OutputStore {
  function load(projectId: string): Loaded {
    const file = outputsFile(dataDir, projectId)
    let present = false
    try {
      lstatSync(file)
      present = true
    } catch {
      present = false
    }
    if (!present) return { outputs: [], state: 'missing' }
    const raw = readPlain(file, INDEX_MAX_BYTES)
    if (!raw) return { outputs: [], state: 'unreadable' }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw.text)
    } catch {
      return { outputs: [], state: 'unreadable' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { outputs: [], state: 'unreadable' }
    const p = parsed as { version?: unknown; outputs?: unknown }
    if ((p.version !== 1 && p.version !== 2) || !Array.isArray(p.outputs)) return { outputs: [], state: 'unreadable' }
    const seen = new Set<string>()
    const outputs: StoredOutput[] = []
    for (const e of p.outputs) {
      const c = cleanOutput(e, projectId)
      if (c && !seen.has(c.id)) {
        seen.add(c.id)
        outputs.push(c)
      }
    }
    return { outputs, state: 'ok' }
  }

  function save(projectId: string, outputs: StoredOutput[]): void {
    const dir = projectDataDir(dataDir, projectId)
    ensurePlainDir(dataDir, projectId, dir)
    const stored = outputs.map((o) => {
      const { missing: _m, ...rest } = o as StoredOutput & { missing?: true }
      void _m
      return rest
    })
    atomicWrite(outputsFile(dataDir, projectId), JSON.stringify({ version: 2, outputs: stored }))
  }

  function loadForWrite(projectId: string): StoredOutput[] {
    if (!isSafeId(projectId)) throw new Error("That output is not in this project's list.")
    const l = load(projectId)
    if (l.state === 'unreadable') throw new Error(unreadableMessage(outputsFile(dataDir, projectId)))
    return l.outputs
  }

  const keyOf = (p: string): string => pathKey(p)

  return {
    list(projectId) {
      if (!isSafeId(projectId)) return []
      return load(projectId).outputs.slice()
    },
    get(projectId, id) {
      return this.list(projectId).find((o) => o.id === id)
    },
    byPath(projectId, path) {
      const k = keyOf(path)
      return this.list(projectId).find((o) => keyOf(o.path) === k)
    },
    add(projectId, entry) {
      const all = loadForWrite(projectId)
      const created: StoredOutput = applyVersionFields({ version: 1, versionCount: 1, openNoteCount: 0, ...entry, versions: entry.versions ?? [], id: entry.id && OUTPUT_ID_RE.test(entry.id) ? entry.id : newOutputId(), projectId })
      all.push(created)
      let dropped: string[] = []
      if (all.length > OUTPUTS_MAX) {
        all.sort((a, b) => a.createdAt - b.createdAt)
        const drop = all.splice(0, all.length - OUTPUTS_MAX)
        dropped = drop.map((d) => d.id)
        log.info(`outputs: project ${projectId} passed ${OUTPUTS_MAX} entries; forgot the ${drop.length} oldest (their files stay)`)
      }
      save(projectId, all)
      if (dropped.length) hooks.onDropped?.(projectId, dropped)
      return created
    },
    update(projectId, id, patch) {
      const all = loadForWrite(projectId)
      const i = all.findIndex((o) => o.id === id)
      if (i < 0) return undefined
      const next: StoredOutput = { ...all[i], ...patch }
      if (patch.versions) applyVersionFields(next)
      all[i] = next
      save(projectId, all)
      return next
    },
    updateMany(projectId, entries) {
      const all = loadForWrite(projectId)
      const byId = new Map(entries.map((e) => [e.id, e]))
      save(
        projectId,
        all.map((o) => byId.get(o.id) ?? o)
      )
    },
    remove(projectId, id) {
      const all = loadForWrite(projectId)
      const next = all.filter((o) => o.id !== id)
      if (next.length === all.length) return false
      save(projectId, next)
      return true
    }
  }
}
