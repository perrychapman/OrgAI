/**
 * Slash command registry (W4-T4; cli-spec 6.1). Each command acts only through SlashContext; every argument and every
 * notice built from host data goes through sanitizeTty, and a command's failure becomes one danger notice (a command
 * never throws into the shell).
 */
import { outputsOfRun, outputsOverlayText } from '../outputsText'
import { LOG_LEVEL_WORDS, logsOverlayText, type LogLevelFilter } from '../logText'
import { runIndexMap, runName, runTag } from '../../shared/view/runLabels'
import { agentLabel, statusWordOfSummary } from '../render'
import { basename } from 'node:path'
import { helpKeyLines } from './keymap'
import { copyToClipboard, lastAssistantText, latestCodeBlock } from './clipboard'
import { CYCLE_MODES, EFFORT_WORDS, GOAL_WORDS, modeInForce, modeSwitchHint, modelSwitchBlock, pickModel as pickModelFromList, isTier } from './runControls'
import { sanitizeTty } from './sanitizeTty'
import { offersRetro } from './selectors'
import { usageText } from './usageText'
import { approvalsText } from './approvals'
import { analyzeText, applyText, historyText, parseEvolve, rollbackText } from './evolve'
import { MODEL_HANDOFF_BODY, MODEL_HANDOFF_TITLE } from '../../shared/liveModelSwitch'
import type { Effort, PermissionMode, ProviderModel, RunOverrides, RunSummary, StaffingGoal } from '../../shared/types'
import { connectionName, modelChoices, pickModel as pickModelFromCatalog } from '../modelSwitch'
import { parseSlashRunArgs } from '../runStartFlags'
import type { SlashCommand, SlashContext, TuiState } from './types'

/** One line of untrusted text, sanitized, whitespace folded, at most `max` characters. */
export function cleanLine(s: string | undefined, max = 200): string {
  const t = sanitizeTty(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  // Cut on code points so a surrogate pair (emoji, rare CJK) is never split into a lone half.
  const cps = Array.from(t)
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : t
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

const readOnlyText = (s: TuiState): string => `Read-only: ${cleanLine(s.readOnlyReason, 120)}`

function startReason(s: TuiState): string | undefined {
  if (s.readOnlyReason) return readOnlyText(s)
  return s.project ? undefined : 'Open a project folder first.'
}

function interruptReason(s: TuiState): string | undefined {
  if (s.readOnlyReason) return readOnlyText(s)
  const run = activeSummary(s)
  if (!run) return 'No run is followed. Start or follow one first.'
  return 'This run is not working right now.'
}

function stopReason(s: TuiState): string | undefined {
  if (s.readOnlyReason) return readOnlyText(s)
  const run = activeSummary(s)
  if (!run) return 'No run is followed. Start or follow one first.'
  return 'This session already ended.'
}

const needsRunReason = (): string => 'Follow a run first (/runs, or start one with /new).'

/** The followed run is paused (a usage limit) and this TUI may act on it. */
const pausedRun = (s: TuiState): boolean => !s.readOnlyReason && activeSummary(s)?.status === 'paused'

function pausedReason(s: TuiState): string | undefined {
  if (s.readOnlyReason) return readOnlyText(s)
  if (!activeSummary(s)) return needsRunReason()
  return pausedRun(s) ? undefined : 'This run is not paused.'
}

/** /new and /ask arguments: leading run flags (exec's parsers, runStartFlags.ts), then the prompt. */
function startArgs(args: string): { prompt: string; overrides?: RunOverrides } {
  const { prompt, overrides } = parseSlashRunArgs(args)
  const clean = cleanText(prompt)
  return { prompt: clean, ...(overrides ? { overrides } : {}) }
}

/** "model-id via Anthropic" for notices. */
const selectionLabel = (m: Pick<ProviderModel, 'id' | 'connection'>, name?: string): string => `${cleanLine(m.id, 120)} via ${cleanLine(name ?? m.connection, 60)}`

/** /model: no argument lists the choices (a picker when the shell has one), else resolves a tier or id and switches (or stages when no run is followed). */
async function runModel(ctx: SlashContext, args: string): Promise<void> {
  const s = ctx.state()
  const run = activeSummary(s)
  const want = cleanLine(args, 200)
  if (!run) {
    if (!ctx.session.listModels || !ctx.session.stage) {
      ctx.notify(needsRunReason(), 'warn')
      return
    }
    const staged = ctx.session.getStaged?.() ?? {}
    const current = staged.model
    if (!want) {
      const now = current ? `${cleanLine(current.model, 80)} on ${cleanLine(String(current.connection), 40)}` : "the project's default"
      ctx.notify(`Model: ${now} (for the next run). Use /model fast|everyday|deep|top|<model id>.`)
      return
    }
    const models = await ctx.session.listModels(isTier(want.toLowerCase()) ? current?.connection : undefined)
    const picked = pickModelFromList(models, want, current?.connection)
    if ('error' in picked) {
      ctx.notify(picked.error, 'warn')
      return
    }
    const label = `${cleanLine(picked.label || picked.id, 80)} (${cleanLine(picked.id, 80)})`
    ctx.session.stage({ model: { model: picked.id, connection: picked.connection } })
    ctx.notify(`The next run starts on ${label}.`)
    return
  }
  if (!ctx.session.modelCatalog && ctx.session.listModels) {
    const current = run.modelSelection
    if (!want) {
      const now = current ? `${cleanLine(current.model, 80)} on ${cleanLine(String(current.connection), 40)}` : "the project's default"
      ctx.notify(`Model: ${now}. Use /model fast|everyday|deep|top|<model id>.`)
      return
    }
    const models = await ctx.session.listModels(isTier(want.toLowerCase()) ? current?.connection : undefined)
    const picked = pickModelFromList(models, want, current?.connection)
    if ('error' in picked) {
      ctx.notify(picked.error, 'warn')
      return
    }
    const label = `${cleanLine(picked.label || picked.id, 80)} (${cleanLine(picked.id, 80)})`
    const blocked = modelSwitchBlock(s, picked)
    if (blocked) {
      ctx.notify(blocked, 'warn')
      return
    }
    const res = await ctx.session.switchModel({ model: picked.id, connection: picked.connection })
    if (res.applied) ctx.notify(`Now using ${label}.`)
    else ctx.notify(`${label} is saved for the next message.${res.reason ? ` ${cleanLine(res.reason, 200)}` : ''}`, 'warn')
    return
  }
  const catalog = await ctx.session.modelCatalog()
  let selected: ProviderModel | undefined
  if (!want) {
    const choices = modelChoices(run, catalog)
    if (!choices.length) {
      ctx.notify('No models available on connected connections.', 'warn')
      return
    }
    const current = run.modelSelection ? selectionLabel({ id: run.modelSelection.model, connection: run.modelSelection.connection }, connectionName(catalog, run.modelSelection.connection)) : 'not recorded'
    const options = choices.map((c) => ({
      value: JSON.stringify([c.connection, c.id]),
      label: cleanLine(`${c.label !== c.id ? `${c.label} (${c.id})` : c.id} · ${connectionName(catalog, c.connection)}${c.tiers.length ? ` · ${c.tiers.join(', ')}` : ''}${c.current ? ' · current' : c.handoff ? ' · ends session' : ''}`, 160)
    }))
    if (!ctx.pick) {
      await ctx.openText('Models', [`Current: ${current}`, '', ...options.map((o) => `  ${o.label}`), '', 'Switch: /model <tier|model id>'].join('\n'))
      return
    }
    const value = await ctx.pick(`Model (current: ${current})`, options)
    if (value === undefined) return
    const [connection, id] = JSON.parse(value) as [string, string]
    selected = catalog.models.find((m) => m.connection === connection && m.id === id)
  } else {
    const picked = pickModelFromCatalog(run, catalog, want)
    if ('error' in picked) {
      ctx.notify(cleanLine(picked.error, 200), 'warn')
      return
    }
    selected = picked.model
  }
  if (!selected) return
  if (run.modelSelection?.model === selected.id && run.modelSelection.connection === selected.connection) {
    ctx.notify(`Already on ${selectionLabel(selected, connectionName(catalog, selected.connection))}.`)
    return
  }
  const out = await ctx.session.switchModel(selected, { confirm: () => ctx.confirm(`${MODEL_HANDOFF_TITLE} ${MODEL_HANDOFF_BODY}`) })
  if (out.kind === 'cancelled') ctx.notify('Model unchanged.')
  else if (out.kind === 'applied') ctx.notify(`Model changed to ${selectionLabel(selected, connectionName(catalog, selected.connection))}.`)
  else ctx.notify(`Model selected for the next message: ${selectionLabel(selected, connectionName(catalog, selected.connection))}.`)
}

/**
 * /approvals (cli-parity 3.4 as built, read-only): what waits for approval, in full (the gate's summary, "May spend
 * more", what an undo would bring back, a folder's own config), ending with where approving is done and why.
 */
async function runApprovals(ctx: SlashContext): Promise<void> {
  const api = ctx.session.approvals
  if (!api) {
    ctx.notify('Approvals are not available here.', 'warn')
    return
  }
  const items = await api.list()
  if (!items.length) {
    ctx.notify('Nothing waits for approval.')
    return
  }
  await ctx.openText('Approvals', approvalsText(items))
}

function retroReason(s: TuiState): string | undefined {
  if (s.readOnlyReason) return readOnlyText(s)
  const run = activeSummary(s)
  if (!run) return 'Follow an ended work run first (/runs).'
  if (run.status !== 'finished' && run.status !== 'error') return 'The run has not ended yet. The retrospective reviews an ended run.'
  return 'Only ended team runs of a project have a retrospective, not chats or assistant runs.'
}

function commandLines(): string[] {
  return SLASH_COMMANDS.map((c) => {
    const head = `/${c.name}${c.args ? ` ${c.args}` : ''}`
    const alias = c.aliases?.length ? ` (also ${c.aliases.map((a) => `/${a}`).join(', ')})` : ''
    return `  ${head.padEnd(22)}${c.summary}${alias}`
  })
}

function helpText(): string {
  return HELP_TEXT
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
    args: '[--goal g] [--permission-mode m] [--strict-delegation] [prompt]',
    summary: 'Start a new team run',
    available: canStart,
    unavailableReason: startReason,
    run: (ctx, args) =>
      guarded(ctx, () => {
        const { prompt, overrides } = startArgs(args)
        return ctx.newRun({ ...(prompt ? { prompt } : {}), ...(overrides ? { overrides } : {}) })
      })
  },
  {
    name: 'ask',
    args: '[--goal g] [--permission-mode m] [--strict-delegation] [prompt]',
    summary: 'Ask one assistant (no team)',
    available: canStart,
    unavailableReason: startReason,
    run: (ctx, args) =>
      guarded(ctx, () => {
        const { prompt, overrides } = startArgs(args)
        return ctx.newRun({ ...(prompt ? { prompt } : {}), team: 'single', ...(overrides ? { overrides } : {}) })
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
    unavailableReason: interruptReason,
    run: (ctx) => guarded(ctx, () => ctx.session.interrupt())
  },
  {
    name: 'model',
    args: '[<tier|model id>]',
    summary: "Switch the run's model (a short list without an argument)",
    available: (s) => !s.readOnlyReason && s.activeRunId !== undefined,
    unavailableReason: (s) => (s.readOnlyReason ? readOnlyText(s) : needsRunReason()),
    run: (ctx, args) => guarded(ctx, () => runModel(ctx, args))
  },
  {
    name: 'resume-now',
    aliases: ['resumenow'],
    summary: 'Resume this run, paused for a usage limit, now',
    available: pausedRun,
    unavailableReason: pausedReason,
    run: (ctx) =>
      guarded(ctx, async () => {
        await ctx.session.resumeNow()
        ctx.notify('Resumed.')
      })
  },
  {
    name: 'cancel-resume',
    aliases: ['keep-paused'],
    summary: 'Keep this paused run paused (no automatic resume)',
    available: (s) => pausedRun(s) && activeSummary(s)?.autoResume === true,
    unavailableReason: (s) => pausedReason(s) ?? 'This run is not set to resume by itself.',
    run: (ctx) =>
      guarded(ctx, async () => {
        await ctx.session.cancelAutoResume()
        ctx.notify('The run stays paused. /resume-now resumes it.')
      })
  },
  {
    name: 'stop',
    aliases: ['end'],
    summary: 'End this session (the run stops)',
    available: stoppable,
    unavailableReason: stopReason,
    run: (ctx) =>
      guarded(ctx, async () => {
        if (await ctx.confirm('End this session?')) await ctx.session.stop()
      })
  },
  {
    name: 'approvals',
    aliases: ['team-files', 'trust'],
    summary: 'Read the team-file changes and folder config that wait for approval (read-only: approving is not available in the terminal yet)',
    run: (ctx) => guarded(ctx, () => runApprovals(ctx))
  },
  {
    name: 'team',
    summary: "The project's saved roles as a tree: models, effort, staffing; edit a role in place",
    available: (s) => s.project !== undefined,
    unavailableReason: () => 'Open a project folder first.',
    run: (ctx) =>
      guarded(ctx, () => {
        if (ctx.openConfig) ctx.openConfig('team')
        else ctx.notify('The Team view is not available here; use orgai team roles.', 'warn')
      })
  },
  {
    name: 'settings',
    aliases: ['config', 'tiers'],
    summary: 'Project, tier and app settings with their values; edit one in place',
    available: (s) => s.project !== undefined,
    unavailableReason: () => 'Open a project folder first.',
    run: (ctx) =>
      guarded(ctx, () => {
        if (ctx.openConfig) ctx.openConfig('settings')
        else ctx.notify('The Settings view is not available here; use orgai projects show and orgai settings.', 'warn')
      })
  },
  {
    // The owning orgai's own card list; not the removed `orgai inbox` command (spec 4.1).
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
    unavailableReason: needsRunReason,
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
    unavailableReason: needsRunReason,
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
    unavailableReason: retroReason,
    run: (ctx) =>
      guarded(ctx, async () => {
        if (ctx.startRetro) await ctx.startRetro()
        else ctx.notify('The Org retrospective is not available here.', 'warn')
      })
  },
  {
    name: 'logs',
    args: '[info|all]',
    summary: "The run's warnings and errors, kept for the whole run (info or all adds the rest)",
    available: (s) => s.activeRunId !== undefined,
    unavailableReason: needsRunReason,
    run: (ctx, args) =>
      guarded(ctx, async () => {
        const word = cleanLine(args, 20).toLowerCase()
        const level: LogLevelFilter = word === '' || word === 'warn' ? 'warn' : word === 'info' ? 'info' : word === 'all' ? 'all' : 'warn'
        if (word !== '' && !LOG_LEVEL_WORDS.includes(word as LogLevelFilter)) {
          ctx.notify('Use /logs, /logs info or /logs all.', 'warn')
          return
        }
        const st = ctx.state()
        const run = st.activeRunId ? st.runs[st.activeRunId] : undefined
        await ctx.openText('Logs', logsOverlayText(run?.logs, level))
      })
  },
  {
    name: 'outputs',
    summary: "The files this run produced (orgai outputs show <id> previews one)",
    available: (s) => s.activeRunId !== undefined,
    unavailableReason: needsRunReason,
    run: (ctx) =>
      guarded(ctx, async () => {
        const runId = ctx.state().activeRunId
        const all = await ctx.session.listOutputs()
        await ctx.openText('Outputs', outputsOverlayText(runId ? outputsOfRun(all, runId) : []))
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
    name: 'effort',
    args: '[low|medium|high|xhigh|max]',
    summary: "Choose the root agent's reasoning effort for the next run",
    available: (s) => !s.readOnlyReason,
    unavailableReason: readOnlyText,
    run: (ctx, args) =>
      guarded(ctx, () => {
        const word = cleanLine(args, 20).toLowerCase()
        const run = activeSummary(ctx.state())
        const staged = ctx.session.getStaged()
        if (!word) {
          const now = run?.rootEffort ?? staged.effort
          ctx.notify(`Effort: ${now ?? "the role's own"}${staged.effort && run ? ` (next run: ${staged.effort})` : ''}. Use /effort ${EFFORT_WORDS.join('|')}.`)
          return
        }
        if (!(EFFORT_WORDS as readonly string[]).includes(word)) {
          ctx.notify(`Effort is one of ${EFFORT_WORDS.join(', ')}.`, 'warn')
          return
        }
        ctx.session.stage({ effort: word as Effort })
        ctx.notify(`The next run starts at ${word} effort.${run ? ' The followed run keeps its own.' : ''}`)
      })
  },
  {
    name: 'mode',
    args: '[default|acceptEdits|plan|auto]',
    summary: 'Show or change the permission mode (Shift+Tab cycles it from the composer)',
    available: (s) => !s.readOnlyReason,
    unavailableReason: readOnlyText,
    run: (ctx, args) =>
      guarded(ctx, async () => {
        const s = ctx.state()
        const run = activeSummary(s)
        const staged = ctx.session.getStaged()
        const word = cleanLine(args, 24)
        if (!word) {
          const now = modeInForce(run, staged.permissionMode)
          ctx.notify(`Mode: ${now ?? "the project's"}${run ? '' : ' (for the next run)'}. ${modeSwitchHint(s)}`)
          return
        }
        const mode = (CYCLE_MODES as readonly string[]).find((m) => m.toLowerCase() === word.toLowerCase()) as PermissionMode | undefined
        if (!mode) {
          ctx.notify(`Mode is one of ${CYCLE_MODES.join(', ')}.`, 'warn')
          return
        }
        if (ctx.setMode) await ctx.setMode(mode)
      })
  },
  {
    name: 'goal',
    args: '[balanced|speed|cost]',
    summary: 'Staffing goal for the next run or continuation (balanced, speed or cost)',
    available: (s) => !s.readOnlyReason,
    unavailableReason: readOnlyText,
    run: (ctx, args) =>
      guarded(ctx, () => {
        const word = cleanLine(args, 20).toLowerCase()
        const staged = ctx.session.getStaged()
        if (!word) {
          ctx.notify(`Staffing goal: ${staged.goal ?? "the project's"}. Use /goal ${GOAL_WORDS.join('|')}.`)
          return
        }
        if (!(GOAL_WORDS as readonly string[]).includes(word)) {
          ctx.notify(`Goal is one of ${GOAL_WORDS.join(', ')}.`, 'warn')
          return
        }
        ctx.session.stage({ goal: word as StaffingGoal })
        ctx.notify(`The next run or continuation staffs for ${word}. A run already working keeps its goal.`)
      })
  },
  {
    name: 'save-project',
    aliases: ['save'],
    args: '[name]',
    summary: 'Save this chat (a quick run) as a project',
    available: (s) => !s.readOnlyReason && !!activeSummary(s)?.quick,
    unavailableReason: (s) => (s.readOnlyReason ? readOnlyText(s) : 'Only a chat started without a project can be saved as one. Follow it first.'),
    run: (ctx, args) =>
      guarded(ctx, async () => {
        const s = ctx.state()
        const run = activeSummary(s)
        if (!run?.quick) {
          ctx.notify('Only a chat started without a project can be saved as one.', 'warn')
          return
        }
        if (run.status === 'starting' || run.status === 'running' || run.status === 'idle' || run.status === 'stopping') {
          ctx.notify('End the session first (/stop), then /save-project.', 'warn')
          return
        }
        const name = cleanLine(args, 80) || cleanLine(basename(s.folder), 80) || 'Project'
        const res = await ctx.session.promoteQuick(name)
        if (res.kind === 'existing') {
          ctx.notify(`This folder is already the project ${cleanLine(res.name, 80)}.`, 'warn')
          return
        }
        ctx.notify(`Saved as the project ${cleanLine(res.project.name, 80)}.`)
        if (ctx.openProject) await ctx.openProject(res.project, res.run.id)
      })
  },
  {
    name: 'evolve',
    args: '[analyze|apply [deterministic|hybrid]|history|rollback [genId]]',
    summary: 'Analyze run waste and evolve the team chart (apply and rollback change the project)',
    available: (s) => !s.readOnlyReason,
    unavailableReason: readOnlyText,
    run: (ctx, args) =>
      guarded(ctx, async () => {
        const req = parseEvolve(args)
        if (req.kind === 'error') {
          ctx.notify(req.message, 'warn')
          return
        }
        const s = ctx.state()
        const project = s.project
        if (!project) {
          ctx.notify('/evolve needs a saved project. Open a project folder first (a quick chat can be saved with /save-project).', 'warn')
          return
        }
        const projectId = project.id
        if ((req.kind === 'apply' || req.kind === 'rollback') && (s.readOnlyReason || activeSummary(s)?.status === 'running' || activeSummary(s)?.status === 'starting')) {
          ctx.notify('A run is working. Changing the chart mid-run is confusing: wait for it, or /interrupt it, then /evolve.', 'warn')
          return
        }
        if (req.kind === 'analyze') {
          await ctx.openText('Team evolution', analyzeText(await ctx.session.evolveAnalyze({ projectId }), project))
        } else if (req.kind === 'history') {
          await ctx.openText('Team evolution history', historyText(await ctx.session.evolveHistory(projectId)))
        } else if (req.kind === 'apply') {
          if (req.strategy === 'hybrid') ctx.notify('Hybrid makes one tracked model call on the host to draft the plan.')
          const res = await ctx.session.evolveApply({ projectId, strategy: req.strategy })
          const text = applyText(res, req.strategy, project)
          ctx.notify(res.applied ? `Evolved the team${res.generation ? ` (${cleanLine(res.generation.id, 20)})` : ''}. The org tree shows the new chart.` : `Nothing applied: ${cleanLine(res.reason, 120) || 'no change'}.`, res.applied ? 'ok' : 'warn')
          await ctx.openText('Team evolution applied', text)
        } else {
          const res = await ctx.session.evolveRollback({ projectId, ...(req.generationId ? { generationId: req.generationId } : {}) })
          ctx.notify(rollbackText(res), res.rolledBack ? 'ok' : 'warn')
        }
      })
  },
  {
    name: 'copy',
    args: '[code]',
    summary: 'Copy the last assistant message (or its latest code block with "code")',
    available: (s) => lastAssistantText(s) !== undefined,
    unavailableReason: () => 'There is no assistant message to copy yet.',
    run: (ctx, args) =>
      guarded(ctx, async () => {
        const s = ctx.state()
        const wantCode = cleanLine(args, 20).toLowerCase() === 'code'
        const text = wantCode ? latestCodeBlock(s) : lastAssistantText(s)
        if (!text) {
          ctx.notify(wantCode ? 'No code block in the recent messages.' : 'There is no assistant message to copy yet.', 'warn')
          return
        }
        const via = ctx.copyText ? await ctx.copyText(text) : await copyToClipboard(text)
        if (via.length === 0) ctx.notify('Could not reach a clipboard. Select the text with the mouse instead.', 'warn')
        else ctx.notify(`Copied ${wantCode ? 'the code block' : 'the last message'} (${Array.from(text).length} characters).`)
      })
  },
  {
    name: 'quit',
    aliases: ['q', 'exit'],
    summary: 'Leave the terminal UI (active runs are stopped; it asks first)',
    run: (ctx) => guarded(ctx, () => ctx.quit())
  }
]

/** /help: the commands first (what most people look for), then the keys (generated from KEYMAP, so hints, `?` and this cannot drift). */
export const HELP_TEXT = ['Commands (type / in the composer)', ...commandLines(), '', ...helpKeyLines()].join('\n')

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
  return rankCommands(commands, query, s, true)
}

/** With an empty query /help and /new lead (issue #30 L6); the rest stay alphabetical. */
const LEADING = ['help', 'new']

function rankCommands(commands: readonly SlashCommand[], query: string, s: TuiState, available: boolean): SlashCommand[] {
  const q = (query ?? '').trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase()
  const ranked: { cmd: SlashCommand; rank: number }[] = []
  for (const cmd of commands) {
    const ok = !cmd.available || cmd.available(s)
    if (ok !== available) continue
    const aliases = cmd.aliases ?? []
    let rank = -1
    if (cmd.name === q) rank = 0
    else if (aliases.includes(q)) rank = 1
    else if (cmd.name.startsWith(q)) rank = 2
    else if (aliases.some((a) => a.startsWith(q))) rank = 3
    if (rank >= 0) ranked.push({ cmd, rank })
  }
  const lead = (c: SlashCommand): number => {
    if (q !== '') return 0
    const at = LEADING.indexOf(c.name)
    return at < 0 ? LEADING.length : at
  }
  ranked.sort((a, b) => a.rank - b.rank || lead(a.cmd) - lead(b.cmd) || a.cmd.name.localeCompare(b.cmd.name))
  return ranked.map((r) => r.cmd)
}

/** The command a parsed line names (exact name or alias among the available ones), else undefined. */
export function findSlash(name: string, s: TuiState): SlashCommand | undefined {
  const n = name.toLowerCase()
  return matchSlash(n, s).find((c) => c.name === n || (c.aliases ?? []).includes(n))
}

/**
 * The best unavailable command a query names (exact name or alias, else the first prefix match) with the reason it
 * cannot run now. Only meaningful when no available command matches (issue #29 M6).
 */
export function unavailableFor(commands: readonly SlashCommand[], query: string, s: TuiState): { cmd: SlashCommand; reason: string } | undefined {
  const cmd = rankCommands(commands, query, s, false)[0]
  if (!cmd) return undefined
  return { cmd, reason: cleanLine(cmd.unavailableReason?.(s) ?? 'Not available right now.', 160) }
}

/** "/retro: <reason>" for a typed line that names an unavailable command (the findSlash path), else undefined. */
export function unavailableMessage(name: string, s: TuiState, commands: readonly SlashCommand[] = SLASH_COMMANDS): string | undefined {
  if (matchCommands(commands, name, s).some((c) => c.name === name.toLowerCase() || (c.aliases ?? []).includes(name.toLowerCase()))) return undefined
  const hit = unavailableFor(commands, name, s)
  if (!hit) return undefined
  const n = name.toLowerCase()
  if (hit.cmd.name !== n && !(hit.cmd.aliases ?? []).includes(n)) return undefined
  return `/${hit.cmd.name}: ${hit.reason}`
}
