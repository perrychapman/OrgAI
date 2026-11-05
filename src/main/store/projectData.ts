import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngagementDocumentInfo, EngagementNote, EngagementNoteContent, EngagementNoteWriter, Project } from '@shared/types'
import {
  ENGAGEMENT_DOCUMENT_MAX_CHARS,
  ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS,
  ENGAGEMENT_NOTES_MAX,
  ENGAGEMENT_NOTE_EXCERPT_MAX_CHARS,
  ENGAGEMENT_NOTE_MAX_CHARS,
  ENGAGEMENT_NOTE_TITLE_MAX_CHARS
} from '@shared/types'
import { isSafeId, projectDocumentPath, projectRulesLocation } from '@shared/defaults'
import { settingsLocalPath } from '../runtime/permissionRules'
import { clampText, hiddenCharIn, hiddenCharProblem } from '../capabilities/sanitize'

/**
 * Per-project files OrgAI keeps in its own data folder instead of the project folder (engagements write nothing into
 * their working folder). The one place these paths are built:
 *   <data>/projects/<projectId>/ENGAGEMENT.md          the approved engagement document
 *   <data>/projects/<projectId>/permission-rules.json  saved "always allow" rules ({ permissions: { allow: [] } })
 * Project ids are checked with isSafeId, so an id can never climb out of the folder.
 */

/** `<data>/projects/<projectId>`. Throws on an unsafe id. */
export function projectDataDir(dataDir: string, projectId: string): string {
  if (!isSafeId(projectId)) throw new Error('Invalid project id')
  return join(dataDir, 'projects', projectId)
}

/** Delete `<data>/projects/<projectId>` (a missing dir or an unsafe id is ignored; a link is removed, never followed). */
export function removeProjectData(dataDir: string, projectId: string): void {
  try {
    rmSync(projectDataDir(dataDir, projectId), { recursive: true, force: true })
  } catch {
    /* unsafe id or not removable: nothing to clean */
  }
}

/** `<data>/projects/<projectId>/ENGAGEMENT.md`. */
export function engagementDocumentFile(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), projectDocumentPath('engagement'))
}

/** `<data>/projects/<projectId>/permission-rules.json`. */
export function appRulesFile(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), 'permission-rules.json')
}

/**
 * The file holding a project's saved allow rules: `<project>/.claude/settings.local.json` for code projects,
 * appRulesFile for engagements (defaults.ts projectRulesLocation). Both use the same JSON shape, so
 * permissionRules.ts reads and writes either through its file-path functions.
 */
export function projectRulesFile(project: Pick<Project, 'id' | 'path' | 'kind'>, dataDir: string): string {
  return projectRulesLocation(project) === 'app' ? appRulesFile(dataDir, project.id) : settingsLocalPath(project.path)
}

/**
 * The engagement document's text for the prompt, at most `max` characters followed by a truncation note; undefined
 * when there is none (not an engagement document yet, unreadable, not a regular file, or empty).
 */
export function readEngagementDocument(dataDir: string, projectId: string, max = ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS): string | undefined {
  try {
    const file = engagementDocumentFile(dataDir, projectId)
    if (!existsSync(file) || !lstatSync(file).isFile()) return undefined
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
    if (!text.trim()) return undefined
    return text.length > max ? `${text.slice(0, max)}\n\n… (truncated: the engagement document is longer than ${max} characters)` : text
  } catch {
    return undefined
  }
}

// ---------- Engagement document (whole file) and context notes ----------

/** Largest file these helpers read (a document is at most 100,000 characters, a note 50,000). */
const READ_MAX_BYTES = 2 * 1024 * 1024

/** True for a symbolic link (false for anything else, including a missing path). */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Create `dir` (and parents) after checking that the project data folder and `dir` are plain folders, not links. */
export function ensurePlainDir(dataDir: string, projectId: string, dir: string): void {
  const base = projectDataDir(dataDir, projectId)
  for (const d of dir === base ? [base] : [base, dir]) {
    if (existsSync(d) || isLink(d)) {
      const st = lstatSync(d)
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('OrgAI\'s data folder for this project is not a plain folder.')
    } else mkdirSync(d, { recursive: true })
  }
}

/** Write through an exclusive random temp name and rename; refuses a link or non-file at the target. */
export function atomicWrite(file: string, text: string): void {
  if (isLink(file) || (existsSync(file) && !lstatSync(file).isFile())) throw new Error('A file in OrgAI\'s data folder is not a plain file.')
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' })
    renameSync(tmp, file)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/** The text of a regular, non-linked file of at most `maxBytes` (default READ_MAX_BYTES), or null. */
export function readPlain(file: string, maxBytes = READ_MAX_BYTES): { text: string; mtimeMs: number } | null {
  try {
    const st = lstatSync(file)
    if (!st.isFile() || st.size > maxBytes) return null
    return { text: readFileSync(file, 'utf8').replace(/^﻿/, ''), mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

/** The whole engagement document for the editor: { text: '' } when there is none. Never throws. */
export function readEngagementDocumentInfo(dataDir: string, projectId: string): EngagementDocumentInfo {
  try {
    const r = readPlain(engagementDocumentFile(dataDir, projectId))
    if (!r) return { text: '' }
    const meta = readMeta(dataDir, projectId)
    // Without a sidecar (a document written before it existed) the file's mtime and 'setup' stand in.
    return { text: r.text, updatedAt: meta ? meta.updatedAt : Math.round(r.mtimeMs), updatedBy: meta ? meta.updatedBy : 'setup' }
  } catch {
    return { text: '' }
  }
}

/** `<data>/projects/<id>/engagement.meta.json`: { updatedAt, updatedBy } of the document, written next to it. */
export function engagementMetaFile(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), 'engagement.meta.json')
}

function readMeta(dataDir: string, projectId: string): { updatedAt: number; updatedBy: 'user' | 'setup' } | null {
  const raw = readPlain(engagementMetaFile(dataDir, projectId))
  if (!raw) return null
  try {
    const j = JSON.parse(raw.text) as { updatedAt?: unknown; updatedBy?: unknown }
    if (typeof j.updatedAt !== 'number' || !Number.isFinite(j.updatedAt) || j.updatedAt <= 0) return null
    if (j.updatedBy !== 'user' && j.updatedBy !== 'setup') return null
    return { updatedAt: Math.round(j.updatedAt), updatedBy: j.updatedBy }
  } catch {
    return null
  }
}

/** Document first, then the sidecar. Timestamps never go backwards or repeat, so a stale editor is always detected. */
function commitDocument(dataDir: string, projectId: string, text: string, by: 'user' | 'setup'): void {
  ensurePlainDir(dataDir, projectId, projectDataDir(dataDir, projectId))
  const before = readEngagementDocumentInfo(dataDir, projectId).updatedAt ?? 0
  atomicWrite(engagementDocumentFile(dataDir, projectId), text)
  atomicWrite(engagementMetaFile(dataDir, projectId), `${JSON.stringify({ updatedAt: Math.max(Date.now(), before + 1), updatedBy: by })}\n`)
}

/**
 * The setup service's write of the approved engagement document ('setup'): atomic, no limits applied (the text is
 * rendered by OrgAI from the approved charter), empty text is written as is.
 */
export function writeEngagementDocumentFromSetup(dataDir: string, projectId: string, text: string): void {
  commitDocument(dataDir, projectId, text, 'setup')
}

/** The refusal text when the editor's copy is out of date. */
export const ENGAGEMENT_STALE_MESSAGE = 'The engagement plan changed since you opened it. Reload it to see the latest version.'

/**
 * projects:updateEngagementDocument: the user's save. Refused with ENGAGEMENT_STALE_MESSAGE when the stored document's
 * updatedAt differs from `expectedUpdatedAt` (a missing document matches undefined or 0; an omitted value while a
 * document exists is refused too). Then writeEngagementDocument rules apply.
 */
export function updateEngagementDocument(dataDir: string, projectId: string, text: string, expectedUpdatedAt: number | undefined): EngagementDocumentInfo {
  const current = readEngagementDocumentInfo(dataDir, projectId).updatedAt ?? 0
  if (current !== (expectedUpdatedAt ?? 0)) throw new Error(ENGAGEMENT_STALE_MESSAGE)
  return writeEngagementDocument(dataDir, projectId, text, 'user')
}

function checkedText(label: string, text: unknown, max: number): string {
  if (typeof text !== 'string') throw new Error(`${label} must be text.`)
  if (text.length > max) throw new Error(`${label} is longer than ${max.toLocaleString('en-US')} characters (${text.length.toLocaleString('en-US')}). Shorten it; nothing was saved.`)
  // Tab, line feed and carriage return are fine; any other control, zero-width or bidi character is refused.
  const problem = hiddenCharProblem(label, text, { multiline: true })
  if (problem) throw new Error(problem)
  return text
}

/**
 * Save the engagement document (atomic). Text longer than ENGAGEMENT_DOCUMENT_MAX_CHARS or holding hidden characters
 * other than tab, LF and CR is refused, never cut. Empty (or blank) text DELETES the file: "no document" and an empty
 * one read the same everywhere (the prompt, the editor). Returns what is stored afterwards.
 */
export function writeEngagementDocument(dataDir: string, projectId: string, text: string, by: 'user' | 'setup' = 'user'): EngagementDocumentInfo {
  const file = engagementDocumentFile(dataDir, projectId)
  const clean = checkedText('The engagement document', text, ENGAGEMENT_DOCUMENT_MAX_CHARS)
  if (!clean.trim()) {
    if (isLink(file) || existsSync(file)) rmSync(file, { force: true })
    rmSync(engagementMetaFile(dataDir, projectId), { force: true })
    return { text: '' }
  }
  commitDocument(dataDir, projectId, clean, by)
  return readEngagementDocumentInfo(dataDir, projectId)
}

/** True when the document file exists (for the removal result). */
export function engagementDocumentExists(dataDir: string, projectId: string): boolean {
  try {
    return existsSync(engagementDocumentFile(dataDir, projectId))
  } catch {
    return false
  }
}

/** True when the app-folder saved rules file exists (for the removal result). */
export function appRulesExist(dataDir: string, projectId: string): boolean {
  try {
    return existsSync(appRulesFile(dataDir, projectId))
  } catch {
    return false
  }
}

/** `<data>/skill-evaluations/<projectId>.json` (the path skills/evaluation.ts writes), or null for an unsafe id. */
export function skillEvaluationFile(dataDir: string, projectId: string): string | null {
  return isSafeId(projectId) ? join(dataDir, 'skill-evaluations', `${projectId}.json`) : null
}

/** `<data>/team-reviews/<projectId>.json`, or null for an unsafe id. */
export function teamReviewFile(dataDir: string, projectId: string): string | null {
  return isSafeId(projectId) ? join(dataDir, 'team-reviews', `${projectId}.json`) : null
}

/** Delete a file (a link is removed, never followed). Returns whether it existed. Never throws. */
export function removeFileIfExists(file: string | null): boolean {
  if (!file) return false
  try {
    if (!isLink(file) && !existsSync(file)) return false
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

/** Delete the project's skill evaluation file. Returns whether one existed. */
export function removeSkillEvaluation(dataDir: string, projectId: string): boolean {
  return removeFileIfExists(skillEvaluationFile(dataDir, projectId))
}

/** `<data>/projects/<projectId>/context`. */
export function contextDir(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), 'context')
}

function noteFile(dataDir: string, projectId: string, noteId: string): string {
  return join(contextDir(dataDir, projectId), `${noteId}.md`)
}

function indexFile(dataDir: string, projectId: string): string {
  return join(contextDir(dataDir, projectId), 'index.json')
}

function isNoteId(id: unknown): id is string {
  return isSafeId(id) && id.startsWith('note_')
}

/** The first non-empty line of a note's text, hidden characters stripped, at most ENGAGEMENT_NOTE_EXCERPT_MAX_CHARS. */
export function noteExcerpt(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  return clampText(line, ENGAGEMENT_NOTE_EXCERPT_MAX_CHARS)
}

/** A role name or slug as stored on an agent note: 1..120 characters without hidden characters, else undefined. */
function cleanRole(role: unknown): string | undefined {
  if (typeof role !== 'string') return undefined
  const r = role.trim()
  return r && r.length <= ENGAGEMENT_NOTE_TITLE_MAX_CHARS && !hiddenCharIn(r) ? r : undefined
}

/** `recordedBy` of an agent note from untrusted fields: only a safe runId and a clean role survive; undefined when neither does. */
function cleanRecordedBy(runId: unknown, role: unknown): EngagementNote['recordedBy'] {
  const out: { runId?: string; role?: string } = {}
  if (isSafeId(runId)) out.runId = runId
  const r = cleanRole(role)
  if (r !== undefined) out.role = r
  return Object.keys(out).length ? out : undefined
}

/**
 * The index with junk entries, duplicates and entries whose note file is missing dropped; at most ENGAGEMENT_NOTES_MAX.
 * Rows written before `excerpt` / `createdAt` existed are filled from the file (createdAt = updatedAt), never rewritten.
 */
function readIndex(dataDir: string, projectId: string): EngagementNote[] {
  const raw = readPlain(indexFile(dataDir, projectId))
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.text)
  } catch {
    return []
  }
  const list = (parsed as { notes?: unknown } | null)?.notes
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: EngagementNote[] = []
  for (const n of list) {
    if (!n || typeof n !== 'object') continue
    const e = n as Record<string, unknown>
    if (!isNoteId(e.id) || seen.has(e.id)) continue
    if (typeof e.title !== 'string' || !e.title.trim() || e.title.length > ENGAGEMENT_NOTE_TITLE_MAX_CHARS) continue
    if (typeof e.updatedAt !== 'number' || !Number.isFinite(e.updatedAt)) continue
    const file = noteFile(dataDir, projectId, e.id)
    const st = (() => {
      try {
        return lstatSync(file)
      } catch {
        return null
      }
    })()
    if (!st || !st.isFile()) continue
    seen.add(e.id)
    const excerptOk = typeof e.excerpt === 'string' && e.excerpt.length <= ENGAGEMENT_NOTE_EXCERPT_MAX_CHARS && !hiddenCharIn(e.excerpt)
    const excerpt = excerptOk ? (e.excerpt as string) : noteExcerpt(readPlain(file)?.text ?? '')
    const createdAt = typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : e.updatedAt
    const source = e.source === 'agent' ? 'agent' : undefined
    const rb = e.recordedBy && typeof e.recordedBy === 'object' ? (e.recordedBy as Record<string, unknown>) : undefined
    const recordedBy = source && rb ? cleanRecordedBy(rb.runId, rb.role) : undefined
    const updatedBy = e.updatedBy === 'user' || e.updatedBy === 'agent' ? e.updatedBy : undefined
    out.push({
      id: e.id,
      title: e.title,
      excerpt,
      createdAt,
      updatedAt: e.updatedAt,
      chars: typeof e.chars === 'number' && Number.isFinite(e.chars) && e.chars >= 0 ? Math.floor(e.chars) : 0,
      ...(source ? { source } : {}),
      ...(recordedBy ? { recordedBy } : {}),
      ...(updatedBy ? { updatedBy } : {}),
      ...(e.retired === true ? { retired: true } : {})
    })
    if (out.length >= ENGAGEMENT_NOTES_MAX) break
  }
  return out
}

function writeIndex(dataDir: string, projectId: string, notes: EngagementNote[]): void {
  atomicWrite(indexFile(dataDir, projectId), `${JSON.stringify({ version: 1, notes }, null, 2)}\n`)
}

/** The project's context notes, newest first. Never throws. */
export function listNotes(dataDir: string, projectId: string): EngagementNote[] {
  try {
    return readIndex(dataDir, projectId).sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

/** One note with its text, or null when unknown, unreadable or not in the index. */
export function readNote(dataDir: string, projectId: string, noteId: string): EngagementNoteContent | null {
  try {
    if (!isNoteId(noteId)) return null
    const entry = readIndex(dataDir, projectId).find((n) => n.id === noteId)
    if (!entry) return null
    const body = readPlain(noteFile(dataDir, projectId, noteId))
    return body ? { ...entry, text: body.text, chars: body.text.length } : null
  } catch {
    return null
  }
}

/** The refusal when an agent tries to replace a note it may not change. */
export const NOTE_USER_ONLY_MESSAGE = 'Only the user can change that note; save a new one instead.'
/** A replace whose `expectedUpdatedAt` no longer matches the stored note (code 'stale_revision'). */
export const NOTE_STALE_MESSAGE = 'The note changed since it was read. Read it again and redo the edit.'

/**
 * Create a note (no noteId) or replace one (a known noteId; an unknown one throws "Note not found"). Title 1..120
 * characters without hidden characters; text at most ENGAGEMENT_NOTE_MAX_CHARS, hidden characters other than tab, LF and
 * CR refused; at most ENGAGEMENT_NOTES_MAX notes. `writer` is the user (default) or an agent (engagement_context save):
 * an agent may replace only a note whose source is 'agent' and that the user has not saved since (updatedBy !==
 * 'user'), else NOTE_USER_ONLY_MESSAGE. A new note records who created it (`source` 'agent' with `recordedBy`; a user
 * note stores no source); a replace sets `updatedBy` and keeps source and recordedBy. `retired` is the user's only
 * (ignored for agent writers; omitted = unchanged). `expectedUpdatedAt` (replace only) refuses the save with code
 * 'stale_revision' when the stored note's updatedAt differs; the check and the write run synchronously, so nothing in
 * this process writes the note in between. Returns the index entry.
 */
export function saveNote(
  dataDir: string,
  projectId: string,
  input: { noteId?: string; title: string; text: string; retired?: boolean; expectedUpdatedAt?: number },
  writer: EngagementNoteWriter = { by: 'user' }
): EngagementNote {
  if (typeof input.title !== 'string') throw new Error('The title must be text.')
  const title = input.title.trim()
  if (!title) throw new Error('Give the note a title.')
  if (title.length > ENGAGEMENT_NOTE_TITLE_MAX_CHARS) throw new Error(`The title is longer than ${ENGAGEMENT_NOTE_TITLE_MAX_CHARS} characters.`)
  const titleProblem = hiddenCharProblem('The title', title)
  if (titleProblem) throw new Error(titleProblem)
  const text = checkedText('The note', input.text, ENGAGEMENT_NOTE_MAX_CHARS)
  const notes = readIndex(dataDir, projectId)
  const agent = writer.by === 'agent'
  let id: string
  let existing: EngagementNote | undefined
  if (input.noteId !== undefined) {
    existing = isNoteId(input.noteId) ? notes.find((n) => n.id === input.noteId) : undefined
    if (!existing) throw new Error('Note not found')
    if (agent && (existing.source !== 'agent' || existing.updatedBy === 'user')) throw new Error(NOTE_USER_ONLY_MESSAGE)
    if (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) {
      throw Object.assign(new Error(NOTE_STALE_MESSAGE), { code: 'stale_revision' })
    }
    id = existing.id
  } else {
    if (notes.length >= ENGAGEMENT_NOTES_MAX) throw new Error(`A project keeps at most ${ENGAGEMENT_NOTES_MAX} notes. Remove or merge notes first.`)
    do id = `note_${randomBytes(6).toString('hex')}`
    while (notes.some((n) => n.id === id))
  }
  ensurePlainDir(dataDir, projectId, contextDir(dataDir, projectId))
  const now = Date.now()
  const source = existing ? existing.source : agent ? 'agent' : undefined
  const recordedBy = existing ? existing.recordedBy : agent ? cleanRecordedBy(writer.runId, writer.role) : undefined
  const retired = !agent && input.retired !== undefined ? input.retired : existing?.retired
  const entry: EngagementNote = {
    id,
    title,
    excerpt: noteExcerpt(text),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    chars: text.length,
    ...(source ? { source } : {}),
    ...(recordedBy ? { recordedBy } : {}),
    ...(existing ? { updatedBy: writer.by } : {}),
    ...(retired ? { retired: true } : {})
  }
  atomicWrite(noteFile(dataDir, projectId, id), text)
  try {
    writeIndex(dataDir, projectId, [...notes.filter((n) => n.id !== id), entry])
  } catch (err) {
    // A new note whose index entry could not be written would be an orphan file: remove it.
    if (input.noteId === undefined) rmSync(noteFile(dataDir, projectId, id), { force: true })
    throw err
  }
  return entry
}

/** Delete a note; resolves to the remaining notes (an unknown id changes nothing). */
export function removeNote(dataDir: string, projectId: string, noteId: string): EngagementNote[] {
  const notes = readIndex(dataDir, projectId)
  if (!isNoteId(noteId) || !notes.some((n) => n.id === noteId)) return notes.sort((a, b) => b.updatedAt - a.updatedAt)
  const rest = notes.filter((n) => n.id !== noteId)
  ensurePlainDir(dataDir, projectId, contextDir(dataDir, projectId))
  writeIndex(dataDir, projectId, rest)
  rmSync(noteFile(dataDir, projectId, noteId), { force: true })
  return rest.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Most project ids whose run records are kept after the project was removed. */
export const RETAINED_RUN_PROJECTS_MAX = 1000

function retainedFile(dataDir: string): string {
  return join(dataDir, 'retained-run-projects.json')
}

/** Ids of removed projects whose run records the user chose to keep. Junk is dropped; never throws. */
export function readRetainedRunProjects(dataDir: string): Set<string> {
  const out = new Set<string>()
  try {
    const raw = readPlain(retainedFile(dataDir))
    if (!raw) return out
    const list = (JSON.parse(raw.text) as { projectIds?: unknown } | null)?.projectIds
    if (!Array.isArray(list)) return out
    for (const id of list) {
      if (isSafeId(id)) out.add(id)
      if (out.size >= RETAINED_RUN_PROJECTS_MAX) break
    }
  } catch {
    return new Set()
  }
  return out
}

/** Remember that a removed project's runs are kept, so boot housekeeping does not delete them. */
export function retainRunProject(dataDir: string, projectId: string): void {
  if (!isSafeId(projectId)) throw new Error('Invalid project id')
  const ids = readRetainedRunProjects(dataDir)
  if (ids.has(projectId)) return
  const list = [...ids, projectId].slice(-RETAINED_RUN_PROJECTS_MAX)
  mkdirSync(dataDir, { recursive: true })
  atomicWrite(retainedFile(dataDir), `${JSON.stringify({ version: 1, projectIds: list }, null, 2)}\n`)
}

/** Run project ids housekeeping may delete: not live, not retained. */
export function orphanRunProjects(runProjectIds: Iterable<string>, liveIds: ReadonlySet<string>, retained: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const id of new Set(runProjectIds)) if (!liveIds.has(id) && !retained.has(id)) out.push(id)
  return out
}
