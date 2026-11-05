/**
 * The exhaustive host channel registry (cli-spec 3.3(3), Wave 1): every IPC, TEMPLATE_ENGAGEMENT_IPC, KNOWLEDGE_IPC,
 * MCP_SCOPE_IPC, KIT_IPC, HOST_IPC and SECRETS_IPC (Wave 7) channel plus the host.* protocol methods, with its scope,
 * bulk flag and param validators, and the RPC gate that refuses anything unmapped with `unknown_channel`.
 *
 * Scopes are copied from the spec's table (cli-spec 3.3(3)); registry.test.ts holds a second literal copy and compares.
 * Param specs live in params.ts, the clearable / nullable codec in jsonCodec.ts. Electron-free; relative imports only.
 */
import {
  HOST_IPC,
  HOST_METHODS,
  IPC,
  KIT_IPC,
  MCP_SCOPE_IPC,
  RPC_BULK_CHANNELS,
  RPC_BULK_FRAME_MAX_BYTES,
  RPC_CONTROL_REQUEST_MAX_BYTES,
  RPC_CONTROL_RESPONSE_MAX_BYTES,
  SECRETS_IPC,
  hostCanOpenWindows
} from '../../shared/types'
import type { HostKind, HostRpcError, HostRpcErrorCode, HostScope, HostSubscribeTopic } from '../../shared/types'
import { CHANNEL_JSON_FIELDS, decodeRequest } from './jsonCodec'
import { CHANNEL_PARAMS, paramProblem } from './params'
import { STORES_SECRET, type StoresSecretFn } from './storesSecret'

export type { StoresSecretFn, StoresSecretHostView } from './storesSecret'

/** A host RPC refusal: carries the wire error code (and retryAfterMs for host_starting / host_draining). */
export class HostRpcFailure extends Error {
  constructor(
    readonly code: HostRpcErrorCode,
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'HostRpcFailure'
  }

  toRpcError(): HostRpcError {
    return { code: this.code, message: this.message, ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}) }
  }
}

/** A request channel's scope; 'desktop_only' channels are refused over the socket. */
export type ChannelScope = HostScope | 'desktop_only'

/**
 * One positional parameter's shape check (params.ts matchesKind). 'id' is a string matching params.ts
 * PARAM_ID_PATTERN; 'stringOrObject' a string or a plain object (projects:remove takes an id or ProjectRemoveInput).
 */
export interface ParamSpec {
  kind: 'string' | 'id' | 'object' | 'stringOrObject' | 'boolean' | 'number' | 'array' | 'any'
  optional?: boolean
  nullable?: boolean
}

export interface RequestChannelEntry {
  direction: 'request'
  scope: ChannelScope
  /** Frames may reach RPC_BULK_FRAME_MAX_BYTES. */
  bulk: boolean
  /** Positional params (the ipcRenderer.invoke arguments after the channel). */
  params: readonly ParamSpec[]
  /** Served over the socket only (HOST_IPC); no ipcMain handler. */
  socketOnly?: true
  /** Answered by the socket transport itself, not the dispatcher (runs:subscribe, host.subscribe). */
  transport?: true
  /**
   * Needs a host that can open windows (HOST_KIND_CAPABILITIES canOpenWindows) and its DesktopHooks; refused with
   * desktop_unavailable otherwise (window:openRun).
   */
  desktopRequired?: true
  /**
   * Wave 7 (cli-standalone.md 5.6): true when this call will store a non-empty secret value; invokeRpc then awaits
   * SecretStore.prepareWrite() before the handler runs. Absent on channels that never store a secret (storesSecret.ts).
   */
  storesSecret?: StoresSecretFn
  /** Where the handler or constant lives, for readers. */
  source: string
}

export interface PushChannelEntry {
  direction: 'push'
  delivery: 'socket_subscribable' | 'desktop_only'
  /** Which subscription delivers it: a host.subscribe topic, or 'runs' (runs:subscribe). */
  topic?: HostSubscribeTopic | 'runs'
  source: string
}

/** A host.* method of the protocol itself (host.challenge, host.hello). */
export interface ProtocolMethodEntry {
  direction: 'protocol'
  source: string
}

export type ChannelEntry = RequestChannelEntry | PushChannelEntry | ProtocolMethodEntry

export interface GateContext {
  grantedScopes: readonly HostScope[]
  hostKind: HostKind
}

/** A request that passed the gate: positional args validated and decoded, and whether it counts as a mutation lease. */
export interface GatedRequest {
  channel: string
  args: unknown[]
  entry: RequestChannelEntry
  /** 'operate', 'decide' or 'configure' scope (an inFlightRpcMutations lease). */
  mutation: boolean
}

export type GateFn = (channel: string, params: unknown, ctx: GateContext) => GatedRequest

// ---------- The scope table (cli-spec 3.3(3), copied verbatim) ----------

/** Request channels per scope, exactly the spec table's rows. */
const SCOPE_TABLE: Readonly<Record<ChannelScope, readonly string[]>> = {
  read: [
    'host.status', 'host.subscribe', 'app:info', 'app:logPath', 'settings:get', 'auth:status', 'projects:list', 'projects:get',
    'projects:checkPath', 'projects:previewRemap', 'projects:scanAgents', 'projects:previewImport', 'projects:removePreview',
    'projects:engagementDocument', 'projects:listNotes', 'projects:getNote', 'runs:list', 'runs:get', 'runs:listLive',
    'runs:pendingCards', 'runs:usageStats', 'runs:usageCsv', 'runs:subscribe', 'runs:findDecision', 'permissions:list', 'connections:list',
    'models:list', 'models:prices', 'mcp:list', 'mcp:registrySearch', 'mcpLibrary:list', 'connectors:list',
    'connectorPresets:list', 'skills:list', 'skills:read', 'skills:previewImport', 'skills:lastEvaluation', 'skillLibrary:list',
    'skillLibrary:read', 'capabilities:lastReview', 'maintenance:listWorktrees', 'maintenance:diff', 'templates:list',
    'knowledge:get', 'knowledge:inferredLinks', 'kit:previewBundle', 'secrets:status'
  ],
  operate: [
    'runs:start', 'runs:startQuick', 'runs:continue', 'runs:send', 'runs:interrupt', 'runs:stop', 'runs:resumeNow',
    'runs:cancelAutoResume', 'setup:start', 'setup:retro', 'mcp:startAssist', 'skills:startAssist', 'usage:refresh',
    'connections:test', 'models:refresh', 'mcp:test', 'mcpLibrary:test', 'capabilities:discover', 'capabilities:recommend',
    'capabilities:cancel', 'capabilities:review', 'skills:evaluate', 'draft:orgChart', 'window:openRun'
  ],
  decide: ['runs:decide', 'permissions:decideRequest', 'setup:decide', 'setup:answer', 'merges:decide', 'mcp:answerInstall'],
  configure: [
    'host.stop', 'settings:set', 'projects:create', 'projects:save', 'projects:remove', 'projects:remapModels',
    'projects:applyImport', 'projects:exportOrg', 'projects:updateEngagementDocument', 'projects:saveNote',
    'projects:removeNote', 'runs:promoteQuick', 'permissions:add', 'permissions:remove', 'connections:connect',
    'connections:update', 'connections:setSecret', 'connections:login', 'connections:cancelLogin', 'connections:logout',
    'connections:setDefault', 'mcp:upsert', 'mcp:remove', 'mcp:setSecret', 'mcp:linkLibrary', 'mcp:promote', 'mcp:authorize',
    'mcp:cancelAuthorize', 'mcp:revokeAuth', 'mcp:copyFromLibrary', 'mcp:setProjectOverrides', 'mcpLibrary:upsert',
    'mcpLibrary:remove', 'mcpLibrary:setSecret', 'connectors:add', 'connectors:setToken', 'connectorPresets:upsert',
    'connectorPresets:remove', 'plugins:upsert', 'plugins:remove', 'skills:create', 'skills:update', 'skills:remove',
    'skills:linkLibrary', 'skills:promote', 'skills:applyImport', 'skills:undoImport', 'skills:applySuggestion',
    'skillLibrary:create', 'skillLibrary:addFromBundle', 'skillLibrary:update', 'skillLibrary:remove', 'capabilities:apply',
    'capabilities:undo', 'capabilities:dismiss', 'capabilities:restore', 'maintenance:integrateWorktree',
    'maintenance:discardWorktree', 'maintenance:uninstallRepo', 'templates:saveFromProject', 'templates:remove',
    'templates:apply', 'knowledge:saveNode', 'knowledge:removeNode', 'knowledge:saveEdge', 'knowledge:removeEdge',
    'knowledge:clear', 'knowledge:dismissLink', 'kit:exportBundle', 'kit:applyBundle', 'secrets:init', 'secrets:reset',
    'secrets:undelete', 'secrets:confirmDelete'
  ],
  desktop_only: [
    'projects:pickDirectory', 'skillLibrary:addFromFolder', 'kit:pickExportPath', 'kit:pickImportPath', 'kit:export',
    'kit:previewImport', 'kit:applyImport', 'menu:setState', 'app:openPath', 'app:openLogs', 'app:setNotifications',
    'app:cliShimStatus', 'app:installCliShim', 'app:uninstallCliShim', 'projects:parseRepoSource', 'projects:repoTools',
    'projects:cloneRepo', 'projects:cancelClone'
  ]
}

/** Push channels (cli-spec 3.3(3) push rows): delivery, the subscription that carries them, and their emitter today. */
const PUSH_TABLE: Readonly<Record<string, Omit<PushChannelEntry, 'direction'>>> = {
  [IPC.runEvent]: { delivery: 'socket_subscribable', topic: 'runs', source: 'index.ts broadcast (RunManager events) -> host/events.ts' },
  [IPC.settingsChanged]: { delivery: 'socket_subscribable', topic: 'settings', source: 'index.ts broadcastSettings -> host/events.ts' },
  [IPC.connectionsEvent]: { delivery: 'socket_subscribable', topic: 'connections', source: 'index.ts ConnectionService events -> host/events.ts' },
  [IPC.mcpLibraryChanged]: { delivery: 'socket_subscribable', topic: 'mcpLibrary', source: 'index.ts McpService onLibraryChanged -> host/events.ts' },
  [IPC.skillLibraryChanged]: { delivery: 'socket_subscribable', topic: 'skillLibrary', source: 'index.ts SkillService onLibraryChanged -> host/events.ts' },
  [IPC.capabilitiesProgress]: { delivery: 'socket_subscribable', topic: 'capabilities', source: 'index.ts CapabilityService onProgress -> host/events.ts' },
  [IPC.capabilitiesReviewUpdated]: { delivery: 'socket_subscribable', topic: 'capabilities', source: 'index.ts CapabilityService onReviewUpdated -> host/events.ts' },
  [IPC.projectsEngagementChanged]: { delivery: 'socket_subscribable', topic: 'engagement', source: 'host/dispatcher.ts + RunManager engagementChanged -> host/events.ts' },
  [IPC.appFocusRun]: { delivery: 'desktop_only', source: 'notifications.ts (notification click focuses a run)' },
  [IPC.menuAction]: { delivery: 'desktop_only', source: 'appMenu.ts (application menu item click)' },
  [IPC.projectsCloneProgress]: { delivery: 'desktop_only', source: 'ipc.ts registerRepoIpc (progress of a clone the window started)' }
}

/** Where each request channel is handled today (ipc.ts register functions; HOST_IPC and host.* are Wave 1 / 2). */
const SOURCE_TABLE: Readonly<Record<string, readonly string[]>> = {
  'ipc.ts registerKnowledgeIpc': [
    IPC.knowledgeGet, IPC.knowledgeSaveNode, IPC.knowledgeRemoveNode, IPC.knowledgeSaveEdge, IPC.knowledgeRemoveEdge, IPC.knowledgeClear,
    IPC.knowledgeInferredLinks, IPC.knowledgeDismissLink
  ],
  'ipc.ts registerTemplateEngagementIpc': [
    IPC.templatesList, IPC.templatesSaveFromProject, IPC.templatesRemove, IPC.templatesApply, IPC.projectsEngagementDocument,
    IPC.projectsUpdateEngagementDocument, IPC.projectsListNotes, IPC.projectsGetNote, IPC.projectsSaveNote, IPC.projectsRemoveNote
  ],
  'ipc.ts registerMcpIpc': [
    IPC.mcpList, IPC.mcpUpsert, IPC.mcpRemove, IPC.mcpSetSecret, IPC.mcpTest, IPC.mcpRegistrySearch, IPC.mcpAnswerInstall,
    IPC.mcpStartAssist, IPC.mcpLinkLibrary, IPC.mcpPromote, IPC.mcpAuthorize, IPC.mcpCancelAuthorize, IPC.mcpRevokeAuth,
    IPC.mcpLibraryList, IPC.mcpLibraryUpsert, IPC.mcpLibraryRemove, IPC.mcpLibrarySetSecret, IPC.mcpLibraryTest,
    IPC.connectorsList, IPC.connectorsAdd, IPC.connectorsSetToken, IPC.pluginsUpsert, IPC.pluginsRemove,
    MCP_SCOPE_IPC.mcpCopyFromLibrary, MCP_SCOPE_IPC.mcpSetProjectOverrides, MCP_SCOPE_IPC.connectorPresetsList,
    MCP_SCOPE_IPC.connectorPresetsUpsert, MCP_SCOPE_IPC.connectorPresetsRemove
  ],
  'ipc.ts registerSkillIpc': [
    IPC.skillsList, IPC.skillsRead, IPC.skillsCreate, IPC.skillsUpdate, IPC.skillsRemove, IPC.skillsLinkLibrary, IPC.skillsPromote,
    IPC.skillsPreviewImport, IPC.skillsApplyImport, IPC.skillsUndoImport, IPC.skillsEvaluate, IPC.skillsLastEvaluation,
    IPC.skillsApplySuggestion, IPC.skillLibraryList, IPC.skillLibraryRead, IPC.skillLibraryCreate, IPC.skillLibraryAddFromFolder,
    IPC.skillLibraryUpdate, IPC.skillLibraryRemove
  ],
  'ipc.ts registerCapabilityIpc': [
    IPC.capabilitiesDiscover, IPC.capabilitiesRecommend, IPC.capabilitiesCancel, IPC.capabilitiesApply, IPC.capabilitiesUndo,
    IPC.capabilitiesReview, IPC.capabilitiesLastReview, IPC.capabilitiesDismiss, IPC.capabilitiesRestore
  ],
  'ipc.ts registerConnectionIpc': [
    IPC.projectsRemapModels, IPC.projectsPreviewRemap, IPC.connectionsList, IPC.connectionsUpdate, IPC.connectionsSetSecret,
    IPC.connectionsTest, IPC.connectionsConnect, IPC.connectionsLogin, IPC.connectionsCancelLogin, IPC.connectionsLogout,
    IPC.connectionsSetDefault, IPC.modelsList, IPC.modelsRefresh, IPC.modelsPrices
  ],
  'ipc.ts registerKitIpc': [KIT_IPC.kitPickExportPath, KIT_IPC.kitPickImportPath, KIT_IPC.kitExport, KIT_IPC.kitPreviewImport, KIT_IPC.kitApplyImport],
  'ipc.ts registerIpc (UsageMonitor.refresh)': [IPC.usageRefresh],
  'ipc.ts desktop-only (shimInstaller.ts)': [IPC.appCliShimStatus, IPC.appInstallCliShim, IPC.appUninstallCliShim],
  'ipc.ts registerRepoIpc (desktop-only; repoClone.ts, progress and cancel-on-close use the IPC sender)': [
    IPC.projectsParseRepoSource, IPC.projectsRepoTools, IPC.projectsCloneRepo, IPC.projectsCancelClone
  ],
  'host dispatcher (HOST_IPC, socket only; skills/service.ts libraryAddFromBundle)': [HOST_IPC.skillLibraryAddFromBundle],
  'host dispatcher (HOST_IPC, socket only; kit/service.ts bundle channels)': [HOST_IPC.kitExportBundle, HOST_IPC.kitPreviewBundle, HOST_IPC.kitApplyBundle],
  'host dispatcher (HOST_IPC, socket only; RunManager.findDecision, cli-spec Wave 3)': [HOST_IPC.runsFindDecision],
  'host dispatcher (SECRETS_IPC; SecretStore vault, cli-standalone.md 5.6, Wave 7)': [
    SECRETS_IPC.secretsStatus, SECRETS_IPC.secretsInit, SECRETS_IPC.secretsReset, SECRETS_IPC.secretsUndelete,
    SECRETS_IPC.secretsConfirmDelete
  ],
  'socket transport (Wave 2 socketServer.ts; cli-spec 3.3(4).1)': [HOST_IPC.runsSubscribe],
  'socket transport (Wave 2 socketServer.ts; cli-spec 3.3(4).2)': [HOST_METHODS.hostSubscribe],
  'host dispatcher (HostControl.status, bootstrap.ts)': [HOST_METHODS.hostStatus],
  'host dispatcher (HostControl.stop, bootstrap.ts)': [HOST_METHODS.hostStop]
}

const HOST_IPC_VALUES: ReadonlySet<string> = new Set(Object.values(HOST_IPC))
const HOST_METHOD_VALUES: ReadonlySet<string> = new Set(Object.values(HOST_METHODS))
const TRANSPORT_CHANNELS: ReadonlySet<string> = new Set([HOST_IPC.runsSubscribe, HOST_METHODS.hostSubscribe])
const BULK: ReadonlySet<string> = new Set(RPC_BULK_CHANNELS)

function sourceOf(channel: string): string {
  for (const [source, channels] of Object.entries(SOURCE_TABLE)) if (channels.includes(channel)) return source
  return 'ipc.ts registerIpc'
}

function buildRegistry(): Record<string, ChannelEntry> {
  const out: Record<string, ChannelEntry> = Object.create(null)
  for (const [scope, channels] of Object.entries(SCOPE_TABLE) as [ChannelScope, readonly string[]][]) {
    for (const channel of channels) {
      if (out[channel]) throw new Error(`Host registry: ${channel} is listed twice`)
      const params = CHANNEL_PARAMS[channel]
      if (!params) throw new Error(`Host registry: ${channel} has no params spec`)
      const socketOnly = HOST_IPC_VALUES.has(channel) || HOST_METHOD_VALUES.has(channel)
      out[channel] = {
        direction: 'request',
        scope,
        bulk: BULK.has(channel),
        params,
        ...(socketOnly ? { socketOnly: true as const } : {}),
        ...(TRANSPORT_CHANNELS.has(channel) ? { transport: true as const } : {}),
        ...(channel === IPC.windowOpenRun ? { desktopRequired: true as const } : {}),
        ...(Object.hasOwn(STORES_SECRET, channel) ? { storesSecret: STORES_SECRET[channel] } : {}),
        source: sourceOf(channel)
      }
    }
  }
  for (const channel of Object.keys(STORES_SECRET)) {
    const e = out[channel]
    if (!e || e.direction !== 'request' || e.scope === 'desktop_only') throw new Error(`Host registry: storesSecret names ${channel}, which is not a socket request channel`)
  }
  for (const [channel, push] of Object.entries(PUSH_TABLE)) {
    if (out[channel]) throw new Error(`Host registry: ${channel} is listed twice`)
    out[channel] = { direction: 'push', ...push }
  }
  out[HOST_METHODS.hostChallenge] = { direction: 'protocol', source: 'socket transport handshake step 1 (cli-spec 3.3(2))' }
  out[HOST_METHODS.hostHello] = { direction: 'protocol', source: 'socket transport handshake step 2 (cli-spec 3.3(2))' }
  return out
}

/** Every channel and host.* method: one entry per allChannels() value plus the 5 HOST_METHODS, nothing else. */
export const HOST_CHANNEL_REGISTRY: Readonly<Record<string, ChannelEntry>> = Object.freeze(buildRegistry())

export function channelEntry(channel: string): ChannelEntry | undefined {
  return Object.prototype.hasOwnProperty.call(HOST_CHANNEL_REGISTRY, channel) ? HOST_CHANNEL_REGISTRY[channel] : undefined
}

/** Every request entry, keyed by channel. */
export function requestEntries(): [string, RequestChannelEntry][] {
  return Object.entries(HOST_CHANNEL_REGISTRY).filter((e): e is [string, RequestChannelEntry] => e[1].direction === 'request')
}

/** Request channels the dispatcher serves over the socket: not desktop_only and not answered by the transport. */
export function socketInvokableChannels(): string[] {
  return requestEntries()
    .filter(([, e]) => e.scope !== 'desktop_only' && !e.transport)
    .map(([c]) => c)
}

/** The request channels refused over the socket (scope 'desktop_only'). */
export function desktopOnlyChannels(): string[] {
  return requestEntries()
    .filter(([, e]) => e.scope === 'desktop_only')
    .map(([c]) => c)
}

const bad = (message: string): HostRpcFailure => new HostRpcFailure('bad_request', message)

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Validates one RPC call, in this order: known channel, a request (not push, not protocol), not desktop_only, a host
 * that can open windows for desktopRequired (hostCanOpenWindows), scope granted (scopes are explicit, never hierarchical), params an array (a host.*
 * method may take one plain object), the clearable / nullable codec (jsonCodec decodeRequest), then the param specs.
 * Throws HostRpcFailure.
 */
export const gateRequest: GateFn = (channel, params, ctx) => {
  const entry = channelEntry(channel)
  if (!entry) throw new HostRpcFailure('unknown_channel', `Unknown channel: ${channel}`)
  if (entry.direction === 'push') throw bad(`${channel} is a push channel; subscribe with runs:subscribe or host.subscribe`)
  if (entry.direction === 'protocol') throw bad(`${channel} is part of the handshake only`)
  if (entry.scope === 'desktop_only') throw new HostRpcFailure('desktop_unavailable', `${channel} works only in the OrgAI window`)
  if (entry.desktopRequired && !hostCanOpenWindows(ctx.hostKind)) {
    const where = ctx.hostKind === 'inproc' ? 'runs inside the CLI' : 'runs without the OrgAI app'
    throw new HostRpcFailure('desktop_unavailable', `${channel} needs the OrgAI desktop app; this host ${where}`)
  }
  if (!ctx.grantedScopes.includes(entry.scope)) {
    throw new HostRpcFailure('scope_denied', `${channel} needs the '${entry.scope}' scope, which this connection was not granted`)
  }
  const hostMethod = HOST_METHOD_VALUES.has(channel)
  let raw: unknown[]
  if (params === undefined) raw = []
  else if (Array.isArray(params)) raw = params
  else if (hostMethod && isPlainObject(params)) raw = [params]
  else throw bad(`${channel} params must be an array of positional arguments${hostMethod ? ' or one object' : ''}`)
  const args = !hostMethod && Object.hasOwn(CHANNEL_JSON_FIELDS, channel) ? decodeRequest(channel, raw) : raw.slice()
  const problem = paramProblem(channel, entry.params, args)
  if (problem) throw bad(problem)
  return { channel, args, entry, mutation: entry.scope !== 'read' }
}

/** Post-authentication frame caps: RPC_BULK_FRAME_MAX_BYTES both ways for RPC_BULK_CHANNELS, else the control caps. */
export function frameLimitFor(channel: string): { requestBytes: number; responseBytes: number } {
  const entry = channelEntry(channel)
  if (entry?.direction === 'request' && entry.bulk) return { requestBytes: RPC_BULK_FRAME_MAX_BYTES, responseBytes: RPC_BULK_FRAME_MAX_BYTES }
  return { requestBytes: RPC_CONTROL_REQUEST_MAX_BYTES, responseBytes: RPC_CONTROL_RESPONSE_MAX_BYTES }
}

/** The socket-subscribable push channels a host.subscribe topic (or 'runs', runs:subscribe) delivers. */
export function pushChannelsForTopic(topic: HostSubscribeTopic | 'runs'): string[] {
  return Object.entries(HOST_CHANNEL_REGISTRY)
    .filter(([, e]) => e.direction === 'push' && e.delivery === 'socket_subscribable' && e.topic === topic)
    .map(([c]) => c)
}
