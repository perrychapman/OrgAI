/**
 * The paused-run actions of `orgai resume` (cli-parity 3.5, I8):
 *
 * - `orgai resume <run> --now`: `runs:resumeNow` (operate), then the terminal UI follows the resumed run. The call is
 *   made once the TUI is connected and before it draws (`prepare`), so a refusal prints like any command error.
 * - `orgai resume <run> --cancel-auto-resume`: `runs:cancelAutoResume` (operate); text or `--output-format json`.
 *
 * A run is paused only inside the orgai process that ran it (cli-standalone-default.md: no run lives behind the
 * scenes; a new host ends the pause of every saved run). From another terminal the host therefore answers "Run is not
 * paused"; that answer is printed as the host wrote it, with a hint to continue the run instead. In the TUI that owns
 * the run, /resume-now and /cancel-resume do the same (slashCommands.ts).
 */
import { isOpenStatus } from '../../shared/view/runChains'
import type { RunRecord, RunSummary } from '../../shared/types'
import { runIndexMap, runTag } from '../../shared/view/runLabels'
import { hostCall, hostError, withHost } from '../manage'
import { emit, safeLine } from '../output'
import { liveSource, resolveRunFromSource } from '../runRef'
import type { TuiHostConnection, TuiLaunch } from '../tui/types'
import { CliError, EXIT, type CliContext } from '../types'
import { hasTty, launchTui, managedOf, prepareRun, worktreeRefusal } from './tui'

export const PAUSED_ACTION_FLAGS = ['now', 'cancel-auto-resume'] as const

const usage = (message: string): CliError => new CliError(message, EXIT.usage)

/** The hint after a refusal for a run that is not paused (any more). */
export function notPausedHint(run: Pick<RunSummary, 'status'> | undefined, tag: string): string {
  if (!run) return ''
  if (run.status === 'paused') return ''
  if (isOpenStatus(run.status)) return ` ${tag} is not paused; it is still open.`
  return ` ${tag} is not paused any more (a pause lasts while the orgai that ran it is open). Continue it with: orgai resume ${tag}`
}

/** Checks shared by both actions: exactly one run, no other resume flags. */
function checkArgs(values: Record<string, unknown>, positionals: string[], flag: string): string {
  const other = Object.keys(values).find((k) => values[k] !== undefined && !(['inline', 'ax-screen-reader'] as string[]).concat(flag).includes(k))
  if (other) throw usage(`--${other} does not apply with --${flag}.`)
  if (positionals.length !== 1 || positionals[0] === '-') throw usage(`Use: orgai resume <runId-or-R#> --${flag}`)
  return positionals[0]
}

/** `orgai resume <run> --now | --cancel-auto-resume` (exec.ts runResume hands these over before anything else). */
export async function runPausedAction(ctx: CliContext, values: Record<string, unknown>, positionals: string[]): Promise<number> {
  if (values.now === true && values['cancel-auto-resume'] === true) throw usage('Use --now or --cancel-auto-resume, not both.')
  if (values.now === true) {
    const ref = checkArgs(values, positionals, 'now')
    if (!hasTty(ctx)) throw usage('--now follows the resumed run in the terminal UI, which needs a terminal.')
    const managed = managedOf(ctx)
    if (managed) throw usage(worktreeRefusal(managed.mainCheckout))
    return launchTui(ctx, { inline: values.inline === true, screenReader: values['ax-screen-reader'] === true }, (conn) => prepareResumeNow(ctx, conn, ref))
  }
  const ref = checkArgs(values, positionals, 'cancel-auto-resume')
  if (values.inline !== undefined || values['ax-screen-reader'] !== undefined) throw usage('--inline and --ax-screen-reader apply to the terminal UI, not to --cancel-auto-resume.')
  return withHost(ctx, ['read', 'operate'], async (client) => {
    const r = await resolveRunFromSource(ctx, liveSource(client), ref).catch((e: unknown) => {
      throw hostError(e)
    })
    const rec = await hostCall<RunRecord | null>(client, 'runs:get', [r.runId])
    const run = rec?.summary
    const tag = tagOf(r.runs, run, r.runId)
    if (!run) throw new CliError(`Run ${safeLine(r.runId)} is not available.`, EXIT.failure)
    if (run.status !== 'paused') throw new CliError(`Run is not paused.${notPausedHint(run, tag)}`, EXIT.failure)
    const had = run.autoResume === true
    await hostCall<void>(client, 'runs:cancelAutoResume', [run.id])
    emit(ctx, { runId: run.id, tag, status: 'paused', autoResume: false, cancelled: had }, () =>
      had ? `${tag} stays paused; it will not resume by itself. Resume it with: orgai resume ${tag} --now` : `${tag} was not set to resume by itself; it stays paused.`
    )
    return EXIT.ok
  })
}

function tagOf(runs: readonly RunSummary[], run: RunSummary | undefined, runId: string): string {
  const list = run ? runs.filter((x) => x.projectId === run.projectId) : [...runs]
  const all = run && !list.some((x) => x.id === run.id) ? [...list, run] : list
  return runTag(runIndexMap(all).get(runId))
}

/** TUI prepare for --now: resolve the run, resume it (the host's refusal is the error), follow the resumed run. */
export async function prepareResumeNow(ctx: CliContext, conn: TuiHostConnection, ref: string): Promise<TuiLaunch> {
  const launch = await prepareRun(ctx, conn, ref)
  if (launch.readOnlyReason) throw usage(launch.readOnlyReason)
  const runId = launch.runId as string
  let before: RunSummary | undefined
  try {
    before = (await conn.client.call<RunRecord | null>('runs:get', [runId]))?.summary
  } catch {
    before = undefined
  }
  let resumed: RunSummary
  try {
    resumed = await conn.client.call<RunSummary>('runs:resumeNow', [runId])
  } catch (e) {
    const err = hostError(e)
    const runs = before ? await liveSource(conn.client).runs(before.projectId).catch(() => [] as RunSummary[]) : []
    const hint = notPausedHint(before, tagOf(runs, before, runId))
    throw new CliError(hint && !/[.!?]$/.test(err.message) ? `${err.message}.${hint}` : `${err.message}${hint}`, err.exitCode)
  }
  if (!resumed || typeof resumed.id !== 'string') throw new CliError('The OrgAI host did not return the resumed run.', EXIT.failure)
  return { ...launch, runId: resumed.id }
}
