/**
 * bootOrgAIHost (cli-spec 3.1, 3.2(2) step 4, 3.2(4), Wave 1): Electron-free host construction. Every store, service,
 * adapter and background probe the app needs is built here, in the order index.ts's whenReady built them before, so the
 * same boot runs inside Electron (index.ts, the desktop shell) and, from Wave 2 on, in plain Node (`--host inproc`).
 *
 * The caller acquires <dataDir>/run ownership BEFORE calling (RunStore rewrites live runs at construction). Every
 * main -> client push goes through one HostEventBus; the desktop shell forwards it to windows. Synchronous, like the
 * old whenReady body.
 *
 * Electron-free (noElectronImport.test.ts lists it); relative imports only.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings, ConnectionId, HostKind, HostStatusResult, Project, RunEvent, RunSummary } from '../../shared/types'
import { DEFAULT_KEEP_RUNS, HARNESS_PROJECT_ID, HOST_KIND_CAPABILITIES, HOST_PROTOCOL_VERSION, IPC, OUTPUTS_IPC, QUICK_PROJECT_ID, SKILLS_PROJECT_ID, isBuiltinConnectionId, isVirtualProjectId } from '../../shared/types'
import { connectionConfigured, connectionIds } from '../../shared/defaults'
import { buildSettingsInfo } from '../appInfo'
import { CapabilityService } from '../capabilities/service'
import { seedMockHome } from '../capabilities/mockHome'
import { CommunityPrices } from '../connections/communityPrices'
import { ConnectionService } from '../connections/service'
import { authChildrenInFlight } from '../connections/anthropicAuth'
import { KitService } from '../kit/service'
import { log } from '../log'
import { MaintenanceService } from '../maintenance'
import { TeamFilesService } from '../teamFiles/service'
import { harnessProject } from '../mcp/assist'
import { McpService } from '../mcp/service'
import { QuickRunService, projectPeeks } from '../quick/quickRuns'
import { sweepScratchDirs } from '../quick/scratch'
import { ClaudeAdapter } from '../runtime/claude'
import { sweepStaleSkillDirs } from '../runtime/claudeSkills'
import { CodexAdapter } from '../runtime/codex'
import { MockAdapter } from '../runtime/mock'
import { repoLockActivity } from '../runtime/repoLock'
import { RunManager, outputScopeOf } from '../runtime/runManager'
import { controlProtectedPaths } from '../runtime/selfControlGate'
import { cliUserDataDir, platformUserDataDir } from '../../cli/client/locate'
import type { RunConnection, RuntimeAdapter } from '../runtime/types'
import { AgentImportService } from '../setup/import/importer'
import { SetupService } from '../setup/service'
import { TemplateService } from '../setup/templates'
import { skillsProject } from '../skills/assist'
import { SkillEvaluationService } from '../skills/evaluation'
import { SkillService } from '../skills/service'
import { knowledgeStore } from '../store/knowledge'
import { createOutputsService } from '../outputs/service'
import { createOutputWatcher } from '../outputs/watch'
import { McpLibraryStore } from '../store/mcpLibrary'
import { listNotes, orphanRunProjects, readNote, readRetainedRunProjects, saveNote } from '../store/projectData'
import { ProjectStore } from '../store/projects'
import { RunStore } from '../store/runs'
import { SecretStore, type SecretCipher, type SecretStoreOptions } from '../store/secrets'
import { SettingsStore } from '../store/settings'
import { UsageMonitor } from '../usageMonitor'
import { HostActivityTracker, daemonIdleMs } from './activity'
import { createAppReference, type ShortcutRow } from '../reference/appReference'
import { withAppSettingChanges } from '../../shared/appSettingsProposal'
import type { AppSettingsProposalPayload, CliShimStatus } from '../../shared/types'
import { harnessProjectFor, settingsSetArgs, withEffectiveDefault } from './args'
import { HostDispatcher } from './dispatcher'
import { HostEventBus } from './events'
import type { HostOwnership } from './ownership'
import type { HostRuntimeEnv } from './runtimeEnv'
import { ShutdownCoordinator, type ShutdownReleaseInfo } from './shutdown'
import type { DesktopHooks, HostControl, HostServices } from './types'

/** How long after a proxy run ends its key's spend is re-read (the proxy batches spend writes, ~10 s by default). */
export const LITELLM_SPEND_DELAY_MS = 15_000

/** What a housekeeping step sees. */
export interface HousekeepingContext {
  dataDir: string
  runStore: RunStore
  keepRunsFor: (projectId: string) => number
  /** Stored project ids plus the virtual ones (harness, quick, skills): their runs survive restarts. */
  knownProjects: ReadonlySet<string>
}

/** The boot housekeeping, in the order it runs. Injectable for tests (BootOrgAIHostOptions.housekeeping). */
export interface HousekeepingSteps {
  /** Project ids whose runs are dropped: neither a known project nor retained (projectData.ts). */
  orphanRunProjects(ctx: HousekeepingContext): string[]
  removeProject(ctx: HousekeepingContext, projectId: string): number
  prune(ctx: HousekeepingContext): number
  sweepOrphans(ctx: HousekeepingContext): number
  /** Scratch dirs (Chat without a folder, MCP build workspaces) no remaining run record points to. */
  sweepScratchDirs(ctx: HousekeepingContext): number
  sweepStaleSkillDirs(ctx: HousekeepingContext): void
}

export const defaultHousekeeping: HousekeepingSteps = {
  orphanRunProjects: (ctx) => orphanRunProjects(ctx.runStore.allProjectIds(), ctx.knownProjects, readRetainedRunProjects(ctx.dataDir)),
  removeProject: (ctx, projectId) => ctx.runStore.removeProject(projectId),
  prune: (ctx) => ctx.runStore.prune(ctx.keepRunsFor),
  sweepOrphans: (ctx) => ctx.runStore.sweepOrphans(),
  sweepScratchDirs: (ctx) => sweepScratchDirs(ctx.dataDir, ctx.runStore.all()),
  sweepStaleSkillDirs: () => {
    sweepStaleSkillDirs()
  }
}

/**
 * Which background work a boot starts (Wave 7, cli-standalone.md 4.1 step 4). Each flag defaults to
 * `BootOrgAIHostOptions.startBackground !== false`. A management command's in-process host keeps connection status
 * probes on and turns off model discovery, community prices and the usage monitor.
 */
export interface HostBackgroundOptions {
  /** connections.init(): probe each enabled connection's status at boot. */
  connectionProbes?: boolean
  /** connections.startDiscovery(): model discovery (first run 20 s after boot, then hourly). */
  modelDiscovery?: boolean
  /** communityPrices.start() (never under mock). */
  communityPrices?: boolean
  /** usageMonitor.start(): plan usage at boot and every 10 minutes while idle. */
  usageMonitor?: boolean
}

export interface BootOrgAIHostOptions {
  env: HostRuntimeEnv
  /** `<userDataDir>/data`. */
  dataDir: string
  hostKind: HostKind
  /** Acquired by the entry point before boot (acquireHostOwnership). */
  ownership: Pick<HostOwnership, 'info' | 'markReady' | 'markDraining' | 'release' | 'runtimeDir'>
  /** Electron's safeStorage in the desktop shell; anything SecretCipher-shaped elsewhere. */
  safeStorage: SecretCipher
  /** SecretStore options: `--host inproc` passes { readOnly: true, overlay } (cli-spec 3.5). Default: read-write. */
  secrets?: SecretStoreOptions
  /**
   * Wave 7 (cli-standalone.md 5.6): the store openSecretStore opened (and reconciled) after acquireHostOwnership and
   * before this boot. When given, `safeStorage` and `secrets` are not used to build one.
   */
  secretStore?: SecretStore
  openExternal(url: string): Promise<void> | void
  desktop?: DesktopHooks
  /** Shortcut rows for the reference corpus (the shell maps shared/view SHORTCUTS to this; main never imports renderer code). */
  referenceShortcuts?: readonly ShortcutRow[]
  /** The command line shim state for the reference status snapshot (desktop shell only). */
  cliShimStatus?: () => CliShimStatus | Promise<CliShimStatus>
  /** ORGAI_MOCK === '1': registers the scripted mock adapter and keeps discovery off the real home. */
  mock: boolean
  platform?: NodeJS.Platform
  homeDir?: string
  processEnv?: NodeJS.ProcessEnv
  /** connections.init / startDiscovery, communityPrices.start (not under mock), usageMonitor.start. Default true. */
  startBackground?: boolean
  /** Per-kind overrides of startBackground (Wave 7). */
  background?: HostBackgroundOptions
  housekeeping?: Partial<HousekeepingSteps>
  /**
   * Called once a shutdown released ownership (Wave 7, cli-standalone.md 4.3: after the writers settled and the socket
   * closed, or at the hard limit): the process may exit now. Desktop: quit the app; inproc: resolve `closed`; Node host:
   * exit the process.
   */
  onDrained?: (info: ShutdownReleaseInfo) => void
  /**
   * The socket server's graceful close (HostSocketServer.closeGracefully), run by the shutdown before the release so the
   * host.stop reply is flushed. Absent = no socket to close here.
   */
  closeSocket?: (graceMs: number) => Promise<void>
  /**
   * The shutdown's hard limit (4.3): once the host's descendants are gone, end the process (its exit hook releases
   * ownership), so no writer of this host can run after the data folder is given up. Every real entry point passes one
   * (desktop: process.exit; inproc and Node hosts: startInprocHost's, which tells the terminal and exits);
   * absent (tests) = release, then onDrained.
   */
  exitAtHardLimit?: () => void
  /**
   * Processes the hard limit never kills, with their subtrees (the desktop: Electron's own GPU, renderer and utility
   * helpers from app.getAppMetrics, which Chromium would relaunch as fast as they die). Absent = none.
   */
  shutdownExcludePids?: () => number[]
  /** The shutdown's hard limit and its tree-kill waits; production uses the defaults (tests shorten them). */
  shutdownLimits?: { hardLimitMs?: number; kill?: { termGraceMs?: number; waitMs?: number; stepMs?: number } }
  /** Authenticated terminal sessions (HostSocketServer.terminalSessionCount), for the host.status counts. Absent = 0. */
  terminalSessions?: () => number
  /**
   * More background work the drain stops at once (after the host's own: Team assistant, OAuth flows, skill evaluation),
   * e.g. the desktop's repository clones. A throw is logged.
   */
  quiesce?: () => void
}

export interface OrgAIHost {
  services: HostServices
  events: HostEventBus
  dispatcher: HostDispatcher
  activity: HostActivityTracker
  runs: RunManager
  settings: SettingsStore
  /** A stored project, or the display project of a virtual id (harness, quick, skills). */
  projectOrHarness(projectId: string): Project | null | undefined
  hostControl: HostControl
  /**
   * The one shutdown sequence (Wave 7, cli-standalone.md 4.3): host.stop, idle exit and every entry point's exit path
   * (desktop Quit, signals, inproc cleanup) go through it; ownership is released only after the writers settled.
   */
  shutdown: ShutdownCoordinator
  /** Stop background timers and probes (before-quit). Idempotent. */
  dispose(): void
}

/**
 * An approved appSettings proposal, applied exactly like settings:set (dispatcher): the changes merge onto the stored
 * settings, settingsSetArgs keeps every main-owned field, SettingsStore.set normalizes and notifies its listeners
 * (theme, settings:changed). Throws a readable sentence on a refused value; nothing is saved then. Exported for tests.
 */
export function applyAppSettingsPayload(settings: Pick<SettingsStore, 'get' | 'set'>, payload: AppSettingsProposalPayload): void {
  const stored = settings.get()
  settings.set(settingsSetArgs(withAppSettingChanges(stored, payload.changes), stored))
}

/** The other product's default data folder: the CLI's for the app, the app's for the CLI (the gate protects its control files). */
function otherProductDataDir(hostKind: HostKind): string {
  const dir = hostKind === 'desktop' ? cliUserDataDir : platformUserDataDir
  return join(dir(process.platform, process.env, homedir()), 'data')
}

export function bootOrgAIHost(opts: BootOrgAIHostOptions): OrgAIHost {
  const { env, dataDir, hostKind, ownership } = opts
  const platform = opts.platform ?? process.platform
  const processEnv = opts.processEnv ?? process.env
  const mockAdapter = opts.mock
  const openExternal = async (url: string): Promise<void> => {
    await opts.openExternal(url)
  }
  const events = new HostEventBus()
  const emitRun = (event: RunEvent): void => events.emit(IPC.runEvent, event)
  const emitProject = (project: Project): void => emitRun({ type: 'project.updated', runId: '', project })

  const projects = new ProjectStore(dataDir)
  const settings = new SettingsStore(dataDir)

  /** The effective default connection; set once the connection service exists. */
  let effectiveDefaultOf: (() => ConnectionId) | undefined
  /** The defaultConnection last sent with settings:changed, so a moved effective default is re-broadcast once. */
  let lastBroadcastDefault: ConnectionId | undefined
  /** settings:changed carries the effective default (withEffectiveDefault), never the stored value. */
  const broadcastSettings = (s: AppSettings): void => {
    const effective = effectiveDefaultOf?.() ?? s.defaultConnection
    lastBroadcastDefault = effective
    events.emit(IPC.settingsChanged, buildSettingsInfo(withEffectiveDefault(s, effective), { dataDir: settings.dataDir, appVersion: env.appVersion }))
  }
  settings.onChange(broadcastSettings)

  const runStore = new RunStore(dataDir)
  const secrets = opts.secretStore ?? new SecretStore(dataDir, opts.safeStorage, opts.secrets)
  // Socket access is fixed by the host kind (no setting): only the orgai process's in-process host answers a socket, and
  // only its own process through the owner proof (every scope); the desktop opens no socket at all.
  // `adapters` is declared below and only read when discovery runs.
  let adapters: { claude: ClaudeAdapter; codex: CodexAdapter; mock?: MockAdapter }
  const connections = new ConnectionService({
    dataDir,
    settings,
    projects,
    secrets,
    broadcast: (event) => events.emit(IPC.connectionsEvent, event),
    logInfo: (m) => log.info(m),
    // The effective default moved without a settings write (e.g. chosen mode, a removed key): re-broadcast once.
    onDefaultChanged: () => {
      if (effectiveDefaultOf && effectiveDefaultOf() !== lastBroadcastDefault) broadcastSettings(settings.get())
    },
    openExternal,
    // Models the Claude login offers (SDK supportedModels); the scripted mock answers its own list.
    anthropicModels: (auth) => {
      const adapter: RuntimeAdapter | undefined = mockAdapter ? adapters.mock : adapters.claude
      return adapter?.listModels?.(auth) ?? Promise.resolve(null)
    }
  })
  effectiveDefaultOf = () => connections.effectiveDefault()
  lastBroadcastDefault = connections.effectiveDefault()
  // Community model prices (LiteLLM's public list): a cached fallback after the builtin table; AppSettings.communityPrices turns it off.
  const communityPrices = new CommunityPrices({ dataDir, enabled: () => settings.get().communityPrices !== false })
  /** The virtual project of harness-level runs (library MCP assistant), from the current settings. */
  const harness = (): Project => harnessProject(connections.effectiveSettings(), dataDir, { mock: mockAdapter })
  // Set once RunManager exists (below); only read when a run or a window asks for a project.
  let quickRuns: QuickRunService | undefined
  let skillEvaluationService: SkillEvaluationService | undefined
  const projectOrHarness = (projectId: string): Project | null | undefined =>
    projectId === HARNESS_PROJECT_ID ? harness()
    : projectId === QUICK_PROJECT_ID ? quickRuns?.displayProject()
    : projectId === SKILLS_PROJECT_ID ? skillsProject(connections.effectiveSettings(), dataDir, { mock: mockAdapter })
    : projects.get(projectId)
  const mcp = new McpService({
    projects,
    secrets,
    library: new McpLibraryStore(dataDir),
    dataDir,
    openExternal,
    // ORGAI_MOCK=1 only: connector entries authorize and test without network (walkthroughs, e2e).
    mock: mockAdapter,
    onLibraryChanged: (entries) => events.emit(IPC.mcpLibraryChanged, entries),
    // Library changes that save a project (unlink on remove, promote) reach every client like a run's project update.
    onProjectChanged: emitProject,
    // `orgai mcp auth` (announceUrl): the authorization URL reaches 'connections' subscribers (cli-spec 6.3(5)).
    onAuthorizeUrl: (u) => events.emit(IPC.connectionsEvent, { type: 'mcp.authorize', authorize: u }),
    // Wave 7 (round 6 item 9): only an authorization's final commit holds a mutation lease. `activityRef` is set below,
    // before any call can arrive.
    commitLease: (label) => (activityRef ? activityRef.acquire('inFlightRpcMutations', label) : () => {})
  })
  const skills = new SkillService({
    dataDir,
    projects,
    onLibraryChanged: (entries) => events.emit(IPC.skillLibraryChanged, entries),
    onProjectChanged: emitProject
  })
  // Team files: a code project's team as plain files under .orgai/ (the project cache stays what runs read). Every
  // ProjectStore.save passes through its hook; the folders are checked at boot (index.ts), on window focus and at project open / run start.
  const teamFiles = new TeamFilesService({
    dataDir,
    projects,
    modelContext: (id) => connections.importModelContext(id),
    withAdapter: (project) => connections.withAdapter(project),
    skills: {
      readFiles: (projectId, spec) => skills.teamReadFiles(projectId, spec),
      storeFiles: (projectId, skillId, files) => skills.teamStoreFiles(projectId, skillId, files),
      removeFiles: (projectId, skillId) => skills.teamRemoveFiles(projectId, skillId)
    },
    mcp: {
      libraryEntries: () => mcp.libraryEntries(),
      connectorEntry: (connectorId, variant) => mcp.connectorEntryForTeam(connectorId, variant),
      connectorPreview: (connectorId, variant) => mcp.connectorPreviewForTeam(connectorId, variant),
      discardConnectorEntry: (entryId) => mcp.discardConnectorEntryForTeam(entryId),
      removeServerSecrets: (projectId, serverId) => mcp.removeServerSecrets(projectId, serverId)
    },
    // teamFiles:changed is desktop_only delivery (registry PUSH_TABLE): it never goes on the bus a socket client can subscribe to.
    broadcastStatus: (status) => opts.desktop?.teamFilesChanged?.(status),
    broadcastProject: emitProject,
    warn: (m) => log.warn(`Team files: ${m}`)
  })
  projects.setTeamFilesHook(teamFiles)
  const templates = new TemplateService({
    dataDir,
    projects,
    modelContext: (id) => connections.importModelContext(id),
    withAdapter: (project) => connections.withAdapter(project),
    onProjectChanged: emitProject
  })
  const setup = new SetupService(projects, {
    dataDir,
    removeMcpSecrets: (projectId, serverId) => mcp.removeServerSecrets(projectId, serverId),
    mcp: {
      libraryEntries: () => mcp.libraryEntries(),
      applyProposal: (projectId, payload, o) => mcp.applyProposal(projectId, payload, o),
      applyLibraryProposal: (payload, o) => mcp.applyLibraryProposal(payload, o)
    },
    skills: { applyProposal: (projectId, payload, o) => skills.applyProposal(projectId, payload, o) },
    templates: () => templates.list()
  })
  const keepRunsFor = (projectId: string): number => projects.get(projectId)?.keepRuns ?? DEFAULT_KEEP_RUNS
  // complete() (org chart drafts) has no project: use the enabled Codex-capable connection, OpenAI first.
  const codexCompletion = (): RunConnection | undefined => {
    const s = settings.get()
    // OpenAI first, then the first enabled proxy that has a base URL and a stored key.
    const proxy = (s.proxies ?? []).find((p) => p.enabled && p.hasApiKey && (p.openaiBaseUrl?.trim() || p.anthropicBaseUrl?.trim()))
    const connection: ConnectionId | undefined = s.connections.openai.enabled ? 'openai' : proxy?.id
    if (!connection) return undefined
    try {
      return connections.runConnection(undefined, { adapter: 'codex', connection, mismatched: [] })
    } catch (e) {
      console.warn(`Codex completion connection unavailable: ${(e as Error).message}`)
      return undefined
    }
  }
  // The scripted mock adapter (no tokens) is opt-in; a project uses it only when its provider.id is "mock".
  adapters = {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter({ completionConnection: codexCompletion }),
    ...(mockAdapter ? { mock: new MockAdapter() } : {})
  }
  // A proxy run that ends changed the key's spend: re-read it once the proxy has written it (it batches spend
  // writes); each end restarts the one timer, so the last run's spend is read. Set once the usage monitor exists.
  let refreshProxySpend: (() => void) | undefined
  let spendTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  // Set once RunManager exists; work-run ends feed the proactive Team review (never setup-like or harness runs).
  let capabilities: CapabilityService | undefined
  let runManager: RunManager | undefined
  const runBroadcast = (event: RunEvent): void => {
    emitRun(event)
    if (event.type !== 'run.status' || !['finished', 'error', 'paused'].includes(event.status)) return
    if (event.status !== 'paused') {
      const summary = runManager?.summaryOf(event.runId)
      if (summary?.kind === 'work' && !isVirtualProjectId(summary.projectId)) capabilities?.runEnded(summary.projectId, event.runId)
    }
    const endedOn = runManager?.summaryOf(event.runId)?.connection
    if (endedOn === undefined || isBuiltinConnectionId(endedOn)) return
    if (disposed) return
    clearTimeout(spendTimer)
    spendTimer = setTimeout(() => {
      spendTimer = undefined
      refreshProxySpend?.()
    }, LITELLM_SPEND_DELAY_MS)
  }
  let activityRef: HostActivityTracker | undefined
  /** Set once the dispatcher exists (below); the drain's quiesce aborts its model calls (draft:orgChart). */
  let dispatcherRef: HostDispatcher | undefined
  // Self-knowledge: OrgAI answers about itself (reference service, built lazily on first query) and can configure itself.
  const reference = createAppReference({
    shortcuts: opts.referenceShortcuts,
    status: {
      appVersion: env.appVersion,
      platform,
      dataDir,
      mock: mockAdapter,
      hostKind,
      settings: () => settings.get(),
      connections: () => connections.list(),
      projectCount: () => projects.list().length,
      mcpLibraryCount: () => mcp.libraryEntries().length,
      skillLibraryCount: () => skills.libraryList().length,
      ...(opts.cliShimStatus ? { cliShim: opts.cliShimStatus } : {})
    }
  })
  // Run outputs (types.ts "Run outputs"): one service for the harness tools (RunManager) and the outputs:* channels.
  // The OS trash only on the desktop (Electron shell.trashItem); every other host deletes for good. The service raises
  // outputs:changed itself for the versions the watcher captures and the revision ends it settles.
  const outputs = createOutputsService(dataDir, {
    ...(opts.desktop?.trashItem ? { trash: opts.desktop.trashItem } : {}),
    onChange: (projectId, ids, what) => events.emit(OUTPUTS_IPC.outputsChanged, { projectId, ids, what })
  })
  const outputWatcher = createOutputWatcher({
    service: outputs,
    scopeOf: (projectId) => {
      const p = projects.get(projectId)
      return p ? outputScopeOf(p, dataDir) : null
    },
    emit: (event) => events.emit(OUTPUTS_IPC.outputsChanged, event)
  })
  const rm = new RunManager(adapters, runBroadcast, runStore, setup, keepRunsFor, {
    dataDir,
    selfKnowledge: {
      reference: (q, o) => reference.query(q, o),
      navigate: (e) => opts.desktop?.navigate?.(e) ?? false,
      settings: () => settings.get(),
      // As settings:set (dispatcher): merge onto the stored settings through settingsSetArgs; SettingsStore.set
      // normalizes and notifies its listeners (theme, settings:changed with the effective default).
      applyAppSettings: (payload) => applyAppSettingsPayload(settings, payload)
    },
    teamFiles,
    // cli-spec 3.4(1): the control socket dir, daemon secret, secrets.json and CODEX_HOME are off limits to agent tools.
    // Wave 7: plus the vault's key file, re-read per call (the vault may change; cli-standalone.md 8.4).
    controlProtectedPaths: () => controlProtectedPaths(dataDir, ownership.runtimeDir, { vaultKeyFiles: secrets.vaultKeyFiles(), otherProductDataDirs: [otherProductDataDir(hostKind)] }),
    // cli-spec 6.2(1) humanGraceMs: open windows (index.ts source) plus TUI / interactive sockets (socketServer's
    // attachedClientCount, which leaves non-interactive CLI exec sockets out). `activity` is created further down;
    // before that (never during a run) there is nobody to count.
    noWaitPolicy: hostKind === 'inproc',
    interactiveClients: () => (activityRef ? activityRef.snapshot().counts.interactiveClients : 0),
    // "Always allow for project" cards: append folders / switch to Accept edits on the stored project (the store cleans them).
    saveProjectPermissions: (projectId, patch) =>
      projects.update(projectId, (p) => ({
        ...p,
        ...(patch.addDirectories?.length ? { allowedDirectories: [...(p.allowedDirectories ?? []), ...patch.addDirectories] } : {}),
        // Re-checked on the stored copy: the user may have changed the mode since the run started.
        ...(patch.acceptEdits && p.permissionMode === 'default' ? { permissionMode: 'acceptEdits' as const } : {})
      })),
    resolveProject: (projectId) => projectOrHarness(projectId),
    // Context notes for engagement_context (agent saves carry the run and role as the writer); the knowledge graph for
    // engagement_knowledge; both agent write paths push projects:engagementChanged. propose_org_chart fromTemplate.
    engagementNotes: {
      list: (projectId) => listNotes(dataDir, projectId),
      read: (projectId, noteId) => readNote(dataDir, projectId, noteId),
      save: (projectId, input, writer) => saveNote(dataDir, projectId, input, writer)
    },
    knowledge: knowledgeStore(dataDir),
    engagementChanged: (event) => events.emit(IPC.projectsEngagementChanged, event),
    outputs,
    outputsChanged: (event) => events.emit(OUTPUTS_IPC.outputsChanged, event),
    orgTemplate: (templateId, project) => templates.forRun(templateId, project),
    // An auto-resumed build session gets its checked workspace back; a vanished one throws (resumeNow reports it).
    buildProject: (summary) => harnessProjectFor(summary, connections.effectiveSettings(), dataDir, mockAdapter),
    opusGuardThreshold: () => settings.get().opusGuardThreshold,
    catalog: () => connections.catalog(),
    appSettings: () => settings.get(),
    communityPrices: () => communityPrices.get(),
    resolveConnection: (project, choice) => connections.runConnection(project, choice),
    // Bridged reports (multi-provider org charts): a role on another connection runs on its own RunConnection.
    resolveRoleConnection: (project, target) => connections.runConnectionFor(project, target),
    // Architect drafts may name any configured connection; their tiers map through that connection's own mapping.
    connectionModels: () => {
      const s = settings.get()
      return connectionIds(s)
        .filter((id) => connectionConfigured(id, s))
        .map((id) => {
          const c = connections.importModelContext(id)
          return { connection: id, name: c.connectionName, tierModels: c.tierModels, models: c.catalog.map((m) => m.id) }
        })
    },
    fastModel: (_project, choice) => connections.fastModel(choice),
    mcp: {
      enabledServers: (project) => mcp.enabledServers(project),
      resolve: (projectId, spec, extra) => mcp.resolve(projectId, spec, extra),
      persistInstall: (projectId, spec, values, scope) => mcp.persistInstall(projectId, spec, values, scope),
      withLibrary: (project) => mcp.withLibrary(project),
      prepareForRun: (projectId, specs) => mcp.prepareForRun(projectId, specs),
      skippedServers: (project) => mcp.skippedServers(project),
      libraryEntries: () => mcp.libraryEntries(),
      storeProposalSecrets: (projectId, payload, values) => mcp.storeProposalSecrets(projectId, payload, values),
      searchRegistry: (input) => mcp.registrySearch(input)
    },
    skills,
    // Chat: a continued or resumed quick run rebuilds its project from summary.quick.
    quickProject: (summary) => quickRuns?.projectFor(summary),
    // list_projects (quick runs only): stored projects with their newest run; never virtual ids, never secrets.
    listProjects: () => projectPeeks(projects.list(), (projectId) => runStore.list(projectId)[0]),
    // Skill assistant: the library plus (in a project session) the project's skills; reads never throw.
    skillAssist: {
      catalog: (projectId) => {
        try {
          return {
            library: skills.libraryList(),
            project: projectId ? skills.list(projectId) : [],
            ...(projectId ? { evaluation: skillEvaluationService?.last(projectId) ?? null } : {})
          }
        } catch (e) {
          console.warn(`Skill catalog unavailable: ${(e as Error).message}`)
          return { library: [], project: [] }
        }
      },
      read: (projectId, ref) => {
        try {
          if (typeof ref?.libraryId === 'string') return skills.libraryRead({ libraryId: ref.libraryId })
          if (typeof ref?.skillId === 'string' && projectId) return skills.read({ projectId, skillId: ref.skillId })
        } catch {
          /* unknown id: the tool reports it */
        }
        return null
      }
    }
  })
  runManager = rm
  const quick = new QuickRunService({
    dataDir,
    settings: () => connections.effectiveSettings(),
    runs: rm,
    store: runStore,
    projects,
    prepare: (p) => connections.prepareNewProject(p),
    broadcast: emitRun,
    mock: mockAdapter
  })
  quickRuns = quick
  // A pruned or deleted quick run takes its scratch dir with it when no other run uses it.
  runStore.onRunsRemoved = (removed: RunSummary[]) => quick.runsRemoved(removed)
  const skillEvaluation = new SkillEvaluationService({
    dataDir,
    project: (projectId) => projects.get(projectId),
    listRuns: (projectId) => rm.list(projectId),
    getRun: (runId) => rm.get(runId),
    skills,
    complete: (project, input) => rm.completeForProject(project, input)
  })
  skillEvaluationService = skillEvaluation
  if (mockAdapter) seedMockHome(join(dataDir, 'mock-home'))
  const caps = new CapabilityService({
    projects,
    skills,
    mcp,
    dataDir,
    complete: (project, input) => rm.completeForProject(project, input),
    listRuns: (projectId) => rm.list(projectId),
    getRun: (runId) => rm.get(runId),
    progress: (event) => events.emit(IPC.capabilitiesProgress, event),
    reviewUpdated: (summary) => events.emit(IPC.capabilitiesReviewUpdated, summary),
    onProjectChanged: emitProject,
    // ORGAI_MOCK=1 only: local discovery reads seeded fixtures under the data dir, never the real home.
    homeDir: mockAdapter ? join(dataDir, 'mock-home') : (opts.homeDir ?? homedir()),
    env: mockAdapter ? {} : processEnv,
    platform,
    mock: mockAdapter
  })
  capabilities = caps
  const maintenance = new MaintenanceService(projects, teamFiles)
  const importer = new AgentImportService({
    projects,
    modelContext: (id) => connections.importModelContext(id),
    withAdapter: (project) => connections.withAdapter(project),
    onProjectChanged: emitProject
  })
  const kit = new KitService({ appVersion: env.appVersion, platform, skills, mcp, templates })

  const startBackground = opts.startBackground !== false
  const background: Required<HostBackgroundOptions> = {
    connectionProbes: opts.background?.connectionProbes ?? startBackground,
    modelDiscovery: opts.background?.modelDiscovery ?? startBackground,
    communityPrices: opts.background?.communityPrices ?? startBackground,
    usageMonitor: opts.background?.usageMonitor ?? startBackground
  }
  if (background.connectionProbes) connections.init()
  if (background.modelDiscovery) connections.startDiscovery()
  if (background.communityPrices && !mockAdapter) communityPrices.start()

  // Plan usage without a run: at boot, every 10 minutes while idle, and on request from the meter.
  const monitor = new UsageMonitor({
    adapter: adapters.claude,
    auth: () => settings.get().providerAuth,
    broadcast: emitRun,
    liveRuns: () => rm.liveRunCount(),
    extraProbes: [() => connections.probeCodexUsage(), { key: 'proxies', probe: () => connections.probeProxyUsages() }]
  })
  // Every usage.status a run or probe sends is merged onto the monitor's newest Claude status.
  const unobserve = events.on((channel, payload) => {
    if (channel === IPC.runEvent) monitor.observe(payload as RunEvent)
  })
  refreshProxySpend = () => void monitor.refreshProbe('proxies')
  if (background.usageMonitor) monitor.start()

  // Housekeeping: runs of projects that no longer exist, runs past retention, record files nobody indexes.
  // The virtual projects (harness, quick, skills) own runs without being stored: their runs survive restarts.
  const steps: HousekeepingSteps = { ...defaultHousekeeping, ...opts.housekeeping }
  const ctx: HousekeepingContext = {
    dataDir,
    runStore,
    keepRunsFor,
    knownProjects: new Set([...projects.list().map((p) => p.id), HARNESS_PROJECT_ID, QUICK_PROJECT_ID, SKILLS_PROJECT_ID])
  }
  let dropped = 0
  for (const projectId of steps.orphanRunProjects(ctx)) dropped += steps.removeProject(ctx, projectId)
  dropped += steps.prune(ctx)
  dropped += steps.sweepOrphans(ctx)
  dropped += steps.sweepScratchDirs(ctx)
  steps.sweepStaleSkillDirs(ctx)
  if (dropped) console.log(`Housekeeping removed ${dropped} stale run(s) or record file(s).`)

  // Wave 7 (cli-standalone.md 4.3): the one shutdown sequence. The activity tracker drains and settles the writers; the
  // coordinator closes the socket, releases ownership (never before the writers are done), ends the process through
  // onDrained, and at SHUTDOWN_HARD_LIMIT_MS kills this process's descendants and exits.
  const shutdown = new ShutdownCoordinator({
    release: () => ownership.release(),
    ...(opts.closeSocket ? { closeSocket: opts.closeSocket } : {}),
    handoffFacts: () => ({ ...rm.handoffFacts(), terminalSessions: opts.terminalSessions?.() ?? 0 }),
    ...(opts.onDrained ? { onReleased: opts.onDrained } : {}),
    ...(opts.exitAtHardLimit ? { exitAtHardLimit: opts.exitAtHardLimit } : {}),
    ...(opts.shutdownExcludePids ? { excludePids: opts.shutdownExcludePids } : {}),
    ...(opts.shutdownLimits?.hardLimitMs !== undefined ? { hardLimitMs: opts.shutdownLimits.hardLimitMs } : {}),
    ...(opts.shutdownLimits?.kill ? { killTiming: opts.shutdownLimits.kill } : {}),
    log: (m) => log.info(m)
  })
  // cli-spec 3.2(4): what keeps the host from going idle and how it drains.
  const activity = new HostActivityTracker({
    ownership,
    idleMs: daemonIdleMs(processEnv),
    ...shutdown.activityHooks(),
    // A draining host starts no background work and abandons what waits on a user or a model (round 6 item 9): no
    // Team review (every run forceStop ends would arm one), no OAuth flow, no skill evaluation model step, no org chart
    // draft, plus the entry point's own (the desktop's repository clones).
    quiesce: () => {
      caps.dispose()
      mcp.dispose()
      skillEvaluation.dispose()
      // `claude auth status` children have their cwd in the data folder: end them; the drain waits for their exit
      // (the tracker's settleOnly, never counted toward a stop refusal) before ownership is released and the folder can be removed.
      connections.abortProbes()
      // An org chart draft's model call (no timeout of its own) would hold its mutation lease until the hard limit.
      dispatcherRef?.quiesce()
      if (opts.quiesce) {
        try {
          opts.quiesce()
        } catch (e) {
          log.warn(`Quiescing the entry point's background work failed: ${(e as Error)?.message ?? String(e)}`)
        }
      }
    },
    forceStop: () => rm.stopAll({ reason: 'quit' }),
    // Every live run, waiting ones included: a non-forced drain ends those too, as cut
    // by the app ("Ended when OrgAI closed", continuable), before the writers settle and ownership is released.
    liveRuns: () => rm.liveRunCount(),
    // Auth probe children (abortProbes at quiesce) are awaited in the settle phase only: never a stop refusal.
    settleOnly: () => authChildrenInFlight(),
    // Past the deadline (or on a throw) write every live run as cut by the app now (RunManager.markQuit).
    forceStopFallback: () => rm.markQuit(),
    log: (m) => log.info(m)
  })
  activityRef = activity
  shutdown.attachActivity(activity)
  // Wave 7 (cli-standalone.md 4.3): background vault work (creation, reconciliation, write-back) holds a lease.
  secrets.attachLeases((label) => activity.acquire('backgroundTasks', label))
  // Runs that only wait on the user (idle, a card open, held) do not keep a host busy (review H3; runActivity.ts).
  activity.addSource('liveRuns', () => rm.busyRunCount())
  activity.addSource('pausedAutoResumes', () => rm.activeResumeTimerCount() + rm.inFlightResumeCount())
  activity.addSource('activeWorktreeOps', () => repoLockActivity())
  activity.addSource('backgroundTasks', () => rm.titleTaskCount() + caps.inFlightCount() + skillEvaluation.inFlightCount())
  activity.addSource('activeOAuthFlows', () => mcp.activeAuthorizationCount() + connections.pendingLoginCount())

  const hostControl: HostControl = {
    status: (): HostStatusResult => ({
      protocolVersion: HOST_PROTOCOL_VERSION,
      hostInstanceId: ownership.info.hostInstanceId,
      hostKind,
      state: activity.state(),
      appVersion: env.appVersion,
      dataDir,
      mock: mockAdapter,
      pid: ownership.info.pid,
      startedAt: ownership.info.startedAt,
      activity: activity.snapshot(),
      // The run counts the TUI's quit confirm shows (host.status).
      ...((): { handoff?: HostStatusResult['handoff'] } => {
        const facts = shutdown.handoffFacts()
        return facts ? { handoff: facts } : {}
      })()
    }),
    // host.stop through the coordinator: the drain.
    stop: (input) => shutdown.stop(input)
  }

  const services: HostServices = {
    projects,
    runs: rm,
    setup,
    maintenance,
    settings,
    connections,
    mcp,
    adapterIds: Object.keys(adapters),
    harnessProject: harness,
    importer,
    skills,
    skillEvaluation,
    capabilities: caps,
    quick,
    templates,
    kit,
    teamFiles,
    outputs,
    outputWatcher,
    events,
    activity,
    usage: { refresh: () => monitor.refresh() },
    reference,
    env: {
      app: { getVersion: () => env.appVersion, getPath: () => env.userDataDir, isPackaged: env.isPackaged },
      platform,
      logsDir: () => env.logsDir,
      hostKind
    },
    ...(opts.desktop ? { desktop: opts.desktop } : {}),
    host: hostControl,
    secrets
  }
  const dispatcher = new HostDispatcher(services)
  dispatcherRef = dispatcher

  // Stores built, probes started, housekeeping done: advertise the host as ready.
  ownership.markReady()
  // No host arms an idle exit: the desktop host lives as long as its windows, and an inproc host as long as its terminal
  // command ('Press Ctrl+C to stop'); an idle drain would end runs waiting on the user.

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    outputWatcher.dispose()
    caps.dispose()
    connections.dispose()
    communityPrices.dispose()
    clearTimeout(spendTimer)
    spendTimer = undefined
    monitor.stop()
    activity.disarmIdleExit()
    unobserve()
    // Wave 7 (cli-standalone.md 5.6): the vault's background retry timer (legacy-only app hosts).
    secrets.dispose()
  }

  return { services, events, dispatcher, activity, runs: rm, settings, projectOrHarness, hostControl, shutdown, dispose }
}
