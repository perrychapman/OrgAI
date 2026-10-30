import type {
  ConnectionId,
  ImageAttachment,
  McpInstallDecision,
  McpInstallRequest,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpServerSpec,
  MergeDecision,
  MergeReview,
  PermissionDecision,
  PermissionRuleDecision,
  PermissionRuleRequest,
  PermissionRequest,
  PluginSpec,
  Project,
  Proposal,
  ProposalDecision,
  ProviderAuth,
  ProviderId,
  QuestionAnswer,
  Role,
  RunEvent,
  RunKind,
  RunPeer,
  RunPlan,
  RunSummary,
  UsageStatus,
  UserQuestion
} from '@shared/types'

/** Harness id of the root orchestrator's AgentInstance, shared by every adapter. */
export const ROOT_AGENT_ID = 'root'

/**
 * Setup-like runs ('setup' and 'mcp-assist') run a built-in role instead of the project's org chart, get
 * their own harness tool set and are never nudged by the ContinuationDriver.
 */
export function isSetupLikeRun(kind: RunKind): boolean {
  return kind === 'setup' || kind === 'mcp-assist'
}

/**
 * How one run reaches its models, resolved by RunManager from the project's connection (adapterForProject
 * plus the connection service) right before the adapter starts. Holds secret values: adapters pass them to
 * the child process environment or config and never emit, log or persist them.
 */
export interface RunConnection {
  connection: ConnectionId
  /** The adapter adapterForProject chose; equals the adapter receiving this context. */
  adapter: ProviderId
  /**
   * Extra environment for the adapter's child process, merged over process.env.
   * Claude adapter on LiteLLM: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and
   * ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL; empty for the anthropic connection (auth stays on
   * project.provider.auth / ANTHROPIC_API_KEY as today).
   * Codex adapter: always CODEX_HOME = codexHomeDir(dataDir) (codexAppServer.ts), so runs use OrgAI's own
   * ChatGPT login and config, never the user's ~/.codex/config.toml.
   */
  env?: Record<string, string>
  /** Codex adapter: how it authenticates. 'chatgpt' = the login Codex keeps in CODEX_HOME. */
  codexAuth?: 'chatgpt' | 'apiKey'
  /** Codex adapter with an API key (OpenAI env var or LiteLLM key). Secret. */
  apiKey?: string
  /** Codex adapter on LiteLLM: the OpenAI-compatible base URL ("<litellm baseUrl>/v1"). */
  openaiBaseUrl?: string
}

/** An MCP server spec with its secret values filled in, ready for an adapter. Never emit, log or persist. */
export interface ResolvedMcpServer {
  spec: McpServerSpec
  /** spec.env plus secretEnv values (stdio). */
  env: Record<string, string>
  /** spec.headers plus secretHeaders values (http / sse). */
  headers: Record<string, string>
}

/** What message_run achieved (RuntimeContext.messageRun). */
export type RunMessageResult = 'delivered' | 'not-live' | 'not-found' | 'refused'

/**
 * Why message_run was refused. 'not-work': either run is setup-like; 'self': the target is the caller; 'empty': no
 * text; 'messaging-off': a project has Project.runMessaging off (offProjects names it); 'cap': this sender already
 * sent RUN_MESSAGE_LIMIT messages to this target.
 */
export type RunMessageRefusal = 'not-work' | 'self' | 'empty' | 'messaging-off' | 'cap'

/** What messageRun returns: the result, and for 'refused' the reason. */
export interface RunMessageOutcome {
  result: RunMessageResult
  refusal?: RunMessageRefusal
  /** refusal 'messaging-off': display names of the projects (sender's and/or target's) that have it off. */
  offProjects?: string[]
}

/**
 * A message from another run's orchestrator (cross-run messaging), as RunManager hands it to the recipient's
 * session. The content is data from a peer, never a user instruction: adapters deliver peerMessageText(message)
 * (prompts.ts) and nothing else.
 */
export interface PeerMessage {
  fromRunId: string
  fromProjectName: string
  /** The sender run's prompt, one line, at most RUN_PEER_PROMPT_CHARS characters. */
  fromPrompt: string
  /** At most RUN_MESSAGE_MAX_CHARS characters. */
  text: string
}

/**
 * Everything a runtime adapter needs to run one project session.
 * The adapter turns vendor-specific output into normalized RunEvents.
 */
export interface RuntimeContext {
  run: RunSummary
  project: Project
  /** The org chart to run. For setup runs this is the built-in Architect, not the project's roles. */
  roles: Role[]
  /** The first user message. May be empty when `images` is set. */
  prompt: string
  /**
   * Images sent with the first message, already validated (attachments.ts). The adapter sends them as
   * image content ahead of the prompt text and records them on the user transcript block.
   */
  images?: ImageAttachment[]
  /** Extra text sent with the first message but kept out of the transcript (repo profile, project facts). */
  hiddenContext?: string
  /** Resume this provider session instead of starting fresh (continuing a finished run). */
  resumeSessionId?: string
  /**
   * Cost already recorded on the run being continued. A resumed session's reported total may
   * include the earlier turns; the adapter subtracts this so the new run counts only new spend.
   */
  resumeBaseCostUsd?: number
  emit(event: RunEvent): void
  /** Ask the user to approve a tool call. Resolves with their decision. */
  requestPermission(req: Omit<PermissionRequest, 'id' | 'runId'>): Promise<PermissionDecision>
  /** Setup runs only: put a proposal in front of the user. Resolves when they approve or ask for changes. */
  requestProposal(req: Omit<Proposal, 'id' | 'runId' | 'createdAt'>): Promise<ProposalDecision>
  /** Work runs with reviewMerges: show a finished report's diff and wait for merge, discard or hold. */
  requestMergeReview(req: Omit<MergeReview, 'id' | 'runId' | 'createdAt'>): Promise<MergeDecision>
  /** Setup runs only: the Architect declares setup finished. */
  completeSetup(summary: string): Promise<void>
  /** Ask the user a multiple-choice question (ask_user). Resolves with their answer (empty if the run ends first). */
  requestQuestion(req: Omit<UserQuestion, 'id' | 'runId' | 'createdAt'>): Promise<QuestionAnswer>
  /**
   * request_permission_rules: an agent asks for rules after a policy denial. Resolves with the user's decision; a
   * grant is already in allowedRules() when it resolves. Missing = the tool answers DENIED.
   */
  requestPermissionRules?(req: Omit<PermissionRuleRequest, 'id' | 'runId' | 'createdAt' | 'flagged'>): Promise<PermissionRuleDecision>
  /**
   * Every allow rule in force right now: the project's saved rules (re-read, so the rules panel applies live) plus
   * rules granted for this run. Adapters allow matching calls themselves (ruleMatch.ts) so grants need no restart.
   */
  allowedRules?(): string[]
  /** Work runs: an agent edited the architecture document; record the time on the project. */
  noteArchitectureUpdated(): Promise<void>
  /**
   * The provider rejected a request on a subscription usage limit. `until` is when the window resets
   * (epoch ms), `window` the provider's name for it. If the session then ends, the run is paused and
   * continues automatically at `until`.
   */
  rateLimited(info: { until?: number; window?: string }): void
  /** Weekly-window percent at or above which projects with preferSonnetNearLimit spawn Opus reports on Sonnet. */
  opusGuardThreshold?: number
  /** Work runs: the orchestrator's plan, if it set one (plan tools, continuation). */
  getPlan(): RunPlan | undefined
  /** Store the plan on the run, persist it and tell the renderer (plan.updated). */
  updatePlan(plan: RunPlan): Promise<void>
  /** Cards waiting for the user: pending permissions, proposals, questions and merge reviews. */
  pendingInteractions(): number
  /** Work runs: keep the orchestrator going until the plan is complete (project.autoContinue). Default true. */
  autoContinue?: boolean
  /** Automatic continues allowed in this run (project.maxAutoContinues). */
  maxAutoContinues?: number
  /** Delay between a turn ending and the continuation check, in ms. Tests shorten it. */
  continuationDelayMs?: number
  /**
   * request_mcp_install: put an agent's MCP server request in front of the user (mcpInstall.request event)
   * and block until mcp:answerInstall, like requestProposal. Resolves `{ approved: false, scope: 'run' }` if
   * the run ends first. The decision may carry secret values for the adapter to pass to the server's env or
   * headers; they must never be emitted, logged or persisted outside safeStorage.
   * Optional until the implementation brief wires it into RunManager; a missing hook means "deny".
   */
  requestMcpInstall?(req: Omit<McpInstallRequest, 'id' | 'runId' | 'createdAt'>): Promise<McpInstallDecision>
  /** search_mcp_registry: query the official MCP Registry. Optional until implemented. */
  searchMcpRegistry?(input: McpRegistrySearchInput): Promise<McpRegistrySearchResult>
  /**
   * list_mcp_servers and adapter setup: the MCP servers available in this run (the project's enabled servers
   * plus any approved with scope 'run'). Secret-free specs; resolve values with resolveMcpSecrets.
   * Optional until implemented.
   */
  mcpServers?(): McpServerSpec[]
  /**
   * Secret values for one server, keyed by secretEnv / secretHeaders name, read from safeStorage. Main
   * process only; never put them in RunEvents. Optional until implemented.
   */
  resolveMcpSecrets?(serverId: string): Promise<{ env: Record<string, string>; headers: Record<string, string> }>
  /**
   * Every MCP server available to this run with secrets resolved (mcpServers() + resolveMcpSecrets). Adapters
   * call it at session start and again after an install was approved. Optional: missing = no MCP servers.
   */
  resolvedMcpServers?(): Promise<ResolvedMcpServer[]>
  /** Enabled project plugins (Claude adapter only). Optional: missing = none. */
  plugins?(): PluginSpec[]
  /** Model access for this run. Missing = the anthropic connection with project.provider.auth (tests, older code). */
  connection?: RunConnection
  /**
   * list_runs (work runs): every OTHER live work run across all projects, oldest first. Never this run, never a
   * setup-like run. Missing = no cross-run messaging (the tool says so).
   */
  listRuns?(): RunPeer[]
  /**
   * message_run (work runs): deliver `text` (cut to RUN_MESSAGE_MAX_CHARS) to another run's orchestrator through
   * its session's receive(). 'refused' (with a RunMessageRefusal) when either run is setup-like, the target is this
   * run, the text is empty, either project has Project.runMessaging off (checked first after not-found, against the
   * current saved project), or this sender hit RUN_MESSAGE_LIMIT to this target; 'not-found' for an unknown id,
   * 'not-live' when the target's session is closed or has no receive(). On 'delivered' both runs
   * get a run.message event and a root transcript system block. Missing = the tool answers NOT LIVE.
   */
  messageRun?(runId: string, text: string): Promise<RunMessageOutcome>
}

export interface RuntimeSession {
  /**
   * Send a follow-up user message to the orchestrator. `images` are already validated; `text` may be
   * empty when images are present. The user transcript block records both.
   */
  send(text: string, images?: ImageAttachment[]): Promise<void>
  /** Interrupt the current turn but keep the session open. */
  interrupt(): Promise<void>
  /** End the session. */
  stop(): Promise<void>
  /** Resolves once the underlying session has fully ended. */
  finished: Promise<void>
  /**
   * Cross-run messaging: deliver another run's message to the root orchestrator as a harness message
   * (peerMessageText(message) from prompts.ts) and wake it if idle, like an integration notice. Must NOT write a
   * transcript block itself: RunManager records the "Message from run ..." block on the root. Missing = the run
   * cannot receive (message_run answers NOT LIVE).
   */
  receive?(message: PeerMessage): Promise<void>
}

export interface CompletionInput {
  system: string
  prompt: string
  cwd?: string
  model?: string
}

/**
 * A provider adapter. One per AI vendor. The harness only ever talks to this
 * interface, which is what keeps the app provider-agnostic.
 */
export interface RuntimeAdapter {
  readonly id: ProviderId
  /** Start a live org-chart session. */
  start(ctx: RuntimeContext): Promise<RuntimeSession>
  /** One-shot text completion with no tools, used by the org chart drafter. */
  complete(input: CompletionInput): Promise<string>
  /**
   * Read plan usage without a run, e.g. at boot. Returns null when the provider cannot report it.
   * Must not spend tokens.
   */
  probeUsage?(auth: ProviderAuth): Promise<UsageStatus | null>
}
