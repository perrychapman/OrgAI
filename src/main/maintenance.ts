import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeOrgaiIfEmpty, removeTeamFolderFiles } from './teamFiles/disk'
import type { MaintenanceResult, PendingWorktree, Project, RunRecord, RunSummary, WorktreeDiff } from '@shared/types'
import { writesToProjectFolder } from '@shared/defaults'
import type { ProjectStore } from './store/projects'
import { ARCHITECTURE_PATH, CLAUDE_MD_MARKER } from './setup/service'
import { diffWorktree, discardWorktree, inspectPending, integrateWorktree, isGitRepo, removeExcludeLine, UnfinishedGitStateError, type GateDecision } from './runtime/worktrees'
import { runTestGate, testGateCommand } from './runtime/testGate'

const DAY_MS = 24 * 60 * 60 * 1000
/** Run statuses after which nothing of the run is live and it will not resume by itself. */
const ENDED_RUN: ReadonlySet<RunSummary['status']> = new Set<RunSummary['status']>(['finished', 'error'])

/** What the retention sweep needs to know about runs (RunStore satisfies it). */
export interface MaintenanceRuns {
  list(projectId: string): RunSummary[]
  getRecord(runId: string): RunRecord | null
}

export interface MaintenanceDeps {
  runs?: MaintenanceRuns
  /** True while RunManager has a live run of the project (extra to the stored status). */
  hasLiveRun?: (projectId: string) => boolean
  now?: () => number
  log?: (message: string) => void
}

/**
 * Cleanup that happens outside a run: leftover report branches, and removing OrgAI's
 * footprint from a repository.
 */
export class MaintenanceService {
  /** `teamFiles.markRemoved` keeps the team files from coming back on a later save (teamFiles:enable turns them on again). */
  constructor(
    private projects: ProjectStore,
    private teamFiles?: { markRemoved(projectId: string): void },
    private deps: MaintenanceDeps = {}
  ) {}

  private project(id: string): Project {
    const p = this.projects.get(id)
    if (!p) throw new Error('Project not found')
    return p
  }

  /**
   * Leftover report branches are listed whenever the folder is a git repository, whatever the isolation setting is
   * now (it may have been on for an earlier run). Listing only reads; inspectPending answers [] for a non-git folder.
   */
  async listWorktrees(projectId: string): Promise<PendingWorktree[]> {
    const p = this.project(projectId)
    return inspectPending(p.path)
  }

  private async find(projectId: string, branch: string): Promise<{ root: string; wt: PendingWorktree }> {
    const p = this.project(projectId)
    const root = p.path
    const wt = (await inspectPending(root)).find((w) => w.branch === branch)
    if (!wt) throw new Error(`Branch ${branch} is not a pending report branch`)
    return { root, wt }
  }

  async integrateWorktree(projectId: string, branch: string): Promise<MaintenanceResult> {
    const { root, wt } = await this.find(projectId, branch)
    const project = this.project(projectId)
    // The same gates as an integration inside a run: the project's test command, and where merges land.
    const command = testGateCommand(project)
    const gate = command
      ? async (): Promise<GateDecision> => {
          const run = await runTestGate(command, wt.path)
          return run.outcome === 'passed'
            ? { behavior: 'merge' }
            : { behavior: 'refuse', reason: 'tests', message: `Not merged: the project's tests ${run.outcome === 'timeout' ? 'timed out' : 'failed'}, and this project requires them to pass first. ${wt.branch} is kept at ${wt.path}.\n${run.detail}` }
        }
      : undefined
    const mainBranch = project.mainBranch?.trim()
    const result = await integrateWorktree(
      root,
      { path: wt.path, branch: wt.branch, status: 'merging' },
      `${wt.lastSubject ?? 'Leftover report'} (integrated from maintenance)`,
      gate,
      mainBranch ? { mainBranch } : {}
    )
    return { ok: result.info.status === 'merged' || result.info.status === 'empty', message: result.message }
  }

  /**
   * Project.keepFailedBranchesDays: remove the finished copies (worktrees) of failed work once their last activity is
   * older than N days, through the same discardWorktree a user discard uses (so it refuses over an unfinished git
   * operation too). A copy goes only when every one of these holds; anything unknown keeps it:
   * - the project is a code project in a git repository with keepFailedBranchesDays set;
   * - no run of the project is live (stored status other than finished / error, or RunManager says so), so a copy a live
   *   run might still integrate is never touched;
   * - a stored run record of the project names the copy's agent, that run ended, and the agent's copy either could not be
   *   merged (status 'conflict': a conflict or a refused test gate), was discarded but left behind ('removed'), or the
   *   agent failed ('error'). Held, in-review, active and unowned copies are never removed;
   * - the copy has no uncommitted file, and the newest of its last commit, its run's end and its folder's change is
   *   older than N days.
   * There is no periodic sweep in the app: the host calls this once at start. Returns the removed branch names.
   */
  async sweepFinishedCopies(): Promise<string[]> {
    const removed: string[] = []
    const runs = this.deps.runs
    if (!runs) return removed
    const now = (this.deps.now ?? Date.now)()
    for (const project of this.projects.list()) {
      const days = project.keepFailedBranchesDays
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) continue
      if (!writesToProjectFolder(project) || !isGitRepo(project.path)) continue
      try {
        const summaries = runs.list(project.id)
        if (this.deps.hasLiveRun?.(project.id) || summaries.some((s) => !ENDED_RUN.has(s.status))) continue
        const pending = await inspectPending(project.path)
        if (!pending.length) continue
        // agent id -> its run and its copy's last recorded state.
        const owners = new Map<string, { run: RunSummary; failed: boolean }>()
        for (const run of summaries) {
          const record = runs.getRecord(run.id)
          for (const [agentId, agent] of Object.entries(record?.agents ?? {})) {
            const status = agent.worktree?.status
            if (!status) continue
            const failed = status === 'conflict' || status === 'removed' || (agent.state === 'error' && status !== 'held' && status !== 'review')
            const prev = owners.get(agentId)
            // The newest run that knows the agent wins; a later one that did not fail keeps the copy.
            if (!prev || run.startedAt >= prev.run.startedAt) owners.set(agentId, { run, failed })
          }
        }
        for (const wt of pending) {
          const owner = owners.get(wt.agentId)
          if (!owner?.failed || wt.uncommittedFiles > 0) continue
          let folderChanged = 0
          try {
            if (wt.exists) folderChanged = statSync(wt.path).mtimeMs
          } catch {
            /* unreadable: the other two clocks decide */
          }
          const last = Math.max(wt.lastCommitAt ?? 0, owner.run.endedAt ?? owner.run.startedAt, folderChanged)
          if (!last || now - last < days * DAY_MS) continue
          try {
            await discardWorktree(project.path, wt)
            removed.push(wt.branch)
            this.deps.log?.(`Removed the finished copy ${wt.branch} of ${project.name}: its work failed and it was idle for more than ${days} day${days === 1 ? '' : 's'}.`)
          } catch (e) {
            // An unfinished git operation (or any git failure): keep it, try again at the next start.
            if (!(e instanceof UnfinishedGitStateError)) this.deps.log?.(`Kept ${wt.branch}: could not remove it (${e instanceof Error ? e.message : String(e)}).`)
          }
        }
      } catch (e) {
        this.deps.log?.(`Retention sweep skipped ${project.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return removed
  }

  async discardWorktree(projectId: string, branch: string): Promise<MaintenanceResult> {
    const { root, wt } = await this.find(projectId, branch)
    try {
      await discardWorktree(root, wt)
    } catch (e) {
      if (e instanceof UnfinishedGitStateError) return { ok: false, message: e.message }
      throw e
    }
    return { ok: true, message: `Discarded ${branch}.` }
  }

  /** The branch's committed changes against the main checkout. Uncommitted files in its worktree are not included. */
  async diffWorktree(projectId: string, branch: string): Promise<WorktreeDiff> {
    const { root, wt } = await this.find(projectId, branch)
    const { stat, patch } = await diffWorktree(root, wt.branch)
    return { stat, patch }
  }

  /** Remove the architecture document, the CLAUDE.md block, the exclude line and the setup record. */
  async uninstallRepo(projectId: string): Promise<MaintenanceResult> {
    const project = this.project(projectId)
    const root = project.path
    // An engagement's folder holds nothing of OrgAI's (its document and rules live in the data folder): never touch it.
    if (!writesToProjectFolder(project)) return { ok: true, message: 'Nothing to remove.' }
    if (isGitRepo(root)) {
      const holding = (await inspectPending(root)).filter((w) => w.uncommittedFiles > 0 || w.commitsAhead > 0)
      if (holding.length) {
        return {
          ok: false,
          message: `${holding.length} report branch${holding.length === 1 ? ' still holds' : 'es still hold'} unmerged work (${holding.map((w) => w.branch).join(', ')}). Integrate or discard them first.`
        }
      }
      try {
        for (const w of await inspectPending(root)) await discardWorktree(root, w)
      } catch (e) {
        if (e instanceof UnfinishedGitStateError) return { ok: false, message: e.message }
        throw e
      }
    }

    const removed: string[] = []
    let removedDoc = false
    for (const docPath of [ARCHITECTURE_PATH]) {
      const docFile = join(root, docPath)
      if (existsSync(docFile)) {
        unlinkSync(docFile)
        removed.push(docPath)
        removedDoc = true
      }
    }
    // The team files (team.json, mcp.json, agents, skills) go too; org.json stays. Links are unlinked, never followed.
    // The service is told first so no later save recreates them.
    this.teamFiles?.markRemoved(project.id)
    const team = removeTeamFolderFiles(root)
    removed.push(...team)
    if (removedDoc || team.length) removeOrgaiIfEmpty(root) // a folder with only OS litter left (Finder's .DS_Store)

    const claudeMd = join(root, 'CLAUDE.md')
    if (existsSync(claudeMd)) {
      const before = readFileSync(claudeMd, 'utf8')
      const after = stripArchitectureBlock(before)
      if (after !== before) {
        const rest = after.trim()
        if (!rest || rest === `# ${project.name}`) {
          unlinkSync(claudeMd)
          removed.push('CLAUDE.md')
        } else {
          writeFileSync(claudeMd, after, 'utf8')
          removed.push('CLAUDE.md (OrgAI section)')
        }
      }
    }

    if (isGitRepo(root) && removeExcludeLine(root)) removed.push('.git/info/exclude entry')

    if (project.setup?.architecture || project.setup?.architecturePath) {
      const setup = { ...project.setup }
      delete setup.architecture
      delete setup.architecturePath
      this.projects.save({ ...project, setup })
    }

    return { ok: true, message: removed.length ? `Removed ${removed.join(', ')}.` : 'Nothing to remove.' }
  }
}

/** Remove the block writeArchitecture appends to CLAUDE.md, from the marker through its paragraph. */
export function stripArchitectureBlock(text: string): string {
  const start = text.indexOf(CLAUDE_MD_MARKER)
  if (start === -1) return text
  const rest = text.slice(start + CLAUDE_MD_MARKER.length)
  // The block is the marker, a heading, and one paragraph; it ends at the next blank line or EOF.
  const m = /^\s*## [^\n]*\n\n[^\n]*(?:\n(?!\n)[^\n]*)*\n?/.exec(rest)
  const endOffset = m ? m[0].length : 0
  const before = text.slice(0, start).replace(/\n+$/, '\n')
  const after = rest.slice(endOffset).replace(/^\n+/, '')
  return after ? `${before}${before.endsWith('\n') ? '\n' : '\n\n'}${after}` : before
}
