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
 * - macOS (review round 2): ACL entries grant access beside the mode bits and a new file inherits its folder's
 *   `file_inherit` entries, which fstat cannot see. `/bin/ls -le` (absolute path, no shell, empty environment) lists
 *   them: a key file with any `allow` entry is refused at open and probe (remedy `chmod -N`), and create refuses a
 *   folder with an inheritable allow entry before making the file, then checks the new, still empty file before writing
 *   the key (deleting it on a refusal). The ls check reads the path, not the open descriptor, so a file swapped between
 *   the fstat and the ls is not caught. Linux needs no such check: a POSIX default ACL is masked by mode 0o600.
 * - Windows: refuse a folder in which a new file would inherit access for anyone but this user, SYSTEM, Administrators
 *   or CREATOR OWNER (that principal could open the new file before it is restricted and keep the handle), then create
 *   the empty file exclusively, set a protected DACL for the current user's SID (from `whoami /user /fo csv /nh`, never
 *   from environment variables) with `icacls <file> /inheritance:r /grant:r *<SID>:F`, verify that this SID is the only
 *   principal left, then write and flush the key; any failure deletes the empty file and fails closed. Open refuses a
 *   symbolic link (lstat) and checks the same DACL; a refusal names the exact icacls command that fixes it.
 * - ACLs are read as SDDL through `icacls <path> /save <temp file>` (UTF-16LE) and compared by SID only, so neither the
 *   console code page (whoami and icacls print in the OEM code page when piped) nor a path echo matters.
 * - A path that comes from ORGAI_VAULT_KEY_FILE (not from `--key-file`) and already exists is taken as an import when a
 *   new vault is made (a provisioned CI key); nothing is ever overwritten.
 *
 * UNVERIFIED: the Windows steps were never run (the `/save` file format, its encoding and that a folder path saves the
 * folder's own ACL follow Microsoft's documentation; a format we do not recognise fails closed). The lstat-then-open
 * sequence on Windows leaves a small window in which the path could be swapped; the DACL check runs on the same path.
 */
import { closeSync, constants as fsConstants, existsSync, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { randomBytes } from 'node:crypto'
import { system32Path } from '../../host/systemBinaries'
import { CustodyError, VAULT_DEK_BYTES, vaultNames, type CustodianCreated, type CustodianProbe, type VaultCustody, type VaultProduct } from '../vaultTypes'
import type { RemovableKeyCustodian } from './common'
import { custodianEnvFor } from './env'
import { decodeKeyBase64, defaultSpawner, runHelper, stdoutText, type CustodianSpawner } from './run'

type Env = Readonly<Record<string, string | undefined>>

/** The largest file read as a key (a base64 key with CRLF is 46 bytes). */
const KEY_FILE_READ_MAX = 4096

export const keyFileNotConfigured = (product?: VaultProduct): string => `No key file is configured: set ${vaultNames(product).keyFileEnv} or run \`orgai secrets init --key-file <path>\`.`
/** A new key file was asked for where a file already exists (names the exact import command). */
export function keyFileExistsReason(path: string): string {
  return `A file already exists at ${path}; OrgAI never overwrites a key file. To use it as the vault's key, run \`orgai secrets init --key-file "${path}" --import\`.`
}
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
  /** custody.keyFile of the vault on disk, for probe() (open() gets custody itself). Implies vaultExists. */
  recordedKeyFile?: string
  /**
   * A vault already exists (its custody is key-file): probe() then reports a missing key file as 'missing' instead of
   * checking that one could be created.
   */
  vaultExists?: boolean
  /** ORGAI_VAULT_KEY_FILE is read from here. Default process.env. */
  env?: Env
  platform?: NodeJS.Platform
  /** whoami.exe / icacls.exe on Windows (tests). */
  spawner?: CustodianSpawner
  timeoutMs?: number
  /** process.getuid() stand-in (tests). */
  uid?: number
  /** Whose key-file variable is read (default 'desktop'). */
  product?: VaultProduct
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

/** `whoami /user /fo csv /nh` -> the account name and SID, or undefined. Only the SID (ASCII) is ever compared. */
export function parseWhoamiUser(text: string): { name: string; sid: string } | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*"([^"]+)","(S-1-\d+(?:-\d+){1,14})"\s*$/.exec(line)
    if (m) return { name: m[1]!, sid: m[2]!.toUpperCase() }
  }
  return undefined
}

/** The SDDL aliases of well-known SIDs icacls may print instead of the SID string. */
const SDDL_ALIASES: Readonly<Record<string, string>> = {
  SY: 'S-1-5-18',
  BA: 'S-1-5-32-544',
  BU: 'S-1-5-32-545',
  BG: 'S-1-5-32-546',
  PU: 'S-1-5-32-547',
  AU: 'S-1-5-11',
  WD: 'S-1-1-0',
  AN: 'S-1-5-7',
  IU: 'S-1-5-4',
  NU: 'S-1-5-2',
  SU: 'S-1-5-6',
  PS: 'S-1-5-10',
  CO: 'S-1-3-0',
  CG: 'S-1-3-1',
  OW: 'S-1-3-4',
  LS: 'S-1-5-19',
  NS: 'S-1-5-20',
  AC: 'S-1-15-2-1'
}

/** SYSTEM, Administrators and CREATOR OWNER (the creator, this user) may be in a key file's folder. */
const TRUSTED_FOLDER_SIDS = new Set(['S-1-5-18', 'S-1-5-32-544', 'S-1-3-0'])

export interface SddlAce {
  /** A, D, OA, OD, XA... */
  type: string
  /** Two-letter flags: OI, CI, NP, IO, ID... */
  flags: string[]
  rights: string
  /** A SID string (upper case), or `alias:<XX>` for an alias this table does not know, or `LA` (the local admin). */
  sid: string
}

export interface SddlDacl {
  /** `D:P...`: inheritance from the parent is blocked. */
  protected: boolean
  /** `D:NO_ACCESS_CONTROL`: a null DACL, everyone has full access. */
  nullDacl: boolean
  aces: SddlAce[]
}

function sddlSid(raw: string): string {
  if (/^S-1-\d+(?:-\d+)*$/i.test(raw)) return raw.toUpperCase()
  if (raw === 'LA') return 'LA'
  return SDDL_ALIASES[raw] ?? `alias:${raw}`
}

function sameSid(aceSid: string, userSid: string): boolean {
  // LA is the machine's built-in Administrator account (RID 500).
  return aceSid === userSid.toUpperCase() || (aceSid === 'LA' && /-500$/.test(userSid))
}

/**
 * One DACL in SDDL (`D:PAI(A;OICI;FA;;;SY)(A;;FA;;;S-1-5-21-...)`), optionally after `O:` / `G:` and before `S:`.
 * Undefined for anything else, conditional ACEs included (fail closed).
 */
export function parseSddlDacl(text: string): SddlDacl | undefined {
  const m = /^(?:O:[A-Za-z0-9-]+)?(?:G:[A-Za-z0-9-]+)?D:([A-Z_]*)((?:\([^()]*\))*)(?:S:.*)?$/.exec(text.trim())
  if (!m) return undefined
  const nullDacl = m[1]!.includes('NO_ACCESS_CONTROL')
  const flags = m[1]!.replace('NO_ACCESS_CONTROL', '')
  if (!/^(?:P|AI|AR)*$/.test(flags)) return undefined
  const aces: SddlAce[] = []
  for (const a of m[2]!.matchAll(/\(([^()]*)\)/g)) {
    const parts = a[1]!.split(';')
    if (parts.length !== 6) return undefined
    const [type, aceFlags, rights, , , sid] = parts as [string, string, string, string, string, string]
    if (!/^[A-Z]{1,2}$/.test(type) || !/^(?:[A-Z]{2})*$/.test(aceFlags) || !sid) return undefined
    aces.push({ type, flags: aceFlags.match(/[A-Z]{2}/g) ?? [], rights, sid: sddlSid(sid) })
  }
  return { protected: /P/.test(flags.replace(/AI|AR/g, '')), nullDacl, aces }
}

/**
 * The DACL in an `icacls <path> /save <file>` file (UTF-16LE, usually with a BOM: the object's name, then its SDDL), or
 * undefined. The name line is never compared, so no code page or path echo matters (review round 1).
 */
export function parseIcaclsSave(buf: Buffer): SddlDacl | undefined {
  let text: string
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le')
  else if (buf.length >= 2 && buf.length % 2 === 0 && buf[1] === 0) text = buf.toString('utf16le')
  else text = buf.toString('latin1')
  const dacls = text
    .split(/\r?\n/)
    .map((l) => parseSddlDacl(l))
    .filter((d): d is SddlDacl => d !== undefined)
  return dacls.length === 1 ? dacls[0] : undefined
}

const FULL_ACCESS = new Set(['FA', 'GA'])

/** True when the DACL is protected and exactly one explicit full-control allow entry for this user's SID. */
export function daclIsOwnerOnly(dacl: SddlDacl, user: { sid: string }): boolean {
  if (dacl.nullDacl || !dacl.protected || dacl.aces.length !== 1) return false
  const a = dacl.aces[0]!
  const full = FULL_ACCESS.has(a.rights) || /^0x0*1f01ff$/i.test(a.rights)
  return a.type === 'A' && !a.flags.includes('ID') && full && sameSid(a.sid, user.sid)
}

/**
 * True when a file created in the folder would inherit access for a principal other than this user, SYSTEM,
 * Administrators or CREATOR OWNER: such a principal could open the new key file in the moment before OrgAI restricts
 * it and keep the handle (review round 1). Deny entries do not count; any other entry type counts as an allow.
 */
export function folderLetsOthersIn(dacl: SddlDacl, user: { sid: string }): boolean {
  if (dacl.nullDacl) return true
  return dacl.aces.some(
    (a) => !['D', 'OD', 'XD'].includes(a.type) && a.flags.includes('OI') && !TRUSTED_FOLDER_SIDS.has(a.sid) && !sameSid(a.sid, user.sid)
  )
}

interface WinDeps {
  env: Env
  spawner: CustodianSpawner
  timeoutMs?: number
}

interface WinUser {
  name: string
  sid: string
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

async function winUser(deps: WinDeps): Promise<WinUser> {
  const user = parseWhoamiUser(await winRun(deps, 'whoami.exe', ['/user', '/fo', 'csv', '/nh']))
  if (!user) throw new CustodyError('denied', 'whoami named no user SID, so the key file cannot be restricted to this user.')
  return user
}

/** How to name the user: whoami prints in the OEM code page, so a name that did not decode is left out. */
function userLabel(user: WinUser): string {
  return /^[\x20-\x7e]+$/.test(user.name) ? `${user.name} (${user.sid})` : user.sid
}

/** SYSTEM and Administrators: a new file made by an elevated process carries them as its own entries (the token's default DACL), so they are removed as well (never the user's own SID). */
const SYSTEM_SID = 'S-1-5-18'
const ADMINS_SID = 'S-1-5-32-544'

/** The icacls arguments that leave this user as the only principal on a key file. */
export function keyFileAclArgs(path: string, sid: string): string[] {
  const drop = [SYSTEM_SID, ADMINS_SID].filter((x) => x !== sid.toUpperCase())
  return [path, '/inheritance:r', '/grant:r', `*${sid}:F`, ...(drop.length ? ['/remove:g', ...drop.map((x) => `*${x}`)] : [])]
}

/** The exact command that restricts a key file to this user (shown with every refusal of its access list). */
export function icaclsRemedy(path: string, sid: string): string {
  const [, ...rest] = keyFileAclArgs(path, sid)
  return `icacls "${path}" ${rest.map((x) => (x.startsWith('/') ? x : `"${x}"`)).join(' ')}`
}

/** `icacls <path> /save <temp file> /q`, read back as SDDL; a temp folder of its own, removed again. */
async function winDacl(deps: WinDeps, path: string): Promise<SddlDacl | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'orgai-acl-'))
  try {
    const out = join(dir, 'acl.txt')
    await winRun(deps, 'icacls.exe', [path, '/save', out, '/q'])
    let buf: Buffer
    try {
      buf = readFileSync(out)
    } catch {
      return undefined
    }
    return parseIcaclsSave(buf)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The access list as plain SIDs and rights (no names, no values): added to a refusal so it can be diagnosed. */
function describeDacl(d: SddlDacl): string {
  if (d.nullDacl) return 'no access control'
  return `${d.protected ? 'protected' : 'inherits'}: ${d.aces.map((a) => `${a.type}${a.flags.length ? `[${a.flags.join('')}]` : ''}:${a.rights}:${a.sid}`).join(' ') || 'no entries'}`
}

async function winVerifyDacl(deps: WinDeps, path: string, user: WinUser, phase: 'create' | 'open'): Promise<void> {
  const dacl = await winDacl(deps, path)
  if (!dacl) {
    throw new CustodyError('denied', `OrgAI could not read the access list of the key file ${path} (icacls answered in a form OrgAI does not recognise), so it cannot tell who may read it.`)
  }
  if (daclIsOwnerOnly(dacl, user)) return
  if (phase === 'create') throw new CustodyError('denied', `OrgAI could not restrict the new key file ${path} to ${userLabel(user)}, so it deleted it (access list was ${describeDacl(dacl)}).`)
  throw new CustodyError(
    'denied',
    `The key file ${path} is not limited to ${userLabel(user)} (other accounts or inherited entries may read it; access list ${describeDacl(dacl)}). Restrict it with \`${icaclsRemedy(path, user.sid)}\` and try again.`
  )
}

/** Refuses a folder whose new files other accounts could open before OrgAI restricts them. */
async function winCheckFolder(deps: WinDeps, dir: string, user: WinUser): Promise<void> {
  const dacl = await winDacl(deps, dir)
  if (!dacl) {
    throw new CustodyError('denied', `OrgAI could not read the access list of the folder ${dir} (icacls answered in a form OrgAI does not recognise), so it does not create a key file there.`)
  }
  if (folderLetsOthersIn(dacl, user)) {
    throw new CustodyError(
      'denied',
      `Other accounts can open new files in ${dir}, so a new key file there could be read before OrgAI restricts it. Choose a folder only you can read (for example under your user profile), or create the key file yourself, restrict it with \`${icaclsRemedy(join(dir, '<file>'), user.sid)}\` and use --import.`
    )
  }
}

/**
 * Windows create (5.3.1): refuse a folder other accounts can read new files in, then the empty file exclusively, the
 * protected DACL, verify, then write and flush; any failure after the file exists deletes it.
 */
export async function createKeyFileWindows(path: string, content: Buffer, deps: WinDeps): Promise<void> {
  if (pathExists(path)) throw createError(Object.assign(new Error('exists'), { code: 'EEXIST' }), path)
  const user = await winUser(deps)
  await winCheckFolder(deps, dirname(path), user)
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (e) {
    throw createError(e, path)
  }
  closeSync(fd)
  try {
    await winRun(deps, 'icacls.exe', keyFileAclArgs(path, user.sid))
    await winVerifyDacl(deps, path, user, 'create')
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
  await winVerifyDacl(deps, path, await winUser(deps), 'open')
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

// ---------- macOS extended ACLs ----------

/** `/bin/ls` lists a path's ACL entries with -e (fstat cannot see them). */
export const LS_PATH = '/bin/ls'

/**
 * The ACL entries `ls -le` / `ls -led` prints under a path's line (` 0: group:everyone inherited allow read`), or
 * undefined when the output is not in that shape (fail closed). Entries are the text after `<n>: `.
 */
export function parseLsAcl(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0 || !/^[-dlbcpsw][-rwxsStT]{9}[@+ ]?/.test(lines[0]!)) return undefined
  const entries: string[] = []
  for (const line of lines.slice(1)) {
    const m = /^\s*\d+: (.*)$/.exec(line)
    // A name with a line break in it shows up as an unknown line: never guess, refuse.
    if (!m) return undefined
    entries.push(m[1]!)
  }
  return entries
}

/** An entry that grants something (deny entries only take access away). */
function grants(entry: string): boolean {
  return /\ballow\b/.test(entry)
}

interface DarwinDeps {
  env: Env
  spawner: CustodianSpawner
  timeoutMs?: number
}

async function darwinAcl(deps: DarwinDeps, path: string, dir: boolean): Promise<string[]> {
  const r = await runHelper(LS_PATH, [dir ? '-led' : '-le', path], {
    spawner: deps.spawner,
    env: custodianEnvFor('key-file', deps.env, 'darwin'),
    label: 'custodian:key-file',
    platform: 'darwin',
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {})
  })
  if (r.spawnError) throw new CustodyError('unavailable', `${LS_PATH} could not be run, so the access list of ${path} cannot be checked.`)
  if (r.timedOut) throw new CustodyError('timeout', `${LS_PATH} did not answer within 10 seconds.`)
  const entries = r.overflow || r.code !== 0 ? undefined : parseLsAcl(stdoutText(r))
  if (!entries) throw new CustodyError('denied', `OrgAI could not read the access list of ${path}, so it cannot tell who may read it.`)
  return entries
}

/**
 * macOS (review round 2): a file inherits ACL entries from its folder (`chmod +a "... allow read,file_inherit"`), and
 * those grant access whatever the 0o600 mode says. A key file with any allow entry is refused.
 */
export async function darwinCheckFile(deps: DarwinDeps, path: string, phase: 'create' | 'open'): Promise<void> {
  if (!(await darwinAcl(deps, path, false)).some(grants)) return
  if (phase === 'create') {
    throw new CustodyError(
      'denied',
      `The folder ${dirname(path)} gives new files extra access (an inherited ACL; see \`ls -led "${dirname(path)}"\`), so a key file there could be read by other accounts. OrgAI deleted the empty file; choose another folder or remove that entry.`
    )
  }
  throw new CustodyError('denied', `The key file ${path} has ACL entries that may let other accounts read it; run \`chmod -N "${path}"\` and try again.`)
}

/** macOS: refuse, before creating anything, a folder whose allow entries new files would inherit. */
export async function darwinCheckFolder(deps: DarwinDeps, dir: string): Promise<void> {
  const inherited = (await darwinAcl(deps, dir, true)).filter((e) => grants(e) && /\bfile_inherit\b/.test(e))
  if (inherited.length === 0) return
  throw new CustodyError(
    'denied',
    `The folder ${dir} gives new files extra access (an inherited ACL; see \`ls -led "${dir}"\`), so a key file there could be read by other accounts. Choose another folder or remove that entry.`
  )
}

// ---------- POSIX ----------

function createError(e: unknown, path: string): CustodyError {
  const code = (e as NodeJS.ErrnoException).code
  if (code === 'EEXIST') return new CustodyError('denied', keyFileExistsReason(path))
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

/** A check that runs on the open file's path after the fstat checks (macOS: its ACL). Throws CustodyError. */
export type ExtraFileCheck = (path: string) => Promise<void>

/**
 * POSIX open (5.3.1): O_NOFOLLOW (and O_NONBLOCK, so a FIFO never blocks), then fstat checks, then `extra` (macOS
 * ACL), then the content.
 */
export async function readKeyFilePosix(path: string, uid: number | undefined, extra?: ExtraFileCheck): Promise<Buffer> {
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
  } catch (e) {
    throw openError(e, path)
  }
  try {
    const size = posixCheck(fd, path, uid)
    if (extra) await extra(path)
    return readKey(fd, size)
  } finally {
    closeSync(fd)
  }
}

/**
 * POSIX create (5.3.1): O_CREAT | O_EXCL | O_NOFOLLOW, mode 0o600, the fstat checks and `extra` (macOS ACL) on the
 * still empty file, then written and flushed; deleted again on a failure.
 */
export async function createKeyFilePosix(path: string, content: Buffer, uid: number | undefined, extra?: ExtraFileCheck): Promise<void> {
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0), 0o600)
  } catch (e) {
    throw createError(e, path)
  }
  try {
    try {
      posixCheck(fd, path, uid)
      if (extra) await extra(path)
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
    const envPath = this.env[vaultNames(this.opts.product).keyFileEnv]?.trim()
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

  private helperDeps(): WinDeps & DarwinDeps {
    return { env: this.env, spawner: this.opts.spawner ?? defaultSpawner, ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}) }
  }

  /** The usable path, or a CustodyError (`unconfigured` decides the kind when nothing is configured). */
  private checkedPath(unconfigured: 'unavailable' | 'missing', custody?: VaultCustody): string {
    const p = this.configuredPath(custody)
    if (p === undefined) throw new CustodyError(unconfigured, keyFileNotConfigured(this.opts.product))
    const problem = keyFilePathProblem(p, { userDataDir: this.opts.userDataDir, dataDir: this.opts.dataDir, platform: this.platform })
    if (problem) throw new CustodyError('denied', problem)
    return p
  }

  /** macOS only: the ACL check of a key file (fstat cannot see ACL entries). */
  private extraCheck(phase: 'create' | 'open'): ExtraFileCheck | undefined {
    if (this.platform !== 'darwin') return undefined
    const deps = this.helperDeps()
    return (path) => darwinCheckFile(deps, path, phase)
  }

  private read(path: string): Promise<Buffer> {
    return this.platform === 'win32' ? readKeyFileWindows(path, this.helperDeps()) : readKeyFilePosix(path, this.uid(), this.extraCheck('open'))
  }

  private existingVault(): boolean {
    return this.opts.vaultExists === true || this.opts.recordedKeyFile !== undefined
  }

  /**
   * The same checks as open for a file that is there; for a path that is not, 'missing' when it should already hold
   * the key (an existing vault, `--import`), else whether its folder exists so create() can make it.
   */
  async probe(): Promise<CustodianProbe> {
    try {
      const path = this.checkedPath(this.existingVault() ? 'missing' : 'unavailable')
      const askedNow = this.opts.keyFile !== undefined
      if (pathExists(path)) {
        // `secrets init --key-file` (no --import) for a new vault would refuse this file: say so now.
        if (askedNow && !this.opts.importExisting && !this.existingVault()) throw new CustodyError('denied', keyFileExistsReason(path))
        ;(await this.read(path)).fill(0)
        return { ok: true }
      }
      if (this.opts.importExisting || (this.existingVault() && !askedNow)) throw new CustodyError('missing', `The key file ${path} does not exist.`)
      const dir = pathApi(this.platform).dirname(path)
      if (!isDirectory(dir)) throw new CustodyError('unavailable', `The folder for the key file ${path} does not exist.`)
      if (this.platform === 'darwin') await darwinCheckFolder(this.helperDeps(), dir)
      return { ok: true }
    } catch (e) {
      if (e instanceof CustodyError) return { ok: false, kind: e.kind, reason: e.reason }
      return { ok: false, kind: 'unavailable', reason: 'The key file could not be checked.' }
    }
  }

  async create(vaultId: string): Promise<CustodianCreated> {
    void vaultId
    const path = this.checkedPath('unavailable')
    // custody.keyFile: the canonical spelling, computed once the file exists (its real path).
    const made = (dek: Buffer): CustodianCreated => ({ dek, keyFile: canonicalSpelling(path, this.platform) })
    if (this.opts.importExisting) return made(await this.read(path))
    // ORGAI_VAULT_KEY_FILE naming a provisioned key (CI, a moved file): use it as it is, never overwrite it. A path
    // asked for now with `--key-file` still creates a new file only.
    if (this.opts.keyFile === undefined && pathExists(path)) return made(await this.read(path))
    const dek = randomBytes(VAULT_DEK_BYTES)
    const content = Buffer.from(`${dek.toString('base64')}\n`, 'latin1')
    try {
      if (this.platform === 'win32') await createKeyFileWindows(path, content, this.helperDeps())
      else {
        if (this.platform === 'darwin' && !pathExists(path)) await darwinCheckFolder(this.helperDeps(), dirname(path))
        await createKeyFilePosix(path, content, this.uid(), this.extraCheck('create'))
      }
    } catch (e) {
      dek.fill(0)
      throw e
    } finally {
      content.fill(0)
    }
    return made(dek)
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
