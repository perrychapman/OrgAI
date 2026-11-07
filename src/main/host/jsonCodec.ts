/**
 * JSON codec for the host socket (cli-spec 3.3(1), "Safe JSON Reviver & Per-Field Clearable/Nullable Codec").
 *
 * Electron IPC uses structured clone, which keeps an own property whose value is `undefined`; JSON drops it. Several
 * handlers clear an optional field exactly that way (settings:set merges onto the stored settings, so a missing key
 * keeps the stored value while `{ key: undefined }` clears it). Over JSON-RPC such a field travels as `null`, and this
 * module turns it back into an own `undefined` property on the host side. Fields where `null` is itself a domain value
 * (connections:setDefault(null), a setSecret `value: null`) are listed as nullable and never touched.
 *
 * Standalone and pure: no electron import, no file I/O. Wave 1's src/main/host/registry.ts imports it.
 */
import { HOST_IPC, IPC, KIT_IPC, MCP_SCOPE_IPC, OUTPUTS_IPC, SECRETS_IPC, TEAM_FILES_IPC } from '../../shared/types'

// ---------- Safe parse / stringify ----------

/** Keys the reviver removes at every depth (prototype pollution through a later merge or Object.assign). */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * JSON.parse with a reviver that drops `__proto__`, `constructor` and `prototype` own keys at every depth. JSON.parse
 * defines `__proto__` as an own data property (it never sets the prototype), and a reviver returning undefined deletes
 * the key, so the parsed tree has none of them and no prototype is touched.
 */
export function parseJsonSafe(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => (FORBIDDEN_KEYS.has(key) ? undefined : value))
}

/** JSON.stringify that refuses a bigint, a function, a symbol or a circular structure with a clear error. */
export function stringifyJson(value: unknown): string {
  const stack: object[] = []
  const check = (v: unknown, path: string): void => {
    if (typeof v === 'bigint') throw new Error(`Cannot send a bigint as JSON (at ${path || 'the top level'}).`)
    if (typeof v === 'function') throw new Error(`Cannot send a function as JSON (at ${path || 'the top level'}).`)
    if (typeof v === 'symbol') throw new Error(`Cannot send a symbol as JSON (at ${path || 'the top level'}).`)
    if (v === null || typeof v !== 'object') return
    if (stack.includes(v)) throw new Error(`Cannot send a circular structure as JSON (at ${path || 'the top level'}).`)
    // toJSON (Date and friends) decides its own shape; JSON.stringify calls it.
    if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return
    stack.push(v)
    if (Array.isArray(v)) v.forEach((item, i) => check(item, `${path}[${i}]`))
    else for (const [k, item] of Object.entries(v)) check(item, path ? `${path}.${k}` : k)
    stack.pop()
  }
  check(value, '')
  const out = JSON.stringify(value)
  if (out === undefined) throw new Error('Cannot send undefined as JSON.')
  return out
}

// ---------- Channels ----------

/**
 * A field of a request's FIRST argument: '' is the whole argument, 'a.b' a nested own property, and a segment '[]'
 * means "every element of this array" (e.g. 'roles.[].reportsTo').
 */
export type FieldPath = string

export interface ChannelJsonFields {
  /** Literal null is a domain value: kept as null both ways. Documentation for the Wave 1 validators. */
  nullable?: readonly FieldPath[]
  /** An own `undefined` (structured clone) travels as null and decodes back to an own `undefined` property. */
  clearable?: readonly FieldPath[]
  /** Anything a JSON client should know about this channel's payload. */
  note?: string
}

/**
 * The 12 main -> renderer push channels (cli-spec 3.3(3)). They carry no request; Wave 1 routes them through
 * host.subscribe / runs:subscribe (or keeps them desktop-only).
 */
export const PUSH_CHANNELS: readonly string[] = [
  IPC.runEvent,
  IPC.settingsChanged,
  IPC.connectionsEvent,
  IPC.mcpLibraryChanged,
  IPC.skillLibraryChanged,
  IPC.capabilitiesProgress,
  IPC.capabilitiesReviewUpdated,
  IPC.projectsEngagementChanged,
  IPC.appFocusRun,
  IPC.menuAction,
  IPC.projectsCloneProgress,
  TEAM_FILES_IPC.teamFilesChanged,
  IPC.appNavigate,
  OUTPUTS_IPC.outputsChanged
]

/**
 * Every channel value the host knows: IPC (with TEMPLATE_ENGAGEMENT_IPC and KNOWLEDGE_IPC), MCP_SCOPE_IPC, KIT_IPC,
 * HOST_IPC, SECRETS_IPC (Wave 7).
 */
export function allChannels(): string[] {
  return [...Object.values(IPC), ...Object.values(MCP_SCOPE_IPC), ...Object.values(KIT_IPC), ...Object.values(TEAM_FILES_IPC), ...Object.values(OUTPUTS_IPC), ...Object.values(HOST_IPC), ...Object.values(SECRETS_IPC)]
}

/** Every request channel: allChannels() minus PUSH_CHANNELS. */
export function requestChannels(): string[] {
  const push = new Set(PUSH_CHANNELS)
  return allChannels().filter((c) => !push.has(c))
}

/**
 * AppSettings fields settings:set lets an own `undefined` clear (ipc.ts settingsSetArgs merges `{ ...stored, ...rest }`
 * and lets undefined through while it drops a null whose kind differs from the stored value's). The spec's
 * `defaultProjectDir` does not exist on AppSettings; these are the real optional fields. The main-owned optional
 * fields (defaultConnectionChosen, defaultConnectionReplaced) are always overwritten by settingsSetArgs and left out.
 */
const SETTINGS_CLEARABLE: readonly FieldPath[] = [
  'defaultMaxBudgetUsd',
  'skillAssistModel',
  'quickRunModel',
  'notifications',
  'communityPrices',
  // SettingsStore.set: an undefined modelPrices keeps the stored overrides (same as the renderer's undefined).
  'modelPrices'
]

/**
 * Optional top-level Project fields the renderer clears with undefined (projects:save -> ProjectStore.saveFromRenderer
 * saves the sent object as the whole project, so an own undefined and a missing key both clear; listed so a JSON
 * client can say "clear" with null). `permissionMode` is required on Project but named by the spec; a null there
 * decodes to undefined and ProjectStore / the Wave 1 validator decides. The spec's `defaultTier` and
 * `worktreeSetupCommand` do not exist on Project. kind, mcpServers, plugins and skills are listed for completeness:
 * saveFromRenderer always keeps the stored values.
 */
const PROJECT_CLEARABLE: readonly FieldPath[] = [
  'kind',
  'referenceDirectories',
  'client',
  'allowedDirectories',
  'permissionMode',
  'maxBudgetUsd',
  'maxSubagentDepth',
  'maxConcurrentSubagents',
  'isolateWriters',
  'reviewMerges',
  'keepRuns',
  'maxWindowShare',
  'preferEverydayNearLimit',
  'preferSonnetNearLimit',
  'autoContinue',
  'maxAutoContinues',
  'runMessaging',
  'mcpServers',
  'plugins',
  'skills',
  'skillEvaluation',
  'teamReview',
  'setup'
]

/**
 * ProviderConnection fields connections:update clears (ConnectionService.update saves the sent record whole through
 * SettingsStore.set -> normalizeConnections). A proxy's `anthropicBaseUrl` is a required string ('' = unset): undefined
 * normalizes to the default ''. A tierModels entry left undefined means "no model for this tier".
 */
const CONNECTION_CLEARABLE: readonly FieldPath[] = [
  'anthropicBaseUrl',
  'openaiBaseUrl',
  'modelsUrl',
  'autoTiers',
  'tierModels.top',
  'tierModels.deep',
  'tierModels.everyday',
  'tierModels.fast'
]

const IMAGES_NOTE = 'images[].data is base64 text; a bulk channel (RPC_BULK_CHANNELS).'

/**
 * Per request channel: which fields of the first argument are nullable or clearable. Every request channel has an
 * entry (empty `{}` when nothing needs the codec), so Wave 1's registry stays exhaustive. Each entry names its source.
 */
export const CHANNEL_JSON_FIELDS: Readonly<Record<string, ChannelJsonFields>> = {
  // ---- templates and engagement (TEMPLATE_ENGAGEMENT_IPC; ipc.ts registerTemplateEngagementIpc, templateEngagementArgs) ----
  'templates:list': {}, // templates.list()
  'templates:saveFromProject': {}, // templateEngagementArgs.saveTemplate
  'templates:remove': {}, // templateEngagementArgs.templateId
  'templates:apply': {}, // templateEngagementArgs.applyTemplate
  'projects:engagementDocument': {}, // templateEngagementArgs.projectId
  'projects:updateEngagementDocument': {}, // templateEngagementArgs (expectedUpdatedAt refuses a stale save)
  'projects:listNotes': {}, // listNotes(dataDir, projectId)
  'projects:getNote': {}, // templateEngagementArgs
  'projects:saveNote': {}, // templateEngagementArgs
  'projects:removeNote': {}, // templateEngagementArgs
  'runs:usageCsv': { note: 'Returns CSV text (a string), JSON safe.' }, // runs.usageCsv(UsageStatsQuery)
  'projects:removePreview': {}, // projectRemoveArgs

  // ---- knowledge (KNOWLEDGE_IPC; ipc.ts registerKnowledgeIpc, knowledgeArgs) ----
  'knowledge:get': { note: 'Bulk response (a graph up to KNOWLEDGE_FILE_MAX_BYTES).' }, // knowledgeArgs.projectId
  // knowledgeArgs.saveNode treats facts: null like an omitted list (keeps the facts); a null aliases / summary / noteIds
  // is refused by optionalText / optionalTextList. appendFacts / expectedUpdatedAt are plain values.
  'knowledge:saveNode': {},
  'knowledge:removeNode': {}, // knowledgeArgs.itemRef
  'knowledge:saveEdge': {}, // knowledgeArgs.saveEdge
  'knowledge:removeEdge': {}, // knowledgeArgs.itemRef
  'knowledge:clear': {}, // knowledgeArgs.projectId
  'knowledge:inferredLinks': {}, // knowledgeArgs.projectId -> KnowledgeInferredResult
  'knowledge:dismissLink': {}, // knowledgeArgs.dismissLink

  // ---- projects ----
  'projects:list': {}, // projects.list()
  'projects:get': {}, // projectOrHarness(id)
  'projects:create': {}, // ProjectStore.create(ProjectCreateInput) builds the project; missing = undefined
  // projects:save -> ProjectStore.saveFromRenderer. Role.reportsTo null is the root's domain value.
  'projects:save': { clearable: PROJECT_CLEARABLE, nullable: ['roles.[].reportsTo'] },
  'projects:remove': {}, // projectRemoveArgs (string id or ProjectRemoveInput)
  'projects:pickDirectory': { note: 'Opens a native dialog in the desktop app; returns a path or null.' },
  // REPO_CLONE_IPC (ipc.ts registerRepoIpc): desktop only; progress and cancel-on-close use the IPC sender.
  'projects:parseRepoSource': { note: 'Desktop only.' }, // text -> RepoSourceParse
  'projects:repoTools': { note: 'Desktop only.' }, // -> RepoTools
  'projects:cloneRepo': { note: 'Desktop only; progress arrives on projects:cloneProgress to the calling window.' }, // repoCloneArgs
  'projects:cancelClone': { note: 'Desktop only.' }, // repoCancelArg
  'projects:checkPath': {}, // importer / checkPath(path)
  'projects:scanAgents': {}, // importer.scan(path)
  'projects:previewImport': {}, // importer.preview(AgentImportInput)
  'projects:applyImport': {}, // importer.apply(AgentImportApplyInput); result previousRoles carry reportsTo null
  'projects:exportOrg': {}, // importer.exportOrg(projectId)
  'projects:remapModels': {}, // connections.remapModels(RemapModelsInput)
  'projects:previewRemap': {}, // connections.previewRemap(RemapModelsInput)
  'draft:orgChart': {}, // draft(DraftRequest)

  // ---- runs ----
  'runs:start': { note: IMAGES_NOTE }, // runs.start(StartRunInput)
  'runs:send': { note: IMAGES_NOTE }, // runs.send(runId, text, images)
  'runs:interrupt': {}, // runs.interrupt(runId)
  'runs:stop': {}, // runs.stop(runId)
  'runs:list': {}, // runs.list(projectId)
  'runs:get': { note: 'Bulk response: a RunRecord may carry base64 user images.' }, // runs.get(runId)
  'runs:decide': {}, // runs.decide(runId, requestId, PermissionDecision)
  'runs:continue': { note: IMAGES_NOTE }, // runs.continueRun(project, runId, text, images)
  'runs:resumeNow': {}, // runs.resumeNow(runId)
  'runs:cancelAutoResume': {}, // runs.cancelAutoResume(runId)
  'runs:listLive': {}, // runs.liveRuns()
  'runs:pendingCards': { note: 'Response cards may carry SettingsProposalPayload.maxBudgetUsd: null (domain null, kept by JSON).' },
  'runs:usageStats': {}, // runs.usageStats(UsageStatsQuery)
  'runs:startQuick': { note: IMAGES_NOTE }, // quickArgs.start
  'runs:promoteQuick': {}, // quickArgs.promote
  'window:openRun': { note: 'Opens a desktop window; desktop only.' }, // checkRunTarget(FocusRunTarget)

  // ---- setup, maintenance, merges ----
  'setup:start': {}, // setup.start(SetupStartInput)
  'setup:retro': {}, // { projectId, runId }
  'setup:decide': {}, // proposalDecideArgs (SettingsProposalPayload never travels in a request)
  'setup:answer': {}, // runs.answerQuestion(runId, questionId, QuestionAnswer)
  'maintenance:listWorktrees': {}, // maintenance.listWorktrees(projectId)
  'maintenance:integrateWorktree': {}, // { projectId, branch }
  'maintenance:discardWorktree': {}, // { projectId, branch }
  'maintenance:uninstallRepo': {}, // maintenance.uninstallRepo(projectId)
  'maintenance:diff': {}, // { projectId, branch }
  'merges:decide': {}, // runs.decideMerge(runId, reviewId, MergeDecision)

  // ---- app, settings, menu ----
  'auth:status': {}, // AuthStatusResult
  'settings:get': {}, // settingsInfo()
  'settings:set': { clearable: SETTINGS_CLEARABLE }, // settingsSetArgs
  'app:openPath': {}, // openPathRefusal; returns '' or a refusal string
  'menu:setState': { note: 'Per-window menu state; desktop only.' }, // cleanMenuState
  'app:setNotifications': {}, // boolean
  'usage:refresh': {}, // UsageMonitor refresh (handler in index.ts)
  'app:openLogs': {}, // shell.openPath(logsDir)
  'app:cliShimStatus': {}, // desktop only (cli-spec 7(3))
  'app:installCliShim': {}, // desktop only
  'app:uninstallCliShim': {}, // desktop only
  'app:logPath': {}, // logPath()
  'app:info': {}, // buildAppInfo
  'app:reference': {}, // appReferenceArgs: optional fields are left out

  // ---- permissions ----
  'permissions:list': {}, // projectRulesFile + readRules
  'permissions:ignored': {}, // projectRulesFile + listIgnoredRules
  'projects:folderConfig': {}, // folderConfigProjectArg + folderConfigReview
  'projects:setFolderConfigTrust': {}, // folderConfigTrustArgs + applyFolderConfigTrust (desktop only)
  // ---- team files (TEAM_FILES_IPC; teamFilesArgs) ----
  'teamFiles:status': {}, // may write the files on the first call of a code project
  'teamFiles:listAttention': {},
  'teamFiles:approve': {}, // desktop only
  'teamFiles:reject': {},
  'teamFiles:undo': {},
  'teamFiles:commit': {},
  'teamFiles:enable': {},
  // ---- run outputs (OUTPUTS_IPC; outputArgs rebuilds each input). Optional fields are left out or sent as undefined by a
  // client, never meaningful as null: outputArgs treats undefined and null alike (so nothing needs decoding), except
  // where listed as clearable below. ----
  'outputs:list': {},
  'outputs:preview': { clearable: ['version'], note: 'version missing or null = the current version' },
  'outputs:forget': {},
  'outputs:delete': { clearable: ['expectedVersionCount'] },
  'outputs:open': {}, // desktop only
  'outputs:reveal': {}, // desktop only
  'outputs:saveAs': {}, // desktop only
  'outputs:saveImage': {}, // desktop only
  'outputs:deletePreview': {},
  'outputs:versions': {},
  'outputs:readSource': {},
  'outputs:thumb': {},
  'outputs:compare': {},
  'outputs:notes': {},
  'outputs:revisions': {},
  'outputs:reviseOptions': {},
  'outputs:saveEdit': { clearable: ['forceNew'] },
  'outputs:restore': {},
  'outputs:update': { clearable: ['title', 'description', 'versionLabel'], note: 'an absent field is unchanged; description / label "" clears' },
  'outputs:noteAdd': {},
  'outputs:noteUpdate': { clearable: ['text', 'status'] },
  'outputs:noteRemove': {},
  'outputs:revise': { clearable: ['anchor', 'noteIds'] },
  'outputs:watch': {},
  'outputs:unwatch': {},
  'permissions:remove': {}, // permissionRuleArgs
  'permissions:add': {}, // permissionRuleArgs + permissionAddRefusal
  'permissions:decideRequest': {}, // runs.decideRules(runId, requestId, PermissionRuleDecision)

  // ---- connections and models (ipc.ts registerConnectionIpc) ----
  'connections:list': {}, // connections.list()
  'connections:update': { clearable: CONNECTION_CLEARABLE }, // connectionIdArg + ConnectionService.update
  'connections:setSecret': { nullable: ['apiKey'] }, // connectionSecretArgs: null clears the stored key
  'connections:createProxy': {}, // proxyCreateArgs: optional fields are left out, never null
  'connections:removeProxy': {}, // proxyIdArg
  'connections:test': {}, // connectionIdArg
  'connections:connect': {}, // connectionIdArg
  'connections:login': { note: 'Two arguments: (id, method?).' }, // connections.login(id, method)
  'connections:cancelLogin': {}, // connections.cancelLogin(loginId)
  'connections:logout': {}, // connectionIdArg
  'connections:setDefault': { nullable: [''] }, // ConnectionDefaultInput: null returns to automatic
  'models:list': { nullable: [''] }, // modelsQueryArg: undefined or null = every enabled connection
  'models:refresh': { nullable: [''] }, // modelsQueryArg
  'models:prices': {}, // ModelPricesQuery

  // ---- MCP (ipc.ts registerMcpIpc) ----
  'mcp:list': {}, // mcp.list(projectId)
  'mcp:upsert': {}, // mcp.upsert(McpUpsertInput): the spec replaces the stored one (missing = undefined)
  'mcp:remove': {}, // { projectId, serverId }
  'mcp:setSecret': { nullable: ['value'] }, // mcpSecretArgs: value null deletes the stored value
  'mcp:test': {}, // { projectId, serverId }
  'mcp:registrySearch': {}, // McpRegistrySearchInput
  'mcp:answerInstall': {}, // runs.answerMcpInstall
  'mcp:startAssist': {}, // mcpAssistArgs
  'mcp:linkLibrary': {}, // McpLinkLibraryInput
  'mcp:promote': {}, // { projectId, serverId }
  'mcp:authorize': { note: 'Opens the system browser for OAuth.' }, // McpAuthorizeInput
  'mcp:cancelAuthorize': {}, // McpAuthTarget
  'mcp:revokeAuth': {}, // McpAuthTarget
  'mcpLibrary:list': {}, // mcp.libraryList()
  // mcp.libraryUpsert: an absent field keeps the stored value (perProjectSecrets / perProjectEnv); no null semantics.
  'mcpLibrary:upsert': {},
  'mcpLibrary:remove': {}, // { libraryId }
  'mcpLibrary:setSecret': { nullable: ['value'] }, // mcpLibrarySecretArgs: value null deletes the stored value
  'mcpLibrary:test': {}, // { libraryId }
  'connectors:list': {}, // mcp.connectorsList()
  'connectors:add': {}, // connectorArgs.add
  'connectors:setToken': { nullable: ['token'] }, // connectorArgs.setToken: token null clears it
  'plugins:upsert': {}, // PluginUpsertInput
  'plugins:remove': {}, // { projectId, pluginId }

  // ---- skills (ipc.ts registerSkillIpc) ----
  'skills:list': {}, // projectIdArg
  'skills:read': {}, // projectSkill
  'skills:create': {}, // withProject<SkillCreateInput>
  'skills:update': {}, // withProject<SkillUpdateInput>
  'skills:remove': {}, // projectSkill
  'skills:linkLibrary': {}, // withProject
  'skills:promote': {}, // projectSkill
  'skills:previewImport': {}, // withProject<SkillImportInput>
  'skills:applyImport': {}, // withProject<SkillImportApplyInput>
  'skills:undoImport': {}, // projectIdArg
  'skills:evaluate': {}, // evaluation.evaluate(projectId)
  'skills:lastEvaluation': {}, // evaluation.last(projectId); returns a report or null
  'skills:applySuggestion': {}, // withProject
  'skills:startAssist': {}, // skillAssistArgs
  'skillLibrary:list': {}, // skills.libraryList()
  'skillLibrary:read': {}, // libraryArg
  'skillLibrary:create': {}, // obj<SkillDraft>
  'skillLibrary:addFromFolder': { note: 'Accepts only a path from the desktop folder picker (wasPickedFolder).' },
  'skillLibrary:update': {}, // libraryArg + draft
  'skillLibrary:remove': {}, // libraryArg

  // ---- Team assistant (ipc.ts registerCapabilityIpc, capabilityArgs) ----
  'capabilities:discover': {}, // capabilityArgs.discover
  'capabilities:recommend': {}, // capabilityArgs.recommend
  'capabilities:cancel': {}, // { requestId }
  'capabilities:apply': {}, // capabilityArgs.apply
  'capabilities:undo': {}, // capabilityArgs.undo
  'capabilities:review': {}, // capabilityArgs.review
  'capabilities:lastReview': {}, // projectIdArg; returns a review or null
  'capabilities:dismiss': {}, // capabilityArgs.dismiss
  'capabilities:restore': {}, // capabilityArgs.restore

  // ---- MCP_SCOPE_IPC ----
  'mcp:copyFromLibrary': {}, // mcpCopyArgs
  'mcp:setProjectOverrides': {}, // mcpOverridesArgs: an absent env / headers map is left alone
  'connectorPresets:list': {}, // mcp.connectorPresetsList()
  'connectorPresets:upsert': {}, // validateUserPreset
  'connectorPresets:remove': {}, // presetRemoveArgs

  // ---- KIT_IPC (ipc.ts registerKitIpc) ----
  'kit:pickExportPath': { note: 'Native save dialog; desktop only. Socket clients use kit:exportBundle.' },
  'kit:pickImportPath': { note: 'Native open dialog; desktop only. Socket clients use kit:previewBundle.' },
  'kit:export': {}, // PickedPaths-checked KitExportInput
  'kit:previewImport': {}, // KitPreviewInput
  'kit:applyImport': {}, // KitApplyInput

  // ---- HOST_IPC (socket only; handlers land in Wave 1) ----
  'runs:subscribe': {}, // RunsSubscribeInput
  'skillLibrary:addFromBundle': { note: 'files[].base64 is base64 text; bulk.' }, // SkillBundleInput
  'kit:exportBundle': { note: 'Response rawBytesBase64 is base64 text; bulk.' }, // KitBundleExportInput
  'kit:previewBundle': { note: 'rawBytesBase64 is base64 text; bulk.' }, // KitBundlePreviewInput
  'kit:applyBundle': { note: 'rawBytesBase64 is base64 text; bulk. stale_target_digest on a moved destination.' }, // KitBundleApplyInput
  'runs:findDecision': {}, // [requestId] -> DecisionLookup

  // ---- SECRETS_IPC (Wave 7; never a secret value either way) ----
  'secrets:status': {}, // [SecretsStatusInput?] -> SecretsStatusResult
  'secrets:init': {}, // [SecretsInitInput?] -> SecretsInitResult
  'secrets:reset': {}, // [SecretsResetInput] -> SecretsResetResult
  'secrets:undelete': {}, // [SecretsUndeleteInput] -> SecretsUndeleteResult
  'secrets:confirmDelete': {} // [SecretsConfirmDeleteInput] -> SecretsConfirmDeleteResult
}

// ---------- encode / decode ----------

function fieldsOf(channel: string): ChannelJsonFields {
  if (!Object.hasOwn(CHANNEL_JSON_FIELDS, channel)) {
    const err = new Error(`Unknown channel: ${channel}`) as Error & { code: string }
    err.code = 'unknown_channel'
    throw err
  }
  return CHANNEL_JSON_FIELDS[channel]
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Copy-on-write rewrite of `value` at `segments`: an own property at the end of the path that is exactly `from`
 * becomes an own property `to`. Containers on the path are copied only when something below them changed.
 */
function rewrite(value: unknown, segments: readonly string[], from: unknown, to: unknown): unknown {
  if (segments.length === 0) return value
  const [head, ...rest] = segments
  if (head === '[]') {
    if (!Array.isArray(value)) return value
    let changed = false
    const out = value.map((item) => {
      const next = rewrite(item, rest, from, to)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  if (!isPlainObject(value) || !Object.hasOwn(value, head)) return value
  const current = value[head]
  if (rest.length === 0) {
    if (current !== from) return value
    return { ...value, [head]: to }
  }
  const next = rewrite(current, rest, from, to)
  return next === current ? value : { ...value, [head]: next }
}

function applyClearable(channel: string, args: unknown[], from: unknown, to: unknown): unknown[] {
  if (!Array.isArray(args)) throw new Error('Request arguments must be an array.')
  const clearable = fieldsOf(channel).clearable ?? []
  if (clearable.length === 0 || args.length === 0) return args.slice()
  let first = args[0]
  for (const path of clearable) {
    if (path === '') {
      if (first === from) first = to
      continue
    }
    first = rewrite(first, path.split('.'), from, to)
  }
  const out = args.slice()
  out[0] = first
  return out
}

/**
 * Client side: for each clearable path of `channel`, an own property whose value is undefined becomes null. Nothing
 * else changes, and the input is never mutated. Unknown channels throw (code 'unknown_channel').
 */
export function encodeRequest(channel: string, args: unknown[]): unknown[] {
  return applyClearable(channel, args, undefined, null)
}

/**
 * Host side: for each clearable path of `channel`, null becomes an own property set to undefined. Nullable paths keep
 * null, other nulls are left as they are (Wave 1 validators decide). Unknown channels throw an Error with
 * `code = 'unknown_channel'`. The input is never mutated.
 */
export function decodeRequest(channel: string, args: unknown[]): unknown[] {
  return applyClearable(channel, args, null, undefined)
}
