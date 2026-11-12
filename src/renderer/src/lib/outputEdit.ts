// Pure logic of the output editor (docs/design/outputs-2.md section 9): JSON validity with a line number, dirty compare,
// read-only reasons and the wording of save results. No React.
import type { OutputKind, OutputSaveEditResult, RunOutput } from '@shared/types'
import { OUTPUT_EDITABLE_KINDS, OUTPUT_EDIT_MAX_BYTES } from '@shared/types'

export const TOO_LARGE_TEXT = 'This file is too large to edit here. Edit it in your own app.'
export const DRAFT_KEPT_TEXT = 'Your unsaved changes were kept. Save or discard them.'
export const NO_CHANGES_TEXT = 'No changes to save.'
export const JSON_INVALID_SAVE = 'Fix the JSON before saving.'
export const SVG_ACTIVE_SAVE = 'This drawing has active content, so it cannot be saved here.'
export const SVG_INVALID_SAVE = 'This is not a complete SVG drawing yet, so it cannot be saved.'
export const SVG_REFUSED_TEXT = 'OrgAI did not show this drawing because it contained active content.'

export type SvgCheck = { state: 'ok' } | { state: 'invalid' } | { state: 'refused'; reason: string }

/** Classifies an SVG source from the result of the preview gate (lib/outputSvg.ts safeMermaidSvg): ok, not a drawing (yet) or active content. */
export function svgCheckOf(result: { ok: true } | { ok: false; reason: string }): SvgCheck {
  if (result.ok) return { state: 'ok' }
  if (result.reason === 'unreadable' || result.reason === 'not a drawing') return { state: 'invalid' }
  return { state: 'refused', reason: result.reason }
}

export function canEditKind(kind: OutputKind): boolean {
  return OUTPUT_EDITABLE_KINDS.includes(kind)
}

export function isDirty(base: string, current: string): boolean {
  return base !== current
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function tooLargeToEdit(text: string): boolean {
  return byteLength(text) > OUTPUT_EDIT_MAX_BYTES
}

export type JsonStatus = { ok: true; line: string } | { ok: false; line: string; at: number; reason: string }

function lineOfOffset(text: string, offset: number): number {
  let line = 1
  const end = Math.min(Math.max(offset, 0), text.length)
  for (let i = 0; i < end; i++) if (text[i] === '\n') line++
  return line
}

function plainReason(message: string): string {
  const m = message.toLowerCase()
  if (m.includes("expected ','") || m.includes('expected a comma')) return 'expected a comma'
  if (m.includes('double-quoted property name') || m.includes('property name')) return 'expected a name in double quotes'
  if (m.includes("expected ':'")) return 'expected a colon'
  if (m.includes('unexpected end') || m.includes('end of json')) return 'the text ends too early'
  if (m.includes('unterminated string') || m.includes('bad control character')) return 'a string is not closed'
  if (m.includes('unexpected non-whitespace') || m.includes('after json')) return 'there is extra text after the end'
  if (m.includes('unexpected token') || m.includes('unexpected character')) return 'unexpected character'
  return 'this is not valid JSON'
}

/** "Valid JSON." or "Line 3: expected a comma". The line comes from the engine's position when it names one. */
export function jsonStatus(text: string): JsonStatus {
  try {
    JSON.parse(text)
    return { ok: true, line: 'Valid JSON.' }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const lineMatch = /\(line (\d+) column \d+\)/.exec(message)
    const posMatch = /position (\d+)/.exec(message)
    const reason = plainReason(message)
    let at = 1
    if (lineMatch) at = Number(lineMatch[1])
    else if (posMatch) at = lineOfOffset(text, Number(posMatch[1]))
    else if (/end of json/i.test(message)) at = Math.max(1, text.split('\n').length)
    return { ok: false, at, reason, line: `Line ${at}: ${reason}` }
  }
}

/** Pretty-printed with 2 spaces and a final line break kept as it was; null when the text is not JSON. */
export function formatJson(text: string): string | null {
  try {
    const out = JSON.stringify(JSON.parse(text), null, 2)
    return /\n$/.test(text) ? out + '\n' : out
  } catch {
    return null
  }
}

export interface ReadOnlyFacts {
  output: Pick<RunOutput, 'missing' | 'kind'>
  isCurrent: boolean
  /** The edit target is in a folder agents may only read (a reference folder). */
  referenceFolder?: boolean
}

/** Why the editor cannot be offered, in plain words; null when it can. */
export function readOnlyReason(f: ReadOnlyFacts): string | null {
  if (f.output.missing) return 'The file is gone.'
  if (!f.isCurrent) return 'Restore this version to edit it.'
  if (f.referenceFolder) return 'OrgAI cannot change this file here: it is in a folder agents may only read.'
  if (!canEditKind(f.output.kind)) return 'OrgAI does not edit this kind of file here. Edit it in your own app.'
  return null
}

/** What Save is waiting for, as a visible line; null when Save can run. */
export function saveBlockedReason(f: { dirty: boolean; jsonOk?: boolean; svgRefused?: boolean; svgInvalid?: boolean }): string | null {
  if (f.svgRefused) return SVG_ACTIVE_SAVE
  if (f.svgInvalid) return SVG_INVALID_SAVE
  if (f.jsonOk === false) return JSON_INVALID_SAVE
  if (!f.dirty) return NO_CHANGES_TEXT
  return null
}

export function savedText(version: number): string {
  return `Saved as version ${version}.`
}

export function staleText(currentVersion: number): string {
  return `Version ${currentVersion} was made while you were editing. Your changes are still here.`
}

export function saveAnywayLabel(currentVersion: number): string {
  return `Save as version ${currentVersion + 1} anyway`
}

export function compareLabel(currentVersion: number): string {
  return `Compare with version ${currentVersion}`
}

export function discardBody(title: string): string {
  return `Discard your changes to ${title}? They cannot be brought back.`
}

export function leaveTitle(title: string): string {
  return `Save your changes to ${title} first?`
}

export type SaveOutcome = { kind: 'saved'; version: number; text: string } | { kind: 'stale'; currentVersion: number; text: string } | { kind: 'refused'; text: string }

/** One answer of outputs:saveEdit as the state the bar shows. */
export function saveOutcome(r: OutputSaveEditResult): SaveOutcome {
  if ('ok' in r) return { kind: 'saved', version: r.version, text: savedText(r.version) }
  if ('stale' in r) return { kind: 'stale', currentVersion: r.currentVersion, text: staleText(r.currentVersion) }
  return { kind: 'refused', text: r.refused }
}

/** "Line 4, column 12" style position for a textarea offset (1-based). */
export function caretPosition(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  const line = lineOfOffset(before, before.length)
  const column = before.length - (before.lastIndexOf('\n') + 1) + 1
  return { line, column }
}
