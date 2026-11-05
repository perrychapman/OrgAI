/**
 * The exhaustive host channel registry (cli-spec 3.3(3), Wave 1): every IPC, TEMPLATE_ENGAGEMENT_IPC, KNOWLEDGE_IPC,
 * MCP_SCOPE_IPC, KIT_IPC and HOST_IPC channel plus the host.* protocol methods, with its scope, bulk flag and param
 * validators, and the RPC gate that refuses anything unmapped with `unknown_channel`.
 *
 * Wave 1 contracts skeleton: the types and HostRpcFailure are final; the registry contents, gateRequest,
 * frameLimitFor and pushChannelsForTopic are filled by the registry task. Electron-free; relative imports only.
 */
import { RPC_CONTROL_REQUEST_MAX_BYTES, RPC_CONTROL_RESPONSE_MAX_BYTES } from '../../shared/types'
import type { HostKind, HostRpcError, HostRpcErrorCode, HostScope, HostSubscribeTopic } from '../../shared/types'

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

/** One positional parameter's shape check. */
export interface ParamSpec {
  kind: 'string' | 'id' | 'object' | 'boolean' | 'number' | 'array' | 'any'
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
  /** Needs DesktopHooks; refused with desktop_unavailable without them (window:openRun). */
  desktopRequired?: true
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

/** Every channel and host.* method. Skeleton: empty until the registry task fills it. */
export const HOST_CHANNEL_REGISTRY: Readonly<Record<string, ChannelEntry>> = {}

export function channelEntry(channel: string): ChannelEntry | undefined {
  return Object.prototype.hasOwnProperty.call(HOST_CHANNEL_REGISTRY, channel) ? HOST_CHANNEL_REGISTRY[channel] : undefined
}

/** Validates scope and params of one RPC call. Skeleton: refuses everything as unknown. */
export const gateRequest: GateFn = (channel) => {
  throw new HostRpcFailure('unknown_channel', `Unknown channel: ${channel}`)
}

/** Post-authentication frame caps for a channel. Skeleton: the control caps for every channel. */
export function frameLimitFor(_channel: string): { requestBytes: number; responseBytes: number } {
  return { requestBytes: RPC_CONTROL_REQUEST_MAX_BYTES, responseBytes: RPC_CONTROL_RESPONSE_MAX_BYTES }
}

/** The push channels a host.subscribe topic (or 'runs') delivers. Skeleton: none. */
export function pushChannelsForTopic(_topic: HostSubscribeTopic | 'runs'): string[] {
  return []
}
