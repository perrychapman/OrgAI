import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ImageAttachment, ImageMediaType, RunRecord, RunSummary, TranscriptEntry } from '@shared/types'

const MAX_TRANSCRIPT_ENTRIES = 5000
const MAX_LOG_LINES = 400

const IMAGE_EXT: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
/** The only image refs ever written or read: a content hash plus a known extension, so a ref cannot leave the run's directory. */
const IMAGE_REF = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/

/**
 * Persists run summaries in one index file, and one record file per run with the
 * agents, transcript and logs, so a past run can be redrawn after a restart.
 *
 * Layout under `dataDir`: `runs.json` (index), `runs/<runId>.json` (record) and
 * `runs/<runId>/images/<sha256>.<ext>` (content-addressed bytes of images sent with user messages).
 * Records on disk carry `ImageAttachment.ref` with `data: ''`; getRecord rehydrates `data` and drops `ref`.
 */
export class RunStore {
  private file: string
  private recordsDir: string
  private runs: RunSummary[] = []
  /** Images already written, by object identity, so periodic flushes of a live record skip hashing. */
  private storedImages = new WeakMap<ImageAttachment, string>()

  constructor(dataDir: string) {
    this.file = join(dataDir, 'runs.json')
    this.recordsDir = join(dataDir, 'runs')
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { runs?: RunSummary[] }
        this.runs = Array.isArray(parsed.runs) ? parsed.runs : []
      }
    } catch {
      this.runs = []
    }
    // Anything still marked live from a previous app session is actually dead. Paused runs lose their
    // auto-resume (timers die with the process) but keep pausedUntil, so the Runs tab can offer Continue.
    // endedWithApp tells the UI the session was cut by the app quitting, not closed by the run itself.
    for (const r of this.runs) {
      if (r.status !== 'finished' && r.status !== 'error') {
        r.status = 'finished'
        r.endedAt = r.endedAt ?? Date.now()
        r.endedWithApp = true
      }
      if (r.autoResume) delete r.autoResume
      if (!r.kind) r.kind = 'work'
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, runs: this.runs.slice(-500) }, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  upsert(run: RunSummary): void {
    const idx = this.runs.findIndex((r) => r.id === run.id)
    if (idx === -1) this.runs.push({ ...run })
    else this.runs[idx] = { ...run }
    this.persist()
  }

  list(projectId: string): RunSummary[] {
    return this.runs.filter((r) => r.projectId === projectId).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(runId: string): RunSummary | null {
    const run = this.runs.find((r) => r.id === runId)
    return run ? { ...run } : null
  }

  allProjectIds(): string[] {
    return this.runs.map((r) => r.projectId)
  }

  private safeId(runId: string): string {
    return runId.replace(/[^a-z0-9_-]/gi, '_')
  }

  private recordPath(runId: string): string {
    return join(this.recordsDir, `${this.safeId(runId)}.json`)
  }

  /** Per-run directory beside the record file; holds `images/`. */
  private runDir(runId: string): string {
    return join(this.recordsDir, this.safeId(runId))
  }

  /** Write an image once (content-addressed) and return its ref; null if it could not be written. */
  private storeImage(runId: string, img: ImageAttachment): string | null {
    const known = this.storedImages.get(img)
    if (known) return known
    const ext = IMAGE_EXT[img.mediaType]
    if (!ext) return null
    try {
      const bytes = Buffer.from(img.data, 'base64')
      const ref = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`
      const dir = join(this.runDir(runId), 'images')
      const file = join(dir, ref)
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true })
        const tmp = `${file}.tmp`
        writeFileSync(tmp, bytes)
        renameSync(tmp, file)
      }
      this.storedImages.set(img, ref)
      return ref
    } catch (e) {
      console.warn(`Failed to store an image of run ${runId}; keeping it inline:`, e)
      return null
    }
  }

  /** Copy of the transcript with user images moved to the image store. Never mutates the input. */
  private externalizeImages(runId: string, transcript: TranscriptEntry[]): TranscriptEntry[] {
    return transcript.map((entry) => {
      const block = entry.block
      if (block.kind !== 'user' || !block.images?.length) return entry
      const images = block.images.map((img) => {
        if (!img.data) return img // already a ref (or nothing to store)
        const ref = this.storeImage(runId, img)
        return ref ? { ...img, data: '', ref } : img
      })
      return { ...entry, block: { ...block, images } }
    })
  }

  /** Copy of the transcript with image data read back from the image store and refs removed. */
  private rehydrateImages(runId: string, transcript: TranscriptEntry[]): TranscriptEntry[] {
    if (!Array.isArray(transcript)) return transcript
    return transcript.map((entry) => {
      const block = entry?.block
      if (!block || block.kind !== 'user' || !Array.isArray(block.images) || !block.images.some((i) => i.ref !== undefined)) return entry
      const images = block.images.map((img) => {
        if (img.ref === undefined) return img
        const { ref, ...rest } = img
        let data = ''
        if (typeof ref === 'string' && IMAGE_REF.test(ref)) {
          try {
            data = readFileSync(join(this.runDir(runId), 'images', ref)).toString('base64')
          } catch {
            /* missing or unreadable: warned below */
          }
        }
        if (!data) console.warn(`Image ${String(ref)} of run ${runId} is missing from the image store`)
        return { ...rest, data }
      })
      return { ...entry, block: { ...block, images } }
    })
  }

  saveRecord(record: RunRecord): void {
    mkdirSync(this.recordsDir, { recursive: true })
    const trimmed: RunRecord = {
      ...record,
      transcript: this.externalizeImages(record.summary.id, record.transcript.slice(-MAX_TRANSCRIPT_ENTRIES)),
      logs: record.logs.slice(-MAX_LOG_LINES)
    }
    const file = this.recordPath(record.summary.id)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(trimmed), 'utf8')
    renameSync(tmp, file)
  }

  getRecord(runId: string): RunRecord | null {
    const file = this.recordPath(runId)
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as RunRecord
      const record: RunRecord = { ...parsed, transcript: this.rehydrateImages(runId, parsed.transcript) }
      // The index is the source of truth for status; a crash can leave a record marked live.
      const summary = this.runs.find((r) => r.id === runId)
      return summary ? { ...record, summary } : record
    } catch {
      return null
    }
  }

  /** Delete a run's record file and its directory (image store). */
  removeRecord(runId: string): void {
    const file = this.recordPath(runId)
    if (existsSync(file)) unlinkSync(file)
    rmSync(this.runDir(runId), { recursive: true, force: true })
  }

  /** Forget every run of a project, index entries and record files alike. */
  removeProject(projectId: string): number {
    const gone = this.runs.filter((r) => r.projectId === projectId)
    if (!gone.length) return 0
    this.runs = this.runs.filter((r) => r.projectId !== projectId)
    this.persist()
    for (const r of gone) this.removeRecord(r.id)
    return gone.length
  }

  /** Keep only the newest `keepFor(projectId)` finished runs per project; delete the rest with their records. */
  prune(keepFor: (projectId: string) => number): number {
    const byProject = new Map<string, RunSummary[]>()
    for (const r of this.runs) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r])
    const drop = new Set<string>()
    for (const [projectId, runs] of byProject) {
      const keep = Math.max(1, keepFor(projectId))
      const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt)
      for (const r of sorted.slice(keep)) if (r.status === 'finished' || r.status === 'error') drop.add(r.id)
    }
    if (!drop.size) return 0
    this.runs = this.runs.filter((r) => !drop.has(r.id))
    this.persist()
    for (const id of drop) this.removeRecord(id)
    return drop.size
  }

  /** Delete record files and run directories (image stores) whose run is no longer in the index. */
  sweepOrphans(): number {
    if (!existsSync(this.recordsDir)) return 0
    const known = new Set(this.runs.map((r) => this.recordPath(r.id)))
    const knownDirs = new Set(this.runs.map((r) => this.runDir(r.id)))
    let removed = 0
    for (const name of readdirSync(this.recordsDir)) {
      const file = join(this.recordsDir, name)
      if (!name.endsWith('.json')) {
        try {
          if (statSync(file).isDirectory() && !knownDirs.has(file)) {
            rmSync(file, { recursive: true, force: true })
            removed++
          }
        } catch {
          /* locked or already gone */
        }
        continue
      }
      if (!known.has(file)) {
        try {
          unlinkSync(file)
          removed++
        } catch {
          /* locked or already gone */
        }
      }
    }
    return removed
  }
}
