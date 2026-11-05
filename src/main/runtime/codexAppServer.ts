import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { trackChildProcess } from '../host/shutdown'
import { scrubControlEnv } from './childEnv'
import { checkCodexBinary, lookupCodexBinary, type CodexBinary, type CodexLookupOptions, type CodexVersionRunner } from './codexBinary'

/**
 * A client for `codex app-server`: JSON-RPC 2.0 messages, one JSON object per line, over the child's stdio.
 * Shared by the Codex adapter (threads and turns) and the connection service (account, login, models, rate
 * limits). Vendor protocol shapes beyond the envelope live in codexProtocol.ts.
 *
 * Wire format checked against `codex app-server generate-json-schema` / `generate-ts --experimental` of
 * @openai/codex 0.166.0 (token-free): requests are { id, method, params }, responses { id, result } or
 * { id, error: { code, message, data? } }, notifications { method, params }; the "jsonrpc" field is not
 * required and is not sent. The client sends `initialize` and then the `initialized` notification.
 */

/**
 * OrgAI's own CODEX_HOME under the data dir. The connection service (login, account, models) and the Codex
 * adapter (runs) both use it, so OrgAI keeps its own ChatGPT login and config.toml and never loads the
 * user's personal ~/.codex configuration (their MCP servers, profiles, approval defaults).
 */
export function codexHomeDir(dataDir: string): string {
  return join(dataDir, 'codex')
}

export type { CodexBinary } from './codexBinary'

/**
 * The native codex binary (cli-standalone 6.2: ORGAI_CODEX_PATH, the per-platform package, then PATH; shims mapped to
 * their native package, never spawned). Undefined when none was found; lookupCodexBinary says why.
 */
export function resolveCodexBinary(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  opts: Omit<CodexLookupOptions, 'platform' | 'arch'> = {}
): CodexBinary | undefined {
  return lookupCodexBinary({ ...opts, platform, arch }).binary
}

/** start() after (or during) close(): nothing was spawned. */
export const CODEX_CLOSED_BEFORE_START = 'codex app-server was closed before it started'

/** How many non-empty stderr lines CodexAppServer keeps for exit errors, and their total length cap. */
export const STDERR_TAIL_LINES = 10
export const STDERR_TAIL_MAX_CHARS = 2_000
/** Env keys whose values are not secret (and are useful in an error, e.g. a missing CODEX_HOME path). */
const PLAIN_ENV_KEYS = new Set(['CODEX_HOME', 'PATH', 'Path', 'RUST_LOG'])

/** Replace every occurrence of each secret (at least 4 characters) with [redacted], longest first. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of [...secrets].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join('[redacted]')
  return out
}

/** Characters kept back when a newline-free stderr run is flushed (longer than any key we pass). */
const STDERR_CARRY = 1_024

/**
 * Mask key-like tokens exact-value redaction cannot match (a gateway echoing a key fragment, a token codex holds
 * itself, an inline MCP value): Bearer tokens, sk-/pk-/rk- keys, and key=value / "key": value pairs whose name
 * says api key, token, secret or password.
 */
export function maskKeyLike(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk)-[\w.*-]{3,}/gi, '[redacted]')
    // Bounded quantifiers keep this linear on long lines.
    .replace(/((?:api[_-]?key|token|secret|password)[\w-]{0,40}"?\s{0,4}[=:]\s{0,4}"?)[^\s"',;]{4,}/gi, '$1[redacted]')
}

/** The error text for an app-server that exited: the exit code, then its last stderr lines when there are any. */
export function codexExitMessage(code: number | null | undefined, tail?: string, during?: string): string {
  const head = `codex app-server exited (code ${code ?? 'unknown'})${during ? ` during ${during}` : ''}`
  return tail ? `${head}: ${tail}` : head
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export class CodexRpcError extends Error {
  constructor(
    readonly method: string,
    readonly error: JsonRpcError
  ) {
    super(`${method}: ${error.message}`)
  }
}

export interface CodexAppServerOptions {
  /** Working directory of the app-server process. */
  cwd?: string
  /** Environment for the child (merged over process.env). Holds secrets (API keys): never log it. */
  env?: Record<string, string | undefined>
  /** `-c key=value` config overrides (TOML values), e.g. ['mcp_servers.github.command="npx"']. */
  config?: string[]
  /** Opt into experimental methods and fields (dynamicTools). Default true. */
  experimentalApi?: boolean
  /** Request timeout, ms. Default 30 s. Turns are long-running but their requests return at once. */
  requestTimeoutMs?: number
  /** Override the binary (tests). A binary without `source` skips the version check. */
  binary?: CodexBinary
  /** Runs `codex --version` (tests); default codexBinary.ts defaultCodexVersionRunner. */
  versionRunner?: CodexVersionRunner
  /** A warning to show the user (a run warning): Codex chosen through ORGAI_CODEX_PATH outside the tested version. */
  onWarning?(message: string): void
  /** stderr lines (debug logging), secrets replaced by [redacted] (see `redact`). */
  onStderr?(line: string): void
  /**
   * Extra secret values to scrub from stderr lines and the exit error (e.g. the run's API key). Every `env` value
   * except CODEX_HOME, PATH and RUST_LOG is scrubbed as well.
   */
  redact?: string[]
}

type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>
type NotificationHandler = (method: string, params: unknown) => void

/** One running `codex app-server` process. */
export class CodexAppServer {
  private child?: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number | string, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private notificationHandlers = new Set<NotificationHandler>()
  private serverRequestHandler?: ServerRequestHandler
  private buffer = ''
  private stderrBuffer = ''
  private stderrLines: string[] = []
  private closed = false
  private exitHandlers = new Set<(code: number | null, error?: Error) => void>()
  /** Resolves when the process exits. */
  readonly exited: Promise<void>
  private markExited!: () => void

  constructor(private options: CodexAppServerOptions = {}) {
    this.exited = new Promise((resolve) => (this.markExited = resolve))
  }

  /** Spawn the process and run the initialize handshake. Rejects when codex is missing or does not answer. */
  async start(clientVersion = '0.0.0'): Promise<unknown> {
    if (this.closed) throw new Error(CODEX_CLOSED_BEFORE_START)
    let binary = this.options.binary
    if (!binary) {
      const found = lookupCodexBinary()
      if (!found.binary) throw new Error(found.problem)
      binary = found.binary
    }
    // The version check covers every start: login, logout, discovery and runs (cli-standalone 6.2). Cached per binary.
    const check = await checkCodexBinary(binary, { run: this.options.versionRunner })
    if (!check.ok) throw new Error(check.reason)
    // close() may land while the version check runs (End session, a cancelled completion): never spawn after it.
    if (this.closed) throw new Error(CODEX_CLOSED_BEFORE_START)
    if (check.warning) this.options.onWarning?.(check.warning)
    // codex app-server exits 1 at once when CODEX_HOME names a folder that does not exist.
    // Owner-only: it holds the ChatGPT login (auth.json). The path is used exactly as the child will see it.
    const home = this.options.env?.CODEX_HOME
    if (home?.trim()) mkdirSync(home, { recursive: true, mode: 0o700 })
    // OrgAI's control variables (ORGAI_DATA_DIR, ORGAI_DAEMON_*, ORGAI_SECRET_*, ELECTRON_RUN_AS_NODE) never reach
    // Codex or the MCP servers it spawns, inherited or set by the connection (cli-spec 3.4(3)).
    const env: Record<string, string | undefined> = scrubControlEnv({ ...process.env, ...this.options.env })
    if (binary.pathDir) env.PATH = `${binary.pathDir}${delimiter}${env.PATH ?? env.Path ?? ''}`
    const args = ['app-server', ...(this.options.config ?? []).flatMap((c) => ['-c', c])]
    const child = spawn(binary.path, args, { cwd: this.options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    // A host that gives up at the shutdown hard limit kills it (host/shutdown.ts); untracked on exit.
    trackChildProcess(child, 'codex app-server')
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.onStderrData(chunk))
    // A write to a dying process raises EPIPE on stdin; the exit handler reports the real failure.
    child.stdin.on('error', () => {})
    child.on('error', (err) => this.handleExit(null, err))
    // 'close' fires once stdio has drained, so the stderr tail is complete. A grandchild holding the pipes open
    // must not hang the client: 'exit' settles it after a short grace period.
    child.on('close', (code) => this.handleExit(code))
    child.on('exit', (code) => {
      setTimeout(() => this.handleExit(code), 250).unref?.()
    })
    const result = await this.request('initialize', {
      clientInfo: { name: 'orgai', title: 'OrgAI', version: clientVersion },
      capabilities: { experimentalApi: this.options.experimentalApi !== false, requestAttestation: false }
    })
    this.notify('initialized')
    return result
  }

  /**
   * The last non-empty stderr lines (at most STDERR_TAIL_LINES and STDERR_TAIL_MAX_CHARS, newest kept), with
   * secrets redacted; '' when there are none. Includes a trailing line that has no newline yet.
   */
  stderrTail(): string {
    const partial = this.stderrBuffer.trim()
    const lines = partial ? [...this.stderrLines, this.scrub(partial)] : this.stderrLines
    const text = lines.slice(-STDERR_TAIL_LINES).join('\n')
    return text.length > STDERR_TAIL_MAX_CHARS ? `…${text.slice(-(STDERR_TAIL_MAX_CHARS - 1))}` : text
  }

  get running(): boolean {
    return !!this.child && !this.closed
  }

  /** Send a request and wait for its result. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<T> {
    if (!this.child || this.closed) return Promise.reject(new Error(`codex app-server is not running (${method})`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)} s`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer })
      this.write(params === undefined ? { id, method } : { id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  /** Every server notification (item/*, turn/*, account/*, ...). Returns an unsubscribe function. */
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  /** Requests the server sends to the client (approvals, dynamic tool calls). One handler; unhandled ones get an error. */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler
  }

  /** Called once when the process exits or fails to spawn. Returns an unsubscribe function. */
  onExit(handler: (code: number | null, error?: Error) => void): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  private handleExit(code: number | null, error?: Error): void {
    if (this.closed) return
    this.closed = true
    // A last line without a newline still counts.
    if (this.stderrBuffer.trim()) this.pushStderrLine(this.stderrBuffer)
    this.stderrBuffer = ''
    const tail = this.stderrTail()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error ?? new Error(codexExitMessage(code, tail, p.method)))
    }
    this.pending.clear()
    for (const h of this.exitHandlers) h(code, error)
    this.markExited()
  }

  /**
   * Kill the process. Pending requests reject. Before the process exists (start() still checking the version) it marks
   * the server closed so start() spawns nothing and rejects; `exited` resolves and no exit handler fires.
   */
  close(): void {
    if (this.closed) return
    if (!this.child) {
      this.closed = true
      this.markExited()
      return
    }
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {
      // already gone
    }
  }

  private write(msg: unknown): void {
    if (!this.child || this.closed) return
    this.child.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  private secrets(): string[] {
    const fromEnv = Object.entries(this.options.env ?? {})
      .filter(([k, v]) => !PLAIN_ENV_KEYS.has(k) && typeof v === 'string')
      .map(([, v]) => v as string)
    return [...fromEnv, ...(this.options.redact ?? [])]
  }

  private scrub(line: string): string {
    return maskKeyLike(redactSecrets(line, this.secrets()))
  }

  /** stderr arrives in chunks that can split a line: complete lines go out, the rest waits for the next chunk. */
  private onStderrData(chunk: string): void {
    this.stderrBuffer += chunk
    let nl: number
    while ((nl = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, nl)
      this.stderrBuffer = this.stderrBuffer.slice(nl + 1)
      this.pushStderrLine(line)
    }
    // A runaway line without newlines is flushed in pieces so the buffer stays bounded.
    // The last STDERR_CARRY characters stay buffered so a secret is never cut in two by the flush.
    if (this.stderrBuffer.length > STDERR_TAIL_MAX_CHARS * 4) {
      this.pushStderrLine(this.stderrBuffer.slice(0, -STDERR_CARRY))
      this.stderrBuffer = this.stderrBuffer.slice(-STDERR_CARRY)
    }
  }

  private pushStderrLine(raw: string): void {
    const line = raw.trim()
    if (!line) return
    const clean = this.scrub(line)
    this.stderrLines.push(clean.length > STDERR_TAIL_MAX_CHARS ? `${clean.slice(0, STDERR_TAIL_MAX_CHARS - 1)}…` : clean)
    if (this.stderrLines.length > STDERR_TAIL_LINES) this.stderrLines.shift()
    this.options.onStderr?.(clean)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object') return
      msg = parsed as Record<string, unknown>
    } catch {
      this.options.onStderr?.(`(non-JSON stdout) ${line.slice(0, 200)}`)
      return
    }
    const id = msg.id as number | string | undefined
    const method = typeof msg.method === 'string' ? msg.method : undefined
    if (id !== undefined && method) {
      void this.answerServerRequest(id, method, msg.params)
      return
    }
    if (id !== undefined) {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      if (msg.error && typeof msg.error === 'object') {
        const e = msg.error as Partial<JsonRpcError>
        p.reject(new CodexRpcError(p.method, { code: Number(e.code ?? -1), message: String(e.message ?? 'error'), data: e.data }))
      } else p.resolve(msg.result)
      return
    }
    if (method) for (const h of this.notificationHandlers) h(method, msg.params)
  }

  private async answerServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    if (!this.serverRequestHandler) {
      this.write({ id, error: { code: -32601, message: `OrgAI does not handle ${method}` } })
      return
    }
    try {
      const result = await this.serverRequestHandler(method, params)
      this.write({ id, result: result ?? {} })
    } catch (e) {
      this.write({ id, error: { code: -32000, message: (e as Error).message } })
    }
  }
}
