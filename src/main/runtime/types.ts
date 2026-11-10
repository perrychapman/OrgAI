import type {
  ConnectionId,
  DelegationVerdict,
  EngagementNote,
  EngagementNoteContent,
  KnowledgeEdgeSaveInput,
  KnowledgeEdgeWriteResult,
  KnowledgeGraph,
  KnowledgeInferredResult,
  KnowledgeRecallInput,
  KnowledgeNodeUpsertInput,
  KnowledgeNodeWriteResult,
  KnowledgeRetireInput,
  KnowledgeRetireResult,
  KnowledgeSource,
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
  OutputProduceInput,
  OutputReadInput,
  OutputRegisterInput,
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
  RunStaffing,
  RunSummary,
  ProjectPeek,
  StaffingGoal,
  SkillContent,
  SkillEvaluationReport,
  SkillFileInfo,
  SkillInfo,
  SkillLibraryInfo,
  TokenUsage,
  UsageStatus,
  UserQuestion
} from '@shared/types'
import type { OutputReadResult, OutputWriteResult } from '../outputs/api'
import type { StaffingProfile } from '../store/staffingProfile'
import type { AppNavigateEvent, AppNavigateOutcome, AppReferenceQuery, AppReferenceResult, AppSettings, AppSettingsProposalPayload, AtlasSurfaceId, PermissionMode } from '@shared/types'

/**
 * RunManagerOptions.selfKnowledge (types.ts "Self-knowledge and self-configuration"), wired in host/bootstrap.ts.
 * Missing = no app_reference answers, no open_in_app and no appSettings apply.
 */
export interface SelfKnowledgeHooks {
  /** The reference service (src/main/reference/appReference.ts). `status: false` makes a status query answer "not available". */
  reference(query: AppReferenceQuery, opts: { status: boolean }): Promise<AppReferenceResult>
  /**
   * Deliver an AppNavigateEvent to the desktop main window (index.ts DesktopHooks). false when no desktop window can
   * show it (a headless or in-process host): the tool then says so.
   */
  navigate(event: AppNavigateEvent): boolean
  /** The stored app settings. */
  settings(): AppSettings
  /**
   * Apply an approved appSettings proposal through the settings:set path (args.ts settingsSetArgs semantics,
   * SettingsStore normalization, which also applies the theme and broadcasts settings:changed). Throws a readable
   * sentence on refusal; nothing is saved then.
   */
  applyAppSettings(payload: AppSettingsProposalPayload): void
}

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
  /** The connection's display name (a proxy's own name), for messages. Not a secret. */
  name?: string
  /** The adapter adapterForProject chose; equals the adapter receiving this context. */
  adapter: ProviderId
  /**
   * Extra environment for the adapter's child process. The Claude adapter merges it over an isolated copy of
   * process.env (childEnv.ts isolateClaudeEnv: a user's gateway, model and cloud-provider variables never reach a
   * run), so this is the only source of routing variables.
   * Claude adapter on a proxy: ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and
   * ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL. On the anthropic connection: ANTHROPIC_API_KEY (copied from
   * the project's auth.envVar) for an API-key project whose variable is set, else empty (the Claude Code login or
   * CLAUDE_CODE_OAUTH_TOKEN authenticates). Secret values here are redacted from logs (collectSecrets).
   * Codex adapter: always CODEX_HOME = codexHomeDir(dataDir) (codexAppServer.ts), so runs use OrgAI's own
   * ChatGPT login and config, never the user's ~/.codex/config.toml.
   */
  env?: Record<string, string>
  /** Codex adapter: how it authenticates. 'chatgpt' = the login Codex keeps in CODEX_HOME. */
  codexAuth?: 'chatgpt' | 'apiKey'
  /** Codex adapter with an API key (OpenAI env var or proxy key). Secret. */
  apiKey?: string
  /** Codex adapter on a proxy: the OpenAI-compatible base URL ("<proxy baseUrl>/v1"). */
  openaiBaseUrl?: string
  /**
   * Proxy only (a litellm-kind proxy that reported prices): token prices by model id from the catalog (ProviderModel.price, read from /model/info). Keys are
   * the proxy's model names, plus the bare upstream model (litellm_params.model without its "provider/" prefix) when
   * no model name already has it, since a proxy may answer with the upstream name. Look up with pricing.ts
   * `priceFor` (date suffixes and provider prefixes are tolerated). Missing or no match = no estimate (cost 0;
   * the Claude adapter then keeps the CLI's own rates). Not secret.
   */
  pricing?: Record<string, ModelPrice>
  /**
   * The connection's tier mapping at run start (the connection's record, connectionRecord(settings, connection).tierModels), for tier-driven
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

/**
 * The calling agent of a knowledge or note write, as the adapter reports it to the harness tool (the same fields as
 * harnessTools.ts HarnessToolCaller). Missing agentId = the root; RunManager turns it into a KnowledgeSource.
 */
export interface KnowledgeCaller {
  agentId?: string
  roleId?: string
}

/**
 * The knowledge graph store as RunManager and ipc.ts use it (store/knowledge.ts `knowledgeStore(dataDir)`): every
 * function is keyed by the stored project id, validates its input (keys, lengths, hidden characters, caps, note ids
 * against the note index) and throws an Error whose message is shown to the caller. Writes are atomic. The agent
 * functions take the KnowledgeSource RunManager built; the user's IPC writes use the store's own user functions.
 */
export interface KnowledgeStoreApi {
  /** The graph as stored (junk dropped, note links to missing notes dropped); empty when there is no file. */
  get(projectId: string): KnowledgeGraph
  /** Agent upsert (identity by id, else (kind, name) / (kind, alias) case-insensitive; see KnowledgeNodeUpsertInput). */
  upsertNode(projectId: string, input: KnowledgeNodeUpsertInput, source: KnowledgeSource): KnowledgeNodeWriteResult
  /** Agent or user link: from / to are node ids; (from, to, relation) dedupes onto the existing edge (note updated). */
  saveEdge(projectId: string, input: Omit<KnowledgeEdgeSaveInput, 'projectId'>, source: KnowledgeSource): KnowledgeEdgeWriteResult
  /** Agent retire: refuses an item whose source.by is 'user' ("Only the user can change that."). */
  retire(projectId: string, input: KnowledgeRetireInput, source: KnowledgeSource): KnowledgeRetireResult
  /** Derived links and appearances for the current graph, computed once per graph revision. Never throws. Missing = no inferred lines in recalls. */
  inferred?(projectId: string): KnowledgeInferredResult
  /**
   * For a recall: the graph revision to rank on and its inferred links. The current revision, except that a very large
   * graph keeps one revision for a while so its index and inference are not rebuilt per write (store/knowledge.ts
   * readRecallView). Never throws. Missing = the current graph and `inferred`.
   */
  recallView?(projectId: string): { rankOn: KnowledgeGraph; inferred: KnowledgeInferredResult }
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
   * The project's saved allow rules alone (no run grants), re-read at each call from wherever the project keeps them
   * (store/projectData.ts projectRulesFile: .claude/settings.local.json for code projects, OrgAI's data folder for
   * engagements). Adapters use it instead of `listRules(ctx.project.path)` (Claude options.allowedTools, Codex and
   * mock fallbacks). Missing on trust-restricted runs = none.
   */
  savedRules?(): string[]
  /**
   * Save "Always allow for project" rules where the project keeps them (see savedRules); returns the full list and
   * the rules that were new (permissionRules.ts addRulesReport). permissionRules.ts applyAllowScope calls it through
   * AllowScopePersist, so adapters pass it with allowDirectories / acceptEditsForProject. Missing on
   * trust-restricted runs: nothing persists.
   */
  saveProjectRules?(rules: string[]): { rules: string[]; added: string[] }
  /**
   * Engagements: the approved engagement document's text (store/projectData.ts readEngagementDocument, at most
   * ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS plus a truncation note), read at call time; undefined for code projects or
   * before one is approved. Adapters pass it as PromptFlags.engagementDocument.
   */
  engagementDocument?(): string | undefined
  /**
   * engagement_context (ENGAGEMENT_CONTEXT_TOOL): the project's context notes. RunManager provides it on engagement
   * work runs and single-agent runs (RunSummary.team 'single') of a stored project, never on quick, setup-like or
   * trust-restricted runs. `list` is the index (EngagementNote), `read` one note's text or null for an unknown id.
   * Read at call time. Missing = the tool is not offered (adapters) or says no notes are available.
   * `save` creates (no noteId) or replaces an agent-written note: RunManager fills source 'agent', the run id and the
   * caller's role (from the run's agent record, else the caller's roleId, else the root role), writes the harness
   * transcript row "Saved note <title>" on the writing agent, counts it toward KNOWLEDGE_RUN_WRITES_MAX and pushes
   * projects:engagementChanged 'notes'. It throws (the tool answers REFUSED with the message) for a user note
   * ("Only the user can change that note; save a new one instead."), an unknown id, the caps, or the writes limit.
   */
  engagementNotes?: {
    list(): EngagementNote[]
    read(noteId: string): EngagementNoteContent | null
    save(input: { noteId?: string; title: string; text: string }, caller: KnowledgeCaller): EngagementNote
  }
  /**
   * engagement_knowledge (KNOWLEDGE_TOOL): the engagement's knowledge graph (types.ts "Engagement knowledge graph").
   * RunManager provides it on engagement work runs of a stored project (any team, never bare, quick, setup-like or
   * trust-restricted runs); missing = the tool is not offered (adapters) or answers that no knowledge graph is
   * available. `graph` is read at call time (search, vocabulary and get are pure helpers in shared/knowledge.ts over
   * it). Every write takes the calling agent (HarnessToolCaller) and RunManager fills the KnowledgeSource (by 'agent',
   * run id, agent id, role name or slug), writes one harness transcript row on the writing agent ("Recorded <kind>
   * <name>" / "Updated <kind> <name>" / "Linked <from> <relation> <to>" / "Retired <item> <label>"), counts it toward
   * KNOWLEDGE_RUN_WRITES_MAX (past it every write throws "The knowledge graph write limit for this run (N) is
   * reached; nothing was saved." and nothing is saved) and pushes projects:engagementChanged 'knowledge'. Validation
   * failures (keys, lengths, hidden characters, unknown ids, user-written items on retire, the graph caps) throw with
   * the message the tool shows after "REFUSED: ".
   */
  knowledge?: {
    graph(): KnowledgeGraph
    upsertNode(input: KnowledgeNodeUpsertInput, caller: KnowledgeCaller): KnowledgeNodeWriteResult
    /** from / to are node ids (the tool resolves names first). */
    link(input: Omit<KnowledgeEdgeSaveInput, 'projectId' | 'edgeId' | 'retired'>, caller: KnowledgeCaller): KnowledgeEdgeWriteResult
    retire(input: KnowledgeRetireInput, caller: KnowledgeCaller): KnowledgeRetireResult
  }
  /**
   * produce_output / register_output (OUTPUT_TOOLS; types.ts "Run outputs"). RunManager provides it on work runs of a
   * stored project (team 'default' or 'single', code or engagement; never bare, quick, trust-restricted, setup-like or
   * virtual-project runs); missing = the tools answer "Outputs are not available in this run.". On each call RunManager
   * resolves the folder scope from the stored project (path, allowed and reference folders) at call time, fills the
   * OutputSource from the run's agent record (never a value the agent supplied), counts it toward OUTPUTS_RUN_MAX (past
   * it the call throws "The output limit for this run (200) is reached; nothing was saved."), and on success emits
   * `output.created`, writes one quiet harness transcript row on the calling agent and pushes outputs:changed. Every
   * refusal (path rules, caps, hidden characters, an unrenderable document) throws with the sentence the tool shows
   * after "REFUSED: ".
   */
  outputs?: {
    /**
     * Identity rule (outputs 2): a path that is an indexed output adds a version (`versioned`), an unchanged result
     * changes nothing (`created` and `versioned` both false). RunManager emits `output.created` or `output.versioned`.
     */
    produce(input: OutputProduceInput, caller: KnowledgeCaller): Promise<OutputWriteResult>
    register(input: OutputRegisterInput, caller: KnowledgeCaller): Promise<OutputWriteResult>
    /** read_output (list / read / notes) over the service; a refusal throws a sentence the tool shows after "REFUSED: ". Read-only, no cap. */
    read(input: OutputReadInput, caller: KnowledgeCaller): Promise<OutputReadResult>
  }
  /**
   * knowledge_recall (KNOWLEDGE_RECALL_TOOL): one budgeted, ranked answer as fenced data. RunManager provides it on
   * engagement work runs and single (Ask) engagement runs of a stored project; never on bare, quick, setup-like or
   * trust-restricted runs. It keeps the per-agent "already shown" state (only for a named agent: `caller.agentId` must
   * be set, ROOT_AGENT_ID for a known root; missing = no dedupe, and the row lands on the root), counts RunUsage.knowledge,
   * writes the row "Recalled N items about <query>" on the caller and emits knowledge.recalled. Read-only. Never throws for
   * a query it can answer; a refusal comes back as text starting "REFUSED: ".
   */
  knowledgeRecall?(input: KnowledgeRecallInput, caller: KnowledgeCaller): string
  /**
   * Zero-call context, same runs as knowledgeRecall. Deterministic and with no model call: finds live entities whose
   * name or alias appears in `text` (word boundaries, exact, names under 3 characters skipped), and returns a fenced
   * data block of at most KNOWLEDGE_CONTEXT_MAX_CHARS, framed as data from the graph (never instructions, never the
   * user's words), or null when nothing matches, when everything matched was already shown to that agent, or when
   * knowledgeAutoContextOn(project) is false (read at call time). It reaches later turns unasked, so it holds name, kind,
   * relations and only user-written summaries and facts; agents get the rest from knowledgeRecall.
   *
   * The adapter calls it where text reaches an agent: `purpose: 'spawn'` on a spawn's brief, `purpose: 'message'` on a
   * user message, never on harness nudges or peer messages. It adds the block beside the text, never inside the user's
   * transcript entry (hiddenContext-style). `agentId` is the receiving agent when known; missing means no dedupe and
   * the row lands on the root. On a non-null result RunManager has already counted it, written the row "Added 2 known
   * items: Acme Corp, Jane Doe" on that agent and emitted knowledge.recalled.
   */
  knowledgeContext?(text: string, opts: { agentId?: string; purpose: 'spawn' | 'message' }): string | null
  /**
   * The standing index for the system prompt (shared/knowledgeIndex.ts knowledgeBrief, at most
   * KNOWLEDGE_BRIEF_MAX_CHARS): computed once per run at its first call and then constant, so prompt caching holds, and
   * undefined for an empty graph. It reaches every role, so it holds nothing an agent wrote: counts, common kinds and
   * relations, names of user-created entities. Same runs as knowledgeRecall. Adapters pass `knowledgeBrief: ctx.knowledgeBrief?.()`
   * as PromptFlags.knowledgeBrief wherever they pass engagementDocument.
   */
  knowledgeBrief?(): string | undefined
  /**
   * propose_org_chart `fromTemplate` (setup runs): the saved team template's roles as drafts for this project
   * (converted through the agent-import path, models mapped to the project's connection; no ids, grants or
   * positions), with the template's name. null for an unknown id. Missing = templates unavailable.
   */
  orgTemplate?(templateId: string): { name: string; roles: Role[] } | null
  /**
   * False when the working folder's own agent config must not load this run (folderConfigTrust.ts): the project's
   * state is 'untrusted' or 'changed', or a digest that matched at run start no longer does. Sticky: once false it stays
   * false for the run, so an agent's mid-run edit cannot reach a restarted query. It re-hashes the config, so read it
   * when building a query or launch config, never per tool call. Absent = no gate.
   */
  folderConfigLoads?(): boolean
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
   * Read-only extra folders: Project.referenceDirectories resolved by RunManager at run start like allowedDirectories
   * (existing directories only, canonical, the same refusals, one run warning per missing or dropped folder; a folder
   * also in allowedDirectories() is left out here). Read it at call time. Missing (quick runs, build sessions, every
   * isTrustRestrictedRun) or empty = none.
   * - The provider sees them as readable extra folders: Claude adds them to Options.additionalDirectories next to
   *   allowedDirectories(); Codex never adds them to sandbox_workspace_write.writable_roots (workspace-write reads
   *   outside the workspace already, per the Codex docs; unverified live).
   * - The adapter MUST refuse Edit / Write / MultiEdit / NotebookEdit whose path is under one (lexical plus the real
   *   path of the nearest existing ancestor; a missing or non-string path on those tools is refused) before any allow
   *   path, restarted queries included, and decline a Codex file change under one without a card, always with
   *   referenceDirectories.ts `referenceFolderMessage(folder)`: "<folder> is a reference folder: agents may read it,
   *   not change it". Use referenceDirectories.ts `referenceEditDenial` / `referenceFolderOf`.
   * - A `cd` into one needs no rule (ruleMatch.ts matchOptionsFor adds them to freeDirs).
   * - LIMITATION: Bash (and PowerShell) commands that write inside a reference folder are NOT gated by this; the
   *   project's permission mode still applies to them.
   */
  referenceDirectories?(): string[]
  /**
   * "Always allow for project" on an addDirectories suggestion (permissionRules.ts applyAllowScope): save the folders
   * onto Project.allowedDirectories through ProjectStore (cleaned) and add the ones that resolve (as above) to
   * allowedDirectories() at once. Returns the canonical folders now in force from `dirs`. Logs one info line.
   * A folder that is (or is inside) a reference folder is never added: it is skipped with a log line, so a
   * reference folder stays read-only. Missing on trust-restricted runs: nothing persists.
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
  /**
   * Paths the self-control gate protects (selfControlGate.ts `controlProtectedPaths`, cli-spec 3.4(1)): the host's
   * `<dataDir>/run`, `secrets.json`, `codex` (CODEX_HOME) and a fallback runtime socket dir, both spellings. Read live
   * on every check (the runtime dir is known only once ownership is acquired). Missing = no self-control paths.
   */
  controlProtectedPaths?(): string[]
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
  /** Work runs: the run's staffing record (shared/types.ts "Run staffing"), if anything was recorded. Nothing writes it yet. */
  getStaffing(): RunStaffing | undefined
  /**
   * Store the run's whole staffing record, persist it and tell the renderer (staffing.updated), like updatePlan.
   * RunManager cleans it first (defaults.ts cleanRunStaffing: malformed rows dropped, the newest
   * RUN_STAFFING_ASSIGNMENTS_MAX kept); a value that is not an object is ignored with a warning.
   */
  updateStaffing(staffing: RunStaffing): Promise<void>
  /**
   * The goal this run staffs for: defaults.ts staffingGoalOf(project, RunOverrides.goal), the per-run override on top
   * of Project.staffingGoal, fixed at run start. RunManager sets it on every run; missing (fakes, older callers) =
   * staffingGoalOf(ctx.project, ctx.run.overrides?.goal). staffing.ts recordStaffing reads it for a run's first record.
   */
  staffingGoal?: StaffingGoal
  /**
   * The project's staffing profile (store/staffingProfile.ts, docs/design/orchestration-efficiency.md 4.5), read once when
   * RunManager builds the context: a snapshot for the life of the run. Set only on runs it applies to
   * (staffingProfileApplies: work runs of a stored project with automatic staffing, not quick, Ask, setup-like or build
   * runs); bridged child sessions never get it. Adapters feed it to their StaffingBook (profileDefaultsFor) and the
   * root's first message (withRootStaffingBrief). Missing (fakes, older callers) = no profile.
   */
  staffingProfile?(): StaffingProfile | undefined
  /** Cards waiting for the user: pending permissions, proposals, questions and merge reviews. */
  pendingInteractions(): number
  /**
   * Reports running now (subagent threads and bridged reports of this session, any depth). The plan tools subtract it
   * from the project's concurrency limit to say how many agent slots are free. Missing = none running.
   */
  liveReports?(): number
  /** Work runs: keep the orchestrator going until the plan is complete (project.autoContinue). Default true. */
  autoContinue?: boolean
  /** Automatic continues allowed in this run (project.maxAutoContinues). */
  maxAutoContinues?: number
  /** Delay between a turn ending and the continuation check, in ms. Tests shorten it. */
  continuationDelayMs?: number
  /**
   * Headless exec settlement (cli-spec 6.2(2)). Adapters call it on EVERY root turn end, failed ones included,
   * BEFORE emitting run.status 'idle'. Optional: missing = nobody listens.
   */
  onRootTurnEnded?(e: RootTurnEnd): void
  /** Adapter-internal activity that should keep an exec run from settling or stalling (bumps activityGen). */
  noteActivity?(reason: ExecActivityReason): void
  /**
   * Required delegation (docs/design/delegation-enforcement.md 5.2): the run's ledger gate, implemented by RunManager on
   * work runs only (missing on setup, assistant, quick and single-agent runs: nothing is enforced). Adapters call it at
   * each spawn, completion, delivery and native-spawn attempt and act on the answer.
   */
  delegation?: DelegationGate
  /**
   * Set by RunManager on exec runs with a budget: the effective budget minus the exec chain's prior cost (0 allowed).
   * Claude passes it as options.maxBudgetUsd instead of project.maxBudgetUsd; a restart subtracts this run's cost from it.
   */
  budgetUsd?: number
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
   * Chat (quick) runs only: true once the user answered "Allow for session" on a card for an edit inside the chat's
   * folder that offered the quick session-edit suggestion (quick/sessionEdits.ts `quickSessionEditSuggestion`).
   * RunManager owns the flag (decide() re-checks the card's tool and path) and binds this only on quick runs.
   * Adapters read it through `quickEditPreApproved` and never pass the setMode suggestion on to a provider: the
   * provider stays in its asking mode, and only edits `quickFolderEditCovered` accepts (inside the folder, by lexical
   * and real path, never under .git, .claude, .codex, .agents, .orgai, .vscode, .idea, .github or the listed config
   * files) become free. Missing = no session edit grant.
   */
  quickSessionEdits?(): boolean
  /**
   * app_reference (every run kind; types.ts "Self-knowledge and self-configuration"): RunManager binds
   * RunManagerOptions.selfKnowledge.reference with `status` allowed only on quick (Chat), 'mcp-assist' and
   * 'skill-assist' runs; elsewhere a status query answers that status is not available in this run. Missing = the
   * tool says the reference is unavailable.
   */
  appReference?(query: AppReferenceQuery): Promise<AppReferenceResult>
  /**
   * open_in_app (quick, setup, 'mcp-assist' and 'skill-assist' runs only; never work or single runs). RunManager
   * checks the surface id (isAtlasSurfaceId), the project (a stored, non-virtual project; required for project and
   * engagement surfaces, an engagement for engagement surfaces, dropped for app and assistant surfaces), the per-run
   * limits (OPEN_IN_APP_PER_RUN_MAX, OPEN_IN_APP_MIN_INTERVAL_MS), then sends AppNavigateEvent through
   * RunManagerOptions.selfKnowledge.navigate and writes one harness transcript row "Opened <path> for you" on the
   * calling agent. Missing = the tool says it cannot open the app from this run.
   */
  navigate?(target: { surfaceId: AtlasSurfaceId; projectId?: string }, caller: { agentId?: string }): AppNavigateOutcome
  /** Quick runs only: the stored app settings (secret-free), for an appSettings proposal's `from` values. */
  appSettings?(): AppSettings
  /** Quick runs only: a stored, non-virtual project by id (propose_project_settings target). undefined otherwise. */
  storedProject?(projectId: string): Project | undefined
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
  /**
   * Multi-provider org charts (bridged reports, runtime/bridge.ts): present on a work run of a stored project whose
   * chart has bridged roles (AdapterChoice.bridged), never on setup-like, quick, single or trust-restricted runs and
   * never inside a bridged child session (no nested bridging in phase 1). Read at call time.
   * - `roles()`: the bridged roles (id, slug, name, connection and its display name, adapter). Adapters must not
   *   offer these roles through their native spawn path (Claude: no AgentDefinition, PreToolUse denies Agent / Task
   *   for their subagent_type; Codex: spawn_agent routes them to `spawn`).
   * - `spawn(input)`: start the role in a child session on its own adapter and RunConnection and resolve with its
   *   final text once its root's first turn ends (or the child fails / the run stops: `ok: false` with an error text).
   *   RunManager enforces spawnable (the caller's role may spawn it; unknown caller = the root role), depth and
   *   concurrency (effectiveSubagentLimits, counting native and bridged agents) and refuses with a thrown Error whose
   *   message the caller returns to the model. The child's agents reach the run as ordinary agent.upsert events (root
   *   remapped to a fresh id under `parentAgentId`, `connection` set), so adapters emit nothing for it themselves.
   *   Never rejects for a child failure; rejects only for a refusal before the child exists.
   */
  bridge?: {
    roles(): BridgedRole[]
    spawn(input: BridgeSpawnInput): Promise<BridgeSpawnResult>
  }
  /** The connection a role's agents run on in this run (defaults.ts roleConnection), for adapters that label agents. Missing = the run's connection. */
  agentConnection?(roleId: string): ConnectionId | undefined
  /**
   * Setup runs (propose_org_chart drafts with a `connection`): every connection a role may name right now
   * (connectionConfigured, the anthropic connection included), with its display name, tier mapping and catalog ids,
   * so a draft's tier maps through ITS connection. Read at call time. Missing = drafts may not name a connection
   * other than the run's (the tool answers REVISE). Never secrets.
   */
  connectionModels?(): { connection: ConnectionId; name: string; tierModels: Partial<Record<ModelTier, ModelRef>>; models: ModelRef[] }[]
  /**
   * Set only on the RuntimeContext of a bridged child session (runtime/bridge.ts). The child's root (`roles` holds the
   * bridged role with reportsTo null plus the roles reachable through its spawnable chain) is NOT the run's root:
   * harnessToolsFor gives it no 'root'-audience tools (no plan, proposal, org-change, messaging or ask_user tools),
   * adapters pass PromptFlags.bridged so it gets a report's prompt, the ContinuationDriver never nudges it
   * (autoContinue false), and its run.status / run.title / run.finalized / run.usage / run.cost / plan.updated /
   * staffing.updated events are dropped by the wrapper (it reads 'idle' and the end of the session as "the report is
   * done"). Its getStaffing / updateStaffing are stubs, like getPlan / updatePlan: nothing reaches the parent run.
   */
  bridgedChild?: {
    /** The harness agent id the child's root appears under in the parent run. */
    agentId: string
    /** The parent agent that delegated (ROOT_AGENT_ID or a report's id). */
    parentAgentId: string
    roleId: string
  }
}

/** RuntimeContext.bridge.roles() entry. */
export interface BridgedRole {
  roleId: string
  slug: string
  name: string
  connection: ConnectionId
  /** connectionName(connection, settings), e.g. "OpenAI" or a proxy's name. Not a secret. */
  connectionName: string
  adapter: ProviderId
}

/** RuntimeContext.bridge.spawn input. `brief` is the delegating agent's text, passed to the child as its first message. */
export interface BridgeSpawnInput {
  /** Role id or slug of a bridged role. */
  role: string
  brief: string
  /** Requested handle (unique across the run; generated as <slug>-<n> when missing, network.ts spawnHandle). */
  name?: string
  /** One line shown as the agent's first activity. */
  description?: string
  /** The delegating agent (HarnessToolCaller.agentId); missing = the root. */
  parentAgentId?: string
  /** The delegating agent's role (HarnessToolCaller.roleId); missing = the root role. */
  parentRoleId?: string
  /** The delegating tool call's id when the adapter knows it (AgentInstance.spawnToolUseId). */
  toolUseId?: string
  /**
   * Called synchronously once the child's agent exists (before its first turn), so an asynchronous caller (Codex
   * spawn_agent) can answer its tool call with the handle at once.
   */
  onStarted?(info: { agentId: string; handle: string }): void
}

/** RuntimeContext.bridge.spawn result. `text` is the child's final text (at most BRIDGE_RESULT_MAX_CHARS) or the failure text. */
export interface BridgeSpawnResult {
  agentId: string
  handle: string
  text: string
  ok: boolean
  /** Set when the harness stopped the child (an interrupt or the run's end, BridgedSessions.stopAll), not the child itself. */
  stopped?: boolean
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
  /** Change only the root model at a safe boundary; refuse without changing state when unsafe. */
  switchModel?(input: { model: string; connection?: RunConnection }): Promise<void>
  /**
   * Change the live session's permission mode (RunManager.setPermissionMode, desktop runs:setPermissionMode only).
   * `mode` is already validated by RunManager (runPermissionModeChoices, never on setup-like or exec runs). Before it
   * calls it, RunManager has already set ctx.project to a copy with `permissionMode: mode`, so the adapter's existing
   * mode mapping (Claude: claudePermissionMode / claudeAllowsBypass; Codex: its sandbox / approval mapping) reads the
   * new value; on false or a throw RunManager restores the previous ctx.project. The adapter applies the mapped mode to
   * the root session and to agents it spawns from now on (live reports keep theirs where the provider cannot change
   * them). Open permission cards stay open for the user; session-only grants are untouched. Resolve true when applied;
   * false (or throw) to refuse, e.g. when the provider cannot switch now. Missing = this session cannot switch live
   * (RunManager answers applied: false and changes nothing).
   */
  setPermissionMode?(mode: PermissionMode): Promise<boolean>
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
  /**
   * Deliver a harness message to the root orchestrator and wake it if idle, through the adapter's existing harness-message
   * path (Claude: notifyOrchestrator). It is not an auto-continue and writes no user block. RunManager uses it for the
   * exec root's one delegation correction. Missing = the adapter cannot, and no correction is sent.
   */
  nudge?(text: string): Promise<void>
  /** Headless exec settlement view (cli-spec 6.2(2)). Missing = the adapter cannot report it (treated as not settled). */
  settlement?(): SessionSettlement
}

/** What a completion check answers (DelegationLedger.completion). */
export interface DelegationCompletion {
  action: 'allow' | 'wait' | 'correct' | 'fail' | 'none'
  /** The correction / wait text to send the agent. */
  text?: string
  verdict?: DelegationVerdict
  /** On 'fail': what is missing, in words ("policy never spawned; evidence ended without a report"). */
  missing?: string
}

/** RuntimeContext.delegation: the host-owned ledger as the adapters see it. RunManager forces canCorrect / canWait false while the run is held, limited or stopping. */
export interface DelegationGate {
  noteSpawn(childId: string, parentId: string, roleId: string): void
  /** An agent tries to finish. `provisional`: decide without recording the agent as done (the root's complete_plan). */
  completion(agentId: string, opts: { canCorrect: boolean; canWait: boolean; reportText: string; provisional?: boolean }): DelegationCompletion
  /** The agent ended (interrupted, failed, removed) without completing. */
  ended(agentId: string): void
  /** A done or ended agent was resumed (its lead messaged it): it works again and its next completion is evaluated afresh. */
  resumed(agentId: string): void
  /** The adapter confirmed the child's report reached its parent. */
  delivered(childId: string): void
  /** The receipt (+ failure) line to place before the child's report; undefined when the child has no obligations. */
  receiptText(childId: string): string | undefined
  /** A native (non-harness) spawn attempt: returns the agent's strike count. */
  nativeStrike(agentId: string): number
}

/** One root turn end, reported through RuntimeContext.onRootTurnEnded. */
export interface RootTurnEnd {
  /** The adapter's own monotonic root-turn counter: 1 for the first root turn end of the session. */
  turnGen: number
  ok: boolean
  /** The SDK result subtype, e.g. 'error_max_turns', 'error_during_execution', 'error_max_budget_usd', or 'failed' for a Codex failed turn. */
  errorSubtype?: string
  isAuthError?: boolean
  /** The turn ended on a usage limit: the run is about to pause, not fail. */
  limited?: boolean
  /** The user interrupted the turn. */
  interrupted?: boolean
}

/** Why RuntimeContext.noteActivity was called. */
export type ExecActivityReason = 'subagent' | 'report' | 'integration' | 'continuation' | 'restart' | 'message'

/** RuntimeSession.settlement(): what the adapter knows about being done (cli-spec 6.2(2)). */
export interface SessionSettlement {
  /** The newest root turn generation the adapter reported through onRootTurnEnded. */
  rootTurnGen: number
  /** The root agent is idle (no turn running). */
  rootIdle: boolean
  /** ContinuationDriver.isSettledForTurn(rootTurnGen): no timer, no evaluation in flight, that turn evaluated. */
  continuationSettled: boolean
  /** The turn-1 set-plan nudge was sent (ContinuationDriver.nudgeTurn1Sent). */
  nudgeTurn1Sent: boolean
  /**
   * Nothing adapter-internal pending: no deferred turn end or MCP / app-server restart pending, no background tasks,
   * no queued harness or user messages, no turn in flight, and integrator.hasPendingWork() false.
   */
  quiescent: boolean
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
