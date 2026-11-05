import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamFileChange, TeamFilesUndoInfo } from '@shared/types'
import { TEAM_FILES_LIST_MAX } from '@shared/types'
import { atomicWrite, ensurePlainDir, projectDataDir, readPlain } from '../store/projectData'
import type { TeamDoc } from './doc'
import { normalizeDoc } from './digest'

/**
 * `<data>/projects/<projectId>/team-files/`: what OrgAI remembers about a project's team files on this computer.
 *   state.json     bookkeeping (digests, flags, the last applied changes, undo info)
 *   approved.json  the team in use (a TeamDoc)
 *   undo.json      the team Undo restores (a TeamDoc)
 * Everything lives under `<data>/projects/<id>/`, which project removal deletes (removeProjectData). Reads are tolerant:
 * junk or a missing file means "no snapshot", never a throw. Writes are atomic through projectData's helpers.
 */

export interface TeamFilesState {
  /** Digest of the files as last looked at (the stamp fast path and rejection lifting use the parsed digest). */
  lastKnownDigest?: string
  /** The user refused the files with this digest. */
  rejectedDigest?: string
  /** The files were written from (or adopted into) this computer's team once. */
  migrated?: boolean
  /** "Remove OrgAI files" ran: nothing is read or written until teamFiles:enable. */
  removed?: boolean
  /** No team of this folder was approved yet: every difference needs approval. */
  firstSeen?: boolean
  /** The document a failed write was based on; retried at the next check. */
  dirtyBefore?: TeamDoc
  /** The changes last applied at once from the files. */
  applied?: TeamFileChange[]
  /** What Undo would restore (the document is in undo.json). */
  undo?: TeamFilesUndoInfo
  /** The last Undo that ran. */
  lastUndo?: TeamFilesUndoInfo
}

const BIG = 160 * 1024 * 1024

export function teamFilesDir(dataDir: string, projectId: string): string {
  return join(projectDataDir(dataDir, projectId), 'team-files')
}

const stateFile = (d: string, id: string): string => join(teamFilesDir(d, id), 'state.json')
const approvedFile = (d: string, id: string): string => join(teamFilesDir(d, id), 'approved.json')
const undoFile = (d: string, id: string): string => join(teamFilesDir(d, id), 'undo.json')

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A TeamDoc from junk, or null when its shape is not one. */
export function docFromJson(v: unknown): TeamDoc | null {
  try {
    if (!isObj(v) || !isObj(v.settings) || typeof v.settings.brief !== 'string' || typeof v.settings.permissionMode !== 'string') return null
    if (!Array.isArray(v.roles) || !Array.isArray(v.skills) || !Array.isArray(v.mcp)) return null
    const ok = (list: unknown[], key: string): boolean => list.every((x) => isObj(x) && typeof x[key] === 'string')
    if (!ok(v.roles, 'slug') || !ok(v.skills, 'name') || !ok(v.mcp, 'name')) return null
    return normalizeDoc(v as unknown as TeamDoc)
  } catch {
    return null
  }
}

function readJson(file: string): unknown {
  const raw = readPlain(file, BIG)
  if (!raw) return undefined
  try {
    return JSON.parse(raw.text)
  } catch {
    return undefined
  }
}

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined)

function cleanChanges(v: unknown): TeamFileChange[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: TeamFileChange[] = []
  for (const c of v.slice(0, TEAM_FILES_LIST_MAX)) {
    if (isObj(c) && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.file === 'string' && typeof c.summary === 'string') out.push(c as unknown as TeamFileChange)
  }
  return out
}

function cleanInfo(v: unknown): TeamFilesUndoInfo | undefined {
  if (!isObj(v) || typeof v.at !== 'string' || typeof v.label !== 'string' || !Array.isArray(v.files)) return undefined
  return { at: v.at.slice(0, 40), label: v.label.slice(0, 300), files: v.files.filter((f): f is string => typeof f === 'string').slice(0, TEAM_FILES_LIST_MAX) }
}

export class TeamFilesStore {
  constructor(private dataDir: string) {}

  readState(projectId: string): TeamFilesState {
    try {
      const j = readJson(stateFile(this.dataDir, projectId))
      if (!isObj(j)) return {}
      const s: TeamFilesState = {}
      const last = str(j.lastKnownDigest, 128)
      if (last) s.lastKnownDigest = last
      const rej = str(j.rejectedDigest, 128)
      if (rej) s.rejectedDigest = rej
      if (j.migrated === true) s.migrated = true
      if (j.removed === true) s.removed = true
      if (j.firstSeen === true) s.firstSeen = true
      const dirty = docFromJson(j.dirtyBefore)
      if (dirty) s.dirtyBefore = dirty
      const applied = cleanChanges(j.applied)
      if (applied?.length) s.applied = applied
      const undo = cleanInfo(j.undo)
      if (undo) s.undo = undo
      const lastUndo = cleanInfo(j.lastUndo)
      if (lastUndo) s.lastUndo = lastUndo
      return s
    } catch {
      return {}
    }
  }

  writeState(projectId: string, state: TeamFilesState): void {
    this.write(projectId, stateFile(this.dataDir, projectId), JSON.stringify(state))
  }

  readApproved(projectId: string): TeamDoc | null {
    try {
      return docFromJson(readJson(approvedFile(this.dataDir, projectId)))
    } catch {
      return null
    }
  }

  writeApproved(projectId: string, doc: TeamDoc): void {
    this.write(projectId, approvedFile(this.dataDir, projectId), JSON.stringify(doc))
  }

  readUndo(projectId: string): TeamDoc | null {
    try {
      return docFromJson(readJson(undoFile(this.dataDir, projectId)))
    } catch {
      return null
    }
  }

  /** The document Undo restores; null deletes it. */
  writeUndo(projectId: string, doc: TeamDoc | null): void {
    if (doc === null) {
      rmSync(undoFile(this.dataDir, projectId), { force: true })
      return
    }
    this.write(projectId, undoFile(this.dataDir, projectId), JSON.stringify(doc))
  }

  /** Forget everything remembered about a project's team files. */
  clear(projectId: string): void {
    try {
      rmSync(teamFilesDir(this.dataDir, projectId), { recursive: true, force: true })
    } catch {
      /* nothing to clear */
    }
  }

  private write(projectId: string, file: string, text: string): void {
    ensurePlainDir(this.dataDir, projectId, teamFilesDir(this.dataDir, projectId))
    atomicWrite(file, text)
  }
}
