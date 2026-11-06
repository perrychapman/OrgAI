/**
 * cli-standalone.md 4.3 tests (b) and (c) with a real owner process: testFixtures/shutdownOwner.ts runs under vite-node
 * as a 'node' host owning a temp data folder; this test is the racing contender (acquireHostOwnership in a loop, as a
 * `--host inproc` CLI would). (b) a writer that finishes after the drain began: no contender owns the folder before the
 * write landed. (c) a writer that hangs past the hard limit plus a git stand-in (and its hook) that ignore SIGTERM: the
 * folder is taken only after the owner process exited and both descendants are gone. POSIX only (the Windows process
 * table and taskkill paths are not exercised here).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostOwnershipError, acquireHostOwnership } from './ownership'
import { readProcessTable } from './shutdown'

const ROOT = resolve(__dirname, '..', '..', '..')
const VITE_NODE = join(ROOT, 'node_modules', 'vite-node', 'vite-node.mjs')
const FIXTURE = join(__dirname, 'testFixtures', 'shutdownOwner.ts')

const dirs: string[] = []
const kids: ChildProcess[] = []
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill('SIGKILL')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Owner {
  child: ChildProcess
  events: Record<string, unknown>[]
  exited: Promise<number | null>
  next(event: string, ms?: number): Promise<Record<string, unknown>>
}

function startOwner(env: Record<string, string>): Owner {
  const child = spawn(process.execPath, [VITE_NODE, FIXTURE], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  kids.push(child)
  const events: Record<string, unknown>[] = []
  let buf = ''
  child.stdout!.on('data', (d) => {
    buf += String(d)
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try {
        events.push({ ...JSON.parse(line), receivedAt: Date.now() })
      } catch {
        // not ours
      }
    }
  })
  let stderr = ''
  child.stderr!.on('data', (d) => void (stderr += String(d)))
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))
  return {
    child,
    events,
    exited,
    async next(event, ms = 30_000) {
      const end = Date.now() + ms
      for (;;) {
        const hit = events.find((e) => e.event === event)
        if (hit) return hit
        if (child.exitCode !== null && !events.some((e) => e.event === event)) throw new Error(`owner exited before ${event}: ${stderr}`)
        if (Date.now() > end) throw new Error(`timed out waiting for ${event}: ${stderr}`)
        await new Promise((r) => setTimeout(r, 25))
      }
    }
  }
}

function folder(): { dataDir: string; runtimeBase: string } {
  const base = realpathSync(mkdtempSync(join('/tmp', 'orgai-sdi-')))
  dirs.push(base)
  const runtimeBase = join(base, 'rt')
  mkdirSync(runtimeBase, { recursive: true, mode: 0o700 })
  return { dataDir: join(base, 'data'), runtimeBase }
}

/** One contender attempt: true when it took (and gave back) ownership, false when a live host still owns the folder. */
async function contend(dataDir: string, runtimeBase: string): Promise<boolean> {
  try {
    const own = await acquireHostOwnership({ dataDir, hostKind: 'inproc', appVersion: '0.0.0-contender', listen: false, runtimeBase, liveWaitMs: 500, probeTimeoutMs: 200 })
    own.release()
    return true
  } catch (e) {
    if (e instanceof HostOwnershipError) return false
    throw e
  }
}

async function isGone(pid: number): Promise<boolean> {
  const t = await readProcessTable()
  const row = t?.get(pid)
  return row === undefined || row.zombie === true
}

describe.skipIf(process.platform === 'win32')('shutdown with a real owner process (cli-standalone.md 4.3)', () => {
  it('(b) a writer still in flight when the shutdown starts: no contender owns the folder before it wrote', async () => {
    const { dataDir, runtimeBase } = folder()
    const owner = startOwner({ FIXTURE_DATA_DIR: dataDir, FIXTURE_MODE: 'late', FIXTURE_WRITER_MS: '1500', FIXTURE_RUNTIME_BASE: runtimeBase })
    await owner.next('ready')
    expect(await contend(dataDir, runtimeBase)).toBe(false)
    owner.child.kill('SIGTERM')
    let acquiredAt: number | undefined
    const end = Date.now() + 20_000
    while (acquiredAt === undefined && Date.now() < end) {
      if (await contend(dataDir, runtimeBase)) acquiredAt = Date.now()
      else await new Promise((r) => setTimeout(r, 50))
    }
    expect(acquiredAt).toBeDefined()
    const written = await owner.next('written')
    // The contender got the folder only after the write had landed (and the file is there, complete).
    expect(existsSync(join(dataDir, 'written.txt'))).toBe(true)
    expect(Number(readFileSync(join(dataDir, 'written.txt'), 'utf8'))).toBeLessThanOrEqual(acquiredAt!)
    expect(written.receivedAt as number).toBeLessThanOrEqual(acquiredAt!)
    const released = await owner.next('released')
    expect(released).toMatchObject({ reason: 'signal', forced: true, hardLimit: false })
    expect(await owner.exited).toBe(0)
  }, 60_000)

  it('(c) a writer that hangs past the hard limit plus a git child and hook that ignore SIGTERM: taken only after they died and the owner exited', async () => {
    const { dataDir, runtimeBase } = folder()
    const owner = startOwner({ FIXTURE_DATA_DIR: dataDir, FIXTURE_MODE: 'hang', FIXTURE_HARD_LIMIT_MS: '1500', FIXTURE_RUNTIME_BASE: runtimeBase })
    const ready = await owner.next('ready')
    const [git, hook] = ready.descendants as number[]
    expect(await isGone(git)).toBe(false)
    expect(await isGone(hook)).toBe(false)
    const ownerPid = ready.pid as number
    owner.child.kill('SIGTERM')
    let taken = false
    let goneWhenTaken: boolean[] = []
    const end = Date.now() + 30_000
    while (!taken && Date.now() < end) {
      if (await contend(dataDir, runtimeBase)) {
        taken = true
        // Right after the contender took the folder: the owner, the git stand-in and its hook are all gone.
        goneWhenTaken = [await isGone(ownerPid), await isGone(git), await isGone(hook)]
      } else {
        // Until then the owner must still be holding on: its descendants are only killed at the hard limit.
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    expect(taken).toBe(true)
    expect(goneWhenTaken).toEqual([true, true, true])
    await owner.exited
    expect(await owner.next('exiting')).toMatchObject({ reason: 'signal', forced: true, hardLimit: true })
    expect(owner.events.some((e) => e.event === 'released')).toBe(false)
  }, 60_000)
})
