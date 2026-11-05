import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, RunEvent } from '@shared/types'
import { RunManager } from './runManager'
import { MockAdapter } from './mock'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { RunStore } from '../store/runs'
import { SetupService } from '../setup/service'
import { createProject, listOrgai, makeComputer, readOrgai, rolePath, type Computer } from '../teamFiles/service.fixture'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let root: string
let repo: string
let c: Computer
let events: RunEvent[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-rm-team-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
  c = makeComputer(root, 'a', repo)
  events = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function manager(adapter: RuntimeAdapter): RunManager {
  const setup = new SetupService(c.projects, {})
  return new RunManager({ mock: adapter }, (e) => void events.push(e), new RunStore(join(c.data)), setup, () => 100, { teamFiles: c.svc, dataDir: c.data })
}

/** The mock adapter that keeps every RuntimeContext it was started with. */
function capturing(): { adapter: RuntimeAdapter; contexts: RuntimeContext[] } {
  const real = new MockAdapter({ script: { delayMs: 0 } })
  const contexts: RuntimeContext[] = []
  const adapter = Object.assign(Object.create(real) as RuntimeAdapter, {
    start: (ctx: RuntimeContext) => {
      contexts.push(ctx)
      return real.start(ctx)
    }
  })
  return { adapter, contexts }
}

async function until(pred: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out; saw ${events.map((e) => e.type).join(', ')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** The default script either goes idle or stops at its first permission card; both mean the session is up and running. */
const settled = (runId: string): Promise<void> => until(() => events.some((e) => e.runId === runId && (e.type === 'permission.request' || (e.type === 'run.status' && e.status === 'idle'))))

const mockProject = (): Project => createProject(c, { mock: true })

describe('RunManager and team files (mock adapter)', () => {
  it('a run on a project with no files writes them at start and the default script still works', async () => {
    const p = mockProject()
    expect(listOrgai(repo)).toEqual([])
    const { adapter } = capturing()
    const m = manager(adapter)
    const run = await m.start({ project: p, prompt: 'Do the thing' })
    expect(listOrgai(repo)).toContain('team.json')
    await settled(run.id)
    expect(events.some((e) => e.type === 'agent.upsert')).toBe(true)
    await m.stop(run.id)
  })

  it('a file change after start never reaches the running project; the next run gets the approved change and a warning for a pending one', async () => {
    const p = mockProject()
    c.svc.status(p.id)
    const { adapter, contexts } = capturing()
    const m = manager(adapter)
    const run = await m.start({ project: c.projects.get(p.id)!, prompt: 'First run' })
    await settled(run.id)
    const ctx = contexts[0]
    const reviewer = (project: Project) => project.roles.find((r) => r.slug === 'reviewer')!
    const toolsBefore = [...reviewer(ctx.project).tools].sort()
    // The agent (or a pull) edits the role file during the run: it gains Bash (needs approval) and a new prompt (applies at once).
    const file = rolePath(c, 'reviewer')
    const text = readFileSync(file, 'utf8').replace(/tools:\r?\n/, 'tools:\n  - "Bash"\n').replace('You are a meticulous', 'You are a changed')
    writeFileSync(file, text, 'utf8')
    const status = c.svc.check(p.id)
    expect(status.state).toBe('pending')
    expect(c.projects.get(p.id)!.roles.find((r) => r.slug === 'reviewer')!.prompt).toContain('You are a changed')
    // The live run's roles and project are untouched.
    expect([...reviewer(ctx.project).tools].sort()).toEqual(toolsBefore)
    expect(reviewer(ctx.project).prompt).not.toContain('You are a changed')
    expect(ctx.roles.find((r) => r.slug === 'reviewer')!.prompt).not.toContain('You are a changed')
    // The next run starts on the last approved team (new prompt, old tools) and logs one warning.
    const second = await m.start({ project: c.projects.get(p.id)!, prompt: 'Second run' })
    const warnings = events.filter((e) => e.type === 'log' && e.runId === second.id && e.level === 'warn' && /waiting for your approval/.test(e.message))
    expect(warnings.length).toBe(1)
    const ctx2 = contexts[1]
    expect([...reviewer(ctx2.project).tools].sort()).toEqual(toolsBefore)
    expect(reviewer(ctx2.project).prompt).toContain('You are a changed')
    await m.stop(run.id)
    await m.stop(second.id)
  })

  it('a pull ingested by the same save that approves a change never reaches the live run: only the approved change does (setLive)', async () => {
    const p = mockProject()
    c.svc.status(p.id)
    c.projects.update(p.id, (x) => ({ ...x, permissionMode: 'default' }))
    const { adapter, contexts } = capturing()
    const setup = new SetupService(c.projects, {})
    const m = new RunManager({ mock: adapter }, (e) => void events.push(e), new RunStore(join(c.data)), setup, () => 100, {
      teamFiles: c.svc,
      dataDir: c.data,
      saveProjectPermissions: (id) => c.projects.update(id, (x) => ({ ...x, permissionMode: 'acceptEdits' }))
    })
    const run = await m.start({ project: c.projects.get(p.id)!, prompt: 'First run' })
    await settled(run.id)
    const ctx = contexts[0]
    const briefBefore = ctx.project.brief
    // A pull changes the brief in team.json (applies at once). The next save ingests it first.
    const file = join(repo, '.orgai', 'team.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace(briefBefore, 'Pulled brief'), 'utf8')
    expect(ctx.acceptEditsForProject?.()).toBe(true)
    const stored = c.projects.get(p.id)!
    expect(stored.brief).toBe('Pulled brief')
    expect(stored.permissionMode).toBe('acceptEdits')
    // The live run has the approved change and not the pulled one.
    expect(ctx.project.permissionMode).toBe('acceptEdits')
    expect(ctx.project.brief).toBe(briefBefore)
    await m.stop(run.id)
  })

  it('a run on an engagement writes nothing into its folder', async () => {
    const e = c.projects.create({ name: 'Eng', path: repo, brief: '', kind: 'engagement' }, undefined, {})
    const { adapter } = capturing()
    const m = manager(adapter)
    const run = await m.start({ project: { ...e, provider: { ...e.provider, id: 'mock' } }, prompt: 'Go' })
    await settled(run.id)
    expect(listOrgai(repo)).toEqual([])
    await m.stop(run.id)
  })

  it('a team files check that throws does not stop the run', async () => {
    const p = mockProject()
    const { adapter } = capturing()
    const real = new RunManager({ mock: adapter }, (e) => void events.push(e), new RunStore(join(c.data)), new SetupService(c.projects, {}), () => 100, {
      dataDir: c.data,
      teamFiles: { beforeRun: () => { throw new Error('boom') } }
    })
    const run = await real.start({ project: p, prompt: 'Go' })
    await settled(run.id)
    await real.stop(run.id)
    void readOrgai
  })
})
