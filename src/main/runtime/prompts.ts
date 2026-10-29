import type { Project, Role } from '@shared/types'
import { INTEGRATE_TOOL } from './harnessTools'

/**
 * Prompt text the harness gives every role, independent of the provider. Pure functions of the role,
 * the org chart, the project and a few run flags; adapters put the result wherever their SDK takes a
 * system prompt.
 */

const WRITE_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit'])

/** True when the role has a tool that edits files; such reports get a worktree when isolation is on. */
export function canWrite(role: Role): boolean {
  return role.tools.some((t) => WRITE_TOOLS.has(t))
}

export interface PromptFlags {
  /** Setup run (the Architect): no "no reports" fallback, no architecture or brief paragraphs. */
  isSetup: boolean
  /** Writing reports run in their own git worktrees. */
  isolation: boolean
}

/** The roles this role may delegate to. */
export function reportsOf(role: Role, roles: Role[]): Role[] {
  return roles.filter((r) => role.canSpawn && role.spawnable.includes(r.id))
}

export function reportsText(reports: Role[]): string {
  return (
    `You lead the following specialists. Delegate to them with the Agent tool, passing subagent_type exactly as written:\n` +
    reports.map((r) => `- ${r.slug}: ${r.description}`).join('\n') +
    `\nYou may only delegate to these roles. Give each delegate a complete, self-contained brief.`
  )
}

/** For the root orchestrator when isolation is on: how merges and conflicts work. */
export function orchestratorIsolationText(): string {
  return (
    `Parallel work is safe: every report that can edit files runs in its own git worktree, so you may delegate several tasks at once. ` +
    `When a report finishes, the harness commits its branch and merges it into the main checkout, then tells you the result in a message. ` +
    `If a merge conflicts, the branch is kept and you integrate it yourself: in the main checkout run git merge <branch>, resolve the conflicts, ` +
    `then git worktree remove --force <path> and git branch -d <branch>; or commit your own changes and call ${INTEGRATE_TOOL} to retry. ` +
    `Keep your own edits in the main checkout small while reports are running, commit them before retrying a merge, and verify the merged result (build, tests) before reporting to the user.`
  )
}

/** For a writing report when isolation is on: stay inside the worktree. */
export function reportIsolationText(): string {
  return (
    `You work in an isolated git worktree of the repository, on your own branch. Edit only files inside your current working directory; ` +
    `the main checkout is off limits and other reports cannot see your changes until they are merged. Do not run git merge, checkout, rebase or push. ` +
    `You may commit as you go; the harness commits anything left over and merges your branch when you report back. List every file you changed in your report.`
  )
}

export function architectureText(architecturePath: string): string {
  return `The agreed architecture and conventions live in ${architecturePath}. Read it before changing code and follow it.`
}

/** For the root orchestrator: keep the architecture document true when the work changes it. */
export function architectureDriftText(architecturePath: string): string {
  return `When a task changes the stack, module layout, conventions or commands, update ${architecturePath} in the same run so it stays true, and mention the update in your report.`
}

export function briefText(brief: string): string | null {
  return brief.trim() ? `About this project:\n${brief.trim()}` : null
}

export function buildRolePrompt(role: Role, roles: Role[], project: Project, flags: PromptFlags): string {
  const { isSetup, isolation } = flags
  const parts: string[] = [role.prompt.trim()]
  if (role.responsibilities.length) {
    parts.push(`Your responsibilities:\n${role.responsibilities.map((r) => `- ${r}`).join('\n')}`)
  }
  const reports = reportsOf(role, roles)
  if (reports.length) {
    parts.push(reportsText(reports))
    if (isolation && role.reportsTo === null) parts.push(orchestratorIsolationText())
  } else if (!isSetup) {
    parts.push('You have no reports. Do the assigned work yourself and report back concisely when finished.')
  }
  if (isolation && role.reportsTo !== null && canWrite(role)) parts.push(reportIsolationText())
  if (!isSetup) {
    const archPath = project.setup?.architecturePath
    if (archPath) {
      parts.push(architectureText(archPath))
      if (role.reportsTo === null) parts.push(architectureDriftText(archPath))
    }
    const brief = briefText(project.brief)
    if (brief) parts.push(brief)
  }
  return parts.join('\n\n')
}

/** The first user message: the prompt plus hidden harness context (repo profile, project facts). */
export function composeFirstMessage(prompt: string, hiddenContext?: string): string {
  return hiddenContext ? `${prompt}\n\n---\nContext from the harness (not visible to the user):\n${hiddenContext}` : prompt
}

/** True when a tool's file_path points at the project's architecture document (in the main checkout or a worktree). */
export function isArchitectureFile(filePath: unknown, architecturePath: string): boolean {
  if (typeof filePath !== 'string' || !filePath) return false
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  const file = norm(filePath)
  const target = norm(architecturePath)
  return file === target || file.endsWith(`/${target}`)
}
