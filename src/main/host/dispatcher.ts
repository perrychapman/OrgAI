/**
 * The host dispatcher (cli-spec Wave 1): every request handler, served to the desktop (ipcMain through ipc.ts) and to
 * RPC clients (socket / inproc). Electron-free; relative imports only.
 *
 * Wave 1 contracts skeleton: the dispatcher task moves the handlers out of ipc.ts. `invoke` stays synchronous for the
 * desktop (existing tests expect sync throws); `invokeRpc` gates the call, checks draining and holds a mutation lease.
 */
import { HostEventBus } from './events'
import type { GateFn } from './registry'
import type { HostServices, InvokeContext, RpcInvokeContext } from './types'

export class HostDispatcher {
  readonly events: HostEventBus

  constructor(
    private readonly services: HostServices,
    private readonly opts: { gate?: GateFn } = {}
  ) {
    this.events = services.events ?? new HostEventBus()
  }

  /** Desktop path: run the channel's handler with already-structured-cloned args. */
  invoke(channel: string, _args: unknown[], _ctx: InvokeContext): unknown {
    void this.services
    throw new Error(`HostDispatcher.invoke: not implemented (${channel})`)
  }

  /** RPC path: gate (scope, params), refuse while draining, hold an inFlightRpcMutations lease for mutations. */
  invokeRpc(channel: string, _params: unknown, _ctx: RpcInvokeContext): Promise<unknown> {
    void this.opts
    return Promise.reject(new Error(`HostDispatcher.invokeRpc: not implemented (${channel})`))
  }

  has(_channel: string): boolean {
    return false
  }

  channels(): string[] {
    return []
  }
}
