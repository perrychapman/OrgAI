/**
 * A real `--host inproc` owner for inprocShutdown.int.test.ts (cli-standalone.md 4.3 test (c) for the inproc host), run
 * with vite-node: startInprocHost (mock, no background work) on FIXTURE_USER_DATA_DIR with the shutdown's hard limit
 * shortened to FIXTURE_HARD_LIMIT_MS, one writer that never finishes (a worktree operation behind another process's
 * repo lock), and a child standing in for git that ignores SIGTERM and has a hook child that ignores it too. On SIGTERM
 * it stops the host with force, as a CLI command's cleanup does; the default exitAtHardLimit (inprocHardLimitExit)
 * must then end the process. Prints { event: 'ready', pid, descendants } on stdout. Not a test; never imported by the app.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { startInprocHost } from '../inprocHost'

const out = (v: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(v)}\n`)
const log = (m: string): void => void process.stderr.write(`[fixture] ${m}\n`)

const IGNORE_TERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
const GIT_STAND_IN = `const { spawn } = require('node:child_process'); const hook = spawn(process.execPath, ['-e', ${JSON.stringify(IGNORE_TERM)}], { stdio: 'ignore' }); console.log(hook.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`

async function main(): Promise<void> {
  const userDataDir = process.env.FIXTURE_USER_DATA_DIR
  if (!userDataDir) throw new Error('FIXTURE_USER_DATA_DIR is required')
  const hardLimitMs = Number(process.env.FIXTURE_HARD_LIMIT_MS ?? '1500')
  const h = await startInprocHost({
    userDataDir,
    dataDir: join(userDataDir, 'data'),
    env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' },
    mock: true,
    overlay: new Map(),
    logging: false,
    startBackground: false,
    shutdownLimits: { hardLimitMs, kill: { termGraceMs: 300, stepMs: 100, waitMs: 5_000 } }
  })
  // The writer that never finishes, leased as the repo lock source would count it. Like a real wait for another
  // process's repo lock it polls, which keeps the event loop (and so the process) alive.
  h.host.activity.acquire('activeWorktreeOps', 'git behind another process lock')
  setInterval(() => {}, 200)
  const git = spawn(process.execPath, ['-e', GIT_STAND_IN], { stdio: ['ignore', 'pipe', 'ignore'] })
  const hook = await new Promise<number>((resolve) => git.stdout.once('data', (d) => resolve(Number(String(d).trim()))))
  process.on('SIGTERM', () => {
    log('SIGTERM: stopping the in-process host with force')
    h.stop(true).then(
      () => out({ event: 'stopped' }),
      (e: unknown) => log(`stop failed: ${e instanceof Error ? e.message : String(e)}`)
    )
  })
  out({ event: 'ready', pid: process.pid, descendants: [git.pid, hook] })
}

main().catch((e: unknown) => {
  log(`failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
  process.exit(2)
})
