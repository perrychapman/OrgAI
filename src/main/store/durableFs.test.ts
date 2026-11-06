import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DurableFsError, durableTempPath, fsyncDir, nodeVaultFs, renameDurable, unlinkDurable, writeFileDurable, type VaultFs } from './durableFs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'durable-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

/** A file system that records every call and fails the nth call of one kind (directory calls named 'dir-*'). */
function recordingFs(failAt?: { op: string; nth: number; code?: string }): { fs: VaultFs; ops: string[] } {
  const ops: string[] = []
  const dirFds = new Set<number>()
  const counts = new Map<string, number>()
  const hit = (op: string): void => {
    ops.push(op)
    const n = (counts.get(op) ?? 0) + 1
    counts.set(op, n)
    if (failAt && failAt.op === op && failAt.nth === n) throw errno(failAt.code ?? 'EIO')
  }
  const fs: VaultFs = {
    ...nodeVaultFs,
    openSync: (p, f, m) => {
      const isDir = f === 'r' && statSync(p).isDirectory()
      hit(isDir ? 'dir-open' : 'open')
      const fd = nodeVaultFs.openSync(p, f, m)
      if (isDir) dirFds.add(fd)
      return fd
    },
    writeSync: (fd, d, o, l) => {
      hit('write')
      return nodeVaultFs.writeSync(fd, d, o, l)
    },
    fsyncSync: (fd) => {
      hit(dirFds.has(fd) ? 'dir-fsync' : 'fsync')
      nodeVaultFs.fsyncSync(fd)
    },
    closeSync: (fd) => {
      if (!dirFds.has(fd)) hit('close')
      dirFds.delete(fd)
      nodeVaultFs.closeSync(fd)
    },
    renameSync: (a, b) => {
      hit('rename')
      nodeVaultFs.renameSync(a, b)
    },
    unlinkSync: (p) => {
      hit('unlink')
      nodeVaultFs.unlinkSync(p)
    }
  }
  return { fs, ops }
}

describe('writeFileDurable (cli-standalone.md 5.5 Durability)', () => {
  it('writes, fsyncs the file, renames, then fsyncs the directory on POSIX (mode 0o600, no temp left)', () => {
    const target = join(dir, 'vault.json')
    const { fs, ops } = recordingFs()
    writeFileDurable(target, 'hello', { fs, platform: 'linux' })
    expect(readFileSync(target, 'utf8')).toBe('hello')
    // 'unlink' first: a leftover <target>.tmp from a crash is removed (ENOENT here) before the O_EXCL create
    expect(ops).toEqual(['unlink', 'open', 'write', 'fsync', 'close', 'rename', 'dir-open', 'dir-fsync'])
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['vault.json'])
  })

  it('skips the directory fsync on win32', () => {
    const { fs, ops } = recordingFs()
    writeFileDurable(join(dir, 'x'), 'a', { fs, platform: 'win32' })
    expect(ops).not.toContain('dir-fsync')
    expect(ops).not.toContain('dir-open')
  })

  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])('treats a directory fsync refused with %s like Windows', (code) => {
    const { fs } = recordingFs({ op: 'dir-fsync', nth: 1, code })
    writeFileDurable(join(dir, 'x'), 'a', { fs, platform: 'linux' })
    expect(readFileSync(join(dir, 'x'), 'utf8')).toBe('a')
  })

  it.each([
    ['open', 'unchanged'],
    ['write', 'unchanged'],
    ['fsync', 'unchanged'],
    ['close', 'unchanged'],
    ['rename', 'unknown'],
    ['dir-open', 'unknown'],
    ['dir-fsync', 'unknown']
  ] as const)('a failure at %s is %s', (op, outcome) => {
    const target = join(dir, 'vault.json')
    writeFileSync(target, 'old')
    const { fs } = recordingFs({ op, nth: 1 })
    let err: unknown
    try {
      writeFileDurable(target, 'new', { fs, platform: 'linux' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(DurableFsError)
    expect((err as DurableFsError).outcome).toBe(outcome)
    // before the rename nothing changed; from the rename on the new bytes may be visible (not known to be durable)
    expect(readFileSync(target, 'utf8')).toBe(outcome === 'unchanged' || op === 'rename' ? 'old' : 'new')
    // the temp file never stays behind
    expect(readdirSync(dir)).toEqual(['vault.json'])
  })

  it('uses one fixed temp name per target: a leftover from a crash is replaced, never piled up', () => {
    const target = join(dir, 'vault.json')
    expect(durableTempPath(target)).toBe(join(dir, 'vault.json.tmp'))
    writeFileSync(durableTempPath(target), 'stale half-written bytes')
    writeFileDurable(target, 'new', { platform: 'linux' })
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['vault.json'])
  })

  it('a link planted at the temp name is removed, never followed (O_EXCL create after the unlink)', () => {
    if (process.platform === 'win32') return
    const outside = join(dir, 'outside')
    writeFileSync(outside, 'keep me')
    const target = join(dir, 'vault.json')
    symlinkSync(outside, durableTempPath(target))
    writeFileDurable(target, 'new', { platform: 'linux' })
    expect(readFileSync(outside, 'utf8')).toBe('keep me')
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(readdirSync(dir).sort()).toEqual(['outside', 'vault.json'])
  })

  it('a leftover temp file that cannot be removed fails before the rename (unchanged)', () => {
    const target = join(dir, 'vault.json')
    writeFileSync(target, 'old')
    const { fs } = recordingFs({ op: 'unlink', nth: 1, code: 'EACCES' })
    expect(() => writeFileDurable(target, 'new', { fs, platform: 'linux' })).toThrow(expect.objectContaining({ outcome: 'unchanged', step: 'open' }))
    expect(readFileSync(target, 'utf8')).toBe('old')
  })

  it('renameDurable and unlinkDurable report ENOENT as unchanged and dir-fsync failures as unknown', () => {
    expect(() => renameDurable(join(dir, 'none'), join(dir, 'b'))).toThrow(expect.objectContaining({ outcome: 'unchanged' }))
    expect(() => unlinkDurable(join(dir, 'none'))).toThrow(expect.objectContaining({ outcome: 'unchanged' }))
    writeFileSync(join(dir, 'a'), '1')
    const { fs } = recordingFs({ op: 'dir-fsync', nth: 1 })
    expect(() => renameDurable(join(dir, 'a'), join(dir, 'b'), { fs, platform: 'darwin' })).toThrow(expect.objectContaining({ outcome: 'unknown', step: 'dir-fsync' }))
    expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('1')
    const { fs: fs2 } = recordingFs({ op: 'unlink', nth: 1, code: 'EPERM' })
    expect(() => unlinkDurable(join(dir, 'b'), { fs: fs2 })).toThrow(expect.objectContaining({ outcome: 'unknown', step: 'unlink' }))
    unlinkDurable(join(dir, 'b'), { platform: 'win32' })
    expect(readdirSync(dir)).toEqual([])
    fsyncDir(dir, { platform: 'win32' })
  })
})
