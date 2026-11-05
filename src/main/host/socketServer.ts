/**
 * The host's JSON-RPC 2.0 socket server (cli-spec 3.3). Electron-free, relative imports only.
 *
 * Wave 2 contracts skeleton: the signatures below are final; W2-T1 implements the bodies. Until then accept() destroys
 * every socket and attachedClientCount() is 0.
 *
 * Use from an entry point (desktop shell, `--headless-host`, `--host inproc`):
 *
 *   const server = new HostSocketServer({ dataDir, hostKind, hostInstanceId: currentHostInstanceId(), appVersion, mock })
 *   const ownership = await acquireHostOwnership({ ..., onConnection: (s) => server.accept(s) })
 *   const host = bootOrgAIHost({ ..., ownership })
 *   server.attach(host) // synchronously after boot
 *
 * Intended contract (T1):
 * - On accept the server sends `host.challenge` (protocol.ts challengeFrame) with a fresh hostNonce and reads lines
 *   through a LineReader capped at RPC_PRE_AUTH_FRAME_MAX_BYTES until host.hello succeeds; at most
 *   RPC_MAX_UNAUTH_SOCKETS unauthenticated sockets, each with an RPC_HANDSHAKE_TIMEOUT_MS deadline, and at most
 *   RPC_MAX_CLIENT_SOCKETS authenticated ones (else 'too_many_connections').
 * - host.hello (id HELLO_REQUEST_ID): before attach() it answers 'host_starting' with retryAfterMs 250. Then it checks
 *   protocolVersion ('protocol_mismatch'), the clientProof against readDaemonSecret(dataDir) ('auth_failed'),
 *   AppSettings.terminalServer ('terminal_server_disabled'), the optional peerCheck ('descendant' ->
 *   'agent_descendant_refused'; 'unavailable' is logged and accepted), grants the requested scopes and answers an
 *   RpcHelloResult with hostProof (and versionSkewWarning when clientVersion !== appVersion).
 * - After hello: requests go to host.dispatcher.invokeRpc (scope gate, draining, leases) with frame caps
 *   RPC_CONTROL_REQUEST_MAX_BYTES / RPC_BULK_FRAME_MAX_BYTES per channel, RPC_BULK_MEMORY_BUDGET_BYTES across all
 *   sockets for frames over 2 MB, and RPC_MAX_INFLIGHT_PER_SOCKET in flight per socket ('too_many_requests').
 * - The transport methods `runs:subscribe` (RunsSubscribeInput -> snapshot XOR replay; then `runs:event`
 *   notifications with RunsEventParams) and `host.subscribe` (HostSubscribeInput -> HostSubscribeResult; then
 *   `method: channel, params: payload` notifications from host.events) are answered here, never by invokeRpc. The
 *   durable ring (2,000 events / 16 MB, images over 512 KB scrubbed to OmittedImage) and the per-socket 16 MB outbound
 *   queue with tail agent.partial coalescing live here too.
 * - attach() registers the 'interactiveClients' activity source (attachedClientCount) on host.activity.
 */
import type { Socket } from 'node:net'
import type { HostKind } from '../../shared/types'
import type { OrgAIHost } from './bootstrap'

export interface HostSocketServerOptions {
  /** `<userDataDir>/data`; daemon.secret is read from `<dataDir>/run`. */
  dataDir: string
  hostKind: HostKind
  /** currentHostInstanceId(): the id ownership advertises in daemon.json and the challenge carries. */
  hostInstanceId: string
  appVersion: string
  mock: boolean
  /**
   * Best-effort peer ancestry check of host.hello's pid (cli-spec 3.4(2)): 'descendant' refuses the client with
   * 'agent_descendant_refused', 'unavailable' is logged and allowed. Missing = no check.
   */
  peerCheck?: (pid: number) => Promise<'ok' | 'descendant' | 'unavailable'>
  log?: (m: string) => void
  /** Clock for deadlines; tests pass a fake. */
  now?: () => number
}

export class HostSocketServer {
  protected readonly opts: HostSocketServerOptions
  protected host: OrgAIHost | undefined
  private closed = false

  constructor(opts: HostSocketServerOptions) {
    this.opts = opts
  }

  /** Ownership's onConnection hook: take over one freshly accepted socket (challenge, handshake, requests). */
  accept(socket: Socket): void {
    // Skeleton: nothing is served until W2-T1 lands.
    socket.destroy()
  }

  /**
   * Start serving the booted host (call synchronously after bootOrgAIHost). Before this, host.hello answers
   * 'host_starting' with retryAfterMs 250. Registers the 'interactiveClients' activity source.
   */
  attach(host: OrgAIHost): void {
    this.host = host
  }

  /** Authenticated sockets that are clientKind 'tui' or hold a runs:subscribe subscription. */
  attachedClientCount(): number {
    return 0
  }

  /** Destroy every socket and stop serving. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
  }
}
