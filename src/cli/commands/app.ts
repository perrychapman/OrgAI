/**
 * `orgai app [--run <id|R#>]` (cli-spec 6.1, 3.2(1)): open the desktop app, optionally on a run. When a host is
 * already live, the spawned app hands its argv to it (second-instance) and the running app opens or focuses a window.
 * Waits up to 10 s for a ready desktop or headless host. Exit 0, 1 with the launcher's error (or when the spawned app
 * failed or quit with an error), or 6 when a `--host inproc` host owns the data folder: the desktop app cannot open on a
 * pure-Node host (cli-spec 3.2(1)), and that host's daemon.json must never count as the app being ready.
 */
import type { DaemonInfo } from '../../shared/types'
import { parseFlags } from '../flags'
import { emit, safeLine } from '../output'
import { openReadSource, resolveRunFromSource } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

export const APP_READY_TIMEOUT_MS = 10_000

/** The hosts a desktop launch can end up in: its own, or a running app that took the hand-off. */
const APP_HOST_KINDS = ['desktop', 'headless-host'] as const

export function inprocOwnerMessage(pid: number): string {
  return `A terminal host started with --host inproc (pid ${pid}) owns this data folder, so the desktop app cannot open on it. Stop that host (Ctrl+C in its terminal, or \`orgai daemon stop\`), then run \`orgai app\` again.`
}

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
  const owner = ctx.launcher.current()
  if (owner?.hostKind === 'inproc') throw new CliError(inprocOwnerMessage(owner.pid), EXIT.hostBusy)
  const app = ctx.launcher.resolve()
  if ('error' in app) throw new CliError(app.error, EXIT.failure)
  let ready: DaemonInfo | null
  try {
    ctx.launcher.spawn({ headless: false, ...(run ? { run } : {}) })
    ready = await ctx.launcher.waitForReady({ timeoutMs: APP_READY_TIMEOUT_MS, hostKinds: APP_HOST_KINDS })
  } catch (e) {
    throw new CliError(`Could not start OrgAI: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
  }
  if (!ready) {
    // An inproc host that took the data folder meanwhile is why the app gave up.
    const now = ctx.launcher.current()
    if (now?.hostKind === 'inproc') throw new CliError(inprocOwnerMessage(now.pid), EXIT.hostBusy)
    throw new CliError(`OrgAI did not become ready within ${APP_READY_TIMEOUT_MS / 1000} s. See \`orgai daemon logs\`.`, EXIT.failure)
  }
  emit(ctx, { opened: true, ...(run ? { runId: run } : {}), hostKind: ready.hostKind ?? null, pid: ready.pid }, () => [
    run ? `Opened OrgAI on run ${safeLine(run)}.` : 'Opened OrgAI.'
  ])
  return EXIT.ok
}
