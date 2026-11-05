/**
 * `orgai` CLI entry (bundled to out/cli/orgai.mjs; the build adds the `#!/usr/bin/env node` banner). Plain Node only:
 * no desktop-shell import, ever. Wave 2 contracts stub: prints the version for --version / -V and otherwise exits 2.
 * W2-T4 replaces it with routing over commandTable.ts.
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EXIT } from './types'
import { CLI_VERSION } from './version'

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--version') || argv.includes('-V')) {
    process.stdout.write(`${CLI_VERSION}\n`)
    return EXIT.ok
  }
  process.stderr.write('orgai: the CLI is not available yet in this build.\n')
  return EXIT.usage
}

/** True when this module is the process entry (also through a symlinked bin shim). False when imported (tests). */
function isEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntry()) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      process.stderr.write(`orgai: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = EXIT.failure
    }
  )
}
