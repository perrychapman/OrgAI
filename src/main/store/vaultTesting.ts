/**
 * Test support for the secret vault (never imported by production code): a fake custodian (an in-memory "keychain"
 * shared by every host of a test), fake safeStorage ciphers, an older OrgAI app that only knows secrets.json, and a
 * file system that fails or "crashes" at any write, fsync, rename or unlink boundary. Electron-free.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { VaultCustodyScheme } from '../../shared/types'
import { nodeVaultFs, type VaultFs } from './durableFs'
import type { SecretCipher } from './secrets'
import { CustodyError, type CustodianFactory, type CustodianRequest, type CustodyFailure, type VaultCustody } from './vaultTypes'

/** Reversible fake of safeStorage: not encryption, but never stores the plain text. */
export const fakeCipher = (available = true): SecretCipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
  decryptString: (buf) => {
    const s = buf.toString('utf8')
    if (!s.startsWith('enc:')) throw new Error('bad ciphertext')
    return [...s.slice(4)].reverse().join('')
  }
})

/** A Node host's cipher: nothing can be encrypted or decrypted. */
export const noCipher: SecretCipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('no safeStorage')
  },
  decryptString: () => {
    throw new Error('no safeStorage')
  }
}

/** An in-memory key store shared by the hosts of one test (the OS keychain stand-in). */
export interface FakeCustody {
  factory: CustodianFactory
  items: Map<string, Buffer>
  calls: { probe: number; create: number; open: number; requests: { scheme: VaultCustodyScheme; request?: CustodianRequest; custody?: VaultCustody }[] }
  /** Fail every create / open / probe with this until cleared. */
  fail(f: CustodyFailure | undefined): void
  /** Hold every create / open until release() (single-flight tests). */
  hold(): void
  release(): void
}

export function fakeCustody(): FakeCustody {
  const items = new Map<string, Buffer>()
  const calls: FakeCustody['calls'] = { probe: 0, create: 0, open: 0, requests: [] }
  let failure: CustodyFailure | undefined
  let gate: Promise<void> | undefined
  let open: (() => void) | undefined
  const waitGate = async (): Promise<void> => {
    if (gate) await gate
  }
  const factory: CustodianFactory = (scheme, request) => ({
    scheme,
    probe: async () => {
      calls.probe++
      return failure ? { ok: false, ...failure } : { ok: true }
    },
    create: async (vaultId) => {
      calls.create++
      calls.requests.push({ scheme, ...(request ? { request } : {}) })
      await waitGate()
      if (failure) throw new CustodyError(failure.kind, failure.reason)
      if (items.has(vaultId)) throw new CustodyError('denied', 'an item for this vault exists')
      const dek = randomBytes(32)
      items.set(vaultId, Buffer.from(dek))
      // dpapi-user stores a protected blob in vault.json (custody.wrapped): the fake's blob is the key itself, base64.
      return { dek, ...(scheme === 'key-file' && request?.keyFile ? { keyFile: request.keyFile } : {}), ...(scheme === 'dpapi-user' ? { wrapped: dek.toString('base64') } : {}) }
    },
    open: async (vaultId, custody) => {
      calls.open++
      calls.requests.push({ scheme, ...(request ? { request } : {}), custody })
      await waitGate()
      if (failure) throw new CustodyError(failure.kind, failure.reason)
      const dek = items.get(vaultId)
      if (!dek) throw new CustodyError('missing', 'no item for this vault')
      return Buffer.from(dek)
    }
  })
  return {
    factory,
    items,
    calls,
    fail: (f) => {
      failure = f
    },
    hold: () => {
      gate = new Promise<void>((r) => (open = r))
    },
    release: () => {
      open?.()
      gate = undefined
    }
  }
}

/** The OrgAI app before this wave: it reads secrets.json into a map and rewrites the whole file on every change. */
export interface OlderApp {
  get(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
  /** Rewrite secrets.json with exactly these values (e.g. after loading a corrupt file as empty). */
  rewrite(values: Record<string, string>): void
  keys(): string[]
}

export function olderApp(dataDir: string, cipher: SecretCipher = fakeCipher()): OlderApp {
  const file = join(dataDir, 'secrets.json')
  const load = (): Record<string, string> => {
    try {
      const raw = (JSON.parse(readFileSync(file, 'utf8')) as { secrets?: Record<string, string> }).secrets
      return raw && typeof raw === 'object' ? { ...raw } : {}
    } catch {
      return {}
    }
  }
  const save = (values: Record<string, string>): void => writeFileSync(file, JSON.stringify({ version: 1, secrets: values }, null, 2))
  return {
    get: (k) => {
      const v = load()[k]
      return v === undefined ? undefined : cipher.decryptString(Buffer.from(v, 'base64'))
    },
    set: (k, v) => {
      const m = load()
      m[k] = cipher.encryptString(v).toString('base64')
      save(m)
    },
    delete: (k) => {
      const m = load()
      delete m[k]
      save(m)
    },
    rewrite: (values) => {
      const m: Record<string, string> = {}
      for (const [k, v] of Object.entries(values)) m[k] = cipher.encryptString(v).toString('base64')
      save(m)
    },
    keys: () => Object.keys(load())
  }
}

/** One mutating file-system call, named by the file it touches (temp files as `<target>.tmp`). */
export type FsBoundary = { op: 'open' | 'write' | 'fsync' | 'close' | 'rename' | 'dir-open' | 'dir-fsync' | 'unlink'; file: string }

/**
 * How a boundary fails. 'throw': that call throws EIO and later calls work (the store recovers in process).
 * 'crash': that call throws and every later call (reads included) fails: the process is gone; reopen on a healthy fs.
 * 'crash-lose-rename' (dir-fsync only): as 'crash', and the rename before it is undone, source and target (power lost
 * before the directory entries were durable). 'fail-from': that call and every later write boundary throw (a full disk); reads work.
 */
export type FaultMode = 'throw' | 'crash' | 'crash-lose-rename' | 'fail-from'

export interface FaultFs {
  fs: VaultFs
  /** Boundaries seen since the last arm(). */
  events: FsBoundary[]
  /** Start counting (and fail at the nth boundary, 1-based, when given). */
  arm(at?: number, mode?: FaultMode): void
  dead(): boolean
}

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`injected ${code}`), { code })
const label = (p: string): string => basename(p)

export function faultFs(): FaultFs {
  const events: FsBoundary[] = []
  let at = 0
  let mode: FaultMode = 'throw'
  let crashed = false
  const dirFds = new Map<number, string>()
  const fileFds = new Map<number, string>()
  /** The last rename: its source bytes and the target's bytes before it, so a lost rename puts both entries back. */
  let lastRename: { from: string; moved: Buffer | undefined; to: string; before: Buffer | undefined } | undefined
  const boundary = (op: FsBoundary['op'], file: string): void => {
    if (crashed) throw errno('EIO')
    events.push({ op, file })
    if (at && mode === 'fail-from' && events.length >= at) throw errno('ENOSPC')
    if (at && events.length === at) {
      if (mode !== 'throw') {
        crashed = true
        if (mode === 'crash-lose-rename' && op === 'dir-fsync' && lastRename) {
          if (lastRename.before === undefined) {
            if (existsSync(lastRename.to)) unlinkSync(lastRename.to)
          } else writeFileSync(lastRename.to, lastRename.before)
          // the source entry comes back too (a temp file left behind, or a file a reset was moving aside)
          if (lastRename.moved !== undefined) writeFileSync(lastRename.from, lastRename.moved)
        }
      }
      throw errno('EIO')
    }
  }
  const read = <T,>(fn: () => T): T => {
    if (crashed) throw errno('EIO')
    return fn()
  }
  const fs: VaultFs = {
    readFileSync: (p) => read(() => nodeVaultFs.readFileSync(p)),
    existsSync: (p) => read(() => nodeVaultFs.existsSync(p)),
    readdirSync: (p) => read(() => nodeVaultFs.readdirSync(p)),
    realpathSync: (p) => read(() => nodeVaultFs.realpathSync(p)),
    mkdirSync: (p, o) => read(() => nodeVaultFs.mkdirSync(p, o)),
    openSync: (p, f, m) => {
      const isDir = f === 'r'
      boundary(isDir ? 'dir-open' : 'open', label(p))
      const fd = nodeVaultFs.openSync(p, f, m)
      if (isDir) dirFds.set(fd, p)
      else fileFds.set(fd, label(p))
      return fd
    },
    writeSync: (fd, d, o, l) => {
      boundary('write', fileFds.get(fd) ?? '?')
      return nodeVaultFs.writeSync(fd, d, o, l)
    },
    fsyncSync: (fd) => {
      boundary(dirFds.has(fd) ? 'dir-fsync' : 'fsync', dirFds.has(fd) ? 'dir' : (fileFds.get(fd) ?? '?'))
      nodeVaultFs.fsyncSync(fd)
    },
    closeSync: (fd) => {
      if (dirFds.has(fd)) {
        dirFds.delete(fd)
        nodeVaultFs.closeSync(fd)
        return
      }
      const name = fileFds.get(fd) ?? '?'
      fileFds.delete(fd)
      try {
        boundary('close', name)
      } finally {
        nodeVaultFs.closeSync(fd)
      }
    },
    renameSync: (a, b) => {
      boundary('rename', label(b))
      lastRename = { from: a, moved: existsSync(a) ? readFileSync(a) : undefined, to: b, before: existsSync(b) ? readFileSync(b) : undefined }
      nodeVaultFs.renameSync(a, b)
    },
    unlinkSync: (p) => {
      // removing our own temp file after a failure is not a boundary
      if (p.endsWith('.tmp')) return nodeVaultFs.unlinkSync(p)
      boundary('unlink', label(p))
      nodeVaultFs.unlinkSync(p)
    }
  }
  return {
    fs,
    events,
    arm: (n = 0, m = 'throw') => {
      events.length = 0
      at = n
      mode = m
      crashed = false
      lastRename = undefined
    },
    dead: () => crashed
  }
}

/** Every file directly in `dir` (the data folder of a test), for restoring a starting point. */
export function snapshotDir(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isFile()) out.set(name, readFileSync(p))
  }
  return out
}

/** Put `dir` back to a snapshot: files not in it are removed, the others rewritten. */
export function restoreDir(dir: string, snap: Map<string, Buffer>): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isFile() && !snap.has(name)) unlinkSync(p)
  }
  for (const [name, bytes] of snap) writeFileSync(join(dir, name), bytes)
}

/** 1-based index of the first boundary matching, for arming a fault there (0 when none). */
export function boundaryIndex(events: FsBoundary[], match: Partial<FsBoundary>, nth = 1): number {
  let seen = 0
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as FsBoundary
    if ((match.op === undefined || e.op === match.op) && (match.file === undefined || e.file === match.file) && ++seen === nth) return i + 1
  }
  return 0
}
