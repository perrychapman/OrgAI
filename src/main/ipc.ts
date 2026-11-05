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
import type { ConnectorPresetRemoveInput, McpCopyFromLibraryInput, McpProjectOverridesInput } from '@shared/types'
import { KIT_IPC, MCP_SCOPE_IPC, REPO_DESTINATION_MAX_CHARS, REPO_SOURCE_MAX_CHARS } from '@shared/types'
import type { RepoCloneInput, RepoCloneProgress, RepoCloneResult, RepoSourceParse, RepoTools } from '@shared/types'
import { REPO_REQUEST_ID_RE, parseRepoSource, scrubStderr, type RepoCloneService } from './repoClone'
import type { KitApplyResult, KitExportResult, KitImportPreview } from '@shared/types'
import { applyArgs as kitApplyArgs, exportArgs as kitExportArgs, type KitService } from './kit/service'
import { PickedPaths, kitExportTarget } from './kit/pickedPaths'
import { CONNECTION_IDS, HARNESS_PROJECT_ID, IPC, KNOWLEDGE_LINK_ID_RE, QUICK_PROJECT_ID, PROPOSAL_NOTE_MAX_CHARS, QUICK_RUN_MAX_PROMPT_CHARS, SKILLS_PROJECT_ID, isVirtualProjectId } from '@shared/types'
import { isConnectionId, isSafeId } from '@shared/defaults'
import { sanitizeImages } from './runtime/attachments'
import { skillAssistPrompt, skillsProject } from './skills/assist'
import { harnessProject as buildHarnessProject } from './mcp/assist'
import { createScratchDir, isInsideEither, samePath, scratchDirFor, validateQuickFolder } from './quick/scratch'
import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { hiddenCharIn, hiddenCharProblem } from './capabilities/sanitize'
import type { QuickRunService } from './quick/quickRuns'
import type { ProjectStore } from './store/projects'
import type { RunManager } from './runtime/runManager'
import type { SetupService } from './setup/service'
import type { MaintenanceService } from './maintenance'
import type { SettingsStore } from './store/settings'
import type { ConnectionService } from './connections/service'
import type { McpService } from './mcp/service'
import type { AgentImportService } from './setup/import/importer'
import { cleanMenuState, setMenuState } from './appMenu'
import { applySuggestion, type SkillEvaluationApi, type SkillServiceApi } from './skills/types'
import type { CapabilityServiceApi } from './capabilities/types'
import { claudeAuthStatus } from './connections/anthropicAuth'
import { assistPrompt } from './mcp/assist'
import { draftOrgChart } from './ai/draft'
import { projectConnection } from '@shared/defaults'
import { log, logPath, logsDir } from './log'
import {
  appRulesExist,
  engagementDocumentExists,
  listNotes,
  projectRulesFile,
  readEngagementDocumentInfo,
  readNote,
  removeNote,
  removeProjectData,
  removeSkillEvaluation,
  retainRunProject,
  saveNote,
  skillEvaluationFile,
  teamReviewFile,
  updateEngagementDocument
} from './store/projectData'
import { clearKnowledge, dismissKnowledgeLink, knowledgeNodeCount, readKnowledge, readKnowledgeInferred, removeEdge, removeNode, saveEdge, saveNodeForUser, userSource } from './store/knowledge'
import { emptyKnowledgeGraph } from '@shared/knowledge'
import type { TemplateService } from './setup/templates'
import type {
  EngagementChangedEvent,
  EngagementDocumentInfo,
  EngagementDocumentUpdate,
  EngagementNote,
  EngagementNoteContent,
  EngagementNoteRef,
  EngagementNoteSaveInput,
  KnowledgeEdge,
  KnowledgeDismissLinkInput,
  KnowledgeEdgeSaveInput,
  KnowledgeFactInput,
  KnowledgeGraph,
  KnowledgeInferredResult,
  KnowledgeItemRef,
  KnowledgeNode,
  KnowledgeNodeSaveInput,
  OrgTemplateApplyInput,
  OrgTemplateInfo,
  OrgTemplateSaveInput,
  ProjectRemoveInput,
  ProjectRemoveResult
} from '@shared/types'
import { projectKindOf } from '@shared/defaults'
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
  /** Saved team templates (src/main/setup/templates.ts). */
  templates: TemplateService
  /** The practice kit (src/main/kit/service.ts). Absent = the kit channels are not registered (older tests). */
  kit?: KitService
  /** Start a project from a repository: parse, tools, clone or fork, cancel (src/main/repoClone.ts). Absent = the channels are not registered. */
  repoClone?: RepoCloneService
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

export function registerIpc({ projects, runs, setup, maintenance, settings, connections, mcp, adapterIds, harnessProject, openRunWindow, importer, skills, skillEvaluation, capabilities, quick, templates, kit, repoClone }: IpcServices): void {
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
      importRoles: (p, sources) => importer.rolesForNewProject(p, sources),
      // Only when importAgents produced no roles; after prepare so the template's models map to the project's connection.
      fromTemplate: (p, templateId) => templates.rolesForNewProject(p, templateId)
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
  // A string id or ProjectRemoveInput. Facts are gathered before anything is deleted (removalFacts).
  ipcMain.handle(IPC.projectsRemove, async (_e, input: unknown): Promise<ProjectRemoveResult> => {
    const { projectId: id, removeRuns: asked } = projectRemoveArgs(input)
    const stored = projects.get(id)
    if (!stored) throw new Error('Project not found')
    const removeRuns = effectiveRemoveRuns(projectKindOf(stored), asked)
    if (!removeRuns) retainRunProject(settings.dataDir, id)
    const facts = removalFacts({ dataDir: settings.dataDir, project: stored, runCount: (pid) => runs.list(pid).length }, id, removeRuns)
    const removed = await runs.removeProject(id, { removeRuns })
    mcp.removeProjectSecrets(id)
    skills.removeProjectFiles(id)
    capabilities.forgetProject(id)
    projects.remove(id)
    removeProjectData(settings.dataDir, id)
    removeSkillEvaluation(settings.dataDir, id)
    return { ...facts, runsRemoved: typeof removed === 'number' ? removed : facts.runsRemoved }
  })
  ipcMain.handle(IPC.projectsRemovePreview, (_e, input: unknown): ProjectRemoveResult => {
    const { projectId: id, removeRuns: asked } = projectRemoveArgs(input)
    const project = projects.get(id)
    if (!project) throw new Error('Project not found')
    return removalFacts({ dataDir: settings.dataDir, project, runCount: (pid) => runs.list(pid).length }, id, effectiveRemoveRuns(projectKindOf(project), asked))
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
    return runs.start({ project, prompt: input.prompt, scaffold: input.scaffold, images: input.images, ...(input.team === 'single' ? { team: 'single' as const } : {}) })
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
  ipcMain.handle(IPC.runsUsageCsv, (_e, query: UsageStatsQuery): string => {
    const q = query && typeof query === 'object' ? query : ({} as UsageStatsQuery)
    const project = isValidId(q.projectId) ? projectOrHarness(q.projectId) : null
    if (!project) throw new Error('Project not found')
    return runs.usageCsv(q, { project: project.name, client: project.client ?? '' })
  })
  registerTemplateEngagementIpc({ projects, templates, dataDir: settings.dataDir })
  registerKnowledgeIpc({ projects, dataDir: settings.dataDir })
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
  // defaultConnection is the effective default (connections.effectiveDefault()); the stored value stays main-only.
  const settingsInfo = (): AppSettingsInfo =>
    buildSettingsInfo(withEffectiveDefault(settings.get(), connections.effectiveDefault()), { dataDir: settings.dataDir, appVersion: app.getVersion() })
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
  // Returns shell.openPath's contract: an error message, or '' on success. Never throws to the renderer.
  ipcMain.handle(IPC.appOpenPath, async (_e, path: unknown): Promise<string> => {
    try {
      const list = projects.list()
      const refusal = openPathRefusal(path, {
        dataDir: settings.dataDir,
        projectPaths: list.map((p) => p.path),
        allowedDirectories: list.flatMap((p) => p.allowedDirectories ?? []),
        stat: lstatDirectory
      })
      if (refusal) {
        log.warn('app:openPath refused:', refusal)
        return refusal
      }
      return await shell.openPath(path as string)
    } catch (err) {
      log.warn('app:openPath failed:', err instanceof Error ? err.message : String(err))
      return 'OrgAI could not open that folder.'
    }
  })
  ipcMain.handle(IPC.appLogPath, () => logPath())
  ipcMain.handle(IPC.appInfo, (): AppInfo => buildAppInfo(app, { platform: process.platform, logsDir: logsDir(), adapterIds }))
  ipcMain.handle(IPC.appOpenLogs, async () => {
    logPath() // creates the folder if nothing has been logged yet
    const error = await shell.openPath(logsDir())
    if (error) log.warn(`Could not open logs folder: ${error}`)
  })
  // What the renderer shows, for enabling application menu items. Booleans only; nothing is echoed back.
  ipcMain.handle(IPC.menuSetState, (e, input: unknown): void => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && !win.isDestroyed()) setMenuState(win, cleanMenuState(input))
  })
  ipcMain.handle(IPC.permissionsList, (_e, projectId: string) => {
    const project = projects.get(projectId)
    if (!project) throw new Error('Project not found')
    return listRules({ file: projectRulesFile(project, settings.dataDir) })
  })
  ipcMain.handle(IPC.permissionsRemove, (_e, raw: unknown) => {
    const input = permissionRuleArgs(raw)
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return removeRule({ file: projectRulesFile(project, settings.dataDir) }, input.rule)
  })
  ipcMain.handle(IPC.permissionsAdd, (_e, raw: unknown) => {
    const input = permissionRuleArgs(raw)
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    const rule = input.rule
    const refusal = permissionAddRefusal(rule)
    if (refusal) throw new Error(refusal)
    return addRules({ file: projectRulesFile(project, settings.dataDir) }, [rule])
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
  if (kit) registerKitIpc(kit)
  if (repoClone) registerRepoIpc(repoClone)
}

// ---- Start a project from a repository (clone or fork) ----

/**
 * projects:cloneRepo input rebuilt field by field: a plain object, requestId 1..64 of letters, digits, '_' and '-',
 * source and destination text within their limits (refused, never cut), mode exactly 'clone' or 'fork'; extra fields
 * are dropped. The refusals are one fixed line and never quote the input. Exported for tests.
 */
export function repoCloneArgs(input: unknown): RepoCloneInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid clone request.')
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) throw new Error('Invalid clone request.')
  const i = input as Record<string, unknown>
  if (typeof i.requestId !== 'string' || !REPO_REQUEST_ID_RE.test(i.requestId)) throw new Error('Invalid clone request.')
  if (typeof i.source !== 'string') throw new Error('Type or paste a repository address.')
  if (i.source.length > REPO_SOURCE_MAX_CHARS * 2) throw new Error('That address is too long.')
  if (i.mode !== 'clone' && i.mode !== 'fork') throw new Error('Choose clone or fork.')
  if (typeof i.destination !== 'string' || !i.destination.trim()) throw new Error('Choose a folder for the new project.')
  if (i.destination.length > REPO_DESTINATION_MAX_CHARS * 2) throw new Error('That folder path is too long.')
  return { requestId: i.requestId, source: i.source, mode: i.mode, destination: i.destination }
}

/** projects:cancelClone argument: a valid request id, else refused. Exported for tests. */
export function repoCancelArg(input: unknown): string {
  if (typeof input !== 'string' || !REPO_REQUEST_ID_RE.test(input)) throw new Error('Invalid clone request.')
  return input
}

/** The slice of WebContents that watchSenderGone uses. */
export interface GoneWatchable {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * Calls `onGone` (once) when the window is destroyed, its renderer process is gone, or its main frame starts a new
 * navigation to another document. Returns a function that removes every listener; call it when the work ends.
 */
export function watchSenderGone(sender: GoneWatchable, onGone: () => void): () => void {
  const fire = (): void => onGone()
  const onNavigate = (...args: unknown[]): void => {
    const d = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined
    if (d && d.isMainFrame === true && d.isSameDocument !== true) onGone()
  }
  sender.on('destroyed', fire)
  sender.on('render-process-gone', fire)
  sender.on('did-start-navigation', onNavigate)
  return () => {
    sender.removeListener('destroyed', fire)
    sender.removeListener('render-process-gone', fire)
    sender.removeListener('did-start-navigation', onNavigate)
  }
}

function registerRepoIpc(repoClone: RepoCloneService): void {
  ipcMain.handle(IPC.projectsParseRepoSource, (_e, text: unknown): RepoSourceParse => {
    try {
      return typeof text === 'string' ? repoClone.parse(text) : parseRepoSource(undefined)
    } catch {
      return parseRepoSource(undefined)
    }
  })
  ipcMain.handle(IPC.projectsRepoTools, async (): Promise<RepoTools> => {
    try {
      return await repoClone.tools()
    } catch {
      return { git: { available: false }, gh: { available: false, loggedIn: false, detail: 'OrgAI could not check your GitHub CLI sign-in.' } }
    }
  })
  ipcMain.handle(IPC.projectsCloneRepo, async (e, raw: unknown): Promise<RepoCloneResult> => {
    const input = repoCloneArgs(raw)
    const sender = e.sender
    const onProgress = (event: RepoCloneProgress): void => {
      if (!sender.isDestroyed()) sender.send(IPC.projectsCloneProgress, event)
    }
    // A closed, crashed or navigated window cancels its own clone.
    const stopWatching = watchSenderGone(sender as unknown as GoneWatchable,() => repoClone.cancel(input.requestId))
    try {
      return await repoClone.clone(input, onProgress)
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'The clone failed.'
      log.warn(`Clone request failed: ${scrubStderr(message)}`)
      throw new Error(message)
    } finally {
      stopWatching()
    }
  })
  ipcMain.handle(IPC.projectsCancelClone, (_e, id: unknown): void => {
    try {
      repoClone.cancel(repoCancelArg(id))
    } catch {
      // an invalid id names no clone
    }
  })
}

// ---- Practice kit ----

const kitExportPicks = new PickedPaths()
const kitImportPicks = new PickedPaths()
const kitTrackedSenders = new Set<number>()
function rememberKitPath(picks: PickedPaths, sender: WebContents, path: string): void {
  picks.remember(sender.id, path)
  if (kitTrackedSenders.has(sender.id)) return
  kitTrackedSenders.add(sender.id)
  const id = sender.id
  sender.once('destroyed', () => {
    kitExportPicks.forget(id)
    kitImportPicks.forget(id)
    kitTrackedSenders.delete(id)
  })
}

/**
 * kit:* channels. The save and open dialogs are main's own; kit:export, kit:previewImport and kit:applyImport accept
 * only a path the same renderer picked (an export path is consumed by a successful export). Inputs are rebuilt field by
 * field (`exportArgs`, `applyArgs`).
 */
function registerKitIpc(kit: KitService): void {
  const pickedPath = (input: unknown): string => {
    const p = input && typeof input === 'object' && !Array.isArray(input) ? (input as { path?: unknown }).path : undefined
    if (typeof p !== 'string' || !p || p.length > 4096) throw new Error('Choose a kit file.')
    return p
  }
  ipcMain.handle(KIT_IPC.kitPickExportPath, async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = { title: 'Save a practice kit', defaultPath: 'practice.orgai-kit.json', filters: [{ name: 'OrgAI kit', extensions: ['json'] }] }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const path = kitExportTarget(result.filePath, existsSync)
    rememberKitPath(kitExportPicks, e.sender, path)
    return path
  })
  ipcMain.handle(KIT_IPC.kitPickImportPath, async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = { title: 'Import a practice kit', properties: ['openFile' as const], filters: [{ name: 'OrgAI kit', extensions: ['json'] }] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? null : result.filePaths[0] ?? null
    if (path) rememberKitPath(kitImportPicks, e.sender, path)
    return path
  })
  ipcMain.handle(KIT_IPC.kitExport, (e, input: unknown): KitExportResult => {
    const i = kitExportArgs(input)
    if (!kitExportPicks.has(e.sender.id, i.path)) throw new Error('Choose where to save the kit with the Save dialog first.')
    const out = kit.export(i)
    kitExportPicks.take(e.sender.id, i.path)
    return out
  })
  ipcMain.handle(KIT_IPC.kitPreviewImport, (e, input: unknown): KitImportPreview => {
    const path = pickedPath(input)
    if (!kitImportPicks.has(e.sender.id, path)) throw new Error('Choose the kit file with the file dialog first.')
    return kit.previewImport({ path })
  })
  ipcMain.handle(KIT_IPC.kitApplyImport, (e, input: unknown): KitApplyResult => {
    const i = kitApplyArgs(input)
    if (!kitImportPicks.has(e.sender.id, i.path)) throw new Error('Choose the kit file with the file dialog first.')
    return kit.applyImport(i)
  })
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

// ---------- Team templates, engagement document and notes, project removal ----------

/** A project id for a stored project: a valid id that is not virtual. */
function storedIdArg(id: unknown): string {
  if (!isSafeId(id) || isVirtualProjectId(id)) throw new Error('Project not found')
  return id
}

/** projects:remove / projects:removePreview input: a bare id, or { projectId, removeRuns? } (extra fields dropped). */
export function projectRemoveArgs(input: unknown): { projectId: string; removeRuns: boolean | undefined } {
  if (typeof input === 'string') {
    if (isVirtualProjectId(input)) throw new Error('This assistant project cannot be removed.')
    return { projectId: storedIdArg(input), removeRuns: undefined }
  }
  const i = obj<Partial<ProjectRemoveInput>>(input)
  if (typeof i.projectId === 'string' && isVirtualProjectId(i.projectId)) throw new Error('This assistant project cannot be removed.')
  if (i.removeRuns !== undefined && typeof i.removeRuns !== 'boolean') throw new Error('Invalid removal options.')
  return { projectId: storedIdArg(i.projectId), removeRuns: i.removeRuns }
}

/** Runs are removed by default; an engagement always removes them (false is ignored there). */
export function effectiveRemoveRuns(kind: 'code' | 'engagement', asked: boolean | undefined): boolean {
  return kind === 'engagement' ? true : asked !== false
}

export interface RemovalDeps {
  dataDir: string
  /** The stored project, or null when it is already gone. */
  project: Project | null
  /** Run records the project has (RunManager.list). */
  runCount(projectId: string): number
}

/**
 * What removing a project deletes, gathered before anything is deleted. projects:remove returns it (with the run
 * count RunManager reports) and projects:removePreview returns it as is, so the two always agree. Best effort: a
 * failing lookup counts as nothing. `removeRuns` is the effective value (effectiveRemoveRuns).
 */
export function removalFacts(deps: RemovalDeps, projectId: string, removeRuns: boolean): ProjectRemoveResult {
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  const runs = safe(() => deps.runCount(projectId), 0)
  const exists = (file: string | null): boolean => !!file && safe(() => existsSync(file), false)
  return {
    projectId,
    kind: projectKindOf(deps.project),
    runsRemoved: removeRuns ? runs : 0,
    runsKept: removeRuns ? 0 : runs,
    notesRemoved: safe(() => listNotes(deps.dataDir, projectId).length, 0),
    skillsRemoved: deps.project?.skills?.length ?? 0,
    documentRemoved: engagementDocumentExists(deps.dataDir, projectId),
    rulesRemoved: appRulesExist(deps.dataDir, projectId),
    teamReviewRemoved: exists(teamReviewFile(deps.dataDir, projectId)),
    skillEvaluationRemoved: exists(skillEvaluationFile(deps.dataDir, projectId)),
    knowledgeRemoved: safe(() => knowledgeNodeCount(deps.dataDir, projectId), 0)
  }
}

const NOTE_ID = /^note_[A-Za-z0-9_-]{1,100}$/

/** Renderer input of the templates:* and engagement channels, rebuilt field by field (extra fields dropped). */
export const templateEngagementArgs = {
  projectId(input: unknown): string {
    return storedIdArg(input)
  },
  templateId(input: unknown): string {
    if (!isSafeId(input)) throw new Error('Template not found')
    return input
  },
  saveTemplate(input: unknown): OrgTemplateSaveInput {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.name !== 'string') throw new Error('Give the template a name.')
    if (i.description !== undefined && typeof i.description !== 'string') throw new Error('The template description must be text.')
    return { projectId: storedIdArg(i.projectId), name: i.name, ...(typeof i.description === 'string' ? { description: i.description } : {}) }
  },
  applyTemplate(input: unknown): OrgTemplateApplyInput {
    const i = obj<Record<string, unknown>>(input)
    if (i.mode !== 'replace' && i.mode !== 'merge') throw new Error('Choose whether the template replaces the org chart or is added to it.')
    return { projectId: storedIdArg(i.projectId), templateId: templateEngagementArgs.templateId(i.templateId), mode: i.mode }
  },
  updateDocument(input: unknown): EngagementDocumentUpdate {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.text !== 'string') throw new Error('The engagement document must be text.')
    if (i.expectedUpdatedAt !== undefined && (typeof i.expectedUpdatedAt !== 'number' || !Number.isFinite(i.expectedUpdatedAt) || i.expectedUpdatedAt < 0)) {
      throw new Error('Invalid document version.')
    }
    return { projectId: storedIdArg(i.projectId), text: i.text, ...(typeof i.expectedUpdatedAt === 'number' ? { expectedUpdatedAt: i.expectedUpdatedAt } : {}) }
  },
  noteRef(input: unknown): EngagementNoteRef {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.noteId !== 'string' || !NOTE_ID.test(i.noteId)) throw new Error('Note not found')
    return { projectId: storedIdArg(i.projectId), noteId: i.noteId }
  },
  saveNote(input: unknown): EngagementNoteSaveInput {
    const i = obj<Record<string, unknown>>(input)
    if (typeof i.title !== 'string') throw new Error('The title must be text.')
    if (typeof i.text !== 'string') throw new Error('The note must be text.')
    let noteId: string | undefined
    if (i.noteId !== undefined && i.noteId !== null) {
      if (typeof i.noteId !== 'string' || !NOTE_ID.test(i.noteId)) throw new Error('Note not found')
      noteId = i.noteId
    }
    if (i.retired !== undefined && i.retired !== null && typeof i.retired !== 'boolean') throw new Error('retired must be true or false.')
    return {
      projectId: storedIdArg(i.projectId),
      ...(noteId ? { noteId } : {}),
      title: i.title,
      text: i.text,
      ...(typeof i.retired === 'boolean' ? { retired: i.retired } : {})
    }
  }
}

/** Push projects:engagementChanged to every live window (RunManager gets it as `engagementChanged` for agent writes). */
export function broadcastEngagementChanged(event: EngagementChangedEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.projectsEngagementChanged, event)
  }
}

const isKnowledgeId = (x: unknown, prefix: string): x is string => isSafeId(x) && x.startsWith(prefix)

/** An optional id field: undefined / null = absent; anything else must be a string with the prefix, else `refusal`. */
function optionalKnowledgeId(x: unknown, prefix: string, refusal: string): string | undefined {
  if (x === undefined || x === null) return undefined
  if (!isKnowledgeId(x, prefix)) throw new Error(refusal)
  return x
}

/** An optional string field: undefined / null = absent; anything else must be a string. */
function optionalText(x: unknown, label: string): string | undefined {
  if (x === undefined || x === null) return undefined
  if (typeof x !== 'string') throw new Error(`${label} must be text.`)
  return x
}

function optionalBoolean(x: unknown, label: string): boolean | undefined {
  if (x === undefined || x === null) return undefined
  if (typeof x !== 'boolean') throw new Error(`${label} must be true or false.`)
  return x
}

function optionalTextList(x: unknown, label: string): string[] | undefined {
  if (x === undefined || x === null) return undefined
  if (!Array.isArray(x) || x.some((s) => typeof s !== 'string')) throw new Error(`${label} must be a list of text.`)
  return [...(x as string[])]
}

/**
 * Renderer input of the knowledge:* channels, rebuilt field by field (extra fields dropped, wrong types refused with a
 * short message). String content (lengths, hidden characters, keys, caps) is the store's to validate.
 */
export const knowledgeArgs = {
  projectId(input: unknown): string {
    return storedIdArg(input)
  },
  saveNode(input: unknown): KnowledgeNodeSaveInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = storedIdArg(i.projectId)
    const nodeId = optionalKnowledgeId(i.nodeId, 'kn_', 'Entity not found')
    if (typeof i.kind !== 'string') throw new Error('The kind must be text.')
    if (typeof i.name !== 'string') throw new Error('The name must be text.')
    const aliases = optionalTextList(i.aliases, 'Aliases')
    const summary = optionalText(i.summary, 'The summary')
    const noteIds = optionalTextList(i.noteIds, 'Note links')
    const retired = optionalBoolean(i.retired, 'retired')
    let facts: KnowledgeFactInput[] | undefined
    if (i.facts !== undefined && i.facts !== null) {
      if (!Array.isArray(i.facts)) throw new Error('Facts must be a list.')
      facts = i.facts.map((raw): KnowledgeFactInput => {
        const f = obj<Record<string, unknown>>(raw)
        const id = optionalKnowledgeId(f.id, 'kf_', 'Fact not found')
        if (typeof f.text !== 'string') throw new Error('A fact must be text.')
        const flag = optionalBoolean(f.retired, 'A fact\'s retired flag')
        return { ...(id ? { id } : {}), text: f.text, ...(flag !== undefined ? { retired: flag } : {}) }
      })
    }
    return {
      projectId,
      ...(nodeId ? { nodeId } : {}),
      kind: i.kind,
      name: i.name,
      ...(aliases ? { aliases } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(facts ? { facts } : {}),
      ...(noteIds ? { noteIds } : {}),
      ...(retired !== undefined ? { retired } : {})
    }
  },
  /** projectId plus exactly one of nodeId / edgeId. */
  itemRef(input: unknown): KnowledgeItemRef {
    const i = obj<Record<string, unknown>>(input)
    const projectId = storedIdArg(i.projectId)
    const nodeId = optionalKnowledgeId(i.nodeId, 'kn_', 'Entity not found')
    const edgeId = optionalKnowledgeId(i.edgeId, 'ke_', 'Relation not found')
    if ((nodeId === undefined) === (edgeId === undefined)) throw new Error('Name exactly one of nodeId or edgeId.')
    return { projectId, ...(nodeId ? { nodeId } : {}), ...(edgeId ? { edgeId } : {}) }
  },
  saveEdge(input: unknown): KnowledgeEdgeSaveInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = storedIdArg(i.projectId)
    const edgeId = optionalKnowledgeId(i.edgeId, 'ke_', 'Relation not found')
    if (typeof i.from !== 'string' || typeof i.to !== 'string') throw new Error('Name the two entities to relate.')
    if (typeof i.relation !== 'string') throw new Error('The relation must be text.')
    const note = optionalText(i.note, 'The note')
    const retired = optionalBoolean(i.retired, 'retired')
    return {
      projectId,
      ...(edgeId ? { edgeId } : {}),
      from: i.from,
      to: i.to,
      relation: i.relation,
      ...(note !== undefined ? { note } : {}),
      ...(retired !== undefined ? { retired } : {})
    }
  },
  /** projectId plus a link id of the KNOWLEDGE_LINK_ID_RE shape; extra fields dropped. */
  dismissLink(input: unknown): KnowledgeDismissLinkInput {
    const i = obj<Record<string, unknown>>(input)
    const projectId = storedIdArg(i.projectId)
    if (typeof i.linkId !== 'string' || !KNOWLEDGE_LINK_ID_RE.test(i.linkId)) throw new Error('That is not a connection id.')
    return { projectId, linkId: i.linkId }
  }
}

/** knowledge:* handlers: reads for any stored project (empty for code projects), writes for engagements only. */
function registerKnowledgeIpc({ projects, dataDir }: { projects: ProjectStore; dataDir: string }): void {
  const stored = (id: string): Project => {
    const p = projects.get(id)
    if (!p) throw new Error('Project not found')
    return p
  }
  const engagement = (id: string): Project => {
    const p = stored(id)
    if (projectKindOf(p) !== 'engagement') throw new Error('Only engagements keep a knowledge graph.')
    return p
  }
  const changed = (projectId: string, ids?: string[]): void => broadcastEngagementChanged({ projectId, what: 'knowledge', ...(ids ? { ids } : {}) })
  ipcMain.handle(IPC.knowledgeGet, (_e, id: unknown): KnowledgeGraph => {
    const project = stored(knowledgeArgs.projectId(id))
    return projectKindOf(project) === 'engagement' ? readKnowledge(dataDir, project.id) : emptyKnowledgeGraph()
  })
  ipcMain.handle(IPC.knowledgeSaveNode, (_e, input: unknown): KnowledgeNode => {
    const { projectId, ...rest } = knowledgeArgs.saveNode(input)
    const node = saveNodeForUser(dataDir, engagement(projectId).id, rest)
    changed(projectId, [node.id])
    return node
  })
  ipcMain.handle(IPC.knowledgeRemoveNode, (_e, input: unknown): KnowledgeGraph => {
    const ref = knowledgeArgs.itemRef(input)
    if (!ref.nodeId) throw new Error('Entity not found')
    const project = engagement(ref.projectId)
    const before = readKnowledge(dataDir, project.id)
    const removedEdges = before.edges.filter((e) => e.from === ref.nodeId || e.to === ref.nodeId).map((e) => e.id)
    const graph = removeNode(dataDir, project.id, ref.nodeId)
    changed(project.id, [ref.nodeId, ...removedEdges])
    return graph
  })
  ipcMain.handle(IPC.knowledgeSaveEdge, (_e, input: unknown): KnowledgeEdge => {
    const { projectId, ...rest } = knowledgeArgs.saveEdge(input)
    const { edge } = saveEdge(dataDir, engagement(projectId).id, rest, userSource())
    changed(projectId, [edge.id])
    return edge
  })
  ipcMain.handle(IPC.knowledgeRemoveEdge, (_e, input: unknown): KnowledgeGraph => {
    const ref = knowledgeArgs.itemRef(input)
    if (!ref.edgeId) throw new Error('Relation not found')
    const graph = removeEdge(dataDir, engagement(ref.projectId).id, ref.edgeId)
    changed(ref.projectId, [ref.edgeId])
    return graph
  })
  ipcMain.handle(IPC.knowledgeClear, (_e, id: unknown): KnowledgeGraph => {
    const project = engagement(knowledgeArgs.projectId(id))
    const graph = clearKnowledge(dataDir, project.id)
    changed(project.id)
    return graph
  })
  ipcMain.handle(IPC.knowledgeInferredLinks, (_e, id: unknown): KnowledgeInferredResult => {
    const project = stored(knowledgeArgs.projectId(id))
    return projectKindOf(project) === 'engagement' ? readKnowledgeInferred(dataDir, project.id) : { links: [], appearances: {} }
  })
  ipcMain.handle(IPC.knowledgeDismissLink, (_e, input: unknown): KnowledgeInferredResult => {
    const { projectId, linkId } = knowledgeArgs.dismissLink(input)
    const result = dismissKnowledgeLink(dataDir, engagement(projectId).id, linkId)
    changed(projectId, [linkId])
    return result
  })
}

function registerTemplateEngagementIpc({ projects, templates, dataDir }: { projects: ProjectStore; templates: TemplateService; dataDir: string }): void {
  const stored = (id: string): Project => {
    const p = projects.get(id)
    if (!p) throw new Error('Project not found')
    return p
  }
  ipcMain.handle(IPC.templatesList, (): OrgTemplateInfo[] => templates.list())
  ipcMain.handle(IPC.templatesSaveFromProject, (_e, input: unknown): OrgTemplateInfo => templates.saveFromProject(templateEngagementArgs.saveTemplate(input)))
  ipcMain.handle(IPC.templatesRemove, (_e, id: unknown): OrgTemplateInfo[] => templates.remove(templateEngagementArgs.templateId(id)))
  ipcMain.handle(IPC.templatesApply, (_e, input: unknown): AgentImportApplyResult => templates.apply(templateEngagementArgs.applyTemplate(input)))

  ipcMain.handle(IPC.projectsEngagementDocument, (_e, id: unknown): EngagementDocumentInfo => {
    const project = stored(templateEngagementArgs.projectId(id))
    return projectKindOf(project) === 'engagement' ? readEngagementDocumentInfo(dataDir, project.id) : { text: '' }
  })
  ipcMain.handle(IPC.projectsUpdateEngagementDocument, (_e, input: unknown): EngagementDocumentInfo => {
    const i = templateEngagementArgs.updateDocument(input)
    const project = stored(i.projectId)
    if (projectKindOf(project) !== 'engagement') throw new Error('Only engagements keep their document in OrgAI.')
    const info = updateEngagementDocument(dataDir, project.id, i.text, i.expectedUpdatedAt)
    broadcastEngagementChanged({ projectId: project.id, what: 'document' })
    return info
  })
  ipcMain.handle(IPC.projectsListNotes, (_e, id: unknown): EngagementNote[] => listNotes(dataDir, stored(templateEngagementArgs.projectId(id)).id))
  ipcMain.handle(IPC.projectsGetNote, (_e, input: unknown): EngagementNoteContent => {
    const ref = templateEngagementArgs.noteRef(input)
    const note = readNote(dataDir, stored(ref.projectId).id, ref.noteId)
    if (!note) throw new Error('Note not found')
    return note
  })
  ipcMain.handle(IPC.projectsSaveNote, (_e, input: unknown): EngagementNote => {
    const i = templateEngagementArgs.saveNote(input)
    const note = saveNote(dataDir, stored(i.projectId).id, { noteId: i.noteId, title: i.title, text: i.text, retired: i.retired })
    broadcastEngagementChanged({ projectId: i.projectId, what: 'notes', ids: [note.id] })
    return note
  })
  ipcMain.handle(IPC.projectsRemoveNote, (_e, input: unknown): EngagementNote[] => {
    const ref = templateEngagementArgs.noteRef(input)
    const rest = removeNote(dataDir, stored(ref.projectId).id, ref.noteId)
    broadcastEngagementChanged({ projectId: ref.projectId, what: 'notes', ids: [ref.noteId] })
    return rest
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
    if (!connection || typeof connection !== 'object') throw new Error('Unknown connection')
    connectionIdArg(connection.id)
    return connections.update(connection)
  })
  ipcMain.handle(IPC.connectionsSetSecret, (_e, input: unknown): Promise<ConnectionInfo> => connections.setSecret(connectionSecretArgs(input)))
  ipcMain.handle(IPC.connectionsTest, (_e, id: unknown): Promise<ConnectionStatus> => connections.test(connectionIdArg(id)))
  ipcMain.handle(IPC.connectionsConnect, (_e, id: unknown): Promise<ConnectionInfo> => connections.connect(connectionIdArg(id)))
  ipcMain.handle(IPC.connectionsLogin, (_e, id: 'openai', method?: ConnectionLoginMethod): Promise<ConnectionLoginStart> =>
    connections.login(id, method === 'deviceCode' ? 'deviceCode' : 'browser')
  )
  ipcMain.handle(IPC.connectionsCancelLogin, (_e, loginId: string): Promise<void> => connections.cancelLogin(loginId))
  ipcMain.handle(IPC.connectionsLogout, (_e, id: unknown): Promise<ConnectionInfo> => connections.logout(connectionIdArg(id)))
  ipcMain.handle(IPC.modelsList, (_e, query?: unknown): ProviderModel[] => connections.models(modelsQueryArg(query)))
  ipcMain.handle(IPC.modelsRefresh, (_e, query?: unknown): Promise<ProviderModel[]> => connections.refresh(modelsQueryArg(query)))
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
  ipcMain.handle(IPC.mcpSetSecret, (_e, input: unknown): McpMutationResult => mcp.setSecret(mcpSecretArgs(input)))
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
  ipcMain.handle(IPC.mcpLibrarySetSecret, (_e, input: unknown): McpLibraryInfo[] => mcp.librarySetSecret(mcpLibrarySecretArgs(input)))
  ipcMain.handle(IPC.mcpLibraryTest, (_e, input: { libraryId: string }): Promise<McpTestResult> => mcp.libraryTest(input))
  // Connectors: the renderer names a preset (and a variant); main builds the entry from src/shared/connectors.ts.
  ipcMain.handle(IPC.connectorsList, (): ConnectorInfo[] => mcp.connectorsList())
  ipcMain.handle(IPC.connectorsAdd, (_e, input: unknown): McpLibraryInfo => mcp.connectorsAdd(connectorArgs.add(input)))
  ipcMain.handle(IPC.connectorsSetToken, (_e, input: unknown): McpLibraryInfo => mcp.connectorsSetToken(connectorArgs.setToken(input)))
  ipcMain.handle(IPC.pluginsUpsert, (_e, input: PluginUpsertInput): Project => mcp.upsertPlugin(input))
  ipcMain.handle(IPC.pluginsRemove, (_e, input: { projectId: string; pluginId: string }): Project => mcp.removePlugin(input))

  // ---- MCP per-project secrets and custom connector presets ----
  ipcMain.handle(MCP_SCOPE_IPC.mcpCopyFromLibrary, (_e, input: unknown) => mcp.copyFromLibrary(mcpCopyArgs(input)))
  ipcMain.handle(MCP_SCOPE_IPC.mcpSetProjectOverrides, (_e, input: unknown) => mcp.setProjectOverrides(mcpOverridesArgs(input)))
  ipcMain.handle(MCP_SCOPE_IPC.connectorPresetsList, () => mcp.connectorPresetsList())
  // The service validates the whole definition (validateUserPreset); the handler passes the raw structured-clone input.
  ipcMain.handle(MCP_SCOPE_IPC.connectorPresetsUpsert, (_e, input: unknown) => mcp.connectorPresetsUpsert(input))
  ipcMain.handle(MCP_SCOPE_IPC.connectorPresetsRemove, (_e, input: unknown) => mcp.connectorPresetsRemove(presetRemoveArgs(input)))
}

/**
 * The settings the renderer sees (settings:get / settings:set results, the settings:changed push): defaultConnection
 * is the effective default, never the stored value (defaultConnectionChosen still says whether the user picked it;
 * settings:set keeps the stored value whatever is echoed back). Pure; exported for tests and index.ts.
 */
export function withEffectiveDefault(s: AppSettings, effective: ConnectionId): AppSettings {
  return { ...s, defaultConnection: effective }
}

/**
 * connections:test / connections:logout input: a known ConnectionId (an own entry of CONNECTION_IDS, never a
 * prototype key), else "Unknown connection". Exported for tests.
 */
export function connectionIdArg(raw: unknown): ConnectionId {
  if (!isConnectionId(raw)) throw new Error('Unknown connection')
  return raw
}

/** Longest LiteLLM key accepted over IPC (connections:setSecret). */
export const CONNECTION_SECRET_MAX_CHARS = 4000

/**
 * connections:setSecret input rebuilt as `{ id: 'litellm', apiKey: string | null }`: the key is printable text
 * without line breaks or control characters (it becomes an env var and an Authorization header), at most
 * CONNECTION_SECRET_MAX_CHARS; '' or null clears it. Anything else is refused; extra fields are dropped. The error
 * never echoes the value. Exported for tests.
 */
export function connectionSecretArgs(raw: unknown): ConnectionSecretInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Only the LiteLLM connection has a stored secret')
  const i = raw as Record<string, unknown>
  if (i.id !== 'litellm') throw new Error('Only the LiteLLM connection has a stored secret')
  if (i.apiKey === null || i.apiKey === undefined) return { id: 'litellm', apiKey: null }
  if (typeof i.apiKey !== 'string') throw new Error('The API key must be text.')
  if (i.apiKey.length > CONNECTION_SECRET_MAX_CHARS) throw new Error(`The API key is too long (at most ${CONNECTION_SECRET_MAX_CHARS} characters).`)
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(i.apiKey.trim())) throw new Error('The API key contains line breaks or hidden characters.')
  return { id: 'litellm', apiKey: i.apiKey }
}

/**
 * models:list / models:refresh input rebuilt: undefined or null for every enabled connection, else an object whose
 * `connection` is absent or a known ConnectionId; other fields are dropped. Exported for tests.
 */
export function modelsQueryArg(raw: unknown): ModelsQuery | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Unknown connection')
  const connection = (raw as Record<string, unknown>).connection
  if (connection === undefined) return {}
  return { connection: connectionIdArg(connection) }
}

/**
 * settings:set input: a plain object (anything else is refused), merged onto the stored settings (never onto the
 * defaults, so a field the renderer left out keeps its stored value). The main-owned fields always keep their stored
 * values: defaultConnection, defaultConnectionChosen and defaultConnectionReplaced (change the default only through
 * connections:setDefault), connections and its providerAuth mirror (connections:update / setSecret). The
 * AppSettingsInfo extras are dropped. Pure; exported for tests. SettingsStore.set normalizes the rest.
 */
export const OPEN_PATH_MAX_CHARS = 1024
export const OPEN_PATH_REFUSAL = "OrgAI only opens project folders, allowed folders and its own data folder."

/** lstat as a directory probe: a symlink or a file is not a directory; null when missing or unreadable. */
export function lstatDirectory(p: string): { isDirectory: boolean } | null {
  try {
    return { isDirectory: lstatSync(p).isDirectory() }
  } catch {
    return null
  }
}

/**
 * app:openPath guard (pure apart from the injected stat and path canonicalization): a refusal message, or null when
 * `path` may be handed to the OS. Only an existing real directory that is a stored project's folder, an entry of a
 * project's allowedDirectories, or the data folder / inside it, compared on lexical and real spellings.
 */
export function openPathRefusal(
  path: unknown,
  ctx: { dataDir: string; projectPaths: string[]; allowedDirectories: string[]; stat: (p: string) => { isDirectory: boolean } | null }
): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'No folder was given.'
  if (path.length > OPEN_PATH_MAX_CHARS) return 'That path is too long.'
  if (path.includes('\0') || hiddenCharProblem('path', path)) return 'That path has hidden characters.'
  if (/^[\\/]{2}/.test(path)) return 'OrgAI does not open network or device paths.'
  const absolute = process.platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(path) : isAbsolute(path)
  if (!absolute) return 'That path is not absolute.'
  const st = ctx.stat(path)
  if (!st) return 'That folder does not exist.'
  if (!st.isDirectory) return 'OrgAI only opens folders.'
  try {
    const known = [...ctx.projectPaths, ...ctx.allowedDirectories].some((p) => typeof p === 'string' && p !== '' && samePath(p, path))
    if (known || isInsideEither(ctx.dataDir, path)) return null
  } catch {
    // fall through: fail closed
  }
  return OPEN_PATH_REFUSAL
}

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
  // A field whose kind differs from the stored one's (a non-array modelPrices, a string flag, null) is dropped, so a
  // malformed save never wipes a stored value. undefined still clears an optional field; a field with nothing stored
  // goes through to SettingsStore normalization.
  const kindOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
  const storedFields = stored as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(rest)) {
    const was = Object.hasOwn(storedFields, key) ? storedFields[key] : undefined
    if (value !== undefined && was !== undefined && kindOf(value) !== kindOf(was)) delete (rest as Record<string, unknown>)[key]
  }
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

/**
 * mcp:copyFromLibrary input rebuilt field by field: a plain object with projectId and serverId matching SAFE_ID and a
 * boolean copySecrets; extra fields are dropped, anything else is refused. Exported for tests.
 */
export function mcpCopyArgs(input: unknown): McpCopyFromLibraryInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid copy request.')
  const i = input as Record<string, unknown>
  if (!isSafeId(i.projectId) || !isSafeId(i.serverId) || typeof i.copySecrets !== 'boolean') throw new Error('Invalid copy request.')
  return { projectId: i.projectId, serverId: i.serverId, copySecrets: i.copySecrets }
}

function secretArgs(input: unknown, idField: 'projectId' | 'libraryId'): Record<string, unknown> {
  const bad = (): never => {
    throw new Error('Invalid secret.')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad()
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) return bad()
  const i = input as Record<string, unknown>
  const own = (k: string): unknown => (Object.hasOwn(i, k) ? i[k] : undefined)
  if (!isSafeId(own(idField))) return bad()
  const kind = own('kind')
  if (kind !== 'env' && kind !== 'header') return bad()
  const name = own('name')
  if (typeof name !== 'string' || name.length < 1 || name.length > 128) return bad()
  const value = own('value')
  if (value !== null) {
    if (typeof value !== 'string' || value.length > 4000 || hiddenCharIn(value)) return bad()
  }
  const out: Record<string, unknown> = { [idField]: own(idField), kind, name, value }
  if (idField === 'projectId') {
    if (!isSafeId(own('serverId'))) return bad()
    out.serverId = own('serverId')
  }
  return out
}

/** mcp:setSecret input rebuilt field by field; "Invalid secret." never echoes the value. Exported for tests. */
export function mcpSecretArgs(input: unknown): McpSecretInput {
  return secretArgs(input, 'projectId') as unknown as McpSecretInput
}

/** mcpLibrary:setSecret input rebuilt field by field. Exported for tests. */
export function mcpLibrarySecretArgs(input: unknown): McpLibrarySecretInput {
  return secretArgs(input, 'libraryId') as unknown as McpLibrarySecretInput
}

/** Most names one mcp:setProjectOverrides map may carry (the entry's perProjectEnv is capped at 20 anyway). */
export const OVERRIDES_MAX_KEYS = 50

/**
 * mcp:setProjectOverrides input rebuilt field by field: a plain object with SAFE_ID projectId and serverId and, for
 * env and headers each, absent or a plain object of at most OVERRIDES_MAX_KEYS string values; anything else is refused
 * ("Invalid overrides."), extra fields are dropped. McpService.setProjectOverrides filters names and checks values.
 * Exported for tests.
 */
export function mcpOverridesArgs(input: unknown): McpProjectOverridesInput {
  const bad = (): never => {
    throw new Error('Invalid overrides.')
  }
  const isPlainObject = (v: unknown): v is Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    const proto = Object.getPrototypeOf(v)
    return proto === Object.prototype || proto === null
  }
  if (!isPlainObject(input)) return bad()
  if (!isSafeId(input.projectId) || !isSafeId(input.serverId)) return bad()
  const out: McpProjectOverridesInput = { projectId: input.projectId, serverId: input.serverId }
  for (const field of ['env', 'headers'] as const) {
    const given = Object.hasOwn(input, field) ? input[field] : undefined
    if (given === undefined) continue
    if (!isPlainObject(given)) return bad()
    const entries = Object.entries(given)
    if (entries.length > OVERRIDES_MAX_KEYS) return bad()
    const map: Record<string, string> = {}
    for (const [k, v] of entries) {
      if (typeof v !== 'string' || k === '__proto__') return bad()
      map[k] = v
    }
    out[field] = map
  }
  return out
}

/** connectorPresets:remove input rebuilt as `{ id }`: a kebab-case id of at most 64 characters, else "Unknown connector." Exported for tests. */
export function presetRemoveArgs(input: unknown): ConnectorPresetRemoveInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Unknown connector.')
  const id = (input as Record<string, unknown>).id
  if (typeof id !== 'string' || !CONNECTOR_ID_RE.test(id)) throw new Error('Unknown connector.')
  return { id }
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
