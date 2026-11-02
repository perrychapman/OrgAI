import type {
  ConnectionId,
  ModelRef,
  ModelTier,
  ImageAttachment,
  McpInstallDecision,
  McpInstallRequest,
  McpRegistrySearchInput,
  McpRegistrySearchResult,
  McpLibraryEntry,
  McpServerSpec,
  MergeDecision,
  MergeReview,
  ModelPrice,
  PermissionDecision,
  PermissionRuleDecision,
  PermissionRuleRequest,
  PermissionRequest,
  PluginSpec,
  Project,
  Proposal,
  ProposalDecision,
  ProposalOutcome,
  ProviderAuth,
  ProviderId,
  QuestionAnswer,
  Role,
  RunEvent,
  RunKind,
  RunPeer,
  RunPlan,
  RunSummary,
  ProjectPeek,
  SkillContent,
  SkillEvaluationReport,
  SkillFileInfo,
  SkillInfo,
  SkillLibraryInfo,
  TokenUsage,
  UsageStatus,
  UserQuestion
} from '@shared/types'

/** Harness id of the root orchestrator's AgentInstance, shared by every adapter. */
export const ROOT_AGENT_ID = 'root'

/**
 * Setup-like runs ('setup', 'mcp-assist' and 'skill-assist') run a built-in role instead of the project's org
 * chart, get their own harness tool set, are never nudged by the ContinuationDriver, never get cross-run messaging
 * and never load skills. A quick run is a 'work' run, not setup-like.
 */
export function isSetupLikeRun(kind: RunKind): boolean {
  return kind === 'setup' || kind === 'mcp-assist' || kind === 'skill-assist'
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
   * Extra environment for the adapter's child process. The Claude adapter merges it over an isolated copy of
   * process.env (childEnv.ts isolateClaudeEnv: a user's gateway, model and cloud-provider variables never reach a
   * run), so this is the only source of routing variables.
   * Claude adapter on LiteLLM: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and
   * ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL. On the anthropic connection: ANTHROPIC_API_KEY (copied from
   * the project's auth.envVar) for an API-key project whose variable is set, else empty (the Claude Code login or
   * CLAUDE_CODE_OAUTH_TOKEN authenticates). Secret values here are redacted from logs (collectSecrets).
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
  /**
   * LiteLLM only: token prices by model id from the catalog (ProviderModel.price, read from /model/info). Keys are
   * the proxy's model names, plus the bare upstream model (litellm_params.model without its "provider/" prefix) when
   * no model name already has it, since a proxy may answer with the upstream name. Look up with pricing.ts
   * `priceFor` (date suffixes and provider prefixes are tolerated). Missing or no match = no estimate (cost 0;
   * the Claude adapter then keeps the CLI's own rates). Not secret.
   */
  pricing?: Record<string, ModelPrice>
  /**
   * The connection's tier mapping at run start (AppSettings.connections[connection].tierModels), for tier-driven
   * choices inside a run: steering deep/top spawns to the everyday tier near a plan limit, and mapping the tier names
   * of proposed org chart roles. Missing on mock runs. Not secret.
   */
  tierModels?: Partial<Record<ModelTier, ModelRef>>
  /** Ids of the connection's catalog at run start (ConnectionService.catalog), for validating proposed role models. */
  models?: ModelRef[]
}

/**
 * One model an adapter reports without a run (RuntimeAdapter.listModels). Claude: the SDK's supportedModels()
 * (ModelInfo value / displayName / description), read after init with no prompt sent.
 */
export interface AdapterModelInfo {
  /** What Role.model would hold ('opus', 'sonnet[1m]', a full id...). Never the CLI's 'default' pseudo-entry. */
  id: ModelRef
  label?: string
  description?: string
  /** The concrete model the id currently resolves to, when the provider says (ModelInfo.resolvedModel). */
  resolvedModel?: string
}

/** An MCP server spec with its secret values filled in, ready for an adapter. Never emit, log or persist. */
export interface ResolvedMcpServer {
  spec: McpServerSpec
  /** spec.env plus secretEnv values (stdio). */
  env: Record<string, string>
  /** spec.headers plus secretHeaders values (http / sse). */
  headers: Record<string, string>
}

/**
 * A project skill ready for a run (RuntimeContext.skills): enabled, its library link present, granted to at least one
 * role of the run. `dir` is OrgAI's own stored copy (under the data dir), never the repository.
 */
export interface RunSkill {
  /** SkillSpec.id (the project skill id, also for a linked skill). */
  id: string
  name: string
  description: string
  /** Absolute folder holding SKILL.md and the resource files. */
  dir: string
  /** The stored files, SKILL.md first (only these may be read or copied). */
  files: SkillFileInfo[]
  /** Ids of the run's roles granted this skill (Role.skills). */
  roleIds: string[]
}

/** What message_run achieved (RuntimeContext.messageRun). */
export type RunMessageResult = 'delivered' | 'queued' | 'not-live' | 'not-found' | 'refused'

/**
 * Why message_run was refused. 'not-work': either run is setup-like; 'self': the target is the caller; 'empty': no
 * text; 'messaging-off': a project has Project.runMessaging off (offProjects names it); 'cap': this sender already
 * sent RUN_MESSAGE_LIMIT messages to this target (cap 'pair') or the target already took RUN_MESSAGE_INBOUND_LIMIT
 * messages from all runs (cap 'inbound'); 'busy': the target is waiting on its user and its queue of held messages
 * is full (RUN_MESSAGE_QUEUE_LIMIT); 'timeout': the live target's session did not take it within
 * RUN_MESSAGE_RECEIVE_TIMEOUT_MS.
 */
export type RunMessageRefusal = 'not-work' | 'self' | 'empty' | 'messaging-off' | 'cap' | 'busy' | 'timeout'

/** What messageRun returns: the result, and for 'refused' the reason. */
export interface RunMessageOutcome {
  result: RunMessageResult
  refusal?: RunMessageRefusal
  /** refusal 'messaging-off': display names of the projects (sender's and/or target's) that have it off. */
  offProjects?: string[]
  /** refusal 'cap': which cap was hit, the per-pair one or the recipient's inbound one. */
  cap?: 'pair' | 'inbound'
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
  /**
   * The org chart to run. For setup runs this is the built-in Architect, not the project's roles. A work run gets its own
   * copies of the roles: RunManager rewrites their grant fields (mcpServers, skills) in place when the user approves a
   * grant change mid-run (refreshRoleGrants), so hold these objects and read the grants at call time. Ids and every
   * other field stay as the run started (an org change applies from the next run).
   */
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
  /**
   * Put a proposal in front of the user. Resolves with the secret-free outcome (approve, revise or decline) once it
   * is applied or refused. RunManager sets Proposal.effect.
   */
  requestProposal(req: Omit<Proposal, 'id' | 'runId' | 'createdAt' | 'effect'>): Promise<ProposalOutcome>
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
  /**
   * Extra folders agents may read and edit like the project folder: Project.allowedDirectories resolved by RunManager
   * at run start (existing directories only, canonical, never touching OrgAI's data folder in either direction, never
   * the project folder or a folder inside it). Live: folders added during the run through allowDirectories appear at
   * once, so read it at call time. Claude passes it as Options.additionalDirectories on every options build; a `cd`
   * into one needs no rule (ruleMatch.ts matchOptionsFor). Missing (quick runs, build sessions, every
   * isTrustRestrictedRun) = none.
   */
  allowedDirectories?(): string[]
  /**
   * "Always allow for project" on an addDirectories suggestion (permissionRules.ts applyAllowScope): save the folders
   * onto Project.allowedDirectories through ProjectStore (cleaned) and add the ones that resolve (as above) to
   * allowedDirectories() at once. Returns the canonical folders now in force from `dirs`. Logs one info line.
   * Missing on trust-restricted runs: nothing persists.
   */
  allowDirectories?(dirs: string[]): string[]
  /**
   * "Always allow for project" on a setMode acceptEdits suggestion: set Project.permissionMode to 'acceptEdits' only
   * while it is 'default' (never from auto, plan, dontAsk or bypassPermissions); ctx.project follows. Returns true
   * when it switched. Logs it. Missing on trust-restricted runs: nothing persists.
   */
  acceptEditsForProject?(): boolean
  /**
   * Folders never offered or granted as extra directories (addDirectories suggestions, session dirs): OrgAI's data
   * folder, both spellings. Set on every run, restricted ones included. ruleMatch.ts matchOptionsFor carries it as
   * MatchOptions.deniedDirs. Missing = only the built-in refusals (roots, UNC, home and its config folders).
   */
  protectedDirectories?(): string[]
  /** Work runs: an agent edited the architecture document; record the time on the project. */
  noteArchitectureUpdated(): Promise<void>
  /**
   * The provider rejected a request on a subscription usage limit. `until` is when the window resets
   * (epoch ms), `window` the provider's name for it. If the session then ends, the run is paused and
   * continues automatically at `until`.
   */
  rateLimited(info: { until?: number; window?: string }): void
  /**
   * Weekly-window percent at or above which projects with preferEverydayNearLimit (defaults.ts helper; legacy
   * preferSonnetNearLimit honoured) spawn deep- and top-tier reports on the everyday tier (connection.tierModels).
   */
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
   * Setup-like runs (setup, mcp-assist): the app-wide MCP library entries (secret-free), for list_mcp_servers,
   * propose_mcp_servers links and the mock adapter. A run whose project id is HARNESS_PROJECT_ID manages the
   * library itself (scope 'library'). Optional: missing = an empty library.
   */
  mcpLibrary?(): McpLibraryEntry[]
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
  /**
   * Work runs: the project skills granted to at least one role in `roles` (RunSkill.roleIds says which). Setup-like
   * runs get none. Recomputed when an approved proposal or install changes the project (RunManager setLive), so read it at call time. Missing = none.
   * Grants are enforced per agent: Claude gates the Skill tool in PreToolUse, list_skills / load_skill filter by the
   * caller's role (HarnessToolCaller.roleId). Adapters emit `skill.used` when a granted skill loads.
   */
  skills?(): RunSkill[]
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
   * current saved project), this sender hit RUN_MESSAGE_LIMIT to this target or the target hit
   * RUN_MESSAGE_INBOUND_LIMIT ('cap'), or the target's held-message queue is full ('busy'); 'not-found' for an unknown
   * id, 'not-live' when the target's session is closed or has no receive(). 'queued' when the target is waiting on its
   * user (interrupted, usage-limited, or a card pending): RunManager holds the message and delivers it after the
   * user's next message or once the last card is answered, so a peer never overrides the user's stop. The sender's
   * run.message 'out' event and block are emitted at once; the target's 'in' event and block at delivery.
   * Missing = the tool answers NOT LIVE.
   */
  messageRun?(runId: string, text: string): Promise<RunMessageOutcome>
  /**
   * list_projects (quick runs only, RunSummary.quick set): every stored project as ProjectPeek data, never a virtual
   * project, never secrets. RunManager provides it only for quick runs. Missing = the tool says it is unavailable.
   */
  listProjects?(): ProjectPeek[]
  /**
   * Skill assistant runs ('skill-assist'): the skill library and, in a project session, the project's skills with
   * the role ids that load them (SkillInfo.grantedTo; resolve to slugs through ctx.project.roles). `project` is empty
   * on the virtual SKILLS_PROJECT_ID. Missing = the skill tools say the library is unavailable.
   */
  skillCatalog?(): SkillAssistCatalog
  /**
   * Skill assistant runs: one skill's stored text. `libraryId` names a library entry, `skillId` a skill of the
   * session's project (a linked skill reads its entry). null = unknown id. Never reads outside OrgAI's own copies.
   */
  readSkill?(ref: { libraryId?: string; skillId?: string }): SkillContent | null
}

/** RuntimeContext.skillCatalog: what list_skill_library reports. */
export interface SkillAssistCatalog {
  library: SkillLibraryInfo[]
  /** Project skills (project session only). */
  project: SkillInfo[]
  /** The project's newest skills:evaluate report, when one exists (project session only). */
  evaluation?: SkillEvaluationReport | null
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
  /**
   * What the completion is for. 'draft' (default): the org chart drafter, answered with JSON. 'title': a run title
   * (src/main/ai/runTitle.ts), answered with one short line. Adapters only use it where they must (the mock answers
   * deterministically per kind). 'skills': the skill evaluation's suggestion drafter (src/main/skills/), answered
   * with JSON `{ "suggestions": [{ name, description, body, rationale, findingIds }] }`. 'recommend': the Team
   * assistant (src/main/capabilities/recommend.ts), answered with JSON `{ "recommendations": [{ candidateId, roleIds,
   * reason, access }], "gaps": [{ roleId, need }] }`; the prompt lists `candidate <id> | ...` and `role <id> | ...` lines.
   */
  kind?: 'draft' | 'title' | 'skills' | 'recommend'
  /**
   * How to reach the models, as RunManager resolved it for a run (env, API key, base URL, Codex home). Claude merges
   * `connection.env` over the process environment (and drops ANTHROPIC_API_KEY on a non-anthropic connection, like
   * a run does); Codex uses it instead of its completionConnection. Missing = the adapter's default route.
   * Holds secrets: never log, emit or persist it.
   */
  connection?: RunConnection
  /**
   * Aborted when the caller gives up (the run-title timeout). Adapters stop the completion's query or process and
   * reject. Missing = the completion runs to its own end.
   */
  signal?: AbortSignal
  /**
   * Called once when the completion finished, with what it spent if the adapter knows (Claude: the result message's
   * usage and total_cost_usd; Codex: the turn's token usage; mock: a fixed small figure). Missing = not reported.
   */
  onUsage?(usage: { tokens: TokenUsage; costUsd?: number; model?: string }): void
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
  /**
   * The models the provider offers this login right now, without a run and without spending tokens (Claude: a query
   * whose prompt never yields, supportedModels(), then abort; same pattern as probeUsage). null when the provider
   * cannot say (old SDK, timeout, error). Never throws. ConnectionService turns the list into catalog entries.
   */
  listModels?(auth: ProviderAuth): Promise<AdapterModelInfo[] | null>
}
