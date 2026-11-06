/**
 * A real owner process for shutdown.int.test.ts (cli-standalone.md 4.3 tests (b) and (c)), run with vite-node: it takes
 * ownership of FIXTURE_DATA_DIR as a 'node' host (no listener), runs the activity tracker and the shutdown coordinator
 * the way a host does, holds one leased writer, and shuts down (forced) on SIGTERM.
 *
 * - FIXTURE_MODE=late: the writer finishes FIXTURE_WRITER_MS after ready, writing `<data>/written.txt` (tmp + rename).
 * - FIXTURE_MODE=hang: the writer never finishes, and a child process standing in for git under the repo lock ignores
 *   SIGTERM and has its own child (a hook) that ignores it too; the hard limit (FIXTURE_HARD_LIMIT_MS) must end them.
 *
 * Prints one JSON line per event on stdout: { event: 'ready', pid, descendants }, { event: 'released', ... }.
 * Not a test; never imported by the app.
 */
import { spawn } from 'node:child_process'
import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HostActivityTracker } from '../activity'
import { acquireHostOwnership } from '../ownership'
import { ShutdownCoordinator, installShutdownSignals, killHostDescendants, trackChildProcess } from '../shutdown'

const out = (v: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(v)}\n`)
const log = (m: string): void => void process.stderr.write(`[fixture] ${m}\n`)

const IGNORE_TERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
const GIT_STAND_IN = `const { spawn } = require('node:child_process'); const hook = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORE_TERM)}], { stdio: 'ignore' }); console.log(hook.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`

async function main(): Promise<void> {
  const dataDir = process.env.FIXTURE_DATA_DIR
  if (!dataDir) throw new Error('FIXTURE_DATA_DIR is required')
  const mode = process.env.FIXTURE_MODE === 'hang' ? 'hang' : 'late'
  const writerMs = Number(process.env.FIXTURE_WRITER_MS ?? '1500')
  const hardLimitMs = Number(process.env.FIXTURE_HARD_LIMIT_MS ?? '60000')
  const runtimeBase = process.env.FIXTURE_RUNTIME_BASE

  const ownership = await acquireHostOwnership({ dataDir, hostKind: 'node', appVersion: '0.0.0-fixture', listen: false, ...(runtimeBase ? { runtimeBase } : {}) })
  process.on('exit', () => ownership.release())
  const coordinator = new ShutdownCoordinator({
    release: () => ownership.release(),
    hardLimitMs,
    killDescendants: () => killHostDescendants({ termGraceMs: 300, stepMs: 100, waitMs: 5_000, log }),
    onReleased: (info) => {
      out({ event: 'released', ...info })
      process.exit(0)
    },
    exitAtHardLimit: (info) => {
      out({ event: 'exiting', ...info })
      process.exit(0)
    },
    log
  })
  const activity = new HostActivityTracker({ ownership, settleLogMs: 200, settlePollMs: 20, log, ...coordinator.activityHooks() })
  coordinator.attachActivity(activity)
  installShutdownSignals(coordinator, { log })

  // The writer, leased like an RPC mutation.
  const release = activity.acquire('inFlightRpcMutations', 'fixture write')
  const descendants: number[] = []
  if (mode === 'late') {
    setTimeout(() => {
      const file = join(dataDir, 'written.txt')
      writeFileSync(`${file}.tmp`, String(Date.now()))
      renameSync(`${file}.tmp`, file)
      out({ event: 'written', at: Date.now() })
      release()
    }, writerMs)
  } else {
    const git = spawn(process.execPath, ['-e', GIT_STAND_IN], { stdio: ['ignore', 'pipe', 'ignore'] })
    trackChildProcess(git, 'git')
    const hook = await new Promise<number>((resolve) => git.stdout.once('data', (d) => resolve(Number(String(d).trim()))))
    descendants.push(git.pid!, hook)
  }
  out({ event: 'ready', pid: process.pid, descendants })
  setInterval(() => {}, 1_000)
}

main().catch((e: unknown) => {
  log(`failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
  process.exit(2)
})
