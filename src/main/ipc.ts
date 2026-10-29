import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AppSettings,
  AppSettingsInfo,
  AuthStatusResult,
  ConnectionId,
  ConnectionInfo,
  ConnectionLoginMethod,
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
  RemapResult,
  RunSummary,
  SendRunInput,
  SetupKind,
  StartRunInput
} from '@shared/types'
import { CONNECTION_IDS, IPC } from '@shared/types'
import type { ProjectStore } from './store/projects'
import type { RunManager } from './runtime/runManager'
import type { SetupService } from './setup/service'
import type { MaintenanceService } from './maintenance'
import type { SettingsStore } from './store/settings'
import type { ConnectionService } from './connections/service'
import type { McpService } from './mcp/service'
import { claudeAuthStatus } from './connections/anthropicAuth'
import { assistPrompt } from './mcp/assist'
import { draftOrgChart } from './ai/draft'
import { log, logPath, logsDir } from './log'
import { listRules, removeRule } from './runtime/permissionRules'

export interface IpcServices {
  projects: ProjectStore
  runs: RunManager
  setup: SetupService
  maintenance: MaintenanceService
  settings: SettingsStore
  connections: ConnectionService
  mcp: McpService
}

export function registerIpc({ projects, runs, setup, maintenance, settings, connections, mcp }: IpcServices): void {
  ipcMain.handle(IPC.projectsList, () => projects.list())
  ipcMain.handle(IPC.projectsGet, (_e, id: string) => projects.get(id))
  ipcMain.handle(IPC.projectsCreate, (_e, input: { name: string; path: string; brief: string; setupKind?: SetupKind }) =>
    projects.create(input, settings.get())
  )
  // The renderer's copy never changes mcpServers or plugins; those go through mcp:* and plugins:*.
  ipcMain.handle(IPC.projectsSave, (_e, project: Project) => projects.saveFromRenderer(project))
  ipcMain.handle(IPC.projectsRemove, async (_e, id: string) => {
    await runs.removeProject(id)
    mcp.removeProjectSecrets(id)
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
    return { ...(await claudeAuthStatus()), mode: 'subscription' }
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

  registerConnectionIpc(projects, connections)
  registerMcpIpc(projects, runs, mcp)
}

/** Connections, model catalog and remaps: ConnectionService 1:1. */
function registerConnectionIpc(projects: ProjectStore, connections: ConnectionService): void {
  ipcMain.handle(IPC.connectionsList, (): Promise<ConnectionInfo[]> => connections.list())
  ipcMain.handle(IPC.connectionsUpdate, (_e, connection: ProviderConnection): Promise<ConnectionInfo> => {
    if (!CONNECTION_IDS.includes(connection?.id)) throw new Error('Unknown connection')
    return connections.update(connection)
  })
  ipcMain.handle(IPC.connectionsSetSecret, (_e, input: ConnectionSecretInput): Promise<ConnectionInfo> => connections.setSecret(input))
  ipcMain.handle(IPC.connectionsTest, (_e, id: ConnectionId): Promise<ConnectionStatus> => connections.test(id))
  ipcMain.handle(IPC.connectionsConnect, (_e, id: ConnectionId): Promise<ConnectionInfo> => connections.connect(id))
  ipcMain.handle(IPC.connectionsLogin, (_e, id: 'openai', method?: ConnectionLoginMethod): Promise<ConnectionLoginStart> =>
    connections.login(id, method === 'deviceCode' ? 'deviceCode' : 'browser')
  )
  ipcMain.handle(IPC.connectionsCancelLogin, (_e, loginId: string): Promise<void> => connections.cancelLogin(loginId))
  ipcMain.handle(IPC.connectionsLogout, (_e, id: ConnectionId): Promise<ConnectionInfo> => connections.logout(id))
  ipcMain.handle(IPC.modelsList, (_e, query?: ModelsQuery): ProviderModel[] => connections.models(query))
  ipcMain.handle(IPC.modelsRefresh, (_e, query?: ModelsQuery): Promise<ProviderModel[]> => connections.refresh(query))
  ipcMain.handle(IPC.projectsRemapModels, (_e, input: RemapModelsInput): RemapModelsOutput => {
    if (!projects.get(input.projectId)) throw new Error('Project not found')
    return connections.remapModels(input)
  })
  ipcMain.handle(IPC.projectsPreviewRemap, (_e, input: RemapModelsInput): RemapResult => connections.previewRemap(input))
}

/** MCP servers, plugins, registry search and install approvals: McpService 1:1, installs and the assistant via RunManager. */
function registerMcpIpc(projects: ProjectStore, runs: RunManager, mcp: McpService): void {
  ipcMain.handle(IPC.mcpList, (_e, projectId: string): McpServerInfo[] => mcp.list(projectId))
  ipcMain.handle(IPC.mcpUpsert, (_e, input: McpUpsertInput): McpMutationResult => mcp.upsert(input))
  ipcMain.handle(IPC.mcpRemove, (_e, input: { projectId: string; serverId: string }): McpMutationResult => mcp.remove(input))
  ipcMain.handle(IPC.mcpSetSecret, (_e, input: McpSecretInput): McpMutationResult => mcp.setSecret(input))
  ipcMain.handle(IPC.mcpTest, (_e, input: { projectId: string; serverId: string }): Promise<McpTestResult> => mcp.test(input))
  ipcMain.handle(IPC.mcpRegistrySearch, (_e, input: McpRegistrySearchInput): Promise<McpRegistrySearchResult> => mcp.registrySearch(input))
  ipcMain.handle(IPC.mcpAnswerInstall, (_e, input: McpAnswerInstallInput): void => runs.answerMcpInstall(input.runId, input.requestId, input.decision))
  ipcMain.handle(IPC.mcpStartAssist, async (_e, input: McpAssistInput): Promise<RunSummary> => {
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return runs.start({ project, kind: 'mcp-assist', prompt: assistPrompt(project, input.instruction) })
  })
  ipcMain.handle(IPC.pluginsUpsert, (_e, input: PluginUpsertInput): Project => mcp.upsertPlugin(input))
  ipcMain.handle(IPC.pluginsRemove, (_e, input: { projectId: string; pluginId: string }): Project => mcp.removePlugin(input))
}
