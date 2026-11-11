/**
 * TUI commands (cli-spec 5, 6.1): `orgai tui [--run <ref>]` (a saved run), bare `orgai` / `orgai [--] <prompt>`
 * and `orgai resume [ref] [--prompt <text>]` without --exec. Never statically imports react, ink or any ../tui/*.tsx:
 * the TUI is reached only through `await import('../tui/index')` (the out/cli/tui.mjs chunk; lazyTui.test.ts).
 *
 * Checks before any host starts: a terminal on both ends, and the managed agent worktree guard (cli-spec 4.2): starting
 * or continuing a run there is exit 2 naming the main checkout; `tui --run` opens read-only. What to open is
 * resolved once the TUI is connected (`prepare`): run refs through the live host, else the folder's project, else the
 * folder onboarding.
 */
import { isOpenStatus } from '../../shared/view/runChains'
import type { Project, RunOverrides, RunSummary, RunTeam } from '../../shared/types'
import { quietInproc } from '../context'
import { parseFlags } from '../flags'
import { liveSource, resolveRunFromSource } from '../runRef'
import { execRunFlags, interactiveOverrides } from '../runStartFlags'
import type { TuiHostConnection, TuiLaunch } from '../tui/types'
import { CliError, EXIT, type CliContext, type CommandFn, type HostCallError } from '../types'

export const NO_TTY_MESSAGE = 'The terminal UI needs a terminal; use orgai exec for scripts.'
export const PROMPT_NO_TTY_MESSAGE = 'The terminal UI needs a terminal. For scripts use: orgai exec "<prompt>"'
export const PROMPT_HINT = 'To start the terminal UI with a prompt: orgai -- "<prompt>"'

const usage = (message: string): CliError => new CliError(message, EXIT.usage)

export const worktreeRefusal = (mainCheckout: string): string =>
  `This folder is an OrgAI agent worktree. Start or continue runs from the main checkout: ${mainCheckout}`
export const worktreeReadOnly = (mainCheckout: string): string =>
  `This folder is an agent worktree; continue runs from the main checkout: ${mainCheckout}`

const TUI_FLAGS = {
  inline: { type: 'boolean' },
  'ax-screen-reader': { type: 'boolean' }
} as const

export interface TuiFlags {
  inline: boolean
  screenReader: boolean
}

const flagsOf = (v: { inline?: boolean; 'ax-screen-reader'?: boolean }): TuiFlags => ({ inline: v.inline === true, screenReader: v['ax-screen-reader'] === true })

export const hasTty = (ctx: CliContext): boolean => ctx.io.stdinIsTTY && ctx.io.stdout.isTTY === true

function requireTty(ctx: CliContext): void {
  if (!hasTty(ctx)) throw usage(NO_TTY_MESSAGE)
}

/** A host RPC failure as a CliError: a refused input is a usage error, anything else exit 1. */
function hostFailure(e: unknown): CliError {
  if (e instanceof CliError) return e
  const data = (e as Partial<HostCallError>)?.data
  return new CliError(e instanceof Error ? e.message : String(e), data?.code === 'bad_request' ? EXIT.usage : EXIT.failure)
}

/** The managed agent worktree cwd is in (cli-spec 4.2), unless --project names the project. */
export const managedOf = (ctx: CliContext): { mainCheckout: string } | undefined =>
  ctx.globals.project === undefined ? ctx.resolveProject([]).managedWorktree : undefined

/** Starting or continuing a run from an agent worktree is refused (exit 2). */
function refuseManaged(ctx: CliContext): void {
  const m = managedOf(ctx)
  if (m) throw usage(worktreeRefusal(m.mainCheckout))
}

/** Hand off to the lazily loaded TUI (quietInproc first). Shared with commands/interactive.ts. */
export async function launchTui(ctx: CliContext, flags: TuiFlags, prepare: (conn: TuiHostConnection) => Promise<TuiLaunch>): Promise<number> {
  quietInproc(ctx)
  const { runTui } = await import('../tui/index')
  return runTui(ctx, {}, flags, { prepare })
}

/** The folder's project, else onboarding (no run asked for). */
export async function prepareFolder(ctx: CliContext, conn: TuiHostConnection, extra: Pick<TuiLaunch, 'prompt' | 'team' | 'overrides'> = {}): Promise<TuiLaunch> {
  const projects = await conn.projects().catch((e: unknown) => {
    throw hostFailure(e)
  })
  const res = ctx.resolveProject(Array.isArray(projects) ? projects : [])
  if (res.error) throw usage(res.error)
  if (res.managedWorktree) throw usage(worktreeRefusal(res.managedWorktree.mainCheckout))
  if (res.project) return { project: res.project, ...extra }
  return { onboarding: { folder: ctx.cwd }, ...extra }
}

async function resolveRun(ctx: CliContext, conn: TuiHostConnection, ref: string): Promise<{ runId: string; project?: Project; managed?: { mainCheckout: string } }> {
  const r = await resolveRunFromSource(ctx, liveSource(conn.client), ref).catch((e: unknown) => {
    throw hostFailure(e)
  })
  const run = r.runs.find((x) => x.id === r.runId)
  const project = run ? r.projects.find((p) => p.id === run.projectId) : undefined
  const managed = r.resolution.managedWorktree ?? managedOf(ctx)
  return { runId: r.runId, ...(project ? { project } : {}), ...(managed ? { managed } : {}) }
}

/** A run ref through the live host: the run and its project; read-only in an agent worktree. */
export async function prepareRun(ctx: CliContext, conn: TuiHostConnection, ref: string): Promise<TuiLaunch> {
  const { runId, project, managed } = await resolveRun(ctx, conn, ref)
  return { runId, ...(project ? { project } : {}), ...(managed ? { readOnlyReason: worktreeReadOnly(managed.mainCheckout) } : {}) }
}

/** The ref for `orgai resume` without one: the project's newest ended run. */
export async function prepareResume(ctx: CliContext, conn: TuiHostConnection, ref: string | undefined, resumeText: string | undefined): Promise<TuiLaunch> {
  const extra = resumeText !== undefined ? { resumeText } : {}
  if (ref !== undefined) {
    const { runId, project, managed } = await resolveRun(ctx, conn, ref)
    if (managed) throw usage(worktreeRefusal(managed.mainCheckout))
    return { runId, ...(project ? { project } : {}), ...extra }
  }
  const src = liveSource(conn.client)
  const projects: Project[] = await src.projects().catch((e: unknown) => {
    throw hostFailure(e)
  })
  const res = ctx.resolveProject(projects)
  if (res.error) throw usage(res.error)
  if (res.managedWorktree) throw usage(worktreeRefusal(res.managedWorktree.mainCheckout))
  if (!res.project) throw usage('This folder is not an OrgAI project; give a run id, or pass --project.')
  const runs: RunSummary[] = await src.runs(res.project.id).catch((e: unknown) => {
    throw hostFailure(e)
  })
  const ended = runs.find((r) => !isOpenStatus(r.status))
  if (!ended) throw usage('This project has no ended run to resume.')
  return { project: res.project, runId: ended.id, ...extra }
}

// ---------- orgai tui ----------

export const runTuiCommand: CommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { ...TUI_FLAGS, run: { type: 'string' } })
  const USE = 'Use: orgai tui [<run> | --run <runId-or-R#>] [--inline] [--ax-screen-reader]'
  if (positionals.length > 1 || (positionals.length === 1 && values.run !== undefined)) throw usage(USE)
  requireTty(ctx)
  const ref = values.run ?? positionals[0]
  if (ref === undefined) {
    refuseManaged(ctx)
    return launchTui(ctx, flagsOf(values), (conn) => prepareFolder(ctx, conn))
  }
  return launchTui(ctx, flagsOf(values), (conn) => prepareRun(ctx, conn, ref))
}

// ---------- bare orgai / orgai [--] <prompt> ----------

/**
 * `orgai` and `orgai [--inline] [--ax-screen-reader] [--team default|single] [--] <prompt>`. Without a terminal and
 * without a prompt this prints `help()` (today's behaviour); a prompt without a terminal is exit 2 pointing at exec.
 * Before `--`, a prompt must contain whitespace (one bare word is a mistyped command).
 */
export function parseDefaultTuiArgs(args: string[]): { flags: TuiFlags; prompt: string; team?: RunTeam; overrides?: RunOverrides } {
  const dashed = args.includes('--')
  const { values, positionals } = parseFlags(args, { ...execRunFlags(), ...TUI_FLAGS, team: { type: 'string' } })
  // Exec's run flags for the first run (cli-parity 3.5), validated by exec's own parser; headless-only ones are refused.
  const overrides = interactiveOverrides(values as Record<string, unknown>)
  const team = values.team
  if (team !== undefined && team !== 'default' && team !== 'single') throw usage('--team must be one of default, single.')
  const prompt = positionals.join(' ')
  if (!dashed && prompt && !/\s/.test(prompt.trim())) throw usage(`Unknown command '${prompt}'. ${PROMPT_HINT}`)
  if (team !== undefined && !prompt.trim()) throw usage('--team applies to a prompt: orgai --team single -- "<prompt>"')
  return { flags: flagsOf(values), prompt, ...(team ? { team: team as RunTeam } : {}), ...(overrides ? { overrides } : {}) }
}

/**
 * True when bare `orgai` only prints help: no terminal on both ends and no prompt. index.ts checks it before it builds
 * the context, so the secret-env refusal and scrub never run just to print help.
 */
export function defaultTuiPrintsHelp(io: Pick<CliContext['io'], 'stdinIsTTY' | 'stdout'>, args: string[]): boolean {
  if (io.stdinIsTTY && io.stdout.isTTY === true) return false
  return !parseDefaultTuiArgs(args).prompt.trim()
}

export async function runDefaultTui(ctx: CliContext, args: string[], opts: { help?: () => string } = {}): Promise<number> {
  const { flags, prompt, team, overrides } = parseDefaultTuiArgs(args)
  if (!hasTty(ctx)) {
    if (!prompt.trim()) {
      if (opts.help) ctx.io.stdout.write(`${opts.help()}\n`)
      return EXIT.ok
    }
    throw usage(PROMPT_NO_TTY_MESSAGE)
  }
  refuseManaged(ctx)
  const extra: Pick<TuiLaunch, 'prompt' | 'team' | 'overrides'> = { ...(prompt.trim() ? { prompt, ...(team ? { team } : {}) } : {}), ...(overrides ? { overrides } : {}) }
  return launchTui(ctx, flags, (conn) => prepareFolder(ctx, conn, extra))
}

// ---------- orgai resume (no --exec) ----------

/** `orgai resume [ref] [--prompt <text>] [--inline] [--ax-screen-reader]`: the TUI on that chain. */
export async function runResumeTui(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { ...TUI_FLAGS, prompt: { type: 'string' } })
  // `-` (positional or `--prompt -`) means stdin in `resume [ref] [--prompt <text> | -]`; only --exec reads it.
  if (positionals.includes('-') || values.prompt === '-') throw usage('Reading the message from stdin needs --exec; in the terminal UI give --prompt "<text>" or type it.')
  if (positionals.length > 1) throw usage('Use: orgai resume [runId-or-R#] [--prompt <text>]')
  const text = values.prompt
  if (text !== undefined && !text.trim()) throw usage('Give a message to continue with: --prompt "<text>".')
  requireTty(ctx)
  refuseManaged(ctx)
  const ref = positionals[0]
  return launchTui(ctx, flagsOf(values), (conn) => prepareResume(ctx, conn, ref, text))
}
