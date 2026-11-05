import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CustodyError } from '../vaultTypes'
import { fakeSpawner, type FakeAnswer } from './fakeSpawner'
import {
  KeyFileCustodian,
  createKeyFileWindows,
  daclIsOwnerOnly,
  folderLetsOthersIn,
  icaclsRemedy,
  keyFilePathProblem,
  parseIcaclsSave,
  parseKeyFileContent,
  parseSddlDacl,
  parseWhoamiUser,
  readKeyFileWindows
} from './keyFile'

const posixOnly = process.platform === 'win32' ? it.skip : it
const ID = '0123456789abcdef0123456789abcdef'

let root: string
let userDataDir: string
let dataDir: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-keyfile-'))
  userDataDir = join(root, 'userData')
  dataDir = join(userDataDir, 'data')
  outside = join(root, 'outside')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(outside)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const custodian = (extra: Partial<ConstructorParameters<typeof KeyFileCustodian>[0]> = {}): KeyFileCustodian =>
  new KeyFileCustodian({ dataDir, userDataDir, env: {}, ...extra })

const failure = async (p: Promise<unknown>): Promise<CustodyError> =>
  p.then(
    () => {
      throw new Error('resolved')
    },
    (e: CustodyError) => {
      expect(e).toBeInstanceOf(CustodyError)
      return e
    }
  )

describe('parseKeyFileContent (5.3.1 content)', () => {
  const key = Buffer.alloc(32, 0xab)
  const b64 = key.toString('base64')
  it('accepts 32 raw bytes and base64 with at most one trailing newline', () => {
    expect(parseKeyFileContent(key)?.equals(key)).toBe(true)
    expect(parseKeyFileContent(Buffer.from(b64))?.equals(key)).toBe(true)
    expect(parseKeyFileContent(Buffer.from(`${b64}\n`))?.equals(key)).toBe(true)
    expect(parseKeyFileContent(Buffer.from(`${b64}\r\n`))?.equals(key)).toBe(true)
  })
  it('refuses anything else', () => {
    expect(parseKeyFileContent(Buffer.from(`${b64}\n\n`))).toBeUndefined()
    expect(parseKeyFileContent(Buffer.from(` ${b64}`))).toBeUndefined()
    expect(parseKeyFileContent(Buffer.alloc(31))).toBeUndefined()
    expect(parseKeyFileContent(Buffer.alloc(33))).toBeUndefined()
    expect(parseKeyFileContent(Buffer.from(Buffer.alloc(16).toString('base64')))).toBeUndefined()
    expect(parseKeyFileContent(Buffer.from(Buffer.alloc(32).toString('base64url')))).toBeUndefined()
  })
})

describe('keyFilePathProblem (5.3.1 location)', () => {
  it('refuses relative paths and paths inside the user data folder or the data folder', () => {
    expect(keyFilePathProblem('orgai.key', { userDataDir, dataDir, platform: 'linux' })).toMatch(/absolute/)
    expect(keyFilePathProblem(join(userDataDir, 'orgai.key'), { userDataDir, dataDir, platform: 'linux' })).toMatch(/data folder/)
    expect(keyFilePathProblem(join(dataDir, 'x', 'orgai.key'), { userDataDir, dataDir, platform: 'linux' })).toMatch(/data folder/)
    expect(keyFilePathProblem(userDataDir, { userDataDir, dataDir, platform: 'linux' })).toMatch(/data folder/)
    expect(keyFilePathProblem(join(outside, 'orgai.key'), { userDataDir, dataDir, platform: 'linux' })).toBeUndefined()
    expect(keyFilePathProblem(join(outside, 'a\nb'), { userDataDir, dataDir, platform: 'linux' })).toMatch(/control/)
  })

  posixOnly('refuses a path that reaches the data folder through a link (canonical spelling)', () => {
    const link = join(outside, 'link-to-userdata')
    symlinkSync(userDataDir, link)
    expect(keyFilePathProblem(join(link, 'orgai.key'), { userDataDir, dataDir, platform: process.platform })).toMatch(/data folder/)
    // And the other way round: the data folder named through a link, the key file by its real path.
    const ud2 = join(outside, 'ud-link')
    symlinkSync(userDataDir, ud2)
    expect(keyFilePathProblem(join(realpathSync(userDataDir), 'k'), { userDataDir: ud2, dataDir: join(ud2, 'data'), platform: process.platform })).toMatch(/data folder/)
  })

  it('folds case on macOS and Windows', () => {
    expect(keyFilePathProblem(join(userDataDir.toUpperCase(), 'k'), { userDataDir, dataDir, platform: 'darwin' })).toMatch(/data folder/)
    expect(
      keyFilePathProblem('C:\\USERS\\ME\\APPDATA\\Roaming\\OrgAI\\orgai.key', { userDataDir: 'C:\\Users\\me\\AppData\\Roaming\\OrgAI', dataDir: 'C:\\Users\\me\\AppData\\Roaming\\OrgAI\\data', platform: 'win32' })
    ).toMatch(/data folder/)
  })

  it('refuses UNC and relative paths on Windows', () => {
    const o = { userDataDir: 'C:\\u', dataDir: 'C:\\u\\data', platform: 'win32' as const }
    expect(keyFilePathProblem('\\\\server\\share\\orgai.key', o)).toMatch(/network/)
    expect(keyFilePathProblem('orgai.key', o)).toMatch(/absolute/)
    expect(keyFilePathProblem('\\orgai.key', o)).toMatch(/absolute/)
    expect(keyFilePathProblem('D:\\keys\\orgai.key', o)).toBeUndefined()
  })
})

describe('KeyFileCustodian on POSIX (5.3.1)', () => {
  posixOnly('creates a new 0600 file with base64 text and opens it again', async () => {
    const path = join(outside, 'orgai.key')
    const c = custodian({ keyFile: path })
    const { dek, wrapped } = await c.create(ID)
    expect(wrapped).toBeUndefined()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'latin1')).toBe(`${dek.toString('base64')}\n`)
    expect(c.canonicalPath()).toBe(realpathSync(path))
    const again = await custodian().open(ID, { scheme: 'key-file', keyFile: realpathSync(path) })
    expect(again.equals(dek)).toBe(true)
  })

  posixOnly('never overwrites: create refuses an existing file or a link at the path', async () => {
    const path = join(outside, 'orgai.key')
    writeFileSync(path, 'old', { mode: 0o600 })
    expect((await failure(custodian({ keyFile: path }).create(ID))).kind).toBe('denied')
    expect(readFileSync(path, 'utf8')).toBe('old')
    const target = join(outside, 'target')
    const link = join(outside, 'dangling.key')
    symlinkSync(target, link)
    expect((await failure(custodian({ keyFile: link }).create(ID))).kind).toBe('denied')
    expect(existsSync(target)).toBe(false)
  })

  posixOnly('imports an existing file (openssl rand -base64 32 style) without changing it', async () => {
    const path = join(outside, 'ci.key')
    const key = Buffer.alloc(32, 0x42)
    writeFileSync(path, `${key.toString('base64')}\n`, { mode: 0o600 })
    const { dek } = await custodian({ keyFile: path, importExisting: true }).create(ID)
    expect(dek.equals(key)).toBe(true)
    expect(readFileSync(path, 'latin1')).toBe(`${key.toString('base64')}\n`)
    expect((await failure(custodian({ keyFile: join(outside, 'none.key'), importExisting: true }).create(ID))).kind).toBe('missing')
  })

  posixOnly('refuses group or other bits, another owner, links, non-regular files and bad content on open', async () => {
    const key = Buffer.alloc(32, 1)
    const path = join(outside, 'k')
    writeFileSync(path, key, { mode: 0o600 })
    const open = (p: string, extra = {}) => custodian(extra).open(ID, { scheme: 'key-file', keyFile: p })
    expect((await open(path)).equals(key)).toBe(true)

    chmodSync(path, 0o640)
    expect((await failure(open(path))).reason).toMatch(/chmod 600/)
    chmodSync(path, 0o600)

    expect((await failure(open(path, { uid: (process.getuid?.() ?? 0) + 1 }))).reason).toMatch(/another user/)

    const link = join(outside, 'k-link')
    symlinkSync(path, link)
    expect((await failure(open(link))).kind).toBe('denied')

    const dir = join(outside, 'adir')
    mkdirSync(dir, { mode: 0o700 })
    expect((await failure(open(dir))).kind).toBe('denied')

    const fifo = join(outside, 'fifo')
    execFileSync('/usr/bin/mkfifo', ['-m', '600', fifo])
    expect((await failure(open(fifo))).reason).toMatch(/not a regular file/)

    const bad = join(outside, 'bad')
    writeFileSync(bad, 'not a key\n', { mode: 0o600 })
    expect((await failure(open(bad))).kind).toBe('denied')

    expect((await failure(open(join(outside, 'gone')))).kind).toBe('missing')
  })

  posixOnly('lets ORGAI_VAULT_KEY_FILE override the recorded path, and refuses it inside the data folder', async () => {
    const recorded = join(outside, 'old.key')
    const moved = join(outside, 'moved.key')
    const key = Buffer.alloc(32, 7)
    writeFileSync(moved, key, { mode: 0o600 })
    const c = custodian({ env: { ORGAI_VAULT_KEY_FILE: moved } })
    expect((await c.open(ID, { scheme: 'key-file', keyFile: recorded })).equals(key)).toBe(true)

    const inData = join(dataDir, 'orgai.key')
    writeFileSync(inData, key, { mode: 0o600 })
    const e = await failure(custodian({ env: { ORGAI_VAULT_KEY_FILE: inData } }).open(ID, { scheme: 'key-file', keyFile: moved }))
    expect(e.kind).toBe('denied')
    expect(e.reason).toMatch(/data folder/)
    expect((await failure(custodian({ keyFile: join(userDataDir, 'k') }).create(ID))).kind).toBe('denied')
    expect(existsSync(join(userDataDir, 'k'))).toBe(false)
  })

  posixOnly('probes: unconfigured, a creatable path, a missing folder, an existing file checked like open', async () => {
    expect(await custodian().probe()).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(await custodian({ keyFile: join(outside, 'new.key') }).probe()).toEqual({ ok: true })
    expect(await custodian({ keyFile: join(outside, 'nope', 'new.key') }).probe()).toMatchObject({ ok: false, kind: 'unavailable' })
    expect(await custodian({ keyFile: join(dataDir, 'new.key') }).probe()).toMatchObject({ ok: false, kind: 'denied' })
    const loose = join(outside, 'loose.key')
    writeFileSync(loose, Buffer.alloc(32), { mode: 0o644 })
    chmodSync(loose, 0o644)
    expect(await custodian({ keyFile: loose, importExisting: true }).probe()).toMatchObject({ ok: false, kind: 'denied', reason: expect.stringMatching(/chmod 600/) })
    expect(await custodian({ recordedKeyFile: loose }).probe()).toMatchObject({ ok: false, kind: 'denied', reason: expect.stringMatching(/chmod 600/) })
  })

  posixOnly('probes an existing vault whose key file is gone as missing, even when its folder exists (review round 1)', async () => {
    const gone = join(outside, 'gone.key')
    // The recorded path, the variable naming it, or a factory that only knows a vault exists: all 'missing'.
    expect(await custodian({ recordedKeyFile: gone }).probe()).toMatchObject({ ok: false, kind: 'missing' })
    expect(await custodian({ vaultExists: true, env: { ORGAI_VAULT_KEY_FILE: gone } }).probe()).toMatchObject({ ok: false, kind: 'missing' })
    expect(await custodian({ recordedKeyFile: join(outside, 'old.key'), env: { ORGAI_VAULT_KEY_FILE: gone } }).probe()).toMatchObject({ ok: false, kind: 'missing' })
    expect(await custodian({ vaultExists: true }).probe()).toMatchObject({ ok: false, kind: 'missing' })
    // And --import of a file that is not there.
    expect(await custodian({ keyFile: gone, importExisting: true }).probe()).toMatchObject({ ok: false, kind: 'missing' })
    // A new vault through the variable: the file will be created, so its folder is what counts.
    expect(await custodian({ env: { ORGAI_VAULT_KEY_FILE: gone } }).probe()).toEqual({ ok: true })
    // The probe agrees with open.
    expect((await failure(custodian().open(ID, { scheme: 'key-file', keyFile: gone }))).kind).toBe('missing')
  })

  posixOnly('probe of `init --key-file` on an existing file names the --import command', async () => {
    const path = join(outside, 'there.key')
    writeFileSync(path, Buffer.alloc(32, 3), { mode: 0o600 })
    const p = await custodian({ keyFile: path }).probe()
    expect(p).toMatchObject({ ok: false, kind: 'denied' })
    expect((p as { reason: string }).reason).toContain(`orgai secrets init --key-file "${path}" --import`)
    const e = await failure(custodian({ keyFile: path }).create(ID))
    expect(e.reason).toContain(`orgai secrets init --key-file "${path}" --import`)
  })

  posixOnly('a new vault takes an existing file named by ORGAI_VAULT_KEY_FILE as an import, never overwriting it (review round 1)', async () => {
    const path = join(outside, 'ci.key')
    const key = Buffer.alloc(32, 0x5a)
    writeFileSync(path, `${key.toString('base64')}\n`, { mode: 0o600 })
    const c = custodian({ env: { ORGAI_VAULT_KEY_FILE: path } })
    expect(await c.probe()).toEqual({ ok: true })
    const { dek } = await c.create(ID)
    expect(dek.equals(key)).toBe(true)
    expect(readFileSync(path, 'latin1')).toBe(`${key.toString('base64')}\n`)
    // Still checked like open: a loose file is refused, not imported.
    chmodSync(path, 0o644)
    expect((await failure(c.create(ID))).reason).toMatch(/chmod 600/)
    // A missing file named by the variable is created.
    const fresh = join(outside, 'fresh.key')
    const made = await custodian({ env: { ORGAI_VAULT_KEY_FILE: fresh } }).create(ID)
    expect(readFileSync(fresh, 'latin1')).toBe(`${made.dek.toString('base64')}\n`)
    expect(statSync(fresh).mode & 0o777).toBe(0o600)
  })

  posixOnly('open with nothing configured is missing', async () => {
    expect((await failure(custodian().open(ID, { scheme: 'key-file' }))).kind).toBe('missing')
  })
})

describe('Windows key file DACL steps (5.3.1; fake whoami / icacls)', () => {
  const env = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', ORGAI_SECRET_X: 'v' }
  const SID = 'S-1-5-21-111-222-333-1001'
  const whoami = `"desktop-1\\me","${SID}"\r\n`
  const OWNER_ONLY = `D:PAI(A;;FA;;;${SID})`
  const PROFILE_FOLDER = `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${SID})`

  /** What `icacls <path> /save <file>` writes: UTF-16LE with a BOM, the name line, then the SDDL. */
  const saveFile = (name: string, sddl: string): Buffer => Buffer.from(`\ufeff${name}\r\n${sddl}\r\n`, 'utf16le')

  function fakeWin(
    path: string,
    fileSddl: string,
    overrides: { set?: FakeAnswer; whoami?: FakeAnswer; folderSddl?: string; saved?: (target: string) => Buffer | undefined } = {}
  ) {
    return fakeSpawner(({ file, args }) => {
      if (file.endsWith('whoami.exe')) return overrides.whoami ?? { code: 0, stdout: whoami }
      if (file.endsWith('icacls.exe') && args[1] === '/save') {
        const target = args[0]!
        const custom = overrides.saved?.(target)
        writeFileSync(args[2]!, custom ?? saveFile('x', target === path ? fileSddl : (overrides.folderSddl ?? PROFILE_FOLDER)))
        return { code: 0 }
      }
      if (file.endsWith('icacls.exe')) return overrides.set ?? { code: 0, stdout: `processed file: ${path}\r\n` }
      return { code: 9 }
    })
  }

  it('checks the folder, creates the empty file, restricts it to the SID, verifies, then writes', async () => {
    const path = join(outside, 'win.key')
    const f = fakeWin(path, OWNER_ONLY)
    const content = Buffer.from('k\n')
    await createKeyFileWindows(path, content, { env, spawner: f.spawner })
    expect(readFileSync(path, 'utf8')).toBe('k\n')
    const calls = f.calls.map((c) => [c.file, c.args.map((a, i) => (c.args[1] === '/save' && i === 2 ? '<tmp>' : a))])
    expect(calls).toEqual([
      ['C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh']],
      ['C:\\Windows\\System32\\icacls.exe', [outside, '/save', '<tmp>', '/q']],
      ['C:\\Windows\\System32\\icacls.exe', [path, '/inheritance:r', '/grant:r', `*${SID}:F`]],
      ['C:\\Windows\\System32\\icacls.exe', [path, '/save', '<tmp>', '/q']]
    ])
    for (const c of f.calls) expect(c.options.env).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\t' })
    for (const c of f.calls) expect(c.stdin).toBe('')
    // The temp ACL files are gone again.
    for (const c of f.calls.filter((x) => x.args[1] === '/save')) expect(existsSync(c.args[2]!)).toBe(false)
  })

  it('deletes the empty file and fails closed when another principal remains or a step fails', async () => {
    const path = join(outside, 'win.key')
    const extra = fakeWin(path, `D:PAI(A;;FA;;;${SID})(A;;FA;;;BA)`)
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: extra.spawner }))).kind).toBe('denied')
    expect(existsSync(path)).toBe(false)

    const setFails = fakeWin(path, OWNER_ONLY, { set: { code: 5, stderr: 'Access is denied.' } })
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: setFails.spawner }))).kind).toBe('denied')
    expect(existsSync(path)).toBe(false)

    const noSid = fakeWin(path, OWNER_ONLY, { whoami: { code: 0, stdout: 'nothing' } })
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: noSid.spawner }))).kind).toBe('denied')
    expect(existsSync(path)).toBe(false)

    const inherited = fakeWin(path, `D:AI(A;ID;FA;;;${SID})`)
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: inherited.spawner }))).kind).toBe('denied')
    expect(existsSync(path)).toBe(false)
  })

  it('refuses a folder whose new files other accounts could open, before creating anything (review round 1)', async () => {
    const path = join(outside, 'win.key')
    // C:\ci under C:\: Authenticated Users (M) and Users (RX) inherited onto files.
    const shared = fakeWin(path, OWNER_ONLY, { folderSddl: 'D:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;OICIID;0x1301bf;;;AU)' })
    const e = await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: shared.spawner }))
    expect(e.kind).toBe('denied')
    expect(e.reason).toMatch(/Other accounts can open new files/)
    expect(e.reason).toContain('--import')
    expect(existsSync(path)).toBe(false)
    expect(shared.calls.some((c) => c.args.includes('/grant:r'))).toBe(false)
    // A null DACL, and an unreadable answer, fail closed too.
    const open = fakeWin(path, OWNER_ONLY, { folderSddl: 'D:NO_ACCESS_CONTROL' })
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: open.spawner }))).kind).toBe('denied')
    const junk = fakeWin(path, OWNER_ONLY, { saved: (t) => (t === outside ? Buffer.from('garbage') : undefined) })
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: junk.spawner }))).reason).toMatch(/could not read the access list of the folder/)
    expect(existsSync(path)).toBe(false)
    // An entry for others that applies to subfolders only (CI without OI) does not reach a new file.
    const subdirsOnly = fakeWin(path, OWNER_ONLY, { folderSddl: `${PROFILE_FOLDER}(A;CI;0x1200a9;;;BU)` })
    await createKeyFileWindows(path, Buffer.from('k'), { env, spawner: subdirsOnly.spawner })
    expect(existsSync(path)).toBe(true)
  })

  it('never overwrites an existing file', async () => {
    const path = join(outside, 'win.key')
    writeFileSync(path, 'old')
    const f = fakeWin(path, OWNER_ONLY)
    const e = await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: f.spawner }))
    expect(e.kind).toBe('denied')
    expect(e.reason).toContain('--import')
    expect(readFileSync(path, 'utf8')).toBe('old')
    expect(f.calls).toHaveLength(0)
  })

  it('opens only after the DACL check passes, and names the icacls fix when it does not (review round 1)', async () => {
    const path = join(outside, 'win.key')
    const key = Buffer.alloc(32, 4)
    writeFileSync(path, key.toString('base64'))
    const ok = fakeWin(path, OWNER_ONLY)
    expect((await readKeyFileWindows(path, { env, spawner: ok.spawner })).equals(key)).toBe(true)
    // `openssl rand -base64 32 > key` in a profile folder: inherited SYSTEM, Administrators and the user.
    const editorMade = fakeWin(path, `D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${SID})`)
    const e = await failure(readKeyFileWindows(path, { env, spawner: editorMade.spawner }))
    expect(e.kind).toBe('denied')
    expect(e.reason).toContain(`icacls "${path}" /inheritance:r /grant:r "*${SID}:F"`)
    expect(icaclsRemedy(path, SID)).toBe(`icacls "${path}" /inheritance:r /grant:r "*${SID}:F"`)
    expect((await failure(readKeyFileWindows(join(outside, 'none'), { env, spawner: ok.spawner }))).kind).toBe('missing')
  })

  it('reads a non-ASCII path and account name, comparing SIDs only (review round 1)', async () => {
    const path = join(outside, 'José', 'orgai.key')
    mkdirSync(join(outside, 'José'))
    const key = Buffer.alloc(32, 6)
    writeFileSync(path, key.toString('base64'))
    // whoami prints in the OEM code page (cp850 "é" = 0x82), which does not decode as UTF-8; the name is then left out
    // of messages and only the SID is compared. icacls /save's name line is never read.
    const oem = Buffer.concat([Buffer.from('"desktop-1\\Jos'), Buffer.from([0x82]), Buffer.from(`","${SID}"\r\n`)])
    const f = fakeWin(path, OWNER_ONLY, { whoami: { code: 0, stdout: oem.toString('latin1') } })
    expect((await readKeyFileWindows(path, { env, spawner: f.spawner })).equals(key)).toBe(true)
    const other = fakeWin(path, `D:PAI(A;;FA;;;S-1-5-21-9-9-9-1002)`, { whoami: { code: 0, stdout: oem.toString('latin1') } })
    const e = await failure(readKeyFileWindows(path, { env, spawner: other.spawner }))
    expect(e.reason).toContain(SID)
    expect(e.reason).not.toContain('desktop-1')
  })

  it('gives an unreadable access list its own message', async () => {
    const path = join(outside, 'win.key')
    writeFileSync(path, Buffer.alloc(32, 4).toString('base64'))
    const f = fakeWin(path, OWNER_ONLY, { saved: () => Buffer.from('not sddl at all') })
    const e = await failure(readKeyFileWindows(path, { env, spawner: f.spawner }))
    expect(e.reason).toMatch(/could not read the access list of the key file/)
    expect(e.reason).not.toMatch(/other accounts/)
  })

  it('parses whoami, icacls /save files and SDDL', () => {
    expect(parseWhoamiUser(whoami)).toEqual({ name: 'desktop-1\\me', sid: SID })
    expect(parseWhoamiUser('"User Name","SID"\r\n"a\\b","S-1-5-18"\r\n')).toEqual({ name: 'a\\b', sid: 'S-1-5-18' })
    expect(parseWhoamiUser('')).toBeUndefined()

    expect(parseIcaclsSave(saveFile('orgai.key', OWNER_ONLY))).toEqual({ protected: true, nullDacl: false, aces: [{ type: 'A', flags: [], rights: 'FA', sid: SID }] })
    // Without a BOM, and as plain text.
    expect(parseIcaclsSave(Buffer.from(`orgai.key\r\n${OWNER_ONLY}\r\n`, 'utf16le'))?.aces).toHaveLength(1)
    expect(parseIcaclsSave(Buffer.from(`orgai.key\r\n${OWNER_ONLY}\r\n`, 'latin1'))?.aces).toHaveLength(1)
    // Two objects (a folder saved with its contents) or none: unknown.
    expect(parseIcaclsSave(saveFile('a', `${OWNER_ONLY}\r\nb\r\n${OWNER_ONLY}`))).toBeUndefined()
    expect(parseIcaclsSave(Buffer.from('garbage'))).toBeUndefined()

    expect(parseSddlDacl('D:AI(A;OICIID;FA;;;SY)(A;OICIID;0x1301bf;;;AU)')?.aces).toEqual([
      { type: 'A', flags: ['OI', 'CI', 'ID'], rights: 'FA', sid: 'S-1-5-18' },
      { type: 'A', flags: ['OI', 'CI', 'ID'], rights: '0x1301bf', sid: 'S-1-5-11' }
    ])
    expect(parseSddlDacl(`O:BAG:SYD:PAI(A;;FA;;;${SID})`)?.protected).toBe(true)
    expect(parseSddlDacl('D:(XA;;FA;;;WD;(@User.x == 1))')).toBeUndefined()
    expect(parseSddlDacl('nonsense')).toBeUndefined()

    const user = { sid: SID }
    const dacl = (t: string) => parseSddlDacl(t)!
    expect(daclIsOwnerOnly(dacl(OWNER_ONLY), user)).toBe(true)
    expect(daclIsOwnerOnly(dacl(`D:P(A;;0x1f01ff;;;${SID.toLowerCase()})`), user)).toBe(true)
    expect(daclIsOwnerOnly(dacl(`D:AI(A;;FA;;;${SID})`), user)).toBe(false)
    expect(daclIsOwnerOnly(dacl(`D:P(A;;FR;;;${SID})`), user)).toBe(false)
    expect(daclIsOwnerOnly(dacl('D:P(A;;FA;;;S-1-5-21-1-2-3-1002)'), user)).toBe(false)
    expect(daclIsOwnerOnly(dacl(`D:P(A;;FA;;;${SID})(D;;FA;;;WD)`), user)).toBe(false)
    expect(daclIsOwnerOnly(dacl('D:PNO_ACCESS_CONTROL'), user)).toBe(false)
    expect(daclIsOwnerOnly(dacl('D:P(A;;FA;;;LA)'), { sid: 'S-1-5-21-1-2-3-500' })).toBe(true)

    expect(folderLetsOthersIn(dacl(PROFILE_FOLDER), user)).toBe(false)
    expect(folderLetsOthersIn(dacl(`${PROFILE_FOLDER}(A;OICI;FA;;;CO)(D;OICI;FA;;;WD)`), user)).toBe(false)
    expect(folderLetsOthersIn(dacl(`${PROFILE_FOLDER}(A;OICIIO;0x1200a9;;;BU)`), user)).toBe(true)
    expect(folderLetsOthersIn(dacl(`${PROFILE_FOLDER}(A;OI;FR;;;S-1-5-21-1-2-3-1002)`), user)).toBe(true)
    expect(folderLetsOthersIn(dacl(`${PROFILE_FOLDER}(A;OI;FR;;;ZZ)`), user)).toBe(true)
  })
})
