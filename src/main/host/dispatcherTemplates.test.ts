import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/types'
import type { HostScope, OrgTemplateInfo, Project } from '@shared/types'
import { ANTHROPIC_BUILTIN_MODELS, DEFAULT_APP_SETTINGS, defaultTierModels } from '@shared/defaults'

// The dispatcher must load and run without Electron (cli-spec 3.1.1).
vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host dispatcher')
})
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '/logs/main.log', logsDir: () => '/logs' }))

const { HostDispatcher } = await import('./dispatcher')
const { TemplateService } = await import('../setup/templates')
const { project: makeProject } = await import('../runtime/testHelpers')
type HostServices = import('./types').HostServices
type RpcInvokeContext = import('./types').RpcInvokeContext

const rpc = (scopes: HostScope[]): RpcInvokeContext => ({ surface: 'socket', grantedScopes: scopes })
const READ = rpc(['read'])
const CONFIGURE = rpc(['read', 'operate', 'configure'])

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-dispatcher-templates-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const stored: Project[] = [makeProject({ id: 'proj_a' })]
  const settings = { get: () => DEFAULT_APP_SETTINGS, dataDir: dir, set: vi.fn() }
  const templates = new TemplateService({
    dataDir: dir,
    projects: {
      get: (id) => stored.find((p) => p.id === id) ?? null,
      save: (p) => {
        stored[0] = p
        return p
      }
    },
    modelContext: (connection) => ({ connection, catalog: ANTHROPIC_BUILTIN_MODELS, tierModels: defaultTierModels(ANTHROPIC_BUILTIN_MODELS) })
  })
  const services: HostServices = {
    projects: { get: (id: string) => stored.find((p) => p.id === id) ?? null, list: () => stored } as never,
    runs: { list: () => [] } as never,
    setup: {} as never,
    maintenance: {} as never,
    settings: settings as never,
    connections: { effectiveSettings: () => settings.get(), effectiveDefault: () => 'anthropic' } as never,
    mcp: {} as never,
    adapterIds: ['mock'],
    harnessProject: () => makeProject({ id: 'harness', roles: [] }),
    importer: {} as never,
    skills: {} as never,
    skillEvaluation: {} as never,
    capabilities: {} as never,
    quick: {} as never,
    templates
  }
  return { d: new HostDispatcher(services), stored }
}

describe('templates:* with the built-in starting teams', () => {
  it('templates:list leads with the two built-in teams (read scope)', async () => {
    const { d } = setup()
    const list = (await d.invokeRpc(IPC.templatesList, [], READ)) as OrgTemplateInfo[]
    expect(list.map((t) => [t.id, t.builtIn])).toEqual([
      ['builtin:code', true],
      ['builtin:engagement', true]
    ])
  })

  it('templates:remove refuses a built-in with a plain sentence and answers the full list otherwise', async () => {
    const { d } = setup()
    await expect(d.invokeRpc(IPC.templatesRemove, ['builtin:code'], CONFIGURE)).rejects.toThrow(/cannot be removed\. Duplicate it/)
    const saved = (await d.invokeRpc(IPC.templatesSaveFromProject, [{ projectId: 'proj_a', name: 'Mine' }], CONFIGURE)) as OrgTemplateInfo
    const rest = (await d.invokeRpc(IPC.templatesRemove, [saved.id], CONFIGURE)) as OrgTemplateInfo[]
    expect(rest.map((t) => t.id)).toEqual(['builtin:code', 'builtin:engagement'])
  })

  it('templates:apply accepts a built-in id and counts it', async () => {
    const { d } = setup()
    await d.invokeRpc(IPC.templatesApply, [{ projectId: 'proj_a', templateId: 'builtin:engagement', mode: 'replace' }], CONFIGURE)
    const list = (await d.invokeRpc(IPC.templatesList, [], READ)) as OrgTemplateInfo[]
    expect(list.find((t) => t.id === 'builtin:engagement')?.appliedCount).toBe(1)
    expect(list.find((t) => t.id === 'builtin:code')?.appliedCount).toBeUndefined()
    await expect(d.invokeRpc(IPC.templatesApply, [{ projectId: 'proj_a', templateId: 'builtin:nope', mode: 'replace' }], CONFIGURE)).rejects.toThrow('Template not found')
  })
})
