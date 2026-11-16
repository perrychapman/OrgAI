/**
 * `orgai init [<folder>]` (cli-spec 6.3(1), Wave 5): register the folder as a project and run the Architect's setup
 * interview in the terminal UI, or with --skip-architect create it with the default team (or --template /
 * --import-agents) and exit 0.
 *
 * Order: the managed worktree guard and (without --skip-architect) the terminal check come before any host starts.
 * Then, with 'configure': projects:checkPath; an existing project is reused (--skip-architect just says so), else
 * projects:create (commands/projects.ts createProjectIn, --client through a follow-up save). The Architect runs through
 * runInteractiveRun (setup:start), which exits 0 once complete_setup finishes and 130 on Ctrl+C after runs:stop.
 */
import { projectKindLabel, projectKindOf } from '../../shared/defaults'
import type { Project } from '../../shared/types'
import { parseFlags } from '../flags'
import { withHost } from '../manage'
import { quietInproc } from '../context'
import { emit, safeLine } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn } from '../types'
import { runInteractiveRun, type InteractiveRunSpec } from './interactive'
import { CREATE_FLAGS, checkFolder, createOptionsOf, createProjectIn, folderArg, projectFacts, projectLines } from './projects'
import { hasTty, managedOf, worktreeRefusal } from './tui'

export const INIT_NO_TTY_MESSAGE = 'orgai init needs a terminal for the Architect interview; pass --skip-architect to create the project with the default team.'
export const ARCHITECT_LABEL = 'Architect setup'

/** Swappable in tests: the interactive run (commands/interactive.ts). */
export const initDeps = {
  runInteractiveRun: (ctx: CliContext, spec: InteractiveRunSpec, flags?: { inline?: boolean; screenReader?: boolean }): Promise<number> => runInteractiveRun(ctx, spec, flags)
}

const INIT_FLAGS = {
  ...CREATE_FLAGS,
  'skip-architect': { type: 'boolean' },
  inline: { type: 'boolean' },
  'ax-screen-reader': { type: 'boolean' }
} as const

export const runInit: CommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, INIT_FLAGS)
  if (positionals.length > 1) throw new CliError('Use: orgai init [<folder>] [--name <name>] [--kind code|engagement] [--skip-architect] ...', EXIT.usage)
  const opts = createOptionsOf(values)
  const skip = values['skip-architect'] === true
  const managed = managedOf(ctx)
  if (managed) throw new CliError(worktreeRefusal(managed.mainCheckout), EXIT.usage)
  if (!skip && !hasTty(ctx)) throw new CliError(INIT_NO_TTY_MESSAGE, EXIT.usage)
  const folder = folderArg(ctx, positionals[0])

  // The Architect's terminal UI follows on this same host, so it starts quiet (its console lines go to the log file).
  if (!skip) quietInproc(ctx)
  const outcome = await withHost(ctx, ['read', 'configure'], async (client): Promise<{ project: Project; existing: boolean }> => {
    const check = await checkFolder(client, folder)
    if (check.exists && !check.isDirectory) throw new CliError(`${safeLine(folder)} is not a folder.`, EXIT.usage)
    if (!check.exists) throw new CliError(`No folder at ${safeLine(folder)}.`, EXIT.usage)
    if (check.existingProjectId) {
      const p = await client.call<Project | null>('projects:get', [check.existingProjectId]).catch(() => null)
      const project = p ?? ({ id: check.existingProjectId, name: check.existingProjectName ?? check.existingProjectId, path: folder } as Project)
      return { project, existing: true }
    }
    return { project: await createProjectIn(ctx, client, folder, check, opts), existing: false }
    // Without --skip-architect the Architect follows on this same host (one boot, not two).
  }, { keepHost: !skip })
  const { project, existing } = outcome

  if (skip) {
    if (existing) {
      emit(ctx, { project: { id: project.id, name: project.name, path: project.path }, existing: true }, () => `Already an OrgAI project: ${safeLine(project.name)}`)
      return EXIT.ok
    }
    emit(ctx, { project: projectFacts(project), existing: false }, () => [
      `Created ${projectKindLabel(projectKindOf(project)).toLowerCase()} ${safeLine(project.name)} (${safeLine(project.id)}) ${opts.template !== undefined ? 'from the template' : opts.importAgents ? 'with the imported agents' : 'with the default team'}.`,
      ...projectLines(ctx, project).slice(1)
    ])
    return EXIT.ok
  }

  if (!existing) ctx.io.stderr.write(`Created ${safeLine(project.name)}. Starting the Architect...\n`)
  return initDeps.runInteractiveRun(
    ctx,
    { channel: 'setup:start', input: { projectId: project.id }, label: ARCHITECT_LABEL, noTtyMessage: INIT_NO_TTY_MESSAGE },
    { inline: values.inline === true, screenReader: values['ax-screen-reader'] === true }
  )
}
