import type { Project, Role } from '@shared/types'
import { newProject, singleRunProject } from '@shared/defaults'
import { jsonSchemaOf } from './codexProtocol'
import { codexToolsFor } from './codexAgents'
import { harnessToolsFor, type HarnessTool } from './harnessTools'
import type { RuntimeContext } from './types'

/**
 * Token-free size measurement of the harness tool definitions an agent receives, shared by
 * scripts/measure-prompt-size.mjs (the full report) and toolDefinitionSize.test.ts (the budget). No network, no SDK.
 * A tool's size is the JSON of what the model is sent: name, description and input schema.
 */

export const MEASURE_ARCH = 'docs/ARCHITECTURE.md'
export const MEASURE_BRIEF = 'Build a small web app for tracking tasks.'

/** The measured slugs of the default chart, plus 'single' for the single assistant. */
export type MeasureSlug = 'orchestrator' | 'implementer' | 'reviewer' | 'researcher' | 'single'

export interface MeasureCase {
  project: Project
  roleSlug: string
  team: 'single' | undefined
  isolation: boolean
}

/** The default code project (newProject) as one measured case: a role of the default chart, or the single assistant. */
export function measureCase(slug: MeasureSlug, opts: { isolation: boolean; arch: boolean }): MeasureCase {
  const base = newProject({ name: 'Measure', path: '/measure', brief: MEASURE_BRIEF })
  const stored: Project = { ...base, isolateWriters: opts.isolation, ...(opts.arch ? { setup: { kind: 'existing', state: 'done', architecturePath: MEASURE_ARCH } } : {}) } as Project
  if (slug === 'single') {
    const project = { ...singleRunProject(stored), isolateWriters: false }
    return { project, roleSlug: project.roles[0].slug, team: 'single', isolation: false }
  }
  return { project: stored, roleSlug: slug, team: undefined, isolation: opts.isolation }
}

/** A RuntimeContext with no-op round trips (the same fixture shape as testHelpers.fakeCtx, without vitest). */
export function measureCtx(project: Project, team: 'single' | undefined, dir: string): RuntimeContext {
  const p = { ...project, path: dir }
  let plan: unknown
  const noop = async (): Promise<void> => {}
  return {
    run: { id: 'run-1', projectId: p.id, kind: 'work', prompt: 'Do it', status: 'starting', startedAt: 0, totalCostUsd: 0, ...(team ? { team } : {}) },
    project: p,
    roles: p.roles,
    prompt: 'Do it',
    autoContinue: false,
    emit: () => {},
    requestPermission: async () => ({ behavior: 'allow' }),
    requestProposal: async () => ({ behavior: 'approve' }),
    requestMergeReview: async () => ({ behavior: 'merge' }),
    completeSetup: noop,
    requestQuestion: async () => ({ selected: [] }),
    noteArchitectureUpdated: noop,
    rateLimited: () => {},
    getPlan: () => plan,
    updatePlan: async (next: unknown) => {
      plan = next
    },
    pendingInteractions: () => 0,
    mcpServers: () => [],
    resolvedMcpServers: async () => [],
    plugins: () => [],
    searchMcpRegistry: async () => ({ entries: [] }),
    requestMcpInstall: async () => ({ approved: true, scope: 'run' })
  } as unknown as RuntimeContext
}

/** The harness tools an agent of this role is given (the root gets every one; both adapters filter the same way). */
export function harnessToolsForRole(harness: readonly HarnessTool[], role: Role, isRoot: boolean): HarnessTool[] {
  return harness.filter((t) => isRoot || t.audience === 'all' || (role.canSpawn && t.audience === 'spawners'))
}

/** One Claude tool definition as measured: the `mcp__orgai__` name, the description and the input schema. */
export function claudeToolDefinitionChars(t: Pick<HarnessTool, 'name' | 'description' | 'inputSchema'>): number {
  const name = `mcp__orgai__${t.name}`
  return JSON.stringify({ name, description: t.description, inputSchema: jsonSchemaOf(t.inputSchema) }).length
}

export interface ToolSizeRow {
  name: string
  chars: number
  descriptionChars: number
}

/** The Claude tool definitions of one case's role (the adapter loads skills natively, so no list_skills / load_skill). */
export function claudeToolSizes(c: MeasureCase): ToolSizeRow[] {
  const ctx = measureCtx(c.project, c.team, '/measure')
  const role = ctx.roles.find((r) => r.slug === c.roleSlug)!
  const harness = harnessToolsFor(ctx, {}, { nativeSkills: true })
  return harnessToolsForRole(harness, role, role.reportsTo === null).map((t) => ({ name: `mcp__orgai__${t.name}`, chars: claudeToolDefinitionChars(t), descriptionChars: t.description.length }))
}

/** The Codex dynamic tools of one case's role, built as CodexAdapter builds them (harness tools plus network tools). */
export function codexToolSizes(c: MeasureCase): ToolSizeRow[] {
  const ctx = measureCtx(c.project, c.team, '/measure')
  const role = ctx.roles.find((r) => r.slug === c.roleSlug)!
  const harness = harnessToolsFor(ctx, {}, { bridgeThroughSpawn: true })
  return codexToolsFor(harness, role, role.reportsTo === null, { setupLike: false }).specs.map((s) => ({ name: s.name, chars: JSON.stringify(s).length, descriptionChars: s.description.length }))
}

export const sumChars = (rows: readonly ToolSizeRow[]): number => rows.reduce((n, r) => n + r.chars, 0)
