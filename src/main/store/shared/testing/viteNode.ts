/**
 * Test helper: run a TypeScript file in a child process through the vite-node CLI, started with `process.execPath`.
 *
 * Never spawn `node_modules/.bin/vite-node`: on Windows that name is a POSIX shell shim (node parses it as JavaScript
 * and fails with "SyntaxError: missing ) after argument list"), and the `.cmd` shim cannot be spawned without a shell.
 * The CLI file is resolved through the package instead: `vite-node/cli` (vite-node 6, `dist/cli.mjs`) first, then
 * `vite-node/vite-node.mjs` (vite-node 3). Paths always go through argv, never into generated source.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let cached: string | null = null

/** The absolute path of the vite-node CLI entry for this install. */
export function viteNodeCli(): string {
  if (cached) return cached
  const errors: string[] = []
  for (const spec of ['vite-node/cli', 'vite-node/vite-node.mjs']) {
    try {
      cached = require.resolve(spec)
      return cached
    } catch (e) {
      errors.push(`${spec}: ${(e as Error).message.split('\n')[0]}`)
    }
  }
  throw new Error(`The vite-node CLI could not be resolved (${errors.join('; ')}).`)
}

/** Spawn `node <vite-node cli> <script> ...args`. */
export function spawnViteNode(script: string, args: readonly string[] = [], opts: SpawnOptions = {}): ChildProcess {
  return spawn(process.execPath, [viteNodeCli(), script, ...args], opts)
}

/**
 * Kill every child (SIGKILL) and wait until each has exited. On Windows a child's open handle keeps its files busy
 * (EBUSY on unlink) until the process is gone, so a test's temp folder may only be removed after this resolves.
 */
export async function killAndWait(children: ChildProcess[]): Promise<void> {
  await Promise.all(
    children.splice(0).map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.exitCode !== null || c.signalCode !== null || c.pid === undefined) return resolve()
          c.once('exit', () => resolve())
          try {
            c.kill('SIGKILL')
          } catch {
            resolve()
          }
        })
    )
  )
}
