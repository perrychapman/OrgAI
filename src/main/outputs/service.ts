import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type {
  OutputCompareInput,
  OutputDeletePreview,
  OutputDiff,
  OutputKind,
  OutputNote,
  OutputNoteAddInput,
  OutputNoteUpdateInput,
  OutputPreview,
  OutputProduceInput,
  OutputReadInput,
  OutputRegisterInput,
  OutputRestoreResult,
  OutputRevisionRequest,
  OutputSaveEditInput,
  OutputSaveEditResult,
  OutputSourceResult,
  OutputThumb,
  OutputUpdateInput,
  OutputVersion,
  OutputVersionSource,
  RunOutput
} from '@shared/types'
import {
  OUTPUTS_DIR_NAME,
  OUTPUT_DESCRIPTION_MAX_CHARS,
  OUTPUT_EDITABLE_KINDS,
  OUTPUT_EDIT_MAX_BYTES,
  OUTPUT_FILE_MAX_BYTES,
  OUTPUT_KINDS,
  OUTPUT_PPTX_IMAGE_MAX_BYTES,
  OUTPUT_TITLE_MAX_CHARS,
  OUTPUT_VERSION_LABEL_MAX_CHARS,
  outputKindForPath
} from '@shared/types'
import { hiddenCharProblem } from '../capabilities/sanitize'
import { log } from '../log'
import { isInsideEither } from '../quick/scratch'
import type { OutputScope, OutputSource, OutputWriteResult, OutputReadResult, OutputsServiceApi, OutputsServiceEvents, OutputsServiceOptions } from './api'
import type { DeckImageReader, textForAgent } from './formats'
import {
  NOT_OPENABLE_MESSAGE,
  checkDeletableFile,
  checkRegisteredPath,
  checkWritablePath,
  isOpenablePath,
  readRegularCapped,
  relPathFor,
  type CheckedFile,
  resolveProducedTarget,
  sameFile,
  writeFileAtomic,
  writeProduced
} from './paths'
import {
  addNote,
  checkRevisionRequest,
  notesForWrite,
  openCount,
  readNotes,
  readRevisions,
  removeNote,
  revisionsForWrite,
  updateNote,
  writeNotes,
  writeRevisions
} from './notes'
import { type OutputVersionMeta, type StoredOutput, applyVersionFields, createOutputStore, newOutputId } from './store'
import {
  VersionStorageFullError,
  assertVersionRoom,
  pruneVersions,
  readSnapshot,
  removeOutputData,
  removeSnapshot,
  sha256,
  snapshotExt,
  snapshotPath,
  writeSnapshot
} from './versions'

/**
 * The run outputs service (api.ts OutputsServiceApi) over the index store, versions, notes, the path rules, the writers
 * and the previews. Electron-free. Every refusal is an Error whose message is one plain sentence (the union-result
 * channels answer { refused } instead).
 *
 * Serialization: every call that changes an output's file or index (produce, register, saveEdit, restore,
 * captureExternal, delete) runs through one promise queue per PROJECT (a superset of per-output ordering: a run and the
 * user never interleave, and concurrent produces of one file make v2, v3 in call order). The snapshot is always
 * written before the index entry that names it.
 */

/** Previews run on the main thread and one can hold hundreds of MB, so one runs at a time per process; later calls wait. */
// The writers (docx, exceljs, jszip), the previews (mammoth, exceljs) and the format layer pull in about 3 MB of document
// libraries; they load once, on first use, so a host that never produces or previews an output never parses them.
let writersLoad: Promise<typeof import('./writers')> | undefined
let previewLoad: Promise<typeof import('./preview')> | undefined
let formatsLoad: Promise<typeof import('./formats')> | undefined
const writersModule = (): Promise<typeof import('./writers')> => (writersLoad ??= import('./writers'))
const previewModule = (): Promise<typeof import('./preview')> => (previewLoad ??= import('./preview'))
const formatsModule = (): Promise<typeof import('./formats')> => (formatsLoad ??= import('./formats'))

const PREVIEW_QUEUE_MAX = 8
const PREVIEW_BUSY = 'Too many previews are loading. Try again in a moment.'
let previewTail: Promise<unknown> = Promise.resolve()
let previewsPending = 0

function queuedHeavy<T>(run: () => Promise<T>, busy: T): Promise<T> {
  if (previewsPending >= PREVIEW_QUEUE_MAX) return Promise.resolve(busy)
  previewsPending++
  const p = previewTail.then(run)
  previewTail = p.then(
    () => undefined,
    () => undefined
  )
  return p.finally(() => {
    previewsPending--
  })
}

/** Wraps a union-result job so a full version store answers { refused } instead of throwing. */
function refuseWhenFull<R>(fn: () => Promise<R>): () => Promise<R> {
  return async () => {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof VersionStorageFullError) return { refused: err.message } as R
      throw err
    }
  }
}

const THUMB_PARALLEL = 2
let thumbActive = 0
const thumbWaiting: Array<() => void> = []

const THUMB_WAITING_MAX = 50

async function queuedThumb<T>(run: () => Promise<T>, busy: T): Promise<T> {
  if (thumbActive >= THUMB_PARALLEL) {
    if (thumbWaiting.length >= THUMB_WAITING_MAX) return busy
    await new Promise<void>((res) => thumbWaiting.push(res))
  }
  thumbActive++
  try {
    return await run()
  } finally {
    thumbActive--
    thumbWaiting.shift()?.()
  }
}

const NOT_LISTED = "That output is not in this project's list."
const NO_VERSION = 'That version is not stored.'
const NO_WRITE = 'OrgAI cannot write to that folder.'
const CHANGED = 'This output changed. Check it and delete again.'
const EXTERNAL_LOG_MS = 3_600_000

function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('The title must be text.')
  const t = raw.trim()
  if (!t) throw new Error('The title is empty.')
  if (t.length > OUTPUT_TITLE_MAX_CHARS) throw new Error(`The title is longer than ${OUTPUT_TITLE_MAX_CHARS} characters.`)
  const hidden = hiddenCharProblem('The title', t)
  if (hidden) throw new Error(hidden)
  return t
}

function cleanDescription(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error('The description must be text.')
  if (raw.length > OUTPUT_DESCRIPTION_MAX_CHARS) throw new Error(`The description is longer than ${OUTPUT_DESCRIPTION_MAX_CHARS} characters.`)
  const hidden = hiddenCharProblem('The description', raw, { prose: true })
  if (hidden) throw new Error(hidden)
  return raw.trim() ? raw : undefined
}

function cleanLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') throw new Error('The version name must be text.')
  const t = raw.trim()
  if (!t) return undefined
  if (t.length > OUTPUT_VERSION_LABEL_MAX_CHARS) throw new Error(`The version name is longer than ${OUTPUT_VERSION_LABEL_MAX_CHARS} characters.`)
  const hidden = hiddenCharProblem('The version name', t)
  if (hidden) throw new Error(hidden)
  return t
}

function checkScope(scope: OutputScope): void {
  if (!scope || typeof scope.projectId !== 'string' || typeof scope.projectPath !== 'string' || !scope.projectPath) throw new Error('The project folder is not known.')
}

function sourceFields(source: OutputSource): Pick<RunOutput, 'runId' | 'agentId' | 'role'> {
  const out: Pick<RunOutput, 'runId' | 'agentId' | 'role'> = { runId: source.runId }
  if (source.agentId) out.agentId = source.agentId
  if (source.role) out.role = source.role
  return out
}

/** The entry as the renderer sees it: no internal fields. */
function publicEntry(o: StoredOutput): RunOutput {
  const { versions: _v, stat: _s, ...rest } = o
  void _v
  void _s
  return rest
}

/** The entry as listed: missing: true when its file is gone or no longer a regular file. */
function decorate(o: StoredOutput): RunOutput {
  const pub = publicEntry(o)
  try {
    const st = lstatSync(o.path)
    if (st.isFile()) return pub
  } catch {
    /* gone */
  }
  return { ...pub, missing: true }
}

const statOf = (file: string): { size: number; mtimeMs: number } | undefined => {
  try {
    const st = lstatSync(file)
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : undefined
  } catch {
    return undefined
  }
}

const currentMeta = (e: StoredOutput): OutputVersionMeta | undefined => e.versions[e.versions.length - 1]
const nextVersionNumber = (e: StoredOutput): number => Math.max(e.version ?? 1, ...e.versions.map((v) => v.n)) + 1

export function createOutputsService(dataDir: string, options: OutputsServiceOptions & OutputsServiceEvents & { versionsBytesMax?: number } = {}): OutputsServiceApi {
  const now = options.now ?? Date.now
  const bytesMax = options.versionsBytesMax
  /** Throws VersionStorageFullError when `extra` bytes of new snapshots would not fit this project even after pruning. */
  const assertRoom = (projectId: string, extra: number, forId?: string): void => assertVersionRoom(store.list(projectId), extra, forId, bytesMax, now())
  const store = createOutputStore(dataDir, {
    onDropped: (projectId, ids) => {
      for (const id of ids) removeOutputData(dataDir, projectId, id)
    }
  })

  const tails = new Map<string, Promise<void>>()
  function queued<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const key = `p:${projectId}`
    const run = (tails.get(key) ?? Promise.resolve()).then(fn)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }

  const lastExternalLog = new Map<string, number>()
  function logExternalOnce(outputId: string, text: string): void {
    const t = now()
    const last = lastExternalLog.get(outputId)
    if (last !== undefined && t - last < EXTERNAL_LOG_MS) return
    lastExternalLog.set(outputId, t)
    log.warn(`outputs: ${text}`)
  }

  function entryOf(projectId: string, outputId: string): StoredOutput {
    const e = typeof outputId === 'string' ? store.get(projectId, outputId) : undefined
    if (!e) throw new Error(NOT_LISTED)
    return e
  }

  function list(projectId: string): RunOutput[] {
    return store
      .list(projectId)
      .map((o, i) => ({ o, i }))
      .sort((a, b) => b.o.createdAt - a.o.createdAt || b.i - a.i)
      .map((x) => decorate(x.o))
  }

  /** The entry's file after the register rules and "still the stored real path". */
  function currentChecked(scope: OutputScope, e: StoredOutput): CheckedFile {
    const c = checkRegisteredPath(e.path, scope, dataDir)
    if (!sameFile(c.path, e.path)) throw new Error('That file is no longer where the list says it is.')
    return c
  }
  const currentFile = (scope: OutputScope, e: StoredOutput): string => currentChecked(scope, e).path

  function checkedPath(scope: OutputScope, outputId: string): string {
    checkScope(scope)
    return currentFile(scope, entryOf(scope.projectId, outputId))
  }

  function openablePath(scope: OutputScope, outputId: string): string {
    const p = checkedPath(scope, outputId)
    if (!isOpenablePath(p)) throw new Error(NOT_OPENABLE_MESSAGE)
    return p
  }

  // ---------- versions ----------

  /**
   * The first time something needs it, snapshot an index-format-1 entry's file as v1 (only when it is still a regular
   * file under the path rules and still the size the index recorded: otherwise the old content is unknowable and the
   * next version simply becomes v2). Call BEFORE the file is changed. Returns the fresh entry.
   */
  function ensureV1(scope: OutputScope, id: string): StoredOutput {
    const e = entryOf(scope.projectId, id)
    if (e.versions.length) return e
    try {
      const c = currentChecked(scope, e)
      const file = c.path
      const bytes = readRegularCapped(file, OUTPUT_FILE_MAX_BYTES, c)
      if (bytes.length !== e.bytes) return e
      assertRoom(scope.projectId, bytes.length)
      const ext = snapshotExt(e.path)
      const meta: OutputVersionMeta = { n: 1, source: 'agent', createdAt: e.createdAt, title: e.title, bytes: bytes.length, digest: sha256(bytes), ext }
      if (e.runId) meta.runId = e.runId
      if (e.agentId) meta.agentId = e.agentId
      if (e.role) meta.role = e.role
      writeSnapshot(dataDir, scope.projectId, id, 1, ext, bytes)
      return store.update(scope.projectId, id, { versions: [meta], stat: statOf(file) ?? e.stat }) ?? e
    } catch (err) {
      if (err instanceof VersionStorageFullError) throw err
      log.warn(`outputs: could not snapshot version 1 of ${id}: ${(err as Error).message}`)
      return e
    }
  }

  interface Commit {
    source: OutputVersionSource
    bytes: Buffer
    ext: string
    title: string
    runId?: string
    agentId?: string
    role?: string
    answers?: string
    restoredFrom?: number
    stat?: { size: number; mtimeMs: number }
    patch?: Partial<StoredOutput>
  }

  /** Snapshot (first), then the index: add the version, apply the caps. Reads the entry fresh. */
  function commitVersion(projectId: string, id: string, a: Commit): StoredOutput {
    const fresh = entryOf(projectId, id)
    const n = nextVersionNumber(fresh)
    assertRoom(projectId, a.bytes.length, id)
    writeSnapshot(dataDir, projectId, id, n, a.ext, a.bytes)
    const meta: OutputVersionMeta = { n, source: a.source, createdAt: now(), title: a.title, bytes: a.bytes.length, digest: sha256(a.bytes), ext: a.ext }
    if (a.runId) meta.runId = a.runId
    if (a.agentId) meta.agentId = a.agentId
    if (a.role) meta.role = a.role
    if (a.answers) meta.answers = a.answers
    if (a.restoredFrom) meta.restoredFrom = a.restoredFrom
    const next: StoredOutput = { ...fresh, ...a.patch, title: a.title, bytes: a.bytes.length, updatedAt: meta.createdAt, versions: [...fresh.versions, meta] }
    if (a.stat) next.stat = a.stat
    const entries = store.list(projectId).map((o) => (o.id === id ? next : o))
    const dropped = pruneVersions(entries)
    for (const o of entries) applyVersionFields(o)
    store.updateMany(projectId, entries)
    for (const d of dropped) removeSnapshot(dataDir, projectId, d.outputId, d.n, d.ext)
    if (dropped.length) log.info(`outputs: pruned ${dropped.length} old version(s) in project ${projectId}`)
    return entries.find((o) => o.id === id) ?? next
  }

  /** The current file's bytes when the file differs from the current snapshot: records an 'external' version. */
  function captureIfChanged(scope: OutputScope, id: string): StoredOutput {
    const e = entryOf(scope.projectId, id)
    const cur = currentMeta(e)
    if (!cur) return e
    let file: string
    let bytes: Buffer
    try {
      const c = currentChecked(scope, e)
      file = c.path
      if (c.bytes > OUTPUT_FILE_MAX_BYTES) return e
      bytes = readRegularCapped(file, OUTPUT_FILE_MAX_BYTES, c)
    } catch {
      return e
    }
    if (sha256(bytes) === cur.digest) {
      const st = statOf(file)
      if (st && (!e.stat || e.stat.size !== st.size || e.stat.mtimeMs !== st.mtimeMs)) return store.update(scope.projectId, id, { stat: st }) ?? e
      return e
    }
    return commitVersion(scope.projectId, id, { source: 'external', bytes, ext: snapshotExt(e.path), title: e.title, stat: statOf(file) })
  }

  /** The newest unanswered, un-ended revision request when it was sent to `runId`. */
  function openRequestFor(projectId: string, outputId: string, runId: string): OutputRevisionRequest | undefined {
    const r = readRevisions(dataDir, projectId, outputId)
    if (r.state === 'unreadable') return undefined
    const open = r.items.filter((x) => x.answeredBy === undefined && x.endedAt === undefined)
    const newest = open[open.length - 1]
    return newest && newest.runId === runId ? newest : undefined
  }

  function markAnswered(projectId: string, outputId: string, requestId: string, n: number): void {
    try {
      const all = revisionsForWrite(dataDir, projectId, outputId)
      const r = all.find((x) => x.id === requestId)
      if (!r) return
      r.answeredBy = n
      writeRevisions(dataDir, projectId, outputId, all)
    } catch (err) {
      log.warn(`outputs: could not record the answer to ${requestId}: ${(err as Error).message}`)
    }
  }

  function previousOf(e: StoredOutput): OutputWriteResult['previous'] {
    const cur = currentMeta(e)
    return cur ? { n: cur.n, source: cur.source, at: cur.createdAt } : { n: e.version ?? 1, source: 'agent', at: e.updatedAt ?? e.createdAt }
  }

  /** Add an agent version of an existing output from bytes already on disk; answers a revision request when it fits. */
  function agentVersion(projectId: string, e: StoredOutput, bytes: Buffer, ext: string, title: string, source: OutputSource, stat: Commit['stat'], patch: Partial<StoredOutput>): OutputWriteResult {
    const previous = previousOf(e)
    const req = openRequestFor(projectId, e.id, source.runId)
    const out = commitVersion(projectId, e.id, { source: 'agent', bytes, ext, title, runId: source.runId, agentId: source.agentId, role: source.role, answers: req?.id, stat, patch })
    const result: OutputWriteResult = { output: publicEntry(out), created: false, versioned: true, previous }
    if (req) {
      markAnswered(projectId, e.id, req.id, out.version ?? 0)
      result.answered = req.id
    }
    return result
  }

  // ---------- produce / register ----------

  function produce(scope: OutputScope, input: OutputProduceInput, source: OutputSource): Promise<OutputWriteResult> {
    return queued(scope.projectId, async () => {
      checkScope(scope)
      if (!input || typeof input !== 'object') throw new Error('The output request is not valid.')
      const title = cleanTitle(input.title)
      const description = cleanDescription(input.description)
      if (input.fileName !== undefined && typeof input.fileName !== 'string') throw new Error('The file name must be text.')
      const images: DeckImageReader = {
        read(path: string): Buffer {
          const c = checkRegisteredPath(path, scope, dataDir, { strictNames: true })
          if (c.bytes > OUTPUT_PPTX_IMAGE_MAX_BYTES) throw new Error(`That image is larger than ${Math.round(OUTPUT_PPTX_IMAGE_MAX_BYTES / 1024 / 1024)} MB.`)
          return readRegularCapped(c.path, OUTPUT_PPTX_IMAGE_MAX_BYTES, c)
        }
      }
      const bytes = await (await writersModule()).renderProduced(input, images)
      const separate = input.separate === true
      const realOf = (abs: string): string | undefined => {
        try {
          return realpathSync.native(abs)
        } catch {
          return undefined
        }
      }
      const byAnyPath = (abs: string): StoredOutput | undefined => {
        const e = store.byPath(scope.projectId, abs)
        if (e) return e
        const r = realOf(abs)
        if (r) return store.byPath(scope.projectId, r)
        // The file is gone: resolve its nearest existing folder so a lexical spelling (8.3 name, /var) still finds the stored real path.
        const dir = realOf(dirname(abs))
        return dir ? store.byPath(scope.projectId, join(dir, basename(abs))) : undefined
      }
      const target = resolveProducedTarget({ scope, dataDir, kind: input.kind, title, fileName: input.fileName, known: (abs) => !!byAnyPath(abs), separate })
      const existing = separate || target.renamed ? undefined : byAnyPath(target.file)
      const projectId = scope.projectId

      if (existing) {
        // The old content must be snapshotted (v1) and any outside change captured BEFORE the file is replaced.
        ensureV1(scope, existing.id)
        const e = captureIfChanged(scope, existing.id)
        const digest = sha256(bytes)
        const fileThere = !!statOf(target.file)
        if (fileThere && e.contentDigest === digest) {
          const patch: Partial<StoredOutput> = { title }
          if (description !== undefined) patch.description = description
          const updated = store.update(projectId, e.id, patch) ?? e
          return { output: publicEntry(updated), created: false, versioned: false }
        }
        assertRoom(projectId, bytes.length, e.id)
        const written = writeProduced({ ...target, overwrite: fileThere }, bytes)
        void written
        let real = e.path
        const r = realOf(target.file)
        if (r) real = r
        const patch: Partial<StoredOutput> = { path: real, relPath: relPathFor(scope.projectPath, real), fileName: basename(real) }
        if (description !== undefined) patch.description = description
        try {
          return agentVersion(projectId, e, bytes, snapshotExt(real), title, source, statOf(target.file), patch)
        } catch (err) {
          throw new Error(`The file was written to ${relPathFor(scope.projectPath, real)} but could not be added to the outputs list: ${(err as Error).message}`)
        }
      }

      assertRoom(projectId, bytes.length)
      const written = writeProduced({ ...target, overwrite: false }, bytes)
      const real = realOf(target.file) ?? target.file
      const relPath = relPathFor(scope.projectPath, real)
      const createdAt = now()
      try {
        const id = newOutputId()
        const ext = snapshotExt(real)
        writeSnapshot(dataDir, projectId, id, 1, ext, bytes)
        const meta: OutputVersionMeta = { n: 1, source: 'agent', createdAt, title, bytes: written, digest: sha256(bytes), ext, runId: source.runId }
        if (source.agentId) meta.agentId = source.agentId
        if (source.role) meta.role = source.role
        const entry: Omit<StoredOutput, 'id' | 'projectId'> & { id: string } = {
          id,
          ...sourceFields(source),
          kind: input.kind,
          title,
          fileName: basename(real),
          path: real,
          relPath,
          bytes: written,
          createdAt,
          source: 'produced',
          versions: [meta],
          stat: statOf(real)
        }
        if (description) entry.description = description
        return { output: publicEntry(store.add(projectId, entry)), created: true }
      } catch (e) {
        throw new Error(`The file was written to ${relPath} but could not be added to the outputs list: ${(e as Error).message}`)
      }
    })
  }

  function register(scope: OutputScope, input: OutputRegisterInput, source: OutputSource): Promise<OutputWriteResult> {
    return queued(scope.projectId, async () => {
      checkScope(scope)
      if (!input || typeof input !== 'object') throw new Error('The output request is not valid.')
      const title = cleanTitle(input.title)
      const description = cleanDescription(input.description)
      const checked = checkRegisteredPath(input.path, scope, dataDir, { strictNames: true })
      if (/\.pptm$/i.test(checked.path)) throw new Error('Macro-enabled PowerPoint files (.pptm) are not accepted as outputs. Save the deck as .pptx and register that.')
      const inferred = outputKindForPath(checked.path)
      const kind: OutputKind = input.kind ?? inferred
      if (!OUTPUT_KINDS.includes(kind)) throw new Error('That kind of output is not known.')
      // The agent does not pick the kind: the real file's extension does (a .bat is never a "docx").
      if (kind !== inferred) throw new Error(`That file's extension makes it ${inferred === 'other' ? 'an unrecognised file' : `a ${inferred} output`}, not ${kind}; leave the kind out or use ${inferred}.`)
      const projectId = scope.projectId
      const known = store.byPath(projectId, checked.path)
      if (known) {
        if (known.kind !== inferred) log.warn(`outputs: ${known.id} keeps kind ${known.kind}; its path now implies ${inferred}`)
        const e = ensureV1(scope, known.id)
        const bytes = readRegularCapped(checked.path, OUTPUT_FILE_MAX_BYTES, checked)
        const digest = sha256(bytes)
        const base: Partial<StoredOutput> = { relPath: checked.relPath }
        if (description !== undefined) base.description = description
        const cur = currentMeta(e)
        if (cur && cur.digest === digest) {
          const updated = store.update(projectId, e.id, { ...base, title, bytes: bytes.length, stat: statOf(checked.path) }) ?? e
          return { output: publicEntry(updated), created: false, versioned: false }
        }
        return agentVersion(projectId, e, bytes, snapshotExt(checked.path), title, source, statOf(checked.path), base)
      }
      const bytes = readRegularCapped(checked.path, OUTPUT_FILE_MAX_BYTES, checked)
      assertRoom(projectId, bytes.length)
      const createdAt = now()
      const id = newOutputId()
      const ext = snapshotExt(checked.path)
      writeSnapshot(dataDir, projectId, id, 1, ext, bytes)
      const meta: OutputVersionMeta = { n: 1, source: 'agent', createdAt, title, bytes: bytes.length, digest: sha256(bytes), ext, runId: source.runId }
      if (source.agentId) meta.agentId = source.agentId
      if (source.role) meta.role = source.role
      const entry: Omit<StoredOutput, 'id' | 'projectId'> & { id: string } = {
        id,
        ...sourceFields(source),
        kind,
        title,
        fileName: basename(checked.path),
        path: checked.path,
        relPath: checked.relPath,
        bytes: bytes.length,
        createdAt,
        source: 'registered',
        versions: [meta],
        stat: statOf(checked.path)
      }
      if (description) entry.description = description
      return { output: publicEntry(store.add(projectId, entry)), created: true }
    })
  }

  // ---------- previews ----------

  /** Path of one version's bytes: the checked current file, or its snapshot. Throws a sentence. */
  function versionFile(scope: OutputScope, e: StoredOutput, version: number | undefined): string {
    if (version === undefined || version === (e.version ?? 1)) return currentFile(scope, e)
    const meta = e.versions.find((v) => v.n === version)
    if (!meta) throw new Error(NO_VERSION)
    const p = snapshotPath(dataDir, scope.projectId, e.id, meta.n, meta.ext)
    try {
      const st = lstatSync(p)
      if (!st.isFile()) throw new Error('x')
    } catch {
      throw new Error('That version is no longer stored.')
    }
    return p
  }

  async function preview(scope: OutputScope, outputId: string, version?: number): Promise<OutputPreview> {
    checkScope(scope)
    const e = entryOf(scope.projectId, outputId)
    let path: string
    try {
      path = versionFile(scope, e, version)
    } catch (err) {
      return { kind: 'none', reason: (err as Error).message }
    }
    return queuedHeavy(async () => (await previewModule()).previewFile(path, e.kind), { kind: 'none', reason: PREVIEW_BUSY })
  }

  async function thumb(scope: OutputScope, outputId: string, version: number): Promise<OutputThumb> {
    try {
      checkScope(scope)
      const e = entryOf(scope.projectId, outputId)
      const path = versionFile(scope, e, version)
      return await queuedThumb(async () => (await formatsModule()).thumbForFile(path, e.kind), { kind: 'none' })
    } catch {
      return { kind: 'none' }
    }
  }

  async function compare(scope: OutputScope, input: Omit<OutputCompareInput, 'projectId'>): Promise<OutputDiff> {
    try {
      checkScope(scope)
      const e = entryOf(scope.projectId, input.outputId)
      const a = versionFile(scope, e, input.a)
      const b = versionFile(scope, e, input.b)
      return await queuedHeavy(async () => (await formatsModule()).compareFiles(a, b, e.kind), { kind: 'none', reason: PREVIEW_BUSY } as OutputDiff)
    } catch (err) {
      return { kind: 'none', reason: (err as Error).message }
    }
  }

  // ---------- user writes ----------

  const EDIT_REFUSED = 'That kind of file cannot be edited here.'

  async function readSource(scope: OutputScope, outputId: string, version: number): Promise<OutputSourceResult> {
    checkScope(scope)
    const e = entryOf(scope.projectId, outputId)
    if (!OUTPUT_EDITABLE_KINDS.includes(e.kind)) return { refused: EDIT_REFUSED }
    let file: string
    try {
      file = versionFile(scope, e, version)
    } catch (err) {
      return { refused: (err as Error).message }
    }
    try {
      const st = lstatSync(file)
      if (st.size > OUTPUT_EDIT_MAX_BYTES) return { refused: 'That file is too large to edit here.' }
      const bytes = readRegularCapped(file, OUTPUT_EDIT_MAX_BYTES, { dev: st.dev, ino: st.ino })
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
      return { text, digest: sha256(bytes) }
    } catch {
      return { refused: 'OrgAI could not read that file as text.' }
    }
  }

  async function checkEditText(kind: OutputKind, text: string): Promise<string | null> {
    if (kind === 'svg') return (await writersModule()).svgProblem(text) ? 'This drawing contains active content.' : null
    if (kind === 'json') {
      try {
        JSON.parse(text)
      } catch (e) {
        return `The JSON is not valid: ${(e as Error).message}`
      }
      return null
    }
    if (kind === 'mermaid') return (await writersModule()).mermaidProblem(text)
    if (text.includes('\u0000')) return 'The text contains a NUL character.'
    return null
  }

  function saveEdit(scope: OutputScope, input: Omit<OutputSaveEditInput, 'projectId'>): Promise<OutputSaveEditResult> {
    return queued(scope.projectId, refuseWhenFull(async (): Promise<OutputSaveEditResult> => {
      checkScope(scope)
      const e0 = entryOf(scope.projectId, input.outputId)
      if (!OUTPUT_EDITABLE_KINDS.includes(e0.kind)) return { refused: EDIT_REFUSED }
      if (typeof input.text !== 'string') return { refused: 'The text is not valid.' }
      const bytes = Buffer.from(input.text, 'utf8')
      if (bytes.length > OUTPUT_EDIT_MAX_BYTES) return { refused: 'That text is too large to save here.' }
      const problem = await checkEditText(e0.kind, input.text)
      if (problem) return { refused: problem }
      let file: string
      try {
        file = checkWritablePath(e0.path, scope, dataDir)
      } catch {
        return { refused: NO_WRITE }
      }
      const forceNew = input.forceNew === true
      if (input.baseVersion !== (e0.version ?? 1) && !forceNew) return { stale: true, currentVersion: e0.version ?? 1 }
      ensureV1(scope, e0.id)
      const e = captureIfChanged(scope, e0.id)
      // A change made outside OrgAI was just captured: the user's text was not based on it.
      if ((e.version ?? 1) !== (e0.version ?? 1) && !forceNew) return { stale: true, currentVersion: e.version ?? 1 }
      assertRoom(scope.projectId, bytes.length, e.id)
      try {
        writeFileAtomic(file, bytes)
      } catch {
        return { refused: NO_WRITE }
      }
      const out = commitVersion(scope.projectId, e.id, { source: 'edit', bytes, ext: snapshotExt(e.path), title: e.title, stat: statOf(file) })
      return { ok: true, output: publicEntry(out), version: out.version ?? 0 }
    }))
  }

  function restore(scope: OutputScope, outputId: string, version: number): Promise<OutputRestoreResult> {
    return queued(scope.projectId, refuseWhenFull(async (): Promise<OutputRestoreResult> => {
      checkScope(scope)
      const e0 = entryOf(scope.projectId, outputId)
      let file: string
      try {
        file = checkWritablePath(e0.path, scope, dataDir)
      } catch {
        return { refused: NO_WRITE }
      }
      ensureV1(scope, e0.id)
      const e = captureIfChanged(scope, e0.id)
      const meta = e.versions.find((v) => v.n === version)
      if (!meta) return { refused: NO_VERSION }
      const bytes = readSnapshot(dataDir, scope.projectId, e.id, meta.n, meta.ext)
      if (!bytes) return { refused: 'That version is no longer stored.' }
      if (sha256(bytes) !== meta.digest) return { refused: "That version's stored copy is damaged." }
      if (version === (e.version ?? 1) && statOf(file)) return { refused: 'That is already the current version.' }
      assertRoom(scope.projectId, bytes.length, e.id)
      try {
        writeFileAtomic(file, bytes)
      } catch {
        return { refused: NO_WRITE }
      }
      const out = commitVersion(scope.projectId, e.id, { source: 'restore', bytes, ext: snapshotExt(e.path), title: e.title, restoredFrom: version, stat: statOf(file) })
      return { ok: true, output: publicEntry(out), version: out.version ?? 0 }
    }))
  }

  function update(projectId: string, input: Omit<OutputUpdateInput, 'projectId'>): RunOutput {
    const e = entryOf(projectId, input.outputId)
    const patch: Partial<StoredOutput> = {}
    if (input.title !== undefined) patch.title = cleanTitle(input.title)
    let clearDescription = false
    if (input.description !== undefined) {
      const d = cleanDescription(input.description)
      if (d === undefined) clearDescription = true
      else patch.description = d
    }
    if (input.versionLabel !== undefined) {
      const vl = input.versionLabel
      if (!vl || typeof vl !== 'object' || !Number.isInteger(vl.n)) throw new Error('That version is not valid.')
      const label = cleanLabel(vl.label)
      if (!e.versions.some((v) => v.n === vl.n)) throw new Error(NO_VERSION)
      patch.versions = e.versions.map((v) => {
        if (v.n !== vl.n) return v
        const { label: _old, ...rest } = v
        void _old
        return label ? { ...rest, label } : rest
      })
    }
    const saved = store.update(projectId, e.id, clearDescription ? { ...patch, description: undefined } : patch)
    if (!saved) throw new Error(NOT_LISTED)
    return publicEntry(saved)
  }

  function statCurrent(scope: OutputScope, outputId: string): { size: number; mtimeMs: number } | null {
    try {
      const file = checkedPath(scope, outputId)
      const st = lstatSync(file)
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
    } catch {
      return null
    }
  }

  function captureExternal(scope: OutputScope, outputId: string): Promise<RunOutput | null> {
    return queued(scope.projectId, async () => {
      try {
        checkScope(scope)
        const before = entryOf(scope.projectId, outputId)
        let file: string
        try {
          file = currentFile(scope, before)
        } catch {
          return null
        }
        const st = statOf(file)
        if (!st) return null
        if (before.stat && before.stat.size === st.size && before.stat.mtimeMs === st.mtimeMs) return null
        if (!before.versions.length) {
          // Nothing to compare with yet: this is the first look at an old entry. Snapshot it and remember its stat.
          ensureV1(scope, outputId)
          store.update(scope.projectId, outputId, { stat: st })
          return null
        }
        const after = captureIfChanged(scope, outputId)
        if (after.versions.length !== before.versions.length || (after.version ?? 1) !== (before.version ?? 1)) {
          options.onChange?.(scope.projectId, [outputId], 'version')
          return publicEntry(after)
        }
        return null
      } catch (err) {
        logExternalOnce(outputId, `could not check ${outputId} for outside changes: ${(err as Error).message}`)
        return null
      }
    })
  }

  // ---------- delete / forget ----------

  /** Capture a change made outside OrgAI (as an 'external' version) so it is not deleted unseen. True when one was recorded. */
  function captureUnseen(scope: OutputScope, outputId: string): boolean {
    let before = entryOf(scope.projectId, outputId)
    try {
      before = ensureV1(scope, outputId)
    } catch (err) {
      if (!(err instanceof VersionStorageFullError)) throw err
    }
    const after = captureIfChanged(scope, outputId)
    const changed = after.versions.length !== before.versions.length || (after.version ?? 1) !== (before.version ?? 1)
    if (changed) options.onChange?.(scope.projectId, [outputId], 'version')
    return changed
  }

  function deletePreview(scope: OutputScope, outputId: string): OutputDeletePreview {
    checkScope(scope)
    entryOf(scope.projectId, outputId)
    try {
      captureUnseen(scope, outputId)
    } catch (err) {
      log.warn(`outputs: could not check ${outputId} for outside changes before the delete preview: ${(err as Error).message}`)
    }
    const e = entryOf(scope.projectId, outputId)
    let missing = true
    try {
      missing = !lstatSync(e.path).isFile()
    } catch {
      missing = true
    }
    return {
      path: e.path,
      relPath: e.relPath,
      outsideOutputsFolder: !isInsideEither(join(scope.projectPath, OUTPUTS_DIR_NAME), e.path),
      versions: e.versionCount ?? 1,
      trash: !!options.trash,
      missing
    }
  }

  function remove(scope: OutputScope, input: { outputId: string; expectedVersionCount?: number }): Promise<RunOutput[]> {
    return queued(scope.projectId, async () => {
      checkScope(scope)
      entryOf(scope.projectId, input.outputId)
      // Content the user never saw must not be deleted: capture an outside change first, then ask again.
      if (captureUnseen(scope, input.outputId)) throw new Error(CHANGED)
      const e = entryOf(scope.projectId, input.outputId)
      const count = e.versionCount ?? 1
      const mayOmit = e.source === 'produced' && count === 1
      if (input.expectedVersionCount === undefined ? !mayOmit : input.expectedVersionCount !== count) throw new Error(CHANGED)
      const file = checkDeletableFile(e.path, scope, dataDir)
      if (file) {
        let trashed = false
        if (options.trash) {
          try {
            await options.trash(file)
            trashed = true
          } catch (err) {
            log.warn(`outputs: the trash refused ${e.id}; deleting it for good: ${(err as Error).message}`)
          }
        }
        if (!trashed) {
          try {
            unlinkSync(file)
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not delete the file: ${(err as Error).message}`)
          }
        }
      }
      store.remove(scope.projectId, e.id)
      removeOutputData(dataDir, scope.projectId, e.id)
      return list(scope.projectId)
    })
  }

  // ---------- notes and revisions ----------

  function syncOpenCount(projectId: string, outputId: string, all: readonly OutputNote[]): void {
    store.update(projectId, outputId, { openNoteCount: openCount(all) })
  }

  function versionsOf(projectId: string, outputId: string): OutputVersion[] {
    const e = entryOf(projectId, outputId)
    const notes = readNotes(dataDir, projectId, outputId).items
    const counts = (n: number): { noteCount: number; openNoteCount: number } => {
      const mine = notes.filter((x) => x.version === n)
      return { noteCount: mine.length, openNoteCount: mine.filter((x) => x.status === 'open').length }
    }
    const out: OutputVersion[] = e.versions.map((v) => {
      const o: OutputVersion = { n: v.n, source: v.source, createdAt: v.createdAt, title: v.title, bytes: v.bytes, digest: v.digest, ...counts(v.n) }
      if (v.runId) o.runId = v.runId
      if (v.agentId) o.agentId = v.agentId
      if (v.role) o.role = v.role
      if (v.label) o.label = v.label
      if (v.answers) o.answers = v.answers
      if (v.restoredFrom) o.restoredFrom = v.restoredFrom
      return o
    })
    if (!e.versions.length) {
      // An index-format-1 entry nobody has touched yet: answer its one version from the entry (no snapshot exists).
      const v: OutputVersion = { n: e.version ?? 1, source: 'agent', createdAt: e.createdAt, title: e.title, bytes: e.bytes, digest: e.contentDigest ?? '', ...counts(e.version ?? 1) }
      if (e.runId) v.runId = e.runId
      if (e.agentId) v.agentId = e.agentId
      if (e.role) v.role = e.role
      out.push(v)
    }
    return out.sort((a, b) => b.n - a.n)
  }

  function versionExists(e: StoredOutput, n: number): boolean {
    return Number.isInteger(n) && (e.versions.some((v) => v.n === n) || n === (e.version ?? 1))
  }

  async function readForAgent(scope: OutputScope, input: OutputReadInput): Promise<OutputReadResult> {
    checkScope(scope)
    if (!input || typeof input !== 'object') throw new Error('The request is not valid.')
    if (input.action === 'list') {
      const all = list(scope.projectId)
      const items = all.slice(0, 50).map((o) => ({ id: o.id, title: o.title, kind: o.kind, version: o.version ?? 1, openNotes: o.openNoteCount ?? 0, relPath: o.relPath }))
      return { action: 'list', items, more: Math.max(0, all.length - items.length) }
    }
    const e = entryOf(scope.projectId, input.outputId as string)
    const current = e.version ?? 1
    if (input.action === 'read') {
      const version = input.version ?? current
      if (!versionExists(e, version)) throw new Error(NO_VERSION)
      const path = versionFile(scope, e, version)
      const r = await queuedHeavy(async () => (await formatsModule()).textForAgent(path, e.kind), { refused: PREVIEW_BUSY } as Awaited<ReturnType<typeof textForAgent>>)
      if ('refused' in r) throw new Error(r.refused)
      return { action: 'read', id: e.id, title: e.title, kind: e.kind, version, text: r.text, truncated: r.truncated }
    }
    if (input.action === 'notes') {
      const notes = readNotes(dataDir, scope.projectId, e.id).items.filter((n) => (n.status === 'open' || n.status === 'sent') && (input.version === undefined || n.version === input.version))
      return { action: 'notes', id: e.id, title: e.title, version: input.version ?? current, notes }
    }
    throw new Error('That read action is not known.')
  }

  return {
    produce,
    register,
    list,
    get(projectId: string, outputId: string): RunOutput | undefined {
      const e = typeof outputId === 'string' ? store.get(projectId, outputId) : undefined
      return e ? decorate(e) : undefined
    },
    preview,
    checkedPath,
    openablePath,
    forget(projectId: string, outputId: string): RunOutput[] {
      if (typeof outputId !== 'string' || !store.remove(projectId, outputId)) throw new Error(NOT_LISTED)
      removeOutputData(dataDir, projectId, outputId)
      return list(projectId)
    },
    delete: remove,
    deletePreview,
    versions: versionsOf,
    readSource,
    thumb,
    compare,
    saveEdit,
    restore,
    update,
    captureExternal,
    statCurrent,

    notes(projectId, outputId) {
      entryOf(projectId, outputId)
      return readNotes(dataDir, projectId, outputId).items
    },
    noteAdd(projectId, input: Omit<OutputNoteAddInput, 'projectId'>) {
      const e = entryOf(projectId, input.outputId)
      if (!versionExists(e, input.version)) throw new Error(NO_VERSION)
      if (e.kind === 'pdf' || e.kind === 'other') throw new Error('Notes are not available for this kind of file.')
      const { note, all } = addNote(dataDir, projectId, e.id, input, now())
      syncOpenCount(projectId, e.id, all)
      return note
    },
    noteUpdate(projectId, input: Omit<OutputNoteUpdateInput, 'projectId'>) {
      const e = entryOf(projectId, input.outputId)
      const { note, all } = updateNote(dataDir, projectId, e.id, input.noteId, input, now())
      syncOpenCount(projectId, e.id, all)
      return note
    },
    noteRemove(projectId, outputId, noteId) {
      const e = entryOf(projectId, outputId)
      const all = removeNote(dataDir, projectId, e.id, noteId)
      syncOpenCount(projectId, e.id, all)
      return all
    },

    revisions(projectId, outputId) {
      entryOf(projectId, outputId)
      return readRevisions(dataDir, projectId, outputId)
        .items.map((r, i) => ({ r, i }))
        .sort((a, b) => b.r.createdAt - a.r.createdAt || b.i - a.i)
        .map((x) => x.r)
    },
    recordRevision(projectId, request) {
      const e = entryOf(projectId, request?.outputId)
      const checked = checkRevisionRequest(request, e.id)
      const all = revisionsForWrite(dataDir, projectId, e.id).filter((r) => r.id !== checked.id)
      // Notes first: when the notes file cannot be written the request is not recorded either.
      if (checked.noteIds?.length) {
        const notes = notesForWrite(dataDir, projectId, e.id)
        let changed = false
        for (const n of notes) {
          if (checked.noteIds.includes(n.id)) {
            n.status = 'sent'
            n.sentIn = checked.id
            changed = true
          }
        }
        if (changed) {
          writeNotes(dataDir, projectId, e.id, notes)
          syncOpenCount(projectId, e.id, notes)
        }
      }
      all.push(checked)
      writeRevisions(dataDir, projectId, e.id, all)
      return checked
    },
    runEnded(projectId, runId) {
      const touched: string[] = []
      for (const e of store.list(projectId)) {
        try {
          const r = readRevisions(dataDir, projectId, e.id)
          if (r.state !== 'ok') continue
          let changed = false
          for (const q of r.items) {
            if (q.runId === runId && q.answeredBy === undefined && q.endedAt === undefined) {
              q.endedAt = now()
              changed = true
            }
          }
          if (changed) {
            writeRevisions(dataDir, projectId, e.id, r.items)
            touched.push(e.id)
          }
        } catch (err) {
          log.warn(`outputs: could not end the revision requests of ${e.id}: ${(err as Error).message}`)
        }
      }
      if (touched.length) options.onChange?.(projectId, touched, 'revision')
      return touched
    },

    readForAgent
  }
}
