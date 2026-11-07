/**
 * Pure helpers for output tool calls in run views (docs/design/outputs.md sections 3 and 7): the fold of each
 * produce_output / register_output call and its result into the one harness row main wrote for it, the match from such
 * a row to an index entry, and the polite announcement text. No I/O.
 */

import type { RunOutput, TranscriptEntry } from '@shared/types'
import { OUTPUT_TOOLS } from '@shared/types'
import type { OutputKind } from '@shared/types'
import { OUTPUT_KIND_LABEL, kindLabel } from './outputs'
import { bareToolName } from './transcriptRows'

export type OutputWriteState = 'produced' | 'registered' | 'refused'

/** One transcript row that stands for an output tool call. */
export interface OutputWriteRow {
  state: OutputWriteState
  /** The sentence shown ("Produced document Project plan", "Refused: ..."). */
  text: string
  /** The output's title as the row or result names it ('' for a refusal that names none). */
  title: string
  /** The file's relPath as the result text names it, when it does. */
  relPath?: string
}

export interface OutputCollapse {
  /** Entry ids to hide: the folded calls and results. */
  hidden: Set<string>
  /** Entry id of the row (the harness row, or the refusal's result entry) -> its row. */
  rows: Map<string, OutputWriteRow>
  /** Row entry id -> the tool result text, for the "Show details" disclosure. */
  body: Map<string, string>
}

const PRODUCED_ROW_RE = /^Produced (?:document|workbook|diagram|file) (.*)$/s
const REGISTERED_ROW_RE = /^Registered output (.*)$/s
/** The tool result: `Produced docx "Title" at outputs/x.docx (38 KB). ...`; the title can hold quotes, so greedy up to the last ` at `. */
const RESULT_RE = /^(Produced|Registered) (\S+) "(.*)" at (.*) \([^()]*\)\./s
/** The older words main's harness row uses, mapped to a kind (the file word names no kind). */
const KIND_BY_WORD: Readonly<Record<string, OutputKind>> = { document: 'docx', workbook: 'xlsx', diagram: 'mermaid' }

function isKind(k: string | undefined): k is OutputKind {
  return k !== undefined && Object.prototype.hasOwnProperty.call(OUTPUT_KIND_LABEL, k)
}

/** The kind word in a sentence: the one label, lower case unless it is a proper name (Word, Excel, Markdown, CSV, JSON, SVG, PDF). */
export function kindWord(kind: string | undefined): string {
  if (!isKind(kind)) return 'file'
  const label = kindLabel(kind)
  return /^(Word|Excel|Markdown|CSV|JSON|SVG|PDF)/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1)
}

/** "Produced Word document: Project plan", "Produced diagram: Architecture diagram"; "file" when the kind is unknown. */
export function producedSentence(kind: string | undefined, title: string): string {
  return `Produced ${kindWord(kind)}: ${title}`
}

/** "Registered image: Logo". */
export function registeredSentence(kind: string | undefined, title: string): string {
  return `Registered ${kindWord(kind)}: ${title}`
}

/** produce_output or register_output, bare or `mcp__<server>__...`. */
export function isOutputTool(name: string): boolean {
  const bare = bareToolName(name)
  return bare === OUTPUT_TOOLS.produce || bare === OUTPUT_TOOLS.register
}

/** A harness row main wrote for an output ("Produced document X", "Registered output X"). */
export function isOutputWriteRow(e: TranscriptEntry): boolean {
  return e.source === 'harness' && e.block.kind === 'system' && (PRODUCED_ROW_RE.test(e.block.text) || REGISTERED_ROW_RE.test(e.block.text))
}

interface ParsedResult {
  verb: 'Produced' | 'Registered'
  kind: string
  title: string
  relPath: string
}

function parseResult(text: string): ParsedResult | null {
  const m = RESULT_RE.exec(text)
  return m ? { verb: m[1] as 'Produced' | 'Registered', kind: m[2], title: m[3], relPath: m[4] } : null
}

function rowOfHarness(text: string, res: ParsedResult | null): OutputWriteRow {
  const produced = PRODUCED_ROW_RE.exec(text)
  const registered = produced ? null : REGISTERED_ROW_RE.exec(text)
  const title = res?.title ?? (produced ?? registered)?.[1]?.trim() ?? ''
  const word = produced ? /^Produced (document|workbook|diagram|file) /.exec(text)?.[1] : undefined
  return {
    state: produced ? 'produced' : 'registered',
    text: produced ? producedSentence(isKind(res?.kind) ? res?.kind : word ? KIND_BY_WORD[word] : undefined, title) : registeredSentence(res?.kind, title),
    title,
    relPath: res?.relPath
  }
}

/** The result's own words when no harness row exists (an older record): "Produced document X". */
function rowOfResult(res: ParsedResult): OutputWriteRow {
  const registered = res.verb === 'Registered'
  const text = registered ? registeredSentence(res.kind, res.title) : producedSentence(res.kind, res.title)
  return { state: registered ? 'registered' : 'produced', text, title: res.title, relPath: res.relPath }
}

/** "REFUSED: reason" -> "Refused: reason". */
function refusalText(result: string): string {
  const reason = result.replace(/^REFUSED:\s*/, '').trim()
  return `Refused: ${reason}`
}

/**
 * Fold each output call and its result into one row. A successful call pairs with the same agent's next unclaimed
 * harness row; call and result hide and the result sits under "Show details". A REFUSED result becomes the row and its
 * call hides. A call with no result yet stays as it is.
 */
export function collapseOutputCalls(entries: readonly TranscriptEntry[]): OutputCollapse {
  const hidden = new Set<string>()
  const rows = new Map<string, OutputWriteRow>()
  const body = new Map<string, string>()
  const results = new Map<string, TranscriptEntry>()
  for (const e of entries) if (e.block.kind === 'tool_result') results.set(e.block.toolUseId, e)
  const claimed = new Set<string>()
  entries.forEach((e, idx) => {
    const b = e.block
    if (b.kind !== 'tool_use' || !isOutputTool(b.name)) return
    const res = results.get(b.id)
    if (!res || res.block.kind !== 'tool_result') return
    const text = res.block.content.trim()
    if (res.block.isError || /^REFUSED:/.test(text)) {
      hidden.add(e.id)
      rows.set(res.id, { state: 'refused', text: refusalText(text), title: '' })
      return
    }
    const parsed = parseResult(text)
    const at = entries.findIndex((x, j) => j > idx && !claimed.has(x.id) && x.agentId === e.agentId && isOutputWriteRow(x))
    hidden.add(e.id)
    if (at >= 0) {
      const row = entries[at]
      claimed.add(row.id)
      hidden.add(res.id)
      if (row.block.kind === 'system') rows.set(row.id, rowOfHarness(row.block.text, parsed))
      if (text) body.set(row.id, text)
      return
    }
    if (parsed) {
      // No harness row: the result is the row.
      rows.set(res.id, rowOfResult(parsed))
      if (text) body.set(res.id, text)
      return
    }
    hidden.delete(e.id)
  })
  // Harness rows nothing claimed (a report's row seen from another feed): the sentence alone.
  for (const e of entries) {
    if (rows.has(e.id) || !isOutputWriteRow(e) || e.block.kind !== 'system') continue
    rows.set(e.id, rowOfHarness(e.block.text, null))
  }
  return { hidden, rows, body }
}

/** main writes titles through its datum(): line breaks to spaces, < and > to look-alikes, trimmed, cut at 120. */
function fenced(title: string): string {
  return title
    .replace(/[\s\x85]/g, ' ')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .trim()
    .slice(0, 120)
}

/** The index entry a row names: relPath wins when present, else the latest by title in that run (or any run of a chain). */
export function matchOutputId(
  outputs: readonly RunOutput[] | undefined,
  runId: string | readonly string[],
  title: string,
  relPath?: string
): string | undefined {
  const runs = typeof runId === 'string' ? [runId] : runId
  const mine = (outputs ?? []).filter((o) => runs.includes(o.runId))
  if (relPath) {
    const hit = mine.find((o) => o.relPath === relPath)
    if (hit) return hit.id
  }
  const want = fenced(title)
  if (!want) return undefined
  let best: RunOutput | undefined
  for (const o of mine) {
    if (fenced(o.title) !== want) continue
    if (!best || (o.updatedAt ?? o.createdAt) > (best.updatedAt ?? best.createdAt)) best = o
  }
  return best?.id
}

/** Titles (oldest first) of the chain's outputs not in `said` (those there at the start or already announced); `mine` is newest first. */
export function unannouncedTitles(mine: readonly Pick<RunOutput, 'id' | 'title'>[], said: ReadonlySet<string>): string[] {
  return mine.filter((o) => !said.has(o.id)).map((o) => o.title).reverse()
}

/** The one polite sentence for outputs that arrived since the last announcement. */
export function announceText(newTitles: readonly string[]): string {
  if (newTitles.length === 0) return ''
  if (newTitles.length === 1) return `Produced ${newTitles[0]}`
  return `Produced ${newTitles.length} outputs`
}
