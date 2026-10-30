import type { AgentInstance, MergeDecision, WorktreeInfo, WorktreeStatus } from '@shared/types'
import { ROOT_AGENT_ID, type RuntimeContext } from './types'
import { INTEGRATE_TOOL } from './harnessTools'
import { commitLeftovers, diffWorktree, findWorktree, inspectPending, integrateWorktree, prepareRepo, type MergeSnapshot } from './worktrees'

/**
 * The per-run worktree state machine, shared by every adapter whose writing reports work in git
 * worktrees: active -> (waiting-children ->) merging -> (review ->) merged | empty | conflict | held | removed.
 * worktrees.ts is the git layer; this class decides when to call it, keeps each isolated agent's
 * WorktreeInfo, logs through ctx.emit and tells the orchestrator what landed through `notify`.
 *
 * Nested isolation: a report spawned by an isolated report is tracked with mergeTarget 'parent'
 * and parentAgentId. When it finishes it merges into its parent's worktree (the parent's branch),
 * not the main checkout; the parent's branch carries it to the main checkout later.
 *
 * Ordering. Reports run in the background, so a parent may finish before its children. A parent
 * that finishes while any child is unsettled (active, waiting-children, merging, review) has its
 * own leftovers committed and waits in 'waiting-children'; the last child to settle triggers the
 * parent's integration. Settled means merged, empty, removed, held or conflict: a child that
 * conflicts against its parent (or is held by the user) is left pending on its branch, the
 * orchestrator is told both branch names, and the parent still merges without it. When the parent
 * then leaves, the git layer moves the child's worktree out of the parent's directory, and the
 * child's merge target becomes the main checkout.
 *
 * Merges into the same working directory are serialized (git takes one index lock per worktree),
 * including the review wait, so a reviewed diff is the diff that gets merged.
 */

export interface IntegratorHost {
  /** The adapter's current snapshot of an agent (for its name and activity). */
  agent(id: string): AgentInstance | undefined
  /** Put the worktree state on the agent and emit agent.upsert. */
  setWorktree(agentId: string, info: WorktreeInfo): void
  /** Deliver a harness message to the orchestrator (starting a new turn if it is idle). */
  notify(text: string): void
}

/** States in which an agent's branch is still on its way; a parent waits for children in these. */
const UNSETTLED: ReadonlySet<WorktreeStatus> = new Set<WorktreeStatus>(['active', 'waiting-children', 'merging', 'review'])
/** States in which the worktree is gone for good. */
const GONE: ReadonlySet<WorktreeStatus> = new Set<WorktreeStatus>(['merged', 'empty', 'removed'])

interface MergeTarget {
  /** Working directory the merge runs in. */
  root: string
  /** Set when merging into a parent report's worktree. */
  parent?: { id: string; name: string; branch: string; path: string }
}

export class WorktreeIntegrator {
  /** Isolated agents by agent id. */
  private worktrees = new Map<string, WorktreeInfo>()
  /** agent id -> the brief it was spawned with, for commit messages. */
  private briefs = new Map<string, string>()
  /** Per working directory: the tail of the queue of git operations that write to it. */
  private locks = new Map<string, Promise<unknown>>()

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

  private nameOf(agentId: string): string {
    return this.host.agent(agentId)?.name ?? agentId
  }

  /** Run `fn` after every earlier operation on the same working directory has finished. */
  private exclusive<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const key = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const prev = this.locks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.locks.set(key, tail)
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    })
    return next
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

  /** Tracked isolated children of an agent. */
  private childrenOf(agentId: string): [string, WorktreeInfo][] {
    return [...this.worktrees].filter(([, info]) => info.parentAgentId === agentId)
  }

  private unsettledChildren(agentId: string): number {
    return this.childrenOf(agentId).filter(([, info]) => UNSETTLED.has(info.status)).length
  }

  /**
   * A finished isolated report gets its branch committed and merged exactly once. If its own
   * isolated reports are still running or merging, it waits for them first.
   */
  async onSubagentFinished(agentId: string): Promise<void> {
    const wt = this.worktrees.get(agentId)
    if (!wt || wt.status !== 'active') return
    const waitingOn = this.unsettledChildren(agentId)
    if (!waitingOn) {
      this.set(agentId, { ...wt, status: 'merging' })
      return this.integrate(agentId)
    }
    this.set(agentId, { ...wt, status: 'waiting-children' })
    const name = this.nameOf(agentId)
    this.log('info', `${name} finished; its branch ${wt.branch} merges after its ${waitingOn} isolated report${waitingOn === 1 ? '' : 's'} are integrated into it.`)
    // Commit the parent's own work now, so its reports merge into a clean, committed worktree.
    const path = (await findWorktree(this.root, agentId))?.path ?? wt.path
    const brief = this.briefs.get(agentId) ?? this.host.agent(agentId)?.activity ?? ''
    const commit = await this.exclusive(path, () => commitLeftovers(path, `${name}: ${brief}`.slice(0, 120)))
    if (commit.error) this.log('warn', `${name}: could not commit its own changes before its reports merge: ${commit.error}`)
    // Children may have settled while we were committing.
    await this.settle(agentId)
  }

  /** Integrate a parent that is waiting for children once none is left unsettled. */
  private async settle(agentId: string | undefined): Promise<void> {
    if (!agentId) return
    const wt = this.worktrees.get(agentId)
    if (!wt || wt.status !== 'waiting-children' || this.unsettledChildren(agentId)) return
    this.set(agentId, { ...wt, status: 'merging' })
    await this.integrate(agentId)
  }

  /** Where an agent's branch merges right now: its live parent's worktree, or the main checkout. */
  private async targetFor(info: WorktreeInfo): Promise<MergeTarget> {
    const parentId = info.mergeTarget === 'parent' ? info.parentAgentId : undefined
    const parent = parentId ? this.worktrees.get(parentId) : undefined
    if (!parentId || !parent || GONE.has(parent.status)) return { root: this.root }
    const located = await findWorktree(this.root, parentId)
    // A parent that is still running or waiting has a worktree by definition; a parent left pending
    // (conflict, held) only counts while git still knows its worktree.
    if (!located && parent.status !== 'active' && parent.status !== 'waiting-children') return { root: this.root }
    const path = located?.path ?? parent.path
    return { root: path, parent: { id: parentId, name: this.nameOf(parentId), branch: located?.branch ?? parent.branch, path } }
  }

  private async integrate(agentId: string): Promise<void> {
    const located = await findWorktree(this.root, agentId)
    const info: WorktreeInfo = { ...this.worktrees.get(agentId)!, ...(located ?? {}), status: 'merging' }
    const target = await this.targetFor(info)
    const agent = this.host.agent(agentId)
    const name = agent?.name ?? agentId
    const brief = this.briefs.get(agentId) ?? agent?.activity ?? ''
    const result = await this.exclusive(target.root, () =>
      integrateWorktree(target.root, info, `${name}: ${brief}`.slice(0, 120), this.reviewGate(agentId, info, target.root))
    )
    this.set(agentId, result.info)
    const level = result.info.status === 'conflict' ? 'warn' : 'info'
    this.log(level, `${name}: ${result.message}`)
    if (target.parent) this.notifyNested(name, result.info, result.message, target.parent)
    else this.notifyMain(name, result.info, result.message)
    if (!target.parent && GONE.has(result.info.status)) await this.retarget(agentId)
    await this.settle(info.parentAgentId)
  }

  /** Messages for a report that merged (or not) into the main checkout. */
  private notifyMain(name: string, info: WorktreeInfo, message: string): void {
    if (info.status === 'held') {
      this.host.notify(
        `Harness: the user reviewed ${name}'s report and chose to hold it for later instead of merging. Its changes are NOT in the main checkout; ` +
          `they stay on branch ${info.branch} (worktree "${info.path}"). Do not build on them and do not merge the branch yourself; ` +
          `if you need them now, ask the user, or call ${INTEGRATE_TOOL}, which asks the user to review the branch again.`
      )
    } else if (info.status === 'removed' && info.changedFiles?.length) {
      this.host.notify(
        `Harness: the user reviewed ${name}'s report and discarded it. None of its changes were merged and its branch was deleted. Redo or reassign that work if it is still needed.`
      )
    } else if (info.status === 'merged') {
      this.host.notify(`Harness: ${name}'s report was merged into the main checkout. ${message} Verify the merged result before relying on it.`)
    } else if (info.status === 'conflict') {
      this.host.notify(
        `Harness: ${name}'s report could not be merged automatically. ${message} Integrate branch ${info.branch} yourself (git merge in the main checkout, resolve conflicts, then git worktree remove --force "${info.path}" and git branch -d ${info.branch}), or commit your own changes and call ${INTEGRATE_TOOL}.`
      )
    }
  }

  /**
   * Messages for a nested report that merged (or not) into its parent's worktree. A clean merge is
   * only logged: the parent verifies it and its own branch brings it to the main checkout.
   */
  private notifyNested(name: string, info: WorktreeInfo, message: string, parent: NonNullable<MergeTarget['parent']>): void {
    const later =
      `${parent.name}'s branch ${parent.branch} still merges into the main checkout when ${parent.name} finishes, without these changes; ` +
      `branch ${info.branch} then stays pending in the main checkout.`
    if (info.status === 'held') {
      this.host.notify(
        `Harness: the user reviewed ${name}'s report (spawned by ${parent.name}) and chose to hold it instead of merging it into ${parent.name}'s branch ${parent.branch}. ` +
          `Its changes stay on branch ${info.branch} (worktree "${info.path}"). ${later} Do not build on them; if they are needed, ask the user or call ${INTEGRATE_TOOL}.`
      )
    } else if (info.status === 'removed' && info.changedFiles?.length) {
      this.host.notify(
        `Harness: the user reviewed ${name}'s report (spawned by ${parent.name}) and discarded it. None of its changes reached ${parent.name}'s branch ${parent.branch}. Redo or reassign that work if it is still needed.`
      )
    } else if (info.status === 'conflict') {
      this.host.notify(
        `Harness: ${name}'s report (spawned by ${parent.name}) could not be merged into ${parent.name}'s worktree automatically. ${message} ` +
          `Child branch: ${info.branch} (worktree "${info.path}"). Parent branch: ${parent.branch} (worktree "${parent.path}"). ${later} ` +
          `After that, integrate ${info.branch} in the main checkout (git merge ${info.branch}, resolve conflicts, then git worktree remove --force <its worktree> and git branch -d ${info.branch}), or call ${INTEGRATE_TOOL}.`
      )
    }
  }

  /**
   * After a parent merged into the main checkout, children it left pending (conflict, held) now
   * target the main checkout; their worktrees were moved out of the parent's directory.
   */
  private async retarget(parentId: string): Promise<void> {
    for (const [childId, child] of this.childrenOf(parentId)) {
      if (UNSETTLED.has(child.status) || GONE.has(child.status)) continue
      const located = await findWorktree(this.root, childId)
      this.set(childId, { ...child, ...(located ?? {}), mergeTarget: 'main' })
    }
  }

  /** Retry from the orchestrator's integrate tool: find the agent that owns the branch, or integrate anonymously. */
  async integratePending(wt: { path: string; branch: string }): Promise<string> {
    const ownerId = [...this.worktrees].find(([, info]) => info.branch === wt.branch)?.[0]
    const tracked = ownerId ? this.worktrees.get(ownerId) : undefined
    if (tracked && UNSETTLED.has(tracked.status)) {
      return `${wt.branch}: still in progress (${tracked.status}); the harness merges it when its report finishes.`
    }
    const owner = ownerId ? this.host.agent(ownerId) : undefined
    const info: WorktreeInfo = {
      ...(tracked ?? {}),
      path: wt.path,
      branch: wt.branch,
      status: 'merging',
      changedFiles: tracked?.changedFiles
    }
    const target = await this.targetFor(info)
    const parentState = target.parent ? this.worktrees.get(target.parent.id)?.status : undefined
    if (parentState === 'merging' || parentState === 'review') {
      return `${wt.branch}: its parent ${target.parent!.name} is being merged right now; retry after that finishes.`
    }
    if (ownerId) this.set(ownerId, info)
    const name = owner?.name ?? (ownerId ? ownerId : undefined)
    const brief = ownerId ? this.briefs.get(ownerId) ?? owner?.activity ?? '' : wt.branch
    const result = await this.exclusive(target.root, () =>
      integrateWorktree(target.root, info, `${name ?? 'report'}: ${brief}`.slice(0, 120), this.reviewGate(ownerId ?? null, info, target.root))
    )
    if (ownerId) this.set(ownerId, result.info)
    this.log(result.info.status === 'conflict' ? 'warn' : 'info', `${name ?? wt.branch}: ${result.message}`)
    if (ownerId && !target.parent && GONE.has(result.info.status)) await this.retarget(ownerId)
    return `${wt.branch}: ${result.message}`
  }

  /**
   * With reviewMerges on, the gate integrateWorktree calls before merging: mark the worktree as
   * under review, show the diff to the user and wait for merge, discard or hold. `targetRoot` is
   * where the branch merges (the main checkout, or the parent's worktree for a nested report),
   * so the diff is against that checkout's HEAD.
   */
  reviewGate(
    agentId: string | null,
    info: WorktreeInfo,
    targetRoot: string = this.root
  ): ((snapshot: MergeSnapshot) => Promise<MergeDecision>) | undefined {
    if (!this.ctx.project.reviewMerges) return undefined
    return async ({ changedFiles, sourceOid, targetOid }) => {
      const owner = agentId ? this.host.agent(agentId) : undefined
      const ownerName = owner?.name ?? agentId ?? undefined
      if (agentId) this.set(agentId, { ...info, status: 'review', changedFiles })
      const diff = await diffWorktree(targetRoot, sourceOid, targetOid)
      const into = targetRoot === this.root ? '' : ` into ${info.parentBranch ?? targetRoot}`
      this.log('info', `${ownerName ?? info.branch}: waiting for the user to review ${info.branch} before merging${into}.`)
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
