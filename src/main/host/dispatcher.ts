/**
 * The host dispatcher (cli-spec 3.1, 3.3(3), Wave 1): every request handler, served to the desktop (ipcMain through
 * ipc.ts) and to RPC clients (Wave 2's socket server, the CLI's inproc host). Electron-free; relative imports only
 * (noElectronImport.test.ts).
 *
 * - `invoke` is the trusted in-process desktop path: no gate, no lease (the window is the interactiveClients lease),
 *   and the handler's result is returned as is, so a sync handler stays sync and a sync throw stays a sync throw.
 * - `invokeRpc` is the untrusted wire path: gate (scope, params), refuse transport-owned channels, refuse mutations
 *   while draining, hold an inFlightRpcMutations lease for mutations, map coded errors to HostRpcFailure.
 *
 * Pushes the handlers make (projects:engagementChanged) go on `events`; the desktop shell forwards them to windows.
 */
import type {
  AgentImportApplyInput,
  AgentImportApplyResult,
  AgentImportInput,
  AgentImportPreview,
  AgentImportScan,
  AppInfo,
  AppSettings,
  DecidedBy,
  DecisionLookup,
  DecisionOptions,
  DecisionOutcome,
  AppSettingsInfo,
  AuthStatusResult,
  CapabilityApplyResult,
  CapabilityDiscovery,
  CapabilityUndoResult,
  ConnectionId,
  ConnectionInfo,
  ConnectionLoginMethod,
  ConnectionLoginStart,
  ConnectionStatus,
  ProxyRemoveResult,
  ConnectorInfo,
  ContinueRunInput,
  DraftRequest,
  EngagementDocumentInfo,
  EngagementNote,
  EngagementNoteContent,
  FolderConfigReview,
  TeamFilesStatus,
  FocusRunTarget,
  HostRpcErrorCode,
  KitApplyResult,
  KitBundleExportResult,
  KitImportPreview,
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeInferredResult,
  KnowledgeNode,
  McpAssistInput,
  McpAuthStatus,
  McpAuthTarget,
  McpAuthorizeInput,
  McpLibraryEntry,
  McpLibraryInfo,
  McpLinkLibraryInput,
  McpMutationResult,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpServerInfo,
  McpTestResult,
  McpUpsertInput,
  ModelPriceInfo,
  ModelPricesQuery,
  OrgExportResult,
  OrgTemplateInfo,
  PendingCards,
  PluginUpsertInput,
  Project,
  ProjectCreateInput,
  ProjectPathCheck,
  ProjectRemoveResult,
  ProviderConnection,
  ProviderModel,
  QuickRunPromoteResult,
  RemapModelsInput,
  RemapModelsOutput,
  RemapResult,
  RunOverrides,
  RunSummary,
  SetupStartInput,
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
  SkillLibraryInfo,
  SkillLinkLibraryInput,
  SkillMutationResult,
  SkillUpdateInput,
  TeamRecommendations,
  TeamReview,
  UsageStats,
  UsageStatsQuery
} from '../../shared/types'
import {
  HARNESS_PROJECT_ID,
  HOST_IPC,
  HOST_METHODS,
  IPC,
  MCP_SCOPE_IPC,
  QUICK_PROJECT_ID,
  SKILLS_PROJECT_ID,
  TEAM_FILES_IPC,
  isVirtualProjectId
} from '../../shared/types'
import { projectConnection, projectKindOf } from '../../shared/defaults'
import { emptyKnowledgeGraph } from '../../shared/knowledge'
import { draftOrgChart } from '../ai/draft'
import { buildAppInfo, buildSettingsInfo } from '../appInfo'
import type { CapabilityServiceApi } from '../capabilities/types'
import { claudeAuthStatus } from '../connections/anthropicAuth'
import type { ConnectionService } from '../connections/service'
import { applyBundleArgs, exportBundleArgs, previewBundleArgs, type KitService } from '../kit/service'
import { logPath } from '../log'
import { assistPrompt, harnessProject as buildHarnessProject } from '../mcp/assist'
import type { McpService } from '../mcp/service'
import type { QuickRunService } from '../quick/quickRuns'
import { createScratchDir } from '../quick/scratch'
import { folderConfigReview } from '../runtime/folderConfigTrust'
import { addRules, listIgnoredRules, listRules, removeRule } from '../runtime/permissionRules'
import type { RunManager } from '../runtime/runManager'
import { overridesWidening } from '../runtime/runOverrides'
import type { TeamFilesService } from '../teamFiles/service'
import type { TemplateService } from '../setup/templates'
import { skillAssistPrompt, skillsProject } from '../skills/assist'
import { bundleArgs } from '../skills/files'
import { applySuggestion, type SkillEvaluationApi, type SkillServiceApi } from '../skills/types'
import { clearKnowledge, dismissKnowledgeLink, readKnowledge, readKnowledgeInferred, removeEdge, removeNode, saveEdge, saveNodeForUser, userSource } from '../store/knowledge'
import {
  listNotes,
  projectRulesFile,
  readEngagementDocumentInfo,
  readNote,
  removeNote,
  removeProjectData,
  removeSkillEvaluation,
  retainRunProject,
  saveNote,
  updateEngagementDocument
} from '../store/projectData'
import { checkProjectPath, type ProjectStore } from '../store/projects'
import type { SettingsStore } from '../store/settings'
import { checkRunTarget, isValidId } from '../windowScope'
import { noopActivity } from './activity'
import {
  capabilityArgs,
  installAnswerArgs,
  mergeDecideArgs,
  permissionDecideArgs,
  questionAnswerArgs,
  ruleDecideArgs,
  continueRunArgs,
  runMessageArgs,
  startRunArgs,
  checkQuickContinue,
  connectionIdArg,
  folderConfigProjectArg,
  pathCheckWithTeamFiles,
  projectCreateInput,
  teamFilesArgs,
  connectionSecretArgs,
  proxyCreateArgs,
  proxyIdArg,
  connectorArgs,
  effectiveRemoveRuns,
  harnessProjectFor,
  knowledgeArgs,
  mcpAssistArgs,
  mcpCopyArgs,
  mcpLibrarySecretArgs,
  mcpOverridesArgs,
  mcpSecretArgs,
  modelsQueryArg,
  obj,
  permissionAddRefusal,
  permissionRuleArgs,
  presetRemoveArgs,
  projectIdArg,
  projectRemoveArgs,
  proposalDecideArgs,
  quickArgs,
  removalFacts,
  settingsSetArgs,
  appReferenceArgs,
  skillAssistArgs,
  templateEngagementArgs,
  withEffectiveDefault
} from './args'
import { HostEventBus } from './events'
import { registerOutputsHandlers } from './outputsHandlers'
import { HostRpcFailure, gateRequest, type GateFn } from './registry'
import type { HostActivityTrackerApi, HostDispatchEnv, HostServices, InvokeContext, RpcInvokeContext } from './types'

/** One request handler: the call context, then the positional arguments (what ipcRenderer.invoke passed). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (ctx: InvokeContext, ...args: any[]) => unknown
type Register = (channel: string, fn: Handler) => void

/**
 * Every HostRpcErrorCode: an Error thrown by a service with one of these as its `code` (knowledge:saveNode
 * `stale_revision`, kit:applyBundle `stale_target_digest`) reaches the wire with that code.
 */
const RPC_ERROR_CODES: ReadonlySet<string> = new Set<HostRpcErrorCode>([
  'host_starting',
  'host_draining',
  'terminal_server_disabled',
  'unknown_channel',
  'desktop_unavailable',
  'agent_descendant_refused',
  'stale_target_digest',
  'stale_revision',
  'scope_denied',
  'frame_too_large',
  'bad_request',
  'auth_failed',
  'protocol_mismatch',
  'too_many_connections',
  'too_many_requests'
])

/** How long a client should wait before retrying a mutation refused while the host drains. */
const DRAINING_RETRY_MS = 1000

/** Used when no env is given (unit tests that only exercise other channels): app:info reports placeholders. */
const FALLBACK_ENV: HostDispatchEnv = {
  app: { getVersion: () => '0.0.0', getPath: () => '', isPackaged: false },
  platform: process.platform,
  logsDir: () => ''
}

function unknownChannel(channel: string): Error {
  const err = new Error(`Unknown channel: ${channel}`) as Error & { code: string }
  err.code = 'unknown_channel'
  return err
}

export class HostDispatcher {
  readonly events: HostEventBus
  private readonly activity: HostActivityTrackerApi
  private readonly env: HostDispatchEnv
  private readonly gate: GateFn
  private readonly handlers: Record<string, Handler>

  constructor(
    private readonly services: HostServices,
    private readonly opts: { gate?: GateFn } = {}
  ) {
    this.events = services.events ?? new HostEventBus()
    this.activity = services.activity ?? noopActivity()
    this.env = services.env ?? FALLBACK_ENV
    this.gate = opts.gate ?? gateRequest
    this.handlers = buildHandlers(services, this.env, this.events)
  }

  /**
   * Desktop path: run the channel's handler with already-structured-cloned args. Returns the handler's result as is
   * (sync stays sync, a sync throw stays a sync throw). An unknown channel throws an Error with code 'unknown_channel'.
   */
  invoke(channel: string, args: unknown[], ctx: InvokeContext): unknown {
    const handler = this.lookup(channel)
    if (!handler) throw unknownChannel(channel)
    return handler(ctx, ...args)
  }

  /**
   * RPC path: gate (scope, params), refuse while draining, hold an inFlightRpcMutations lease for mutations (host.stop
   * excepted).
   */
  async invokeRpc(channel: string, params: unknown, ctx: RpcInvokeContext): Promise<unknown> {
    const g = this.gate(channel, params, { grantedScopes: ctx.grantedScopes, hostKind: this.env.hostKind ?? 'desktop' })
    if (g.entry.transport) throw new HostRpcFailure('bad_request', `${channel} is handled by the socket server.`)
    // host.stop is a lifecycle call, not store work: it holds no inFlightRpcMutations lease (its own lease would make
    // every drain without force refuse itself) and is never refused while draining (requestDrain joins the drain).
    const leased = g.mutation && g.channel !== HOST_METHODS.hostStop
    if (leased && this.activity.state() === 'draining') {
      throw new HostRpcFailure('host_draining', 'OrgAI is shutting down; try again in a moment.', DRAINING_RETRY_MS)
    }
    const handler = this.lookup(g.channel)
    if (!handler) throw new HostRpcFailure('unknown_channel', `Unknown channel: ${channel}`)
    const release = leased ? this.activity.acquire('inFlightRpcMutations', channel) : undefined
    try {
      return await handler(ctx, ...g.args)
    } catch (err) {
      throw rpcError(err)
    } finally {
      release?.()
    }
  }

  has(channel: string): boolean {
    return this.lookup(channel) !== undefined
  }

  /** Every channel (and host.* method) with a handler, in registration order. */
  channels(): string[] {
    void this.services
    void this.opts
    return Object.keys(this.handlers)
  }

  private lookup(channel: string): Handler | undefined {
    return typeof channel === 'string' && Object.prototype.hasOwnProperty.call(this.handlers, channel) ? this.handlers[channel] : undefined
  }
}

/** HostRpcFailure as is; an Error coded with a wire code becomes one; anything else is rethrown unchanged. */
function rpcError(err: unknown): unknown {
  if (err instanceof HostRpcFailure) return err
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code
    if (typeof code === 'string' && RPC_ERROR_CODES.has(code)) return new HostRpcFailure(code as HostRpcErrorCode, err.message)
  }
  return err
}

/** Who resolves a card through this call (cli-spec 3.4(4)): the desktop, else the client's kind (default 'cli'). */
export function decidedByOf(ctx: InvokeContext): DecidedBy {
  return {
    surface: ctx.surface === 'desktop' ? 'desktop' : (ctx.clientKind ?? 'cli'),
    ...(ctx.pid ? { reportedPid: ctx.pid } : {})
  }
}

/**
 * The DecisionOptions every decision channel passes (cli-spec 3.4(4), 5.3): the card revision the client saw (absent =
 * not checked) and who decided. The handlers return RunManager's DecisionOutcome; desktop callers ignore it.
 */
export function decisionOpts(ctx: InvokeContext, input: { expectedRevision?: number }): DecisionOptions {
  return { ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}), decidedBy: decidedByOf(ctx) }
}

/**
 * Headless run overrides at the RPC boundary (cli-spec 2 item 2, 6.2(1)). The desktop surface never sets them (the
 * renderer has no such field), so they are dropped there. From a socket / inproc client every widening field needs the
 * 'configure' scope ('operate', the channel's own scope, may only narrow): without it the call is refused as
 * scope_denied naming the fields. `allowWidening` tells RunManager whether a widening value may apply.
 */
export function checkRunOverrides(
  ctx: InvokeContext,
  project: Project,
  overrides: RunOverrides | undefined
): { overrides?: RunOverrides; allowWidening: boolean } {
  if (ctx.surface === 'desktop' || !overrides) return { allowWidening: false }
  const configure = !!ctx.grantedScopes?.includes('configure')
  if (!configure) {
    const widening = overridesWidening(project, overrides)
    if (widening.length) throw new HostRpcFailure('scope_denied', `These run options need the configure scope: ${widening.join(', ')}.`)
  }
  return { overrides, allowWidening: configure }
}

/**
 * Every request handler registerIpc and its register*Ipc helpers had, moved verbatim (same sync / async shape, same
 * error messages). The first handler argument is the InvokeContext instead of the IpcMainInvokeEvent.
 */
function buildHandlers(services: HostServices, env: HostDispatchEnv, events: HostEventBus): Record<string, Handler> {
  const table: Record<string, Handler> = Object.create(null) as Record<string, Handler>
  const handle = (channel: string, fn: Handler): void => {
    table[channel] = fn
  }
  const { projects, runs, setup, maintenance, settings, connections, mcp, adapterIds, harnessProject, importer, skills, skillEvaluation, capabilities, quick, templates, kit, teamFiles, usage, desktop, host } = services
  const mock = adapterIds.includes('mock')
  // Always served: without a usage monitor the answer is null (nothing to refresh).
  handle(IPC.usageRefresh, () => usage?.refresh() ?? Promise.resolve(null))
  // app:reference (read scope): the user and terminal clients may see the secret-free status snapshot.
  handle(IPC.appReference, (_e, raw: unknown) => {
    const q = appReferenceArgs(raw)
    return services.reference ? services.reference.query(q, { status: true }) : Promise.resolve({ text: 'The reference is not available in this host.' })
  })
  /**
   * A stored project, or the display project of a virtual id (harness, quick = "Chat", skills). Never listed by
   * projects:list. The Chat's display project has no roles and creates no directory.
   */
  const projectOrHarness = (id: string): Project | null =>
    id === HARNESS_PROJECT_ID ? harnessProject()
    : id === QUICK_PROJECT_ID ? quick.displayProject()
    : id === SKILLS_PROJECT_ID ? skillsProject(connections.effectiveSettings(), settings.dataDir, { mock })
    : projects.get(id)
  handle(IPC.projectsList, () => projects.list())
  handle(IPC.projectsGet, (_e, id: string) => projectOrHarness(id))
  // Throws a readable message for a bad path (the form shows it) or a mock project without the mock adapter.
  handle(IPC.projectsCreate, (_e, rawInput: ProjectCreateInput) => {
    // teamFiles is rebuilt to `{ digest }` (64 hex) and wins over importAgents and templateId; the folder's `.orgai`
    // agents never come through importAgents (projectCreateInput), over the socket either.
    const { input, teamArg } = projectCreateInput(rawInput, teamFiles)
    return projects.create(input, settings.get(), {
      mockAvailable: adapterIds.includes('mock'),
      prepare: (p) => connections.prepareNewProject(p),
      // After prepare: imported models map to the connection the project was put on.
      importRoles: (p, sources) => importer.rolesForNewProject(p, sources),
      // Only when importAgents produced no roles; after prepare so the template's models map to the project's connection.
      fromTemplate: (p, templateId) => templates.rolesForNewProject(p, templateId),
      // The team in the folder's .orgai as previewed; a stale digest or a problem rejects with a readable message.
      ...(teamArg && teamFiles ? { teamFiles: { build: (p: Project) => teamFiles.createFromFolder(p, teamArg.digest), adopted: (p: Project) => teamFiles.adopted(p.id) } } : {})
    })
  })
  // Never rejects: the agent scan and the existing-project lookup add fields only when they succeed.
  handle(IPC.projectsCheckPath, (_e, path: string): ProjectPathCheck => {
    const check = checkProjectPath(path)
    return pathCheckWithTeamFiles(check, importer.pathCheckExtras(path, check), teamFiles?.found(path, check))
  })
  // Agent import: read-only scans of the stored project's folder; the renderer supplies choices, never roles.
  handle(IPC.projectsScanAgents, (_e, path: string): AgentImportScan => importer.scan(path))
  handle(IPC.projectsPreviewImport, (_e, input: AgentImportInput): AgentImportPreview => importer.preview(input))
  // The digest of the reviewed preview is required; apply refuses without it or when the folder changed since.
  handle(IPC.projectsApplyImport, (_e, input: AgentImportApplyInput): AgentImportApplyResult => importer.apply(input))
  handle(IPC.projectsExportOrg, (_e, projectId: string): OrgExportResult => importer.exportOrg(projectId))
  // The renderer's copy never changes mcpServers or plugins; those go through mcp:* and plugins:*.
  handle(IPC.projectsSave, (_e, project: Project) => {
    if (typeof project?.id === 'string' && isVirtualProjectId(project.id)) throw new Error('This assistant project cannot be saved.')
    return projects.saveFromRenderer(project)
  })
  // Folder config trust: what the folder's own agent config would do (read from disk now). The user's decision
  // (projects:setFolderConfigTrust) is desktop only and is served by ipc.ts alone: no socket handler exists for it.
  handle(IPC.projectsFolderConfig, (_e, id: unknown): FolderConfigReview => {
    const project = projects.get(folderConfigProjectArg(id))
    if (!project) throw new Error('Project not found')
    return folderConfigReview(project)
  })
  // A string id or ProjectRemoveInput. Facts are gathered before anything is deleted (removalFacts).
  handle(IPC.projectsRemove, async (_e, input: unknown): Promise<ProjectRemoveResult> => {
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
  handle(IPC.projectsRemovePreview, (_e, input: unknown): ProjectRemoveResult => {
    const { projectId: id, removeRuns: asked } = projectRemoveArgs(input)
    const project = projects.get(id)
    if (!project) throw new Error('Project not found')
    return removalFacts({ dataDir: settings.dataDir, project, runCount: (pid) => runs.list(pid).length }, id, effectiveRemoveRuns(projectKindOf(project), asked))
  })

  handle(IPC.draftOrgChart, async (_e, req: DraftRequest) => {
    const project = projects.get(req.projectId)
    if (!project) throw new Error('Project not found')
    return draftOrgChart(runs.adapterFor(project), project, req, connections.importModelContext(projectConnection(project)))
  })

  handle(IPC.runsStart, async (ctx, raw: unknown) => {
    const input = startRunArgs(raw)
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    const o = checkRunOverrides(ctx, project, input.overrides)
    return runs.start({
      project,
      prompt: input.prompt,
      scaffold: input.scaffold,
      images: input.images,
      ...(input.team === 'single' ? { team: 'single' as const } : {}),
      ...(o.overrides ? { overrides: o.overrides, allowWidening: o.allowWidening } : {})
    })
  })
  handle(IPC.runsGet, (_e, runId: string) => runs.get(runId))
  // Chat: every field is rebuilt (quickArgs); the folder is validated in main (QuickRunService), never trusted here.
  // Overrides (socket / inproc only) are checked against the quick project the run will see, inside QuickRunService.start.
  handle(IPC.runsStartQuick, (ctx, raw: unknown): Promise<RunSummary> => {
    const input = quickArgs.start(raw)
    if (ctx.surface === 'desktop') delete input.overrides
    if (!input.overrides) return quick.start(input)
    const overrides = input.overrides
    return quick.start(input, { checkOverrides: (project) => checkRunOverrides(ctx, project, overrides).allowWidening })
  })
  handle(IPC.runsPromoteQuick, (_e, input: unknown): QuickRunPromoteResult => quick.promote(quickArgs.promote(input)))
  // Skill assistant: library scope on the virtual skills project, project scope on a stored project.
  handle(IPC.skillsStartAssist, async (_e, input: unknown): Promise<RunSummary> => {
    const target = skillAssistArgs(input, (id) => !!projects.get(id))
    const project = target.library ? skillsProject(connections.effectiveSettings(), settings.dataDir, { mock }) : projects.get(target.projectId)
    if (!project) throw new Error('Project not found')
    return runs.start({ project, kind: 'skill-assist', prompt: skillAssistPrompt(project, target.instruction) })
  })

  handle(IPC.setupStart, async (_e, input: SetupStartInput) => {
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
      hiddenContext: `${setup.hiddenContext(project)}\n\n${setup.retroContext(record, project)}`
    })
  })
  handle(
    IPC.setupDecide,
    (ctx, input: unknown): DecisionOutcome => {
      const i = proposalDecideArgs(input)
      return runs.decideProposal(i.runId, i.proposalId, i.decision, decisionOpts(ctx, i))
    }
  )
  handle(IPC.runsContinue, async (ctx, raw: unknown) => {
    const input: ContinueRunInput = continueRunArgs(raw)
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
    // Headless fields only from socket / inproc clients; overrides are checked against the project the run continues as.
    if (ctx.surface === 'desktop' || (!input.overrides && input.exec === undefined)) {
      return runs.continueRun(project, input.runId, input.text, input.images)
    }
    const o = checkRunOverrides(ctx, project, input.overrides)
    return runs.continueRun(project, input.runId, input.text, input.images, {
      ...(o.overrides ? { overrides: o.overrides } : {}),
      ...(input.exec !== undefined ? { exec: input.exec } : {}),
      allowWidening: !!ctx.grantedScopes?.includes('configure')
    })
  })
  handle(IPC.runsResumeNow, (_e, runId: string) => runs.resumeNow(runId))
  handle(IPC.runsCancelAutoResume, (_e, runId: string) => runs.cancelAutoResume(runId))
  handle(
    IPC.setupAnswer,
    (ctx, raw: unknown): DecisionOutcome => {
      const input = questionAnswerArgs(raw)
      return runs.answerQuestion(input.runId, input.questionId, input.answer, decisionOpts(ctx, input))
    }
  )
  handle(IPC.runsSend, (_e, raw: unknown) => {
    const input = runMessageArgs(raw)
    const from = runs.summary(input.runId)
    if (from) checkQuickContinue(from, input.text, settings.dataDir)
    return runs.send(input.runId, input.text, input.images)
  })
  handle(IPC.runsInterrupt, (_e, runId: string) => runs.interrupt(runId))
  handle(IPC.runsStop, (_e, runId: string) => runs.stop(runId))
  handle(IPC.runsList, (_e, projectId: string) => runs.list(projectId))
  handle(IPC.runsListLive, (): RunSummary[] => runs.liveRuns())
  handle(IPC.runsPendingCards, (_e, runId: unknown): PendingCards => {
    if (!isValidId(runId)) throw new Error('Invalid run id')
    return runs.pendingCards(runId)
  })
  handle(IPC.runsUsageStats, (_e, query: UsageStatsQuery): UsageStats => {
    const q = query && typeof query === 'object' ? query : ({} as UsageStatsQuery)
    if (!isValidId(q.projectId) || !projectOrHarness(q.projectId)) throw new Error('Project not found')
    return runs.usageStats(q)
  })
  handle(IPC.runsUsageCsv, (_e, query: UsageStatsQuery): string => {
    const q = query && typeof query === 'object' ? query : ({} as UsageStatsQuery)
    const project = isValidId(q.projectId) ? projectOrHarness(q.projectId) : null
    if (!project) throw new Error('Project not found')
    return runs.usageCsv(q, { project: project.name, client: project.client ?? '' })
  })
  registerTemplateEngagementIpc(handle, { projects, templates, dataDir: settings.dataDir, events })
  registerKnowledgeIpc(handle, { projects, dataDir: settings.dataDir, events })
  handle(IPC.windowOpenRun, (_e, input: FocusRunTarget): void => {
    const target = checkRunTarget(input, {
      project: (id) => projectOrHarness(id),
      runProject: (runId) => runs.summary(runId)?.projectId
    })
    if (!desktop) throw new HostRpcFailure('desktop_unavailable', 'Opening a run window needs the OrgAI desktop app.')
    desktop.openRunWindow(target)
  })
  handle(
    IPC.runsDecide,
    (ctx, raw: unknown): DecisionOutcome => {
      const input = permissionDecideArgs(raw)
      return runs.decide(input.runId, input.requestId, input.decision, decisionOpts(ctx, input))
    }
  )
  handle(IPC.mergesDecide, (ctx, raw: unknown): DecisionOutcome => {
    const input = mergeDecideArgs(raw)
    return runs.decideMerge(input.runId, input.reviewId, input.decision, decisionOpts(ctx, input))
  })
  // `orgai decide` lookup (socket only, scope 'read').
  handle(HOST_IPC.runsFindDecision, (_e, id: unknown): DecisionLookup => {
    if (!isValidId(id)) throw new Error('Invalid request id')
    return runs.findDecision(id)
  })

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
    // Only the AuthStatusResult fields cross IPC.
    const s = await claudeAuthStatus()
    return { loggedIn: s.loggedIn, method: s.method, detail: s.detail, mode: 'subscription' }
  })

  // settings.set() notifies SettingsStore listeners: index.ts applies the theme and broadcasts settings:changed.
  // defaultConnection is the effective default (connections.effectiveDefault()); the stored value stays main-only.
  const settingsInfo = (): AppSettingsInfo =>
    buildSettingsInfo(withEffectiveDefault(settings.get(), connections.effectiveDefault()), { dataDir: settings.dataDir, appVersion: env.app.getVersion() })
  handle(IPC.settingsGet, () => settingsInfo())
  handle(IPC.settingsSet, (_e, next: unknown) => {
    settings.set(settingsSetArgs(next, settings.get()))
    return settingsInfo()
  })
  handle(IPC.appLogPath, () => logPath())
  handle(IPC.appInfo, (): AppInfo => buildAppInfo(env.app, { platform: env.platform, logsDir: env.logsDir(), adapterIds }))
  handle(IPC.permissionsList, (_e, projectId: string) => {
    const project = projects.get(projectId)
    if (!project) throw new Error('Project not found')
    return listRules({ file: projectRulesFile(project, settings.dataDir) })
  })
  handle(IPC.permissionsIgnored, (_e, projectId: string) => {
    const project = projects.get(projectId)
    if (!project) throw new Error('Project not found')
    return listIgnoredRules({ file: projectRulesFile(project, settings.dataDir) })
  })
  handle(IPC.permissionsRemove, (_e, raw: unknown) => {
    const input = permissionRuleArgs(raw)
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    return removeRule({ file: projectRulesFile(project, settings.dataDir) }, input.rule)
  })
  handle(IPC.permissionsAdd, (_e, raw: unknown) => {
    const input = permissionRuleArgs(raw)
    const project = projects.get(input.projectId)
    if (!project) throw new Error('Project not found')
    const rule = input.rule
    const refusal = permissionAddRefusal(rule)
    if (refusal) throw new Error(refusal)
    return addRules({ file: projectRulesFile(project, settings.dataDir) }, [rule])
  })
  handle(
    IPC.permissionsDecideRequest,
    (ctx, raw: unknown): DecisionOutcome => {
      const input = ruleDecideArgs(raw)
      return runs.decideRules(input.runId, input.requestId, input.decision, decisionOpts(ctx, input))
    }
  )

  registerConnectionIpc(handle, projects, connections)
  registerMcpIpc(handle, runs, mcp, projectOrHarness, { quick, settings, effectiveSettings: () => connections.effectiveSettings(), mock })
  registerSkillIpc(handle, skills, skillEvaluation)
  registerCapabilityIpc(handle, capabilities)
  if (teamFiles) registerTeamFilesIpc(handle, teamFiles)
  if (kit) registerKitBundleIpc(handle, kit)
  registerOutputsHandlers(handle, { outputs: services.outputs, projects, events, dataDir: settings.dataDir })

  // ---- Host protocol methods the dispatcher answers (socket only; runs:subscribe / host.subscribe are transport) ----
  handle(HOST_METHODS.hostStatus, () => {
    if (!host) throw new HostRpcFailure('desktop_unavailable', 'This host does not report its status.')
    return host.status()
  })
  handle(HOST_METHODS.hostStop, (ctx, input?: unknown) => {
    if (!host) throw new HostRpcFailure('desktop_unavailable', 'This host cannot be stopped over RPC.')
    const i = input && typeof input === 'object' && !Array.isArray(input) ? (input as { force?: unknown }) : {}
    const stopping = host.stop({ force: i.force === true })
    // Over the socket, answer as soon as the drain has started: the drain ends by closing the socket server (inproc)
    // or quitting the app, so a reply sent only after it would never reach the client (it waits for daemon.json to
    // go instead). A refusal is answered as before; in-process callers still get the answer once the drain is done.
    if (ctx.surface === 'socket' && host.status().state === 'draining') {
      stopping.catch(() => undefined)
      return { stopping: true }
    }
    return stopping
  })
  return table
}

/** knowledge:* handlers: reads for any stored project (empty for code projects), writes for engagements only. */
function registerKnowledgeIpc(handle: Register, { projects, dataDir, events }: { projects: ProjectStore; dataDir: string; events: HostEventBus }): void {
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
  const changed = (projectId: string, ids?: string[]): void => events.emit(IPC.projectsEngagementChanged, { projectId, what: 'knowledge', ...(ids ? { ids } : {}) })
  handle(IPC.knowledgeGet, (_e, id: unknown): KnowledgeGraph => {
    const project = stored(knowledgeArgs.projectId(id))
    return projectKindOf(project) === 'engagement' ? readKnowledge(dataDir, project.id) : emptyKnowledgeGraph()
  })
  handle(IPC.knowledgeSaveNode, (_e, input: unknown): KnowledgeNode => {
    const { projectId, ...rest } = knowledgeArgs.saveNode(input)
    const node = saveNodeForUser(dataDir, engagement(projectId).id, rest)
    changed(projectId, [node.id])
    return node
  })
  handle(IPC.knowledgeRemoveNode, (_e, input: unknown): KnowledgeGraph => {
    const ref = knowledgeArgs.itemRef(input)
    if (!ref.nodeId) throw new Error('Entity not found')
    const project = engagement(ref.projectId)
    const before = readKnowledge(dataDir, project.id)
    const removedEdges = before.edges.filter((e) => e.from === ref.nodeId || e.to === ref.nodeId).map((e) => e.id)
    const graph = removeNode(dataDir, project.id, ref.nodeId)
    changed(project.id, [ref.nodeId, ...removedEdges])
    return graph
  })
  handle(IPC.knowledgeSaveEdge, (_e, input: unknown): KnowledgeEdge => {
    const { projectId, ...rest } = knowledgeArgs.saveEdge(input)
    const { edge } = saveEdge(dataDir, engagement(projectId).id, rest, userSource())
    changed(projectId, [edge.id])
    return edge
  })
  handle(IPC.knowledgeRemoveEdge, (_e, input: unknown): KnowledgeGraph => {
    const ref = knowledgeArgs.itemRef(input)
    if (!ref.edgeId) throw new Error('Relation not found')
    const graph = removeEdge(dataDir, engagement(ref.projectId).id, ref.edgeId)
    changed(ref.projectId, [ref.edgeId])
    return graph
  })
  handle(IPC.knowledgeClear, (_e, id: unknown): KnowledgeGraph => {
    const project = engagement(knowledgeArgs.projectId(id))
    const graph = clearKnowledge(dataDir, project.id)
    changed(project.id)
    return graph
  })
  handle(IPC.knowledgeInferredLinks, (_e, id: unknown): KnowledgeInferredResult => {
    const project = stored(knowledgeArgs.projectId(id))
    return projectKindOf(project) === 'engagement' ? readKnowledgeInferred(dataDir, project.id) : { links: [], appearances: {} }
  })
  handle(IPC.knowledgeDismissLink, (_e, input: unknown): KnowledgeInferredResult => {
    const { projectId, linkId } = knowledgeArgs.dismissLink(input)
    const result = dismissKnowledgeLink(dataDir, engagement(projectId).id, linkId)
    changed(projectId, [linkId])
    return result
  })
}

function registerTemplateEngagementIpc(handle: Register, { projects, templates, dataDir, events }: { projects: ProjectStore; templates: TemplateService; dataDir: string; events: HostEventBus }): void {
  const stored = (id: string): Project => {
    const p = projects.get(id)
    if (!p) throw new Error('Project not found')
    return p
  }
  handle(IPC.templatesList, (): OrgTemplateInfo[] => templates.list())
  handle(IPC.templatesSaveFromProject, (_e, input: unknown): OrgTemplateInfo => templates.saveFromProject(templateEngagementArgs.saveTemplate(input)))
  handle(IPC.templatesRemove, (_e, id: unknown): OrgTemplateInfo[] => templates.remove(templateEngagementArgs.templateId(id)))
  handle(IPC.templatesApply, (_e, input: unknown): AgentImportApplyResult => templates.apply(templateEngagementArgs.applyTemplate(input)))

  handle(IPC.projectsEngagementDocument, (_e, id: unknown): EngagementDocumentInfo => {
    const project = stored(templateEngagementArgs.projectId(id))
    return projectKindOf(project) === 'engagement' ? readEngagementDocumentInfo(dataDir, project.id) : { text: '' }
  })
  handle(IPC.projectsUpdateEngagementDocument, (_e, input: unknown): EngagementDocumentInfo => {
    const i = templateEngagementArgs.updateDocument(input)
    const project = stored(i.projectId)
    if (projectKindOf(project) !== 'engagement') throw new Error('Only engagements keep their document in OrgAI.')
    const info = updateEngagementDocument(dataDir, project.id, i.text, i.expectedUpdatedAt)
    events.emit(IPC.projectsEngagementChanged, { projectId: project.id, what: 'document' })
    return info
  })
  handle(IPC.projectsListNotes, (_e, id: unknown): EngagementNote[] => listNotes(dataDir, stored(templateEngagementArgs.projectId(id)).id))
  handle(IPC.projectsGetNote, (_e, input: unknown): EngagementNoteContent => {
    const ref = templateEngagementArgs.noteRef(input)
    const note = readNote(dataDir, stored(ref.projectId).id, ref.noteId)
    if (!note) throw new Error('Note not found')
    return note
  })
  handle(IPC.projectsSaveNote, (_e, input: unknown): EngagementNote => {
    const i = templateEngagementArgs.saveNote(input)
    const note = saveNote(dataDir, stored(i.projectId).id, { noteId: i.noteId, title: i.title, text: i.text, retired: i.retired, expectedUpdatedAt: i.expectedUpdatedAt })
    events.emit(IPC.projectsEngagementChanged, { projectId: i.projectId, what: 'notes', ids: [note.id] })
    return note
  })
  handle(IPC.projectsRemoveNote, (_e, input: unknown): EngagementNote[] => {
    const ref = templateEngagementArgs.noteRef(input)
    const rest = removeNote(dataDir, stored(ref.projectId).id, ref.noteId)
    events.emit(IPC.projectsEngagementChanged, { projectId: ref.projectId, what: 'notes', ids: [ref.noteId] })
    return rest
  })
}

/** Project skills, the skill library, the repo import and evaluation: the services 1:1, ids checked first. */
function registerSkillIpc(handle: Register, skills: SkillServiceApi, evaluation: SkillEvaluationApi): void {
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
  handle(IPC.skillsList, (_e, projectId: unknown): SkillInfo[] => skills.list(projectIdArg(projectId)))
  handle(IPC.skillsRead, (_e, input: unknown): SkillContent => skills.read(projectSkill(input)))
  handle(IPC.skillsCreate, (_e, input: unknown): SkillMutationResult => skills.create(withProject<SkillCreateInput>(input)))
  handle(IPC.skillsUpdate, (_e, input: unknown): SkillMutationResult => {
    const i = withProject<SkillUpdateInput>(input)
    return skills.update({ ...i, ...projectSkill(i) })
  })
  handle(IPC.skillsRemove, (_e, input: unknown): SkillMutationResult => skills.remove(projectSkill(input)))
  handle(IPC.skillsLinkLibrary, (_e, input: unknown): SkillMutationResult => {
    const i = withProject<SkillLinkLibraryInput>(input)
    return skills.linkLibrary({ ...i, ...libraryArg(i) })
  })
  handle(IPC.skillsPromote, (_e, input: unknown): SkillMutationResult => skills.promote(projectSkill(input)))
  // Import: read-only scans of the stored project's folder; the renderer supplies choices and the preview digest.
  handle(IPC.skillsPreviewImport, (_e, input: unknown): SkillImportPreview => skills.previewImport(withProject<SkillImportInput>(input)))
  handle(IPC.skillsApplyImport, (_e, input: unknown): SkillImportApplyResult => skills.applyImport(withProject<SkillImportApplyInput>(input)))
  handle(IPC.skillsUndoImport, (_e, input: unknown): SkillMutationResult => {
    const i = withProject<{ projectId: string; undoId: string }>(input)
    if (!isValidId(i.undoId)) throw new Error('Nothing to undo')
    return skills.undoImport({ projectId: i.projectId, undoId: i.undoId })
  })
  handle(IPC.skillsEvaluate, (_e, projectId: unknown): Promise<SkillEvaluationReport> => evaluation.evaluate(projectIdArg(projectId)))
  handle(IPC.skillsLastEvaluation, (_e, projectId: unknown): SkillEvaluationReport | null => evaluation.last(projectIdArg(projectId)))
  handle(IPC.skillsApplySuggestion, (_e, input: unknown): SkillMutationResult => {
    const i = withProject<SkillApplySuggestionInput>(input)
    if (!isValidId(i.suggestionId)) throw new Error('Suggestion not found')
    return applySuggestion(skills, evaluation, i)
  })
  handle(IPC.skillLibraryList, (): SkillLibraryInfo[] => skills.libraryList())
  handle(IPC.skillLibraryRead, (_e, input: unknown): SkillContent => skills.libraryRead(libraryArg(input)))
  handle(IPC.skillLibraryCreate, (_e, draft: unknown): SkillLibraryInfo[] => skills.libraryCreate(obj<SkillDraft>(draft)))
  // Socket only (cli-spec 3.6): the bytes come with the call; bundleArgs rebuilds the input, readBundle checks content.
  handle(HOST_IPC.skillLibraryAddFromBundle, (_e, input: unknown): SkillLibraryInfo[] => skills.libraryAddFromBundle(bundleArgs(input)))
  handle(IPC.skillLibraryUpdate, (_e, input: unknown): SkillLibraryInfo[] => {
    const i = obj<{ libraryId: string; draft: SkillDraft }>(input)
    return skills.libraryUpdate({ ...libraryArg(i), draft: obj<SkillDraft>(i.draft) })
  })
  handle(IPC.skillLibraryRemove, (_e, input: unknown): SkillLibraryInfo[] => skills.libraryRemove(libraryArg(input)))
}

/** The Team assistant: CapabilityServiceApi 1:1, inputs rebuilt by capabilityArgs, the harness project refused. */
function registerCapabilityIpc(handle: Register, capabilities: CapabilityServiceApi): void {
  handle(IPC.capabilitiesDiscover, (_e, input: unknown): Promise<CapabilityDiscovery> => capabilities.discover(capabilityArgs.discover(input)))
  handle(IPC.capabilitiesRecommend, (_e, input: unknown): Promise<TeamRecommendations> => capabilities.recommend(capabilityArgs.recommend(input)))
  handle(IPC.capabilitiesCancel, (_e, input: unknown): void => {
    const i = obj<{ requestId?: unknown }>(input)
    if (isValidId(i.requestId)) capabilities.cancel(i.requestId)
  })
  handle(IPC.capabilitiesApply, (_e, input: unknown): Promise<CapabilityApplyResult> => capabilities.apply(capabilityArgs.apply(input)))
  handle(IPC.capabilitiesUndo, (_e, input: unknown): CapabilityUndoResult => capabilities.undo(capabilityArgs.undo(input)))
  handle(IPC.capabilitiesReview, (_e, input: unknown): Promise<TeamReview> => capabilities.review(capabilityArgs.review(input)))
  handle(IPC.capabilitiesLastReview, (_e, projectId: unknown): TeamReview | null => capabilities.lastReview(projectIdArg(projectId)))
  handle(IPC.capabilitiesDismiss, (_e, input: unknown): TeamReview => capabilities.dismiss(capabilityArgs.dismiss(input)))
  handle(IPC.capabilitiesRestore, (_e, input: unknown): TeamReview => capabilities.restore(capabilityArgs.restore(input)))
}

/** Connections, model catalog and remaps: ConnectionService 1:1. */
function registerConnectionIpc(handle: Register, projects: ProjectStore, connections: ConnectionService): void {
  handle(IPC.connectionsSetDefault, (_e, raw: unknown): Promise<ConnectionInfo[]> => {
    if (raw !== null) connectionIdArg(raw)
    return connections.setDefault(raw as ConnectionId | null)
  })
  handle(IPC.connectionsList, (): Promise<ConnectionInfo[]> => connections.list())
  handle(IPC.connectionsUpdate, (_e, connection: ProviderConnection): Promise<ConnectionInfo> => {
    if (!connection || typeof connection !== 'object') throw new Error('Unknown connection')
    connectionIdArg(connection.id)
    return connections.update(connection)
  })
  handle(IPC.connectionsSetSecret, (_e, input: unknown): Promise<ConnectionInfo> => connections.setSecret(connectionSecretArgs(input)))
  handle(IPC.connectionsCreateProxy, (_e, input: unknown): Promise<ConnectionInfo> => connections.createProxy(proxyCreateArgs(input)))
  handle(IPC.connectionsRemoveProxy, (_e, id: unknown): Promise<ProxyRemoveResult> => connections.removeProxy(proxyIdArg(id)))
  handle(IPC.connectionsTest, (_e, id: unknown): Promise<ConnectionStatus> => connections.test(connectionIdArg(id)))
  handle(IPC.connectionsConnect, (_e, id: unknown): Promise<ConnectionInfo> => connections.connect(connectionIdArg(id)))
  handle(IPC.connectionsLogin, (_e, id: 'openai', method?: ConnectionLoginMethod): Promise<ConnectionLoginStart> =>
    connections.login(id, method === 'deviceCode' ? 'deviceCode' : 'browser')
  )
  handle(IPC.connectionsCancelLogin, (_e, loginId: string): Promise<void> => connections.cancelLogin(loginId))
  handle(IPC.connectionsLogout, (_e, id: unknown): Promise<ConnectionInfo> => connections.logout(connectionIdArg(id)))
  handle(IPC.modelsList, (_e, query?: unknown): ProviderModel[] => connections.models(modelsQueryArg(query)))
  handle(IPC.modelsRefresh, (_e, query?: unknown): Promise<ProviderModel[]> => connections.refresh(modelsQueryArg(query)))
  handle(IPC.modelsPrices, (_e, query?: ModelPricesQuery): ModelPriceInfo[] => {
    const connection = query && typeof query === 'object' ? query.connection : undefined
    if (connection !== undefined) connectionIdArg(connection)
    return connections.prices(connection ? { connection } : undefined)
  })
  handle(IPC.projectsRemapModels, (_e, input: RemapModelsInput): RemapModelsOutput => {
    if (!projects.get(input.projectId)) throw new Error('Project not found')
    return connections.remapModels(input)
  })
  handle(IPC.projectsPreviewRemap, (_e, input: RemapModelsInput): RemapResult => connections.previewRemap(input))
}

/** MCP servers, plugins, registry search and install approvals: McpService 1:1, installs and the assistant via RunManager. */
function registerMcpIpc(
  handle: Register,
  runs: RunManager,
  mcp: McpService,
  projectOrHarness: (id: string) => Project | null,
  assist: { quick: QuickRunService; settings: SettingsStore; effectiveSettings: () => AppSettings; mock: boolean }
): void {
  handle(IPC.mcpList, (_e, projectId: string): McpServerInfo[] => mcp.list(projectId))
  handle(IPC.mcpUpsert, (_e, input: McpUpsertInput): McpMutationResult => mcp.upsert(input))
  handle(IPC.mcpRemove, (_e, input: { projectId: string; serverId: string }): McpMutationResult => mcp.remove(input))
  handle(IPC.mcpSetSecret, (_e, input: unknown): McpMutationResult => mcp.setSecret(mcpSecretArgs(input)))
  handle(IPC.mcpTest, (_e, input: { projectId: string; serverId: string }): Promise<McpTestResult> => mcp.test(input))
  handle(IPC.mcpRegistrySearch, (_e, input: McpRegistrySearchInput): Promise<McpRegistrySearchResult> => mcp.registrySearch(input))
  handle(IPC.mcpAnswerInstall, (ctx, raw: unknown): DecisionOutcome => {
    const input = installAnswerArgs(raw)
    return runs.answerMcpInstall(input.runId, input.requestId, input.decision, decisionOpts(ctx, input))
  })
  // scope 'library' runs the assistant on the virtual harness project; RunManager and the harness tools treat a run
  // whose projectId is HARNESS_PROJECT_ID as library scope.
  // allowBuild (library scope only, literal true): the session works in its own scratch dir under <data>/quick, with
  // permission mode 'default' (harnessProject), and the run records it as buildWorkspace.
  handle(IPC.mcpStartAssist, async (_e, input: McpAssistInput): Promise<RunSummary> => {
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
  handle(IPC.mcpLinkLibrary, (_e, input: McpLinkLibraryInput): McpMutationResult => mcp.linkLibrary(input))
  handle(IPC.mcpPromote, (_e, input: { projectId: string; serverId: string }): McpMutationResult => mcp.promote(input))
  // Resolves when the browser flow ends (or fails, as state 'error'); client id and secret are write-only.
  handle(IPC.mcpAuthorize, (_e, input: McpAuthorizeInput): Promise<McpAuthStatus> => mcp.authorize(input))
  handle(IPC.mcpCancelAuthorize, (_e, target: McpAuthTarget): void => mcp.cancelAuthorize(target))
  handle(IPC.mcpRevokeAuth, (_e, target: McpAuthTarget): McpAuthStatus => mcp.revokeAuth(target))
  handle(IPC.mcpLibraryList, (): McpLibraryInfo[] => mcp.libraryList())
  handle(IPC.mcpLibraryUpsert, (_e, entry: McpLibraryEntry): McpLibraryInfo[] => mcp.libraryUpsert(entry))
  handle(IPC.mcpLibraryRemove, (_e, input: { libraryId: string }): McpLibraryInfo[] => mcp.libraryRemove(input))
  handle(IPC.mcpLibrarySetSecret, (_e, input: unknown): McpLibraryInfo[] => mcp.librarySetSecret(mcpLibrarySecretArgs(input)))
  handle(IPC.mcpLibraryTest, (_e, input: { libraryId: string }): Promise<McpTestResult> => mcp.libraryTest(input))
  // Connectors: the renderer names a preset (and a variant); main builds the entry from src/shared/connectors.ts.
  handle(IPC.connectorsList, (): ConnectorInfo[] => mcp.connectorsList())
  handle(IPC.connectorsAdd, (_e, input: unknown): McpLibraryInfo => mcp.connectorsAdd(connectorArgs.add(input)))
  handle(IPC.connectorsSetToken, (_e, input: unknown): McpLibraryInfo => mcp.connectorsSetToken(connectorArgs.setToken(input)))
  handle(IPC.pluginsUpsert, (_e, input: PluginUpsertInput): Project => mcp.upsertPlugin(input))
  handle(IPC.pluginsRemove, (_e, input: { projectId: string; pluginId: string }): Project => mcp.removePlugin(input))

  // ---- MCP per-project secrets and custom connector presets ----
  handle(MCP_SCOPE_IPC.mcpCopyFromLibrary, (_e, input: unknown) => mcp.copyFromLibrary(mcpCopyArgs(input)))
  handle(MCP_SCOPE_IPC.mcpSetProjectOverrides, (_e, input: unknown) => mcp.setProjectOverrides(mcpOverridesArgs(input)))
  handle(MCP_SCOPE_IPC.connectorPresetsList, () => mcp.connectorPresetsList())
  // The service validates the whole definition (validateUserPreset); the handler passes the raw structured-clone input.
  handle(MCP_SCOPE_IPC.connectorPresetsUpsert, (_e, input: unknown) => mcp.connectorPresetsUpsert(input))
  handle(MCP_SCOPE_IPC.connectorPresetsRemove, (_e, input: unknown) => mcp.connectorPresetsRemove(presetRemoveArgs(input)))
}


/**
 * kit:*Bundle (socket only, cli-spec 3.6): the kit's bytes travel with the call as base64, so no main-process file
 * dialog is involved; the inputs are rebuilt by kit/service.ts. The dialog-backed kit channels stay in ipc.ts.
 */
/**
 * Team files (src/main/teamFiles/service.ts), the reads and the first-call write. The review decisions (approve, reject,
 * undo, enable, commit) are desktop only and live in ipc.ts. No service = the channels are not served.
 */
function registerTeamFilesIpc(handle: Register, svc: TeamFilesService): void {
  handle(TEAM_FILES_IPC.teamFilesStatus, async (_e, input: unknown): Promise<TeamFilesStatus> => svc.statusWithGit(teamFilesArgs(input).projectId))
  handle(TEAM_FILES_IPC.teamFilesListAttention, async (): Promise<TeamFilesStatus[]> => Promise.all(svc.listAttention().map((s) => svc.withGit(s))))
}

function registerKitBundleIpc(handle: Register, kit: KitService): void {
  handle(HOST_IPC.kitExportBundle, (_e, input: unknown): KitBundleExportResult => kit.exportBundle(exportBundleArgs(input)))
  handle(HOST_IPC.kitPreviewBundle, (_e, input: unknown): KitImportPreview => kit.previewBundle(previewBundleArgs(input)))
  handle(HOST_IPC.kitApplyBundle, (_e, input: unknown): Promise<KitApplyResult> => kit.applyBundle(applyBundleArgs(input)))
}
