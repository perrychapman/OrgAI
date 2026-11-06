/**
 * Positional parameter specs of every request channel (cli-spec 3.3(3), Wave 1). A channel's params are exactly the
 * ipcRenderer.invoke arguments after the channel (src/preload/index.ts), and the specs follow the ipc.ts handler
 * signatures. They are shallow on purpose: type and arity only. The handlers' own arg builders (quickArgs,
 * knowledgeArgs, capabilityArgs, proposalDecideArgs, and for the decision cards and run messages
 * permissionDecideArgs, ruleDecideArgs, mergeDecideArgs, questionAnswerArgs, installAnswerArgs, startRunArgs,
 * runMessageArgs in args.ts) do the deep validation (a coded `bad_request` over RPC), so a spec never refuses something
 * the renderer legitimately sends.
 *
 * Electron-free; relative imports only. Only registry.ts (and its tests) read these.
 */
import { HOST_IPC, HOST_METHODS, IPC, KIT_IPC, MCP_SCOPE_IPC, TEAM_FILES_IPC } from '../../shared/types'
import type { ParamSpec } from './registry'

/** Ids from the renderer (newId() output, virtual project ids, older hand-made ids): windowScope.ts ID_PATTERN. */
export const PARAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

const NONE: readonly ParamSpec[] = []
/** A run, project or other stored id (checked against PARAM_ID_PATTERN). */
const ID: readonly ParamSpec[] = [{ kind: 'id' }]
const STRING: readonly ParamSpec[] = [{ kind: 'string' }]
const OBJECT: readonly ParamSpec[] = [{ kind: 'object' }]
/** An optional input object: left out, undefined (null over JSON, where an invoke(ch, undefined) arrives as [null]) or an object. modelsQueryArg reads undefined and null the same. */
const OPTIONAL_NULLABLE_OBJECT: readonly ParamSpec[] = [{ kind: 'object', optional: true, nullable: true }]
/** projectRemoveArgs: a project id string or ProjectRemoveInput. */
const ID_OR_INPUT: readonly ParamSpec[] = [{ kind: 'stringOrObject' }]

/** Params of every request channel, keyed by channel. registry.ts attaches them to the entries. */
export const CHANNEL_PARAMS: Readonly<Record<string, readonly ParamSpec[]>> = {
  // ---- TEMPLATE_ENGAGEMENT_IPC ----
  [IPC.templatesList]: NONE,
  [IPC.templatesSaveFromProject]: OBJECT,
  // templateEngagementArgs.templateId (isSafeId; builtin template ids may differ from the run id shape).
  [IPC.templatesRemove]: STRING,
  [IPC.templatesApply]: OBJECT,
  [IPC.projectsEngagementDocument]: ID,
  [IPC.projectsUpdateEngagementDocument]: OBJECT,
  [IPC.projectsListNotes]: ID,
  [IPC.projectsGetNote]: OBJECT,
  [IPC.projectsSaveNote]: OBJECT,
  [IPC.projectsRemoveNote]: OBJECT,
  [IPC.runsUsageCsv]: OBJECT,
  [IPC.projectsRemovePreview]: ID_OR_INPUT,

  // ---- KNOWLEDGE_IPC ----
  [IPC.knowledgeGet]: ID,
  [IPC.knowledgeSaveNode]: OBJECT,
  [IPC.knowledgeRemoveNode]: OBJECT,
  [IPC.knowledgeSaveEdge]: OBJECT,
  [IPC.knowledgeRemoveEdge]: OBJECT,
  [IPC.knowledgeClear]: ID,
  [IPC.knowledgeInferredLinks]: ID,
  [IPC.knowledgeDismissLink]: OBJECT,

  // ---- projects ----
  [IPC.projectsList]: NONE,
  [IPC.projectsGet]: ID,
  [IPC.projectsCreate]: OBJECT,
  [IPC.projectsSave]: OBJECT,
  [IPC.projectsRemove]: ID_OR_INPUT,
  [IPC.projectsPickDir]: NONE,
  // A folder path (any text; checkPath never rejects).
  [IPC.projectsCheckPath]: STRING,
  [IPC.projectsScanAgents]: STRING,
  [IPC.projectsPreviewImport]: OBJECT,
  [IPC.projectsApplyImport]: OBJECT,
  [IPC.projectsExportOrg]: ID,
  [IPC.projectsRemapModels]: OBJECT,
  [IPC.projectsPreviewRemap]: OBJECT,
  [IPC.draftOrgChart]: OBJECT,

  // ---- runs ----
  [IPC.runsStart]: OBJECT,
  [IPC.runsSend]: OBJECT,
  [IPC.runsInterrupt]: ID,
  [IPC.runsStop]: ID,
  [IPC.runsList]: ID,
  [IPC.runsGet]: ID,
  [IPC.runsDecide]: OBJECT,
  [IPC.runsContinue]: OBJECT,
  [IPC.runsResumeNow]: ID,
  [IPC.runsCancelAutoResume]: ID,
  [IPC.runsListLive]: NONE,
  [IPC.runsPendingCards]: ID,
  [IPC.runsUsageStats]: OBJECT,
  [IPC.runsStartQuick]: OBJECT,
  [IPC.runsPromoteQuick]: OBJECT,
  [IPC.windowOpenRun]: OBJECT,

  // ---- setup, maintenance, merges ----
  [IPC.setupStart]: OBJECT,
  [IPC.setupRetro]: OBJECT,
  [IPC.setupDecide]: OBJECT,
  [IPC.setupAnswer]: OBJECT,
  [IPC.maintListWorktrees]: ID,
  [IPC.maintIntegrate]: OBJECT,
  [IPC.maintDiscard]: OBJECT,
  [IPC.maintUninstall]: ID,
  [IPC.maintDiff]: OBJECT,
  [IPC.mergesDecide]: OBJECT,

  // ---- app, settings, menu, usage ----
  [IPC.authStatus]: NONE,
  [IPC.settingsGet]: NONE,
  [IPC.settingsSet]: OBJECT,
  [IPC.appOpenPath]: STRING,
  [IPC.menuSetState]: OBJECT,
  // The handler coerces with !!enabled; desktop only, so the socket never validates it.
  [IPC.appSetNotifications]: [{ kind: 'any' }],
  [IPC.usageRefresh]: NONE,
  [IPC.appOpenLogs]: NONE,
  [IPC.appLogPath]: NONE,
  [IPC.appInfo]: NONE,
  // Desktop only (cli-spec 7(3), shimInstaller.ts); the socket refuses them before params.
  [IPC.appCliShimStatus]: NONE,
  [IPC.appInstallCliShim]: NONE,
  [IPC.appUninstallCliShim]: NONE,
  // Desktop only (REPO_CLONE_IPC, ipc.ts registerRepoIpc); the socket refuses them before params. The handlers coerce
  // or rebuild their input (parseSource takes any value, repoCloneArgs / repoCancelArg refuse a bad one).
  [IPC.projectsParseRepoSource]: [{ kind: 'any' }],
  [IPC.projectsRepoTools]: NONE,
  [IPC.projectsCloneRepo]: OBJECT,
  [IPC.projectsCancelClone]: [{ kind: 'any' }],

  // Folder config trust: folderConfigProjectArg / folderConfigTrustArgs rebuild the input.
  [IPC.projectsFolderConfig]: ID,
  [IPC.projectsSetFolderConfigTrust]: OBJECT,

  // ---- TEAM_FILES_IPC ---- (teamFilesArgs rebuilds each input: safe project id, 64-hex digest)
  [TEAM_FILES_IPC.teamFilesStatus]: OBJECT,
  [TEAM_FILES_IPC.teamFilesListAttention]: NONE,
  [TEAM_FILES_IPC.teamFilesApprove]: OBJECT,
  [TEAM_FILES_IPC.teamFilesReject]: OBJECT,
  [TEAM_FILES_IPC.teamFilesUndo]: OBJECT,
  [TEAM_FILES_IPC.teamFilesCommit]: OBJECT,
  [TEAM_FILES_IPC.teamFilesEnable]: OBJECT,

  // ---- permissions ----
  [IPC.permissionsList]: ID,
  [IPC.permissionsIgnored]: ID,
  [IPC.permissionsRemove]: OBJECT,
  [IPC.permissionsAdd]: OBJECT,
  [IPC.permissionsDecideRequest]: OBJECT,

  // ---- connections and models ----
  [IPC.connectionsList]: NONE,
  [IPC.connectionsUpdate]: OBJECT,
  [IPC.connectionsSetSecret]: OBJECT,
  // connectionIdArg checks the id against CONNECTION_IDS.
  [IPC.connectionsTest]: STRING,
  [IPC.connectionsConnect]: STRING,
  // (id, method?): the preload always passes both, so method may arrive as null over JSON.
  [IPC.connectionsLogin]: [{ kind: 'string' }, { kind: 'string', optional: true, nullable: true }],
  [IPC.connectionsCancelLogin]: STRING,
  [IPC.connectionsLogout]: STRING,
  // ConnectionDefaultInput: a connection id, or null for automatic.
  [IPC.connectionsSetDefault]: [{ kind: 'string', nullable: true }],
  [IPC.modelsList]: OPTIONAL_NULLABLE_OBJECT,
  [IPC.modelsRefresh]: OPTIONAL_NULLABLE_OBJECT,
  [IPC.modelsPrices]: OPTIONAL_NULLABLE_OBJECT,

  // ---- MCP ----
  [IPC.mcpList]: ID,
  [IPC.mcpUpsert]: OBJECT,
  [IPC.mcpRemove]: OBJECT,
  [IPC.mcpSetSecret]: OBJECT,
  [IPC.mcpTest]: OBJECT,
  [IPC.mcpRegistrySearch]: OBJECT,
  [IPC.mcpAnswerInstall]: OBJECT,
  [IPC.mcpStartAssist]: OBJECT,
  [IPC.mcpLinkLibrary]: OBJECT,
  [IPC.mcpPromote]: OBJECT,
  [IPC.mcpAuthorize]: OBJECT,
  [IPC.mcpCancelAuthorize]: OBJECT,
  [IPC.mcpRevokeAuth]: OBJECT,
  [IPC.mcpLibraryList]: NONE,
  [IPC.mcpLibraryUpsert]: OBJECT,
  [IPC.mcpLibraryRemove]: OBJECT,
  [IPC.mcpLibrarySetSecret]: OBJECT,
  [IPC.mcpLibraryTest]: OBJECT,
  [IPC.connectorsList]: NONE,
  [IPC.connectorsAdd]: OBJECT,
  [IPC.connectorsSetToken]: OBJECT,
  [IPC.pluginsUpsert]: OBJECT,
  [IPC.pluginsRemove]: OBJECT,

  // ---- skills ----
  [IPC.skillsList]: ID,
  [IPC.skillsRead]: OBJECT,
  [IPC.skillsCreate]: OBJECT,
  [IPC.skillsUpdate]: OBJECT,
  [IPC.skillsRemove]: OBJECT,
  [IPC.skillsLinkLibrary]: OBJECT,
  [IPC.skillsPromote]: OBJECT,
  [IPC.skillsPreviewImport]: OBJECT,
  [IPC.skillsApplyImport]: OBJECT,
  [IPC.skillsUndoImport]: OBJECT,
  [IPC.skillsEvaluate]: ID,
  [IPC.skillsLastEvaluation]: ID,
  [IPC.skillsApplySuggestion]: OBJECT,
  [IPC.skillsStartAssist]: OBJECT,
  [IPC.skillLibraryList]: NONE,
  [IPC.skillLibraryRead]: OBJECT,
  [IPC.skillLibraryCreate]: OBJECT,
  [IPC.skillLibraryAddFromFolder]: OBJECT,
  [IPC.skillLibraryUpdate]: OBJECT,
  [IPC.skillLibraryRemove]: OBJECT,

  // ---- Team assistant ----
  [IPC.capabilitiesDiscover]: OBJECT,
  [IPC.capabilitiesRecommend]: OBJECT,
  [IPC.capabilitiesCancel]: OBJECT,
  [IPC.capabilitiesApply]: OBJECT,
  [IPC.capabilitiesUndo]: OBJECT,
  [IPC.capabilitiesReview]: OBJECT,
  [IPC.capabilitiesLastReview]: ID,
  [IPC.capabilitiesDismiss]: OBJECT,
  [IPC.capabilitiesRestore]: OBJECT,

  // ---- MCP_SCOPE_IPC ----
  [MCP_SCOPE_IPC.mcpCopyFromLibrary]: OBJECT,
  [MCP_SCOPE_IPC.mcpSetProjectOverrides]: OBJECT,
  [MCP_SCOPE_IPC.connectorPresetsList]: NONE,
  [MCP_SCOPE_IPC.connectorPresetsUpsert]: OBJECT,
  [MCP_SCOPE_IPC.connectorPresetsRemove]: OBJECT,

  // ---- KIT_IPC ----
  [KIT_IPC.kitPickExportPath]: NONE,
  [KIT_IPC.kitPickImportPath]: NONE,
  [KIT_IPC.kitExport]: OBJECT,
  [KIT_IPC.kitPreviewImport]: OBJECT,
  [KIT_IPC.kitApplyImport]: OBJECT,

  // ---- HOST_IPC (socket only) ----
  // RunsSubscribeInput: every field is optional, so the whole input may be left out (or sent as null).
  [HOST_IPC.runsSubscribe]: OPTIONAL_NULLABLE_OBJECT,
  [HOST_IPC.skillLibraryAddFromBundle]: OBJECT,
  [HOST_IPC.kitExportBundle]: OBJECT,
  [HOST_IPC.kitPreviewBundle]: OBJECT,
  [HOST_IPC.kitApplyBundle]: OBJECT,
  // [requestId]
  [HOST_IPC.runsFindDecision]: STRING,

  // ---- host.* request methods (a plain-object params is normalized to [object] by the gate) ----
  [HOST_METHODS.hostStatus]: OPTIONAL_NULLABLE_OBJECT,
  [HOST_METHODS.hostSubscribe]: OBJECT,
  // HostStopInput: { force? }.
  [HOST_METHODS.hostStop]: OPTIONAL_NULLABLE_OBJECT
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Whether one non-null, non-undefined value has the spec's kind. */
export function matchesKind(spec: ParamSpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'any':
      return true
    case 'string':
      return typeof value === 'string'
    case 'id':
      return typeof value === 'string' && PARAM_ID_PATTERN.test(value)
    case 'object':
      return isPlainObject(value)
    case 'stringOrObject':
      return typeof value === 'string' || isPlainObject(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'array':
      return Array.isArray(value)
  }
}

const KIND_WORD: Record<ParamSpec['kind'], string> = {
  any: 'a value',
  string: 'a string',
  id: 'an id (letters, digits, _ or -, at most 128)',
  object: 'an object',
  stringOrObject: 'a string or an object',
  boolean: 'a boolean',
  number: 'a finite number',
  array: 'an array'
}

/**
 * Checks `args` against `specs`. Returns null when they fit, else a sentence naming the argument index. `undefined`
 * (a missing arg, or a clearable null the codec decoded) passes only on an optional spec; `null` only on a nullable
 * one.
 */
export function paramProblem(channel: string, specs: readonly ParamSpec[], args: readonly unknown[]): string | null {
  if (args.length > specs.length) {
    return `${channel} takes ${specs.length === 0 ? 'no arguments' : `at most ${specs.length} argument${specs.length === 1 ? '' : 's'}`}, got ${args.length}.`
  }
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const value = i < args.length ? args[i] : undefined
    if (value === undefined) {
      if (spec.optional || spec.kind === 'any') continue
      return `${channel} argument ${i} is required (${KIND_WORD[spec.kind]}).`
    }
    if (value === null) {
      if (spec.nullable || spec.kind === 'any') continue
      return `${channel} argument ${i} must be ${KIND_WORD[spec.kind]}, not null.`
    }
    if (!matchesKind(spec, value)) return `${channel} argument ${i} must be ${KIND_WORD[spec.kind]}.`
  }
  return null
}
