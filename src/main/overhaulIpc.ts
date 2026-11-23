import { app, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  AGENT_MESSAGE_MAX_CHARS,
  OVERHAUL_IPC,
  RUN_ADD_BUDGET_MAX_USD,
  type AddRunBudgetInput,
  type GitSummary,
  type MessageAgentInput,
  type OrgTemplateInfo,
  type ProjectSpend,
  type RetryRunInput,
  type RunEstimate,
  type RunEstimateQuery,
  type RunHold,
  type RunSummary,
  type ScheduleCostReport,
  type ScheduleHistoryEntry,
  type SkipReviewInput,
  type StopAgentResult,
  type SupportDetails
} from '../shared/types'
import { projectKindOf } from '../shared/defaults'
import type { HostActivityTrackerApi } from './host/types'
import type { ProjectStore } from './store/projects'
import type { RunManager } from './runtime/runManager'
import type { ScheduleService } from './schedules/service'
import type { TemplateService } from './setup/templates'
import type { ConnectionService } from './connections/service'
import { estimateRun } from './runtime/estimate'
import { projectSpend } from './runtime/projectSpend'
import { scheduleCosts } from './schedules/scheduleCost'
import { gitBranches, gitSummary } from './projects/gitInfo'
import { forgetAgentFolders, rememberAgentFolder } from './agentFolderPicks'
import { licencePaths, reportProblemUrl, supportDetails, type AboutDeps } from './about'
import { log } from './log'

/**
 * UI overhaul channels (OVERHAUL_IPC). Desktop only: every handler checks the sender is an OrgAI window; none is on the
 * host dispatcher, so the socket, the CLI and agents (self-control) cannot reach them. Run actions are explicit user
 * actions; RunManager applies the existing enforcement (caps, modes, delegation, merge review).
 */
export interface OverhaulIpcServices {
  projects: ProjectStore
  runs: RunManager
  schedules?: ScheduleService
  templates: TemplateService
  connections: ConnectionService
}

type Handler = (e: IpcMainInvokeEvent, ...args: never[]) => unknown

function requireWindow(e: IpcMainInvokeEvent): void {
  const win = e?.sender ? BrowserWindow.fromWebContents(e.sender) : null
  if (!win || win.isDestroyed()) throw new Error('Refused: not an OrgAI window.')
}

function obj<T>(v: unknown): T {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid input')
  return v as T
}

function idArg(v: unknown, what = 'id'): string {
  if (typeof v !== 'string' || !v || v.length > 200 || /[\x00-\x1f\x7f]/.test(v)) throw new Error(`Invalid ${what}`)
  return v
}

function optText(v: unknown, max: number): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v.length > max) throw new Error('Invalid text')
  return v
}

function stringList(v: unknown, max = 200): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length > max) throw new Error('Invalid list')
  return v.map((s) => idArg(s, 'role id'))
}

export function registerOverhaulIpc(
  handle: (channel: string, fn: Handler) => void,
  handleRead: (channel: string, fn: Handler) => void,
  services: OverhaulIpcServices
): void {
  const { projects, runs } = services
  const projectOf = (id: unknown): NonNullable<ReturnType<ProjectStore['get']>> => {
    const p = projects.get(idArg(id, 'project id'))
    if (!p) throw new Error('Project not found')
    return p
  }

  // ---- insights (read-only) ----
  handleRead(OVERHAUL_IPC.runsEstimate, (e, raw: unknown): RunEstimate => {
    requireWindow(e)
    const q = obj<RunEstimateQuery>(raw)
    const project = projectOf(q.projectId)
    const query: RunEstimateQuery = { projectId: project.id, ...(q.team === 'single' ? { team: 'single' } : {}), ...(q.excludeRoleIds ? { excludeRoleIds: stringList(q.excludeRoleIds) } : {}) }
    return estimateRun(runs.list(project.id), query, Date.now())
  })
  handleRead(OVERHAUL_IPC.schedulesCosts, (e): ScheduleCostReport => {
    requireWindow(e)
    const s = services.schedules
    if (!s) return { schedules: [], weeklyTotalUsd: null, unknownCount: 0, generatedAt: Date.now() }
    return scheduleCosts(s.list(), (id) => s.history(id), Date.now())
  })
  handleRead(OVERHAUL_IPC.schedulesPeekHistory, (e, scheduleId: unknown): ScheduleHistoryEntry[] => {
    requireWindow(e)
    const s = services.schedules
    if (!s) return []
    const id = idArg(scheduleId, 'schedule id')
    if (!s.get(id)) throw new Error('That schedule no longer exists.')
    return s.peekHistory(id)
  })
  handleRead(OVERHAUL_IPC.projectsSpend, (e, projectId: unknown): ProjectSpend => {
    requireWindow(e)
    const project = projectOf(projectId)
    return projectSpend(project, runs.list(project.id), Date.now())
  })

  // ---- run actions (explicit user actions; RunManager enforces) ----
  handleRead(OVERHAUL_IPC.runsHold, (e, runId: unknown): RunHold | null => {
    requireWindow(e)
    return runs.holdOf(idArg(runId, 'run id'))
  })
  handle(OVERHAUL_IPC.runsAddBudget, (e, raw: unknown): Promise<RunSummary> => {
    requireWindow(e)
    const i = obj<AddRunBudgetInput>(raw)
    if (typeof i.addUsd !== 'number' || !Number.isFinite(i.addUsd) || i.addUsd <= 0 || i.addUsd > RUN_ADD_BUDGET_MAX_USD) throw new Error('Choose an amount above $0.')
    return runs.addBudget({ runId: idArg(i.runId, 'run id'), addUsd: i.addUsd, ...(optText(i.text, 100_000) !== undefined ? { text: i.text as string } : {}) })
  })
  handle(OVERHAUL_IPC.runsRetry, (e, raw: unknown): Promise<RunSummary> => {
    requireWindow(e)
    const i = obj<RetryRunInput>(raw)
    return runs.retryRun({ runId: idArg(i.runId, 'run id'), ...(optText(i.text, 100_000) !== undefined ? { text: i.text as string } : {}) })
  })
  handle(OVERHAUL_IPC.runsSkipReview, (e, raw: unknown): Promise<void> => {
    requireWindow(e)
    const i = obj<SkipReviewInput>(raw)
    return runs.skipReview({ runId: idArg(i.runId, 'run id'), ...(optText(i.note, 2000) !== undefined ? { note: i.note as string } : {}) })
  })
  handle(OVERHAUL_IPC.runsMessageAgent, (e, raw: unknown): Promise<void> => {
    requireWindow(e)
    const i = obj<MessageAgentInput>(raw)
    const text = optText(i.text, AGENT_MESSAGE_MAX_CHARS)
    if (!text || !text.trim()) throw new Error('Nothing to send')
    return runs.messageAgent({ runId: idArg(i.runId, 'run id'), agentId: idArg(i.agentId, 'agent id'), text })
  })
  handle(OVERHAUL_IPC.runsStopAgent, (e, raw: unknown): Promise<StopAgentResult> => {
    requireWindow(e)
    const i = obj<{ runId: string; agentId: string }>(raw)
    return runs.stopAgent({ runId: idArg(i.runId, 'run id'), agentId: idArg(i.agentId, 'agent id') })
  })

  // ---- git (read-only) ----
  handleRead(OVERHAUL_IPC.gitSummary, async (e, projectId: unknown): Promise<GitSummary | null> => {
    requireWindow(e)
    const project = projectOf(projectId)
    if (projectKindOf(project) !== 'code') return null
    return gitSummary(project.path, project.mainBranch)
  })
  handleRead(OVERHAUL_IPC.gitBranches, async (e, projectId: unknown): Promise<string[]> => {
    requireWindow(e)
    const project = projectOf(projectId)
    if (projectKindOf(project) !== 'code') return []
    return gitBranches(project.path, project.mainBranch)
  })

  // ---- import folder picker ----
  handleRead(OVERHAUL_IPC.pickAgentFolder, async (e): Promise<string | null> => {
    requireWindow(e)
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const picked = result.canceled ? null : result.filePaths[0] ?? null
    if (picked) {
      const id = e.sender.id
      rememberAgentFolder(id, picked)
      e.sender.once('destroyed', () => forgetAgentFolders(id))
    }
    return picked
  })

  // ---- templates ----
  handle(OVERHAUL_IPC.templatesDuplicate, (e, templateId: unknown): OrgTemplateInfo => {
    requireWindow(e)
    return services.templates.duplicate(idArg(templateId, 'template id'))
  })

  // ---- about ----
  const aboutDeps = (): AboutDeps => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    connectionStates: async () => {
      const out: Record<string, string> = {}
      try {
        for (const c of await services.connections.list()) out[c.connection.id] = c.status.state
      } catch {
        /* support details never fail on a connection read */
      }
      return out
    }
  })
  handleRead(OVERHAUL_IPC.aboutSupportDetails, (e): Promise<SupportDetails> => {
    requireWindow(e)
    return supportDetails(aboutDeps())
  })
  handleRead(OVERHAUL_IPC.aboutReportProblem, async (e): Promise<void> => {
    requireWindow(e)
    const url = reportProblemUrl(aboutDeps())
    if (!url.startsWith('https://github.com/perrychapman/OrgAI/issues/new')) throw new Error('Refused')
    await shell.openExternal(url)
  })
  handleRead(OVERHAUL_IPC.aboutOpenLicences, async (e): Promise<string> => {
    requireWindow(e)
    const file = licencePaths(app.getAppPath(), dirname(process.execPath)).find((p) => existsSync(p))
    if (!file) return 'The licences file is not part of this build.'
    const error = await shell.openPath(file)
    if (error) log.warn(`Could not open the licences file: ${error}`)
    return error
  })
}

/** For main/ipc.ts: the activity-leased and plain registration helpers it already has. */
export type OverhaulActivity = HostActivityTrackerApi
