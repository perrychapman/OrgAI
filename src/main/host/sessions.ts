/**
 * Sessions: several `orgai` processes on one CLI data folder (docs/design/cli-sessions.md).
 *
 * Every `orgai` host process is a session. It holds an exclusive kernel lock on `<dataDir>/run/sessions/<id>.lock` for
 * its whole life and writes `<id>.json` beside it, so "is that session alive" is a lock probe: never a pid, a start
 * time, a heartbeat or a file's age. The kernel drops the lock when the process ends, however it ends.
 *
 * A session also has the projects it works in *open*: `project-<hash>.lock`, held shared. Any number of sessions can
 * have a project open; its files are changed under the data folder's write lock on their newest content
 * (store/shared/storeSync.ts), and a run is tied to the session that hosts it by the run index (store/runs.ts). The
 * one thing a session needs a project alone for is removing or moving it: that takes the same lock exclusively, which
 * succeeds only when nobody else has the project open. Chat runs have no project.
 *
 * What lives in the sessions folder:
 * - `<id>.lock`           the session's lock (0 bytes, never written)
 * - `<id>.json`           its record: pid, cwd, command, open projects (tmp + rename)
 * - `project-<hash>.lock` a project's lock (0 bytes; never deleted): shared by every session that has it open
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
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeSyncLock, sleepSync, trySyncLock, trySyncSharedLock, type SyncLockHandle } from '../store/shared/syncLock'
import { renameSyncRetry } from './fsRetry'
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
  /** Ids of the projects this session has open (it works in them; any number of sessions can have one open). */
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

/**
 * A project cannot be used the way that was asked because of another live session: it is open there and this
 * session wanted it alone (to remove or move it), or it is being removed or moved there right now.
 */
export class ProjectBusyError extends SessionBusyError {
  constructor(readonly projectId: string, readonly holder: SessionRecord | undefined, what = 'This project', why: 'open' | 'changing' = 'open') {
    super(
      why === 'open'
        ? `${what} is open in another orgai session${sessionWords(holder)}. Quit it there first.`
        : `${what} is being removed or moved by another orgai session${sessionWords(holder)}. Try again in a moment.`
    )
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

/** A project's lock is tried this many more times, this far apart, before it counts as held alone by another session. */
const OPEN_RETRIES = 5
const OPEN_RETRY_MS = 4
/** The lock of the turn to try for a project alone, and how often it is tried (about half a second in all). */
const ALONE_TURN_LOCK = 'alone-turn.lock'
const TURN_RETRIES = 120

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

/**
 * Text from a record another process wrote (a folder name, a command word), as it may be shown in a terminal: no
 * control characters, no line or paragraph separators and no bidirectional overrides (a folder name can hold any of
 * them, and a refusal quotes it). Over-long text is dropped.
 */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const cleanText = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= TEXT_MAX ? v.replace(UNPRINTABLE, '') : undefined)
/** A path this process will bind or compare, not show: kept only when it has no NUL (never altered). */
const cleanPath = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= TEXT_MAX && !v.includes('\0') ? v : undefined)

/** A validated record, or null: the file is written by other processes and is read as data. */
export function parseSessionRecord(raw: unknown, id: string): SessionRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.hostInstanceId !== id || !HOST_INSTANCE_ID_RE.test(id)) return null
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return null
  if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return null
  const start = cleanText(r.processStartTime)
  const endpoint = cleanPath(r.endpoint)
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
  // Other sessions read this record while it is replaced; on Windows a reader or a scanner can make the rename fail
  // for a moment (fsRetry.ts), which is retried there and is a plain rename everywhere else.
  renameSyncRetry(tmp, file)
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

/**
 * Every session with a record, live or not, oldest first. Reads and probes only: safe without a host. `exceptId`: a
 * session to leave out without reading or probing it (the caller's own; it knows it runs).
 */
export function listSessions(dataDir: string, exceptId?: string): SessionListing[] {
  let names: string[]
  try {
    names = readdirSync(sessionsDirOf(dataDir))
  } catch {
    return []
  }
  const out: SessionListing[] = []
  for (const name of names) {
    const id = RECORD_RE.exec(name)?.[1]
    if (!id || id === exceptId) continue
    const record = readRecord(dataDir, id)
    if (!record) continue
    out.push({ record, live: isLiveLock(sessionLockPath(dataDir, id)) })
  }
  return out.sort((a, b) => a.record.startedAt - b.record.startedAt || (a.record.hostInstanceId < b.record.hostInstanceId ? -1 : 1))
}

/** The running sessions (without `exceptId`, see listSessions). */
export function liveSessions(dataDir: string, exceptId?: string): SessionRecord[] {
  return listSessions(dataDir, exceptId)
    .filter((s) => s.live)
    .map((s) => s.record)
}

/** The live sessions that have `projectId` open, as their records say, oldest first. */
export function projectHolders(dataDir: string, projectId: string): SessionRecord[] {
  return liveSessions(dataDir).filter((s) => s.projects.includes(projectId))
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

export type OpenResult = { ok: true } | { ok: false; holder: SessionRecord | undefined }

/** A project held alone for a moment (to remove or move it). */
export interface ExclusiveProject {
  /** Give it back. `reopen`: this session keeps the project open afterwards (it still exists). */
  release(reopen: boolean): void
}
export type ExclusiveResult = { ok: true; held: ExclusiveProject } | { ok: false; holders: SessionRecord[] }

export interface SessionHandle {
  readonly dataDir: string
  readonly id: string
  /** This session's record as last written. */
  record(): SessionRecord
  /** Change the record (e.g. the liveness endpoint once it is bound). */
  update(patch: Partial<Pick<SessionRecord, 'endpoint' | 'command' | 'processStartTime'>>): void
  /**
   * Have a project open for the rest of this session: this session works in it. Any number of sessions can; it only
   * fails (`ok: false`) while another session is removing or moving the project. Already open is ok. Never waits.
   */
  openProject(projectId: string): OpenResult
  /** {@link openProject}, throwing ProjectBusyError while another session is removing or moving the project. */
  requireProject(projectId: string, what?: string): void
  hasProjectOpen(projectId: string): boolean
  /** Stop having a project open before the session ends (the caller knows nothing of this session uses it any more). */
  closeProject(projectId: string): void
  /**
   * Hold a project alone, to remove or move it: succeeds only when no other session has it open. `ok: false` names
   * the sessions that do, and leaves this session's own hold as it was. Never waits.
   */
  exclusiveProject(projectId: string): ExclusiveResult
  /** The other running sessions that have `projectId` open. */
  othersIn(projectId: string): SessionRecord[]
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
  /** Projects this session holds alone right now (it is removing or moving them). */
  const alone = new Map<string, SyncLockHandle>()
  const save = (): void => {
    if (released) return
    record = { ...record, projects: [...claims.keys()] }
    writeRecord(dataDir, record)
  }
  const saveQuietly = (): void => {
    try {
      save()
    } catch {
      /* the record is rewritten at the next change; the locks are what count */
    }
  }
  /** A shared hold of a project's lock, tried a few times: an exclusive attempt that is about to fail keeps it out for an instant. */
  const sharedHold = (projectId: string): SyncLockHandle | null => {
    let hold = trySyncSharedLock(projectLockPath(dataDir, projectId))
    for (let i = 0; !hold && i < OPEN_RETRIES; i++) {
      sleepSync(OPEN_RETRY_MS)
      hold = trySyncSharedLock(projectLockPath(dataDir, projectId))
    }
    return hold
  }
  /** The turn to try for a project alone (one session at a time, for a few milliseconds); null when it stays taken. */
  const attemptTurn = (): SyncLockHandle | null => {
    const path = join(sessionsDirOf(dataDir), ALONE_TURN_LOCK)
    let turn = trySyncLock(path)
    for (let i = 0; !turn && i < TURN_RETRIES; i++) {
      sleepSync(OPEN_RETRY_MS)
      turn = trySyncLock(path)
    }
    return turn
  }
  const handle: SessionHandle = {
    dataDir,
    id,
    record: () => ({ ...record, projects: [...record.projects] }),
    update(patch) {
      record = { ...record, ...patch }
      save()
    },
    openProject(projectId) {
      if (released) return { ok: false, holder: undefined }
      if (claims.has(projectId)) return { ok: true }
      // This session itself is removing or moving it right now (another request of the same host).
      if (alone.has(projectId)) return { ok: false, holder: undefined }
      const hold = sharedHold(projectId)
      // Only an exclusive holder keeps a shared one out: another session is removing or moving the project.
      if (!hold) return { ok: false, holder: undefined }
      claims.set(projectId, hold)
      try {
        save()
      } catch (e) {
        claims.delete(projectId)
        hold.release()
        throw e
      }
      return { ok: true }
    },
    requireProject(projectId, what) {
      const r = handle.openProject(projectId)
      if (!r.ok) throw new ProjectBusyError(projectId, r.holder, what, 'changing')
    },
    hasProjectOpen: (projectId) => claims.has(projectId),
    closeProject(projectId) {
      const hold = claims.get(projectId)
      if (!hold) return
      claims.delete(projectId)
      hold.release()
      saveQuietly()
    },
    exclusiveProject(projectId) {
      if (released || alone.has(projectId)) return { ok: false, holders: [] }
      // One session at a time tries to take any project alone. Without that, two sessions that both have a project
      // open and both want it alone would each step aside for the other, and one would get it while the other still
      // works in it.
      const turn = attemptTurn()
      if (!turn) return { ok: false, holders: handle.othersIn(projectId) }
      try {
        const path = projectLockPath(dataDir, projectId)
        const own = claims.get(projectId)
        // This session's own shared hold would keep the exclusive one out: it steps aside for the attempt.
        own?.release()
        const exclusive = trySyncLock(path)
        if (!exclusive) {
          if (own) {
            // Nobody else can hold it alone meanwhile (they would need the turn), so this succeeds; if it does not,
            // the record must not go on saying the project is open here.
            const back = sharedHold(projectId)
            if (back) claims.set(projectId, back)
            else {
              claims.delete(projectId)
              saveQuietly()
            }
          }
          return { ok: false, holders: handle.othersIn(projectId) }
        }
        claims.delete(projectId)
        alone.set(projectId, exclusive)
        saveQuietly()
        let done = false
        return {
          ok: true,
          held: {
            release(reopen) {
              if (done) return
              done = true
              alone.delete(projectId)
              exclusive.release()
              if (reopen && !released) {
                // Still this session's project (it was moved, not removed): open again, and say so in the record.
                if (!handle.openProject(projectId).ok) saveQuietly()
              }
            }
          }
        }
      } finally {
        turn.release()
      }
    },
    othersIn: (projectId) => liveSessions(dataDir, id).filter((s) => s.projects.includes(projectId)),
    others: () => liveSessions(dataDir, id),
    release() {
      if (released) return
      released = true
      for (const claim of claims.values()) claim.release()
      claims.clear()
      for (const held of alone.values()) held.release()
      alone.clear()
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
