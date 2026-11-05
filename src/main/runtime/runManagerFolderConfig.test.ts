import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Proposal, RunEvent } from '@shared/types'
import { RunManager, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import { listRules } from './permissionRules'
import { appRulesFile } from '../store/projectData'
import { scanFolderConfig } from './folderConfigTrust'
import type { SetupService } from '../setup/service'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { project as makeProject } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let work: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-rmfc-')))
  work = join(dir, 'work')
  mkdirSync(work, { recursive: true })
  events = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(rel: string, content: string): void {
  const abs = join(work, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function rig(options: RunManagerOptions = {}) {
  const ctxs: RuntimeContext[] = []
  const adapter: RuntimeAdapter = {
    id: 'mock',
    complete: async () => '',
    start: async (ctx) => {
      ctxs.push(ctx)
      ctx.emit({ type: 'run.status', runId: ctx.run.id, status: 'running', sessionId: `s-${ctxs.length}` })
      return { send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: new Promise<void>(() => {}) }
    }
  }
  const setup = {
    applyProposal: vi.fn((_id: string, _p: Proposal) => makeProject({ id: 'real' })),
    markScaffolded: vi.fn(),
    markArchitectureUpdated: vi.fn(),
    hiddenContext: vi.fn(() => 'profile')
  } as unknown as SetupService
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, { dataDir: join(dir, 'data'), ...options })
  return { m, ctxs }
}

function proj(over: Partial<Project> = {}): Project {
  return makeProject({ id: 'p1', path: work, ...over })
}

const warnings = (): string[] => events.filter((e): e is Extract<RunEvent, { type: 'log' }> => e.type === 'log' && e.level === 'warn' && /agent config/.test(e.message)).map((e) => e.message)

describe('RuntimeContext.folderConfigLoads', () => {
  it('is omitted for a project with no gate field and warns about nothing', async () => {
    write('.claude/settings.json', '{}')
    const { m, ctxs } = rig()
    await m.start({ project: proj(), prompt: 'x' })
    expect(ctxs[0].folderConfigLoads).toBeUndefined()
    expect(warnings()).toEqual([])
  })

  it('is false for an untrusted folder, with one warning naming the files', async () => {
    write('.claude/settings.json', '{}')
    write('.mcp.json', '{}')
    const { m, ctxs } = rig()
    await m.start({ project: proj({ folderConfigTrust: { state: 'untrusted' } }), prompt: 'x' })
    expect(ctxs[0].folderConfigLoads?.()).toBe(false)
    expect(ctxs[0].folderConfigLoads?.()).toBe(false)
    expect(warnings()).toEqual(["This folder's own agent config was not loaded: .claude/settings.json, .mcp.json. Review it in Project settings to use it."])
  })

  it('warns on setup runs too', async () => {
    write('CLAUDE.md', 'x')
    const { m } = rig()
    await m.start({ project: proj({ folderConfigTrust: { state: 'untrusted' } }), prompt: 'x', kind: 'setup' })
    expect(warnings()).toHaveLength(1)
  })

  it('is true for an accepted folder, and goes false for good after an edit mid-run', async () => {
    write('.claude/settings.json', '{"a":1}')
    const trusted = proj({ folderConfigTrust: { state: 'trusted', digest: scanFolderConfig(work).digest } })
    const { m, ctxs } = rig({ resolveProject: () => trusted })
    await m.start({ project: trusted, prompt: 'x' })
    expect(ctxs[0].folderConfigLoads?.()).toBe(true)
    expect(warnings()).toEqual([])
    write('.claude/settings.json', '{"a":2}')
    expect(ctxs[0].folderConfigLoads?.()).toBe(false)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatch(/changed since you accepted it.*Project settings/)
    // Putting the file back does not bring it back in this run, and no second warning is written.
    write('.claude/settings.json', '{"a":1}')
    expect(ctxs[0].folderConfigLoads?.()).toBe(false)
    expect(warnings()).toHaveLength(1)
  })

  it('starts false when the folder already changed since the accept, and accepting mid-run does not flip it', async () => {
    write('.claude/settings.json', '{"a":1}')
    const old = proj({ folderConfigTrust: { state: 'trusted', digest: 'f'.repeat(64) } })
    let stored: Project = old
    const { m, ctxs } = rig({ resolveProject: () => stored })
    await m.start({ project: old, prompt: 'x' })
    expect(ctxs[0].folderConfigLoads?.()).toBe(false)
    expect(warnings()[0]).toMatch(/changed since you accepted it/)
    stored = proj({ folderConfigTrust: { state: 'trusted', digest: scanFolderConfig(work).digest } })
    expect(ctxs[0].folderConfigLoads?.()).toBe(false)
    expect(warnings()).toHaveLength(1)
    // The next run does load it.
    await m.start({ project: stored, prompt: 'y' })
    expect(ctxs[1].folderConfigLoads?.()).toBe(true)
  })

  it('treats a project that cannot be scanned as not loading', async () => {
    const { m, ctxs } = rig({
      resolveProject: () => {
        throw new Error('store gone')
      }
    })
    await m.start({ project: proj({ folderConfigTrust: { state: 'untrusted' } }), prompt: 'x' })
    expect(ctxs[0].folderConfigLoads?.()).toBe(false)
  })
})

describe('saved rules of a gated project live in the data folder', () => {
  it('allowedRules ignore the folder\'s settings.local.json and a project-scope grant lands in the data folder without touching the digest', async () => {
    write('.claude/settings.json', '{}')
    write('.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(make deploy:*)'] } }))
    const gated = proj({ folderConfigTrust: { state: 'untrusted' } })
    const before = scanFolderConfig(work).digest
    const { m, ctxs } = rig()
    const run = await m.start({ project: gated, prompt: 'x' })
    expect(ctxs[0].allowedRules?.()).not.toContain('Bash(make deploy:*)')
    void ctxs[0].requestPermissionRules?.({ agentId: 'root', rules: ['Bash(npm test:*)'], reason: 'r' })
    const req = events.find((e) => e.type === 'rules.request' && e.runId === run.id) as Extract<RunEvent, { type: 'rules.request' }>
    m.decideRules(run.id, req.request.id, { behavior: 'grant', scope: 'project' })
    const file = appRulesFile(join(dir, 'data'), 'p1')
    expect(listRules({ file })).toEqual(['Bash(npm test:*)'])
    expect(ctxs[0].allowedRules?.()).toContain('Bash(npm test:*)')
    expect(scanFolderConfig(work).digest).toBe(before)
  })

  it('a gated project without a data folder refuses to start rather than writing into the folder', async () => {
    write('.claude/settings.json', '{}')
    const store = new RunStore(join(dir, 'data2'))
    const adapter: RuntimeAdapter = { id: 'mock', complete: async () => '', start: async () => ({ send: async () => {}, interrupt: async () => {}, stop: async () => {}, finished: Promise.resolve() }) }
    const m = new RunManager({ mock: adapter }, () => {}, store, {} as unknown as SetupService, () => 100, {})
    await expect(m.start({ project: proj({ folderConfigTrust: { state: 'untrusted' } }), prompt: 'x' })).rejects.toThrow(/data folder/)
  })
})
