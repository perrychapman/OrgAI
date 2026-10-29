import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MaintenanceResult, PendingWorktree, Project, WorktreeDiff } from '@shared/types'
import type { ProjectStore } from './store/projects'
import { ARCHITECTURE_PATH, CLAUDE_MD_MARKER } from './setup/service'
import { diffWorktree, discardWorktree, inspectPending, integrateWorktree, isGitRepo, removeExcludeLine } from './runtime/worktrees'

/**
 * Cleanup that happens outside a run: leftover report branches, and removing OrgAI's
 * footprint from a repository.
 */
export class MaintenanceService {
  constructor(private projects: ProjectStore) {}

  private project(id: string): Project {
    const p = this.projects.get(id)
    if (!p) throw new Error('Project not found')
    return p
  }

  listWorktrees(projectId: string): Promise<PendingWorktree[]> {
    return inspectPending(this.project(projectId).path)
  }

  private async find(projectId: string, branch: string): Promise<{ root: string; wt: PendingWorktree }> {
    const root = this.project(projectId).path
    const wt = (await inspectPending(root)).find((w) => w.branch === branch)
    if (!wt) throw new Error(`Branch ${branch} is not a pending report branch`)
    return { root, wt }
  }

  async integrateWorktree(projectId: string, branch: string): Promise<MaintenanceResult> {
    const { root, wt } = await this.find(projectId, branch)
    const result = await integrateWorktree(root, { path: wt.path, branch: wt.branch, status: 'merging' }, `${wt.lastSubject ?? 'Leftover report'} (integrated from maintenance)`)
    return { ok: result.info.status === 'merged' || result.info.status === 'empty', message: result.message }
  }

  async discardWorktree(projectId: string, branch: string): Promise<MaintenanceResult> {
    const { root, wt } = await this.find(projectId, branch)
    await discardWorktree(root, wt)
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
    if (isGitRepo(root)) {
      const holding = (await inspectPending(root)).filter((w) => w.uncommittedFiles > 0 || w.commitsAhead > 0)
      if (holding.length) {
        return {
          ok: false,
          message: `${holding.length} report branch${holding.length === 1 ? ' still holds' : 'es still hold'} unmerged work (${holding.map((w) => w.branch).join(', ')}). Integrate or discard them first.`
        }
      }
      for (const w of await inspectPending(root)) await discardWorktree(root, w)
    }

    const removed: string[] = []
    const archFile = join(root, ARCHITECTURE_PATH)
    if (existsSync(archFile)) {
      unlinkSync(archFile)
      removed.push(ARCHITECTURE_PATH)
      const dir = join(root, '.orgai')
      try {
        if (existsSync(dir) && readdirSync(dir).filter((n) => n !== '.DS_Store').length === 0) {
          rmSync(join(dir, '.DS_Store'), { force: true }) // Finder litter on macOS
          rmdirSync(dir)
        }
      } catch {
        /* leave it */
      }
    }

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
