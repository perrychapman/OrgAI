/**
 * Key-file custodian (cli-standalone.md 5.3.1, scheme 'key-file', opt-in): the data key is a file the user chose,
 * through `orgai secrets init --key-file <path>` (created new, never overwritten) or `--import` (an existing file), or
 * ORGAI_VAULT_KEY_FILE (which overrides the recorded `custody.keyFile`: a moved file, CI).
 *
 * - The path must be absolute and is refused anywhere inside the user data folder (`<userData>`, which contains
 *   `<data>`) and inside `<data>`, on its lexical and canonical spellings (case-folded on Windows and macOS), at
 *   create, open and every probe: a backup or sync of that folder would otherwise hold both the vault and its key.
 * - Content: exactly 32 bytes, or base64 text of 32 bytes with at most one trailing `\n` or `\r\n`
 *   (`openssl rand -base64 32 > file` works). A file OrgAI creates holds base64 text and a newline.
 * - POSIX: created with O_CREAT | O_EXCL | O_NOFOLLOW, mode 0o600; opened with O_NOFOLLOW | O_NONBLOCK (a FIFO never
 *   blocks) then fstat: a regular file owned by the current uid with no group or other bits.
 * - Windows: create the empty file exclusively, set a protected DACL for the current user's SID (from
 *   `whoami /user /fo csv /nh`, never from environment variables) with `icacls <file> /inheritance:r /grant:r *<SID>:F`,
 *   verify with `icacls <file>` that this user is the only principal left, then write and flush the key; any failure
 *   deletes the empty file and fails closed. Open refuses a symbolic link (lstat) and checks the same DACL.
 *
 * UNVERIFIED: the Windows steps were never run (parsing follows Microsoft's documented English output; other locales'
 * account names are compared as printed, and a format we do not recognise fails closed). The lstat-then-open sequence
 * on Windows leaves a small window in which the path could be swapped; the DACL check runs on the same path.
 */
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeSync, existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { randomBytes } from 'node:crypto'
import { system32Path } from '../../host/systemBinaries'
import { CustodyError, VAULT_DEK_BYTES, VAULT_KEY_FILE_ENV, type CustodianCreated, type CustodianProbe, type VaultCustody } from '../vaultTypes'
import type { RemovableKeyCustodian } from './common'
import { custodianEnvFor } from './env'
import { decodeKeyBase64, defaultSpawner, runHelper, stdoutText, type CustodianSpawner } from './run'

type Env = Readonly<Record<string, string | undefined>>

/** The largest file read as a key (a base64 key with CRLF is 46 bytes). */
const KEY_FILE_READ_MAX = 4096

export const KEY_FILE_NOT_CONFIGURED = `No key file is configured: set ${VAULT_KEY_FILE_ENV} or run \`orgai secrets init --key-file <path>\`.`
export const KEY_FILE_BAD_CONTENT = 'The key file must hold exactly 32 bytes, or base64 text of 32 bytes (for example from `openssl rand -base64 32`).'

export interface KeyFileCustodianOptions {
  /** `<userData>/data`: a key file inside it is refused. */
  dataDir: string
  /** `<userData>`: a key file inside it is refused. */
  userDataDir: string
  /** The path asked for now (`secrets init --key-file`); wins over ORGAI_VAULT_KEY_FILE and custody.keyFile. */
  keyFile?: string
  /** `--import`: create() takes the existing file instead of creating one. */
  importExisting?: boolean
  /** custody.keyFile of the vault on disk, for probe() (open() gets custody itself). */
  recordedKeyFile?: string
  /** ORGAI_VAULT_KEY_FILE is read from here. Default process.env. */
  env?: Env
  platform?: NodeJS.Platform
  /** whoami.exe / icacls.exe on Windows (tests). */
  spawner?: CustodianSpawner
  timeoutMs?: number
  /** process.getuid() stand-in (tests). */
  uid?: number
}

// ---------- Paths ----------

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

function folds(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/** realpath of the nearest existing ancestor with the rest re-appended; the resolved input when none resolves. */
function canonicalSpelling(p: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform)
  let probe = api.resolve(p)
  const rest: string[] = []
  for (let i = 0; i < 256; i++) {
    try {
      const real = realpathSync.native(probe)
      return rest.length ? api.join(real, ...rest) : real
    } catch {
      const parent = api.dirname(probe)
      if (parent === probe) break
      rest.unshift(api.basename(probe))
      probe = parent
    }
  }
  return api.resolve(p)
}

function key(p: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform)
  const r = api.resolve(p)
  const root = api.parse(r).root
  const k = r.length > root.length ? r.replace(/[\\/]+$/, '') : root
  return folds(platform) ? k.toLowerCase() : k
}

function inside(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform)
  const rel = api.relative(key(parent, platform), key(child, platform))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel))
}

/** True when `child` is `parent` or inside it on any lexical / canonical spelling of either. */
export function insideOnAnySpelling(parent: string, child: string, platform: NodeJS.Platform = process.platform): boolean {
  const api = pathApi(platform)
  const parents = [api.resolve(parent), canonicalSpelling(parent, platform)]
  const children = [api.resolve(child), canonicalSpelling(child, platform)]
  return parents.some((pa) => children.some((c) => inside(pa, c, platform)))
}

/**
 * Why `path` cannot be a key file, else undefined (5.3.1): not absolute, a network path on Windows, control
 * characters, or inside the user data folder or the data folder.
 */
export function keyFilePathProblem(path: string, opts: { userDataDir: string; dataDir: string; platform?: NodeJS.Platform }): string | undefined {
  const platform = opts.platform ?? process.platform
  // eslint-disable-next-line no-control-regex
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return 'The key file path is empty or holds control characters.'
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(path)) return 'The key file must be on a local drive, not a network path.'
    if (!/^[A-Za-z]:[\\/]/.test(path)) return 'The key file path must be absolute (for example C:\\Users\\you\\orgai.key).'
  } else if (!posix.isAbsolute(path)) {
    return 'The key file path must be absolute.'
  }
  for (const folder of [opts.userDataDir, opts.dataDir]) {
    if (folder && insideOnAnySpelling(folder, path, platform)) {
      return `The key file must not be inside OrgAI's data folder (${folder}): a backup or sync of that folder would then hold both the vault and its key.`
    }
  }
  return undefined
}

/** Reads a key out of a key file's bytes (5.3.1), or undefined. */
export function parseKeyFileContent(buf: Buffer): Buffer | undefined {
  if (buf.length === VAULT_DEK_BYTES) return Buffer.from(buf)
  if (buf.length > 64) return undefined
  let s = buf.toString('latin1')
  if (s.endsWith('\r\n')) s = s.slice(0, -2)
  else if (s.endsWith('\n')) s = s.slice(0, -1)
  return decodeKeyBase64(s)
}

// ---------- Windows DACL ----------

/** `whoami /user /fo csv /nh` -> the account name and SID, or undefined. */
export function parseWhoamiUser(text: string): { name: string; sid: string } | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*"([^"]+)","(S-1-\d+(?:-\d+){1,14})"\s*$/.exec(line)
    if (m) return { name: m[1]!, sid: m[2]! }
  }
  return undefined
}

/**
 * The ACEs `icacls <path>` prints for `path`: the first line starts with the path, continuation lines are indented,
 * and a blank line ends the list. Each entry is the principal and its permission text. Undefined when the output does
 * not have that shape (fail closed).
 */
export function parseIcaclsAces(output: string, path: string): Array<{ principal: string; perms: string }> | undefined {
  const lines = output.split(/\r?\n/)
  const first = lines.findIndex((l) => l.trim() !== '')
  if (first < 0) return undefined
  const head = lines[first]!
  if (!head.toLowerCase().startsWith(path.toLowerCase())) return undefined
  const raw = [head.slice(path.length)]
  for (let i = first + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim() === '') break
    if (!/^\s/.test(l)) break
    raw.push(l)
  }
  const out: Array<{ principal: string; perms: string }> = []
  for (const r of raw) {
    const t = r.trim()
    if (!t) continue
    const at = t.lastIndexOf(':(')
    if (at <= 0) return undefined
    out.push({ principal: t.slice(0, at), perms: t.slice(at + 1) })
  }
  return out.length ? out : undefined
}

/** True when the ACL is exactly one explicit full-control entry for this user (by name or SID). */
export function daclIsOwnerOnly(aces: Array<{ principal: string; perms: string }>, user: { name: string; sid: string }): boolean {
  if (aces.length !== 1) return false
  const { principal, perms } = aces[0]!
  const p = principal.replace(/^\*/, '').toLowerCase()
  const mine = p === user.name.toLowerCase() || p === user.sid.toLowerCase()
  return mine && !/\(I\)/i.test(perms) && /\(F\)/i.test(perms)
}

interface WinDeps {
  env: Env
  spawner: CustodianSpawner
  timeoutMs?: number
}

async function winRun(deps: WinDeps, exe: string, args: string[]): Promise<string> {
  const r = await runHelper(system32Path(exe, deps.env), args, {
    spawner: deps.spawner,
    env: custodianEnvFor('key-file', deps.env, 'win32'),
    label: 'custodian:key-file',
    platform: 'win32',
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {})
  })
  if (r.spawnError) throw new CustodyError('unavailable', `${exe} could not be run, so the key file's access list cannot be set or checked.`)
  if (r.timedOut) throw new CustodyError('timeout', `${exe} did not answer within 10 seconds.`)
  if (r.overflow || r.code !== 0) throw new CustodyError('denied', `${exe} failed (exit ${r.code ?? 'signal'}), so the key file's access list cannot be set or checked.`)
  return stdoutText(r)
}

async function winUser(deps: WinDeps): Promise<{ name: string; sid: string }> {
  const user = parseWhoamiUser(await winRun(deps, 'whoami.exe', ['/user', '/fo', 'csv', '/nh']))
  if (!user) throw new CustodyError('denied', 'whoami named no user SID, so the key file cannot be restricted to this user.')
  return user
}

async function winVerifyDacl(deps: WinDeps, path: string, user: { name: string; sid: string }): Promise<void> {
  const aces = parseIcaclsAces(await winRun(deps, 'icacls.exe', [path]), path)
  if (!aces || !daclIsOwnerOnly(aces, user)) {
    throw new CustodyError('denied', `The key file ${path} can be read by other accounts; it must allow only ${user.name}.`)
  }
}

/** Windows create (5.3.1): empty exclusive file, protected DACL, verify, then write and flush; any failure deletes it. */
export async function createKeyFileWindows(path: string, content: Buffer, deps: WinDeps): Promise<void> {
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (e) {
    throw createError(e, path)
  }
  closeSync(fd)
  try {
    const user = await winUser(deps)
    await winRun(deps, 'icacls.exe', [path, '/inheritance:r', '/grant:r', `*${user.sid}:F`])
    await winVerifyDacl(deps, path, user)
    const w = openSync(path, 'r+')
    try {
      writeSync(w, content)
      fsyncSync(w)
    } finally {
      closeSync(w)
    }
  } catch (e) {
    try {
      unlinkSync(path)
    } catch {
      // Already gone; the failure below is what counts.
    }
    if (e instanceof CustodyError) throw e
    throw new CustodyError('unavailable', `The key file could not be written: ${(e as NodeJS.ErrnoException).code ?? 'error'}.`)
  }
}

/** Windows open: no link, a regular file, the same DACL, then the content. */
export async function readKeyFileWindows(path: string, deps: WinDeps): Promise<Buffer> {
  let st
  try {
    st = lstatSync(path)
  } catch (e) {
    throw openError(e, path)
  }
  if (st.isSymbolicLink()) throw new CustodyError('denied', `The key file ${path} is a link; OrgAI reads only a regular file.`)
  if (!st.isFile()) throw new CustodyError('denied', `The key file ${path} is not a regular file.`)
  await winVerifyDacl(deps, path, await winUser(deps))
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (e) {
    throw openError(e, path)
  }
  try {
    const fst = fstatSync(fd)
    if (!fst.isFile()) throw new CustodyError('denied', `The key file ${path} is not a regular file.`)
    return readKey(fd, fst.size)
  } finally {
    closeSync(fd)
  }
}

// ---------- POSIX ----------

function createError(e: unknown, path: string): CustodyError {
  const code = (e as NodeJS.ErrnoException).code
  if (code === 'EEXIST') return new CustodyError('denied', `A file already exists at ${path}; OrgAI never overwrites a key file. Use --import to use it.`)
  if (code === 'ENOENT' || code === 'ENOTDIR') return new CustodyError('unavailable', `The folder for the key file ${path} does not exist.`)
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new CustodyError('denied', `OrgAI may not create the key file ${path} (${code}).`)
  return new CustodyError('unavailable', `The key file ${path} could not be created (${code ?? 'error'}).`)
}

function openError(e: unknown, path: string): CustodyError {
  const code = (e as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') return new CustodyError('missing', `The key file ${path} does not exist.`)
  if (code === 'ELOOP' || code === 'EMLINK') return new CustodyError('denied', `The key file ${path} is a symbolic link; OrgAI reads only a regular file.`)
  if (code === 'EACCES' || code === 'EPERM') return new CustodyError('denied', `OrgAI may not read the key file ${path}.`)
  return new CustodyError('unavailable', `The key file ${path} could not be read (${code ?? 'error'}).`)
}

function readKey(fd: number, size: number): Buffer {
  if (size > KEY_FILE_READ_MAX) throw new CustodyError('denied', KEY_FILE_BAD_CONTENT)
  const buf = Buffer.alloc(KEY_FILE_READ_MAX + 1)
  let n = 0
  for (;;) {
    const got = readSync(fd, buf, n, buf.length - n, null)
    if (got <= 0) break
    n += got
    if (n > KEY_FILE_READ_MAX) break
  }
  const content = buf.subarray(0, n)
  const parsed = n > KEY_FILE_READ_MAX ? undefined : parseKeyFileContent(content)
  buf.fill(0)
  if (!parsed) throw new CustodyError('denied', KEY_FILE_BAD_CONTENT)
  return parsed
}

function posixCheck(fd: number, path: string, uid: number | undefined): number {
  const st = fstatSync(fd)
  if (!st.isFile()) throw new CustodyError('denied', `The key file ${path} is not a regular file.`)
  if (uid !== undefined && st.uid !== uid) throw new CustodyError('denied', `The key file ${path} belongs to another user.`)
  if ((st.mode & 0o077) !== 0) {
    throw new CustodyError('denied', `The key file ${path} can be read by other users; run \`chmod 600 ${path}\`.`)
  }
  return st.size
}

/** POSIX open (5.3.1): O_NOFOLLOW (and O_NONBLOCK, so a FIFO never blocks), then fstat checks, then the content. */
export function readKeyFilePosix(path: string, uid: number | undefined): Buffer {
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
  } catch (e) {
    throw openError(e, path)
  }
  try {
    return readKey(fd, posixCheck(fd, path, uid))
  } finally {
    closeSync(fd)
  }
}

/** POSIX create (5.3.1): O_CREAT | O_EXCL | O_NOFOLLOW, mode 0o600, written and flushed; deleted again on a failure. */
export function createKeyFilePosix(path: string, content: Buffer, uid: number | undefined): void {
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
  } catch (e) {
    throw createError(e, path)
  }
  try {
    try {
      posixCheck(fd, path, uid)
      writeSync(fd, content)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (e) {
    try {
      unlinkSync(path)
    } catch {
      // Already gone.
    }
    if (e instanceof CustodyError) throw e
    throw new CustodyError('unavailable', `The key file ${path} could not be written (${(e as NodeJS.ErrnoException).code ?? 'error'}).`)
  }
  // Best effort: make the new directory entry durable too.
  try {
    const dir = openSync(posix.dirname(path), fsConstants.O_RDONLY)
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } catch {
    // Some file systems refuse fsync on a directory.
  }
}

// ---------- The custodian ----------

export class KeyFileCustodian implements RemovableKeyCustodian {
  readonly scheme = 'key-file' as const
  private readonly opts: KeyFileCustodianOptions
  private readonly platform: NodeJS.Platform
  private readonly env: Env

  constructor(opts: KeyFileCustodianOptions) {
    this.opts = opts
    this.platform = opts.platform ?? process.platform
    this.env = opts.env ?? process.env
  }

  /** The path to use: the one asked for now, else ORGAI_VAULT_KEY_FILE, else the recorded custody.keyFile. */
  configuredPath(custody?: VaultCustody): string | undefined {
    const envPath = this.env[VAULT_KEY_FILE_ENV]?.trim()
    const p = this.opts.keyFile ?? (envPath ? envPath : undefined) ?? custody?.keyFile ?? this.opts.recordedKeyFile
    return typeof p === 'string' && p !== '' ? p : undefined
  }

  /** The canonical spelling of the path in use, for `custody.keyFile` (recorded at init). */
  canonicalPath(custody?: VaultCustody): string | undefined {
    const p = this.configuredPath(custody)
    return p === undefined ? undefined : canonicalSpelling(p, this.platform)
  }

  private uid(): number | undefined {
    return this.opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
  }

  private winDeps(): WinDeps {
    return { env: this.env, spawner: this.opts.spawner ?? defaultSpawner, ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}) }
  }

  /** The usable path, or a CustodyError (`unconfigured` decides the kind when nothing is configured). */
  private checkedPath(unconfigured: 'unavailable' | 'missing', custody?: VaultCustody): string {
    const p = this.configuredPath(custody)
    if (p === undefined) throw new CustodyError(unconfigured, KEY_FILE_NOT_CONFIGURED)
    const problem = keyFilePathProblem(p, { userDataDir: this.opts.userDataDir, dataDir: this.opts.dataDir, platform: this.platform })
    if (problem) throw new CustodyError('denied', problem)
    return p
  }

  private read(path: string): Promise<Buffer> {
    return this.platform === 'win32' ? readKeyFileWindows(path, this.winDeps()) : Promise.resolve().then(() => readKeyFilePosix(path, this.uid()))
  }

  async probe(): Promise<CustodianProbe> {
    try {
      const path = this.checkedPath('unavailable')
      if (pathExists(path)) {
        ;(await this.read(path)).fill(0)
        return { ok: true }
      }
      if (this.opts.importExisting) throw new CustodyError('missing', `The key file ${path} does not exist.`)
      const dir = pathApi(this.platform).dirname(path)
      if (!isDirectory(dir)) throw new CustodyError('unavailable', `The folder for the key file ${path} does not exist.`)
      return { ok: true }
    } catch (e) {
      if (e instanceof CustodyError) return { ok: false, kind: e.kind, reason: e.reason }
      return { ok: false, kind: 'unavailable', reason: 'The key file could not be checked.' }
    }
  }

  async create(vaultId: string): Promise<CustodianCreated> {
    void vaultId
    const path = this.checkedPath('unavailable')
    if (this.opts.importExisting) return { dek: await this.read(path) }
    const dek = randomBytes(VAULT_DEK_BYTES)
    const content = Buffer.from(`${dek.toString('base64')}\n`, 'latin1')
    try {
      if (this.platform === 'win32') await createKeyFileWindows(path, content, this.winDeps())
      else createKeyFilePosix(path, content, this.uid())
    } catch (e) {
      dek.fill(0)
      throw e
    } finally {
      content.fill(0)
    }
    return { dek }
  }

  async open(vaultId: string, custody: VaultCustody): Promise<Buffer> {
    void vaultId
    return this.read(this.checkedPath('missing', custody))
  }

  /** Deletes the key file (the probe script's cleanup; the store never deletes a key file). */
  async removeItem(vaultId: string, custody: VaultCustody): Promise<void> {
    void vaultId
    const path = this.checkedPath('missing', custody)
    try {
      unlinkSync(path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new CustodyError('denied', `The key file ${path} could not be deleted.`)
    }
  }
}

function pathExists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return existsSync(p)
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
