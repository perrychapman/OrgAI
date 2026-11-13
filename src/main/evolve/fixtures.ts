import type { AgentInstance, PlanStep, Project, Role, RunRecord, StaffingAssignment, TranscriptEntry } from '../../shared/types'

/** Test builders for the evolve engine (not imported by production code). */

export function role(slug: string, over: Partial<Role> = {}): Role {
  return {
    id: `r_${slug}`,
    slug,
    name: slug,
    description: `${slug} role`,
    responsibilities: [],
    prompt: `You are the ${slug}.`,
    tools: ['Read', 'Glob', 'Grep'],
    model: 'everyday',
    tier: 'everyday',
    canSpawn: false,
    spawnable: [],
    reportsTo: 'r_lead',
    position: { x: 0, y: 0 },
    color: '#888',
    ...over
  }
}

export function project(over: Partial<Project> = {}, roles?: Role[]): Project {
  return {
    id: 'p1',
    name: 'Demo',
    path: '/work/demo',
    brief: 'brief',
    provider: { id: 'claude', auth: { kind: 'subscription' } } as Project['provider'],
    permissionMode: 'acceptEdits',
    roles: roles ?? [
      role('lead', { id: 'r_lead', reportsTo: null, canSpawn: true, spawnable: ['r_dev', 'r_review'], tier: 'deep', model: 'deep', tools: ['Read', 'Glob', 'Grep'] }),
      role('dev', { id: 'r_dev', tools: ['Read', 'Edit', 'Write', 'Bash'], tier: 'deep', model: 'deep', effort: 'high' }),
      role('review', { id: 'r_review', name: 'Reviewer', tools: ['Read', 'Grep'] })
    ],
    ...over
  } as Project
}

let seq = 0

export interface AgentSpec {
  slug: string
  state?: AgentInstance['state']
  parent?: string | null
  start?: number
  end?: number
  turns?: number
  out?: number
  inTok?: number
  cost?: number
  conflict?: boolean
  files?: string[]
  result?: string
  verdict?: 'ok' | 'failed'
  id?: string
}

export function agent(spec: AgentSpec, roleId?: string): AgentInstance {
  const id = spec.id ?? `a${++seq}`
  const t0 = spec.start ?? 1000
  return {
    id,
    roleId: roleId ?? `r_${spec.slug}`,
    roleSlug: spec.slug,
    name: spec.slug,
    parentId: spec.parent === undefined ? 'root' : spec.parent,
    spawnToolUseId: null,
    state: spec.state ?? 'done',
    activity: '',
    inputTokens: spec.inTok ?? 1000,
    outputTokens: spec.out ?? 500,
    costUsd: spec.cost ?? 0.1,
    usage: {
      tokens: { input: spec.inTok ?? 1000, output: spec.out ?? 500, cacheRead: 0, cacheWrite: 0 },
      models: [],
      costUsd: spec.cost ?? 0.1,
      costSource: 'provider',
      turns: spec.turns ?? 3,
      toolCalls: 4,
      retries: 0
    },
    startedAt: t0,
    endedAt: spec.end ?? t0 + 5000,
    result: spec.result ?? 'ok',
    ...(spec.verdict ? { delegation: { verdict: spec.verdict, missing: [], corrected: false, nativeSpawns: 0 } } : {}),
    ...(spec.conflict || spec.files ? { worktree: { path: '/wt', branch: 'b', status: spec.conflict ? 'conflict' : 'merged', changedFiles: spec.files } } : {})
  } as AgentInstance
}

export interface RunSpec {
  id?: string
  startedAt?: number
  agents?: AgentSpec[]
  status?: 'finished' | 'error'
  cost?: number
  wallMs?: number
  steps?: PlanStep[]
  assignments?: Partial<StaffingAssignment>[]
  transcript?: TranscriptEntry[]
  quick?: boolean
  kind?: 'work' | 'setup'
}

export function run(spec: RunSpec = {}): RunRecord {
  const id = spec.id ?? `run${++seq}`
  const startedAt = spec.startedAt ?? 1_000_000 + seq * 100_000
  const agents: Record<string, AgentInstance> = { root: agent({ slug: 'lead', id: 'root', parent: null, start: startedAt, end: startedAt + 60_000 }, 'r_lead') }
  for (const a of spec.agents ?? []) {
    const ag = agent({ ...a, start: a.start ?? startedAt + 1000, parent: a.parent })
    agents[ag.id] = ag
  }
  return {
    summary: {
      id,
      projectId: 'p1',
      kind: spec.kind ?? 'work',
      prompt: 'do it',
      status: spec.status ?? 'finished',
      startedAt,
      endedAt: startedAt + (spec.wallMs ?? 60_000),
      totalCostUsd: spec.cost ?? 1,
      usage: { tokens: { input: 50_000, output: 5000, cacheRead: 0, cacheWrite: 0 }, costUsd: spec.cost ?? 1, costSource: 'provider', models: [], roles: [], wallMs: spec.wallMs ?? 60_000, turns: 5, toolCalls: 5, retries: 0, agents: 3, agentsWithoutResult: 0, noResultTokens: 0, nudges: 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, updatedAt: 0 },
      ...(spec.quick ? { quick: { folder: '/x', team: 'default', allowEdits: false, gitRepo: false } } : {})
    },
    agents,
    transcript: spec.transcript ?? [],
    logs: [],
    ...(spec.steps ? { plan: { goal: 'g', steps: spec.steps, status: 'done', autoContinues: 0, updatedAt: 0 } } : {}),
    ...(spec.assignments ? { staffing: { goal: 'balanced', assignments: spec.assignments.map((a) => ({ roleId: 'r_dev', model: 'deep', source: 'role', at: 0, ...a })) as StaffingAssignment[] } } : {})
  } as unknown as RunRecord
}

export const entry = (agentId: string, block: TranscriptEntry['block'], at = 1): TranscriptEntry => ({ id: `e${++seq}`, agentId, at, block })
