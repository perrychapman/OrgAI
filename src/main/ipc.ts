import { exec } from 'node:child_process'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { AppSettings, AppSettingsInfo, AuthStatusResult, DraftRequest, PermissionDecision, Project, ProposalDecision, SetupKind } from '@shared/types'
import { IPC } from '@shared/types'
import type { ProjectStore } from './store/projects'
import type { RunManager } from './runtime/runManager'
import type { SetupService } from './setup/service'
import type { MaintenanceService } from './maintenance'
import type { SettingsStore } from './store/settings'
import { draftOrgChart } from './ai/draft'

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

  ipcMain.handle(IPC.runsStart, async (_e, input: { projectId: string; prompt: string; scaffold?: boolean }) => {
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return runs.start({ project, prompt: input.prompt, scaffold: input.scaffold })
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
  ipcMain.handle(
    IPC.setupDecide,
    (_e, input: { runId: string; proposalId: string; decision: ProposalDecision }) =>
      runs.decideProposal(input.runId, input.proposalId, input.decision)
  )
  ipcMain.handle(IPC.runsSend, (_e, input: { runId: string; text: string }) => runs.send(input.runId, input.text))
  ipcMain.handle(IPC.runsInterrupt, (_e, runId: string) => runs.interrupt(runId))
  ipcMain.handle(IPC.runsStop, (_e, runId: string) => runs.stop(runId))
  ipcMain.handle(IPC.runsList, (_e, projectId: string) => runs.list(projectId))
  ipcMain.handle(
    IPC.runsDecide,
    (_e, input: { runId: string; requestId: string; decision: PermissionDecision }) =>
      runs.decide(input.runId, input.requestId, input.decision)
  )

  ipcMain.handle(IPC.maintListWorktrees, (_e, projectId: string) => maintenance.listWorktrees(projectId))
  ipcMain.handle(IPC.maintIntegrate, (_e, input: { projectId: string; branch: string }) => maintenance.integrateWorktree(input.projectId, input.branch))
  ipcMain.handle(IPC.maintDiscard, (_e, input: { projectId: string; branch: string }) => maintenance.discardWorktree(input.projectId, input.branch))
  ipcMain.handle(IPC.maintUninstall, (_e, projectId: string) => maintenance.uninstallRepo(projectId))

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
