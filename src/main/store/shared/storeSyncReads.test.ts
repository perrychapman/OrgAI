// A store's re-read of a file another session changed runs under the data folder's write lock. Why: a writer replaces
// the file by renaming a temp file over it, and on Windows that rename fails with EPERM while another process has the
// target open for a read, even for a millisecond (src/main/store/sameProject.test.ts failed 2 runs in 5 on it, with
// no change from the UI overhaul involved). Held under the lock, a read and a rename of the same file never overlap.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSession, writeLockPath, type SessionHandle } from '../../host/sessions'
import { createSharedStoreSync, type StoreSync } from './storeSync'
import { probeSyncLock, trySyncLock } from './syncLock'

let dataDir: string
const handles: SessionHandle[] = []
const syncs: { close(): void }[] = []

function session(id: string, opts: Parameters<typeof createSharedStoreSync>[1] = {}): StoreSync {
  const handle = registerSession(dataDir, { hostInstanceId: id, pid: process.pid, startedAt: Date.now(), appVersion: 't', cwd: `/work/${id}`, command: 'tui' })
  handles.push(handle)
  const sync = createSharedStoreSync(handle, { checkMs: 0, liveForMs: 0, ...opts })
  syncs.push(sync)
  return sync
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'orgai-sync-reads-'))
  mkdirSync(dataDir, { recursive: true })
})
afterEach(() => {
  for (const s of syncs.splice(0)) s.close()
  for (const h of handles.splice(0)) h.release()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const lockState = (): string => probeSyncLock(writeLockPath(dataDir))

describe('reads of a shared store file', () => {
  it('re-read a changed file while holding the write lock, and let it go after', () => {
    const file = join(dataDir, 'x.json')
    writeFileSync(file, '1')
    const sync = session('aaaaaaaaaaaa')
    const seen: string[] = []
    sync.load(file, () => seen.push(`load:${lockState()}`))
    writeFileSync(file, '22')
    expect(sync.refresh(file, () => seen.push(`reload:${lockState()}`))).toBe(true)
    expect(seen).toEqual(['load:held', 'reload:held'])
    expect(lockState()).toBe('free')
  })

  it('take no lock when the file has not changed', () => {
    const file = join(dataDir, 'x.json')
    writeFileSync(file, '1')
    const sync = session('aaaaaaaaaaaa')
    sync.load(file, () => {})
    // Another session holds the lock: an unchanged file must not wait for it.
    const other = trySyncLock(writeLockPath(dataDir))
    try {
      const started = Date.now()
      expect(sync.refresh(file, () => expect.unreachable('nothing changed'))).toBe(false)
      expect(Date.now() - started).toBeLessThan(500)
    } finally {
      other?.release()
    }
  })

  it('wait for a writer in another session, then read without the lock rather than fail when it stays', () => {
    const file = join(dataDir, 'x.json')
    writeFileSync(file, '1')
    const sync = session('aaaaaaaaaaaa', { readWaitMs: 150 })
    sync.load(file, () => {})
    writeFileSync(file, '22')
    const writer = trySyncLock(writeLockPath(dataDir))
    expect(writer).not.toBeNull()
    try {
      let read = 0
      const started = performance.now()
      expect(sync.refresh(file, () => void (read += 1))).toBe(true)
      // It waited for the whole read budget (the lock was never given back), and then still read the file.
      expect(performance.now() - started).toBeGreaterThanOrEqual(100)
      expect(read).toBe(1)
    } finally {
      writer?.release()
    }
  })

  it('stay inside a hold of the same session (a read from within a change does not wait for itself)', () => {
    const file = join(dataDir, 'x.json')
    writeFileSync(file, '1')
    const sync = session('aaaaaaaaaaaa')
    sync.load(file, () => {})
    writeFileSync(file, '22')
    const started = Date.now()
    sync.locked(() => {
      expect(sync.refresh(file, () => {})).toBe(true)
    })
    expect(Date.now() - started).toBeLessThan(500)
    expect(lockState()).toBe('free')
  })
})
