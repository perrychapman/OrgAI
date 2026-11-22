/**
 * Sessions: several `orgai` processes on one CLI data folder (docs/design/cli-sessions.md).
 *
 * Every `orgai` host process is a session. It holds an exclusive kernel lock on `<dataDir>/run/sessions/<id>.lock` for
 * its whole life and writes `<id>.json` beside it, so "is that session alive" is a lock probe: never a pid, a start
 * time, a heartbeat or a file's age. The kernel drops the lock when the process ends, however it ends.
 *
 * A session also claims the projects it works in: `project-<hash>.lock`, held the same way. One session per project
 * keeps a project's own files (team, worktrees, notes, outputs, staffing profile, evolution ledger) with a single
 * writer, which is the rule every project-scoped service was written under. Chat runs have no project and need no
 * claim; a run is tied to the session that hosts it by the run index (store/runs.ts).
 *
 * What lives in the sessions folder:
 * - `<id>.lock`           the session's lock (0 bytes, never written)
 * - `<id>.json`           its record: pid, cwd, command, claimed projects (tmp + rename)
 * - `project-<hash>.lock` a project claim (0 bytes; never deleted, reused by the next claimant)
 * - `write.lock`          the data folder's write lock (store/shared/storeSync.ts)
 *
 * Registering and sweeping dead sessions happen while the caller holds the startup mutex (host/ownership.ts), so two
 * starting sessions never see half of each other. Listing only reads and probes: commands that start no host use it.
 *
 * The folder is inside `<dataDir>/run`, which agent tools may not read or write (runtime/selfControlGate.ts).
 *
 * Electron-free; relative imports only.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeSyncLock, trySyncLock, type SyncLockHandle } from '../store/shared/syncLock'
import { HOST_INSTANCE_ID_RE } from './identity'

/** What a session tells the others about itself. */
export interface SessionRecord {
  hostInstanceId: string
  pid: number
  /** The process's start time as host/processInfo.ts reports it (daemon.json takes it on a handover). */
  processStartTime?: string
  /** Epoch ms. */
  startedAt: number
  appVersion: string
  /** The process's working directory when it started. */
  cwd: string
  /** What it is, in a word or two, for people: 'tui', 'exec', 'projects set'. */
  command: string
  /** The liveness endpoint this session bound (daemon.json names it once this session is the one it advertises). */
  endpoint?: string
  /** `endpoint` is bound by a liveness-only listener (DaemonInfo.livenessProbe). */
  livenessProbe?: boolean
  /** Ids of the projects this session has claimed. */
  projects: string[]
}

export interface SessionListing {
  record: SessionRecord
  /** Its lock is held: the process is running. */
  live: boolean
}

/**
 * Something this session asked for is held by another running orgai session. The host answers `session_busy`, which
 * the CLI turns into exit 6 (busy), like every other "another orgai has it" refusal.
 */
export class SessionBusyError extends Error {
  readonly code = 'session_busy'
  constructor(message: string) {
    super(message)
    this.name = 'SessionBusyError'
  }
}

/** A project is claimed by another live session. */
export class ProjectBusyError extends SessionBusyError {
  constructor(readonly projectId: string, readonly holder: SessionRecord | undefined, what = 'This project') {
    super(`${what} is open in another orgai session${sessionWords(holder)}. Use that one, or quit it first.`)
    this.name = 'ProjectBusyError'
  }
}

/** A run is hosted by another live session: it can be read here, never changed. */
export class RunBusyError extends SessionBusyError {
  constructor(readonly runId: string, readonly holder: SessionRecord | undefined) {
    super(`Run ${runId} is live in another orgai session${sessionWords(holder)}. Use that one, or quit it first.`)
    this.name = 'RunBusyError'
  }
}

/** " (<cwd>, pid <pid>)" for a known session, else nothing. */
export function sessionWords(s: Pick<SessionRecord, 'pid' | 'cwd'> | undefined): string {
  if (!s) return ''
  return s.cwd ? ` (${s.cwd}, pid ${s.pid})` : ` (pid ${s.pid})`
}

const RECORD_RE = /^([0-9a-f]{12})\.json$/
const LOCK_RE = /^([0-9a-f]{12})\.lock$/
const TEXT_MAX = 4096
const PROJECTS_MAX = 512

export function sessionsDirOf(dataDir: string): string {
  return join(dataDir, 'run', 'sessions')
}

export function sessionLockPath(dataDir: string, id: string): string {
  return join(sessionsDirOf(dataDir), `${id}.lock`)
}

export function sessionRecordPath(dataDir: string, id: string): string {
  return join(sessionsDirOf(dataDir), `${id}.json`)
}

/** The data folder's write lock (storeSync.ts). */
export function writeLockPath(dataDir: string): string {
  return join(sessionsDirOf(dataDir), 'write.lock')
}

/**
 * The claim file of a project. The id is hashed: the name is then safe on every file system and two ids that differ
 * only in case never share one file on a case-insensitive disk.
 */
export function projectLockPath(dataDir: string, projectId: string): string {
  return join(sessionsDirOf(dataDir), `project-${createHash('sha256').update(projectId).digest('hex').slice(0, 32)}.lock`)
}

const cleanText = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= TEXT_MAX && !v.includes('\0') ? v : undefined)

/** A validated record, or null: the file is written by other processes and is read as data. */
export function parseSessionRecord(raw: unknown, id: string): SessionRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.hostInstanceId !== id || !HOST_INSTANCE_ID_RE.test(id)) return null
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return null
  if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return null
  const start = cleanText(r.processStartTime)
  const endpoint = cleanText(r.endpoint)
  const projects = Array.isArray(r.projects) ? r.projects.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= 200).slice(0, PROJECTS_MAX) : []
  return {
    hostInstanceId: id,
    pid: r.pid,
    ...(start ? { processStartTime: start } : {}),
    startedAt: r.startedAt,
    appVersion: cleanText(r.appVersion) ?? '',
    cwd: cleanText(r.cwd) ?? '',
    command: cleanText(r.command) ?? '',
    ...(endpoint ? { endpoint } : {}),
    ...(endpoint && r.livenessProbe === true ? { livenessProbe: true } : {}),
    projects
  }
}

function readRecord(dataDir: string, id: string): SessionRecord | null {
  try {
    return parseSessionRecord(JSON.parse(readFileSync(sessionRecordPath(dataDir, id), 'utf8')), id)
  } catch {
    return null
  }
}

function writeRecord(dataDir: string, record: SessionRecord): void {
  const file = sessionRecordPath(dataDir, record.hostInstanceId)
  // Its own temp name: only this session writes its record, and a crash leaves a file the next sweep removes.
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

function isLiveLock(path: string): boolean {
  try {
    return probeSyncLock(path) === 'held'
  } catch {
    // A lock file that cannot be judged (a link, not empty) is treated as held: nothing of that session is touched.
    return true
  }
}

/** Whether session `id` is running (its lock is held). False for an id that never registered here. */
export function isSessionLive(dataDir: string, id: string): boolean {
  if (!HOST_INSTANCE_ID_RE.test(id)) return false
  return isLiveLock(sessionLockPath(dataDir, id))
}

/** Every session with a record, live or not, oldest first. Reads and probes only: safe without a host. */
export function listSessions(dataDir: string): SessionListing[] {
  let names: string[]
  try {
    names = readdirSync(sessionsDirOf(dataDir))
  } catch {
    return []
  }
  const out: SessionListing[] = []
  for (const name of names) {
    const id = RECORD_RE.exec(name)?.[1]
    if (!id) continue
    const record = readRecord(dataDir, id)
    if (!record) continue
    out.push({ record, live: isLiveLock(sessionLockPath(dataDir, id)) })
  }
  return out.sort((a, b) => a.record.startedAt - b.record.startedAt || (a.record.hostInstanceId < b.record.hostInstanceId ? -1 : 1))
}

/** The running sessions. */
export function liveSessions(dataDir: string): SessionRecord[] {
  return listSessions(dataDir)
    .filter((s) => s.live)
    .map((s) => s.record)
}

/** The live session that claimed `projectId`, when its record says so. */
export function projectHolder(dataDir: string, projectId: string): SessionRecord | undefined {
  return liveSessions(dataDir).find((s) => s.projects.includes(projectId))
}

/**
 * Remove what dead sessions left: their record, their lock file and stray temp files. Call only while holding the
 * startup mutex, so a session that is registering right now (lock taken, record not yet written) is never mistaken
 * for a dead one. Returns how many sessions were removed.
 */
export function sweepDeadSessions(dataDir: string): number {
  const dir = sessionsDirOf(dataDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const remove = (name: string): void => {
    try {
      unlinkSync(join(dir, name))
    } catch {
      /* gone already, or busy: the next sweep tries again */
    }
  }
  let removed = 0
  const records = new Set<string>()
  for (const name of names) {
    const id = RECORD_RE.exec(name)?.[1]
    if (!id) continue
    if (isLiveLock(sessionLockPath(dataDir, id))) {
      records.add(id)
      continue
    }
    // The record first: the session stops being listed before its lock file goes.
    remove(name)
    remove(`${id}.lock`)
    removed += 1
  }
  for (const name of names) {
    const lockId = LOCK_RE.exec(name)?.[1]
    if (lockId && !records.has(lockId) && !isLiveLock(join(dir, name))) remove(name)
    // A record's temp file whose session is gone.
    const tmpId = /^([0-9a-f]{12})\.json\.tmp-[0-9a-f]{8}$/.exec(name)?.[1]
    if (tmpId && !isLiveLock(sessionLockPath(dataDir, tmpId))) remove(name)
  }
  return removed
}

export type ClaimResult = { ok: true } | { ok: false; holder: SessionRecord | undefined }

export interface SessionHandle {
  readonly dataDir: string
  readonly id: string
  /** This session's record as last written. */
  record(): SessionRecord
  /** Change the record (e.g. the liveness endpoint once it is bound). */
  update(patch: Partial<Pick<SessionRecord, 'endpoint' | 'command' | 'processStartTime'>>): void
  /** Claim a project for the rest of this session. Already ours is ok. Never waits. */
  claimProject(projectId: string): ClaimResult
  /** {@link claimProject}, throwing ProjectBusyError when another session holds it. */
  requireProject(projectId: string, what?: string): void
  holdsProject(projectId: string): boolean
  /** Give a claim back before the session ends (the caller knows nothing of this session uses the project any more). */
  releaseProject(projectId: string): void
  /** The other running sessions. */
  others(): SessionRecord[]
  /** End the session: release every claim and remove its own files. Synchronous and idempotent (process 'exit'). */
  release(): void
}

/**
 * Become a session: take `<id>.lock` and write the record. Call while holding the startup mutex. Throws when the id is
 * taken (a live session with the same id: a caller bug, ids are random).
 */
export function registerSession(dataDir: string, info: Omit<SessionRecord, 'projects'>): SessionHandle {
  const id = info.hostInstanceId
  if (!HOST_INSTANCE_ID_RE.test(id)) throw new Error(`Invalid host instance id: ${String(id)}`)
  mkdirSync(sessionsDirOf(dataDir), { recursive: true, mode: 0o700 })
  const lock = trySyncLock(sessionLockPath(dataDir, id))
  if (!lock) throw new Error(`The orgai session id ${id} is already in use in ${sessionsDirOf(dataDir)}.`)
  let record: SessionRecord = { ...info, projects: [] }
  const claims = new Map<string, SyncLockHandle>()
  let released = false
  try {
    writeRecord(dataDir, record)
  } catch (e) {
    lock.release()
    throw e
  }
  const save = (): void => {
    if (released) return
    record = { ...record, projects: [...claims.keys()] }
    writeRecord(dataDir, record)
  }
  const handle: SessionHandle = {
    dataDir,
    id,
    record: () => ({ ...record, projects: [...record.projects] }),
    update(patch) {
      record = { ...record, ...patch }
      save()
    },
    claimProject(projectId) {
      if (released) return { ok: false, holder: undefined }
      if (claims.has(projectId)) return { ok: true }
      const claim = trySyncLock(projectLockPath(dataDir, projectId))
      if (!claim) return { ok: false, holder: projectHolder(dataDir, projectId) }
      claims.set(projectId, claim)
      try {
        save()
      } catch (e) {
        claims.delete(projectId)
        claim.release()
        throw e
      }
      return { ok: true }
    },
    requireProject(projectId, what) {
      const r = handle.claimProject(projectId)
      if (!r.ok) throw new ProjectBusyError(projectId, r.holder, what)
    },
    holdsProject: (projectId) => claims.has(projectId),
    releaseProject(projectId) {
      const claim = claims.get(projectId)
      if (!claim) return
      claims.delete(projectId)
      claim.release()
      try {
        save()
      } catch {
        /* the record keeps naming it until the next save; the lock is what counts */
      }
    },
    others: () => liveSessions(dataDir).filter((s) => s.hostInstanceId !== id),
    release() {
      if (released) return
      released = true
      for (const claim of claims.values()) claim.release()
      claims.clear()
      // The record first (the session stops being listed), then the lock, then its file.
      for (const file of [sessionRecordPath(dataDir, id)]) {
        try {
          unlinkSync(file)
        } catch {
          /* gone already */
        }
      }
      lock.release()
      try {
        unlinkSync(sessionLockPath(dataDir, id))
      } catch {
        /* gone already, or held open on Windows: the next sweep removes it */
      }
    }
  }
  return handle
}

/**
 * A cached "is that session alive" for callers that ask often (the run index). A session seen dead stays dead (ids are
 * never reused); a live answer is asked again after `liveForMs`.
 */
export function sessionLiveness(dataDir: string, opts: { liveForMs?: number; now?: () => number } = {}): (id: string) => boolean {
  const liveForMs = opts.liveForMs ?? 500
  const now = opts.now ?? Date.now
  const dead = new Set<string>()
  const live = new Map<string, number>()
  return (id) => {
    if (dead.has(id)) return false
    const seen = live.get(id)
    const t = now()
    if (seen !== undefined && t - seen < liveForMs) return true
    if (isSessionLive(dataDir, id)) {
      live.set(id, t)
      return true
    }
    live.delete(id)
    dead.add(id)
    return false
  }
}
