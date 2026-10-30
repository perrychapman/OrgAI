import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppSettings,
  AppSettingsInfo,
  ConnectionEvent,
  ContinueRunInput,
  DraftRequest,
  FocusRunTarget,
  McpLibraryInfo,
  OrgAIApi,
  PermissionDecision,
  Project,
  RunEvent,
  SendRunInput,
  StartRunInput
} from '../shared/types'
import { IPC } from '../shared/types'

const api: OrgAIApi = {
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    get: (id: string) => ipcRenderer.invoke(IPC.projectsGet, id),
    create: (input) => ipcRenderer.invoke(IPC.projectsCreate, input),
    save: (project: Project) => ipcRenderer.invoke(IPC.projectsSave, project),
    remove: (id: string) => ipcRenderer.invoke(IPC.projectsRemove, id),
    pickDirectory: () => ipcRenderer.invoke(IPC.projectsPickDir),
    checkPath: (path: string) => ipcRenderer.invoke(IPC.projectsCheckPath, path),
    remapModels: (input) => ipcRenderer.invoke(IPC.projectsRemapModels, input),
    previewRemap: (input) => ipcRenderer.invoke(IPC.projectsPreviewRemap, input)
  },
  connections: {
    list: () => ipcRenderer.invoke(IPC.connectionsList),
    update: (connection) => ipcRenderer.invoke(IPC.connectionsUpdate, connection),
    setSecret: (input) => ipcRenderer.invoke(IPC.connectionsSetSecret, input),
    test: (id) => ipcRenderer.invoke(IPC.connectionsTest, id),
    connect: (id) => ipcRenderer.invoke(IPC.connectionsConnect, id),
    login: (id, method) => ipcRenderer.invoke(IPC.connectionsLogin, id, method),
    cancelLogin: (loginId) => ipcRenderer.invoke(IPC.connectionsCancelLogin, loginId),
    logout: (id) => ipcRenderer.invoke(IPC.connectionsLogout, id)
  },
  models: {
    list: (query) => ipcRenderer.invoke(IPC.modelsList, query),
    refresh: (query) => ipcRenderer.invoke(IPC.modelsRefresh, query)
  },
  onConnectionEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: ConnectionEvent): void => cb(event)
    ipcRenderer.on(IPC.connectionsEvent, listener)
    return () => ipcRenderer.removeListener(IPC.connectionsEvent, listener)
  },
  mcp: {
    list: (projectId) => ipcRenderer.invoke(IPC.mcpList, projectId),
    upsert: (input) => ipcRenderer.invoke(IPC.mcpUpsert, input),
    remove: (input) => ipcRenderer.invoke(IPC.mcpRemove, input),
    setSecret: (input) => ipcRenderer.invoke(IPC.mcpSetSecret, input),
    test: (input) => ipcRenderer.invoke(IPC.mcpTest, input),
    registrySearch: (input) => ipcRenderer.invoke(IPC.mcpRegistrySearch, input),
    answerInstall: (input) => ipcRenderer.invoke(IPC.mcpAnswerInstall, input),
    startAssist: (input) => ipcRenderer.invoke(IPC.mcpStartAssist, input),
    linkLibrary: (input) => ipcRenderer.invoke(IPC.mcpLinkLibrary, input),
    promote: (input) => ipcRenderer.invoke(IPC.mcpPromote, input),
    authorize: (input) => ipcRenderer.invoke(IPC.mcpAuthorize, input),
    cancelAuthorize: (target) => ipcRenderer.invoke(IPC.mcpCancelAuthorize, target),
    revokeAuth: (target) => ipcRenderer.invoke(IPC.mcpRevokeAuth, target)
  },
  mcpLibrary: {
    list: () => ipcRenderer.invoke(IPC.mcpLibraryList),
    upsert: (entry) => ipcRenderer.invoke(IPC.mcpLibraryUpsert, entry),
    remove: (input) => ipcRenderer.invoke(IPC.mcpLibraryRemove, input),
    setSecret: (input) => ipcRenderer.invoke(IPC.mcpLibrarySetSecret, input),
    test: (input) => ipcRenderer.invoke(IPC.mcpLibraryTest, input)
  },
  onMcpLibraryChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, entries: McpLibraryInfo[]): void => cb(entries)
    ipcRenderer.on(IPC.mcpLibraryChanged, listener)
    return () => ipcRenderer.removeListener(IPC.mcpLibraryChanged, listener)
  },
  plugins: {
    upsert: (input) => ipcRenderer.invoke(IPC.pluginsUpsert, input),
    remove: (input) => ipcRenderer.invoke(IPC.pluginsRemove, input)
  },
  draft: {
    orgChart: (req: DraftRequest) => ipcRenderer.invoke(IPC.draftOrgChart, req)
  },
  runs: {
    start: (input: StartRunInput) => ipcRenderer.invoke(IPC.runsStart, input),
    send: (input: SendRunInput) => ipcRenderer.invoke(IPC.runsSend, input),
    interrupt: (runId: string) => ipcRenderer.invoke(IPC.runsInterrupt, runId),
    stop: (runId: string) => ipcRenderer.invoke(IPC.runsStop, runId),
    list: (projectId: string) => ipcRenderer.invoke(IPC.runsList, projectId),
    get: (runId: string) => ipcRenderer.invoke(IPC.runsGet, runId),
    decide: (input: { runId: string; requestId: string; decision: PermissionDecision }) =>
      ipcRenderer.invoke(IPC.runsDecide, input),
    continue: (input: ContinueRunInput) => ipcRenderer.invoke(IPC.runsContinue, input),
    decideMerge: (input) => ipcRenderer.invoke(IPC.mergesDecide, input),
    resumeNow: (runId: string) => ipcRenderer.invoke(IPC.runsResumeNow, runId),
    cancelAutoResume: (runId: string) => ipcRenderer.invoke(IPC.runsCancelAutoResume, runId),
    listLive: () => ipcRenderer.invoke(IPC.runsListLive)
  },
  window: {
    // Only the two ids cross; main validates them against the stores before opening anything.
    openRun: (target: FocusRunTarget) => ipcRenderer.invoke(IPC.windowOpenRun, { projectId: target?.projectId, runId: target?.runId })
  },
  setup: {
    start: (input) => ipcRenderer.invoke(IPC.setupStart, input),
    retro: (input) => ipcRenderer.invoke(IPC.setupRetro, input),
    decide: (input) => ipcRenderer.invoke(IPC.setupDecide, input),
    answer: (input) => ipcRenderer.invoke(IPC.setupAnswer, input)
  },
  maintenance: {
    listWorktrees: (projectId: string) => ipcRenderer.invoke(IPC.maintListWorktrees, projectId),
    integrateWorktree: (input) => ipcRenderer.invoke(IPC.maintIntegrate, input),
    discardWorktree: (input) => ipcRenderer.invoke(IPC.maintDiscard, input),
    uninstallRepo: (projectId: string) => ipcRenderer.invoke(IPC.maintUninstall, projectId),
    diffWorktree: (input) => ipcRenderer.invoke(IPC.maintDiff, input)
  },
  permissions: {
    list: (projectId: string) => ipcRenderer.invoke(IPC.permissionsList, projectId),
    remove: (input) => ipcRenderer.invoke(IPC.permissionsRemove, input),
    add: (input) => ipcRenderer.invoke(IPC.permissionsAdd, input),
    decideRequest: (input) => ipcRenderer.invoke(IPC.permissionsDecideRequest, input)
  },
  onRunEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: RunEvent): void => cb(event)
    ipcRenderer.on(IPC.runEvent, listener)
    return () => ipcRenderer.removeListener(IPC.runEvent, listener)
  },
  auth: {
    status: () => ipcRenderer.invoke(IPC.authStatus)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (s: AppSettings) => ipcRenderer.invoke(IPC.settingsSet, s)
  },
  onSettingsChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, settings: AppSettingsInfo): void => cb(settings)
    ipcRenderer.on(IPC.settingsChanged, listener)
    return () => ipcRenderer.removeListener(IPC.settingsChanged, listener)
  },
  app: {
    openPath: (path: string) => ipcRenderer.invoke(IPC.appOpenPath, path),
    openLogs: () => ipcRenderer.invoke(IPC.appOpenLogs),
    logPath: () => ipcRenderer.invoke(IPC.appLogPath),
    info: () => ipcRenderer.invoke(IPC.appInfo)
  },
  onFocusRun: (cb) => {
    const listener = (_e: IpcRendererEvent, target: FocusRunTarget): void => cb(target)
    ipcRenderer.on(IPC.appFocusRun, listener)
    return () => ipcRenderer.removeListener(IPC.appFocusRun, listener)
  },
  usage: {
    refresh: () => ipcRenderer.invoke(IPC.usageRefresh)
  },
  notifications: {
    /** @deprecated Mirrors into AppSettings.notifications; removed with NotificationsToggle in phase 1. */
    setEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC.appSetNotifications, enabled)
  }
}

contextBridge.exposeInMainWorld('orgai', api)
