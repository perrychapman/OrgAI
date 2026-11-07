import { randomBytes } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { OutputNote, OutputNoteAnchor, OutputNoteStatus, OutputRevisionRequest } from '@shared/types'
import {
  OUTPUT_ID_RE,
  OUTPUT_NOTES_MAX,
  OUTPUT_NOTE_ID_RE,
  OUTPUT_NOTE_LABELS_MAX,
  OUTPUT_NOTE_LABEL_MAX_CHARS,
  OUTPUT_NOTE_QUOTE_MAX_CHARS,
  OUTPUT_NOTE_TEXT_MAX,
  OUTPUT_REVISIONS_MAX,
  OUTPUT_REVISION_ID_RE
} from '@shared/types'
import { hiddenCharProblem } from '../capabilities/sanitize'
import { atomicWrite, readPlain } from '../store/projectData'
import { ensureOutputDataDir, outputDataDir } from './versions'

/**
 * Notes (`notes.json`) and revision requests (`revisions.json`) of one output, next to its snapshots in
 * `<data>/projects/<id>/outputs/<outputId>/`. Both are { version: 1, ... }, written atomically; a file that exists but
 * does not parse refuses every write and is never overwritten.
 */

const FILE_MAX_BYTES = 8 * 1024 * 1024

export const NOTES_UNREADABLE = "This output's notes could not be read (damaged or too large); nothing was saved."
export const REVISIONS_UNREADABLE = "This output's revision requests could not be read (damaged or too large); nothing was saved."

export function newNoteId(): string {
  return `note_${randomBytes(8).toString('hex')}`
}

/** A fresh revision request id (rev_ + 16 hex), for callers that name it in the message they compose first. */
export function newRevisionId(): string {
  return `rev_${randomBytes(8).toString('hex')}`
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const offset = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 1e9
const posInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x < 1e9

/** Untrusted document text (a quote, a label): controls and invisible characters become spaces, then cut. Never refused. */
function untrusted(x: unknown, max: number): string {
  if (typeof x !== 'string') return ''
  let s = ''
  for (const ch of x) {
    const c = ch.codePointAt(0) ?? 0
    const hidden =
      c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0xad || c === 0x61c || c === 0x180e || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x2069) || c === 0xfeff || (c >= 0xfff9 && c <= 0xfffb) || (c >= 0xe0000 && c <= 0xe0fff)
    s += hidden ? ' ' : ch
  }
  if (s.length > max) {
    s = s.slice(0, max)
    const last = s.charCodeAt(s.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1)
  }
  return s
}

const BAD_ANCHOR = 'That note position is not valid.'
const TOL = 1e-6

/** Rebuild an anchor field by field from untrusted input; throws a plain sentence when its numbers are wrong. */
export function cleanAnchor(raw: unknown): OutputNoteAnchor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(BAD_ANCHOR)
  const a = raw as Record<string, unknown>
  switch (a.type) {
    case 'whole':
      return { type: 'whole' }
    case 'slide':
      if (!posInt(a.slide)) throw new Error(BAD_ANCHOR)
      return { type: 'slide', slide: a.slide }
    case 'text':
      if (!offset(a.start) || !offset(a.end) || a.start > a.end) throw new Error(BAD_ANCHOR)
      return { type: 'text', start: a.start, end: a.end, quote: untrusted(a.quote, OUTPUT_NOTE_QUOTE_MAX_CHARS) }
    case 'block':
      if (!offset(a.index) || !offset(a.start) || !offset(a.end) || a.start > a.end) throw new Error(BAD_ANCHOR)
      return { type: 'block', index: a.index, start: a.start, end: a.end, quote: untrusted(a.quote, OUTPUT_NOTE_QUOTE_MAX_CHARS) }
    case 'cells': {
      if (!offset(a.r1) || !offset(a.c1) || !offset(a.r2) || !offset(a.c2) || a.r1 > a.r2 || a.c1 > a.c2) throw new Error(BAD_ANCHOR)
      const out: OutputNoteAnchor = { type: 'cells', sheet: untrusted(a.sheet, OUTPUT_NOTE_LABEL_MAX_CHARS), r1: a.r1, c1: a.c1, r2: a.r2, c2: a.c2 }
      if (a.quote !== undefined) out.quote = untrusted(a.quote, OUTPUT_NOTE_QUOTE_MAX_CHARS)
      return out
    }
    case 'region': {
      if (a.shape !== 'box' && a.shape !== 'ellipse') throw new Error(BAD_ANCHOR)
      if (!finite(a.x) || !finite(a.y) || !finite(a.w) || !finite(a.h)) throw new Error(BAD_ANCHOR)
      if (a.x < 0 || a.y < 0 || a.x > 1 || a.y > 1 || a.w <= 0 || a.h <= 0 || a.w > 1 || a.h > 1) throw new Error(BAD_ANCHOR)
      if (a.x + a.w > 1 + TOL || a.y + a.h > 1 + TOL) throw new Error(BAD_ANCHOR)
      const out: OutputNoteAnchor = { type: 'region', shape: a.shape, x: a.x, y: a.y, w: a.w, h: a.h }
      if (a.slide !== undefined) {
        if (!posInt(a.slide)) throw new Error(BAD_ANCHOR)
        out.slide = a.slide
      }
      if (a.labels !== undefined) {
        if (!Array.isArray(a.labels)) throw new Error(BAD_ANCHOR)
        const labels = a.labels.slice(0, OUTPUT_NOTE_LABELS_MAX).filter((l): l is string => typeof l === 'string').map((l) => untrusted(l, OUTPUT_NOTE_LABEL_MAX_CHARS))
        if (labels.length) out.labels = labels
      }
      return out
    }
    default:
      throw new Error(BAD_ANCHOR)
  }
}

/** Note text: 1..OUTPUT_NOTE_TEXT_MAX, no hidden characters (line breaks allowed). Throws a sentence. */
export function cleanNoteText(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('The note must be text.')
  if (!raw.trim()) throw new Error('The note is empty.')
  if (raw.length > OUTPUT_NOTE_TEXT_MAX) throw new Error(`The note is longer than ${OUTPUT_NOTE_TEXT_MAX} characters.`)
  const hidden = hiddenCharProblem('The note', raw, { prose: true })
  if (hidden) throw new Error(hidden)
  return raw
}

function cleanStoredNote(x: unknown, outputId: string): OutputNote | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const n = x as Record<string, unknown>
  if (typeof n.id !== 'string' || !OUTPUT_NOTE_ID_RE.test(n.id)) return undefined
  if (!posInt(n.version) || !finite(n.createdAt) || n.createdAt < 0) return undefined
  if (n.status !== 'open' && n.status !== 'resolved' && n.status !== 'sent') return undefined
  let anchor: OutputNoteAnchor
  let text: string
  try {
    anchor = cleanAnchor(n.anchor)
    text = cleanNoteText(n.text)
  } catch {
    return undefined
  }
  const out: OutputNote = { id: n.id, outputId, version: n.version, anchor, text, status: n.status as OutputNoteStatus, createdAt: n.createdAt }
  if (finite(n.resolvedAt) && n.resolvedAt >= 0) out.resolvedAt = n.resolvedAt
  if (typeof n.sentIn === 'string' && OUTPUT_REVISION_ID_RE.test(n.sentIn)) out.sentIn = n.sentIn
  return out
}

type Read<T> = { state: 'missing' | 'ok' | 'unreadable'; items: T[] }

function readJsonList<T>(file: string, key: string, clean: (x: unknown) => T | undefined): Read<T> {
  try {
    lstatSync(file)
  } catch {
    return { state: 'missing', items: [] }
  }
  const raw = readPlain(file, FILE_MAX_BYTES)
  if (!raw) return { state: 'unreadable', items: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.text)
  } catch {
    return { state: 'unreadable', items: [] }
  }
  const p = parsed as Record<string, unknown> | null
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.version !== 1 || !Array.isArray(p[key])) return { state: 'unreadable', items: [] }
  const items: T[] = []
  for (const x of p[key] as unknown[]) {
    const c = clean(x)
    if (c !== undefined) items.push(c)
  }
  return { state: 'ok', items }
}

export const notesFile = (dataDir: string, projectId: string, outputId: string): string => join(outputDataDir(dataDir, projectId, outputId), 'notes.json')
export const revisionsFile = (dataDir: string, projectId: string, outputId: string): string => join(outputDataDir(dataDir, projectId, outputId), 'revisions.json')

export function readNotes(dataDir: string, projectId: string, outputId: string): Read<OutputNote> {
  return readJsonList(notesFile(dataDir, projectId, outputId), 'notes', (x) => cleanStoredNote(x, outputId))
}

/** Notes for a write: throws when the file exists but is unreadable. */
export function notesForWrite(dataDir: string, projectId: string, outputId: string): OutputNote[] {
  const r = readNotes(dataDir, projectId, outputId)
  if (r.state === 'unreadable') throw new Error(NOTES_UNREADABLE)
  return r.items
}

export function writeNotes(dataDir: string, projectId: string, outputId: string, notes: OutputNote[]): void {
  ensureOutputDataDir(dataDir, projectId, outputId)
  atomicWrite(notesFile(dataDir, projectId, outputId), JSON.stringify({ version: 1, notes }))
}

/** Add a note (all checks except "the version exists", which the service does). */
export function addNote(
  dataDir: string,
  projectId: string,
  outputId: string,
  input: { version: number; anchor: unknown; text: unknown },
  now: number
): { note: OutputNote; all: OutputNote[] } {
  if (!posInt(input.version)) throw new Error('That version is not valid.')
  const text = cleanNoteText(input.text)
  const anchor = cleanAnchor(input.anchor)
  const all = notesForWrite(dataDir, projectId, outputId)
  if (all.length >= OUTPUT_NOTES_MAX) throw new Error(`This output already has ${OUTPUT_NOTES_MAX} notes; remove some first.`)
  const note: OutputNote = { id: newNoteId(), outputId, version: input.version, anchor, text, status: 'open', createdAt: now }
  all.push(note)
  writeNotes(dataDir, projectId, outputId, all)
  return { note, all }
}

export function updateNote(
  dataDir: string,
  projectId: string,
  outputId: string,
  noteId: string,
  patch: { text?: unknown; status?: unknown },
  now: number
): { note: OutputNote; all: OutputNote[] } {
  const all = notesForWrite(dataDir, projectId, outputId)
  const i = typeof noteId === 'string' ? all.findIndex((n) => n.id === noteId) : -1
  if (i < 0) throw new Error('That note is not on this output.')
  const next: OutputNote = { ...all[i] }
  if (patch.text !== undefined) next.text = cleanNoteText(patch.text)
  if (patch.status !== undefined) {
    if (patch.status !== 'open' && patch.status !== 'resolved') throw new Error('A note can be set to open or resolved only.')
    next.status = patch.status
    if (patch.status === 'resolved') next.resolvedAt = now
    else delete next.resolvedAt
    delete next.sentIn
  }
  all[i] = next
  writeNotes(dataDir, projectId, outputId, all)
  return { note: next, all }
}

export function removeNote(dataDir: string, projectId: string, outputId: string, noteId: string): OutputNote[] {
  const all = notesForWrite(dataDir, projectId, outputId)
  const next = typeof noteId === 'string' ? all.filter((n) => n.id !== noteId) : all
  if (next.length === all.length) throw new Error('That note is not on this output.')
  writeNotes(dataDir, projectId, outputId, next)
  return next
}

/** Notes whose status is open (what the badge counts). */
export const openCount = (notes: readonly OutputNote[]): number => notes.filter((n) => n.status === 'open').length

// ---------- revision requests ----------

function cleanRevision(x: unknown, outputId: string): OutputRevisionRequest | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined
  const r = x as Record<string, unknown>
  if (typeof r.id !== 'string' || !OUTPUT_REVISION_ID_RE.test(r.id)) return undefined
  if (!posInt(r.version) || typeof r.runId !== 'string' || !r.runId || r.runId.length > 200 || !finite(r.createdAt)) return undefined
  if (r.mode !== 'sent' && r.mode !== 'continued' && r.mode !== 'started') return undefined
  if (r.scope !== 'whole' && r.scope !== 'selection' && r.scope !== 'notes') return undefined
  const out: OutputRevisionRequest = { id: r.id, outputId, version: r.version, runId: r.runId, mode: r.mode, scope: r.scope, createdAt: r.createdAt }
  if (Array.isArray(r.noteIds)) {
    const ids = r.noteIds.filter((n): n is string => typeof n === 'string' && OUTPUT_NOTE_ID_RE.test(n)).slice(0, OUTPUT_NOTES_MAX)
    if (ids.length) out.noteIds = ids
  }
  if (posInt(r.answeredBy)) out.answeredBy = r.answeredBy
  if (finite(r.endedAt)) out.endedAt = r.endedAt
  return out
}

export function readRevisions(dataDir: string, projectId: string, outputId: string): Read<OutputRevisionRequest> {
  return readJsonList(revisionsFile(dataDir, projectId, outputId), 'requests', (x) => cleanRevision(x, outputId))
}

export function revisionsForWrite(dataDir: string, projectId: string, outputId: string): OutputRevisionRequest[] {
  const r = readRevisions(dataDir, projectId, outputId)
  if (r.state === 'unreadable') throw new Error(REVISIONS_UNREADABLE)
  return r.items
}

export function writeRevisions(dataDir: string, projectId: string, outputId: string, requests: OutputRevisionRequest[]): void {
  ensureOutputDataDir(dataDir, projectId, outputId)
  const kept = requests.length > OUTPUT_REVISIONS_MAX ? requests.slice(requests.length - OUTPUT_REVISIONS_MAX) : requests
  atomicWrite(revisionsFile(dataDir, projectId, outputId), JSON.stringify({ version: 1, requests: kept }))
}

/** Validate a request handed in by RunManager (the id is the caller's, made with newRevisionId). Throws a sentence. */
export function checkRevisionRequest(request: Omit<OutputRevisionRequest, 'answeredBy' | 'endedAt'>, outputId: string): OutputRevisionRequest {
  if (!request || typeof request !== 'object') throw new Error('That revision request is not valid.')
  if (typeof request.id !== 'string' || !OUTPUT_REVISION_ID_RE.test(request.id)) throw new Error('That revision request id is not valid.')
  if (typeof outputId !== 'string' || !OUTPUT_ID_RE.test(outputId)) throw new Error('That revision request is not valid.')
  const c = cleanRevision({ ...request, outputId }, outputId)
  if (!c) throw new Error('That revision request is not valid.')
  delete c.answeredBy
  delete c.endedAt
  return c
}
