import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/types'
import type { FolderConfigReview, FolderConfigTrustResult } from '@shared/types'
import { DEFAULT_APP_SETTINGS, projectRulesLocation } from '@shared/defaults'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn), on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))
vi.mock('./log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '', logsDir: () => '' }))

const { folderConfigTrustArgs, registerIpc } = await import('./ipc')
const { ProjectStore } = await import('./store/projects')
const { projectRulesFile } = await import('./store/projectData')
const { listRules } = await import('./runtime/permissionRules')

describe('folderConfigTrustArgs', () => {
  it('rebuilds the input and drops extra fields', () => {
    expect(folderConfigTrustArgs({ projectId: 'proj_a', trust: true, digest: 'a'.repeat(64), evil: 1 })).toEqual({ projectId: 'proj_a', trust: true, digest: 'a'.repeat(64) })
  })

  it('refuses a bad id, virtual ids, a non-boolean trust and a missing or long digest', () => {
    const ok = { projectId: 'proj_a', trust: false, digest: '' }
    expect(folderConfigTrustArgs(ok).trust).toBe(false)
    for (const bad of [null, undefined, 5, 'x', [], { ...ok, projectId: '../x' }, { ...ok, projectId: 'quick' }, { ...ok, projectId: 'harness' }, { ...ok, projectId: 'skills' }, { ...ok, projectId: 7 }]) {
      expect(() => folderConfigTrustArgs(bad), JSON.stringify(bad)).toThrow(/Project not found|no folder config/)
    }
    for (const trust of ['true', 1, null, undefined]) expect(() => folderConfigTrustArgs({ ...ok, trust })).toThrow(/trust/)
    for (const digest of [undefined, 5, 'a'.repeat(65), {}]) expect(() => folderConfigTrustArgs({ ...ok, digest })).toThrow(/Review this folder/)
  })
})

describe('projectRulesFile for a gated project', () => {
  it('is the data folder file in every state, the folder file otherwise', () => {
    const base = { id: 'p1', path: '/repo', kind: 'code' as const }
    expect(projectRulesLocation({ ...base, folderConfigTrust: { state: 'untrusted' } })).toBe('app')
    expect(projectRulesLocation({ ...base, folderConfigTrust: { state: 'trusted', digest: 'a'.repeat(64) } })).toBe('app')
    expect(projectRulesFile({ ...base, folderConfigTrust: { state: 'untrusted' } }, '/data')).toContain('permission-rules.json')
    expect(projectRulesFile(base, '/data').replace(/\\/g, '/')).toBe('/repo/.claude/settings.local.json')
  })
})

describe('projects:folderConfig and projects:setFolderConfigTrust', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-ipcfc-'))
    handlers.clear()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function setup() {
    const work = join(dir, 'work')
    const put = (rel: string, text: string): void => {
      mkdirSync(dirname(join(work, rel)), { recursive: true })
      writeFileSync(join(work, rel), text)
    }
    put('.claude/settings.json', '{"hooks":{}}')
    put('.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(npm test:*)', 'Bash(rm:*)'] } }))
    const data = join(dir, 'data')
    mkdirSync(data)
    const store = new ProjectStore(data)
    const project = store.create({ name: 'cloned', path: work, brief: '' })
    registerIpc({
      projects: store as never,
      runs: {} as never,
      setup: {} as never,
      maintenance: {} as never,
      settings: { get: () => DEFAULT_APP_SETTINGS, dataDir: data, set: vi.fn() } as never,
      connections: { effectiveSettings: () => DEFAULT_APP_SETTINGS } as never,
      mcp: {} as never,
      adapterIds: ['mock'],
      harnessProject: () => project,
      openRunWindow: () => {},
      importer: {} as never,
      skills: {} as never,
      skillEvaluation: {} as never,
      capabilities: {} as never,
      quick: { displayProject: () => project } as never,
      templates: {} as never
    })
    const call = (channel: string, ...args: unknown[]): unknown => handlers.get(channel)!({ sender: { id: 1 } }, ...args)
    return { call, project, store, data, put }
  }

  it('reviews, accepts, then reports changed after an edit, and revokes', async () => {
    const { call, project, store, data, put } = setup()
    expect(project.folderConfigTrust).toEqual({ state: 'untrusted' })
    const review = (await call(IPC.projectsFolderConfig, project.id)) as FolderConfigReview
    expect(review.state).toBe('untrusted')
    expect(review.allowRules.map((r) => [r.rule, !!r.refused])).toEqual([['Bash(npm test:*)', false], ['Bash(rm:*)', true]])
    const accepted = (await call(IPC.projectsSetFolderConfigTrust, { projectId: project.id, trust: true, digest: review.digest, extra: 1 })) as FolderConfigTrustResult
    expect(accepted.review.state).toBe('trusted')
    expect(accepted.project.folderConfigTrust).toMatchObject({ state: 'trusted', digest: review.digest, importedRules: ['Bash(npm test:*)'] })
    expect(store.get(project.id)?.folderConfigTrust?.state).toBe('trusted')
    expect(listRules({ file: projectRulesFile(accepted.project, data) })).toEqual(['Bash(npm test:*)'])
    put('.claude/settings.json', '{"hooks":{"Stop":[]}}')
    expect(((await call(IPC.projectsFolderConfig, project.id)) as FolderConfigReview).state).toBe('changed')
    // Revoking follows the same rule as accepting: the digest of what the user just read.
    await expect((async () => call(IPC.projectsSetFolderConfigTrust, { projectId: project.id, trust: false, digest: '' }))()).rejects.toThrow(/Review this folder/)
    const current = ((await call(IPC.projectsFolderConfig, project.id)) as FolderConfigReview).digest
    const revoked = (await call(IPC.projectsSetFolderConfigTrust, { projectId: project.id, trust: false, digest: current })) as FolderConfigTrustResult
    expect(revoked.review.state).toBe('untrusted')
    expect(listRules({ file: projectRulesFile(revoked.project, data) })).toEqual([])
  })

  it('refuses a stale digest, virtual and unknown projects', async () => {
    const { call, project, put } = setup()
    const review = (await call(IPC.projectsFolderConfig, project.id)) as FolderConfigReview
    put('.claude/settings.json', '{"hooks":{"Stop":[]}}')
    await expect(Promise.resolve().then(() => call(IPC.projectsSetFolderConfigTrust, { projectId: project.id, trust: true, digest: review.digest }))).rejects.toThrow(/changed since you reviewed/)
    expect(() => call(IPC.projectsFolderConfig, 'quick')).toThrow(/no folder config/)
    expect(() => call(IPC.projectsFolderConfig, 'proj_nope')).toThrow(/Project not found/)
    expect(() => call(IPC.projectsSetFolderConfigTrust, { projectId: 'proj_nope', trust: true, digest: review.digest })).toThrow(/Project not found/)
  })
})
