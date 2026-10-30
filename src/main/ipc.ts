import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
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
  PermissionRuleDecision,
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
import { addRules, listRules, removeRule } from './runtime/permissionRules'
import { isValidRule } from './runtime/ruleMatch'
import { buildAppInfo } from './appInfo'

export type TrustedRenderer = { kind: 'origin'; origin: string } | { kind: 'file'; url: string }

/** Build the one renderer location this app trusts. Development trusts only the configured http(s) origin. */
export function trustedRenderer(rendererUrl: string): TrustedRenderer {
  const url = new URL(rendererUrl)
  if (url.protocol === 'file:') {
    url.hash = ''
    url.search = ''
    return { kind: 'file', url: url.href }
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
    return { kind: 'origin', origin: url.origin }
  }
  throw new Error('The renderer URL must be a local file or an http(s) development origin.')
}

/** True only for the packaged renderer document or a page on the configured development origin. */
export function isTrustedRendererUrl(raw: string, trusted: TrustedRenderer): boolean {
  try {
    const url = new URL(raw)
    if (url.username || url.password) return false
    if (trusted.kind === 'origin') return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === trusted.origin
    url.hash = ''
    url.search = ''
    return url.protocol === 'file:' && url.href === trusted.url
  } catch {
    return false
  }
}

/** Validate an untrusted link before delegating it to the operating system. */
export function externalUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

/** IPC is accepted only from the main frame of the trusted renderer. */
export function assertTrustedIpcSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, trusted: TrustedRenderer): void {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !isTrustedRendererUrl(frame.url, trusted)) {
    throw new Error('IPC request rejected: untrusted renderer')
  }
}

type SecureHandle = <Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
) => void

export function secureHandle(trusted: TrustedRenderer): SecureHandle {
  return function handle<Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
  ): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      assertTrustedIpcSender(event, trusted)
      return listener(event, ...(args as unknown as Args))
    })
  }
}

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
  trustedRenderer: TrustedRenderer
}

export function registerIpc({ projects, runs, setup, maintenance, settings, connections, mcp, adapterIds, trustedRenderer: trust }: IpcServices): void {
  const handle = secureHandle(trust)
  handle(IPC.projectsList, () => projects.list())
  handle(IPC.projectsGet, (_e, id: string) => projects.get(id))
  handle(IPC.projectsCreate, (_e, input: { name: string; path: string; brief: string; setupKind?: SetupKind }) =>
    projects.create(input, settings.get())
  )
  // The renderer's copy never changes mcpServers or plugins; those go through mcp:* and plugins:*.
  handle(IPC.projectsSave, (_e, project: Project) => projects.saveFromRenderer(project))
  handle(IPC.projectsRemove, async (_e, id: string) => {
    await runs.removeProject(id)
    mcp.removeProjectSecrets(id)
    projects.remove(id)
  })
  handle(IPC.projectsPickDir, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  handle(IPC.draftOrgChart, async (_e, req: DraftRequest) => {
    const project = projects.get(req.projectId)
    if (!project) throw new Error('Project not found')
    return draftOrgChart(runs.adapterFor(project), project, req)
  })

  handle(IPC.runsStart, async (_e, input: StartRunInput) => {
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return runs.start({ project, prompt: input.prompt, scaffold: input.scaffold, images: input.images })
  })
  handle(IPC.runsGet, (_e, runId: string) => runs.get(runId))

  handle(IPC.setupStart, async (_e, input: { projectId: string; instruction?: string }) => {
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
  handle(IPC.setupRetro, async (_e, input: { projectId: string; runId: string }) => {
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
  handle(
    IPC.setupDecide,
    (_e, input: { runId: string; proposalId: string; decision: ProposalDecision }) =>
      runs.decideProposal(input.runId, input.proposalId, input.decision)
  )
  handle(IPC.runsContinue, async (_e, input: ContinueRunInput) => {
    const from = runs.summary(input.runId)
    if (!from) throw new Error('Run not found')
    const existing = projects.get(from.projectId)
    if (!existing) throw new Error('Project not found')
    // Setup runs re-profile the repo like setup:start so the Architect's hidden context is current.
    const project = from.kind === 'setup' ? await setup.prepare(existing) : existing
    return runs.continueRun(project, input.runId, input.text, input.images)
  })
  handle(IPC.runsResumeNow, (_e, runId: string) => runs.resumeNow(runId))
  handle(IPC.runsCancelAutoResume, (_e, runId: string) => runs.cancelAutoResume(runId))
  handle(
    IPC.setupAnswer,
    (_e, input: { runId: string; questionId: string; answer: QuestionAnswer }) =>
      runs.answerQuestion(input.runId, input.questionId, input.answer)
  )
  handle(IPC.runsSend, (_e, input: SendRunInput) => runs.send(input.runId, input.text, input.images))
  handle(IPC.runsInterrupt, (_e, runId: string) => runs.interrupt(runId))
  handle(IPC.runsStop, (_e, runId: string) => runs.stop(runId))
  handle(IPC.runsList, (_e, projectId: string) => runs.list(projectId))
  handle(
    IPC.runsDecide,
    (_e, input: { runId: string; requestId: string; decision: PermissionDecision }) =>
      runs.decide(input.runId, input.requestId, input.decision)
  )
  handle(IPC.mergesDecide, (_e, input: { runId: string; reviewId: string; decision: MergeDecision }) =>
    runs.decideMerge(input.runId, input.reviewId, input.decision)
  )

  handle(IPC.maintListWorktrees, (_e, projectId: string) => maintenance.listWorktrees(projectId))
  handle(IPC.maintIntegrate, (_e, input: { projectId: string; branch: string }) => maintenance.integrateWorktree(input.projectId, input.branch))
  handle(IPC.maintDiscard, (_e, input: { projectId: string; branch: string }) => maintenance.discardWorktree(input.projectId, input.branch))
  handle(IPC.maintUninstall, (_e, projectId: string) => maintenance.uninstallRepo(projectId))
  handle(IPC.maintDiff, (_e, input: { projectId: string; branch: string }) => maintenance.diffWorktree(input.projectId, input.branch))

  handle(IPC.authStatus, async (): Promise<AuthStatusResult> => {
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
  handle(IPC.settingsGet, () => settingsInfo())
  handle(IPC.settingsSet, (_e, next: AppSettings) => {
    // Drop the read-only field if the renderer echoed it back.
    const { dataDir: _ignored, ...rest } = next as AppSettings & { dataDir?: string }
    settings.set(rest)
    return settingsInfo()
  })
  handle(IPC.appOpenPath, (_e, path: string) => shell.openPath(path))
  handle(IPC.appLogPath, () => logPath())
  handle(IPC.appInfo, (): AppInfo => buildAppInfo(app, { platform: process.platform, logsDir: logsDir(), adapterIds }))
  handle(IPC.appOpenLogs, async () => {
    logPath() // creates the folder if nothing has been logged yet
    const error = await shell.openPath(logsDir())
    if (error) log.warn(`Could not open logs folder: ${error}`)
  })
  handle(IPC.permissionsList, (_e, projectId: string) => {
    const project = projects.get(projectId)
    if (!project) throw new Error('Project not found')
    return listRules(project.path)
  })
  handle(IPC.permissionsRemove, (_e, input: { projectId: string; rule: string }) => {
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return removeRule(project.path, input.rule)
  })
  handle(IPC.permissionsAdd, (_e, input: { projectId: string; rule: string }) => {
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    const rule = String(input.rule ?? '').trim()
    if (!isValidRule(rule)) throw new Error('A rule looks like Tool(prefix:*), Tool(exact command) or a bare tool name, e.g. Bash(gh:*)')
    return addRules(project.path, [rule])
  })
  handle(
    IPC.permissionsDecideRequest,
    (_e, input: { runId: string; requestId: string; decision: PermissionRuleDecision }) =>
      runs.decideRules(input.runId, input.requestId, input.decision)
  )

  registerConnectionIpc(projects, connections, handle)
  registerMcpIpc(projects, runs, mcp, handle)
}

/** Connections, model catalog and remaps: ConnectionService 1:1. */
function registerConnectionIpc(projects: ProjectStore, connections: ConnectionService, handle: SecureHandle): void {
  handle(IPC.connectionsList, (): Promise<ConnectionInfo[]> => connections.list())
  handle(IPC.connectionsUpdate, (_e, connection: ProviderConnection): Promise<ConnectionInfo> => {
    if (!CONNECTION_IDS.includes(connection?.id)) throw new Error('Unknown connection')
    return connections.update(connection)
  })
  handle(IPC.connectionsSetSecret, (_e, input: ConnectionSecretInput): Promise<ConnectionInfo> => connections.setSecret(input))
  handle(IPC.connectionsTest, (_e, id: ConnectionId): Promise<ConnectionStatus> => connections.test(id))
  handle(IPC.connectionsConnect, (_e, id: ConnectionId): Promise<ConnectionInfo> => connections.connect(id))
  handle(IPC.connectionsLogin, (_e, id: 'openai', method?: ConnectionLoginMethod): Promise<ConnectionLoginStart> =>
    connections.login(id, method === 'deviceCode' ? 'deviceCode' : 'browser')
  )
  handle(IPC.connectionsCancelLogin, (_e, loginId: string): Promise<void> => connections.cancelLogin(loginId))
  handle(IPC.connectionsLogout, (_e, id: ConnectionId): Promise<ConnectionInfo> => connections.logout(id))
  handle(IPC.modelsList, (_e, query?: ModelsQuery): ProviderModel[] => connections.models(query))
  handle(IPC.modelsRefresh, (_e, query?: ModelsQuery): Promise<ProviderModel[]> => connections.refresh(query))
  handle(IPC.projectsRemapModels, (_e, input: RemapModelsInput): RemapModelsOutput => {
    if (!projects.get(input.projectId)) throw new Error('Project not found')
    return connections.remapModels(input)
  })
  handle(IPC.projectsPreviewRemap, (_e, input: RemapModelsInput): RemapResult => connections.previewRemap(input))
}

/** MCP servers, plugins, registry search and install approvals: McpService 1:1, installs and the assistant via RunManager. */
function registerMcpIpc(projects: ProjectStore, runs: RunManager, mcp: McpService, handle: SecureHandle): void {
  handle(IPC.mcpList, (_e, projectId: string): McpServerInfo[] => mcp.list(projectId))
  handle(IPC.mcpUpsert, (_e, input: McpUpsertInput): McpMutationResult => mcp.upsert(input))
  handle(IPC.mcpRemove, (_e, input: { projectId: string; serverId: string }): McpMutationResult => mcp.remove(input))
  handle(IPC.mcpSetSecret, (_e, input: McpSecretInput): McpMutationResult => mcp.setSecret(input))
  handle(IPC.mcpTest, (_e, input: { projectId: string; serverId: string }): Promise<McpTestResult> => mcp.test(input))
  handle(IPC.mcpRegistrySearch, (_e, input: McpRegistrySearchInput): Promise<McpRegistrySearchResult> => mcp.registrySearch(input))
  handle(IPC.mcpAnswerInstall, (_e, input: McpAnswerInstallInput): void => runs.answerMcpInstall(input.runId, input.requestId, input.decision))
  handle(IPC.mcpStartAssist, async (_e, input: McpAssistInput): Promise<RunSummary> => {
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return runs.start({ project, kind: 'mcp-assist', prompt: assistPrompt(project, input.instruction) })
  })
  handle(IPC.pluginsUpsert, (_e, input: PluginUpsertInput): Project => mcp.upsertPlugin(input))
  handle(IPC.pluginsRemove, (_e, input: { projectId: string; pluginId: string }): Project => mcp.removePlugin(input))
}
