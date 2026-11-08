/**
 * The CLI's host client (cli-spec 3.3): read `<dataDir>/run/daemon.json`, connect to the advertised endpoint, run the
 * mutual HMAC handshake (host.challenge -> host.hello with clientProof -> hostProof checked) and then speak JSON-RPC
 * 2.0 with at most RPC_MAX_INFLIGHT_PER_SOCKET requests in flight (the rest queue here). Never starts a host, never
 * logs the secret, a proof or a nonce. Electron-free; relative imports only.
 */
import { connect as netConnect, type Socket } from 'node:net'
import {
  HOST_KINDS,
  HOST_PROTOCOL_VERSION,
  RPC_BULK_FRAME_MAX_BYTES,
  RPC_MAX_INFLIGHT_PER_SOCKET,
  type DaemonInfo,
  type HostClientKind,
  type HostRpcError,
  type HostScope,
  type RpcHelloParams,
  type RpcHelloResult
} from '../../shared/types'
import { readDaemonInfo } from '../../main/host/ownership'
import { isLiveProcessCached } from '../../main/host/processInfo'
import {
  HELLO_REQUEST_ID,
  LineReader,
  clientProof,
  daemonSecretPath,
  encodeFrame,
  errorDataOf,
  hostProof,
  isNotification,
  isResponse,
  newNonce,
  ownerProof,
  parseFrame,
  proofMatches,
  readDaemonSecret,
  rpcRequest,
  type JsonRpcId,
  type JsonRpcResponse
} from '../../main/host/protocol'
import type { ConnectResult, HostClient } from '../types'

/** A JSON-RPC error answer from the host; `data` is its HostRpcError (code in data.code). */
export class HostCallError extends Error {
  readonly data: HostRpcError
  constructor(data: HostRpcError) {
    super(data.message)
    this.name = 'HostCallError'
    this.data = data
  }
}

export interface ConnectHostOptions {
  dataDir: string
  scopes: HostScope[]
  clientKind?: HostClientKind
  clientVersion: string
  cwd: string
  pid: number
  /** How long a 'starting' host (daemon.json state or a host_starting answer) is waited for. Default 2000. */
  waitStartingMs?: number
  /** Connect and per-handshake-step timeout. Default 1500 (the challenge gets at least 2000). */
  connectTimeoutMs?: number
  /** Injectable for tests. */
  net?: { connect(endpoint: string): Socket }
  isLive?: (pid: number, startTime?: string) => boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  platform?: NodeJS.Platform
  /** Default call timeout of the returned client. Default 30000. */
  callTimeoutMs?: number
  /**
   * The in-memory owner key of the in-process host this process started (InprocHostHandle.ownerKey): the hello
   * then carries an ownerProof, the only way to get decide / configure from an in-process host past its Terminal
   * access level. Sent only to a host whose hostInstanceId equals `ownerHostInstanceId`.
   */
  ownerKey?: string
  ownerHostInstanceId?: string
}

const CHALLENGE_TIMEOUT_MS = 2000
const STARTING_POLL_MS = 100
export const DEFAULT_CALL_TIMEOUT_MS = 30_000

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type Failure = Extract<ConnectResult, { ok: false }>
type Attempt = { kind: 'done'; result: ConnectResult } | { kind: 'starting'; retryAfterMs?: number; message: string }

const fail = (reason: Failure['reason'], message: string, daemon?: DaemonInfo): ConnectResult => ({
  ok: false,
  reason,
  message,
  ...(daemon ? { daemon } : {})
})

/** Connect to and authenticate with the host that owns `dataDir`. Never throws; never starts a host. */
export async function connectHost(opts: ConnectHostOptions): Promise<ConnectResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const isLive = opts.isLive ?? ((pid: number, start?: string) => isLiveProcessCached(pid, start))
  const waitStartingMs = opts.waitStartingMs ?? 2000
  const deadline = now() + waitStartingMs
  let lastStarting = 'OrgAI is still starting.'
  for (;;) {
    const daemon = readDaemonInfo(opts.dataDir)
    if (!daemon) return fail('no_host', 'OrgAI is not running for this data folder.')
    if (!isLive(daemon.pid, daemon.processStartTime)) return fail('no_host', `OrgAI is not running for this data folder (pid ${daemon.pid} has exited).`, daemon)
    if (daemon.state === 'draining') return fail('draining', 'OrgAI is shutting down for this data folder.', daemon)
    if (daemon.state === 'starting') {
      if (now() >= deadline) return fail('starting', lastStarting, daemon)
      await sleep(Math.min(STARTING_POLL_MS, Math.max(1, deadline - now())))
      continue
    }
    const attempt = await attemptOnce(opts, daemon, isLive)
    if (attempt.kind === 'done') return attempt.result
    lastStarting = attempt.message
    if (now() >= deadline) return fail('starting', lastStarting, daemon)
    const wait = Math.max(STARTING_POLL_MS, attempt.retryAfterMs ?? STARTING_POLL_MS)
    await sleep(Math.min(wait, Math.max(1, deadline - now())))
  }
}

/** Buffers parsed frames from a socket so the handshake can await them one at a time. */
class FrameInbox {
  readonly frames: unknown[] = []
  private waiter: (() => void) | undefined
  closed: Error | null | undefined
  readonly reader = new LineReader()

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData)
    socket.on('close', this.onClose)
    socket.on('error', this.onError)
  }

  private onData = (chunk: Buffer): void => {
    const { lines, overflow } = this.reader.push(chunk)
    for (const line of lines) {
      const parsed = parseFrame(line)
      this.frames.push(parsed.ok ? parsed.message : { __unparsable: true })
    }
    if (overflow) {
      this.closed ??= new Error('The host sent a frame larger than allowed.')
      this.socket.destroy()
    }
    this.wake()
  }

  private onError = (e: Error): void => {
    this.closed ??= e
    this.wake()
  }

  private onClose = (): void => {
    this.closed ??= null
    this.wake()
  }

  private wake(): void {
    const w = this.waiter
    this.waiter = undefined
    w?.()
  }

  /** The next frame, or undefined on close or timeout. */
  async next(timeoutMs: number): Promise<{ frame: unknown } | { closed: true; error: Error | null } | { timeout: true }> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.frames.length) return { frame: this.frames.shift() }
      if (this.closed !== undefined) return { closed: true, error: this.closed }
      const left = deadline - Date.now()
      if (left <= 0) return { timeout: true }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          this.waiter = undefined
          resolve()
        }, left)
        this.waiter = () => {
          clearTimeout(t)
          resolve()
        }
      })
    }
  }

  /** Stop listening (the client takes the socket over). */
  detach(): void {
    this.socket.off('data', this.onData)
    this.socket.off('close', this.onClose)
    this.socket.off('error', this.onError)
  }
}

function openSocket(opts: ConnectHostOptions, endpoint: string, timeoutMs: number): Promise<{ socket: Socket } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false
    let socket: Socket
    try {
      socket = (opts.net ?? { connect: (e: string) => netConnect(e) }).connect(endpoint)
    } catch (e) {
      resolve({ error: (e as NodeJS.ErrnoException).code ?? 'ECONNECT' })
      return
    }
    const finish = (r: { socket: Socket } | { error: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('connect', onConnect)
      socket.off('error', onError)
      if ('error' in r) socket.destroy()
      resolve(r)
    }
    const onConnect = (): void => finish({ socket })
    const onError = (e: NodeJS.ErrnoException): void => finish({ error: e.code ?? 'ECONNECT' })
    const timer = setTimeout(() => finish({ error: 'ETIMEDOUT' }), timeoutMs)
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

async function attemptOnce(opts: ConnectHostOptions, daemon: DaemonInfo, isLive: (pid: number, start?: string) => boolean): Promise<Attempt> {
  const done = (result: ConnectResult): Attempt => ({ kind: 'done', result })
  if (daemon.listening === false) return done(fail('refused', 'The host at this data folder has no listener.', daemon))
  const connectTimeoutMs = opts.connectTimeoutMs ?? 1500
  const opened = await openSocket(opts, daemon.endpoint, connectTimeoutMs)
  if ('error' in opened) {
    const gone = opened.error === 'ENOENT' || opened.error === 'ECONNREFUSED' || opened.error === 'ETIMEDOUT'
    if (gone && !isLive(daemon.pid, daemon.processStartTime)) return done(fail('no_host', 'OrgAI is not running for this data folder.', daemon))
    return done(fail('unreachable', `The OrgAI host (pid ${daemon.pid}) did not answer at its socket (${opened.error}).`, daemon))
  }
  const socket = opened.socket
  const inbox = new FrameInbox(socket)
  const abort = (result: ConnectResult): Attempt => {
    inbox.detach()
    socket.on('error', () => {})
    socket.destroy()
    return done(result)
  }
  const closedResult = (): ConnectResult =>
    isLive(daemon.pid, daemon.processStartTime)
      ? fail('unreachable', `The OrgAI host (pid ${daemon.pid}) closed the connection during the handshake.`, daemon)
      : fail('no_host', 'OrgAI is not running for this data folder.', daemon)

  // Step 1: host.challenge.
  const first = await inbox.next(Math.max(CHALLENGE_TIMEOUT_MS, connectTimeoutMs))
  if ('timeout' in first) return abort(fail('unreachable', `The OrgAI host (pid ${daemon.pid}) did not send its challenge.`, daemon))
  if ('closed' in first) return abort(closedResult())
  const challenge = first.frame
  if (!isNotification(challenge) || challenge.method !== 'host.challenge' || !isObj(challenge.params)) {
    return abort(fail('unreachable', 'The process at the OrgAI socket did not answer like an OrgAI host.', daemon))
  }
  const { protocolVersion, hostInstanceId, hostNonce } = challenge.params
  if (protocolVersion !== HOST_PROTOCOL_VERSION) {
    return abort(fail('protocol_mismatch', `The OrgAI host speaks protocol ${String(protocolVersion)}; this CLI speaks ${HOST_PROTOCOL_VERSION}. Update OrgAI or the CLI.`, daemon))
  }
  if (hostInstanceId !== daemon.hostInstanceId || typeof hostNonce !== 'string') {
    return abort(fail('unreachable', 'The process at the OrgAI socket is not the host daemon.json names.', daemon))
  }

  // Step 2: host.hello.
  const secret = readDaemonSecret(opts.dataDir, opts.platform)
  if (!secret) {
    return abort(
      fail('auth_failed', `Could not read the host's handshake secret (${daemonSecretPath(opts.dataDir)}). It must be a private file (mode 0600) in the run folder ${daemonSecretPath(opts.dataDir).replace(/[\\/][^\\/]+$/, '')}.`, daemon)
    )
  }
  const clientNonce = newNonce()
  const base = {
    protocolVersion: HOST_PROTOCOL_VERSION,
    clientKind: opts.clientKind ?? 'cli',
    clientVersion: opts.clientVersion,
    pid: opts.pid,
    cwd: opts.cwd,
    clientNonce,
    requestedScopes: [...opts.scopes]
  } satisfies Omit<RpcHelloParams, 'clientProof'>
  const params: RpcHelloParams = {
    ...base,
    clientProof: clientProof(secret, { ...base, hostInstanceId: daemon.hostInstanceId, hostNonce })
  }
  if (opts.ownerKey && opts.ownerHostInstanceId === daemon.hostInstanceId) {
    params.ownerProof = ownerProof(opts.ownerKey, { hostInstanceId: daemon.hostInstanceId, hostNonce, clientNonce, clientProof: params.clientProof })
  }
  try {
    socket.write(encodeFrame(rpcRequest(HELLO_REQUEST_ID, 'host.hello', params as unknown as Record<string, unknown>)))
  } catch {
    return abort(closedResult())
  }

  // Step 3: the hello answer (notifications before it are not expected; anything else is skipped).
  let response: JsonRpcResponse | undefined
  const helloDeadline = Date.now() + Math.max(CHALLENGE_TIMEOUT_MS, connectTimeoutMs)
  while (!response) {
    const next = await inbox.next(Math.max(0, helloDeadline - Date.now()))
    if ('timeout' in next) return abort(fail('unreachable', `The OrgAI host (pid ${daemon.pid}) did not answer host.hello.`, daemon))
    if ('closed' in next) return abort(closedResult())
    if (isResponse(next.frame) && (next.frame.id === HELLO_REQUEST_ID || next.frame.id === null)) response = next.frame
  }
  if ('error' in response) {
    const data = errorDataOf(response)
    switch (data.code) {
      case 'host_starting':
        inbox.detach()
        socket.on('error', () => {})
        socket.destroy()
        return { kind: 'starting', message: data.message || 'OrgAI is still starting.', ...(data.retryAfterMs !== undefined ? { retryAfterMs: data.retryAfterMs } : {}) }
      case 'host_draining':
        return abort(fail('draining', data.message || 'OrgAI is shutting down for this data folder.', daemon))
      case 'not_owner':
        return abort(fail('not_owner', data.message, daemon))
      case 'agent_descendant_refused':
      case 'too_many_connections':
        return abort(fail('refused', data.message, daemon))
      case 'protocol_mismatch':
        return abort(fail('protocol_mismatch', data.message, daemon))
      case 'auth_failed':
        return abort(fail('auth_failed', data.message, daemon))
      default:
        return abort(fail('refused', data.message, daemon))
    }
  }
  const hello = parseHelloResult(response.result)
  if (!hello || hello.hostInstanceId !== daemon.hostInstanceId) {
    return abort(fail('auth_failed', 'The OrgAI host answered host.hello with something this CLI cannot verify.', daemon))
  }
  const expected = hostProof(secret, {
    protocolVersion: hello.protocolVersion,
    hostInstanceId: hello.hostInstanceId,
    clientNonce,
    hostNonce,
    hostKind: hello.hostKind,
    appVersion: hello.appVersion,
    dataDir: hello.dataDir,
    mock: hello.mock,
    grantedScopes: hello.grantedScopes
  })
  if (!proofMatches(expected, hello.hostProof)) {
    return abort(fail('auth_failed', 'The OrgAI host could not prove it holds this data folder’s secret. Connection closed.', daemon))
  }
  inbox.detach()
  inbox.reader.maxLineBytes = RPC_BULK_FRAME_MAX_BYTES
  const client = new SocketHostClient(socket, inbox.reader, hello, daemon, opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)
  // Frames that arrived together with the hello answer.
  for (const f of inbox.frames.splice(0)) client.handleFrame(f)
  if (inbox.closed !== undefined) client.handleClose(inbox.closed ?? undefined)
  return done({ ok: true, client })
}

const KINDS: ReadonlySet<string> = new Set<string>(HOST_KINDS)
const SCOPES = new Set(['read', 'operate', 'decide', 'configure'])

function parseHelloResult(v: unknown): RpcHelloResult | null {
  if (!isObj(v)) return null
  const { protocolVersion, hostInstanceId, hostKind, appVersion, dataDir, mock, grantedScopes, hostProof: proof, versionSkewWarning } = v
  if (protocolVersion !== HOST_PROTOCOL_VERSION) return null
  if (typeof hostInstanceId !== 'string' || typeof hostKind !== 'string' || !KINDS.has(hostKind)) return null
  if (typeof appVersion !== 'string' || typeof dataDir !== 'string' || typeof mock !== 'boolean' || typeof proof !== 'string') return null
  if (!Array.isArray(grantedScopes) || !grantedScopes.every((s) => typeof s === 'string' && SCOPES.has(s))) return null
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    hostInstanceId,
    hostKind: hostKind as RpcHelloResult['hostKind'],
    appVersion,
    dataDir,
    mock,
    grantedScopes: grantedScopes as HostScope[],
    ...(typeof versionSkewWarning === 'string' ? { versionSkewWarning } : {}),
    hostProof: proof
  }
}

interface Pending {
  id: number
  method: string
  params?: unknown[] | Record<string, unknown>
  resolve(v: unknown): void
  reject(e: Error): void
  timer?: ReturnType<typeof setTimeout>
  /** The caller gave up (timeout): the answer is dropped, but the slot stays taken until it arrives. */
  abandoned: boolean
}

/** An authenticated JSON-RPC connection (HostClient). */
export class SocketHostClient implements HostClient {
  private nextId = HELLO_REQUEST_ID + 1
  private readonly inflight = new Map<JsonRpcId, Pending>()
  private readonly queue: Pending[] = []
  private readonly notificationFns = new Set<(method: string, params: unknown) => void>()
  private readonly closeFns = new Set<(err?: Error) => void>()
  private closed = false
  private closeErr: Error | undefined

  constructor(
    private readonly socket: Socket,
    private readonly reader: LineReader,
    readonly hello: RpcHelloResult,
    readonly daemon: DaemonInfo,
    private readonly defaultTimeoutMs: number
  ) {
    socket.on('data', (chunk: Buffer) => {
      const { lines, overflow } = this.reader.push(chunk)
      for (const line of lines) {
        const parsed = parseFrame(line)
        if (parsed.ok) this.handleFrame(parsed.message)
      }
      if (overflow) {
        this.closeErr ??= new Error('The host sent a frame larger than allowed.')
        socket.destroy()
      }
    })
    socket.on('error', (e: Error) => {
      this.closeErr ??= e
    })
    socket.on('close', () => this.handleClose(this.closeErr))
  }

  call<T = unknown>(method: string, params?: unknown[] | Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The connection to the OrgAI host is closed.'))
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { id: this.nextId++, method, params, resolve: resolve as (v: unknown) => void, reject, abandoned: false }
      const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        p.timer = setTimeout(() => {
          p.abandoned = true
          const q = this.queue.indexOf(p)
          if (q !== -1) this.queue.splice(q, 1)
          reject(new Error(`The OrgAI host did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`))
        }, timeoutMs)
      }
      this.queue.push(p)
      this.pump()
    })
  }

  onNotification(fn: (method: string, params: unknown) => void): () => void {
    this.notificationFns.add(fn)
    return () => this.notificationFns.delete(fn)
  }

  onClose(fn: (err?: Error) => void): () => void {
    if (this.closed) {
      // Already closed: still tell a late listener, once, asynchronously.
      queueMicrotask(() => fn(this.closeErr))
      return () => {}
    }
    this.closeFns.add(fn)
    return () => this.closeFns.delete(fn)
  }

  close(): void {
    if (this.closed) return
    this.socket.end()
    this.socket.destroy()
    this.handleClose(undefined)
  }

  private pump(): void {
    while (!this.closed && this.inflight.size < RPC_MAX_INFLIGHT_PER_SOCKET && this.queue.length) {
      const p = this.queue.shift()!
      let frame: string
      try {
        frame = encodeFrame(rpcRequest(p.id, p.method, p.params))
      } catch (e) {
        clearTimeout(p.timer)
        p.reject(new Error(`Could not encode ${p.method}: ${(e as Error).message}`))
        continue
      }
      this.inflight.set(p.id, p)
      this.socket.write(frame)
    }
  }

  /** One parsed frame from the host. */
  handleFrame(msg: unknown): void {
    if (isResponse(msg)) {
      if (msg.id === null) return
      const p = this.inflight.get(msg.id)
      if (!p) return
      this.inflight.delete(msg.id)
      clearTimeout(p.timer)
      if (!p.abandoned) {
        if ('error' in msg) p.reject(new HostCallError(errorDataOf(msg)))
        else p.resolve(msg.result)
      }
      this.pump()
      return
    }
    if (isNotification(msg)) {
      for (const fn of [...this.notificationFns]) {
        try {
          fn(msg.method, msg.params)
        } catch {
          // A listener's failure never breaks the connection.
        }
      }
    }
  }

  /** The socket closed: reject everything outstanding and tell the listeners once. */
  handleClose(err?: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeErr = err
    const gone = new Error(err ? `The connection to the OrgAI host failed: ${err.message}` : 'The connection to the OrgAI host closed.')
    for (const p of [...this.inflight.values(), ...this.queue]) {
      clearTimeout(p.timer)
      if (!p.abandoned) p.reject(gone)
    }
    this.inflight.clear()
    this.queue.length = 0
    for (const fn of [...this.closeFns]) {
      try {
        fn(err)
      } catch {
        // ignore
      }
    }
    this.closeFns.clear()
  }
}
