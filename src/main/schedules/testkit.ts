/**
 * Test helpers for the schedules tests (service, scheduler): a real ScheduleStore in a temp dir and a ScheduleService
 * on fake deps that record every start. Not imported by production code.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, RunSummary } from '@shared/types'
import { ScheduleService, type ScheduleRunFacts, type ScheduleServiceDeps, type ScheduleStartInput } from './service'
import { ScheduleStore } from './store'

export interface FakeEnv {
  dir: string
  store: ScheduleStore
  service: ScheduleService
  clock: { now: number }
  projects: Map<string, Project>
  starts: { kind: 'team' | 'ask'; project?: Project; input: ScheduleStartInput & { team?: 'single'; folder?: string; allowEdits?: boolean } }[]
  facts: Map<string, ScheduleRunFacts>
  summaries: Map<string, RunSummary>
  notices: { title: string; body: string }[]
  changed: { scheduleIds: string[]; removed?: string[] }[]
  paused: { value: boolean }
  failStart: { message: string | null }
  folderProblems: Map<string, string>
  cleanup(): void
}

export function fakeProject(id: string, over: Partial<Project> = {}): Project {
  return { id, name: `Project ${id}`, path: `/tmp/${id}`, brief: '', permissionMode: 'default', roles: [], provider: { id: 'mock' }, ...over } as unknown as Project
}

let runSeq = 0

export function fakeEnv(over: Partial<ScheduleServiceDeps> = {}): FakeEnv {
  const dir = mkdtempSync(join(tmpdir(), 'orgai-sched-'))
  const store = new ScheduleStore(dir)
  const env: Omit<FakeEnv, 'service'> = {
    dir,
    store,
    clock: { now: new Date(2026, 10, 12, 10, 0, 0).getTime() },
    projects: new Map([['p1', fakeProject('p1')]]),
    starts: [],
    facts: new Map(),
    summaries: new Map(),
    notices: [],
    changed: [],
    paused: { value: false },
    failStart: { message: null },
    folderProblems: new Map(),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
  const started = (projectId: string): RunSummary => {
    if (env.failStart.message) throw new Error(env.failStart.message)
    const run = { id: `run_${++runSeq}`, projectId, status: 'running', kind: 'work', prompt: '', startedAt: env.clock.now, totalCostUsd: 0 } as RunSummary
    env.summaries.set(run.id, run)
    env.facts.set(run.id, { status: 'running', limitHold: false, pendingCards: 0 })
    return run
  }
  const service = new ScheduleService({
    store,
    now: () => env.clock.now,
    project: (id) => env.projects.get(id),
    folderProblem: (f) => env.folderProblems.get(f) ?? null,
    startTeam: async (project, input) => {
      env.starts.push({ kind: 'team', project, input })
      return started(project.id)
    },
    startAsk: async (input) => {
      env.starts.push({ kind: 'ask', input })
      return started('quick')
    },
    liveRunFacts: (id) => env.facts.get(id) ?? null,
    runSummary: (id) => env.summaries.get(id) ?? null,
    globallyPaused: () => env.paused.value,
    changed: (e) => env.changed.push(e),
    notify: (n) => env.notices.push({ title: n.title, body: n.body }),
    ...over
  })
  return { ...env, service }
}
