/**
 * The host's JSON-RPC 2.0 socket server (cli-spec 3.3). Electron-free, relative imports only.
 *
 * Use from an entry point (desktop shell, `--headless-host`, `--host inproc`):
 *
 *   const server = new HostSocketServer({ dataDir, hostKind, hostInstanceId: currentHostInstanceId(), appVersion, mock })
 *   const ownership = await acquireHostOwnership({ ..., onConnection: (s) => server.accept(s) })
 *   const host = bootOrgAIHost({ ..., ownership })
 *   server.attach(host) // synchronously after boot
 *
 * Contract:
 * - On accept the server sends `host.challenge` (protocol.ts challengeFrame) with a fresh hostNonce and reads lines
 *   through a LineReader capped at RPC_PRE_AUTH_FRAME_MAX_BYTES until host.hello succeeds; at most
 *   RPC_MAX_UNAUTH_SOCKETS unauthenticated sockets (more are destroyed at once), each with an RPC_HANDSHAKE_TIMEOUT_MS
 *   deadline, and at most RPC_MAX_CLIENT_SOCKETS authenticated ones (else 'too_many_connections').
 * - host.hello (id HELLO_REQUEST_ID) is checked in this order: protocolVersion ('protocol_mismatch'; the challenge
 *   names it anyway), a hex clientProof and clientNonce and a requestedScopes array (else a generic 'auth_failed'), on
 *   a daemon.secret the owner could not protect (secretAclProblem: ownership's best-effort ACL warning; review
 *   follow-up: the server runs no icacls of its own, since every listener-binding path in ownership.ts restricts the
 *   run folder and the secret first and fails closed), the clientProof over the fields as sent
 *   against readDaemonSecret(dataDir) ('auth_failed'); only then the field checks with their detail (clientKind,
 *   clientVersion, pid, cwd, requestedScopes: 'bad_request'), so an unauthenticated peer learns nothing about the
 *   expected format. Then before attach() 'host_starting' (retryAfterMs 250), while the host drains 'host_draining',
 *   Terminal access off (OrgAIHost.terminalAccess) 'terminal_server_disabled', the socket quota, and the peer check
 *   ('descendant' -> 'agent_descendant_refused'; 'unavailable' is logged and accepted). On success it grants the
 *   requested scopes the Terminal access level allows (grantScopes: 'operate' = read + operate, the default; 'full' =
 *   all) and remembers the rest as withheld: their channels answer 'scope_denied' with TERMINAL_ACCESS_LEVEL_MESSAGE,
 *   except host.stop for a client that asked for 'configure'. The one exception to the cap is the owner of a
 *   `--host inproc` host: a hello whose ownerProof verifies against the server's in-memory `ownerKey` (only the CLI
 *   process that started the host holds it; it is never written to disk) gets every requested scope. Every other
 *   client of an in-process host, one holding daemon.secret included, is capped like on any host (review H2).
 *   Lowering the level closes sockets holding scopes it no longer allows (never the owner's). It answers an RpcHelloResult with hostProof (and
 *   versionSkewWarning when clientVersion !== appVersion) and raises the line cap to RPC_BULK_FRAME_MAX_BYTES. A
 *   refused hello closes the socket once the error frame is flushed.
 * - Windows named pipe (review H2 (1)): Node's net.Server cannot give a pipe a security descriptor or the
 *   PIPE_REJECT_REMOTE_CLIENTS flag. libuv calls CreateNamedPipeW with no SECURITY_ATTRIBUTES (the pipe gets the
 *   default DACL: full control for LocalSystem, Administrators and the creator owner, read for Everyone and Anonymous)
 *   and listen({ readableAll, writableAll }) can only widen it. Read access alone cannot send host.hello, and a
 *   client of another machine still needs daemon.secret; so on Windows the barriers are the secret's explicit DACL
 *   (refuse every hello when it cannot be set), the proof, and the scope cap above. A native addon (or a pipe created
 *   through another runtime) would be needed for an explicit DACL; UNVERIFIED on Windows from this code.
 * - Handoff connections (Wave 7, cli-standalone.md 4.4 step 5, D8): a proven `clientKind: 'desktop'` hello (the OrgAI
 *   app asking this host to hand over the data folder) is accepted on a Node host ('node') whatever Terminal access is
 *   (off, 'operate' or 'full') and across app versions; every other host kind refuses it after the proof
 *   (DESKTOP_HANDOFF_REFUSED_MESSAGE), with grantedScopes exactly HOST_HANDOFF_SCOPES and `handoff: true` in the result
 *   and its hostProof. Such a connection may call only HOST_HANDOFF_METHODS (host.status, host.stop, forced included):
 *   anything else, the subscriptions included, answers scope_denied before dispatch. The peer check still refuses the
 *   host's own descendants, with DESKTOP_HELLO_PEER_CHECK_MS instead of the default budget. This does not authenticate
 *   the app: any same-user process holding daemon.secret may claim 'desktop' (D8 accepts this). Handoff connections are
 *   not terminal sessions (terminalSessionCount) and Terminal access changes never close them.
 * - closeGracefully(ms) (the shutdown coordinator, before the release): close() and resolve once every socket has
 *   flushed its queued frames and closed, or the time is up (the rest are destroyed then).
 * - mcp:authorize with announceUrl: the `mcp.authorize` connections:event reaches only the socket whose call is still
 *   in flight for that target (authorizeKey), never every 'connections' subscriber.
 * - After hello: requests go to host.dispatcher.invokeRpc (scope gate, draining, leases) with the per-channel caps of
 *   registry.ts frameLimitFor, RPC_BULK_MEMORY_BUDGET_BYTES across all sockets for frames over 2 MB (bulkBudget.ts), and
 *   RPC_MAX_INFLIGHT_PER_SOCKET in flight per socket ('too_many_requests'). A complete line over its channel's cap is
 *   answered 'frame_too_large' and the socket stays open; a line over RPC_BULK_FRAME_MAX_BYTES, or one the bulk budget
 *   cannot hold while it arrives, destroys the socket (a partial line cannot be resynced).
 * - The transport methods `runs:subscribe` (runSubscriptions.ts; snapshot XOR replay, then `runs:event` notifications
 *   with RunsEventParams) and `host.subscribe` (HostSubscribeResult; then `method: channel, params: payload`
 *   notifications) are answered here, never by invokeRpc. The durable ring is eventJournal.ts and the per-socket 16 MB
 *   outbound queue with agent.partial coalescing is outboundQueue.ts.
 * - attach() registers the 'interactiveClients' activity source (attachedClientCount) on host.activity.
 *
 * Secrets, proofs and nonces are never logged.
 */
import type { Socket } from 'node:net'
import {
  HOST_IPC,
  IPC,
  HOST_METHODS,
  HOST_PROTOCOL_VERSION,
  HOST_SCOPES,
  RPC_BULK_FRAME_MAX_BYTES,
  RPC_CONTROL_REQUEST_MAX_BYTES,
  RPC_HANDSHAKE_TIMEOUT_MS,
  RPC_MAX_CLIENT_SOCKETS,
  RPC_MAX_INFLIGHT_PER_SOCKET,
  RPC_MAX_UNAUTH_SOCKETS,
  RPC_PRE_AUTH_FRAME_MAX_BYTES,
  HOST_CLIENT_KINDS,
  HOST_HANDOFF_METHODS,
  HOST_HANDOFF_SCOPES,
  DESKTOP_HELLO_PEER_CHECK_MS
} from '../../shared/types'
import type {
  HostClientKind,
  HostKind,
  HostRpcError,
  HostScope,
  HostSubscribeResult,
  HostSubscribeTopic,
  RpcHelloResult,
  RunEvent,
  TerminalAccessLevel
} from '../../shared/types'
import { log } from '../log'
import type { HostTerminalAccess, OrgAIHost } from './bootstrap'
import { BulkBudget, type BulkReservation } from './bulkBudget'
import { EventJournal } from './eventJournal'
import type { HostPushChannel } from './events'
import { OutboundQueue, frameKey, type FrameMeta } from './outboundQueue'
import { checkPeerAncestry, socketFdOf } from './peerCheck'
import {
  HELLO_REQUEST_ID,
  LineReader,
  challengeFrame,
  clientProof,
  encodeFrame,
  hostProof,
  ownerProof,
  isHexNonce,
  isNotification,
  isRequest,
  newNonce,
  parseFrame,
  proofMatches,
  readDaemonSecret,
  rpcError,
  rpcNotification,
  rpcParseError,
  rpcResult,
  type JsonRpcId,
  type JsonRpcRequest
} from './protocol'
import { HostRpcFailure, channelEntry, frameLimitFor, gateRequest, pushChannelsForTopic } from './registry'
import { RunSubscription, parseRunsSubscribeInput, subscribeRuns } from './runSubscriptions'

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
   * 'agent_descendant_refused', 'unavailable' is logged and allowed. Missing = peerCheck.ts checkPeerAncestry with
   * the accepted socket's fd (macOS maps the socket to its real peer pids through lsof). `timeoutMs` is the budget:
   * DESKTOP_HELLO_PEER_CHECK_MS for a 'desktop' hello, undefined (the check's default) otherwise.
   */
  peerCheck?: (pid: number, socketFd?: number, timeoutMs?: number) => Promise<'ok' | 'descendant' | 'unavailable'>
  log?: (m: string) => void
  /** Clock for deadlines; tests pass a fake. */
  now?: () => number
  /**
   * Why daemon.secret is not protected, read at every hello (wired to HostOwnership.secretAclWarning: set only when a
   * best-effort acquire bound the listener after the win32 ACL step failed). A string refuses the hello with
   * SECRET_ACL_MESSAGE. The server runs no icacls itself (review follow-up): ownership restricts the run folder and the
   * secret before any listener exists ('required' for setListening and for headless / inproc hosts), and a second,
   * concurrent ACL run here raced that write and cached its failure for the server's life.
   */
  secretAclProblem?: () => string | undefined
  /**
   * `--host inproc` only: a 32-byte hex key kept in memory by the CLI process that started this host (never on disk,
   * never logged). A hello carrying a matching ownerProof (protocol.ts ownerProof) is that process and gets every
   * requested scope; everyone else is capped by Terminal access (review H2).
   */
  ownerKey?: string
}

/** The scopes each Terminal access level grants at most (AppSettings.terminalAccessLevel). */
export function scopesForAccessLevel(level: TerminalAccessLevel): readonly HostScope[] {
  return level === 'full' ? HOST_SCOPES : (['read', 'operate'] as const)
}

/** The scopes host.hello grants: the requested ones (deduplicated, in order) the level allows, and the ones it withheld. */
export function grantScopes(requested: readonly HostScope[], level: TerminalAccessLevel): { granted: HostScope[]; withheld: HostScope[] } {
  const allowed = scopesForAccessLevel(level)
  const granted: HostScope[] = []
  const withheld: HostScope[] = []
  for (const s of new Set(requested)) (allowed.includes(s) ? granted : withheld).push(s)
  return { granted, withheld }
}

/** host.subscribe topics (HostSubscribeTopic). */
export const HOST_SUBSCRIBE_TOPICS: readonly HostSubscribeTopic[] = ['settings', 'connections', 'mcpLibrary', 'skillLibrary', 'capabilities', 'engagement']

export const TERMINAL_ACCESS_OFF_MESSAGE =
  'Terminal access is off. Turn it on in OrgAI: App settings > General > Advanced settings > Terminal access.'
/** scope_denied for a scope host.hello withheld because of AppSettings.terminalAccessLevel. */
export const TERMINAL_ACCESS_LEVEL_MESSAGE =
  'Terminal access lets terminal clients watch and run work only. To answer decisions or change settings from a terminal, allow it in OrgAI: App settings > General > Advanced settings > Terminal access.'
/**
 * The same two refusals from a Node host (Wave 7, cli-standalone.md 4.2.1): a machine with only the npm CLI has no App
 * settings, so they name the commands that change the stored Terminal access (review round 1).
 */
export const NODE_TERMINAL_ACCESS_OFF_MESSAGE =
  'Terminal access is off. Once this background host has stopped (its idle exit), turn it on with `orgai terminal-access on`.'
export const NODE_TERMINAL_ACCESS_LEVEL_MESSAGE =
  'Terminal access lets terminal clients watch and run work only. To answer decisions or change settings from a terminal, stop this background host (`orgai daemon stop`), then run `orgai terminal-access --level full`.'

/**
 * A socket settings:set that would turn Terminal access off on a Node host (review round 2): refused, since the host
 * would then run unreachable (4.2.1): neither `orgai daemon stop` nor `orgai terminal-access` could talk to it, and
 * its idle exit never comes while runs are live or with ORGAI_DAEMON_IDLE_MINUTES=0.
 */
export const NODE_TERMINAL_ACCESS_OFF_REFUSED =
  'A background host cannot turn Terminal access off from a terminal: nothing could reach it afterwards. Stop it with `orgai daemon stop`, then run `orgai terminal-access off`.'

/**
 * Whether a socket settings:set (`params` as sent) turns Terminal access off on this host: on a Node host, a
 * `terminalServer: false` while it is stored on. An echo of a stored false changes nothing and passes.
 */
export function turnsNodeTerminalAccessOff(hostKind: HostKind, method: string, params: unknown, stored: () => { terminalServer?: boolean }): boolean {
  if (hostKind !== 'node' || method !== IPC.settingsSet) return false
  const input = Array.isArray(params) ? params[0] : undefined
  if (!isObj(input) || input.terminalServer !== false) return false
  try {
    return stored().terminalServer === true
  } catch {
    // Unreadable settings: refuse rather than risk an unreachable host.
    return true
  }
}

/** TERMINAL_ACCESS_OFF_MESSAGE, or its Node host wording. */
export function terminalAccessOffMessage(hostKind: HostKind): string {
  return hostKind === 'node' ? NODE_TERMINAL_ACCESS_OFF_MESSAGE : TERMINAL_ACCESS_OFF_MESSAGE
}

/** TERMINAL_ACCESS_LEVEL_MESSAGE, or its Node host wording. */
export function terminalAccessLevelMessage(hostKind: HostKind): string {
  return hostKind === 'node' ? NODE_TERMINAL_ACCESS_LEVEL_MESSAGE : TERMINAL_ACCESS_LEVEL_MESSAGE
}

/**
 * What a handoff connection (a 'desktop' hello, cli-standalone.md 4.4) is told when it calls anything but
 * HOST_HANDOFF_METHODS. Wave 7 contracts refused the whole hello with a message of this name; the grant replaced that
 * on Node hosts, and DESKTOP_HANDOFF_REFUSED_MESSAGE keeps refusing it on every other host kind.
 */
export const DESKTOP_HANDOFF_UNAVAILABLE_MESSAGE = 'An OrgAI app hand-off connection may only read the host status and stop the host.'
/**
 * A 'desktop' hello to a host that is not a Node host (4.4 steps 3-4, D8): the app hands over only from a background
 * Node host; an inproc owner (someone's terminal) is never stopped from the app, and the desktop and headless hosts
 * share the app's single-instance lock, so the app never asks them. The hello is refused after the proof, as before the
 * grant existed.
 */
export const DESKTOP_HANDOFF_REFUSED_MESSAGE =
  "This OrgAI host does not hand its data folder over to the app; only a background host started with `orgai daemon start` does. Stop it from its terminal, or with `orgai daemon stop --force`."

/** hello refused on win32 when daemon.secret could not be restricted to the current user. */
export const SECRET_ACL_MESSAGE =
  'OrgAI could not restrict its terminal access secret to your Windows account, so it refuses terminal connections. See main.log.'
export const BULK_BUDGET_MESSAGE = 'OrgAI is handling too much data at once; try again'
const HOST_STARTING_RETRY_MS = 250
const HOST_DRAINING_RETRY_MS = 1000
const CLIENT_VERSION_MAX = 200
const CWD_MAX = 4096
/** Lines a client may pipeline behind host.hello while it is checked. */
const PENDING_LINES_MAX = RPC_MAX_INFLIGHT_PER_SOCKET
/** How long a refused socket may take to flush its last frame. */
const REFUSE_FLUSH_MS = 1000

type ConnState = 'unauth' | 'hello' | 'auth' | 'closed'

interface Conn {
  id: number
  socket: Socket
  reader: LineReader
  queue: OutboundQueue
  state: ConnState
  hostNonce: string
  timer?: ReturnType<typeof setTimeout>
  clientKind?: HostClientKind
  pid?: number
  scopes: HostScope[]
  /** Requested scopes host.hello withheld (AppSettings.terminalAccessLevel); their channels answer the level message. */
  withheld: HostScope[]
  /** The in-process host's own CLI (ownerProof verified): not capped by Terminal access, never closed when it narrows. */
  owner?: boolean
  inflight: number
  /**
   * Targets (authorizeKey) of this socket's mcp:authorize calls with announceUrl still in flight, with their counts:
   * only this socket hears their `mcp.authorize` URL, not every 'connections' subscriber (review Low).
   */
  authorizing: Map<string, number>
  runs?: RunSubscription
  topics: Set<HostSubscribeTopic>
  pendingLines: string[]
  incoming?: BulkReservation
  reservations: Set<BulkReservation>
  /**
   * close() ran while requests were in flight on this authenticated socket: no new request is read and no push is
   * sent, but the in-flight answers (a host.stop reply, whose drain is what closed the server) are still queued; the
   * socket is ended once the last one is (or after REFUSE_FLUSH_MS).
   */
  closeAfterInflight?: boolean
  /**
   * The client's version differs from the host's (versionSkewWarning sent): 'configure' channels other than host.stop
   * are refused, since their argument shapes may differ between versions (cli-spec 3.3(2), 6.3(6)).
   */
  versionSkew?: boolean
  /** A 'desktop' hello's handoff grant (4.4 step 5): only HOST_HANDOFF_METHODS, checked before anything else. */
  handoff?: boolean
}

/** Re-read after calls that may close the connection (defeats narrowing). */
const isClosed = (c: Conn): boolean => c.state === 'closed'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The host's Terminal access (OrgAIHost.terminalAccess; a host without it reads AppSettings directly); off with the
 * lowest level when it cannot be read. The same on every host kind: an in-process host's own CLI is recognised by its
 * ownerProof, never by the host kind (review H2).
 */
function accessOf(host: OrgAIHost): HostTerminalAccess {
  try {
    const fromHost = typeof host.terminalAccess === 'function' ? host.terminalAccess() : undefined
    const s = fromHost ? undefined : host.settings.get()
    const enabled = fromHost ? fromHost.enabled === true : s?.terminalServer === true
    const level: TerminalAccessLevel = (fromHost ? fromHost.level : s?.terminalAccessLevel) === 'full' ? 'full' : 'operate'
    return { enabled, level }
  } catch {
    return { enabled: false, level: 'operate' }
  }
}

/**
 * The authorizeKey of a connections:event `mcp.authorize` (a sentinel no socket holds when its target is malformed,
 * so it reaches nobody); undefined for every other connections:event.
 */
function announcedAuthorizeKey(payload: unknown): string | undefined {
  if (!isObj(payload) || payload.type !== 'mcp.authorize') return undefined
  return authorizeKey(isObj(payload.authorize) ? payload.authorize.target : undefined) ?? '\u0000none'
}

/** A stable key of an McpAuthTarget-shaped value (libraryId, or projectId + serverId); undefined for anything else. */
export function authorizeKey(target: unknown): string | undefined {
  if (!isObj(target)) return undefined
  if (typeof target.libraryId === 'string') return JSON.stringify(['lib', target.libraryId])
  if (typeof target.projectId === 'string' && typeof target.serverId === 'string') return JSON.stringify(['project', target.projectId, target.serverId])
  return undefined
}

export class HostSocketServer {
  protected readonly opts: HostSocketServerOptions
  protected host: OrgAIHost | undefined
  /** Host-wide bulk frame budget (protected so tests can shrink it). */
  protected budget = new BulkBudget()
  protected readonly journal = new EventJournal()
  private closed = false
  private readonly conns = new Set<Conn>()
  /**
   * AppSettings.terminalServer as last read (attach, settings:changed). While it is off and no client is
   * authenticated, run events are not journaled: a desktop user who never uses the terminal pays nothing per event.
   */
  private terminalOn = false
  /** The Terminal access level as last read (attach, settings:changed); a lower one closes over-scoped sockets. */
  private accessLevel: TerminalAccessLevel = 'operate'
  /** win32: daemon.secret's ACL restriction, run once (before the first hello is answered). */
  /** secretAclProblem's refusal is logged once per server. */
  private secretAclLogged = false
  /** Run events are going unjournaled (see terminalOn); the journal's gap is marked once per such stretch. */
  private journalPaused = false
  private nextId = 1
  private detach: Array<() => void> = []
  private readonly channelTopic = new Map<string, HostSubscribeTopic>()

  constructor(opts: HostSocketServerOptions) {
    this.opts = opts
    for (const t of HOST_SUBSCRIBE_TOPICS) for (const c of pushChannelsForTopic(t)) this.channelTopic.set(c, t)
  }

  private log(m: string): void {
    if (this.opts.log) this.opts.log(m)
    else log.info(`[socket] ${m}`)
  }

  private get unauthCount(): number {
    let n = 0
    for (const c of this.conns) if (c.state === 'unauth' || c.state === 'hello') n++
    return n
  }

  private get authCount(): number {
    let n = 0
    for (const c of this.conns) if (c.state === 'auth') n++
    return n
  }

  /** Ownership's onConnection hook: take over one freshly accepted socket (challenge, handshake, requests). */
  accept(socket: Socket): void {
    if (this.closed || this.unauthCount >= RPC_MAX_UNAUTH_SOCKETS) {
      socket.destroy()
      return
    }
    const reader = new LineReader()
    reader.maxLineBytes = RPC_PRE_AUTH_FRAME_MAX_BYTES
    const id = this.nextId++
    const conn: Conn = {
      id,
      socket,
      reader,
      queue: new OutboundQueue(socket, {
        onOverflow: (bytes) => this.log(`Client ${id} stopped reading (${Math.round(bytes / 1024 / 1024)} MB queued); disconnected it.`)
      }),
      state: 'unauth',
      hostNonce: newNonce(),
      scopes: [],
      withheld: [],
      inflight: 0,
      authorizing: new Map(),
      topics: new Set(),
      pendingLines: [],
      reservations: new Set()
    }
    this.conns.add(conn)
    socket.on('error', () => {
      /* closed below */
    })
    socket.on('close', () => this.cleanup(conn))
    socket.on('data', (chunk: Buffer) => this.onData(conn, chunk))
    conn.timer = setTimeout(() => {
      if (conn.state === 'unauth' || conn.state === 'hello') this.kill(conn)
    }, RPC_HANDSHAKE_TIMEOUT_MS)
    conn.timer.unref?.()
    this.send(conn, challengeFrame(this.opts.hostInstanceId, conn.hostNonce))
  }

  /**
   * Start serving the booted host (call synchronously after bootOrgAIHost). Before this, host.hello answers
   * 'host_starting' with retryAfterMs 250. Registers the 'interactiveClients' activity source and the journal listener.
   */
  attach(host: OrgAIHost): void {
    if (this.closed || this.host) return
    this.host = host
    const access = accessOf(host)
    this.terminalOn = access.enabled
    this.accessLevel = access.level
    this.detach.push(host.activity.addSource('interactiveClients', () => this.attachedClientCount()))
    this.detach.push(host.events.on((channel, payload) => this.onHostEvent(channel, payload)))
  }

  private hasAuthenticated(): boolean {
    for (const c of this.conns) if (c.state === 'auth') return true
    return false
  }

  /** Authenticated sockets whose clientKind is 'tui' or whose runs:subscribe asked for an active run record. */
  attachedClientCount(): number {
    let n = 0
    for (const c of this.conns) if (c.state === 'auth' && !c.handoff && (c.clientKind === 'tui' || c.runs?.interactive === true)) n++
    return n
  }

  /** Authenticated terminal sessions (cli and tui sockets), handoff connections excluded (host.status `handoff`). */
  terminalSessionCount(): number {
    let n = 0
    for (const c of this.conns) if (c.state === 'auth' && !c.handoff && !c.closeAfterInflight) n++
    return n
  }

  /**
   * close(), then resolve once every socket has flushed what was queued (a host.stop reply included) and closed, or
   * `graceMs` passed; sockets still open then are destroyed. A client that stops reading cannot hold it. Never rejects.
   */
  closeGracefully(graceMs: number): Promise<void> {
    this.close()
    if (this.conns.size === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        globalThis.clearInterval(poll)
        globalThis.clearTimeout(timer)
        for (const c of [...this.conns]) this.kill(c)
        resolve()
      }
      // Each connection leaves `conns` on its socket's 'close'.
      const poll = globalThis.setInterval(() => {
        if (this.conns.size === 0) finish()
      }, 10)
      const timer = globalThis.setTimeout(finish, Math.max(0, graceMs))
    })
  }

  /** Destroy every socket and stop serving. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const d of this.detach.splice(0)) {
      try {
        d()
      } catch {
        // ignore
      }
    }
    // Flush what is already queued, then end each socket; a client that stops reading cannot hold it open past
    // REFUSE_FLUSH_MS. A socket with requests in flight first gets their answers: a non-forced host.stop drains
    // synchronously inside its own handler, so its reply is produced only after this close. Each connection is
    // cleaned up on its socket's 'close'.
    for (const c of [...this.conns]) {
      if (c.socket.destroyed) this.kill(c)
      else if (c.state === 'auth' && c.inflight > 0) this.closeAfterInflight(c)
      else this.refuseQueued(c)
    }
  }

  // ---------- Connection plumbing ----------

  private send(conn: Conn, msg: unknown): void {
    if (conn.state === 'closed') return
    let frame: string
    try {
      frame = encodeFrame(msg)
    } catch {
      return
    }
    conn.queue.enqueue(frame)
  }

  /** Send a last frame, then end the socket once it is flushed. */
  private refuse(conn: Conn, msg: unknown): void {
    this.send(conn, msg)
    this.refuseQueued(conn)
  }

  /**
   * End every authenticated socket `which` picks (default all: Terminal access turned off); the server keeps serving
   * new handshakes. `why` starts the log line.
   */
  private dropAuthenticated(which: (c: Conn) => boolean = () => true, why = 'Terminal access was turned off'): void {
    let n = 0
    for (const c of [...this.conns]) {
      // A handoff connection does not depend on Terminal access (4.4 step 5).
      if (c.state !== 'auth' || c.closeAfterInflight || c.handoff || !which(c)) continue
      n++
      if (c.socket.destroyed) this.kill(c)
      else if (c.inflight > 0) this.closeAfterInflight(c)
      else this.refuseQueued(c)
    }
    if (n) this.log(`${why}; closed ${n} terminal connection${n === 1 ? '' : 's'}.`)
  }

  /** close() with requests in flight: stop reading and pushing, end the socket once their answers are queued. */
  private closeAfterInflight(conn: Conn): void {
    conn.closeAfterInflight = true
    if (conn.timer) clearTimeout(conn.timer)
    conn.timer = undefined
    conn.runs = undefined
    conn.topics.clear()
    conn.socket.pause()
    setTimeout(() => {
      if (conn.state !== 'closed') this.refuseQueued(conn)
    }, REFUSE_FLUSH_MS).unref?.()
  }

  /** Stop reading, flush the queued frames, then end the socket. */
  private refuseQueued(conn: Conn): void {
    this.markClosing(conn)
    conn.socket.once('finish', () => conn.socket.destroy())
    // A client that stops reading cannot hold the socket open.
    setTimeout(() => conn.socket.destroy(), REFUSE_FLUSH_MS).unref?.()
    conn.queue.end()
  }

  private markClosing(conn: Conn): void {
    if (conn.timer) clearTimeout(conn.timer)
    conn.timer = undefined
    conn.runs = undefined
    conn.topics.clear()
    // Stop reading; 'closed' blocks every later frame except the ones already queued.
    conn.socket.pause()
    conn.state = 'closed'
  }

  private kill(conn: Conn): void {
    this.markClosing(conn)
    conn.queue.destroy()
    if (!conn.socket.destroyed) conn.socket.destroy()
    this.cleanup(conn)
  }

  private cleanup(conn: Conn): void {
    if (conn.timer) clearTimeout(conn.timer)
    conn.timer = undefined
    conn.state = 'closed'
    conn.runs = undefined
    conn.topics.clear()
    conn.reader.reset()
    conn.incoming?.release()
    conn.incoming = undefined
    for (const r of conn.reservations) r.release()
    conn.reservations.clear()
    conn.queue.destroy()
    this.conns.delete(conn)
  }

  private onData(conn: Conn, chunk: Buffer): void {
    if (conn.state === 'closed' || conn.closeAfterInflight) return
    const r = conn.reader.push(chunk)
    for (const line of r.lines) {
      if (isClosed(conn) || conn.closeAfterInflight) return
      this.onLine(conn, line)
    }
    if (isClosed(conn) || conn.closeAfterInflight) return
    if (r.overflow) {
      this.refuse(conn, rpcError(null, { code: 'frame_too_large', message: `A frame exceeded ${conn.reader.maxLineBytes} bytes.` }))
      return
    }
    // Bulk budget for a line still arriving.
    if (r.pendingBytes > RPC_CONTROL_REQUEST_MAX_BYTES) {
      if (conn.incoming) {
        if (!conn.incoming.grow(r.pendingBytes)) return this.budgetRefuse(conn)
      } else {
        const res = this.budget.reserve(r.pendingBytes)
        if (!res) return this.budgetRefuse(conn)
        conn.incoming = res
      }
    } else if (conn.incoming) {
      conn.incoming.release()
      conn.incoming = undefined
    }
  }

  private budgetRefuse(conn: Conn): void {
    conn.incoming?.release()
    conn.incoming = undefined
    conn.reader.reset()
    this.refuse(conn, rpcError(null, { code: 'frame_too_large', message: BULK_BUDGET_MESSAGE }))
  }

  private onLine(conn: Conn, line: string): void {
    if (conn.state === 'hello') {
      if (conn.pendingLines.length >= PENDING_LINES_MAX) {
        this.refuse(conn, rpcError(null, { code: 'bad_request', message: 'Wait for the host.hello answer before sending requests.' }))
        return
      }
      conn.pendingLines.push(line)
      return
    }
    const parsed = parseFrame(line)
    if (conn.state === 'unauth') {
      if (!parsed.ok) return this.refuse(conn, rpcParseError(parsed.error.message))
      const msg = parsed.message
      if (!isRequest(msg) || msg.method !== HOST_METHODS.hostHello || msg.id !== HELLO_REQUEST_ID) {
        const id = isObj(msg) && (typeof msg.id === 'number' || typeof msg.id === 'string') ? msg.id : null
        return this.refuse(conn, rpcError(id, { code: 'bad_request', message: 'The first request must be host.hello with id 1.' }))
      }
      conn.state = 'hello'
      void this.hello(conn, msg)
      return
    }
    if (conn.state !== 'auth') return
    if (!parsed.ok) return this.send(conn, rpcParseError(parsed.error.message))
    const msg = parsed.message
    if (isNotification(msg)) return
    if (!isRequest(msg)) {
      if (isObj(msg) && Object.hasOwn(msg, 'method')) {
        const id = typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : null
        this.send(conn, rpcError(id, { code: 'bad_request', message: 'Not a JSON-RPC 2.0 request.' }))
      }
      // A response from the client: ignored.
      return
    }
    this.onRequest(conn, msg, Buffer.byteLength(line, 'utf8'))
  }

  // ---------- Handshake ----------

  /**
   * Field checks of a host.hello whose proof already verified: the detailed messages go to a peer that holds the
   * secret only (review Low: nothing about the expected format reaches an unauthenticated peer).
   */
  private helloProblem(p: Record<string, unknown>): HostRpcError | undefined {
    const badReq = (message: string): HostRpcError => ({ code: 'bad_request', message })
    if (!HOST_CLIENT_KINDS.includes(p.clientKind as HostClientKind)) return badReq("host.hello clientKind must be 'cli', 'tui' or 'desktop'.")
    if (typeof p.clientVersion !== 'string' || p.clientVersion.length > CLIENT_VERSION_MAX) return badReq('host.hello clientVersion must be a string of at most 200 characters.')
    if (typeof p.pid !== 'number' || !Number.isSafeInteger(p.pid) || p.pid <= 0) return badReq('host.hello pid must be a positive integer.')
    if (typeof p.cwd !== 'string' || p.cwd.length > CWD_MAX || p.cwd.includes('\u0000')) return badReq('host.hello cwd must be a path of at most 4096 characters.')
    if (!Array.isArray(p.requestedScopes) || p.requestedScopes.length === 0 || p.requestedScopes.length > 16) {
      return badReq('host.hello requestedScopes must be a non-empty list of scopes.')
    }
    for (const s of p.requestedScopes) if (!HOST_SCOPES.includes(s as HostScope)) return badReq(`host.hello: unknown scope ${JSON.stringify(String(s)).slice(0, 40)}.`)
    return undefined
  }

  private secretCache: string | undefined

  /** The owner's reason daemon.secret is unprotected (logged once), else undefined. Never throws. */
  private secretAclRefusal(): string | undefined {
    let problem: string | undefined
    try {
      problem = this.opts.secretAclProblem?.()
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e)
    }
    if (!problem) return undefined
    if (!this.secretAclLogged) {
      this.secretAclLogged = true
      this.log(`daemon.secret is not restricted to the current user (${problem}); terminal connections are refused.`)
    }
    return problem
  }

  /** True when this server has an owner key and the hello's ownerProof verifies against it (constant time). */
  private isOwnerHello(conn: Conn, raw: Record<string, unknown>, clientProofHex: string): boolean {
    const key = this.opts.ownerKey
    if (!key || !isHexNonce(key) || !isHexNonce(raw.ownerProof)) return false
    const expected = ownerProof(key, { hostInstanceId: this.opts.hostInstanceId, hostNonce: conn.hostNonce, clientNonce: raw.clientNonce as string, clientProof: clientProofHex })
    return proofMatches(expected, raw.ownerProof)
  }

  private async hello(conn: Conn, req: JsonRpcRequest): Promise<void> {
    const fail = (err: HostRpcError): void => {
      if (conn.state === 'closed') return
      this.refuse(conn, rpcError(HELLO_REQUEST_ID, err))
    }
    const authFailed: HostRpcError = { code: 'auth_failed', message: 'The handshake proof did not verify.' }
    const raw = Array.isArray(req.params) && req.params.length === 1 ? req.params[0] : req.params
    if (!isObj(raw)) return fail(authFailed)
    // The challenge already names the protocol version, so saying it differs tells an unauthenticated peer nothing new.
    if (raw.protocolVersion !== HOST_PROTOCOL_VERSION) {
      return fail({ code: 'protocol_mismatch', message: `This OrgAI speaks protocol version ${HOST_PROTOCOL_VERSION}; update the CLI or the app so they match.` })
    }
    if (!isHexNonce(raw.clientProof) || !isHexNonce(raw.clientNonce) || !Array.isArray(raw.requestedScopes)) return fail(authFailed)
    if (this.secretAclRefusal()) return fail({ code: 'auth_failed', message: SECRET_ACL_MESSAGE })
    const secret = this.secretCache ?? readDaemonSecret(this.opts.dataDir)
    if (!secret) return fail({ code: 'auth_failed', message: 'The host secret could not be read.' })
    let expected: string
    try {
      // Over the fields exactly as sent: a malformed one fails the proof (or the checks below, once it verified).
      expected = clientProof(secret, {
        protocolVersion: HOST_PROTOCOL_VERSION,
        hostInstanceId: this.opts.hostInstanceId,
        hostNonce: conn.hostNonce,
        clientNonce: raw.clientNonce,
        clientKind: raw.clientKind as HostClientKind,
        clientVersion: raw.clientVersion as string,
        pid: raw.pid as number,
        cwd: raw.cwd as string,
        requestedScopes: raw.requestedScopes as HostScope[]
      })
    } catch {
      return fail(authFailed)
    }
    if (!proofMatches(expected, raw.clientProof)) return fail(authFailed)
    this.secretCache = secret
    const problem = this.helloProblem(raw)
    if (problem) return fail(problem)
    // Wave 7 (4.4 step 5, D8): a proven 'desktop' hello gets the handoff grant, whatever Terminal access is, from a
    // Node host only. D8 accepts that any same-user process with daemon.secret can stop a Node host this way; an inproc
    // CLI's host (someone's terminal session), a headless or a desktop host is never stopped through it.
    if (raw.clientKind === 'desktop' && this.opts.hostKind !== 'node') return fail({ code: 'bad_request', message: DESKTOP_HANDOFF_REFUSED_MESSAGE })
    const handoff = raw.clientKind === 'desktop'
    // An inproc host's own CLI, proven by the in-memory owner key (a client that only read daemon.secret cannot make that proof).
    const owner = this.opts.hostKind === 'inproc' && !handoff && this.isOwnerHello(conn, raw, raw.clientProof as string)
    const p = raw as Record<string, unknown> & {
      clientKind: HostClientKind
      clientVersion: string
      pid: number
      cwd: string
      clientNonce: string
      requestedScopes: HostScope[]
      clientProof: string
    }
    const gateProblem = (): HostRpcError | undefined => {
      const host = this.host
      if (!host) return { code: 'host_starting', message: 'OrgAI is starting; try again in a moment.', retryAfterMs: HOST_STARTING_RETRY_MS }
      if (host.activity.state() === 'draining') return { code: 'host_draining', message: 'OrgAI is shutting down.', retryAfterMs: HOST_DRAINING_RETRY_MS }
      // The in-process host's own CLI (owner proof) and a desktop handoff do not depend on Terminal access (cli-standalone.md 13.12).
      if (!handoff && !owner && !accessOf(host).enabled) return { code: 'terminal_server_disabled', message: terminalAccessOffMessage(this.opts.hostKind) }
      if (this.authCount >= RPC_MAX_CLIENT_SOCKETS) return { code: 'too_many_connections', message: `OrgAI already serves ${RPC_MAX_CLIENT_SOCKETS} terminal clients.` }
      return undefined
    }
    const before = gateProblem()
    if (before) return fail(before)
    if (handoff) {
      // The proof verified; the desktop peer check may take DESKTOP_HELLO_PEER_CHECK_MS, which the handshake deadline
      // (RPC_HANDSHAKE_TIMEOUT_MS from accept) would otherwise cut, closing the app's connection mid-check (seen on a
      // loaded Mac, where ps and lsof ran to the budget). Re-arm it past the check.
      if (conn.timer) clearTimeout(conn.timer)
      conn.timer = setTimeout(() => {
        if (conn.state === 'hello') this.kill(conn)
      }, DESKTOP_HELLO_PEER_CHECK_MS + RPC_HANDSHAKE_TIMEOUT_MS)
      conn.timer.unref?.()
    }
    let peer: 'ok' | 'descendant' | 'unavailable'
    try {
      const fd = socketFdOf(conn.socket)
      // A desktop hello gets a longer budget (the app waits on it; a missed descendant would be able to stop the host).
      const budget = handoff ? DESKTOP_HELLO_PEER_CHECK_MS : undefined
      const check =
        this.opts.peerCheck ??
        ((pid: number, socketFd?: number, timeoutMs?: number) =>
          checkPeerAncestry(pid, { ...(socketFd === undefined ? {} : { socketFd }), ...(timeoutMs === undefined ? {} : { timeoutMs }) }))
      peer = await check(p.pid, fd, budget)
    } catch {
      peer = 'unavailable'
    }
    if (conn.state !== 'hello') return
    if (peer === 'descendant') {
      this.log(`Refused client ${conn.id}: its process descends from this host (an agent's tool).`)
      return fail({ code: 'agent_descendant_refused', message: "OrgAI refuses terminal connections from its own agents' processes." })
    }
    if (peer === 'unavailable') this.log(`Client ${conn.id}: peer ancestry check unavailable; allowed.`)
    // Re-check after the await: another hello may have taken the last slot, or a drain may have begun.
    const after = gateProblem()
    if (after) return fail(after)
    // Never more than Terminal access allows (review H2): decide and configure need AppSettings.terminalAccessLevel
    // 'full', which only the desktop window sets (or `orgai terminal-access` on a Node host). The one exception is an
    // in-process host's own CLI (owner proof, any stored choice). A handoff connection gets exactly HOST_HANDOFF_SCOPES.
    const { granted: grantedScopes, withheld } = handoff
      ? { granted: [...HOST_HANDOFF_SCOPES], withheld: [] as HostScope[] }
      : grantScopes(p.requestedScopes, owner ? 'full' : accessOf(this.host!).level)
    const result: RpcHelloResult = {
      protocolVersion: 1,
      hostInstanceId: this.opts.hostInstanceId,
      hostKind: this.opts.hostKind,
      appVersion: this.opts.appVersion,
      dataDir: this.opts.dataDir,
      mock: this.opts.mock,
      grantedScopes,
      hostProof: hostProof(secret, {
        protocolVersion: HOST_PROTOCOL_VERSION,
        hostInstanceId: this.opts.hostInstanceId,
        clientNonce: p.clientNonce,
        hostNonce: conn.hostNonce,
        hostKind: this.opts.hostKind,
        appVersion: this.opts.appVersion,
        dataDir: this.opts.dataDir,
        mock: this.opts.mock,
        grantedScopes,
        ...(handoff ? { handoff: true } : {})
      })
    }
    if (handoff) result.handoff = true
    if (p.clientVersion !== this.opts.appVersion) {
      result.versionSkewWarning = `This orgai CLI is version ${p.clientVersion} and the running OrgAI is ${this.opts.appVersion}; update them to the same version.`
    }
    if (conn.timer) clearTimeout(conn.timer)
    conn.timer = undefined
    conn.state = 'auth'
    conn.clientKind = p.clientKind
    conn.pid = p.pid
    conn.scopes = grantedScopes
    conn.withheld = withheld
    if (handoff) conn.handoff = true
    if (owner) conn.owner = true
    if (result.versionSkewWarning) conn.versionSkew = true
    conn.reader.maxLineBytes = RPC_BULK_FRAME_MAX_BYTES
    this.send(conn, rpcResult(HELLO_REQUEST_ID, result))
    const held = withheld.length ? `; withheld by Terminal access: ${withheld.join(', ')}` : ''
    this.log(`Client ${conn.id} connected (${owner ? 'in-process owner, ' : ''}${p.clientKind} ${p.clientVersion.slice(0, 40)}, scopes ${grantedScopes.join(', ') || 'none'}${held}).`)
    for (const line of conn.pendingLines.splice(0)) {
      if (conn.state !== 'auth') break
      this.onLine(conn, line)
    }
  }

  // ---------- Requests ----------

  private onRequest(conn: Conn, req: JsonRpcRequest, lineBytes: number): void {
    const { id, method } = req
    if (lineBytes > frameLimitFor(method).requestBytes) {
      return this.send(conn, rpcError(id, { code: 'frame_too_large', message: `${method} requests are limited to ${frameLimitFor(method).requestBytes} bytes.` }))
    }
    if (method === HOST_METHODS.hostHello) return this.send(conn, rpcError(id, { code: 'bad_request', message: 'Already connected.' }))
    // A handoff connection (4.4 step 5) reaches host.status and host.stop only, before any other check or dispatch.
    if (conn.handoff && !HOST_HANDOFF_METHODS.includes(method as (typeof HOST_HANDOFF_METHODS)[number])) {
      return this.send(conn, rpcError(id, { code: 'scope_denied', message: `${method}: ${DESKTOP_HANDOFF_UNAVAILABLE_MESSAGE}` }))
    }
    if (method === HOST_IPC.runsSubscribe) return this.runsSubscribe(conn, req)
    if (method === HOST_METHODS.hostSubscribe) return this.hostSubscribe(conn, req)
    const host = this.host
    if (!host) return this.send(conn, rpcError(id, { code: 'host_starting', message: 'OrgAI is starting; try again in a moment.', retryAfterMs: HOST_STARTING_RETRY_MS }))
    if (conn.inflight >= RPC_MAX_INFLIGHT_PER_SOCKET) {
      return this.send(conn, rpcError(id, { code: 'too_many_requests', message: `At most ${RPC_MAX_INFLIGHT_PER_SOCKET} requests may be in flight on one connection.` }))
    }
    const entry = channelEntry(method)
    const scope = entry && 'scope' in entry ? entry.scope : undefined
    if (conn.versionSkew && method !== HOST_METHODS.hostStop && scope === 'configure') {
      return this.send(
        conn,
        rpcError(id, { code: 'scope_denied', message: `${method} needs the same orgai and OrgAI version (the 'configure' scope is limited to host.stop across versions); update them to the same version.` })
      )
    }
    // host.stop is the one 'configure' channel any client that asked for 'configure' may call whatever the Terminal
    // access level: it does nothing a same-user `kill` of the pid in daemon.json could not (`orgai daemon stop`).
    const stopOnly = method === HOST_METHODS.hostStop && conn.withheld.includes('configure')
    if (scope !== undefined && conn.withheld.includes(scope as HostScope) && !stopOnly) {
      return this.send(conn, rpcError(id, { code: 'scope_denied', message: `${method} needs the '${scope}' scope. ${terminalAccessLevelMessage(this.opts.hostKind)}` }))
    }
    if (turnsNodeTerminalAccessOff(this.opts.hostKind, method, req.params, () => host.settings.get())) {
      return this.send(conn, rpcError(id, { code: 'bad_request', message: NODE_TERMINAL_ACCESS_OFF_REFUSED }))
    }
    const grantedScopes: HostScope[] = stopOnly ? [...conn.scopes, 'configure'] : conn.scopes
    const authorizing = method === IPC.mcpAuthorize ? this.trackAuthorize(conn, req.params) : undefined
    conn.inflight++
    let p: Promise<unknown>
    try {
      p = host.dispatcher.invokeRpc(method, req.params, { surface: 'socket', clientKind: conn.clientKind, pid: conn.pid, grantedScopes })
    } catch (e) {
      p = Promise.reject(e)
    }
    p.then(
      (result) => this.sendResult(conn, id, method, result),
      (err: unknown) => this.send(conn, rpcError(id, toRpcError(err)))
    ).finally(() => {
      authorizing?.()
      conn.inflight--
      if (conn.closeAfterInflight && conn.inflight === 0 && conn.state === 'auth') this.refuseQueued(conn)
    })
  }

  /** An mcp:authorize with announceUrl: this socket hears that target's `mcp.authorize` until it answers. */
  private trackAuthorize(conn: Conn, params: unknown): (() => void) | undefined {
    const input = Array.isArray(params) ? params[0] : undefined
    if (!isObj(input) || input.announceUrl !== true) return undefined
    const key = authorizeKey(input)
    if (key === undefined) return undefined
    conn.authorizing.set(key, (conn.authorizing.get(key) ?? 0) + 1)
    return () => {
      const n = (conn.authorizing.get(key) ?? 1) - 1
      if (n > 0) conn.authorizing.set(key, n)
      else conn.authorizing.delete(key)
    }
  }

  /** Serialize a result within the channel's response cap and the bulk budget, else answer frame_too_large. */
  private sendResult(conn: Conn, id: JsonRpcId, method: string, result: unknown): boolean {
    if (conn.state !== 'auth') return false
    let frame: string
    try {
      frame = encodeFrame(rpcResult(id, result))
    } catch (e) {
      this.send(conn, rpcError(id, { code: 'bad_request', message: (e as Error).message }))
      return false
    }
    const bytes = Buffer.byteLength(frame, 'utf8')
    const limit = frameLimitFor(method).responseBytes
    if (bytes - 1 > limit) {
      this.send(conn, rpcError(id, { code: 'frame_too_large', message: `The ${method} answer is larger than ${limit} bytes.` }))
      return false
    }
    if (bytes > RPC_CONTROL_REQUEST_MAX_BYTES) {
      const res = this.budget.reserve(bytes)
      if (!res) {
        this.send(conn, rpcError(id, { code: 'frame_too_large', message: BULK_BUDGET_MESSAGE }))
        return false
      }
      conn.reservations.add(res)
      return conn.queue.enqueue(frame, {
        onDone: () => {
          res.release()
          conn.reservations.delete(res)
        }
      })
    }
    return conn.queue.enqueue(frame)
  }

  private runsSubscribe(conn: Conn, req: JsonRpcRequest): void {
    const host = this.host
    if (!host) return this.send(conn, rpcError(req.id, { code: 'host_starting', message: 'OrgAI is starting; try again in a moment.', retryAfterMs: HOST_STARTING_RETRY_MS }))
    try {
      const g = gateRequest(req.method, req.params, { grantedScopes: conn.scopes, hostKind: this.opts.hostKind })
      const input = parseRunsSubscribeInput(g.args[0])
      const { result, subscription } = subscribeRuns(input, {
        view: host.runs,
        journal: this.journal,
        hostInstanceId: this.opts.hostInstanceId,
        storedProjectIds: () => host.services.projects.list().map((p) => p.id),
        now: this.opts.now
      })
      // Queue the result frame before delivery starts, so no push precedes it (all synchronous).
      if (this.sendResult(conn, req.id, req.method, result)) conn.runs = subscription
    } catch (e) {
      this.send(conn, rpcError(req.id, toRpcError(e)))
    }
  }

  private hostSubscribe(conn: Conn, req: JsonRpcRequest): void {
    try {
      const g = gateRequest(req.method, req.params, { grantedScopes: conn.scopes, hostKind: this.opts.hostKind })
      const input = g.args[0]
      if (!isObj(input) || !Array.isArray(input.topics)) throw new HostRpcFailure('bad_request', 'host.subscribe takes { topics: [...] }.')
      if (input.topics.length > 64) throw new HostRpcFailure('bad_request', 'host.subscribe: too many topics.')
      const topics = new Set<HostSubscribeTopic>()
      for (const t of input.topics) {
        if (typeof t !== 'string') throw new HostRpcFailure('bad_request', 'host.subscribe topics must be strings.')
        if (HOST_SUBSCRIBE_TOPICS.includes(t as HostSubscribeTopic)) topics.add(t as HostSubscribeTopic)
      }
      const result: HostSubscribeResult = { topics: HOST_SUBSCRIBE_TOPICS.filter((t) => topics.has(t)) }
      if (this.sendResult(conn, req.id, req.method, result)) conn.topics = new Set(result.topics)
    } catch (e) {
      this.send(conn, rpcError(req.id, toRpcError(e)))
    }
  }

  // ---------- Pushes ----------

  private onHostEvent(channel: HostPushChannel, payload: unknown): void {
    if (this.closed) return
    // Terminal access switched off: every authenticated client loses its connection (and so its scopes) at once, not
    // only new handshakes (AppSettings.terminalServer, cli-spec invariant 2). In-flight answers (the settings:set that
    // turned it off) still go out first.
    if (channel === 'settings:changed' && this.host) {
      const access = accessOf(this.host)
      this.terminalOn = access.enabled
      const lowered = this.accessLevel === 'full' && access.level !== 'full'
      this.accessLevel = access.level
      if (!this.terminalOn) this.dropAuthenticated((c) => !c.owner)
      else {
        // A lower level takes effect at once: sockets holding scopes it no longer allows are closed, as when Terminal
        // access is turned off; the client reconnects with what it may have now.
        if (lowered) this.dropAuthenticated((c) => !c.owner && c.scopes.some((s) => !scopesForAccessLevel(access.level).includes(s)), 'Terminal access was narrowed')
      }
    }
    if (channel === 'runs:event') {
      this.onRunEvent(payload as RunEvent)
      return
    }
    const topic = this.channelTopic.get(channel)
    if (!topic) return
    // An announced OAuth authorization URL goes only to the socket whose mcp:authorize asked for it (review Low).
    const authorizeFor = channel === IPC.connectionsEvent ? announcedAuthorizeKey(payload) : undefined
    let frame: string | undefined
    for (const c of this.conns) {
      if (c.state !== 'auth' || !c.topics.has(topic)) continue
      if (authorizeFor !== undefined && !c.authorizing.has(authorizeFor)) continue
      if (frame === undefined) {
        try {
          frame = encodeFrame(rpcNotification(channel, payload))
        } catch (e) {
          this.log(`Could not encode a ${channel} push: ${(e as Error).message}`)
          return
        }
      }
      c.queue.enqueue(frame, { push: true })
    }
  }

  private onRunEvent(event: RunEvent): void {
    // Nobody can read the journal while Terminal access is off (handshakes are refused): skip the per-event JSON
    // encoding and the retained ring. A client connecting later gets a snapshot (its sinceSeq predates the gap).
    if (!this.terminalOn && !this.hasAuthenticated()) {
      if (!this.journalPaused) {
        this.journalPaused = true
        this.journal.markGap()
      }
      return
    }
    this.journalPaused = false
    let appended
    try {
      appended = this.journal.append(event)
    } catch (e) {
      this.log(`Could not journal a ${String((event as { type?: unknown })?.type)} event: ${(e as Error).message}`)
      return
    }
    const durable = appended.seq !== undefined
    let frame: string | undefined
    const meta = metaOf(appended.event)
    for (const c of this.conns) {
      if (c.state !== 'auth' || !c.runs) continue
      let match: boolean
      try {
        match = c.runs.matches(appended.event, durable)
      } catch {
        match = false
      }
      if (!match) continue
      frame ??= durable
        ? `{"jsonrpc":"2.0","method":"runs:event","params":{"seq":${appended.seq},"event":${appended.json}}}\n`
        : `{"jsonrpc":"2.0","method":"runs:event","params":{"atSeq":${appended.atSeq},"event":${appended.json}}}\n`
      c.queue.enqueue(frame, { push: true, meta })
    }
  }
}

function metaOf(e: RunEvent): FrameMeta | undefined {
  if (e.type === 'agent.partial') return { kind: 'partial', key: frameKey(e.runId, e.agentId) }
  if (e.type === 'transcript') return { kind: 'transcript', key: frameKey(e.runId, e.entry.agentId) }
  if (e.type === 'agent.upsert') return { kind: 'upsert', key: frameKey(e.runId, e.agent.id) }
  return undefined
}

/** HostRpcFailure as its wire error; any other Error is bad_request with its message (never a stack). */
export function toRpcError(err: unknown): HostRpcError {
  if (err instanceof HostRpcFailure) return err.toRpcError()
  if (err instanceof Error) return { code: 'bad_request', message: err.message || 'The request failed.' }
  return { code: 'bad_request', message: 'The request failed.' }
}
