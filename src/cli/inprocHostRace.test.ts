/**
 * Real processes start the in-process host on one folder at the same moment (docs/design/cli-sessions.md).
 *
 * Sessions: both start. They register one at a time under the startup mutex, exactly one of them is the host
 * daemon.json advertises, and that record follows the sessions: handed over when the advertised one ends, taken over
 * when it is killed, gone with the last one. An orgai that holds the folder alone (as one from before sessions does)
 * still refuses a second one with exit 6, and the refused process writes nothing into the owner's log.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT } from './types'
import { listSessions } from '../main/host/sessions'
import { VITE_NODE_CLI } from '../main/host/testFixtures/viteNodeCli'
import { killAndWait } from '../main/store/shared/testing/viteNode'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const viteNode = VITE_NODE_CLI

interface Result {
  started: boolean
  pid?: number
  advertised?: boolean
  exitCode?: number
  ms?: number
  message?: string
}

interface Child {
  proc: ChildProcess
  line: Promise<Result>
  exited: Promise<number | null>
}

const children: ChildProcess[] = []
let dir = ''

function spawnChild(userDataDir: string, goFile: string, mode?: '--alone'): Child {
  const proc = spawn(process.execPath, [viteNode, '-c', join(root, 'vitest.config.ts'), join(here, 'inprocHostRace.child.ts'), userDataDir, goFile, ...(mode ? [mode] : [])], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ORGAI_CLI_VAULT_NO_OS_KEYSTORE: '1', ORGAI_VAULT_NO_OS_KEYSTORE: '1' }
  })
  children.push(proc)
  let out = ''
  let err = ''
  proc.stderr!.on('data', (d: Buffer) => (err += d.toString()))
  const line = new Promise<Result>((resolve, reject) => {
    proc.stdout!.on('data', (d: Buffer) => {
      out += d.toString()
      const m = /^(\{.*\})$/m.exec(out)
      if (m) resolve(JSON.parse(m[1]!) as Result)
    })
    proc.once('exit', () => reject(new Error(`child ended without a result: ${out} ${err}`)))
  })
  line.catch(() => undefined)
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)))
  return { proc, line, exited }
}

const daemonOf = (dataDir: string): { pid: number; sessions?: boolean; hostInstanceId: string } | undefined => {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'run', 'daemon.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Poll until `check` holds (a handover or a takeover is asynchronous for the watching process). */
async function eventually(check: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return check()
}

afterEach(async () => {
  // Wait until every child is gone before removing the folder: on Windows a process that was just killed still holds
  // its session lock file for a moment, and unlinking it then fails with EBUSY.
  await killAndWait(children)
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  dir = ''
})

describe('orgai processes starting at once on one data folder', () => {
  it('two sessions both start; one is advertised; the record is handed over when it ends and goes with the last one', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'inp-race-')))
    const goFile = join(dir, 'go')
    const userDataDir = join(dir, 'cli')
    const dataDir = join(userDataDir, 'data')
    const a = spawnChild(userDataDir, goFile)
    const b = spawnChild(userDataDir, goFile)
    // Both are loaded and polling: let them go together.
    await new Promise((r) => setTimeout(r, 4000))
    writeFileSync(goFile, 'go')
    const [ra, rb] = await Promise.all([a.line, b.line])
    expect([ra.started, rb.started]).toEqual([true, true])
    // Neither waited long for the other: the startup mutex is held for a moment, not for a session's life.
    expect(Math.max(ra.ms!, rb.ms!)).toBeLessThan(15_000)
    // Exactly one of them is the host daemon.json names, and its record says the folder is shared.
    expect([ra.advertised, rb.advertised].filter(Boolean)).toHaveLength(1)
    const first = ra.advertised ? ra : rb
    const second = ra.advertised ? rb : ra
    expect(daemonOf(dataDir)).toMatchObject({ pid: first.pid, sessions: true })
    // Both are live sessions with their own lock.
    const sessions = listSessions(dataDir)
    expect(sessions.map((s) => s.live)).toEqual([true, true])
    expect(sessions.map((s) => s.record.pid).sort()).toEqual([ra.pid, rb.pid].sort())
    // Each wrote its own start into main.log.
    const log = join(userDataDir, 'logs', 'main.log')
    expect(readFileSync(log, 'utf8').match(/starting \(/g) ?? []).toHaveLength(2)

    // The advertised session ends in order: the record names the other one at once, never nothing.
    const firstChild = ra.advertised ? a : b
    const secondChild = ra.advertised ? b : a
    firstChild.proc.stdin!.end()
    expect(await firstChild.exited).toBe(0)
    expect(daemonOf(dataDir)).toMatchObject({ pid: second.pid, sessions: true })
    expect(listSessions(dataDir).map((s) => [s.record.pid, s.live])).toEqual([[second.pid, true]])

    // The last one ends: nothing advertises the folder and no session is left.
    secondChild.proc.stdin!.end()
    expect(await secondChild.exited).toBe(0)
    expect(existsSync(join(dataDir, 'run', 'daemon.json'))).toBe(false)
    expect(listSessions(dataDir)).toEqual([])
  }, 90_000)

  it('the advertised session is killed: the survivor takes the record over and a third orgai still joins', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'inp-race-')))
    const goFile = join(dir, 'go')
    const userDataDir = join(dir, 'cli')
    const dataDir = join(userDataDir, 'data')
    writeFileSync(goFile, 'go')
    const a = spawnChild(userDataDir, goFile)
    const ra = await a.line
    const b = spawnChild(userDataDir, goFile)
    const rb = await b.line
    expect([ra.started, ra.advertised, rb.started, rb.advertised]).toEqual([true, true, true, false])
    // No cleanup at all: daemon.json still names the dead process, its session record is still there.
    const gone = new Promise<void>((r) => a.proc.once('exit', () => r()))
    a.proc.kill('SIGKILL')
    await gone
    expect(listSessions(dataDir).map((s) => [s.record.pid, s.live]).sort()).toEqual([[ra.pid, false], [rb.pid, true]].sort())
    // The survivor notices on its next check and advertises the folder itself.
    expect(await eventually(() => daemonOf(dataDir)?.pid === rb.pid)).toBe(true)
    expect(daemonOf(dataDir)).toMatchObject({ pid: rb.pid, sessions: true })
    // A third orgai joins the survivor, and its start sweeps what the killed one left.
    const c = spawnChild(userDataDir, goFile)
    const rc = await c.line
    expect([rc.started, rc.advertised]).toEqual([true, false])
    expect(listSessions(dataDir).map((s) => [s.record.pid, s.live]).sort()).toEqual([[rb.pid, true], [rc.pid, true]].sort())
  }, 90_000)

  it('an orgai that holds the folder alone refuses a second one with exit 6 at once, and its main.log is left alone', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'inp-race-')))
    const goFile = join(dir, 'go')
    const userDataDir = join(dir, 'cli')
    writeFileSync(goFile, 'go')
    const owner = spawnChild(userDataDir, goFile, '--alone')
    expect(await owner.line).toMatchObject({ started: true, advertised: true })
    // Its record does not say the folder is shared, exactly like one written by an orgai from before sessions.
    expect(daemonOf(join(userDataDir, 'data'))?.sessions).toBeUndefined()
    const second = spawnChild(userDataDir, goFile)
    const refused = await second.line
    expect(refused).toMatchObject({ started: false, exitCode: EXIT.hostBusy })
    expect(EXIT.hostBusy).toBe(6)
    expect(refused.message).toContain('orgai is already running')
    // "At once": a refusal, not a wait for the owner (which stays up) to finish.
    expect(refused.ms!).toBeLessThan(15_000)
    expect(await second.exited).toBe(EXIT.hostBusy)
    // One start in main.log: the refused process never installed logging or rotated the file.
    const log = join(userDataDir, 'logs', 'main.log')
    expect(existsSync(log)).toBe(true)
    expect(readFileSync(log, 'utf8').match(/starting \(/g) ?? []).toHaveLength(1)
    expect(existsSync(join(userDataDir, 'logs', 'main.1.log'))).toBe(false)
    // And it registered no session.
    expect(listSessions(join(userDataDir, 'data'))).toEqual([])
  }, 90_000)
})
