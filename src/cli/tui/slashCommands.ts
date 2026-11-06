/**
 * Slash command registry (W4-T4; cli-spec 6.1). Each command acts only through SlashContext; every argument and every
 * notice built from host data goes through sanitizeTty, and a command's failure becomes one danger notice (a command
 * never throws into the shell).
 */
import { runIndexMap, runName, runTag } from '../../shared/view/runLabels'
import { agentLabel, statusWordOfSummary } from '../render'
import { helpKeyLines } from './keymap'
import { sanitizeTty } from './sanitizeTty'
import { offersRetro } from './selectors'
import { usageText } from './usageText'
import type { RunSummary } from '../../shared/types'
import type { SlashCommand, SlashContext, TuiState } from './types'

/** One line of untrusted text, sanitized, whitespace folded, at most `max` characters. */
export function cleanLine(s: string | undefined, max = 200): string {
  const t = sanitizeTty(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Free text from an argument (a prompt): sanitized, trimmed, newlines kept. */
const cleanText = (s: string): string => sanitizeTty(s).trim()

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Something went wrong.'
  return cleanLine(msg, 300) || 'Something went wrong.'
}

async function guarded(ctx: SlashContext, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    ctx.notify(errorText(err), 'danger')
  }
}

const activeSummary = (s: TuiState) => (s.activeRunId ? s.runs[s.activeRunId]?.summary : undefined)

/** The active run can be interrupted (its session is open). */
function interruptible(s: TuiState): boolean {
  const st = activeSummary(s)?.status
  return !s.readOnlyReason && (st === 'starting' || st === 'running' || st === 'idle')
}

/** The active run can be ended (End session works on paused runs too). */
function stoppable(s: TuiState): boolean {
  const st = activeSummary(s)?.status
  return !s.readOnlyReason && st !== undefined && st !== 'finished' && st !== 'error' && st !== 'stopping'
}

const canStart = (s: TuiState): boolean => !s.readOnlyReason && s.project !== undefined

/** Keys (generated from KEYMAP, so the footer hints, `?` and this text cannot drift), then the commands. */
export const HELP_TEXT = [...helpKeyLines(), '', 'Commands'].join('\n')

function helpText(): string {
  const lines = SLASH_COMMANDS.map((c) => {
    const head = `/${c.name}${c.args ? ` ${c.args}` : ''}`
    const alias = c.aliases?.length ? ` (also ${c.aliases.map((a) => `/${a}`).join(', ')})` : ''
    return `  ${head.padEnd(22)}${c.summary}${alias}`
  })
  return `${HELP_TEXT}\n${lines.join('\n')}`
}

/** The table /runs shows: R# tag, status word, title; newest last. */
export function runsTable(runs: readonly RunSummary[], projectId?: string): string {
  const own = projectId ? runs.filter((r) => r.projectId === projectId) : [...runs]
  if (own.length === 0) return 'No runs yet.'
  const idx = runIndexMap(own)
  const rows = [...own]
    .sort((a, b) => (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0))
    .map((r) => {
      const tag = runTag(idx.get(r.id))
      const status = cleanLine(statusWordOfSummary(r), 40)
      return `${tag.padEnd(6)} ${status.padEnd(24)} ${cleanLine(runName(r), 80)}`
    })
  return [`${'RUN'.padEnd(6)} ${'STATUS'.padEnd(24)} TITLE`, ...rows].join('\n')
}

const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/

/** A worktree branch from an agent name, handle or id in the followed chain, else the argument as a branch name. */
export function resolveDiffTarget(s: TuiState, arg: string): { branch: string } | { error: string } {
  const want = cleanLine(arg, 200)
  const agents = s.activeChain.flatMap((id) => Object.values(s.runs[id]?.agents ?? {}))
  const withTree = agents.filter((a) => a.worktree?.branch)
  if (!want) {
    if (withTree.length === 1) return { branch: withTree[0].worktree!.branch }
    return { error: withTree.length ? 'Name the agent or branch: /diff <branch|agent>.' : 'No agent in this run has a worktree.' }
  }
  const lower = want.toLowerCase()
  const hit =
    withTree.find((a) => a.id === want) ??
    withTree.find((a) => a.worktree!.branch === want) ??
    withTree.find((a) => (a.handle ?? '').toLowerCase() === lower) ??
    withTree.find((a) => agentLabel(a).toLowerCase() === lower) ??
    withTree.find((a) => a.name.toLowerCase() === lower)
  if (hit) return { branch: hit.worktree!.branch }
  if (BRANCH_RE.test(want)) return { branch: want }
  return { error: `"${want}" is not an agent or branch name.` }
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'help',
    aliases: ['?', 'keys'],
    summary: 'Show the keys and commands',
    run: (ctx) => guarded(ctx, () => ctx.openText('Help', helpText()))
  },
  {
    name: 'new',
    args: '[prompt]',
    summary: 'Start a new team run',
    available: canStart,
    run: (ctx, args) =>
      guarded(ctx, () => {
        const prompt = cleanText(args)
        return ctx.newRun(prompt ? { prompt } : {})
      })
  },
  {
    name: 'ask',
    args: '[prompt]',
    summary: 'Ask one assistant (no team)',
    available: canStart,
    run: (ctx, args) =>
      guarded(ctx, () => {
        const prompt = cleanText(args)
        return ctx.newRun(prompt ? { prompt, team: 'single' } : { team: 'single' })
      })
  },
  {
    name: 'runs',
    aliases: ['ls', 'history'],
    summary: "List this project's runs (pick one: Enter opens, c continues, r retrospective)",
    run: (ctx) =>
      guarded(ctx, async () => {
        const runs = await ctx.session.listRuns()
        const own = ctx.state().project?.id ? runs.filter((r) => r.projectId === ctx.state().project?.id) : runs
        if (ctx.openRuns && own.length > 0) ctx.openRuns(own)
        else await ctx.openText('Runs', runsTable(runs, ctx.state().project?.id))
      })
  },
  {
    name: 'run',
    aliases: ['switch', 'r'],
    args: '<R#|id>',
    summary: 'Follow another run',
    run: (ctx, args) =>
      guarded(ctx, async () => {
        const ref = cleanLine(args, 140)
        if (!ref) {
          ctx.notify('Give a run: /run R2 or /run <run id>.', 'warn')
          return
        }
        await ctx.switchRun(ref)
      })
  },
  {
    name: 'interrupt',
    aliases: ['int'],
    summary: 'Interrupt the running turn',
    available: interruptible,
    run: (ctx) => guarded(ctx, () => ctx.session.interrupt())
  },
  {
    name: 'stop',
    aliases: ['end'],
    summary: 'End this session (the run stops)',
    available: stoppable,
    run: (ctx) =>
      guarded(ctx, async () => {
        if (await ctx.confirm('End this session?')) await ctx.session.stop()
      })
  },
  {
    name: 'inbox',
    aliases: ['tray', 'decisions'],
    summary: 'Focus the Decision Tray',
    run: (ctx) => guarded(ctx, () => ctx.setFocus('tray'))
  },
  {
    name: 'tree',
    aliases: ['agents'],
    summary: 'Show or hide the agent tree',
    run: (ctx) => guarded(ctx, () => ctx.togglePane('tree'))
  },
  {
    name: 'fold',
    aliases: ['finished'],
    summary: 'Fold finished agents into "N done" rows, or show every agent',
    run: (ctx) =>
      guarded(ctx, () => {
        if (ctx.toggleFold) ctx.toggleFold()
        else ctx.notify('Folding is not available here.', 'warn')
      })
  },
  {
    name: 'focus',
    aliases: ['maximise', 'maximize'],
    summary: 'Maximise the transcript, or bring the panes back',
    run: (ctx) =>
      guarded(ctx, () => {
        if (ctx.toggleFocusMode) ctx.toggleFocusMode()
        else ctx.notify('Focus mode is not available here.', 'warn')
      })
  },
  {
    name: 'agent',
    aliases: ['inspect'],
    args: '<name>',
    summary: "Open an agent's inspector (facts, now, worktree, its own transcript)",
    available: (s) => s.activeRunId !== undefined,
    run: (ctx, args) =>
      guarded(ctx, () => {
        if (ctx.openAgent) ctx.openAgent(cleanLine(args, 140))
        else ctx.notify('The inspector is not available here.', 'warn')
      })
  },
  {
    name: 'usage',
    aliases: ['cost'],
    summary: 'Tokens, time and cost by agent and by role (whole conversation)',
    available: (s) => s.activeRunId !== undefined,
    run: (ctx) => guarded(ctx, () => ctx.openText('Usage', usageText(ctx.state())))
  },
  {
    name: 'retro',
    aliases: ['retrospective'],
    summary: "Org retrospective: the Architect reviews this ended run and proposes team changes",
    available: (s) => {
      const run = s.activeRunId ? s.runs[s.activeRunId] : undefined
      return !s.readOnlyReason && !!run && offersRetro(run.summary)
    },
    run: (ctx) =>
      guarded(ctx, async () => {
        if (ctx.startRetro) await ctx.startRetro()
        else ctx.notify('The Org retrospective is not available here.', 'warn')
      })
  },
  {
    name: 'plan',
    summary: 'Show or hide the plan',
    run: (ctx) => guarded(ctx, () => ctx.togglePane('plan'))
  },
  {
    name: 'worktrees',
    aliases: ['wt'],
    summary: 'Show or hide the worktrees',
    run: (ctx) => guarded(ctx, () => ctx.togglePane('worktrees'))
  },
  {
    name: 'diff',
    args: '<branch|agent>',
    summary: "Show a worktree's diff",
    run: (ctx, args) =>
      guarded(ctx, async () => {
        const target = resolveDiffTarget(ctx.state(), args)
        if ('error' in target) {
          ctx.notify(target.error, 'warn')
          return
        }
        const diff = await ctx.session.worktreeDiff(target.branch)
        const stat = sanitizeTty(diff.stat ?? '').trimEnd()
        const patch = sanitizeTty(diff.patch ?? '')
        const body = [stat, patch].filter((p) => p !== '').join('\n\n') || 'No changes.'
        await ctx.openText(`Diff ${cleanLine(target.branch, 120)}`, body)
      })
  },
  {
    name: 'app',
    aliases: ['desktop', 'open'],
    summary: 'Open this run in the desktop app',
    run: (ctx) => guarded(ctx, () => ctx.session.openInDesktop(ctx.state().activeRunId))
  },
  {
    name: 'quit',
    aliases: ['q', 'exit'],
    summary: 'Leave the terminal UI (runs keep going)',
    run: (ctx) => guarded(ctx, () => ctx.quit())
  }
]

/** `/name args` -> { name (lowercase), args (trimmed) }; null when the line is not a slash command. */
export function parseSlash(line: string): { name: string; args: string } | null {
  if (typeof line !== 'string') return null
  const m = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(line)
  if (!m) return null
  const name = m[1].toLowerCase()
  if (!/^[a-z?][a-z0-9?-]{0,31}$/.test(name)) return null
  return { name, args: (m[2] ?? '').trim() }
}

/**
 * Commands available in this state whose name or an alias starts with the query's first word ('/' optional, case
 * folded). An exact name comes first, then an exact alias, then name prefixes, then alias prefixes; ties by name.
 */
export function matchSlash(query: string, s: TuiState): SlashCommand[] {
  return matchCommands(SLASH_COMMANDS, query, s)
}

/** matchSlash over any command list (the palette's `commands`). */
export function matchCommands(commands: readonly SlashCommand[], query: string, s: TuiState): SlashCommand[] {
  const q = (query ?? '').trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase()
  const ranked: { cmd: SlashCommand; rank: number }[] = []
  for (const cmd of commands) {
    if (cmd.available && !cmd.available(s)) continue
    const aliases = cmd.aliases ?? []
    let rank = -1
    if (cmd.name === q) rank = 0
    else if (aliases.includes(q)) rank = 1
    else if (cmd.name.startsWith(q)) rank = 2
    else if (aliases.some((a) => a.startsWith(q))) rank = 3
    if (rank >= 0) ranked.push({ cmd, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || a.cmd.name.localeCompare(b.cmd.name))
  return ranked.map((r) => r.cmd)
}

/** The command a parsed line names (exact name or alias among the available ones), else undefined. */
export function findSlash(name: string, s: TuiState): SlashCommand | undefined {
  const n = name.toLowerCase()
  return matchSlash(n, s).find((c) => c.name === n || (c.aliases ?? []).includes(n))
}
