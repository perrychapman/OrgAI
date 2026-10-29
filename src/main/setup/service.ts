import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArchitectureSpec, Project, Proposal, ProjectSetup, RunRecord } from '@shared/types'
import { setupKindLabel } from '@shared/setup'
import { isPermissionMode } from '@shared/types'
import { MAX_AUTO_CONTINUES_LIMIT, MAX_CONCURRENT_SUBAGENTS_LIMIT, MAX_SUBAGENT_DEPTH_LIMIT } from '@shared/defaults'
import { addRules, isUnsafeAllowRule } from '../runtime/permissionRules'
import type { ProjectStore } from '../store/projects'
import { profileRepo, renderProfile } from './profile'

export const ARCHITECTURE_PATH = '.orgai/ARCHITECTURE.md'
export const CLAUDE_MD_MARKER = '<!-- orgai:architecture -->'

/**
 * Everything the AI-driven setup flow needs from the main process: profiling the
 * working directory, composing the Architect's first message, and applying what
 * the user approved to the project and the repo.
 */
export class SetupService {
  constructor(private projects: ProjectStore) {}

  /** Profile the working directory and record it on the project. */
  async prepare(project: Project): Promise<Project> {
    const profile = await profileRepo(project.path)
    const setup: ProjectSetup = {
      kind: project.setup?.kind ?? (profile.isEmpty ? 'new' : 'existing'),
      ...project.setup,
      state: project.setup?.state === 'complete' ? 'complete' : 'in_progress',
      profile
    }
    return this.projects.save({ ...project, setup })
  }

  /** The visible first message of a setup session. */
  displayPrompt(project: Project, instruction?: string): string {
    if (instruction?.trim()) return instruction.trim()
    const kind = project.setup?.kind ?? 'existing'
    return kind === 'new'
      ? `Set up this new project. Idea: ${project.brief.trim() || '(no description yet)'}`
      : `Read this existing project and set it up for OrgAI.`
  }

  /** The visible first message of a retrospective session. */
  retroPrompt(record: RunRecord): string {
    const task = record.summary.prompt.replace(/\s+/g, ' ').trim().slice(0, 140)
    return `Retrospective on the run "${task}${record.summary.prompt.length > 140 ? '…' : ''}": review how the org chart performed and propose the revisions it needs.`
  }

  /** What happened in a run, condensed for the Architect: outcomes per role, warnings, and the final report. */
  retroContext(record: RunRecord): string {
    const s = record.summary
    const agents = Object.values(record.agents)
    const byId = new Map(agents.map((a) => [a.id, a]))
    const mins = s.endedAt ? Math.round((s.endedAt - s.startedAt) / 60000) : null
    const lines: string[] = [
      `Run record (${s.kind} run ${s.id}): status ${s.status}, ${mins === null ? 'still open' : `${mins} min`}, estimated cost $${s.totalCostUsd.toFixed(2)}${s.error ? `, error: ${s.error}` : ''}.`,
      `Task: ${s.prompt.trim()}`,
      '',
      'Agents:'
    ]
    for (const a of agents) {
      const parent = a.parentId ? byId.get(a.parentId)?.name ?? a.parentId : null
      const wt = a.worktree ? `, branch ${a.worktree.status}${a.worktree.changedFiles?.length ? ` (${a.worktree.changedFiles.length} files)` : ''}` : ''
      const result = (a.result ?? a.lastText ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
      lines.push(
        `- ${a.name} [${a.roleSlug}, ${a.model ?? 'model unknown'}]${parent ? ` under ${parent}` : ''}: ${a.state}, ${a.inputTokens + a.outputTokens} tokens, $${a.costUsd.toFixed(2)}${wt}${result ? `. Report: ${result}` : ''}`
      )
    }
    const noteworthy = record.logs.filter((l) => l.level !== 'info').map((l) => `- [${l.level}] ${l.message.slice(0, 200)}`)
    if (noteworthy.length) lines.push('', 'Warnings and errors from the harness:', ...noteworthy.slice(0, 40))
    const denied = record.transcript.filter((e) => e.block.kind === 'tool_result' && e.block.isError).length
    if (denied) lines.push('', `${denied} tool call${denied === 1 ? '' : 's'} returned an error during the run.`)
    const userTurns = record.transcript.filter((e) => e.block.kind === 'user').map((e) => (e.block.kind === 'user' ? e.block.text : '')).slice(1)
    if (userTurns.length) lines.push('', 'Follow-up messages from the user during the run:', ...userTurns.map((t) => `- ${t.replace(/\s+/g, ' ').slice(0, 200)}`))
    const root = agents.find((a) => a.parentId === null)
    const finalText = record.transcript.filter((e) => e.agentId === root?.id && e.block.kind === 'text').map((e) => (e.block.kind === 'text' ? e.block.text : '')).pop()
    if (finalText) lines.push('', 'Final report from the orchestrator:', finalText.trim().slice(0, 2500))
    const text = lines.join('\n')
    return text.length > 14000 ? `${text.slice(0, 14000)}\n… (run record truncated)` : text
  }

  /** Context appended to the first message but kept out of the transcript. */
  hiddenContext(project: Project): string {
    const setup = project.setup
    const kind = setup?.kind ?? 'existing'
    const parts: string[] = [
      `Project name: ${project.name}`,
      `Working directory: ${project.path}`,
      `Setup kind: ${setupKindLabel(kind)}`,
      `Project brief or idea from the user: ${project.brief.trim() || '(none)'}`
    ]
    if (setup?.architecture) parts.push(`Previously approved architecture summary: ${setup.architecture.summary}`)
    if (project.roles.length) {
      parts.push(
        `Current org chart roles (revise rather than replace when they still fit): ${project.roles
          .map((r) => `${r.name} [${r.model}] -> ${project.roles.find((x) => x.id === r.reportsTo)?.name ?? 'root'}`)
          .join('; ')}`
      )
    }
    parts.push(`Repository profile:\n${setup?.profile ? renderProfile(setup.profile) : '(not scanned)'}`)
    return parts.join('\n\n')
  }

  /** Apply an approved proposal. Returns the saved project. */
  applyProposal(projectId: string, proposal: Proposal): Project {
    const project = this.projects.get(projectId)
    if (!project) throw new Error('Project not found')
    const setup: ProjectSetup = project.setup ?? { kind: 'existing', state: 'in_progress' }
    switch (proposal.kind) {
      case 'architecture': {
        const written = writeArchitecture(project.path, project.name, proposal.payload)
        return this.projects.save({ ...project, setup: { ...setup, architecture: proposal.payload, architecturePath: written } })
      }
      case 'orgChart':
        return this.projects.save({ ...project, roles: proposal.payload.roles, setup })
      case 'settings': {
        const p = proposal.payload
        const next: Project = { ...project, setup }
        if (typeof p.brief === 'string' && p.brief.trim()) next.brief = p.brief.trim()
        if (isPermissionMode(p.permissionMode)) next.permissionMode = p.permissionMode
        if (p.maxBudgetUsd === null) delete next.maxBudgetUsd
        else if (typeof p.maxBudgetUsd === 'number' && p.maxBudgetUsd > 0) next.maxBudgetUsd = p.maxBudgetUsd
        if (p.maxSubagentDepth) next.maxSubagentDepth = clamp(p.maxSubagentDepth, 1, MAX_SUBAGENT_DEPTH_LIMIT)
        if (p.maxConcurrentSubagents) next.maxConcurrentSubagents = clamp(p.maxConcurrentSubagents, 1, MAX_CONCURRENT_SUBAGENTS_LIMIT)
        if (typeof p.isolateWriters === 'boolean') next.isolateWriters = p.isolateWriters
        if (typeof p.reviewMerges === 'boolean') next.reviewMerges = p.reviewMerges
        if (typeof p.autoContinue === 'boolean') next.autoContinue = p.autoContinue
        if (typeof p.maxAutoContinues === 'number' && Number.isFinite(p.maxAutoContinues)) {
          next.maxAutoContinues = clamp(Math.floor(p.maxAutoContinues), 0, MAX_AUTO_CONTINUES_LIMIT)
        }
        // The safe-command allowlist lives with the other saved rules in .claude/settings.local.json.
        const rules = cleanAllowRules(p.allowRules)
        if (rules.length) addRules(project.path, rules)
        return this.projects.save(next)
      }
      case 'mcpServers':
        throw new Error('not implemented')
    }
  }

  markScaffolded(projectId: string): Project {
    const project = this.projects.get(projectId)
    if (!project) throw new Error('Project not found')
    const setup: ProjectSetup = { ...(project.setup ?? { kind: 'new', state: 'complete' }), scaffoldedAt: new Date().toISOString() }
    return this.projects.save({ ...project, setup })
  }

  /** An agent edited the architecture document during a work run. */
  markArchitectureUpdated(projectId: string): Project {
    const project = this.projects.get(projectId)
    if (!project) throw new Error('Project not found')
    const setup: ProjectSetup = { ...(project.setup ?? { kind: 'existing', state: 'complete' }), architectureUpdatedAt: new Date().toISOString() }
    return this.projects.save({ ...project, setup })
  }

  complete(projectId: string, summary: string): Project {
    const project = this.projects.get(projectId)
    if (!project) throw new Error('Project not found')
    const setup: ProjectSetup = {
      ...(project.setup ?? { kind: 'existing' }),
      state: 'complete',
      summary: summary.trim(),
      completedAt: new Date().toISOString()
    }
    return this.projects.save({ ...project, setup })
  }
}

/**
 * Trimmed, non-empty, de-duplicated rule strings. Non-strings and rules the harness never saves from a
 * proposal (bare shell access, destructive commands such as rm, git push or sudo) are dropped.
 */
export function cleanAllowRules(rules: unknown): string[] {
  if (!Array.isArray(rules)) return []
  const strings = rules.filter((r): r is string => typeof r === 'string').map((r) => r.trim())
  return [...new Set(strings.filter((r) => r && !isUnsafeAllowRule(r)))]
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/** Write the architecture document into the repo and make sure CLAUDE.md points at it. Returns the repo-relative path. */
function writeArchitecture(root: string, projectName: string, spec: ArchitectureSpec): string {
  mkdirSync(join(root, '.orgai'), { recursive: true })
  writeFileSync(join(root, ARCHITECTURE_PATH), renderArchitecture(projectName, spec), 'utf8')

  const claudeMd = join(root, 'CLAUDE.md')
  const existing = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : ''
  if (!existing.includes(CLAUDE_MD_MARKER)) {
    const block =
      `${CLAUDE_MD_MARKER}\n## Architecture and conventions\n\n` +
      `Read \`${ARCHITECTURE_PATH}\` before changing code. It records the agreed stack, module layout, conventions and commands for this project. Keep it current when they change.\n`
    const next = existing.trim() ? `${existing.trimEnd()}\n\n${block}` : `# ${projectName}\n\n${block}`
    writeFileSync(claudeMd, next, 'utf8')
  }
  return ARCHITECTURE_PATH
}

export function renderArchitecture(projectName: string, spec: ArchitectureSpec): string {
  const lines: string[] = [`# ${projectName} architecture`, '', spec.summary.trim(), '']
  if (spec.stack.length) lines.push('## Stack', '', ...spec.stack.map((s) => `- ${s}`), '')
  if (spec.modules.length) {
    lines.push('## Modules', '')
    for (const m of spec.modules) {
      lines.push(`### ${m.name}`, '', m.purpose)
      if (m.paths.length) lines.push('', ...m.paths.map((p) => `- \`${p}\``))
      lines.push('')
    }
  }
  if (spec.conventions.length) lines.push('## Conventions', '', ...spec.conventions.map((c) => `- ${c}`), '')
  if (spec.commands.length) lines.push('## Commands', '', ...spec.commands.map((c) => `- ${c.name}: \`${c.command}\``), '')
  if (spec.risks.length) lines.push('## Risks and gaps', '', ...spec.risks.map((r) => `- ${r}`), '')
  lines.push('_Maintained by OrgAI. Approved by the project owner during setup._', '')
  return lines.join('\n')
}
