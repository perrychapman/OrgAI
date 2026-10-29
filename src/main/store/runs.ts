import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RunRecord, RunSummary } from '@shared/types'

const MAX_TRANSCRIPT_ENTRIES = 5000
const MAX_LOG_LINES = 400

/**
 * Persists run summaries in one index file, and one record file per run with the
 * agents, transcript and logs, so a past run can be redrawn after a restart.
 */
export class RunStore {
  private file: string
  private recordsDir: string
  private runs: RunSummary[] = []

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
    // Anything still marked live from a previous app session is actually dead.
    for (const r of this.runs) {
      if (r.status !== 'finished' && r.status !== 'error') {
        r.status = 'finished'
        r.endedAt = r.endedAt ?? Date.now()
      }
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

  private recordPath(runId: string): string {
    return join(this.recordsDir, `${runId.replace(/[^a-z0-9_-]/gi, '_')}.json`)
  }

  saveRecord(record: RunRecord): void {
    mkdirSync(this.recordsDir, { recursive: true })
    const trimmed: RunRecord = {
      ...record,
      transcript: record.transcript.slice(-MAX_TRANSCRIPT_ENTRIES),
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
      const record = JSON.parse(readFileSync(file, 'utf8')) as RunRecord
      // The index is the source of truth for status; a crash can leave a record marked live.
      const summary = this.runs.find((r) => r.id === runId)
      return summary ? { ...record, summary } : record
    } catch {
      return null
    }
  }

  removeRecord(runId: string): void {
    const file = this.recordPath(runId)
    if (existsSync(file)) unlinkSync(file)
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

  /** Delete record files whose run is no longer in the index. */
  sweepOrphans(): number {
    if (!existsSync(this.recordsDir)) return 0
    const known = new Set(this.runs.map((r) => this.recordPath(r.id)))
    let removed = 0
    for (const name of readdirSync(this.recordsDir)) {
      if (!name.endsWith('.json')) continue
      const file = join(this.recordsDir, name)
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
