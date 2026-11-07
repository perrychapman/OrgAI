// Pure helpers for run outputs (docs/design/outputs.md). No React, no DOM, no store.
import type { OutputKind, OutputPreview, RunOutput } from '@shared/types'
import { formatDate } from './dates'

/** Visible name of each kind (plain words; docs/design/outputs.md "Words"). */
export const OUTPUT_KIND_LABEL: Readonly<Record<OutputKind, string>> = {
  docx: 'Document',
  xlsx: 'Spreadsheet',
  mermaid: 'Diagram',
  markdown: 'Markdown',
  text: 'Text',
  csv: 'CSV table',
  json: 'JSON',
  svg: 'SVG image',
  image: 'Image',
  pdf: 'PDF',
  other: 'File'
}

/** Plural chip labels for the kind filter. */
export const OUTPUT_KIND_PLURAL: Readonly<Record<OutputKind, string>> = {
  docx: 'Documents',
  xlsx: 'Spreadsheets',
  mermaid: 'Diagrams',
  markdown: 'Markdown',
  text: 'Text',
  csv: 'CSV tables',
  json: 'JSON',
  svg: 'SVG images',
  image: 'Images',
  pdf: 'PDFs',
  other: 'Other files'
}

export function outputKindLabel(kind: OutputKind): string {
  return OUTPUT_KIND_LABEL[kind] ?? 'File'
}

/** Kinds outputs:open refuses ('other' and svg: an SVG would open in a browser that runs its scripts). */
export const OUTPUT_NOT_OPENABLE: readonly OutputKind[] = ['other', 'svg']

/** Main opens only allowlisted kinds; 'other' and svg files are only shown in their folder or saved. */
export function canOpenOutput(o: Pick<RunOutput, 'kind' | 'missing'>): boolean {
  return !OUTPUT_NOT_OPENABLE.includes(o.kind) && !o.missing
}

/** outputs:delete removes only a produced file under the project's outputs folder. */
export function canDeleteOutput(o: Pick<RunOutput, 'source' | 'missing'>): boolean {
  return o.source === 'produced' && !o.missing
}

/** "512 bytes", "38 KB", "1.2 MB". Never "0 KB" for a non-empty file; an unknown size (not finite) is ''. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return `${Math.round(n)} ${n === 1 ? 'byte' : 'bytes'}`
  const kb = n / 1024
  if (kb < 1024) return `${kb < 10 ? Math.max(1, Math.round(kb * 10) / 10) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`
}

/** "Document · 38 KB · outputs/Project plan.docx". */
export function outputMetaLine(o: Pick<RunOutput, 'kind' | 'bytes' | 'relPath'>): string {
  return [outputKindLabel(o.kind), formatBytes(o.bytes), o.relPath].filter(Boolean).join(' · ')
}

/** "Analyst · R1 · 7 Nov 2026" (role missing = "An agent"; run tag missing = left out). */
export function provenanceLine(o: Pick<RunOutput, 'role' | 'createdAt'>, runTag?: string): string {
  return [o.role?.trim() || 'An agent', runTag, formatDate(o.createdAt)].filter(Boolean).join(' · ')
}

/** Insert an output newest first, or replace the entry with the same id in place. */
export function mergeOutput(list: readonly RunOutput[] | undefined, output: RunOutput): RunOutput[] {
  const cur = list ?? []
  const at = cur.findIndex((o) => o.id === output.id)
  if (at < 0) return [output, ...cur]
  const next = cur.slice()
  next[at] = output
  return next
}

/** The outputs of a set of runs (a chain), newest first, keeping the list's order. */
export function outputsOfRuns(list: readonly RunOutput[] | undefined, runIds: ReadonlySet<string> | readonly string[]): RunOutput[] {
  const ids = runIds instanceof Set ? runIds : new Set(runIds as readonly string[])
  return (list ?? []).filter((o) => ids.has(o.runId))
}

/** "5 outputs" / "1 output". */
export function outputsCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'output' : 'outputs'}`
}

/** Key of a cached preview: a re-produced file changes updatedAt and so misses the cache. */
export function previewKey(o: Pick<RunOutput, 'id' | 'updatedAt' | 'createdAt'>): string {
  return `${o.id}@${o.updatedAt ?? o.createdAt}`
}

/** A small LRU of previews per project (docs/design/outputs.md section 4). */
export class PreviewCache {
  private readonly map = new Map<string, OutputPreview>()
  constructor(private readonly max = 24) {}
  get(key: string): OutputPreview | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key: string, value: OutputPreview): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }
  get size(): number {
    return this.map.size
  }
}

const caches = new Map<string, PreviewCache>()
/** The preview cache of one project (module-level, survives remounts; dropped by forgetPreviewCache). */
export function previewCacheFor(projectId: string): PreviewCache {
  let c = caches.get(projectId)
  if (!c) {
    c = new PreviewCache()
    caches.set(projectId, c)
  }
  return c
}
export function forgetPreviewCache(projectId: string): void {
  caches.delete(projectId)
}
