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
  keyFilePathProblem,
  parseIcaclsAces,
  parseKeyFileContent,
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
    expect(await custodian({ keyFile: loose }).probe()).toMatchObject({ ok: false, kind: 'denied' })
    expect(await custodian({ recordedKeyFile: loose }).probe()).toMatchObject({ ok: false, kind: 'denied' })
  })

  posixOnly('open with nothing configured is missing', async () => {
    expect((await failure(custodian().open(ID, { scheme: 'key-file' }))).kind).toBe('missing')
  })
})

describe('Windows key file DACL steps (5.3.1; fake whoami / icacls)', () => {
  const env = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', ORGAI_SECRET_X: 'v' }
  const SID = 'S-1-5-21-111-222-333-1001'
  const whoami = `"desktop-1\\me","${SID}"\r\n`

  function fakeWin(path: string, aces: string, overrides: { set?: FakeAnswer; whoami?: FakeAnswer } = {}) {
    return fakeSpawner(({ file, args }) => {
      if (file.endsWith('whoami.exe')) return overrides.whoami ?? { code: 0, stdout: whoami }
      if (file.endsWith('icacls.exe') && args.length > 1) return overrides.set ?? { code: 0, stdout: `processed file: ${path}\r\n` }
      if (file.endsWith('icacls.exe')) return { code: 0, stdout: `${path} ${aces}\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n` }
      return { code: 9 }
    })
  }

  it('creates the empty file, restricts it to the SID, verifies, then writes', async () => {
    const path = join(outside, 'win.key')
    const f = fakeWin(path, 'desktop-1\\me:(F)')
    const content = Buffer.from('k\n')
    await createKeyFileWindows(path, content, { env, spawner: f.spawner })
    expect(readFileSync(path, 'utf8')).toBe('k\n')
    expect(f.calls.map((c) => [c.file, c.args])).toEqual([
      ['C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh']],
      ['C:\\Windows\\System32\\icacls.exe', [path, '/inheritance:r', '/grant:r', `*${SID}:F`]],
      ['C:\\Windows\\System32\\icacls.exe', [path]]
    ])
    for (const c of f.calls) expect(c.options.env).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\t' })
    for (const c of f.calls) expect(c.stdin).toBe('')
  })

  it('deletes the empty file and fails closed when another principal remains or a step fails', async () => {
    const path = join(outside, 'win.key')
    const extra = fakeWin(path, 'desktop-1\\me:(F)\r\n                 BUILTIN\\Administrators:(F)')
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: extra.spawner }))).kind).toBe('denied')
    expect(existsSync(path)).toBe(false)

    const setFails = fakeWin(path, 'desktop-1\\me:(F)', { set: { code: 5, stderr: 'Access is denied.' } })
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: setFails.spawner }))).kind).toBe('denied')
    expect(existsSync(path)).toBe(false)

    const noSid = fakeWin(path, 'desktop-1\\me:(F)', { whoami: { code: 0, stdout: 'nothing' } })
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: noSid.spawner }))).kind).toBe('denied')
    expect(existsSync(path)).toBe(false)

    const inherited = fakeWin(path, 'desktop-1\\me:(I)(F)')
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: inherited.spawner }))).kind).toBe('denied')
    expect(existsSync(path)).toBe(false)
  })

  it('never overwrites an existing file', async () => {
    const path = join(outside, 'win.key')
    writeFileSync(path, 'old')
    const f = fakeWin(path, 'desktop-1\\me:(F)')
    expect((await failure(createKeyFileWindows(path, Buffer.from('k'), { env, spawner: f.spawner }))).kind).toBe('denied')
    expect(readFileSync(path, 'utf8')).toBe('old')
    expect(f.calls).toHaveLength(0)
  })

  it('opens only after the DACL check passes', async () => {
    const path = join(outside, 'win.key')
    const key = Buffer.alloc(32, 4)
    writeFileSync(path, key.toString('base64'))
    const ok = fakeWin(path, `*${SID}:(F)`)
    expect((await readKeyFileWindows(path, { env, spawner: ok.spawner })).equals(key)).toBe(true)
    const everyone = fakeWin(path, 'desktop-1\\me:(F)\r\n          Everyone:(R)')
    expect((await failure(readKeyFileWindows(path, { env, spawner: everyone.spawner }))).reason).toMatch(/other accounts/)
    expect((await failure(readKeyFileWindows(join(outside, 'none'), { env, spawner: ok.spawner }))).kind).toBe('missing')
  })

  it('parses whoami and icacls output', () => {
    expect(parseWhoamiUser(whoami)).toEqual({ name: 'desktop-1\\me', sid: SID })
    expect(parseWhoamiUser('"User Name","SID"\r\n"a\\b","S-1-5-18"\r\n')).toEqual({ name: 'a\\b', sid: 'S-1-5-18' })
    expect(parseWhoamiUser('')).toBeUndefined()
    const p = 'C:\\keys\\orgai.key'
    expect(parseIcaclsAces(`${p} NT AUTHORITY\\SYSTEM:(I)(F)\r\n    BUILTIN\\Users:(I)(RX)\r\n\r\nSuccessfully processed 1 files`, p)).toEqual([
      { principal: 'NT AUTHORITY\\SYSTEM', perms: '(I)(F)' },
      { principal: 'BUILTIN\\Users', perms: '(I)(RX)' }
    ])
    expect(parseIcaclsAces('something else entirely', p)).toBeUndefined()
    expect(parseIcaclsAces(`${p} junk`, p)).toBeUndefined()
    const user = { name: 'host\\me', sid: SID }
    expect(daclIsOwnerOnly([{ principal: 'HOST\\ME', perms: '(F)' }], user)).toBe(true)
    expect(daclIsOwnerOnly([{ principal: SID, perms: '(F)' }], user)).toBe(true)
    expect(daclIsOwnerOnly([{ principal: 'host\\me', perms: '(RX)' }], user)).toBe(false)
    expect(daclIsOwnerOnly([{ principal: 'host\\other', perms: '(F)' }], user)).toBe(false)
  })
})
