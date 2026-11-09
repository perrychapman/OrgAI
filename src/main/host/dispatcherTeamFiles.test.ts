import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HOST_SCOPES, IPC, TEAM_FILES_IPC } from '../../shared/types'
import type { HostScope, Project } from '../../shared/types'
import { DEFAULT_APP_SETTINGS } from '../../shared/defaults'
import { HostDispatcher } from './dispatcher'
import type { RpcInvokeContext } from './types'
import { createProject, makeComputer } from '../teamFiles/service.fixture'

/** A service object whose every method is a no-op: only the handlers under test are driven. */
const inert = (): never => new Proxy({}, { get: () => () => undefined }) as never

let root: string
let repo: string
let lastSources: unknown

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-disp-team-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const socketCtx = (scopes: readonly HostScope[] = HOST_SCOPES): RpcInvokeContext => ({ surface: 'socket', grantedScopes: scopes, clientKind: 'cli' })

function setup(): { c: ReturnType<typeof makeComputer>; rpc: (channel: string, ...args: unknown[]) => Promise<unknown>; dispatcher: HostDispatcher } {
  const c = makeComputer(root, 'a', repo)
  const importer = {
    pathCheckExtras: () => ({ agentSources: [{ source: 'orgai', label: 'OrgAI export', agentCount: 2 }] }),
    rolesForNewProject: (p: Project, sources?: unknown) => {
      lastSources = sources
      return p
    }
  }
  const dispatcher = new HostDispatcher({
    projects: c.projects,
    runs: inert(),
    setup: inert(),
    maintenance: inert(),
    settings: { get: () => DEFAULT_APP_SETTINGS, dataDir: c.data } as never,
    connections: { prepareNewProject: (p: Project) => p } as never,
    mcp: inert(),
    adapterIds: ['mock'],
    harnessProject: inert(),
    importer: importer as never,
    skills: inert(),
    skillEvaluation: inert(),
    capabilities: inert(),
    quick: inert(),
    templates: { rolesForNewProject: (p: Project) => p } as never,
    teamFiles: c.svc,
    env: { app: { getVersion: () => '0.0.0', getPath: () => '', isPackaged: false }, platform: process.platform, logsDir: () => '', hostKind: 'desktop' }
  })
  return { c, dispatcher, rpc: (channel, ...args) => dispatcher.invokeRpc(channel, args, socketCtx()) }
}

describe('team files over the socket (invokeRpc)', () => {
  it('projects:create with importAgents [orgai] does not import a folder\'s .orgai agents when it has team files (SECURITY)', async () => {
    const { c, rpc } = setup()
    const first = createProject(c)
    c.svc.status(first.id)
    lastSources = undefined
    await rpc(IPC.projectsCreate, { name: 'Imp', path: repo, brief: '', importAgents: ['orgai', 'claude'] })
    expect(lastSources).toEqual(['claude'])
    lastSources = undefined
    await rpc(IPC.projectsCreate, { name: 'Imp3', path: repo, brief: '', importAgents: ['orgai'] })
    expect(lastSources ?? []).not.toContain('orgai')
    // A folder without team files is not touched by this.
    const plain = join(root, 'plain')
    mkdirSync(plain)
    lastSources = undefined
    await rpc(IPC.projectsCreate, { name: 'Imp2', path: plain, brief: '', importAgents: ['orgai', 'claude'] })
    expect(lastSources).toEqual(['orgai', 'claude'])
  })

  it('projects:create refuses team files for an engagement over the socket', async () => {
    const { rpc } = setup()
    await expect(rpc(IPC.projectsCreate, { name: 'E', path: repo, brief: '', kind: 'engagement', teamFiles: { digest: 'ab'.repeat(32) } })).rejects.toThrow(/code projects only/)
  })

  it('projects:setFolderConfigTrust and the teamFiles decisions are refused over the socket as desktop-only', async () => {
    const { rpc } = setup()
    for (const ch of [IPC.projectsSetFolderConfigTrust, TEAM_FILES_IPC.teamFilesApprove, TEAM_FILES_IPC.teamFilesReject, TEAM_FILES_IPC.teamFilesUndo, TEAM_FILES_IPC.teamFilesEnable, TEAM_FILES_IPC.teamFilesCommit]) {
      await expect(rpc(ch, { projectId: 'proj_x', digest: 'ab'.repeat(32), trust: true }), ch).rejects.toMatchObject({ code: 'desktop_unavailable' })
    }
  })

  it('teamFiles:status needs configure and teamFiles:listAttention needs read', async () => {
    const { dispatcher } = setup()
    await expect(dispatcher.invokeRpc(TEAM_FILES_IPC.teamFilesStatus, [{ projectId: 'proj_x' }], socketCtx(['read']))).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(dispatcher.invokeRpc(TEAM_FILES_IPC.teamFilesListAttention, [], socketCtx(['read']))).resolves.toEqual([])
    await expect(dispatcher.invokeRpc(IPC.projectsFolderConfig, ['proj_x'], socketCtx(['read']))).rejects.toThrow('Project not found')
  })
})

