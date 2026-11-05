/**
 * `orgai worktrees` (cli-spec 6.3, Wave 5): leftover report branches (maintenance:*).
 *
 * - `worktrees list` (read): PendingWorktree rows (branch, agent, files changed, commits ahead, state).
 * - `worktrees diff <branch> [--pager]` (read): maintenance:diff. On a terminal the diff goes through
 *   sanitizeDiffForPager (agent escapes stripped, trusted +/- colour only); otherwise plain sanitized text. --pager
 *   hands it to $PAGER through the TUI pager's showInPager (shell: false, absolute path via whichOnPath).
 * - `worktrees merge <branch>` (configure): maintenance:integrateWorktree; a conflict is exit 1 with the host's message.
 * - `worktrees discard <branch> [--yes]` and `worktrees uninstall [--yes]` (configure, confirmed). Uninstall is for
 *   code projects only.
 *
 * Read-only commands work from inside a managed agent worktree: requireProject resolves it to the main checkout.
 */
import { projectKindOf } from '../../shared/defaults'
import type { MaintenanceResult, PendingWorktree, WorktreeDiff } from '../../shared/types'
import { formatDate } from '../../shared/view/dates'
import { parseFlags } from '../flags'
import { confirm, hostCall, requireProject, runSubcommands, withHost, type SubcommandFn } from '../manage'
import { emit, note, safe, safeLine, styleFor, table, termWidth } from '../output'
import { showInPager } from '../tui/pager'
import { sanitizeDiffForPager } from '../tui/sanitizeTty'
import { CliError, EXIT, type CommandFn } from '../types'
import { checkArg, onlyPositionals, projectJson } from './org'

const USAGE = 'worktrees list | diff <branch> [--pager] | merge <branch> | discard <branch> [--yes] | uninstall [--yes]'

/** Swappable in tests: the pager. */
export const worktreeDeps = { showInPager }

export const runWorktrees: CommandFn = (ctx, args) =>
  runSubcommands(ctx, args, { list: wtList, diff: wtDiff, merge: wtMerge, discard: wtDiscard, uninstall: wtUninstall }, USAGE)

/** The state word of one pending branch. */
export function worktreeState(w: PendingWorktree): string {
  if (!w.exists) return 'branch only'
  if (w.uncommittedFiles > 0) return `${w.uncommittedFiles} uncommitted`
  if (w.commitsAhead > 0) return 'unmerged'
  return 'clean'
}

const wtList: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 0, 'worktrees list')
  return withHost(ctx, ['read'], async (client) => {
    const project = await requireProject(ctx, client)
    const list = await hostCall<PendingWorktree[]>(client, 'maintenance:listWorktrees', [project.id])
    emit(ctx, { project: projectJson(project), worktrees: list.map((w) => ({ ...w, state: worktreeState(w) })) }, () => {
      if (list.length === 0) return 'No pending report branches.'
      const st = styleFor(ctx)
      return [
        `${list.length} pending report branch${list.length === 1 ? '' : 'es'}:`,
        ...table(
          [{ header: 'BRANCH', flex: true }, { header: 'AGENT' }, { header: 'FILES', align: 'right' }, { header: 'AHEAD', align: 'right' }, { header: 'STATE' }, { header: 'LAST' }],
          list.map((w) => [
            safeLine(w.branch),
            safeLine(w.agentId),
            String(w.changedFiles.length),
            String(w.commitsAhead),
            worktreeState(w),
            w.lastCommitAt ? `${formatDate(w.lastCommitAt)} ${safeLine(w.lastSubject ?? '')}`.trim() : safeLine(w.lastSubject ?? '')
          ]),
          termWidth(ctx),
          st
        )
      ]
    })
    return EXIT.ok
  })
}

const wtDiff: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { pager: { type: 'boolean' } })
  onlyPositionals(positionals, 1, 'worktrees diff <branch> [--pager]')
  const branch = checkArg('branch', positionals[0])
  return withHost(ctx, ['read'], async (client) => {
    const project = await requireProject(ctx, client)
    const diff = await hostCall<WorktreeDiff>(client, 'maintenance:diff', [{ projectId: project.id, branch }])
    if (ctx.globals.outputFormat !== 'text') {
      emit(ctx, { project: projectJson(project), branch, stat: diff.stat, patch: diff.patch }, () => '')
      return EXIT.ok
    }
    const text = `${diff.stat.trimEnd()}\n\n${diff.patch}`.trimEnd()
    if (!text) {
      ctx.io.stdout.write('No committed changes on this branch.\n')
      return EXIT.ok
    }
    if (values.pager) {
      const shown = await worktreeDeps.showInPager(text, { env: ctx.env, suspend: () => {}, resume: () => {} })
      if (shown === 'shown') return EXIT.ok
      note(ctx, 'No pager found ($PAGER, less or more); printing the diff.')
    }
    const body = ctx.io.stdout.isTTY && ctx.globals.color ? sanitizeDiffForPager(text) : safe(text)
    ctx.io.stdout.write(`${body}\n`)
    return EXIT.ok
  })
}

const wtMerge: SubcommandFn = async (ctx, args) => {
  const { positionals } = parseFlags(args, {})
  onlyPositionals(positionals, 1, 'worktrees merge <branch>')
  const branch = checkArg('branch', positionals[0])
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    const res = await hostCall<MaintenanceResult>(client, 'maintenance:integrateWorktree', [{ projectId: project.id, branch }])
    if (!res.ok) throw new CliError(safe(res.message) || `Could not merge ${safeLine(branch)}.`, EXIT.failure)
    emit(ctx, { project: projectJson(project), branch, ok: true, message: res.message }, () => safeLine(res.message) || `Merged ${safeLine(branch)}.`)
    return EXIT.ok
  })
}

const wtDiscard: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  onlyPositionals(positionals, 1, 'worktrees discard <branch> [--yes]')
  const branch = checkArg('branch', positionals[0])
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    if (!(await confirm(ctx, `Discard ${safeLine(branch)} and everything on it?`, !!values.yes))) {
      note(ctx, 'Nothing discarded.')
      return EXIT.failure
    }
    const res = await hostCall<MaintenanceResult>(client, 'maintenance:discardWorktree', [{ projectId: project.id, branch }])
    if (!res.ok) throw new CliError(safe(res.message) || `Could not discard ${safeLine(branch)}.`, EXIT.failure)
    emit(ctx, { project: projectJson(project), branch, ok: true, message: res.message }, () => safeLine(res.message))
    return EXIT.ok
  })
}

const wtUninstall: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  onlyPositionals(positionals, 0, 'worktrees uninstall [--yes]')
  return withHost(ctx, ['read', 'configure'], async (client) => {
    const project = await requireProject(ctx, client)
    if (projectKindOf(project) === 'engagement') throw new CliError('Maintenance has no repository tools for engagements: OrgAI writes nothing into their folder.', EXIT.usage)
    if (!(await confirm(ctx, `Remove OrgAI's files (architecture document, CLAUDE.md section, exclude line) from ${safeLine(project.path)}?`, !!values.yes))) {
      note(ctx, 'Nothing removed.')
      return EXIT.failure
    }
    const res = await hostCall<MaintenanceResult>(client, 'maintenance:uninstallRepo', [project.id])
    if (!res.ok) throw new CliError(safe(res.message) || 'Could not remove OrgAI files.', EXIT.failure)
    emit(ctx, { project: projectJson(project), ok: true, message: res.message }, () => safeLine(res.message))
    return EXIT.ok
  })
}
