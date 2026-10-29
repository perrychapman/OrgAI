import type { AgentInstance, MergeDecision, WorktreeInfo } from '@shared/types'
import { ROOT_AGENT_ID, type RuntimeContext } from './types'
import { INTEGRATE_TOOL } from './harnessTools'
import { commitLeftovers, diffWorktree, findWorktree, inspectPending, integrateWorktree, prepareRepo } from './worktrees'

/**
 * The per-run worktree state machine, shared by every adapter whose writing reports work in git
 * worktrees: active -> merging -> (review ->) merged | empty | conflict | held | removed.
 * worktrees.ts is the git layer; this class decides when to call it, keeps each isolated agent's
 * WorktreeInfo, logs through ctx.emit and tells the orchestrator what landed through `notify`.
 */

export interface IntegratorHost {
  /** The adapter's current snapshot of an agent (for its name and activity). */
  agent(id: string): AgentInstance | undefined
  /** Put the worktree state on the agent and emit agent.upsert. */
  setWorktree(agentId: string, info: WorktreeInfo): void
  /** Deliver a harness message to the orchestrator (starting a new turn if it is idle). */
  notify(text: string): void
}

export class WorktreeIntegrator {
  /** Isolated agents by agent id. */
  private worktrees = new Map<string, WorktreeInfo>()
  /** agent id -> the brief it was spawned with, for commit messages. */
  private briefs = new Map<string, string>()

  constructor(
    private ctx: RuntimeContext,
    private host: IntegratorHost
  ) {}

  private get root(): string {
    return this.ctx.project.path
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.ctx.emit({ type: 'log', runId: this.ctx.run.id, level, message })
  }

  private set(agentId: string, info: WorktreeInfo): void {
    this.worktrees.set(agentId, info)
    this.host.setWorktree(agentId, info)
  }

  /**
   * Prepare the repository for isolated reports and reconcile branches left by earlier runs.
   * Returns a message for the orchestrator's first turn, or null when nothing is waiting.
   */
  async start(): Promise<string | null> {
    await prepareRepo(this.root)
    this.log('info', 'Writing reports run in isolated git worktrees; the harness merges each one back when it reports.')
    return this.reconcileLeftovers()
  }

  /** Remember the brief an agent was spawned with (any agent, isolated or not). */
  noteBrief(agentId: string, brief: string): void {
    this.briefs.set(agentId, brief)
  }

  /**
   * Start tracking an isolated agent. Returns the info it is tracked with: the existing one when the
   * agent is already tracked, otherwise `info`. Does not emit; the adapter includes it in its upsert.
   */
  track(agentId: string, info: WorktreeInfo): WorktreeInfo {
    const existing = this.worktrees.get(agentId)
    if (existing) return existing
    this.worktrees.set(agentId, info)
    return info
  }

  worktreeOf(agentId: string): WorktreeInfo | undefined {
    return this.worktrees.get(agentId)
  }

  /** The agent's real working directory, once known (its first tool call). Updates the worktree path. */
  reportCwd(agentId: string, cwd: string | undefined): void {
    const wt = this.worktrees.get(agentId)
    if (!wt || wt.status !== 'active' || !cwd || cwd === this.root || wt.path === cwd) return
    this.set(agentId, { ...wt, path: cwd })
  }

  /** A finished isolated report gets its branch committed and merged exactly once. */
  onSubagentFinished(agentId: string): Promise<void> {
    const wt = this.worktrees.get(agentId)
    if (!wt || wt.status !== 'active') return Promise.resolve()
    this.set(agentId, { ...wt, status: 'merging' })
    return this.integrate(agentId)
  }

  private async integrate(agentId: string): Promise<void> {
    const located = await findWorktree(this.root, agentId)
    const info: WorktreeInfo = { ...this.worktrees.get(agentId)!, ...(located ?? {}), status: 'merging' }
    const agent = this.host.agent(agentId)
    const name = agent?.name ?? agentId
    const brief = this.briefs.get(agentId) ?? agent?.activity ?? ''
    const result = await integrateWorktree(this.root, info, `${name}: ${brief}`.slice(0, 120), this.reviewGate(agentId, info))
    this.set(agentId, result.info)
    const level = result.info.status === 'conflict' ? 'warn' : 'info'
    this.log(level, `${name}: ${result.message}`)
    if (result.info.status === 'held') {
      this.host.notify(
        `Harness: the user reviewed ${name}'s report and chose to hold it for later instead of merging. Its changes are NOT in the main checkout; ` +
          `they stay on branch ${result.info.branch} (worktree "${result.info.path}"). Do not build on them and do not merge the branch yourself; ` +
          `if you need them now, ask the user, or call ${INTEGRATE_TOOL}, which asks the user to review the branch again.`
      )
    } else if (result.info.status === 'removed' && result.info.changedFiles?.length) {
      this.host.notify(
        `Harness: the user reviewed ${name}'s report and discarded it. None of its changes were merged and its branch was deleted. Redo or reassign that work if it is still needed.`
      )
    }
    if (result.info.status === 'merged' || result.info.status === 'conflict') {
      this.host.notify(
        result.info.status === 'merged'
          ? `Harness: ${name}'s report was merged into the main checkout. ${result.message} Verify the merged result before relying on it.`
          : `Harness: ${name}'s report could not be merged automatically. ${result.message} Integrate branch ${result.info.branch} yourself (git merge in the main checkout, resolve conflicts, then git worktree remove --force "${result.info.path}" and git branch -d ${result.info.branch}), or commit your own changes and call ${INTEGRATE_TOOL}.`
      )
    }
  }

  /** Retry from the orchestrator's integrate tool: find the agent that owns the branch, or integrate anonymously. */
  async integratePending(wt: { path: string; branch: string }): Promise<string> {
    const ownerId = [...this.worktrees].find(([, info]) => info.branch === wt.branch)?.[0]
    const owner = ownerId ? this.host.agent(ownerId) : undefined
    const info: WorktreeInfo = {
      path: wt.path,
      branch: wt.branch,
      status: 'merging',
      changedFiles: ownerId ? this.worktrees.get(ownerId)?.changedFiles : undefined
    }
    if (ownerId) this.set(ownerId, info)
    const name = owner?.name ?? (ownerId ? ownerId : undefined)
    const brief = ownerId ? this.briefs.get(ownerId) ?? owner?.activity ?? '' : wt.branch
    const result = await integrateWorktree(this.root, info, `${name ?? 'report'}: ${brief}`.slice(0, 120), this.reviewGate(ownerId ?? null, info))
    if (ownerId) this.set(ownerId, result.info)
    this.log(result.info.status === 'conflict' ? 'warn' : 'info', `${name ?? wt.branch}: ${result.message}`)
    return `${wt.branch}: ${result.message}`
  }

  /**
   * With reviewMerges on, the gate integrateWorktree calls before merging: mark the worktree as
   * under review, show the diff to the user and wait for merge, discard or hold.
   */
  reviewGate(agentId: string | null, info: WorktreeInfo): ((changedFiles: string[]) => Promise<MergeDecision>) | undefined {
    if (!this.ctx.project.reviewMerges) return undefined
    return async (changedFiles) => {
      const owner = agentId ? this.host.agent(agentId) : undefined
      const ownerName = owner?.name ?? agentId ?? undefined
      if (agentId) this.set(agentId, { ...info, status: 'review', changedFiles })
      const diff = await diffWorktree(this.root, info.branch)
      this.log('info', `${ownerName ?? info.branch}: waiting for the user to review ${info.branch} before merging.`)
      const decision = await this.ctx.requestMergeReview({
        agentId: agentId ?? ROOT_AGENT_ID,
        agentName: ownerName ?? info.branch,
        branch: info.branch,
        path: info.path,
        changedFiles: diff.changedFiles.length ? diff.changedFiles : changedFiles,
        stat: diff.stat,
        patch: diff.patch
      })
      if (agentId && decision.behavior === 'merge') this.set(agentId, { ...info, status: 'merging', changedFiles })
      return decision
    }
  }

  /**
   * Report branches left by earlier runs (conflicts, crashes) must not be forgotten: commit any
   * uncommitted work so it is safe, then tell the orchestrator they exist. Returns that message.
   */
  async reconcileLeftovers(): Promise<string | null> {
    const pending = await inspectPending(this.root)
    if (!pending.length) return null
    const lines: string[] = []
    for (const wt of pending) {
      let note = ''
      if (wt.exists && wt.uncommittedFiles > 0) {
        const c = await commitLeftovers(wt.path, 'OrgAI: uncommitted work left by an earlier run')
        note = c.committed ? ' (uncommitted work was just committed to keep it safe)' : c.error ? ` (could not commit leftovers: ${c.error})` : ''
      }
      const files = wt.changedFiles.length ? `, touches ${wt.changedFiles.slice(0, 8).join(', ')}${wt.changedFiles.length > 8 ? ', …' : ''}` : ''
      lines.push(`- ${wt.branch}: ${wt.commitsAhead} commit(s) ahead${files}${wt.lastSubject ? `, last: "${wt.lastSubject}"` : ''}${note}`)
      this.log('warn', `Leftover report branch from an earlier run: ${wt.branch}${note}`)
    }
    return (
      `Harness: ${pending.length} report branch${pending.length === 1 ? '' : 'es'} from earlier runs ${pending.length === 1 ? 'is' : 'are'} still waiting in this repository:\n${lines.join('\n')}\n` +
      `Before new work, decide what to do with them: inspect with git log and git diff, then call ${INTEGRATE_TOOL} to merge the ones worth keeping, or tell the user which ones you recommend discarding. The user can also handle them from the project's maintenance panel.`
    )
  }
}
