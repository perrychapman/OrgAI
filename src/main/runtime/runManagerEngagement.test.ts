import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '@shared/types'
import { RunManager, type RunManagerOptions } from './runManager'
import { RunStore } from '../store/runs'
import { appRulesFile, engagementDocumentFile } from '../store/projectData'
import type { SetupService } from '../setup/service'
import type { RuntimeAdapter, RuntimeContext } from './types'
import { project as makeProject } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

let dir: string
let events: RunEvent[]

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-eng-')))
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

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
  const setup = { applyProposal: vi.fn(), markScaffolded: vi.fn(), markArchitectureUpdated: vi.fn(), hiddenContext: vi.fn(() => '') } as unknown as SetupService
  const store = new RunStore(join(dir, 'data'))
  const m = new RunManager({ mock: adapter }, (e) => void events.push(e), store, setup, () => 100, { dataDir: join(dir, 'data'), ...options })
  return { m, ctxs }
}

const folder = (): string => {
  const p = join(dir, 'client')
  mkdirSync(p, { recursive: true })
  return p
}
const folderLocal = (p: string): string => join(p, '.claude', 'settings.local.json')
const writeRules = (file: string, allow: string[]): void => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ permissions: { allow } }), 'utf8')
}

describe('engagement runs write nothing into the folder', () => {
  it('reads saved rules from the app file and ignores the folder settings.local.json', async () => {
    const p = folder()
    writeRules(folderLocal(p), ['Bash(rm:*)'])
    writeRules(appRulesFile(join(dir, 'data'), 'p1'), ['Bash(ls:*)'])
    const { m, ctxs } = rig()
    await m.start({ project: makeProject({ id: 'p1', path: p, kind: 'engagement' }), prompt: 'go' })
    expect(ctxs[0].allowedRules?.()).toEqual(['Bash(ls:*)'])
    expect(ctxs[0].savedRules?.()).toEqual(['Bash(ls:*)'])
    await m.stopAll()
  })

  it('saves a project-scope grant to the app file and leaves the folder empty', async () => {
    const p = folder()
    const { m, ctxs } = rig()
    const run = await m.start({ project: makeProject({ id: 'p1', path: p, kind: 'engagement' }), prompt: 'go' })
    const pending = ctxs[0].requestPermissionRules!({ agentId: 'root', rules: ['Bash(git status:*)'], reason: 'look' })
    const req = events.find((e): e is Extract<RunEvent, { type: 'rules.request' }> => e.type === 'rules.request')!
    m.decideRules(run.id, req.request.id, { behavior: 'grant', scope: 'project' })
    await pending
    const saved = JSON.parse(readFileSync(appRulesFile(join(dir, 'data'), 'p1'), 'utf8')) as { permissions: { allow: string[] } }
    expect(saved.permissions.allow).toEqual(['Bash(git status:*)'])
    expect(ctxs[0].savedRules?.()).toEqual(['Bash(git status:*)'])
    expect(readdirSync(p)).toEqual([])
    // saveProjectRules (applyAllowScope) goes to the same file
    expect(ctxs[0].saveProjectRules?.(['Bash(ls:*)']).added).toEqual(['Bash(ls:*)'])
    expect(readdirSync(p)).toEqual([])
    await m.stopAll()
  })

  it('does not create a missing engagement folder', async () => {
    const gone = join(dir, 'nowhere')
    const { m } = rig()
    await m.start({ project: makeProject({ id: 'p1', path: gone, kind: 'engagement' }), prompt: 'go' })
    expect(existsSync(gone)).toBe(false)
    await m.stopAll()
  })

  it('shows the adapters isolateWriters false unless the user turned it on', async () => {
    const { m, ctxs } = rig()
    await m.start({ project: makeProject({ id: 'p1', path: folder(), kind: 'engagement' }), prompt: 'a' })
    expect(ctxs[0].project.isolateWriters).toBe(false)
    await m.start({ project: makeProject({ id: 'p2', path: folder(), kind: 'engagement', isolateWriters: true }), prompt: 'b' })
    expect(ctxs[1].project.isolateWriters).toBe(true)
    await m.stopAll()
  })

  it('returns the engagement document text', async () => {
    const { m, ctxs } = rig()
    const file = engagementDocumentFile(join(dir, 'data'), 'p1')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '# Engagement\nScope', 'utf8')
    await m.start({ project: makeProject({ id: 'p1', path: folder(), kind: 'engagement' }), prompt: 'go' })
    expect(ctxs[0].engagementDocument?.()).toBe('# Engagement\nScope')
    await m.stopAll()
  })
})

describe('code projects are unchanged', () => {
  it('reads and writes the folder rules file, has no engagement document and keeps isolateWriters', async () => {
    const p = folder()
    writeRules(folderLocal(p), ['Bash(ls:*)'])
    const { m, ctxs } = rig()
    const run = await m.start({ project: makeProject({ id: 'p1', path: p, isolateWriters: undefined }), prompt: 'go' })
    expect(ctxs[0].allowedRules?.()).toEqual(['Bash(ls:*)'])
    expect(ctxs[0].engagementDocument).toBeUndefined()
    expect(ctxs[0].project.isolateWriters).toBeUndefined()
    const pending = ctxs[0].requestPermissionRules!({ agentId: 'root', rules: ['Bash(git status:*)'], reason: 'look' })
    const req = events.find((e): e is Extract<RunEvent, { type: 'rules.request' }> => e.type === 'rules.request')!
    m.decideRules(run.id, req.request.id, { behavior: 'grant', scope: 'project' })
    await pending
    const saved = JSON.parse(readFileSync(folderLocal(p), 'utf8')) as { permissions: { allow: string[] } }
    expect(saved.permissions.allow).toEqual(['Bash(ls:*)', 'Bash(git status:*)'])
    expect(existsSync(appRulesFile(join(dir, 'data'), 'p1'))).toBe(false)
    await m.stopAll()
  })
})
