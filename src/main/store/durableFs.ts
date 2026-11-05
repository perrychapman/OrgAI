/**
 * Durable file replacement for vault.json and secrets.json (docs/design/cli-standalone.md 5.5 "Durability and
 * failures"): write a temp file, fsync it, rename it over the target, then fsync the directory on POSIX. Windows has no
 * directory fsync (Node's renameSync is MoveFileEx with MOVEFILE_REPLACE_EXISTING), and POSIX file systems that refuse
 * a directory fsync (EINVAL, ENOTSUP, EOPNOTSUPP) are treated like Windows: a power loss right after such a rename may
 * lose it (accepted, documented).
 *
 * Every failure says whether the target is known to be unchanged ('unchanged': it happened before the rename) or not
 * ('unknown': at or after the rename, including a failed directory fsync). An 'unknown' outcome is never success.
 *
 * The file system is injected (VaultFs) so tests can fail every write, fsync and rename boundary. Electron-free;
 * relative imports only.
 */
import * as fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** The file operations the vault store uses (node:fs by default; tests wrap it to inject faults). */
export interface VaultFs {
  readFileSync(path: string): Buffer
  openSync(path: string, flags: string, mode?: number): number
  writeSync(fd: number, data: Buffer, offset: number, length: number): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
  mkdirSync(path: string, opts: { recursive: true }): void
  readdirSync(path: string): string[]
  existsSync(path: string): boolean
  realpathSync(path: string): string
}

export const nodeVaultFs: VaultFs = {
  readFileSync: (p) => fs.readFileSync(p),
  openSync: (p, f, m) => fs.openSync(p, f, m),
  writeSync: (fd, d, o, l) => fs.writeSync(fd, d, o, l),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (a, b) => fs.renameSync(a, b),
  unlinkSync: (p) => fs.unlinkSync(p),
  mkdirSync: (p, o) => void fs.mkdirSync(p, o),
  readdirSync: (p) => fs.readdirSync(p),
  existsSync: (p) => fs.existsSync(p),
  realpathSync: (p) => fs.realpathSync(p)
}

/** Which boundary failed (for logs and tests; never shown with a value). */
export type DurableStep = 'mkdir' | 'open' | 'write' | 'fsync' | 'close' | 'rename' | 'dir-fsync' | 'unlink'

/** A failed durable operation. `outcome` 'unchanged': the target is as before; 'unknown': it may or may not have changed. */
export class DurableFsError extends Error {
  constructor(
    readonly outcome: 'unchanged' | 'unknown',
    readonly step: DurableStep,
    readonly failure: unknown
  ) {
    super(`${step} failed (${errorCode(failure) ?? 'error'})`)
    this.name = 'DurableFsError'
  }
}

/** An errno code, if any. */
export function errorCode(e: unknown): string | undefined {
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** Directory fsync codes that mean "not supported here": treated like Windows (skipped). */
const DIR_FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'])

export interface DurableOptions {
  fs?: VaultFs
  platform?: NodeJS.Platform
}

/** fsync a directory (POSIX); skipped on win32 and where the file system refuses it. Throws on any other failure. */
export function fsyncDir(dir: string, opts: DurableOptions = {}): void {
  const f = opts.fs ?? nodeVaultFs
  if ((opts.platform ?? process.platform) === 'win32') return
  let fd: number
  try {
    fd = f.openSync(dir, 'r')
  } catch (e) {
    if (DIR_FSYNC_UNSUPPORTED.has(errorCode(e) ?? '')) return
    throw e
  }
  try {
    f.fsyncSync(fd)
  } catch (e) {
    if (!DIR_FSYNC_UNSUPPORTED.has(errorCode(e) ?? '')) throw e
  } finally {
    try {
      f.closeSync(fd)
    } catch {
      // closing a read-only directory descriptor cannot lose data
    }
  }
}

/**
 * Replace `target` with `data` durably (mode 0o600). Throws DurableFsError: 'unchanged' before the rename (the temp file
 * is removed best effort), 'unknown' from the rename on (the rename itself or the directory fsync).
 */
export function writeFileDurable(target: string, data: Buffer | string, opts: DurableOptions = {}): void {
  const f = opts.fs ?? nodeVaultFs
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  const dir = dirname(target)
  try {
    f.mkdirSync(dir, { recursive: true })
  } catch (e) {
    throw new DurableFsError('unchanged', 'mkdir', e)
  }
  const tmp = join(dir, `${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  let fd: number | undefined
  let step: DurableStep = 'open'
  try {
    fd = f.openSync(tmp, 'wx', 0o600)
    step = 'write'
    let off = 0
    while (off < bytes.length) off += f.writeSync(fd, bytes, off, bytes.length - off)
    step = 'fsync'
    f.fsyncSync(fd)
    step = 'close'
    const closing = fd
    fd = undefined
    f.closeSync(closing)
  } catch (e) {
    if (fd !== undefined) {
      try {
        f.closeSync(fd)
      } catch {
        // already failing
      }
    }
    try {
      f.unlinkSync(tmp)
    } catch {
      // best effort: a leftover temp file is never read
    }
    throw new DurableFsError('unchanged', step, e)
  }
  try {
    f.renameSync(tmp, target)
  } catch (e) {
    // A failed rename normally leaves the target alone, but the spec treats every failure from the rename on as not
    // known to be durable: the caller re-reads from disk.
    try {
      if (f.existsSync(tmp)) f.unlinkSync(tmp)
    } catch {
      // best effort
    }
    throw new DurableFsError('unknown', 'rename', e)
  }
  try {
    fsyncDir(dir, opts)
  } catch (e) {
    throw new DurableFsError('unknown', 'dir-fsync', e)
  }
}

/** Rename `from` to `to` durably (reset moves vault.json aside). 'unchanged' only when the rename itself failed with ENOENT. */
export function renameDurable(from: string, to: string, opts: DurableOptions = {}): void {
  const f = opts.fs ?? nodeVaultFs
  try {
    f.renameSync(from, to)
  } catch (e) {
    throw new DurableFsError(errorCode(e) === 'ENOENT' ? 'unchanged' : 'unknown', 'rename', e)
  }
  try {
    fsyncDir(dirname(from), opts)
  } catch (e) {
    throw new DurableFsError('unknown', 'dir-fsync', e)
  }
}

/** Unlink `target` durably (retirement deletes secrets.json). */
export function unlinkDurable(target: string, opts: DurableOptions = {}): void {
  const f = opts.fs ?? nodeVaultFs
  try {
    f.unlinkSync(target)
  } catch (e) {
    throw new DurableFsError(errorCode(e) === 'ENOENT' ? 'unchanged' : 'unknown', 'unlink', e)
  }
  try {
    fsyncDir(dirname(target), opts)
  } catch (e) {
    throw new DurableFsError('unknown', 'dir-fsync', e)
  }
}
