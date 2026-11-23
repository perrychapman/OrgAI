import { existsSync, lstatSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeOrgaiIfEmpty, removeTeamFolderFiles } from './teamFiles/disk'
import { FINISHED_COPIES_WALK_MAX_ENTRIES, type FinishedCopiesSize, type MaintenanceResult, type PendingWorktree, type Project, type RunRecord, type RunSummary, type WorktreeDiff } from '@shared/types'
import { writesToProjectFolder } from '@shared/defaults'
import type { ProjectStore } from './store/projects'
import { ARCHITECTURE_PATH, CLAUDE_MD_MARKER } from './setup/service'
import {
  currentBranchName,
  defaultBranchNames,
  deleteReportBranch,
  diffWorktree,
  discardWorktree,
  inspectPending,
  integrateWorktree,
  isGitRepo,
  localBranchExists,
  removeExcludeLine,
  sameBranchName,
  UnfinishedGitStateError,
  type GateDecision
} from './runtime/worktrees'
import { branchNameMatcher, isValidBranchName, REPORT_BRANCH_PREFIX } from './runtime/branchNames'
import { runTestGate, testGateCommand, testGateMissingCommand } from './runtime/testGate'

const DAY_MS = 24 * 60 * 60 * 1000
/** How many of a project's newest stored runs deleteBranch reads to learn which branches were agents' worktrees. */
const RECORDED_RUNS_CHECKED = 100
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
  /** Tests: the entry budget of finishedCopiesSize (default FINISHED_COPIES_WALK_MAX_ENTRIES). */
  walkMaxEntries?: number
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
    // The panel's own button is the user's approval, so the gate runs right away. It executes repository code by the user's choice (testGate.ts).
    const command = testGateCommand(project)
    const missing = testGateMissingCommand(project)
    const gate = missing
      ? (): Promise<GateDecision> => Promise.resolve({ behavior: 'refuse', reason: 'tests', message: `Not merged: ${missing} ${wt.branch} is kept at ${wt.path}.` })
      : command
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

  /**
   * maintenance:finishedCopiesSize: how many finished copies (the same list as listWorktrees) the project has and the
   * bytes of the regular files in them. The walk uses lstat only: a symlink, junction or other link is never followed
   * (and counts no bytes), each copy's own `.git` link file is skipped, and a copy nested inside another one
   * (<copy>/.claude/worktrees) is left to its own entry so nothing is counted twice. At most
   * FINISHED_COPIES_WALK_MAX_ENTRIES entries are looked at in all; past that `truncated` is true and `bytes` a lower
   * bound. A hard link counts once per path. An engagement or a folder that is not a git repository has none.
   */
  async finishedCopiesSize(projectId: string): Promise<FinishedCopiesSize> {
    const project = this.project(projectId)
    if (!writesToProjectFolder(project) || !isGitRepo(project.path)) return { count: 0, bytes: 0, truncated: false }
    const copies = await inspectPending(project.path)
    const budget = { left: this.deps.walkMaxEntries ?? FINISHED_COPIES_WALK_MAX_ENTRIES }
    let bytes = 0
    let truncated = false
    for (const copy of copies) {
      if (!copy.exists) continue
      const walked = walkCopyBytes(copy.path, budget)
      bytes += walked.bytes
      if (walked.truncated) {
        truncated = true
        break
      }
    }
    return { count: copies.length, bytes, truncated }
  }

  /**
   * maintenance:deleteBranch: delete one OrgAI report branch (and its finished copy) from the project's repository.
   * Local branches only; no remote is touched. Refused, with a sentence and nothing changed, for: a name that is not a
   * valid branch name, a branch that does not exist, the branch the checkout is on, the repository's default branch
   * and Project.mainBranch, a branch a live run uses (or any branch while a live run's worktrees cannot be read), and
   * any branch that is not a report branch (see isReportBranch). Then, through the same path as a discard:
   * - the branch has a finished copy: the copy is removed and the branch force-deleted (`git branch -D -- <branch>`);
   *   an unfinished git operation in the repository or the copy refuses it, as for a discard;
   * - no copy: `git branch -d -- <branch>`, which git refuses unless the branch is merged into the current branch.
   */
  async deleteBranch(projectId: string, branch: string): Promise<MaintenanceResult> {
    const project = this.project(projectId)
    const root = project.path
    if (!writesToProjectFolder(project) || !isGitRepo(root)) return { ok: false, message: 'This project has no git repository, so there are no branches to delete.' }
    if (!isValidBranchName(branch)) return { ok: false, message: 'That is not a branch name OrgAI will delete.' }
    if (!(await localBranchExists(root, branch))) return { ok: false, message: `There is no local branch named ${branch}.` }
    const refused = await this.deleteBranchRefusal(project.id, root, branch)
    if (refused) return { ok: false, message: refused }
    if (!this.isReportBranch(project, branch)) return { ok: false, message: `${branch} is not a report branch OrgAI made, so it was left alone.` }
    const copy = (await inspectPending(root)).find((w) => w.branch === branch)
    try {
      // The same conditions again under the repository lock: a run may have started, or the default branch changed, since.
      const result = await deleteReportBranch(root, branch, { ...(copy ? { copyPath: copy.path } : {}), recheck: () => this.deleteBranchRefusal(project.id, root, branch) })
      if (!result.ok) return { ok: false, message: result.message }
      this.deps.log?.(`Deleted the report branch ${branch} of ${project.name}${result.removedCopy ? ' with its finished copy' : ''}.`)
      return { ok: true, message: result.removedCopy ? `Deleted ${branch} and its finished copy.` : `Deleted ${branch}.` }
    } catch (e) {
      if (e instanceof UnfinishedGitStateError) return { ok: false, message: e.message }
      throw e
    }
  }

  /**
   * Why `branch` may not be deleted right now, or undefined: it is the checkout's branch, the repository's default branch
   * or Project.mainBranch, or a live run uses it (or the live runs cannot be read). Read fresh on each call (the project,
   * the live runs, git), because deleteBranch asks again under the repository lock. Names are compared case-insensitively on
   * a case-insensitive file system (sameBranchName), where `Main` is `main`.
   */
  private async deleteBranchRefusal(projectId: string, root: string, branch: string): Promise<string | undefined> {
    const project = this.project(projectId)
    const onBranch = await currentBranchName(root)
    if (onBranch !== null && sameBranchName(onBranch, branch)) return `${branch} is the branch this checkout is on, so it was not deleted. Switch to another branch first.`
    const protectedNames = new Set(await defaultBranchNames(root))
    const mainBranch = project.mainBranch?.trim()
    if (mainBranch) protectedNames.add(mainBranch)
    if ([...protectedNames].some((n) => sameBranchName(n, branch))) return `${branch} is this project's default or main branch, so it was not deleted.`
    const live = this.liveBranches(projectId)
    if (live === 'unknown') return 'A run of this project is active and OrgAI cannot tell which branches it uses, so nothing was deleted. Try again when the run has ended.'
    if ([...live].some((n) => sameBranchName(n, branch))) return `${branch} is used by a run that is still active, so it was not deleted.`
    return undefined
  }

  /**
   * Branches the live runs of the project use: every agent worktree branch in the stored records of runs that have not
   * ended, plus the `worktree-agent-<agent id>` name of each such agent. 'unknown' when RunManager reports a live run
   * that the stored runs do not show, or a live record cannot be read: then nothing may be judged unused.
   */
  private liveBranches(projectId: string): Set<string> | 'unknown' {
    const runs = this.deps.runs
    const live = (runs?.list(projectId) ?? []).filter((s) => !ENDED_RUN.has(s.status))
    if (!live.length) return this.deps.hasLiveRun?.(projectId) ? 'unknown' : new Set()
    const used = new Set<string>()
    for (const summary of live) {
      const record = runs?.getRecord(summary.id)
      if (!record) return 'unknown'
      for (const [agentId, agent] of Object.entries(record.agents ?? {})) {
        used.add(`${REPORT_BRANCH_PREFIX}${agentId}`)
        used.add(`${REPORT_BRANCH_PREFIX}${agent.id}`)
        if (agent.worktree?.branch) used.add(agent.worktree.branch)
      }
    }
    return used
  }

  /**
   * An OrgAI report branch: named like the ones OrgAI and the SDKs create (`worktree-agent-<id>`), matching the
   * project's branchNamePattern (only when the pattern starts with a literal prefix, see branchNameMatcher), or named as
   * an agent's worktree branch in one of the project's most recent stored runs. Anything else is the user's.
   */
  private isReportBranch(project: Project, branch: string): boolean {
    if (branch.startsWith(REPORT_BRANCH_PREFIX) && branch.length > REPORT_BRANCH_PREFIX.length) return true
    if (branchNameMatcher(project.branchNamePattern)?.test(branch)) return true
    const runs = this.deps.runs
    if (!runs) return false
    const recent = [...runs.list(project.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, RECORDED_RUNS_CHECKED)
    for (const summary of recent) {
      const record = runs.getRecord(summary.id)
      for (const agent of Object.values(record?.agents ?? {})) if (agent.worktree?.branch === branch) return true
    }
    return false
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

    // On the project as it is stored now (the steps above awaited), not on the copy this started with.
    const latest = this.projects.get(project.id) ?? project
    if (latest.setup?.architecture || latest.setup?.architecturePath) {
      const setup = { ...latest.setup }
      delete setup.architecture
      delete setup.architecturePath
      this.projects.save({ ...latest, setup })
    }

    return { ok: true, message: removed.length ? `Removed ${removed.join(', ')}.` : 'Nothing to remove.' }
  }
}

/**
 * Bytes of the regular files under one finished copy. `budget.left` is the entries still allowed for the whole size
 * query; every entry looked at (file, directory or link) uses one, and `truncated` is true when it ran out. lstat on every
 * entry, so a symlink or junction is neither followed nor counted; the copy's own `.git` entry and the nested
 * `.claude/worktrees` folder (other copies, listed on their own) are skipped. An unreadable folder or file counts nothing.
 * Iterative, so a deep tree cannot overflow the stack. Exported for tests.
 */
export function walkCopyBytes(copyPath: string, budget: { left: number }): { bytes: number; truncated: boolean } {
  let bytes = 0
  const nested = join(copyPath, '.claude', 'worktrees')
  const pending: string[] = [copyPath]
  while (pending.length) {
    const dir = pending.pop() as string
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (budget.left <= 0) return { bytes, truncated: true }
      budget.left -= 1
      const full = join(dir, name)
      if (dir === copyPath && name === '.git') continue
      if (full === nested) continue
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) pending.push(full)
      else if (st.isFile()) bytes += st.size
    }
  }
  return { bytes, truncated: false }
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
