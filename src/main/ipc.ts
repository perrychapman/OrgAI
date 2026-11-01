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
  CapabilityGrantInput,
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
  TeamRecommendations,
  TeamReview,
  TeamReviewInput
} from '@shared/types'
import { CONNECTION_IDS, HARNESS_PROJECT_ID, IPC } from '@shared/types'
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
  /** Agent import and org export (src/main/setup/import/importer.ts). */
  importer: AgentImportService
  /** Project skills, the skill library and the repo skill import (src/main/skills/service.ts). */
  skills: SkillServiceApi
  /** Skill evaluation (src/main/skills/evaluation.ts). */
  skillEvaluation: SkillEvaluationApi
  /** The Team assistant: discovery, recommendations, apply and grants (src/main/capabilities/service.ts). */
  capabilities: CapabilityServiceApi
}

export function registerIpc({ projects, runs, setup, maintenance, settings, connections, mcp, adapterIds, harnessProject, openRunWindow, importer, skills, skillEvaluation, capabilities }: IpcServices): void {
  /** A stored project, or the virtual harness project that owns harness-level runs. Never listed by projects:list. */
  const projectOrHarness = (id: string): Project | null => (id === HARNESS_PROJECT_ID ? harnessProject() : projects.get(id))
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
    if (project?.id === HARNESS_PROJECT_ID) throw new Error('The harness project cannot be saved.')
    return projects.saveFromRenderer(project)
  })
  ipcMain.handle(IPC.projectsRemove, async (_e, id: string) => {
    if (id === HARNESS_PROJECT_ID) throw new Error('The harness project cannot be removed.')
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
  if (!isValidId(id) || id === HARNESS_PROJECT_ID) throw new Error('Project not found')
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
  setGrant(input: unknown): CapabilityGrantInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = projectIdArg(i.projectId)
    if (!isValidId(i.roleId)) throw new Error('Role not found')
    if (i.kind !== 'skill' && i.kind !== 'mcp') throw new Error('Unknown kind')
    if (!isValidId(i.id)) throw new Error(i.kind === 'skill' ? 'Skill not found' : 'Server not found')
    if (typeof i.granted !== 'boolean') throw new Error('granted must be true or false')
    return { projectId, roleId: i.roleId, kind: i.kind, id: i.id, granted: i.granted }
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
    if (!isValidId(i.recommendationId)) throw new Error('Recommendation not found')
    return { projectId, recommendationId: i.recommendationId }
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
  ipcMain.handle(IPC.capabilitiesSetGrant, (_e, input: unknown): Project => capabilities.setGrant(capabilityArgs.setGrant(input)))
  ipcMain.handle(IPC.capabilitiesReview, (_e, input: unknown): Promise<TeamReview> => capabilities.review(capabilityArgs.review(input)))
  ipcMain.handle(IPC.capabilitiesLastReview, (_e, projectId: unknown): TeamReview | null => capabilities.lastReview(projectIdArg(projectId)))
  ipcMain.handle(IPC.capabilitiesDismiss, (_e, input: unknown): TeamReview => capabilities.dismiss(capabilityArgs.dismiss(input)))
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
  // Connectors: the renderer names a preset (and a variant); main builds the entry from src/shared/connectors.ts.
  ipcMain.handle(IPC.connectorsList, (): ConnectorInfo[] => mcp.connectorsList())
  ipcMain.handle(IPC.connectorsAdd, (_e, input: unknown): McpLibraryInfo => mcp.connectorsAdd(connectorArgs.add(input)))
  ipcMain.handle(IPC.connectorsSetToken, (_e, input: unknown): McpLibraryInfo => mcp.connectorsSetToken(connectorArgs.setToken(input)))
  ipcMain.handle(IPC.pluginsUpsert, (_e, input: PluginUpsertInput): Project => mcp.upsertPlugin(input))
  ipcMain.handle(IPC.pluginsRemove, (_e, input: { projectId: string; pluginId: string }): Project => mcp.removePlugin(input))
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
