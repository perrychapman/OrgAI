/**
 * The one atomic-write helper for shared files (docs/design/parallel-sessions.md 4.4, 4.9): a temp file with a name
 * unique to this host and call (`<file>.tmp-<hostId>-<random>`, created `wx` so it never reuses another writer's temp
 * file), fsync, rename over the target, fsync the directory where the platform allows it.
 *
 * Durability scope (4.9): exact for process crashes everywhere. Directory fsync is skipped on Windows and on file
 * systems that refuse it; the result says so (`dirSynced: false`), so callers and `doctor` can state the narrower
 * power-loss guarantee instead of assuming it.
 *
 * Electron-free; relative imports only.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Set once per process by the host (control/hosts registration); tests may set it. */
let hostTag = 'nohost'

export function setAtomicWriteHostTag(tag: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tag)) throw new Error(`Invalid host tag ${JSON.stringify(tag)}`)
  hostTag = tag
}

export function tempPathFor(file: string): string {
  return join(dirname(file), `${basename(file)}.tmp-${hostTag}-${randomBytes(6).toString('hex')}`)
}

/** Matches temp files written by this helper; group 1 is the host tag. */
export const TEMP_NAME_RE = /\.tmp-([A-Za-z0-9_-]{1,64})-[0-9a-f]{12}$/

const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'EPERM', 'EBADF'])
/** A directory that does not exist (any more) has nothing to sync. */
const DIR_GONE = new Set(['ENOENT', 'ENOTDIR'])

/** fsync a directory; false when the platform or file system does not support it. */
export function fsyncDirectory(dir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return false
  let fd: number
  try {
    fd = openSync(dir, 'r')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? ''
    if (DIR_SYNC_UNSUPPORTED.has(code) || DIR_GONE.has(code)) return false
    throw e
  }
  try {
    fsyncSync(fd)
    return true
  } catch (e) {
    if (DIR_SYNC_UNSUPPORTED.has((e as NodeJS.ErrnoException).code ?? '')) return false
    throw e
  } finally {
    closeSync(fd)
  }
}

export interface AtomicWriteResult {
  /** Whether the directory entry was fsynced (false: power-loss ordering not guaranteed here). */
  dirSynced: boolean
}

/** Write `data` to `file` atomically and durably (as far as the platform allows). */
export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): AtomicWriteResult {
  const tmp = tempPathFor(file)
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  const fd = openSync(tmp, 'wx', mode)
  try {
    let off = 0
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off)
    fsyncSync(fd)
  } catch (e) {
    closeSync(fd)
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw e
  }
  closeSync(fd)
  try {
    renameSync(tmp, file)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* best effort */
    }
    throw e
  }
  return { dirSynced: fsyncDirectory(dirname(file)) }
}

/** Unlink a file and fsync its directory; missing is fine. */
export function unlinkDurable(file: string): AtomicWriteResult {
  try {
    unlinkSync(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  return { dirSynced: fsyncDirectory(dirname(file)) }
}
