import type { AppSettings, ImageMediaType, Project, Role, SetupKind, ToolName } from './types'
import { DEFAULT_KEEP_RUNS, DEFAULT_MAX_AUTO_CONTINUES } from './types'

/** Run limits for new projects: enough parallel reports for a real team, and room for leads with their own reports. */
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 8
export const DEFAULT_MAX_SUBAGENT_DEPTH = 3
/** Upper bounds of the run-limit settings (settings inputs, proposal schema, applying proposals). */
export const MAX_CONCURRENT_SUBAGENTS_LIMIT = 32
export const MAX_SUBAGENT_DEPTH_LIMIT = 5
/** Upper bound of maxAutoContinues (settings inputs, proposal schema, applying proposals). */
export const MAX_AUTO_CONTINUES_LIMIT = 500

/** Image types the composer accepts and the main process forwards to the provider. */
export const SUPPORTED_IMAGE_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** Largest image accepted, in decoded bytes (Anthropic's per-image limit). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
/** Most images sent with one user message. */
export const MAX_IMAGES_PER_MESSAGE = 10

export const ROLE_COLORS = ['#7c5cff', '#2bb0ff', '#22c58b', '#f5a524', '#ff6b6b', '#e879f9', '#38bdf8', '#a3e635']

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultPermissionMode: 'auto',
  defaultMaxBudgetUsd: undefined,
  defaultKeepRuns: DEFAULT_KEEP_RUNS,
  defaultIsolateWriters: true,
  defaultRootModel: 'opus',
  defaultReportModel: 'sonnet',
  providerAuth: { kind: 'subscription' },
  notifications: true,
  opusGuardThreshold: 80,
  defaultPreferSonnetNearLimit: false,
  defaultAutoContinue: true,
  defaultMaxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES
}

/** Provider label matching an auth choice. */
export function claudeProviderLabel(auth: AppSettings['providerAuth']): string {
  return auth.kind === 'apiKey' ? `Claude (API key from ${auth.envVar})` : 'Claude (Claude Code login)'
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'role'
  )
}

export function newId(prefix = ''): string {
  const rnd = Math.random().toString(36).slice(2, 10)
  const stamp = Date.now().toString(36)
  return prefix ? `${prefix}_${stamp}${rnd}` : `${stamp}${rnd}`
}

const READ_ONLY: ToolName[] = ['Read', 'Glob', 'Grep']
const FULL: ToolName[] = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']

/**
 * A sensible starting org for a coding project: one orchestrator with three
 * purpose-built reports. The AI drafter can replace or revise it.
 */
export function defaultRoles(): Role[] {
  const orchestrator: Role = {
    id: newId('role'),
    slug: 'orchestrator',
    name: 'Orchestrator',
    description:
      'Lead agent. Plans the work, delegates to specialists, integrates results and reports to the user.',
    responsibilities: [
      'Understand the request and break it into well-scoped tasks',
      'Delegate each task to the most suitable specialist',
      'Review returned work for correctness and integration',
      'Keep the user informed with concise status and a final summary'
    ],
    prompt: `You are the lead engineer and orchestrator for this project.
Plan before acting. Delegate implementation, review and testing to your specialist reports instead of doing everything yourself. Give each delegate a precise brief: the files involved, the acceptance criteria, and anything already decided. Integrate their results, verify the whole, and report back to the user with what changed and what remains.`,
    tools: FULL,
    model: 'opus',
    canSpawn: true,
    spawnable: [],
    reportsTo: null,
    position: { x: 0, y: 0 },
    color: ROLE_COLORS[0]
  }
  const implementer: Role = {
    id: newId('role'),
    slug: 'implementer',
    name: 'Implementer',
    description:
      'Writes and edits code to complete a precisely scoped task. Use for feature work and bug fixes.',
    responsibilities: [
      'Implement the assigned change end to end',
      'Keep edits minimal and consistent with the codebase',
      'Run the relevant build or tests before reporting'
    ],
    prompt: `You are a senior software engineer. Implement exactly the task you are given. Read the surrounding code first, follow existing conventions, and run the relevant build or tests before you report. Report what you changed, file by file, and anything you could not verify.`,
    tools: FULL,
    model: 'sonnet',
    canSpawn: false,
    spawnable: [],
    reportsTo: orchestrator.id,
    position: { x: -280, y: 200 },
    color: ROLE_COLORS[1]
  }
  const reviewer: Role = {
    id: newId('role'),
    slug: 'reviewer',
    name: 'Reviewer',
    description:
      'Read-only code reviewer. Use to check a change for bugs, security issues and missed cases.',
    responsibilities: [
      'Review diffs for correctness and risk',
      'Call out missing tests and edge cases',
      'Never modify files'
    ],
    prompt: `You are a meticulous code reviewer. You may read anything but must not modify files. Review the described change for correctness bugs, security problems, and missed edge cases. Report findings ranked by severity with file and line references, and say explicitly when you find nothing.`,
    tools: READ_ONLY,
    model: 'sonnet',
    canSpawn: false,
    spawnable: [],
    reportsTo: orchestrator.id,
    position: { x: 0, y: 200 },
    color: ROLE_COLORS[2]
  }
  const researcher: Role = {
    id: newId('role'),
    slug: 'researcher',
    name: 'Researcher',
    description:
      'Explores the codebase or the web to answer a question. Use before planning when context is missing.',
    responsibilities: [
      'Locate relevant code, docs and prior decisions',
      'Summarize findings with references',
      'Never modify files'
    ],
    prompt: `You are a research specialist. Find and summarize the information requested, citing file paths or URLs. Be concise and concrete. Do not modify files.`,
    tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    model: 'haiku',
    canSpawn: false,
    spawnable: [],
    reportsTo: orchestrator.id,
    position: { x: 280, y: 200 },
    color: ROLE_COLORS[3]
  }
  orchestrator.spawnable = [implementer.id, reviewer.id, researcher.id]
  return [orchestrator, implementer, reviewer, researcher]
}

export function newProject(input: { name: string; path: string; brief: string; setupKind?: SetupKind }, settings?: AppSettings): Project {
  const now = new Date().toISOString()
  let roles = defaultRoles()
  if (settings) {
    roles = roles.map((r) => ({ ...r, model: r.reportsTo === null ? settings.defaultRootModel : settings.defaultReportModel }))
    const auth = settings.providerAuth.kind === 'apiKey' ? { kind: 'apiKey' as const, envVar: settings.providerAuth.envVar } : { kind: 'subscription' as const }
    return {
      id: newId('proj'),
      name: input.name,
      path: input.path,
      brief: input.brief,
      provider: { id: 'claude', label: claudeProviderLabel(auth), auth },
      permissionMode: settings.defaultPermissionMode,
      maxBudgetUsd: settings.defaultMaxBudgetUsd,
      maxSubagentDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
      maxConcurrentSubagents: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
      isolateWriters: settings.defaultIsolateWriters,
      keepRuns: settings.defaultKeepRuns,
      preferSonnetNearLimit: settings.defaultPreferSonnetNearLimit,
      autoContinue: settings.defaultAutoContinue,
      maxAutoContinues: settings.defaultMaxAutoContinues,
      roles,
      setup: input.setupKind ? { kind: input.setupKind, state: 'pending' } : undefined,
      createdAt: now,
      updatedAt: now
    }
  }
  return {
    id: newId('proj'),
    name: input.name,
    path: input.path,
    brief: input.brief,
    provider: { id: 'claude', label: 'Claude (Claude Code login)', auth: { kind: 'subscription' } },
    permissionMode: 'auto',
    maxSubagentDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
    maxConcurrentSubagents: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    isolateWriters: true,
    roles: defaultRoles(),
    setup: input.setupKind ? { kind: input.setupKind, state: 'pending' } : undefined,
    createdAt: now,
    updatedAt: now
  }
}

/** Root orchestrator = the role with no manager. Falls back to the first role. */
export function rootRole(project: Project): Role | undefined {
  return project.roles.find((r) => r.reportsTo === null) ?? project.roles[0]
}
