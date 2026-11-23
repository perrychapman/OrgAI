/**
 * Child process of inprocHostRace.test.ts (not a test itself): waits for the `go` file, then starts the in-process
 * host on the folder in argv and prints one JSON line: `{ started: true, pid, advertised, ms }`, or
 * `{ started: false, exitCode, ms, message }` when the start was refused. A started host stays up until its stdin
 * closes, then stops and exits 0. `--alone` starts it with `listen: true`, the way an orgai from before sessions holds
 * the folder (no other orgai may join it).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startInprocHost } from './inprocHost'
import { CliError } from './types'

const [userDataDir, goFile, mode] = process.argv.slice(2) as [string, string, string | undefined]

async function main(): Promise<void> {
  while (!existsSync(goFile)) await new Promise((r) => setTimeout(r, 2))
  const t0 = Date.now()
  try {
    const h = await startInprocHost({
      userDataDir,
      dataDir: join(userDataDir, 'data'),
      env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' },
      mock: true,
      overlay: new Map(),
      logging: true,
      startBackground: false,
      systemCertificates: false,
      // The test drives the handover itself; a short period keeps the crash case quick.
      adoptEveryMs: 200,
      ...(mode === '--alone' ? { listen: true } : {})
    })
    process.stdout.write(`${JSON.stringify({ started: true, pid: process.pid, advertised: h.ownership.advertised, ms: Date.now() - t0 })}\n`)
    process.stdin.resume()
    await new Promise<void>((r) => process.stdin.once('end', () => r()))
    await h.stop(true).catch(() => undefined)
    process.exit(0)
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ started: false, exitCode: e instanceof CliError ? e.exitCode : -1, ms: Date.now() - t0, message: e instanceof Error ? e.message : String(e) })}\n`)
    process.exit(e instanceof CliError ? e.exitCode : 1)
  }
}
void main()
