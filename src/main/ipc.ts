import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type {
  AppInfo,
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
  FocusRunTarget,
  McpAnswerInstallInput,
  McpAssistInput,
  McpAuthStatus,
  McpAuthTarget,
  McpAuthorizeInput,
  McpLibraryEntry,
  McpLibraryInfo,
  McpLibrarySecretInput,
  McpLinkLibraryInput,
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
  ProjectCreateInput,
  ProjectPathCheck,
  ProposalDecision,
  ProviderConnection,
  ProviderModel,
  PermissionRuleDecision,
  QuestionAnswer,
  RemapModelsInput,
  RemapModelsOutput,
  RemapResult,
  PendingCards,
  RunSummary,
  SendRunInput,
  StartRunInput
} from '@shared/types'
import { CONNECTION_IDS, HARNESS_PROJECT_ID, IPC } from '@shared/types'
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
import { addRules, listRules, removeRule } from './runtime/permissionRules'
import { isValidRule } from './runtime/ruleMatch'
import { buildAppInfo, buildSettingsInfo, stripSettingsInfo } from './appInfo'
import { checkProjectPath } from './store/projects'
import { checkRunTarget, isValidId } from './windowScope'

export interface IpcServices {
  projects: ProjectStore
  runs: RunManager
  setup: SetupService
  maintenance: MaintenanceService
  settings: SettingsStore
  connections: ConnectionService
  mcp: McpService
  /** Ids of the adapters handed to RunManager; `app:info` reports `mockAdapter` from it. */
  adapterIds: readonly string[]
  /** The virtual harness project (HARNESS_PROJECT_ID), built fresh from the current settings (mcp/assist.ts harnessProject). */
  harnessProject(): Project
  /**
   * window:openRun after validation: focus the window already scoped to this run, or open a new one at
   * `#/run/<projectId>/<runId>` (index.ts window factory).
   */
  openRunWindow(target: FocusRunTarget): void
}

export function registerIpc({ projects, runs, setup, maintenance, settings, connections, mcp, adapterIds, harnessProject, openRunWindow }: IpcServices): void {
  /** A stored project, or the virtual harness project that owns harness-level runs. Never listed by projects:list. */
  const projectOrHarness = (id: string): Project | null => (id === HARNESS_PROJECT_ID ? harnessProject() : projects.get(id))
  ipcMain.handle(IPC.projectsList, () => projects.list())
  ipcMain.handle(IPC.projectsGet, (_e, id: string) => projectOrHarness(id))
  // Throws a readable message for a bad path (the form shows it) or a mock project without the mock adapter.
  ipcMain.handle(IPC.projectsCreate, (_e, input: ProjectCreateInput) =>
    projects.create(input, settings.get(), { mockAvailable: adapterIds.includes('mock') })
  )
  ipcMain.handle(IPC.projectsCheckPath, (_e, path: string): ProjectPathCheck => checkProjectPath(path))
  // The renderer's copy never changes mcpServers or plugins; those go through mcp:* and plugins:*.
  ipcMain.handle(IPC.projectsSave, (_e, project: Project) => {
    if (project?.id === HARNESS_PROJECT_ID) throw new Error('The harness project cannot be saved.')
    return projects.saveFromRenderer(project)
  })
  ipcMain.handle(IPC.projectsRemove, async (_e, id: string) => {
    if (id === HARNESS_PROJECT_ID) throw new Error('The harness project cannot be removed.')
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
    const existing = projectOrHarness(from.projectId)
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
  ipcMain.handle(IPC.runsListLive, (): RunSummary[] => runs.liveRuns())
  ipcMain.handle(IPC.runsPendingCards, (_e, runId: unknown): PendingCards => {
    if (!isValidId(runId)) throw new Error('Invalid run id')
    return runs.pendingCards(runId)
  })
  ipcMain.handle(IPC.windowOpenRun, (_e, input: FocusRunTarget): void => {
    const target = checkRunTarget(input, {
      project: (id) => projectOrHarness(id),
      runProject: (runId) => runs.summary(runId)?.projectId
    })
    openRunWindow(target)
  })
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

  // settings.set() notifies SettingsStore listeners: index.ts applies the theme and broadcasts settings:changed.
  const settingsInfo = (): AppSettingsInfo => buildSettingsInfo(settings.get(), { dataDir: settings.dataDir, appVersion: app.getVersion() })
  ipcMain.handle(IPC.settingsGet, () => settingsInfo())
  ipcMain.handle(IPC.settingsSet, (_e, next: AppSettings) => {
    settings.set(stripSettingsInfo(next))
    return settingsInfo()
  })
  // Deprecated (phase 1 removes NotificationsToggle): a mirror of AppSettings.notifications, the only source the
  // notifier reads.
  ipcMain.handle(IPC.appSetNotifications, (_e, enabled: boolean): void => {
    settings.set({ ...settings.get(), notifications: !!enabled })
  })
  ipcMain.handle(IPC.appOpenPath, (_e, path: string) => shell.openPath(path))
  ipcMain.handle(IPC.appLogPath, () => logPath())
  ipcMain.handle(IPC.appInfo, (): AppInfo => buildAppInfo(app, { platform: process.platform, logsDir: logsDir(), adapterIds }))
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
  ipcMain.handle(IPC.permissionsAdd, (_e, input: { projectId: string; rule: string }) => {
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    const rule = String(input.rule ?? '').trim()
    if (!isValidRule(rule)) throw new Error('A rule looks like Tool(prefix:*), Tool(exact command) or a bare tool name, e.g. Bash(gh:*)')
    return addRules(project.path, [rule])
  })
  ipcMain.handle(
    IPC.permissionsDecideRequest,
    (_e, input: { runId: string; requestId: string; decision: PermissionRuleDecision }) =>
      runs.decideRules(input.runId, input.requestId, input.decision)
  )

  registerConnectionIpc(projects, connections)
  registerMcpIpc(runs, mcp, projectOrHarness)
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
function registerMcpIpc(runs: RunManager, mcp: McpService, projectOrHarness: (id: string) => Project | null): void {
  ipcMain.handle(IPC.mcpList, (_e, projectId: string): McpServerInfo[] => mcp.list(projectId))
  ipcMain.handle(IPC.mcpUpsert, (_e, input: McpUpsertInput): McpMutationResult => mcp.upsert(input))
  ipcMain.handle(IPC.mcpRemove, (_e, input: { projectId: string; serverId: string }): McpMutationResult => mcp.remove(input))
  ipcMain.handle(IPC.mcpSetSecret, (_e, input: McpSecretInput): McpMutationResult => mcp.setSecret(input))
  ipcMain.handle(IPC.mcpTest, (_e, input: { projectId: string; serverId: string }): Promise<McpTestResult> => mcp.test(input))
  ipcMain.handle(IPC.mcpRegistrySearch, (_e, input: McpRegistrySearchInput): Promise<McpRegistrySearchResult> => mcp.registrySearch(input))
  ipcMain.handle(IPC.mcpAnswerInstall, (_e, input: McpAnswerInstallInput): void => runs.answerMcpInstall(input.runId, input.requestId, input.decision))
  // scope 'library' runs the assistant on the virtual harness project; RunManager and the harness tools treat a run
  // whose projectId is HARNESS_PROJECT_ID as library scope.
  ipcMain.handle(IPC.mcpStartAssist, async (_e, input: McpAssistInput): Promise<RunSummary> => {
    const library = input?.scope === 'library'
    const projectId = library ? HARNESS_PROJECT_ID : typeof input?.projectId === 'string' ? input.projectId : ''
    if (!library && projectId === HARNESS_PROJECT_ID) throw new Error('Project not found')
    const project = projectOrHarness(projectId)
    if (!project) throw new Error('Project not found')
    const instruction = typeof input?.instruction === 'string' ? input.instruction : undefined
    return runs.start({ project, kind: 'mcp-assist', prompt: assistPrompt(project, instruction) })
  })
  ipcMain.handle(IPC.mcpLinkLibrary, (_e, input: McpLinkLibraryInput): McpMutationResult => mcp.linkLibrary(input))
  ipcMain.handle(IPC.mcpPromote, (_e, input: { projectId: string; serverId: string }): McpMutationResult => mcp.promote(input))
  // Resolves when the browser flow ends (or fails, as state 'error'); client id and secret are write-only.
  ipcMain.handle(IPC.mcpAuthorize, (_e, input: McpAuthorizeInput): Promise<McpAuthStatus> => mcp.authorize(input))
  ipcMain.handle(IPC.mcpCancelAuthorize, (_e, target: McpAuthTarget): void => mcp.cancelAuthorize(target))
  ipcMain.handle(IPC.mcpRevokeAuth, (_e, target: McpAuthTarget): McpAuthStatus => mcp.revokeAuth(target))
  ipcMain.handle(IPC.mcpLibraryList, (): McpLibraryInfo[] => mcp.libraryList())
  ipcMain.handle(IPC.mcpLibraryUpsert, (_e, entry: McpLibraryEntry): McpLibraryInfo[] => mcp.libraryUpsert(entry))
  ipcMain.handle(IPC.mcpLibraryRemove, (_e, input: { libraryId: string }): McpLibraryInfo[] => mcp.libraryRemove(input))
  ipcMain.handle(IPC.mcpLibrarySetSecret, (_e, input: McpLibrarySecretInput): McpLibraryInfo[] => mcp.librarySetSecret(input))
  ipcMain.handle(IPC.mcpLibraryTest, (_e, input: { libraryId: string }): Promise<McpTestResult> => mcp.libraryTest(input))
  ipcMain.handle(IPC.pluginsUpsert, (_e, input: PluginUpsertInput): Project => mcp.upsertPlugin(input))
  ipcMain.handle(IPC.pluginsRemove, (_e, input: { projectId: string; pluginId: string }): Project => mcp.removePlugin(input))
}
