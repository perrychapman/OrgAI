/**
 * `orgai app [--run <id|R#>]` (cli-spec 6.1, 3.2(1)): open the desktop app, optionally on a run. When a host is
 * already live, the spawned app hands its argv to it (second-instance) and the running app opens or focuses a window.
 * Waits up to 10 s for a ready host. Exit 0, or 1 with the launcher's error.
 */
import { parseFlags } from '../flags'
import { emit, safeLine } from '../output'
import { openReadSource, resolveRunFromSource } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

export const APP_READY_TIMEOUT_MS = 10_000

export const runApp: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { run: { type: 'string' } })
  if (positionals.length > 0) throw new CliError(`Unexpected argument "${positionals[0]}".`, EXIT.usage)
  let run: string | undefined
  if (values.run !== undefined) {
    const src = await openReadSource(ctx, { quiet: true })
    try {
      run = (await resolveRunFromSource(ctx, src, values.run)).runId
    } finally {
      src.close()
    }
  }
  const app = ctx.launcher.resolve()
  if ('error' in app) throw new CliError(app.error, EXIT.failure)
  try {
    ctx.launcher.spawn({ headless: false, ...(run ? { run } : {}) })
  } catch (e) {
    throw new CliError(`Could not start OrgAI: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
  }
  const ready = await ctx.launcher.waitForReady({ timeoutMs: APP_READY_TIMEOUT_MS })
  if (!ready) throw new CliError(`OrgAI did not become ready within ${APP_READY_TIMEOUT_MS / 1000} s. See \`orgai daemon logs\`.`, EXIT.failure)
  emit(ctx, { opened: true, ...(run ? { runId: run } : {}), hostKind: ready.hostKind ?? null, pid: ready.pid }, () => [
    run ? `Opened OrgAI on run ${safeLine(run)}.` : 'Opened OrgAI.'
  ])
  return EXIT.ok
}
