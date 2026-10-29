import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DraftRequest, OrgAIApi, PermissionDecision, Project, RunEvent } from '../shared/types'
import { IPC } from '../shared/types'

const api: OrgAIApi = {
  projects: {
    list: () => ipcRenderer.invoke(IPC.projectsList),
    get: (id: string) => ipcRenderer.invoke(IPC.projectsGet, id),
    create: (input) => ipcRenderer.invoke(IPC.projectsCreate, input),
    save: (project: Project) => ipcRenderer.invoke(IPC.projectsSave, project),
    remove: (id: string) => ipcRenderer.invoke(IPC.projectsRemove, id),
    pickDirectory: () => ipcRenderer.invoke(IPC.projectsPickDir)
  },
  draft: {
    orgChart: (req: DraftRequest) => ipcRenderer.invoke(IPC.draftOrgChart, req)
  },
  runs: {
    start: (input) => ipcRenderer.invoke(IPC.runsStart, input),
    send: (input) => ipcRenderer.invoke(IPC.runsSend, input),
    interrupt: (runId: string) => ipcRenderer.invoke(IPC.runsInterrupt, runId),
    stop: (runId: string) => ipcRenderer.invoke(IPC.runsStop, runId),
    list: (projectId: string) => ipcRenderer.invoke(IPC.runsList, projectId),
    get: (runId: string) => ipcRenderer.invoke(IPC.runsGet, runId),
    decide: (input: { runId: string; requestId: string; decision: PermissionDecision }) =>
      ipcRenderer.invoke(IPC.runsDecide, input),
    continue: (input) => ipcRenderer.invoke(IPC.runsContinue, input)
  },
  setup: {
    start: (input) => ipcRenderer.invoke(IPC.setupStart, input),
    decide: (input) => ipcRenderer.invoke(IPC.setupDecide, input)
  },
  maintenance: {
    listWorktrees: (projectId: string) => ipcRenderer.invoke(IPC.maintListWorktrees, projectId),
    integrateWorktree: (input) => ipcRenderer.invoke(IPC.maintIntegrate, input),
    discardWorktree: (input) => ipcRenderer.invoke(IPC.maintDiscard, input),
    uninstallRepo: (projectId: string) => ipcRenderer.invoke(IPC.maintUninstall, projectId)
  },
  onRunEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: RunEvent): void => cb(event)
    ipcRenderer.on(IPC.runEvent, listener)
    return () => ipcRenderer.removeListener(IPC.runEvent, listener)
  },
  auth: {
    status: () => ipcRenderer.invoke(IPC.authStatus)
  }
}

contextBridge.exposeInMainWorld('orgai', api)
