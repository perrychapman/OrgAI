/**
 * Pure wording and rules for "Ask the team to revise" (docs/design/outputs-2.md 7, 11.4-11.6). No I/O, no React.
 */
import type { OutputKind, OutputReviseOptions, OutputReviseTarget, OutputVersion, RunOutput } from '@shared/types'
import { OUTPUT_REVISE_TEXT_MAX } from '@shared/types'
import { hasHidden } from './hiddenChars'

export type ReviseScope = 'whole' | 'selection' | 'notes'

export const CANNOT_READ_TEXT = 'OrgAI cannot read this kind of file as text.'
export const MISSING_REVISE_TEXT = 'The file is missing, so there is nothing for the team to revise.'
export const SELECT_FIRST_TEXT = 'Select something first'
export const SENT_ANNOUNCEMENT = 'Sent to the team. They will add a new version.'
export const FORMAT_WARNING = 'You changed this file in another app. The team rewrites it from its text, so some formatting may change.'
export const HIDDEN_INSTRUCTION_TEXT = 'The instruction has hidden or control characters. Remove them and try again.'

const UNREADABLE: readonly OutputKind[] = ['image', 'pdf', 'other']

/** Whether the team can be asked to revise this output (spec 11.6: they read it as text). */
export function canRevise(o: Pick<RunOutput, 'kind' | 'missing'>): { ok: true } | { ok: false; reason: string } {
  if (o.missing) return { ok: false, reason: MISSING_REVISE_TEXT }
  if (UNREADABLE.includes(o.kind)) return { ok: false, reason: CANNOT_READ_TEXT }
  return { ok: true }
}

export interface TargetOption {
  value: string
  label: string
  /** Held runs refuse until the user answers; they stay listed and are never the default. */
  held: boolean
}

export function targetValue(t: OutputReviseTarget): string {
  return t.type === 'new' ? 'new' : `run:${t.runId}`
}

export function targetOfValue(v: string): OutputReviseTarget {
  return v.startsWith('run:') ? { type: 'run', runId: v.slice(4) } : { type: 'new' }
}

/** The options in main's order, then "A new run". */
export function targetOptions(opts: OutputReviseOptions | null): TargetOption[] {
  const out: TargetOption[] = []
  for (const r of opts?.runs ?? []) {
    let label: string
    if (r.state === 'held') label = `${r.label}, waiting for you to answer a question first`
    else if (r.state === 'continuable') label = `${r.label}, continue the conversation`
    else label = r.madeCurrent ? `${r.label} (still running)` : `${r.label} (running)`
    out.push({ value: `run:${r.runId}`, label, held: r.state === 'held' })
  }
  if (opts?.newRunAllowed) out.push({ value: 'new', label: 'A new run', held: false })
  return out
}

/** The first option that is not held, else the first. */
export function defaultTarget(options: readonly TargetOption[]): string {
  return (options.find((o) => !o.held) ?? options[0])?.value ?? ''
}

export function consequenceLine(currentVersion: number): string {
  return `The result will be version ${currentVersion + 1}. Version ${currentVersion} stays.`
}

/** Kinds whose file the team rewrites from text, so an outside edit may lose formatting. */
export function formatWarningApplies(kind: OutputKind, versions: readonly Pick<OutputVersion, 'source'>[] | null): boolean {
  if (kind !== 'docx' && kind !== 'xlsx' && kind !== 'pptx') return false
  return (versions ?? []).some((v) => v.source === 'external')
}

export function placeholderFor(kind: OutputKind, scope: ReviseScope): string {
  if (scope === 'notes') return 'Anything to add to the notes (optional)'
  switch (kind) {
    case 'pptx':
      return scope === 'selection' ? 'Make the title slide shorter' : 'Tighten the wording on every slide'
    case 'xlsx':
    case 'csv':
      return 'Add a totals row'
    case 'mermaid':
    case 'svg':
      return 'Rename the database box'
    case 'json':
      return 'Add a "status" field to each entry'
    default:
      return 'Tighten the executive summary'
  }
}

/** A plain reason the instruction cannot be sent, or null. */
export function validateInstruction(scope: ReviseScope, text: string, noteCount = 0): string | null {
  const trimmed = text.trim()
  if (hasHidden(text) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return HIDDEN_INSTRUCTION_TEXT
  if (text.length > OUTPUT_REVISE_TEXT_MAX) return `Keep it under ${OUTPUT_REVISE_TEXT_MAX.toLocaleString('en-US')} characters.`
  if (scope === 'notes') return noteCount === 0 && !trimmed ? 'Pick at least one note.' : null
  return trimmed ? null : 'Say what should change.'
}

export function clockText(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function pendingSentence(runLabel: string, at: number): string {
  return `Waiting for the team's new version. Sent to ${runLabel} at ${clockText(at)}.`
}

export function answeredSentence(who: string, version: number): string {
  return `${who} made version ${version}.`
}

export function compareLabel(previous: number): string {
  return `Compare with version ${previous}`
}

export function endedSentence(runLabel: string): string {
  return `${runLabel} ended without a new version.`
}

export function chipLabel(title: string): string {
  return `Waiting for the team's version of ${title}`
}

export function successAnnouncement(): string {
  return SENT_ANNOUNCEMENT
}

/** The diagram error pane's prefilled instruction. */
export function diagramFixInstruction(message: string, line: number | null): string {
  const first = message.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const where = line !== null ? `line ${line}` : 'the source'
  return `The diagram does not render: it has a syntax error at ${where} (${first.trim().slice(0, 200)}). Fix the syntax and keep the diagram's content.`
}
