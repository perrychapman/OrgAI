/**
 * `orgai app [--run <id|R#>]` (cli-spec 6.1, 3.2(1)): open the desktop app, optionally on a run. When a host is
 * already live, the spawned app hands its argv to it (second-instance) and the running app opens or focuses a window.
 * Waits up to 10 s for a ready desktop or headless host. Exit 0, or 1 with the launcher's error (or when the spawned app
 * failed or quit with an error).
 *
 * Wave 7 (cli-standalone.md 4.4 step 7): when a pure-Node host owns the data folder (a `node` background host or a
 * `--host inproc` command), the app is launched and the command returns 0 at once with HANDOFF_OPENED_MESSAGE: the app
 * takes over only after that host's process has exited (it asks a Node host to hand over and shows its own wait
 * window), so waiting 10 s for a ready desktop host would only time out. That host's daemon.json never counts as the
 * app being ready.
 */
import type { DaemonInfo, HostKind } from '../../shared/types'
import { parseFlags } from '../flags'
import { emit, safeLine } from '../output'
import { openReadSource, resolveRunFromSource } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'

export const APP_READY_TIMEOUT_MS = 10_000

/** The hosts a desktop launch can end up in: its own, or a running app that took the hand-off. */
const APP_HOST_KINDS = ['desktop', 'headless-host'] as const

/** The owners the app opens beside and waits for (4.4): pure-Node hosts it cannot open on. */
const HANDOFF_OWNER_KINDS: readonly HostKind[] = ['node', 'inproc']

/** What `orgai app` prints when a Node or inproc host owns the data folder (cli-standalone.md 4.4 step 7). */
export const HANDOFF_OPENED_MESSAGE = 'OrgAI opened; it takes over once the background host stops (see its window).'

const handoffOwner = (owner: DaemonInfo | null): owner is DaemonInfo =>
  !!owner && owner.hostKind !== undefined && HANDOFF_OWNER_KINDS.includes(owner.hostKind)

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
  const app = ctx.launcher.resolve()
  if ('error' in app) throw new CliError(app.error, EXIT.failure)
  const opened = (o: DaemonInfo): number => {
    emit(ctx, { opened: true, waitingForHandoff: true, ...(run ? { runId: run } : {}), owner: { hostKind: o.hostKind ?? null, pid: o.pid } }, () => [HANDOFF_OPENED_MESSAGE])
    return EXIT.ok
  }
  if (handoffOwner(owner)) {
    // The app hands over from (or waits for) this host itself and shows its own window; nothing to wait for here.
    try {
      ctx.launcher.spawn({ headless: false, ...(run ? { run } : {}) })
    } catch (e) {
      throw new CliError(`Could not start OrgAI: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
    }
    return opened(owner)
  }
  let ready: DaemonInfo | null
  try {
    ctx.launcher.spawn({ headless: false, ...(run ? { run } : {}) })
    ready = await ctx.launcher.waitForReady({ timeoutMs: APP_READY_TIMEOUT_MS, hostKinds: APP_HOST_KINDS })
  } catch (e) {
    throw new CliError(`Could not start OrgAI: ${e instanceof Error ? e.message : String(e)}`, EXIT.failure)
  }
  if (!ready) {
    // A Node or inproc host that took the data folder meanwhile is why no desktop host became ready: the app is
    // waiting for it in its own window.
    const now = ctx.launcher.current()
    if (handoffOwner(now)) return opened(now)
    throw new CliError(`OrgAI did not become ready within ${APP_READY_TIMEOUT_MS / 1000} s. See \`orgai daemon logs\`.`, EXIT.failure)
  }
  emit(ctx, { opened: true, ...(run ? { runId: run } : {}), hostKind: ready.hostKind ?? null, pid: ready.pid }, () => [
    run ? `Opened OrgAI on run ${safeLine(run)}.` : 'Opened OrgAI.'
  ])
  return EXIT.ok
}
