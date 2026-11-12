/**
 * Run outputs as terminal text (`orgai outputs`, the TUI's /outputs, `orgai runs show`). Pure: every value comes from
 * the RunOutput records the host listed (types.ts "Run outputs"); callers pass nothing sanitized, everything is cleaned
 * here with safeLine. Untrusted file text (titles, previews) never reaches the terminal raw.
 */
import { join } from 'node:path'
import type { DocumentBlock, DocumentRun, OutputPreview, RunOutput } from '../shared/types'
import { formatDateTime } from '../shared/view/dates'
import { readCappedFile } from './client/readOnlyStore'
import { safe, safeLine } from './output'

/** Lines and characters of a text preview shown in the terminal. */
export const PREVIEW_MAX_LINES = 40
export const PREVIEW_MAX_CHARS = 4000

export function bytesText(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'unknown size'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Number((n / 1024).toFixed(1))} KB`
  return `${Number((n / (1024 * 1024)).toFixed(1))} MB`
}

/** "R3 Quarterly report [out_ab12] docx v2 12 KB" style one-liner (no run tag: callers add it). */
export function outputSummary(o: RunOutput): string {
  const parts = [o.kind, `v${o.version ?? 1}`, bytesText(o.bytes)]
  if (o.missing) parts.push('file missing')
  if (o.openNoteCount) parts.push(`${o.openNoteCount} open note${o.openNoteCount === 1 ? '' : 's'}`)
  return `${safeLine(o.title)} [${safeLine(o.id)}] ${parts.join(' · ')}`
}

/** Outputs made or last changed by this run. */
export const outputsOfRun = (outputs: readonly RunOutput[], runId: string): RunOutput[] => outputs.filter((o) => o.runId === runId || o.current?.runId === runId)

const runsText = (runs: readonly DocumentRun[]): string => runs.map((r) => r.text).join('')

function blockText(b: DocumentBlock): string[] {
  switch (b.type) {
    case 'heading':
    case 'paragraph':
      return [runsText(b.runs)]
    case 'list':
      return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '-'} ${runsText(it)}`)
    case 'table':
      return b.rows.map((row) => row.map(runsText).join(' | '))
    case 'code':
      return b.text.split('\n')
    default:
      return []
  }
}

/** The preview's text (text, svg source, document, sheet and slide text), or undefined for an image or a "none" preview. */
export function previewPlainText(p: OutputPreview): string | undefined {
  switch (p.kind) {
    case 'text':
    case 'svg':
      return p.text
    case 'document':
      return p.blocks.flatMap(blockText).join('\n')
    case 'sheets':
      return p.sheets.flatMap((s) => [`# ${s.name}`, ...s.rows.map((r) => r.map((c) => (c.v === null ? '' : String(c.v))).join(' | '))]).join('\n')
    case 'slides':
      return p.slides.map((s) => `Slide ${s.n}${s.title ? `: ${s.title}` : ''}`).join('\n')
    default:
      return undefined
  }
}

/** The preview as terminal lines: cleaned, at most PREVIEW_MAX_LINES lines and PREVIEW_MAX_CHARS characters. */
export function previewLines(text: string): { lines: string[]; truncated: boolean } {
  const clipped = text.length > PREVIEW_MAX_CHARS
  const all = safe(clipped ? text.slice(0, PREVIEW_MAX_CHARS) : text).split('\n')
  const lines = all.slice(0, PREVIEW_MAX_LINES)
  return { lines, truncated: clipped || all.length > PREVIEW_MAX_LINES }
}

/** The /outputs overlay body: one block per output. */
export function outputsOverlayText(outputs: readonly RunOutput[], when: (ms: number) => string = (ms) => formatDateTime(ms)): string {
  if (outputs.length === 0) return 'This run has produced no outputs yet.'
  const head = `${outputs.length} output${outputs.length === 1 ? '' : 's'} of this run (orgai outputs show <id> shows one)`
  const rows = outputs.map((o) => [`${outputSummary(o)}`, `    ${safeLine(o.relPath)}${o.updatedAt ? ` · updated ${when(o.updatedAt)}` : ''}`].join('\n'))
  return [head, '', ...rows].join('\n')
}

/**
 * How many outputs this run made or changed, from the saved index (`<data>/projects/<id>/outputs.json`), for
 * `orgai runs show` which reads files, not a host. 0 when there is no index or it cannot be read; never throws.
 */
export function countRunOutputs(dataDir: string, projectId: string, runId: string): number {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) return 0
  const text = readCappedFile(join(dataDir, 'projects', projectId, 'outputs.json'), 16 * 1024 * 1024)
  if (text === undefined) return 0
  try {
    const parsed = JSON.parse(text) as { outputs?: unknown }
    const list = Array.isArray(parsed?.outputs) ? (parsed.outputs as Partial<RunOutput>[]) : []
    return list.filter((o) => o && (o.runId === runId || o.current?.runId === runId)).length
  } catch {
    return 0
  }
}
