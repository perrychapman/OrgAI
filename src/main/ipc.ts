import { exec } from 'node:child_process'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AppSettings,
  AppSettingsInfo,
  AuthStatusResult,
  ConnectionId,
  ConnectionInfo,
  ConnectionLoginStart,
  ConnectionSecretInput,
  ConnectionStatus,
  ContinueRunInput,
  DraftRequest,
  McpAnswerInstallInput,
  McpAssistInput,
  McpMutationResult,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpSecretInput,
  McpServerInfo,
  McpTestResult,
  McpUpsertInput,
  MergeDecision,
  ModelsQuery,
  PermissionDecision,
  PluginUpsertInput,
  Project,
  ProposalDecision,
  ProviderConnection,
  ProviderModel,
  QuestionAnswer,
  RemapModelsInput,
  RemapModelsOutput,
  RunSummary,
  SendRunInput,
  SetupKind,
  StartRunInput
} from '@shared/types'
import { CONNECTION_IDS, IPC } from '@shared/types'
import { builtinModels, mcpSecretNames } from '@shared/defaults'
import type { ProjectStore } from './store/projects'
import type { RunManager } from './runtime/runManager'
import type { SetupService } from './setup/service'
import type { MaintenanceService } from './maintenance'
import type { SettingsStore } from './store/settings'
import { draftOrgChart } from './ai/draft'
import { log, logPath, logsDir } from './log'
import { listRules, removeRule } from './runtime/permissionRules'

export function registerIpc(projects: ProjectStore, runs: RunManager, setup: SetupService, maintenance: MaintenanceService, settings: SettingsStore): void {
  ipcMain.handle(IPC.projectsList, () => projects.list())
  ipcMain.handle(IPC.projectsGet, (_e, id: string) => projects.get(id))
  ipcMain.handle(IPC.projectsCreate, (_e, input: { name: string; path: string; brief: string; setupKind?: SetupKind }) =>
    projects.create(input, settings.get())
  )
  ipcMain.handle(IPC.projectsSave, (_e, project: Project) => projects.save(project))
  ipcMain.handle(IPC.projectsRemove, async (_e, id: string) => {
    await runs.removeProject(id)
    projects.remove(id)
  })
  ipcMain.handle(IPC.projectsPickDir, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.draftOrgChart, async (_e, req: DraftRequest) => {
    const project = projects.get(req.projectId)
    if (!project) throw new Error('Project not found')
    return draftOrgChart(runs.adapterFor(project), project, req)
  })

  ipcMain.handle(IPC.runsStart, async (_e, input: StartRunInput) => {
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return runs.start({ project, prompt: input.prompt, scaffold: input.scaffold, images: input.images })
  })
  ipcMain.handle(IPC.runsGet, (_e, runId: string) => runs.get(runId))

  ipcMain.handle(IPC.setupStart, async (_e, input: { projectId: string; instruction?: string }) => {
    const existing = projects.get(input.projectId)
    if (!existing) throw new Error('Project not found')
    const project = await setup.prepare(existing)
    return runs.start({
      project,
      kind: 'setup',
      prompt: setup.displayPrompt(project, input.instruction),
      hiddenContext: setup.hiddenContext(project)
    })
  })
  ipcMain.handle(IPC.setupRetro, async (_e, input: { projectId: string; runId: string }) => {
    const existing = projects.get(input.projectId)
    if (!existing) throw new Error('Project not found')
    const record = runs.get(input.runId)
    if (!record || record.summary.projectId !== existing.id) throw new Error('Run not found')
    const project = await setup.prepare(existing)
    return runs.start({
      project,
      kind: 'setup',
      prompt: setup.retroPrompt(record),
      hiddenContext: `${setup.hiddenContext(project)}\n\n${setup.retroContext(record)}`
    })
  })
  ipcMain.handle(
    IPC.setupDecide,
    (_e, input: { runId: string; proposalId: string; decision: ProposalDecision }) =>
      runs.decideProposal(input.runId, input.proposalId, input.decision)
  )
  ipcMain.handle(IPC.runsContinue, async (_e, input: ContinueRunInput) => {
    const from = runs.summary(input.runId)
    if (!from) throw new Error('Run not found')
    const existing = projects.get(from.projectId)
    if (!existing) throw new Error('Project not found')
    // Setup runs re-profile the repo like setup:start so the Architect's hidden context is current.
    const project = from.kind === 'setup' ? await setup.prepare(existing) : existing
    return runs.continueRun(project, input.runId, input.text, input.images)
  })
  ipcMain.handle(IPC.runsResumeNow, (_e, runId: string) => runs.resumeNow(runId))
  ipcMain.handle(IPC.runsCancelAutoResume, (_e, runId: string) => runs.cancelAutoResume(runId))
  ipcMain.handle(
    IPC.setupAnswer,
    (_e, input: { runId: string; questionId: string; answer: QuestionAnswer }) =>
      runs.answerQuestion(input.runId, input.questionId, input.answer)
  )
  ipcMain.handle(IPC.runsSend, (_e, input: SendRunInput) => runs.send(input.runId, input.text, input.images))
  ipcMain.handle(IPC.runsInterrupt, (_e, runId: string) => runs.interrupt(runId))
  ipcMain.handle(IPC.runsStop, (_e, runId: string) => runs.stop(runId))
  ipcMain.handle(IPC.runsList, (_e, projectId: string) => runs.list(projectId))
  ipcMain.handle(
    IPC.runsDecide,
    (_e, input: { runId: string; requestId: string; decision: PermissionDecision }) =>
      runs.decide(input.runId, input.requestId, input.decision)
  )
  ipcMain.handle(IPC.mergesDecide, (_e, input: { runId: string; reviewId: string; decision: MergeDecision }) =>
    runs.decideMerge(input.runId, input.reviewId, input.decision)
  )

  ipcMain.handle(IPC.maintListWorktrees, (_e, projectId: string) => maintenance.listWorktrees(projectId))
  ipcMain.handle(IPC.maintIntegrate, (_e, input: { projectId: string; branch: string }) => maintenance.integrateWorktree(input.projectId, input.branch))
  ipcMain.handle(IPC.maintDiscard, (_e, input: { projectId: string; branch: string }) => maintenance.discardWorktree(input.projectId, input.branch))
  ipcMain.handle(IPC.maintUninstall, (_e, projectId: string) => maintenance.uninstallRepo(projectId))
  ipcMain.handle(IPC.maintDiff, (_e, input: { projectId: string; branch: string }) => maintenance.diffWorktree(input.projectId, input.branch))

  ipcMain.handle(IPC.authStatus, async (): Promise<AuthStatusResult> => {
    const auth = settings.get().providerAuth
    if (auth.kind === 'apiKey') {
      const envVarSet = !!process.env[auth.envVar]?.trim()
      return {
        loggedIn: envVarSet,
        method: 'API key',
        detail: envVarSet ? `Using ${auth.envVar}` : `${auth.envVar} is not set in OrgAI's environment`,
        mode: 'apiKey',
        envVar: auth.envVar,
        envVarSet
      }
    }
    return { ...(await authStatus()), mode: 'subscription' }
  })

  const settingsInfo = (): AppSettingsInfo => ({ ...settings.get(), dataDir: settings.dataDir })
  ipcMain.handle(IPC.settingsGet, () => settingsInfo())
  ipcMain.handle(IPC.settingsSet, (_e, next: AppSettings) => {
    // Drop the read-only field if the renderer echoed it back.
    const { dataDir: _ignored, ...rest } = next as AppSettings & { dataDir?: string }
    settings.set(rest)
    return settingsInfo()
  })
  ipcMain.handle(IPC.appOpenPath, (_e, path: string) => shell.openPath(path))
  ipcMain.handle(IPC.appLogPath, () => logPath())
  ipcMain.handle(IPC.appOpenLogs, async () => {
    logPath() // creates the folder if nothing has been logged yet
    const error = await shell.openPath(logsDir())
    if (error) log.warn(`Could not open logs folder: ${error}`)
  })
  ipcMain.handle(IPC.permissionsList, (_e, projectId: string) => {
    const project = projects.get(projectId)
    if (!project) throw new Error('Project not found')
    return listRules(project.path)
  })
  ipcMain.handle(IPC.permissionsRemove, (_e, input: { projectId: string; rule: string }) => {
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return removeRule(project.path, input.rule)
  })

  registerConnectionIpc(projects, settings)
  registerMcpIpc(projects)
}

/** Contract stub: the implementation brief replaces these handlers. */
function notImplemented(): never {
  throw new Error('not implemented')
}

/**
 * Connections, model catalog and remaps. Reads answer from settings and the builtin catalog; everything that
 * probes, logs in, stores secrets or remaps is a stub until the implementation lands.
 */
function registerConnectionIpc(projects: ProjectStore, settings: SettingsStore): void {
  const catalog = (query?: ModelsQuery): ProviderModel[] => {
    const s = settings.get()
    const ids = query?.connection ? [query.connection] : CONNECTION_IDS.filter((id) => s.connections[id].enabled)
    return ids.flatMap((id) => builtinModels(id))
  }
  const info = (id: ConnectionId): ConnectionInfo => ({
    connection: settings.get().connections[id],
    status: { state: 'disconnected' },
    modelCount: builtinModels(id).length
  })
  ipcMain.handle(IPC.connectionsList, (): ConnectionInfo[] => CONNECTION_IDS.map(info))
  ipcMain.handle(IPC.connectionsUpdate, (_e, connection: ProviderConnection): ConnectionInfo => {
    if (!CONNECTION_IDS.includes(connection?.id)) throw new Error('Unknown connection')
    const current = settings.get()
    // SettingsStore.set keeps the stored hasApiKey and syncs the legacy providerAuth.
    settings.set({ ...current, connections: { ...current.connections, [connection.id]: connection } })
    return info(connection.id)
  })
  ipcMain.handle(IPC.connectionsSetSecret, (_e, _input: ConnectionSecretInput): ConnectionInfo => notImplemented())
  ipcMain.handle(IPC.connectionsTest, (_e, _id: ConnectionId): ConnectionStatus => notImplemented())
  ipcMain.handle(IPC.connectionsConnect, (_e, _id: ConnectionId): ConnectionInfo => notImplemented())
  ipcMain.handle(IPC.connectionsLogin, (_e, _id: 'openai'): ConnectionLoginStart => notImplemented())
  ipcMain.handle(IPC.connectionsCancelLogin, (_e, _loginId: string): void => notImplemented())
  ipcMain.handle(IPC.connectionsLogout, (_e, _id: ConnectionId): ConnectionInfo => notImplemented())
  ipcMain.handle(IPC.modelsList, (_e, query?: ModelsQuery): ProviderModel[] => catalog(query))
  ipcMain.handle(IPC.modelsRefresh, (_e, query?: ModelsQuery): ProviderModel[] => catalog(query))
  ipcMain.handle(IPC.projectsRemapModels, (_e, input: RemapModelsInput): RemapModelsOutput => {
    if (!projects.get(input.projectId)) throw new Error('Project not found')
    return notImplemented()
  })
}

/** MCP servers, plugins, registry search and install approvals. mcp:list reads the project; the rest are stubs. */
function registerMcpIpc(projects: ProjectStore): void {
  ipcMain.handle(IPC.mcpList, (_e, projectId: string): McpServerInfo[] => {
    const project = projects.get(projectId)
    if (!project) throw new Error('Project not found')
    // No secret store yet, so every secret slot reports missing.
    return (project.mcpServers ?? []).map((spec) => ({ spec, envSet: [], headersSet: [], missingSecrets: mcpSecretNames(spec) }))
  })
  ipcMain.handle(IPC.mcpUpsert, (_e, _input: McpUpsertInput): McpMutationResult => notImplemented())
  ipcMain.handle(IPC.mcpRemove, (_e, _input: { projectId: string; serverId: string }): McpMutationResult => notImplemented())
  ipcMain.handle(IPC.mcpSetSecret, (_e, _input: McpSecretInput): McpMutationResult => notImplemented())
  ipcMain.handle(IPC.mcpTest, (_e, _input: { projectId: string; serverId: string }): McpTestResult => notImplemented())
  ipcMain.handle(IPC.mcpRegistrySearch, (_e, _input: McpRegistrySearchInput): McpRegistrySearchResult => notImplemented())
  ipcMain.handle(IPC.mcpAnswerInstall, (_e, _input: McpAnswerInstallInput): void => notImplemented())
  ipcMain.handle(IPC.mcpStartAssist, (_e, _input: McpAssistInput): RunSummary => notImplemented())
  ipcMain.handle(IPC.pluginsUpsert, (_e, _input: PluginUpsertInput): Project => notImplemented())
  ipcMain.handle(IPC.pluginsRemove, (_e, _input: { projectId: string; pluginId: string }): Project => notImplemented())
}

type AuthStatus = { loggedIn: boolean; method?: string; detail?: string }

/**
 * Ask the installed Claude Code CLI whether it is logged in. Used only for the status pill.
 * Several `claude` launchers can sit on the PATH (shims, old installs), so every candidate is
 * tried in PATH order and the first one that answers wins.
 */
async function authStatus(): Promise<AuthStatus> {
  const candidates = await listClaudeBinaries()
  for (const bin of candidates) {
    const result = await runAuthStatus(bin)
    if (result) return result
  }
  return { loggedIn: false, detail: 'Claude Code CLI not found or not logged in' }
}

function listClaudeBinaries(): Promise<string[]> {
  const cmd = process.platform === 'win32' ? 'where claude' : 'which -a claude'
  return new Promise((resolve) => {
    exec(cmd, { timeout: 8000, windowsHide: true }, (err, stdout) => {
      const found = err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      resolve(found.length ? [...new Set(found)] : ['claude'])
    })
  })
}

function runAuthStatus(bin: string): Promise<AuthStatus | null> {
  const quoted = /\s/.test(bin) ? `"${bin}"` : bin
  return new Promise((resolve) => {
    exec(`${quoted} auth status`, { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout.trim()) {
        resolve(null)
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string }
        resolve({ loggedIn: !!parsed.loggedIn, method: parsed.authMethod, detail: parsed.apiProvider })
      } catch {
        if (/logged in|not logged in/i.test(stdout)) resolve({ loggedIn: !/not logged in/i.test(stdout), detail: stdout.trim().slice(0, 120) })
        else resolve(null)
      }
    })
  })
}
