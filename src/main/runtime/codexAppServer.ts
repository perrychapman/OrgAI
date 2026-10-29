import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

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

const PLATFORM_PACKAGES: Record<string, { pkg: string; triple: string }> = {
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
}

/**
 * OrgAI's own CODEX_HOME under the data dir. The connection service (login, account, models) and the Codex
 * adapter (runs) both use it, so OrgAI keeps its own ChatGPT login and config.toml and never loads the
 * user's personal ~/.codex configuration (their MCP servers, profiles, approval defaults).
 */
export function codexHomeDir(dataDir: string): string {
  return join(dataDir, 'codex')
}

export interface CodexBinary {
  /** The native codex executable. */
  path: string
  /** Extra PATH directory the CLI expects (bundled rg), when present. */
  pathDir?: string
}

/**
 * Locate the native codex binary from the per-platform optional dependency (@openai/codex-<platform>-<arch>),
 * mirroring @openai/codex/bin/codex.js. Inside a packaged app the path is rewritten from app.asar to
 * app.asar.unpacked (electron-builder asarUnpack). ORGAI_CODEX_PATH overrides everything. Undefined when
 * no binary is installed for this platform.
 */
export function resolveCodexBinary(platform: string = process.platform, arch: string = process.arch): CodexBinary | undefined {
  const override = process.env.ORGAI_CODEX_PATH?.trim()
  if (override) return existsSync(override) ? { path: override } : undefined
  const target = PLATFORM_PACKAGES[`${platform}-${arch}`]
  if (!target) return undefined
  try {
    const req = createRequire(import.meta.url)
    const pkgJson = req.resolve(`${target.pkg}/package.json`)
    const root = dirname(pkgJson).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
    const vendor = join(root, 'vendor', target.triple)
    const bin = join(vendor, 'bin', platform === 'win32' ? 'codex.exe' : 'codex')
    if (!existsSync(bin)) return undefined
    const pathDir = join(vendor, 'codex-path')
    return { path: bin, ...(existsSync(pathDir) ? { pathDir } : {}) }
  } catch {
    return undefined
  }
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
  /** Override the binary (tests). */
  binary?: CodexBinary
  /** stderr lines (debug logging; never contains secrets the client put there). */
  onStderr?(line: string): void
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
    const binary = this.options.binary ?? resolveCodexBinary()
    if (!binary) throw new Error('The Codex CLI is not installed for this platform (@openai/codex optional dependency missing).')
    const env: Record<string, string | undefined> = { ...process.env, ...this.options.env }
    if (binary.pathDir) env.PATH = `${binary.pathDir}${delimiter}${env.PATH ?? env.Path ?? ''}`
    const args = ['app-server', ...(this.options.config ?? []).flatMap((c) => ['-c', c])]
    const child = spawn(binary.path, args, { cwd: this.options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.options.onStderr?.(line.trim())
    })
    // A write to a dying process raises EPIPE on stdin; the exit handler reports the real failure.
    child.stdin.on('error', () => {})
    child.on('error', (err) => this.handleExit(null, err))
    child.on('exit', (code) => this.handleExit(code))
    const result = await this.request('initialize', {
      clientInfo: { name: 'orgai', title: 'OrgAI', version: clientVersion },
      capabilities: { experimentalApi: this.options.experimentalApi !== false, requestAttestation: false }
    })
    this.notify('initialized')
    return result
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
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error ?? new Error(`codex app-server exited (code ${code ?? 'unknown'}) during ${p.method}`))
    }
    this.pending.clear()
    for (const h of this.exitHandlers) h(code, error)
    this.markExited()
  }

  /** Kill the process. Pending requests reject. */
  close(): void {
    if (!this.child || this.closed) return
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
