/**
 * cli-standalone.md 4.3 test (c) for the `--host inproc` owner, with a real owner process: testFixtures/inprocOwner.ts
 * runs startInprocHost under vite-node with a writer that never finishes and a git stand-in (plus its hook) that
 * ignore SIGTERM; this test is the racing contender. The CLI never calls process.exit itself, so before review round 1
 * the inproc host released the data folder at the hard limit while its hung writer could still write; now the default
 * exitAtHardLimit ends the process and only its exit hook releases. POSIX only (the Windows process table and taskkill
 * paths are not exercised here).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostOwnershipError, acquireHostOwnership } from '../main/host/ownership'
import { readProcessTable } from '../main/host/shutdown'
import { INPROC_HARD_LIMIT_MESSAGE } from './inprocHost'

const ROOT = resolve(__dirname, '..', '..')
const VITE_NODE = join(ROOT, 'node_modules', 'vite-node', 'vite-node.mjs')
const CONFIG = join(ROOT, 'vitest.config.ts')
const FIXTURE = join(__dirname, 'testFixtures', 'inprocOwner.ts')

const dirs: string[] = []
const kids: ChildProcess[] = []
const strays: number[] = []
afterEach(() => {
  for (const k of kids.splice(0)) if (k.exitCode === null) k.kill('SIGKILL')
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function isGone(pid: number): Promise<boolean> {
  const t = await readProcessTable()
  const row = t?.get(pid)
  return row === undefined || row.zombie === true
}

async function contend(dataDir: string): Promise<boolean> {
  try {
    const own = await acquireHostOwnership({ dataDir, hostKind: 'inproc', appVersion: '0.0.0-contender', listen: false, liveWaitMs: 500, probeTimeoutMs: 200 })
    own.release()
    return true
  } catch (e) {
    if (e instanceof HostOwnershipError) return false
    throw e
  }
}

describe.skipIf(process.platform === 'win32')('the in-process host at the shutdown hard limit (cli-standalone.md 4.3 (c))', () => {
  it('exits (code 1, told on stderr) after killing its descendants; a contender owns the folder only after the process exited', async () => {
    // Short paths: the host's per-instance socket lives under <data>/run.
    const userDataDir = realpathSync(mkdtempSync(join('/tmp', 'orgai-iph-')))
    dirs.push(userDataDir)
    const dataDir = join(userDataDir, 'data')
    const child = spawn(process.execPath, [VITE_NODE, '--config', CONFIG, FIXTURE], {
      cwd: ROOT,
      env: { ...process.env, FIXTURE_USER_DATA_DIR: userDataDir, FIXTURE_HARD_LIMIT_MS: '1500' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    kids.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (d) => void (stdout += String(d)))
    child.stderr!.on('data', (d) => void (stderr += String(d)))
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))
    const ready = await (async () => {
      const end = Date.now() + 45_000
      for (;;) {
        const line = stdout.split('\n').find((l) => l.includes('"ready"'))
        if (line) return JSON.parse(line) as { pid: number; descendants: number[] }
        if (child.exitCode !== null) throw new Error(`the owner exited before ready: ${stderr}`)
        if (Date.now() > end) throw new Error(`timed out waiting for ready: ${stderr}`)
        await new Promise((r) => setTimeout(r, 25))
      }
    })()
    const [git, hook] = ready.descendants
    strays.push(git, hook)
    expect(await isGone(git)).toBe(false)
    expect(await isGone(hook)).toBe(false)
    expect(await contend(dataDir)).toBe(false)

    child.kill('SIGTERM')
    let taken = false
    let goneWhenTaken: boolean[] = []
    const end = Date.now() + 30_000
    while (!taken && Date.now() < end) {
      if (await contend(dataDir)) {
        taken = true
        goneWhenTaken = [child.exitCode !== null || child.signalCode !== null || (await isGone(ready.pid)), await isGone(git), await isGone(hook)]
      } else {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    expect(taken).toBe(true)
    // The folder was free only once the owner process had exited and both descendants were gone.
    expect(goneWhenTaken).toEqual([true, true, true])
    expect(await exited).toBe(1)
    expect(stderr).toContain(INPROC_HARD_LIMIT_MESSAGE)
    // Never the normal path: the stop that a CLI command awaits never resolved (the process ended first).
    expect(stdout).not.toContain('"stopped"')
  }, 90_000)
})
