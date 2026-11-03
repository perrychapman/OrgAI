import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import type {
  AgentImportApplyInput,
  AgentImportApplyResult,
  AgentImportInput,
  AgentImportPreview,
  AgentImportScan,
  OrgExportResult,
  AppInfo,
  AppSettings,
  AppSettingsInfo,
  AuthStatusResult,
  CapabilityApplyInput,
  CapabilityApplyResult,
  CapabilityDiscoverInput,
  CapabilityDiscovery,
  CapabilityRecommendInput,
  CapabilityUndoInput,
  CapabilityUndoResult,
  ConnectionId,
  ConnectionInfo,
  ConnectionLoginMethod,
  ConnectionLoginStart,
  ConnectionSecretInput,
  ConnectionStatus,
  ContinueRunInput,
  DraftRequest,
  FocusRunTarget,
  ConnectorAddInput,
  ConnectorInfo,
  ConnectorTokenInput,
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
  ModelPriceInfo,
  ModelPricesQuery,
  UsageStats,
  UsageStatsQuery,
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
  SetupStartInput,
  SendRunInput,
  SkillApplySuggestionInput,
  SkillContent,
  SkillCreateInput,
  SkillDraft,
  SkillEvaluationReport,
  SkillImportApplyInput,
  SkillImportApplyResult,
  SkillImportInput,
  SkillImportPreview,
  SkillInfo,
  SkillLibraryFolderInput,
  SkillLibraryInfo,
  SkillLinkLibraryInput,
  SkillMutationResult,
  SkillUpdateInput,
  StartRunInput,
  TeamDismissInput,
  TeamRestoreInput,
  TeamRecommendations,
  TeamReview,
  TeamReviewInput
} from '@shared/types'
import type { QuickRunInput, QuickRunPromoteInput, QuickRunPromoteResult } from '@shared/types'
import { CONNECTION_IDS, HARNESS_PROJECT_ID, IPC, QUICK_PROJECT_ID, PROPOSAL_NOTE_MAX_CHARS, QUICK_RUN_MAX_PROMPT_CHARS, SKILLS_PROJECT_ID, isVirtualProjectId } from '@shared/types'
import { isSafeId } from '@shared/defaults'
import { sanitizeImages } from './runtime/attachments'
import { skillAssistPrompt, skillsProject } from './skills/assist'
import { harnessProject as buildHarnessProject } from './mcp/assist'
import { createScratchDir, scratchDirFor, validateQuickFolder } from './quick/scratch'
import { existsSync } from 'node:fs'
import type { QuickRunService } from './quick/quickRuns'
import type { ProjectStore } from './store/projects'
import type { RunManager } from './runtime/runManager'
import type { SetupService } from './setup/service'
import type { MaintenanceService } from './maintenance'
import type { SettingsStore } from './store/settings'
import type { ConnectionService } from './connections/service'
import type { McpService } from './mcp/service'
import type { AgentImportService } from './setup/import/importer'
import { applySuggestion, type SkillEvaluationApi, type SkillServiceApi } from './skills/types'
import type { CapabilityServiceApi } from './capabilities/types'
import { claudeAuthStatus } from './connections/anthropicAuth'
import { assistPrompt } from './mcp/assist'
import { draftOrgChart } from './ai/draft'
import { projectConnection } from '@shared/defaults'
import { log, logPath, logsDir } from './log'
import { addRules, allowRuleRefusal, listRules, removeRule, ruleSaveRefusal } from './runtime/permissionRules'
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
  /** Agent import and org export (src/main/setup/import/importer.ts). */
  importer: AgentImportService
  /** Project skills, the skill library and the repo skill import (src/main/skills/service.ts). */
  skills: SkillServiceApi
  /** Skill evaluation (src/main/skills/evaluation.ts). */
  skillEvaluation: SkillEvaluationApi
  /** The Team assistant: discovery, recommendations, apply and grants (src/main/capabilities/service.ts). */
  capabilities: CapabilityServiceApi
  /** Chat (quick runs): start, promote, the project of a continued run and the display project (src/main/quick/quickRuns.ts). */
  quick: QuickRunService
}

/** Longest instruction accepted for the MCP and Skill assistants; longer is cut. */
export const ASSIST_INSTRUCTION_MAX_CHARS = 8000
/**
 * The project a harness-level run continues or auto-resumes in. A build session (summary.buildWorkspace) gets its
 * workspace back (harnessProject allowBuild) only when the recorded path is exactly a <data>/quick/quick_<id> scratch
 * dir that still exists; a forged or vanished path throws instead of running without the workspace. Exported for tests.
 */
export function harnessProjectFor(
  summary: Pick<RunSummary, 'buildWorkspace'>,
  settings: AppSettings,
  dataDir: string,
  mock: boolean,
  exists: (p: string) => boolean = existsSync
): Project {
  const ws = summary.buildWorkspace
  if (ws === undefined) return buildHarnessProject(settings, dataDir, { mock })
  const dir = scratchDirFor(dataDir, ws)
  if (!dir || !exists(dir)) throw new Error("This build session's workspace is gone; start a new one.")
  return buildHarnessProject(settings, dataDir, { mock, allowBuild: true, workspace: dir })
}

/**
 * Checks a continued or messaged quick run: prompt at most QUICK_RUN_MAX_PROMPT_CHARS (refused, never cut) and, for a
 * non-scratch folder, validateQuickFolder again (it may have become a link into the data dir). Exported for tests.
 */
export function checkQuickContinue(summary: Pick<RunSummary, 'quick'>, text: unknown, dataDir: string, validate: (folder: unknown, dataDir: string) => unknown = validateQuickFolder): void {
  if (!summary.quick) return
  if (typeof text === 'string' && text.length > QUICK_RUN_MAX_PROMPT_CHARS) {
    throw new Error(`That message is too long (at most ${QUICK_RUN_MAX_PROMPT_CHARS.toLocaleString('en-US')} characters).`)
  }
  if (!summary.quick.scratch) validate(summary.quick.folder, dataDir)
}

/** Longest folder path accepted for a quick run; QuickRunService validates the folder itself. */
const QUICK_FOLDER_MAX_CHARS = 4096

/**
 * Renderer input for runs:startQuick / runs:promoteQuick rebuilt field by field: a prompt that is text, trimmed and at
 * most QUICK_RUN_MAX_PROMPT_CHARS (longer is refused, never cut), a folder as text (checked by QuickRunService), the
 * team only 'single' | 'default' (anything else is 'single'), allowEdits only when the literal true, images through
 * the run image sanitizer; any other field is dropped. Exported for tests.
 */
export const quickArgs = {
  start(input: unknown): QuickRunInput {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.prompt !== 'string') throw new Error('Type what you want done.')
    const prompt = i.prompt.trim()
    if (prompt.length > QUICK_RUN_MAX_PROMPT_CHARS) throw new Error(`That message is too long (at most ${QUICK_RUN_MAX_PROMPT_CHARS.toLocaleString('en-US')} characters).`)
    const images = sanitizeImages(i.images)
    if (!prompt && !images.length) throw new Error('Type what you want done.')
    const out: QuickRunInput = { prompt, team: i.team === 'default' ? 'default' : 'single', allowEdits: i.allowEdits === true }
    if (typeof i.folder === 'string' && i.folder.trim()) {
      if (i.folder.length > QUICK_FOLDER_MAX_CHARS) throw new Error('That folder path is too long.')
      out.folder = i.folder
    }
    if (images.length) out.images = images
    return out
  },
  promote(input: unknown): QuickRunPromoteInput {
    const i = obj<Record<string, unknown>>(input)
    if (!isSafeId(i.runId)) throw new Error('Quick run not found.')
    const name = typeof i.name === 'string' ? i.name.trim() : ''
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Give the project a name of 1 to 80 characters.')
    return { runId: i.runId, name }
  }
}

/** The Skill assistant / MCP assistant instruction: text only, trimmed, cut at ASSIST_INSTRUCTION_MAX_CHARS. */
function instructionArg(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, ASSIST_INSTRUCTION_MAX_CHARS) : undefined
}

/**
 * skills:startAssist input. Scope 'library' (explicit, or no projectId) runs on the virtual SKILLS_PROJECT_ID. Scope
 * 'project' needs a projectId that is a safe id, not virtual and a stored project (`isStored`). Exported for tests.
 */
export function skillAssistArgs(input: unknown, isStored: (projectId: string) => boolean): { library: true; instruction?: string } | { library: false; projectId: string; instruction?: string } {
  const i = obj<Record<string, unknown>>(input)
  const instruction = instructionArg(i.instruction)
  const base = instruction ? { instruction } : {}
  if (i.scope === 'library' || i.projectId === undefined || i.projectId === null || i.projectId === '') return { library: true, ...base }
  if (!isSafeId(i.projectId) || isVirtualProjectId(i.projectId) || !isStored(i.projectId)) throw new Error('Project not found')
  return { library: false, projectId: i.projectId, ...base }
}

/**
 * mcp:startAssist input. allowBuild is only ever the literal true, and only for library scope (the app-wide
 * assistant): a project-scope request with allowBuild is refused rather than silently ignored, because the user
 * would expect a build workspace. Exported for tests.
 */
export function mcpAssistArgs(input: unknown): { library: boolean; projectId: string; instruction?: string; allowBuild: boolean } {
  const i = obj<Record<string, unknown>>(input)
  const library = i.scope === 'library'
  const allowBuild = i.allowBuild === true
  if (allowBuild && !library) throw new Error('Building a server is available in the app-wide MCP assistant only.')
  const instruction = instructionArg(i.instruction)
  return { library, projectId: library ? HARNESS_PROJECT_ID : typeof i.projectId === 'string' ? i.projectId : '', allowBuild, ...(instruction ? { instruction } : {}) }
}

export function registerIpc({ projects, runs, setup, maintenance, settings, connections, mcp, adapterIds, harnessProject, openRunWindow, importer, skills, skillEvaluation, capabilities, quick }: IpcServices): void {
  const mock = adapterIds.includes('mock')
  /**
   * A stored project, or the display project of a virtual id (harness, quick = "Chat", skills). Never listed by
   * projects:list. The Chat's display project has no roles and creates no directory.
   */
  const projectOrHarness = (id: string): Project | null =>
    id === HARNESS_PROJECT_ID ? harnessProject()
    : id === QUICK_PROJECT_ID ? quick.displayProject()
    : id === SKILLS_PROJECT_ID ? skillsProject(connections.effectiveSettings(), settings.dataDir, { mock })
    : projects.get(id)
  ipcMain.handle(IPC.projectsList, () => projects.list())
  ipcMain.handle(IPC.projectsGet, (_e, id: string) => projectOrHarness(id))
  // Throws a readable message for a bad path (the form shows it) or a mock project without the mock adapter.
  ipcMain.handle(IPC.projectsCreate, (_e, input: ProjectCreateInput) =>
    projects.create(input, settings.get(), {
      mockAvailable: adapterIds.includes('mock'),
      prepare: (p) => connections.prepareNewProject(p),
      // After prepare: imported models map to the connection the project was put on.
      importRoles: (p, sources) => importer.rolesForNewProject(p, sources)
    })
  )
  // Never rejects: the agent scan and the existing-project lookup add fields only when they succeed.
  ipcMain.handle(IPC.projectsCheckPath, (_e, path: string): ProjectPathCheck => {
    const check = checkProjectPath(path)
    return { ...check, ...importer.pathCheckExtras(path, check) }
  })
  // Agent import: read-only scans of the stored project's folder; the renderer supplies choices, never roles.
  ipcMain.handle(IPC.projectsScanAgents, (_e, path: string): AgentImportScan => importer.scan(path))
  ipcMain.handle(IPC.projectsPreviewImport, (_e, input: AgentImportInput): AgentImportPreview => importer.preview(input))
  // The digest of the reviewed preview is required; apply refuses without it or when the folder changed since.
  ipcMain.handle(IPC.projectsApplyImport, (_e, input: AgentImportApplyInput): AgentImportApplyResult => importer.apply(input))
  ipcMain.handle(IPC.projectsExportOrg, (_e, projectId: string): OrgExportResult => importer.exportOrg(projectId))
  // The renderer's copy never changes mcpServers or plugins; those go through mcp:* and plugins:*.
  ipcMain.handle(IPC.projectsSave, (_e, project: Project) => {
    if (typeof project?.id === 'string' && isVirtualProjectId(project.id)) throw new Error('This assistant project cannot be saved.')
    return projects.saveFromRenderer(project)
  })
  ipcMain.handle(IPC.projectsRemove, async (_e, id: string) => {
    if (typeof id === 'string' && isVirtualProjectId(id)) throw new Error('This assistant project cannot be removed.')
    await runs.removeProject(id)
    mcp.removeProjectSecrets(id)
    skills.removeProjectFiles(id)
    capabilities.forgetProject(id)
    projects.remove(id)
  })
  ipcMain.handle(IPC.projectsPickDir, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    const picked = result.canceled ? null : result.filePaths[0] ?? null
    if (picked) rememberPickedFolder(e.sender, picked)
    return picked
  })

  ipcMain.handle(IPC.draftOrgChart, async (_e, req: DraftRequest) => {
    const project = projects.get(req.projectId)
    if (!project) throw new Error('Project not found')
    return draftOrgChart(runs.adapterFor(project), project, req, connections.importModelContext(projectConnection(project)))
  })

  ipcMain.handle(IPC.runsStart, async (_e, input: StartRunInput) => {
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return runs.start({ project, prompt: input.prompt, scaffold: input.scaffold, images: input.images })
  })
  ipcMain.handle(IPC.runsGet, (_e, runId: string) => runs.get(runId))
  // Chat: every field is rebuilt (quickArgs); the folder is validated in main (QuickRunService), never trusted here.
  ipcMain.handle(IPC.runsStartQuick, (_e, input: unknown): Promise<RunSummary> => quick.start(quickArgs.start(input)))
  ipcMain.handle(IPC.runsPromoteQuick, (_e, input: unknown): QuickRunPromoteResult => quick.promote(quickArgs.promote(input)))
  // Skill assistant: library scope on the virtual skills project, project scope on a stored project.
  ipcMain.handle(IPC.skillsStartAssist, async (_e, input: unknown): Promise<RunSummary> => {
    const target = skillAssistArgs(input, (id) => !!projects.get(id))
    const project = target.library ? skillsProject(connections.effectiveSettings(), settings.dataDir, { mock }) : projects.get(target.projectId)
    if (!project) throw new Error('Project not found')
    return runs.start({ project, kind: 'skill-assist', prompt: skillAssistPrompt(project, target.instruction) })
  })

  ipcMain.handle(IPC.setupStart, async (_e, input: SetupStartInput) => {
    const existing = projects.get(input.projectId)
    if (!existing) throw new Error('Project not found')
    const project = await setup.prepare(existing)
    return runs.start({
      project,
      kind: 'setup',
      prompt: setup.displayPrompt(project, input.instruction),
      hiddenContext: setup.hiddenContext(project),
      // Only the literal 'team' is accepted: the Team tab's tray hosts the session (RunSummary.surface).
      ...(input?.surface === 'team' ? { surface: 'team' as const } : {})
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
    (_e, input: unknown) => {
      const i = proposalDecideArgs(input)
      runs.decideProposal(i.runId, i.proposalId, i.decision)
    }
  )
  ipcMain.handle(IPC.runsContinue, async (_e, input: ContinueRunInput) => {
    const from = runs.summary(input.runId)
    if (!from) throw new Error('Run not found')
    // A quick run continues as the project rebuilt from its own summary (folder, team, edits), never a stored one.
    checkQuickContinue(from, input.text, settings.dataDir)
    const existing = from.quick ? quick.projectFor(from)
      : from.projectId === HARNESS_PROJECT_ID ? harnessProjectFor(from, connections.effectiveSettings(), settings.dataDir, mock)
      : projectOrHarness(from.projectId)
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
  ipcMain.handle(IPC.runsSend, (_e, input: SendRunInput) => {
    const from = runs.summary(input.runId)
    if (from) checkQuickContinue(from, input.text, settings.dataDir)
    return runs.send(input.runId, input.text, input.images)
  })
  ipcMain.handle(IPC.runsInterrupt, (_e, runId: string) => runs.interrupt(runId))
  ipcMain.handle(IPC.runsStop, (_e, runId: string) => runs.stop(runId))
  ipcMain.handle(IPC.runsList, (_e, projectId: string) => runs.list(projectId))
  ipcMain.handle(IPC.runsListLive, (): RunSummary[] => runs.liveRuns())
  ipcMain.handle(IPC.runsPendingCards, (_e, runId: unknown): PendingCards => {
    if (!isValidId(runId)) throw new Error('Invalid run id')
    return runs.pendingCards(runId)
  })
  ipcMain.handle(IPC.runsUsageStats, (_e, query: UsageStatsQuery): UsageStats => {
    const q = query && typeof query === 'object' ? query : ({} as UsageStatsQuery)
    if (!isValidId(q.projectId) || !projectOrHarness(q.projectId)) throw new Error('Project not found')
    return runs.usageStats(q)
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
    // Only the AuthStatusResult fields cross IPC.
    const s = await claudeAuthStatus()
    return { loggedIn: s.loggedIn, method: s.method, detail: s.detail, mode: 'subscription' }
  })

  // settings.set() notifies SettingsStore listeners: index.ts applies the theme and broadcasts settings:changed.
  const settingsInfo = (): AppSettingsInfo => buildSettingsInfo(settings.get(), { dataDir: settings.dataDir, appVersion: app.getVersion() })
  ipcMain.handle(IPC.settingsGet, () => settingsInfo())
  ipcMain.handle(IPC.settingsSet, (_e, next: unknown) => {
    settings.set(settingsSetArgs(next, settings.get()))
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
  ipcMain.handle(IPC.permissionsRemove, (_e, raw: unknown) => {
    const input = permissionRuleArgs(raw)
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return removeRule(project.path, input.rule)
  })
  ipcMain.handle(IPC.permissionsAdd, (_e, raw: unknown) => {
    const input = permissionRuleArgs(raw)
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    const rule = input.rule
    const refusal = permissionAddRefusal(rule)
    if (refusal) throw new Error(refusal)
    return addRules(project.path, [rule])
  })
  ipcMain.handle(
    IPC.permissionsDecideRequest,
    (_e, input: { runId: string; requestId: string; decision: PermissionRuleDecision }) =>
      runs.decideRules(input.runId, input.requestId, input.decision)
  )

  registerConnectionIpc(projects, connections)
  registerMcpIpc(runs, mcp, projectOrHarness, { quick, settings, effectiveSettings: () => connections.effectiveSettings(), mock })
  registerSkillIpc(skills, skillEvaluation)
  registerCapabilityIpc(capabilities)
}

/**
 * Folders the user chose in the main-process folder dialog (projects:pickDirectory), per renderer (`WebContents.id`),
 * newest last, at most PICKED_FOLDERS_PER_SENDER each. skillLibrary:addFromFolder accepts only a folder the same
 * renderer picked, and only once (`take` removes it), so a compromised renderer cannot copy an arbitrary folder (or a
 * UNC share) into the library and read it back, nor reuse a folder another window picked. Pure; exported for tests.
 */
export const PICKED_FOLDERS_PER_SENDER = 20
export class PickedFolders {
  private bySender = new Map<number, string[]>()
  remember(senderId: number, path: string): void {
    const list = (this.bySender.get(senderId) ?? []).filter((p) => p !== path)
    list.push(path)
    if (list.length > PICKED_FOLDERS_PER_SENDER) list.shift()
    this.bySender.set(senderId, list)
  }
  /** True (and forgotten) when `senderId` picked `path`; false otherwise. One-shot. */
  take(senderId: number, path: string): boolean {
    const list = this.bySender.get(senderId)
    const i = list ? list.indexOf(path) : -1
    if (!list || i === -1) return false
    list.splice(i, 1)
    if (list.length === 0) this.bySender.delete(senderId)
    return true
  }
  /** Drop everything a renderer picked (its WebContents was destroyed). */
  forget(senderId: number): void {
    this.bySender.delete(senderId)
  }
}
const pickedFolders = new PickedFolders()
const trackedSenders = new Set<number>()
function rememberPickedFolder(sender: WebContents, path: string): void {
  pickedFolders.remember(sender.id, path)
  if (trackedSenders.has(sender.id)) return
  trackedSenders.add(sender.id)
  const id = sender.id
  sender.once('destroyed', () => {
    pickedFolders.forget(id)
    trackedSenders.delete(id)
  })
}

/** A plain object argument, or {} (handlers validate the fields; services re-check ids against the stores). */
function obj<T>(input: unknown): T {
  return (input && typeof input === 'object' ? input : {}) as T
}

/** A project id that may name a stored project (the harness project has no skills). */
function projectIdArg(id: unknown): string {
  if (!isValidId(id) || isVirtualProjectId(id)) throw new Error('Project not found')
  return id
}

/** Project skills, the skill library, the repo import and evaluation: the services 1:1, ids checked first. */
function registerSkillIpc(skills: SkillServiceApi, evaluation: SkillEvaluationApi): void {
  type ProjectSkill = { projectId: string; skillId: string }
  const projectSkill = (input: unknown): ProjectSkill => {
    const i = obj<ProjectSkill>(input)
    projectIdArg(i.projectId)
    if (!isValidId(i.skillId)) throw new Error('Skill not found')
    return { projectId: i.projectId, skillId: i.skillId }
  }
  const withProject = <T extends { projectId: string }>(input: unknown): T => {
    const i = obj<T>(input)
    projectIdArg(i.projectId)
    return i
  }
  const libraryArg = (input: unknown): { libraryId: string } => {
    const i = obj<{ libraryId: string }>(input)
    if (!isValidId(i.libraryId)) throw new Error('Library skill not found')
    return { libraryId: i.libraryId }
  }
  ipcMain.handle(IPC.skillsList, (_e, projectId: unknown): SkillInfo[] => skills.list(projectIdArg(projectId)))
  ipcMain.handle(IPC.skillsRead, (_e, input: unknown): SkillContent => skills.read(projectSkill(input)))
  ipcMain.handle(IPC.skillsCreate, (_e, input: unknown): SkillMutationResult => skills.create(withProject<SkillCreateInput>(input)))
  ipcMain.handle(IPC.skillsUpdate, (_e, input: unknown): SkillMutationResult => {
    const i = withProject<SkillUpdateInput>(input)
    return skills.update({ ...i, ...projectSkill(i) })
  })
  ipcMain.handle(IPC.skillsRemove, (_e, input: unknown): SkillMutationResult => skills.remove(projectSkill(input)))
  ipcMain.handle(IPC.skillsLinkLibrary, (_e, input: unknown): SkillMutationResult => {
    const i = withProject<SkillLinkLibraryInput>(input)
    return skills.linkLibrary({ ...i, ...libraryArg(i) })
  })
  ipcMain.handle(IPC.skillsPromote, (_e, input: unknown): SkillMutationResult => skills.promote(projectSkill(input)))
  // Import: read-only scans of the stored project's folder; the renderer supplies choices and the preview digest.
  ipcMain.handle(IPC.skillsPreviewImport, (_e, input: unknown): SkillImportPreview => skills.previewImport(withProject<SkillImportInput>(input)))
  ipcMain.handle(IPC.skillsApplyImport, (_e, input: unknown): SkillImportApplyResult => skills.applyImport(withProject<SkillImportApplyInput>(input)))
  ipcMain.handle(IPC.skillsUndoImport, (_e, input: unknown): SkillMutationResult => {
    const i = withProject<{ projectId: string; undoId: string }>(input)
    if (!isValidId(i.undoId)) throw new Error('Nothing to undo')
    return skills.undoImport({ projectId: i.projectId, undoId: i.undoId })
  })
  ipcMain.handle(IPC.skillsEvaluate, (_e, projectId: unknown): Promise<SkillEvaluationReport> => evaluation.evaluate(projectIdArg(projectId)))
  ipcMain.handle(IPC.skillsLastEvaluation, (_e, projectId: unknown): SkillEvaluationReport | null => evaluation.last(projectIdArg(projectId)))
  ipcMain.handle(IPC.skillsApplySuggestion, (_e, input: unknown): SkillMutationResult => {
    const i = withProject<SkillApplySuggestionInput>(input)
    if (!isValidId(i.suggestionId)) throw new Error('Suggestion not found')
    return applySuggestion(skills, evaluation, i)
  })
  ipcMain.handle(IPC.skillLibraryList, (): SkillLibraryInfo[] => skills.libraryList())
  ipcMain.handle(IPC.skillLibraryRead, (_e, input: unknown): SkillContent => skills.libraryRead(libraryArg(input)))
  ipcMain.handle(IPC.skillLibraryCreate, (_e, draft: unknown): SkillLibraryInfo[] => skills.libraryCreate(obj<SkillDraft>(draft)))
  ipcMain.handle(IPC.skillLibraryAddFromFolder, (e, input: unknown): SkillLibraryInfo[] => {
    const i = obj<SkillLibraryFolderInput>(input)
    if (typeof i.path !== 'string' || !i.path) throw new Error('Choose a skill folder.')
    if (!pickedFolders.take(e.sender.id, i.path)) throw new Error('Choose the skill folder with the folder picker first.')
    return skills.libraryAddFromFolder({ path: i.path })
  })
  ipcMain.handle(IPC.skillLibraryUpdate, (_e, input: unknown): SkillLibraryInfo[] => {
    const i = obj<{ libraryId: string; draft: SkillDraft }>(input)
    return skills.libraryUpdate({ ...libraryArg(i), draft: obj<SkillDraft>(i.draft) })
  })
  ipcMain.handle(IPC.skillLibraryRemove, (_e, input: unknown): SkillLibraryInfo[] => skills.libraryRemove(libraryArg(input)))
}

/** Role ids per apply; more is refused. */
const CAPABILITY_MAX_ROLE_IDS = 100

/**
 * Renderer input for capabilities:* rebuilt field by field: only known fields with the right shape reach the service,
 * so a renderer can never smuggle a path, a spec or file content into apply. Exported for tests.
 */
export const capabilityArgs = {
  discover(input: unknown): CapabilityDiscoverInput {
    const i = obj<Record<string, unknown>>(input)
    const out: CapabilityDiscoverInput = { projectId: projectIdArg(i.projectId), includeOutside: i.includeOutside === true }
    if (typeof i.query === 'string' && i.query.trim()) out.query = i.query.trim().slice(0, 100)
    if (i.requestId !== undefined) {
      if (!isValidId(i.requestId)) throw new Error('Invalid request id')
      out.requestId = i.requestId
    }
    return out
  },
  recommend(input: unknown): CapabilityRecommendInput {
    const i = obj<Record<string, unknown>>(input)
    const out: CapabilityRecommendInput = { ...capabilityArgs.discover(input), scope: {} }
    const scope = obj<Record<string, unknown>>(i.scope)
    if (scope.roleId !== undefined) {
      if (!isValidId(scope.roleId)) throw new Error('Role not found')
      out.scope = { roleId: scope.roleId }
    }
    return out
  },
  apply(input: unknown): CapabilityApplyInput {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.digest !== 'string' || !/^[a-f0-9]{64}$/.test(i.digest)) throw new Error('Run the recommendations again first: the result is missing or out of date.')
    if (!Array.isArray(i.roleIds) || i.roleIds.length === 0) throw new Error('Choose at least one role.')
    if (i.roleIds.length > CAPABILITY_MAX_ROLE_IDS || !i.roleIds.every((r) => isValidId(r))) throw new Error('Unknown role in the choice.')
    if (i.access !== undefined && i.access !== 'read' && i.access !== 'full') throw new Error('Access must be read or full.')
    const out: CapabilityApplyInput = {
      projectId: projectIdArg(i.projectId),
      digest: i.digest,
      roleIds: [...new Set(i.roleIds as string[])]
    }
    // Omitted access means the recommendation's own access (else 'read'); the service still enforces the write-tools rule.
    if (i.access === 'read' || i.access === 'full') out.access = i.access
    if (i.recommendationId !== undefined) {
      if (!isValidId(i.recommendationId)) throw new Error('Recommendation not found')
      out.recommendationId = i.recommendationId
    }
    if (i.candidateId !== undefined) {
      if (!isValidId(i.candidateId)) throw new Error('Candidate not found')
      out.candidateId = i.candidateId
    }
    if (!out.recommendationId && !out.candidateId) throw new Error('Name a recommendation or a candidate.')
    return out
  },
  undo(input: unknown): CapabilityUndoInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = projectIdArg(i.projectId)
    if (!isValidId(i.undoId)) throw new Error('Nothing to undo')
    return { projectId, undoId: i.undoId }
  },
  review(input: unknown): TeamReviewInput {
    const i = obj<Record<string, unknown>>(input)
    const trigger = i.trigger === 'opened' ? 'opened' : 'manual'
    const out: TeamReviewInput = { projectId: projectIdArg(i.projectId), trigger }
    if (i.requestId !== undefined) {
      if (!isValidId(i.requestId)) throw new Error('Invalid request id')
      out.requestId = i.requestId
    }
    // Outside fetches and the model step are the user's explicit call: never on the throttled 'opened' trigger.
    if (trigger === 'manual') {
      out.includeOutside = i.includeOutside === true
      out.useModel = i.useModel === true
    }
    return out
  },
  dismiss(input: unknown): TeamDismissInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = projectIdArg(i.projectId)
    const out: TeamDismissInput = { projectId }
    if (i.recommendationId !== undefined) {
      if (!isValidId(i.recommendationId)) throw new Error('Recommendation not found')
      out.recommendationId = i.recommendationId
    }
    if (i.candidateId !== undefined) {
      if (!isValidId(i.candidateId)) throw new Error('Candidate not found')
      out.candidateId = i.candidateId
    }
    if (!out.recommendationId && !out.candidateId) throw new Error('Recommendation not found')
    return out
  },
  restore(input: unknown): TeamRestoreInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = projectIdArg(i.projectId)
    if (!isValidId(i.candidateId)) throw new Error('Candidate not found')
    return { projectId, candidateId: i.candidateId }
  }
}

/** The Team assistant: CapabilityServiceApi 1:1, inputs rebuilt by capabilityArgs, the harness project refused. */
function registerCapabilityIpc(capabilities: CapabilityServiceApi): void {
  ipcMain.handle(IPC.capabilitiesDiscover, (_e, input: unknown): Promise<CapabilityDiscovery> => capabilities.discover(capabilityArgs.discover(input)))
  ipcMain.handle(IPC.capabilitiesRecommend, (_e, input: unknown): Promise<TeamRecommendations> => capabilities.recommend(capabilityArgs.recommend(input)))
  ipcMain.handle(IPC.capabilitiesCancel, (_e, input: unknown): void => {
    const i = obj<{ requestId?: unknown }>(input)
    if (isValidId(i.requestId)) capabilities.cancel(i.requestId)
  })
  ipcMain.handle(IPC.capabilitiesApply, (_e, input: unknown): Promise<CapabilityApplyResult> => capabilities.apply(capabilityArgs.apply(input)))
  ipcMain.handle(IPC.capabilitiesUndo, (_e, input: unknown): CapabilityUndoResult => capabilities.undo(capabilityArgs.undo(input)))
  ipcMain.handle(IPC.capabilitiesReview, (_e, input: unknown): Promise<TeamReview> => capabilities.review(capabilityArgs.review(input)))
  ipcMain.handle(IPC.capabilitiesLastReview, (_e, projectId: unknown): TeamReview | null => capabilities.lastReview(projectIdArg(projectId)))
  ipcMain.handle(IPC.capabilitiesDismiss, (_e, input: unknown): TeamReview => capabilities.dismiss(capabilityArgs.dismiss(input)))
  ipcMain.handle(IPC.capabilitiesRestore, (_e, input: unknown): TeamReview => capabilities.restore(capabilityArgs.restore(input)))
}

/** Connections, model catalog and remaps: ConnectionService 1:1. */
function registerConnectionIpc(projects: ProjectStore, connections: ConnectionService): void {
  ipcMain.handle(IPC.connectionsSetDefault, (_e, raw: unknown): Promise<ConnectionInfo[]> => {
    if (raw !== null && !(typeof raw === 'string' && (CONNECTION_IDS as readonly string[]).includes(raw))) throw new Error('Unknown connection')
    return connections.setDefault(raw as ConnectionId | null)
  })
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
  ipcMain.handle(IPC.modelsPrices, (_e, query?: ModelPricesQuery): ModelPriceInfo[] => {
    const connection = query && typeof query === 'object' ? query.connection : undefined
    if (connection !== undefined && !CONNECTION_IDS.includes(connection)) throw new Error('Unknown connection')
    return connections.prices(connection ? { connection } : undefined)
  })
  ipcMain.handle(IPC.projectsRemapModels, (_e, input: RemapModelsInput): RemapModelsOutput => {
    if (!projects.get(input.projectId)) throw new Error('Project not found')
    return connections.remapModels(input)
  })
  ipcMain.handle(IPC.projectsPreviewRemap, (_e, input: RemapModelsInput): RemapResult => connections.previewRemap(input))
}

/** MCP servers, plugins, registry search and install approvals: McpService 1:1, installs and the assistant via RunManager. */
function registerMcpIpc(
  runs: RunManager,
  mcp: McpService,
  projectOrHarness: (id: string) => Project | null,
  assist: { quick: QuickRunService; settings: SettingsStore; effectiveSettings: () => AppSettings; mock: boolean }
): void {
  ipcMain.handle(IPC.mcpList, (_e, projectId: string): McpServerInfo[] => mcp.list(projectId))
  ipcMain.handle(IPC.mcpUpsert, (_e, input: McpUpsertInput): McpMutationResult => mcp.upsert(input))
  ipcMain.handle(IPC.mcpRemove, (_e, input: { projectId: string; serverId: string }): McpMutationResult => mcp.remove(input))
  ipcMain.handle(IPC.mcpSetSecret, (_e, input: McpSecretInput): McpMutationResult => mcp.setSecret(input))
  ipcMain.handle(IPC.mcpTest, (_e, input: { projectId: string; serverId: string }): Promise<McpTestResult> => mcp.test(input))
  ipcMain.handle(IPC.mcpRegistrySearch, (_e, input: McpRegistrySearchInput): Promise<McpRegistrySearchResult> => mcp.registrySearch(input))
  ipcMain.handle(IPC.mcpAnswerInstall, (_e, input: McpAnswerInstallInput): void => runs.answerMcpInstall(input.runId, input.requestId, input.decision))
  // scope 'library' runs the assistant on the virtual harness project; RunManager and the harness tools treat a run
  // whose projectId is HARNESS_PROJECT_ID as library scope.
  // allowBuild (library scope only, literal true): the session works in its own scratch dir under <data>/quick, with
  // permission mode 'default' (harnessProject), and the run records it as buildWorkspace.
  ipcMain.handle(IPC.mcpStartAssist, async (_e, input: McpAssistInput): Promise<RunSummary> => {
    const { library, projectId, instruction, allowBuild } = mcpAssistArgs(input)
    if (!library && isVirtualProjectId(projectId)) throw new Error('Project not found')
    if (allowBuild) {
      const workspace = createScratchDir(assist.settings.dataDir)
      try {
        const project = buildHarnessProject(assist.effectiveSettings(), assist.settings.dataDir, { mock: assist.mock, allowBuild: true, workspace })
        return await runs.start({ project, kind: 'mcp-assist', prompt: assistPrompt(project, instruction), buildWorkspace: workspace })
      } catch (e) {
        assist.quick.removeScratch(workspace)
        throw e
      }
    }
    const project = projectOrHarness(projectId)
    if (!project) throw new Error('Project not found')
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
  // Connectors: the renderer names a preset (and a variant); main builds the entry from src/shared/connectors.ts.
  ipcMain.handle(IPC.connectorsList, (): ConnectorInfo[] => mcp.connectorsList())
  ipcMain.handle(IPC.connectorsAdd, (_e, input: unknown): McpLibraryInfo => mcp.connectorsAdd(connectorArgs.add(input)))
  ipcMain.handle(IPC.connectorsSetToken, (_e, input: unknown): McpLibraryInfo => mcp.connectorsSetToken(connectorArgs.setToken(input)))
  ipcMain.handle(IPC.pluginsUpsert, (_e, input: PluginUpsertInput): Project => mcp.upsertPlugin(input))
  ipcMain.handle(IPC.pluginsRemove, (_e, input: { projectId: string; pluginId: string }): Project => mcp.removePlugin(input))
}

/**
 * settings:set input: a plain object (anything else is refused), merged onto the stored settings (never onto the
 * defaults, so a field the renderer left out keeps its stored value). The main-owned fields always keep their stored
 * values: defaultConnection, defaultConnectionChosen and defaultConnectionReplaced (change the default only through
 * connections:setDefault), connections and its providerAuth mirror (connections:update / setSecret). The
 * AppSettingsInfo extras are dropped. Pure; exported for tests. SettingsStore.set normalizes the rest.
 */
export function settingsSetArgs(raw: unknown, stored: AppSettings): AppSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings must be an object.')
  const proto = Object.getPrototypeOf(raw)
  if (proto !== Object.prototype && proto !== null) throw new Error('Settings must be an object.')
  const incoming = stripSettingsInfo(raw as AppSettings)
  const {
    defaultConnection: _dc,
    defaultConnectionChosen: _chosen,
    defaultConnectionReplaced: _replaced,
    connections: _connections,
    providerAuth: _auth,
    ...rest
  } = incoming
  const out: AppSettings = { ...stored, ...rest }
  out.defaultConnection = stored.defaultConnection
  out.connections = stored.connections
  out.providerAuth = stored.providerAuth
  delete out.defaultConnectionChosen
  delete out.defaultConnectionReplaced
  if (stored.defaultConnectionChosen !== undefined) out.defaultConnectionChosen = stored.defaultConnectionChosen
  if (stored.defaultConnectionReplaced !== undefined) out.defaultConnectionReplaced = stored.defaultConnectionReplaced
  return out
}

/** Longest pasted connector token accepted over IPC; McpService re-checks the header value it builds. */
export const CONNECTOR_TOKEN_MAX_CHARS = 4000
/** Catalog ids and variant ids are lowercase kebab-case, at most 64 chars. */
const CONNECTOR_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

function connectorObject(input: unknown): Record<string, unknown> & { connectorId: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unknown connector.')
  const i = input as Record<string, unknown>
  if (typeof i.connectorId !== 'string' || !CONNECTOR_ID_RE.test(i.connectorId)) throw new Error('Unknown connector.')
  return i as Record<string, unknown> & { connectorId: string }
}

/**
 * Renderer input for connectors:add / connectors:setToken rebuilt field by field: a catalog-shaped connector id (and
 * variant id), or a bounded token string / null; any other field is dropped and a wrong shape is refused. McpService
 * still resolves the ids against the catalog. Exported for tests.
 */
export const connectorArgs = {
  add(input: unknown): ConnectorAddInput {
    const i = connectorObject(input)
    const out: ConnectorAddInput = { connectorId: i.connectorId }
    if (i.variant !== undefined) {
      if (typeof i.variant !== 'string' || !CONNECTOR_ID_RE.test(i.variant)) throw new Error('Unknown connector variant.')
      out.variant = i.variant
    }
    return out
  },
  setToken(input: unknown): ConnectorTokenInput {
    const i = connectorObject(input)
    if (i.token === null) return { connectorId: i.connectorId, token: null }
    if (typeof i.token !== 'string') throw new Error('The token must be text.')
    if (i.token.length > CONNECTOR_TOKEN_MAX_CHARS) throw new Error(`The token is too long (at most ${CONNECTOR_TOKEN_MAX_CHARS} characters).`)
    return { connectorId: i.connectorId, token: i.token }
  }
}

/** Longest permission rule accepted over IPC (permissions:add / permissions:remove). */
export const PERMISSION_RULE_MAX_CHARS = 1000

/**
 * Renderer input for permissions:add / permissions:remove rebuilt as `{ projectId, rule }`: both strings, the project
 * id at most 200 chars, the rule trimmed, non-empty and at most PERMISSION_RULE_MAX_CHARS; anything else is refused
 * (review re-check L8). Exported for tests.
 */
export function permissionRuleArgs(input: unknown): { projectId: string; rule: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Project not found')
  const i = input as Record<string, unknown>
  if (typeof i.projectId !== 'string' || !i.projectId || i.projectId.length > 200) throw new Error('Project not found')
  if (typeof i.rule !== 'string') throw new Error('The rule must be text.')
  const rule = i.rule.trim()
  if (!rule) throw new Error('The rule is empty.')
  if (rule.length > PERMISSION_RULE_MAX_CHARS) throw new Error(`The rule is too long (at most ${PERMISSION_RULE_MAX_CHARS} characters).`)
  return { projectId: i.projectId, rule }
}

/**
 * Why permissions:add refuses a rule, or null (reviewer-3 L4): bad grammar, a blanket or ambiguous path rule
 * (ruleSaveRefusal), a destructive or wildcard shell rule (isUnsafeAllowRule) or a shell prefix that grants far more
 * than one command (isTooBroadPrefix: `curl:*`, `docker compose:*`, `npx tsx:*`). Exact shell rules stay allowed
 * unless destructive. Exported for tests.
 */
export function permissionAddRefusal(rule: string): string | null {
  if (!isValidRule(rule)) return 'A rule looks like Tool(prefix:*), Tool(exact command) or a bare tool name, e.g. Bash(npm test:*)'
  const refusal = ruleSaveRefusal(rule)
  if (refusal) return refusal
  return allowRuleRefusal(rule)
}

/** Most secret values one proposal decision may carry, and the longest key / value. */
export const PROPOSAL_SECRETS_MAX = 100
const PROPOSAL_SECRET_KEY_MAX = 300
const PROPOSAL_SECRET_VALUE_MAX = 4000

/**
 * setup:decide input rebuilt field by field: runId and proposalId strings, and a decision of exactly one known
 * behavior. approve: optional `secrets`, a plain object of at most PROPOSAL_SECRETS_MAX non-empty string values
 * (keys at most 300 chars, values at most 4,000); revise: `feedback` text; decline: optional `note` text (both at
 * most PROPOSAL_NOTE_MAX_CHARS). Every other field is dropped and a wrong shape is refused. Exported for tests.
 */
export function proposalDecideArgs(input: unknown): { runId: string; proposalId: string; decision: ProposalDecision } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unknown proposal decision.')
  const i = input as Record<string, unknown>
  if (typeof i.runId !== 'string' || !i.runId || i.runId.length > 200) throw new Error('Unknown run.')
  if (typeof i.proposalId !== 'string' || !i.proposalId || i.proposalId.length > 200) throw new Error('Unknown proposal.')
  const d = i.decision
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Unknown proposal decision.')
  const dec = d as Record<string, unknown>
  const text = (v: unknown, what: string): string => {
    if (typeof v !== 'string') throw new Error(`The ${what} must be text.`)
    if (v.length > PROPOSAL_NOTE_MAX_CHARS) throw new Error(`The ${what} is too long (at most ${PROPOSAL_NOTE_MAX_CHARS} characters).`)
    return v
  }
  const head = { runId: i.runId, proposalId: i.proposalId }
  if (dec.behavior === 'approve') {
    if (dec.secrets === undefined) return { ...head, decision: { behavior: 'approve' } }
    if (!dec.secrets || typeof dec.secrets !== 'object' || Array.isArray(dec.secrets)) throw new Error('Secrets must be name-value pairs.')
    const entries = Object.entries(dec.secrets as Record<string, unknown>)
    if (entries.length > PROPOSAL_SECRETS_MAX) throw new Error(`At most ${PROPOSAL_SECRETS_MAX} secret values.`)
    const secrets: Record<string, string> = Object.create(null) as Record<string, string>
    for (const [k, v] of entries) {
      if (!k || k.length > PROPOSAL_SECRET_KEY_MAX) throw new Error('Unknown secret slot.')
      if (typeof v !== 'string') throw new Error('A secret value must be text.')
      if (v.length > PROPOSAL_SECRET_VALUE_MAX) throw new Error(`A secret value is too long (at most ${PROPOSAL_SECRET_VALUE_MAX} characters).`)
      if (v) secrets[k] = v
    }
    return { ...head, decision: Object.keys(secrets).length ? { behavior: 'approve', secrets } : { behavior: 'approve' } }
  }
  if (dec.behavior === 'revise') return { ...head, decision: { behavior: 'revise', feedback: text(dec.feedback, 'feedback') } }
  if (dec.behavior === 'decline') {
    if (dec.note === undefined) return { ...head, decision: { behavior: 'decline' } }
    const note = text(dec.note, 'note').trim()
    return { ...head, decision: note ? { behavior: 'decline', note } : { behavior: 'decline' } }
  }
  throw new Error('Unknown proposal decision.')
}
