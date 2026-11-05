import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { McpTestResult } from '@shared/types'
import type { ResolvedMcpServer } from '../runtime/types'
import { parseWwwAuthenticate, redactOAuth } from './oauth'
import { systemCertTrust, type CertTrustState } from '../systemCerts'

/**
 * Starts an MCP server (or connects to it) just far enough to list its tools: initialize, initialized
 * notification, tools/list. No run, no tokens. Secret values it was given are redacted from every error.
 */

export const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'orgai', version: '1.0.0' }
const STDERR_TAIL = 2000
const MAX_PAGES = 10

interface RpcClient {
  request(method: string, params?: unknown): Promise<unknown>
  notify(method: string, params?: unknown): Promise<void>
  close(): Promise<void>
}

/**
 * Every non-trivial secret value the server was given, to scrub from output: the declared secret env and header
 * slots plus any Authorization header whatever its declaration, since McpService.resolve injects an OAuth bearer
 * there without naming the header in secretHeaders.
 */
function secretValues(r: ResolvedMcpServer): string[] {
  const out = new Set<string>()
  for (const n of r.spec.secretEnv ?? []) if (r.env[n]) out.add(r.env[n])
  for (const n of r.spec.secretHeaders ?? []) if (r.headers[n]) out.add(r.headers[n])
  for (const [h, v] of Object.entries(r.headers)) if (h.toLowerCase() === 'authorization' && v) out.add(v)
  // A bearer header value also appears as its token alone in logs.
  for (const v of [...out]) {
    const m = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(v)
    if (m) out.add(m[1])
  }
  return [...out].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length)
}

export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) out = out.split(s).join('[redacted]')
  return redactOAuth(out, secrets)
}

/** How many `cause` links below the thrown error are read. */
const CAUSE_DEPTH = 3

interface CauseLink {
  code?: string
  message?: string
}

/**
 * The thrown error and up to CAUSE_DEPTH nested causes, each reduced to its string `code` and `message`. A string
 * cause (`new TypeError('fetch failed', { cause: 'other side closed' })`) is the chain's last link, as a message.
 */
function causeChain(e: unknown): CauseLink[] {
  const out: CauseLink[] = []
  let cur: unknown = e
  for (let i = 0; i <= CAUSE_DEPTH && cur; i++) {
    if (typeof cur === 'string') {
      if (cur) out.push({ message: cur })
      break
    }
    if (typeof cur !== 'object') break
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown }
    out.push({
      ...(typeof o.code === 'string' && o.code ? { code: o.code } : {}),
      ...(typeof o.message === 'string' && o.message ? { message: o.message } : {})
    })
    cur = o.cause
  }
  return out
}

/** The host of a server URL for an error sentence; never the URL's userinfo, path or query. */
export function hostOfUrl(url: string | undefined): string {
  try {
    const host = url ? new URL(url).host : ''
    return host || 'the server'
  } catch {
    return 'the server'
  }
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME'])
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'])
/** The other side closed or reset the socket before answering (undici's UND_ERR_SOCKET, a TCP reset). */
const CLOSED_SOCKET_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET'])
const ANSWER_TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
/** The longest "fetch failed: <detail>" fallback; a cause message is untrusted text of any length. */
const FALLBACK_DETAIL_MAX = 300

function isCertificateCode(code: string): boolean {
  return code.includes('CERT') || code.startsWith('ERR_TLS') || code.startsWith('SELF_SIGNED') || code.startsWith('UNABLE_TO_VERIFY')
}

const CERT_CAUSE = 'A proxy, VPN or antivirus that inspects HTTPS can cause this.'
/** What the hint says about the system store; it never claims more than OrgAI knows. */
function certStoreHint(trust: CertTrustState): string {
  if (trust === 'pending') return ' OrgAI is still reading the system certificate store; try again in a moment.'
  if (trust === 'unavailable') return ' OrgAI could not read the system certificate store, so a root certificate installed there is not used.'
  return " If this network inspects HTTPS, its root certificate must be in your system's certificate store. Otherwise the server's own certificate chain may be incomplete or self-signed."
}
/** Chain failures a missing root certificate can cause (or an incomplete or self-signed server chain); expired and altname failures are not one. */
const UNTRUSTED_CHAIN_CODES = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED'])

function untrustedChain(code: string | undefined, message: string | undefined): boolean {
  if (code && UNTRUSTED_CHAIN_CODES.has(code)) return true
  return !!message && /unable to verify|self[- ]signed|unable to get (local )?issuer|certificate not trusted/i.test(message)
}

/** True for undici's "fetch failed" whose cause is a socket the other side closed or reset before answering. */
export function isClosedSocketFailure(e: unknown): boolean {
  for (const { code, message } of causeChain(e)) {
    if (code && CLOSED_SOCKET_CODES.has(code)) return true
    if (message && /other side closed/i.test(message)) return true
  }
  return false
}

/**
 * Plain words for undici's bare `TypeError: fetch failed`, whose reason sits in `error.cause` (at most CAUSE_DEPTH
 * levels are read). Null when the error is neither "fetch failed" nor carries a cause, so other errors keep their
 * own message. `host` names the server; the caller still redacts the result. A sentence that already starts with
 * "Could not" needs no "Could not reach the server:" prefix (see `reachabilityMessage`).
 */
export function describeFetchFailure(e: unknown, host = 'the server', trust: CertTrustState = systemCertTrust()): string | null {
  if (!e || typeof e !== 'object') return null
  const chain = causeChain(e)
  const top = chain[0]
  const hasCause = chain.length > 1
  if (top.message !== 'fetch failed' && !hasCause) return null
  const causes = hasCause ? chain.slice(1) : chain
  for (const { code, message } of causes) {
    if (code && DNS_CODES.has(code)) return `Could not look up ${host}. Check your internet connection, VPN or DNS.`
    if (code && CONNECT_CODES.has(code)) return `Could not connect to ${host} (${code}). Check your internet connection, VPN, firewall or proxy.`
    if (code && isCertificateCode(code)) {
      return `The TLS certificate of ${host} could not be verified (${code}). ${CERT_CAUSE}${untrustedChain(code, message) ? certStoreHint(trust) : ''}`
    }
    if (message && /certificate/i.test(message)) {
      return `The TLS certificate of ${host} could not be verified${code ? ` (${code})` : ''}. ${CERT_CAUSE}${untrustedChain(code, message) ? certStoreHint(trust) : ''}`
    }
    if (message && /unexpected redirect/i.test(message)) return `${host} redirected the request; OrgAI does not follow redirects for MCP servers. Check the URL.`
    if ((code && CLOSED_SOCKET_CODES.has(code)) || (message && /other side closed/i.test(message))) return `${host} closed the connection before answering.`
    if (code && ANSWER_TIMEOUT_CODES.has(code)) return `${host} did not answer in time (${code}).`
  }
  const detail = causes.map((c) => c.code).find((c) => c) ?? [...causes].reverse().map((c) => c.message).find((m) => m && m !== 'fetch failed')
  return `fetch failed: ${(detail ?? 'no further detail').slice(0, FALLBACK_DETAIL_MAX)}.`
}

/** The test's error text for a described network failure: one "Could not" at the front, never two. */
export function reachabilityMessage(described: string): string {
  return described.startsWith('Could not') ? described : `Could not reach the server: ${described}`
}

/** A 401 from a remote server: carries the WWW-Authenticate header for the result. */
class AuthRequiredError extends Error {
  constructor(readonly challenge: string) {
    super('This server needs authorization. Use Authorize.')
  }
}

/** Kill a process and everything it started. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
    } else {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  } catch {
    /* already gone */
  }
}

/**
 * Windows runs anything but an .exe through cmd.exe so npx.cmd, uvx.cmd and .bat shims resolve. Everywhere else
 * the command is spawned directly and found through env.PATH (the login-shell PATH on macOS, see shellEnv.ts),
 * in its own process group so killTree can take down npx's children.
 */
export function usesWindowsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' && !/\.exe$/i.test(command)
}

function quoteForCmd(arg: string): string {
  if (arg === '') return '""'
  return /[\s&|<>^()"]/.test(arg) ? `"${arg}"` : arg
}

class StdioClient implements RpcClient {
  private child: ChildProcess
  private nextId = 1
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()
  private buffer = ''
  private stderr = ''
  private dead?: Error
  /** Set when the process exited: its code, or null on a signal. */
  exitCode?: number | null

  constructor(
    private resolved: ResolvedMcpServer,
    private secrets: string[]
  ) {
    const spec = resolved.spec
    const command = spec.command ?? ''
    const args = spec.args ?? []
    const env = { ...process.env, ...resolved.env }
    const winShell = usesWindowsShell(command)
    if (winShell && [command, ...args].some((a) => /["%\r\n]/.test(a))) {
      throw new Error('Arguments with quotes or % cannot be tested on Windows; run the server by hand to check it.')
    }
    this.child = winShell
      ? spawn([command, ...args].map(quoteForCmd).join(' '), { shell: true, env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(command, args, { env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    this.child.stdout!.setEncoding('utf8')
    this.child.stderr!.setEncoding('utf8')
    this.child.stdout!.on('data', (d: string) => this.onData(d))
    this.child.stderr!.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-STDERR_TAIL * 2)
    })
    this.child.stdin!.on('error', () => {})
    this.child.on('error', (e) => this.fail(new Error(`Could not start "${command}": ${e.message}`)))
    this.child.on('exit', (code, signal) => {
      this.exitCode = code
      this.fail(new Error(`The server exited ${code !== null ? `with code ${code}` : `on signal ${signal}`} before answering.`))
    })
  }

  private fail(e: Error): void {
    if (this.dead) return
    this.dead = e
    for (const p of this.pending.values()) p.reject(e)
    this.pending.clear()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: { id?: unknown; result?: unknown; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        continue // servers sometimes print banners on stdout
      }
      if (typeof msg.id !== 'number') continue
      const p = this.pending.get(msg.id)
      if (!p) continue
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`The server returned an error: ${msg.error.message ?? 'unknown'}`))
      else p.resolve(msg.result)
    }
  }

  stderrTail(): string {
    return redact(this.stderr.slice(-STDERR_TAIL).trim(), this.secrets)
  }

  private write(obj: unknown): void {
    if (this.dead) throw this.dead
    this.child.stdin!.write(`${JSON.stringify(obj)}\n`)
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
      } catch (e) {
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  async close(): Promise<void> {
    this.fail(new Error('closed'))
    try {
      this.child.stdin!.end()
    } catch {
      /* ignore */
    }
    killTree(this.child)
  }
}

/** Parse the JSON-RPC response with a given id out of an SSE body. */
export function parseSse(body: string, id: number): { result?: unknown; error?: { message?: string } } | null {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      const msg = JSON.parse(data)
      if (msg && msg.id === id) return msg
    } catch {
      /* skip */
    }
  }
  return null
}

class HttpClient implements RpcClient {
  private nextId = 1
  private session?: string
  private version?: string

  constructor(
    private resolved: ResolvedMcpServer,
    private signal: AbortSignal,
    private fetchImpl: typeof fetch
  ) {}

  /**
   * One POST. `repeatable` requests (initialize, tools/list) are sent once more on a fresh request when the first
   * attempt died on a closed or reset socket before any response arrived (a stale keep-alive connection);
   * notifications are never repeated.
   */
  private async post(body: unknown, repeatable = false): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.resolved.headers,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json'
    }
    if (this.session) headers['Mcp-Session-Id'] = this.session
    if (this.version) headers['MCP-Protocol-Version'] = this.version
    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: this.signal }
    try {
      return await this.fetchImpl(this.resolved.spec.url!, init)
    } catch (e) {
      if (!repeatable || this.signal.aborted || !isClosedSocketFailure(e)) throw e
      return this.fetchImpl(this.resolved.spec.url!, { ...init, headers: { ...headers } })
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const repeatable = method === 'initialize' || method === 'tools/list'
    const res = await this.post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }, repeatable)
    const session = res.headers.get('mcp-session-id')
    if (session) this.session = session
    if (res.status === 401) {
      await res.text().catch(() => '')
      throw new AuthRequiredError(res.headers.get('www-authenticate') ?? '')
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${text ? `: ${text}` : ''}`)
    }
    const type = res.headers.get('content-type') ?? ''
    const text = await res.text()
    let msg: { result?: unknown; error?: { message?: string } } | null
    if (type.includes('text/event-stream')) msg = parseSse(text, id)
    else {
      try {
        msg = JSON.parse(text)
      } catch {
        throw new Error('The server answered with something that is not JSON-RPC.')
      }
    }
    if (!msg) throw new Error('The server closed the stream without answering.')
    if (msg.error) throw new Error(`The server returned an error: ${msg.error.message ?? 'unknown'}`)
    if (method === 'initialize') {
      const v = (msg.result as { protocolVersion?: unknown } | undefined)?.protocolVersion
      if (typeof v === 'string') this.version = v
    }
    return msg.result
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
    await res.text().catch(() => '')
  }

  async close(): Promise<void> {
    if (!this.session) return
    try {
      await this.fetchImpl(this.resolved.spec.url!, {
        method: 'DELETE',
        headers: { ...this.resolved.headers, 'Mcp-Session-Id': this.session },
        redirect: 'error',
        signal: AbortSignal.timeout(2000)
      })
    } catch {
      /* best effort */
    }
  }
}

const MAX_DESCRIPTION = 300

async function handshake(client: RpcClient): Promise<{ name: string; description?: string }[]> {
  await client.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO })
  await client.notify('notifications/initialized')
  const tools: { name: string; description?: string }[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = (await client.request('tools/list', cursor ? { cursor } : {})) as { tools?: { name?: unknown; description?: unknown }[]; nextCursor?: unknown } | undefined
    for (const t of res?.tools ?? []) {
      if (typeof t?.name !== 'string') continue
      const description = typeof t.description === 'string' ? t.description.trim().slice(0, MAX_DESCRIPTION) : ''
      tools.push(description ? { name: t.name, description } : { name: t.name })
    }
    if (typeof res?.nextCursor === 'string' && res.nextCursor) cursor = res.nextCursor
    else break
  }
  return tools
}

export async function testServer(resolved: ResolvedMcpServer, timeoutMs = 20_000, fetchImpl: typeof fetch = fetch): Promise<McpTestResult> {
  const started = Date.now()
  const secrets = secretValues(resolved)
  const spec = resolved.spec
  if (spec.transport === 'sse') {
    return { ok: false, error: 'The legacy SSE transport cannot be tested here. Start a run to check it, or use an http (streamable) endpoint.', durationMs: 0 }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)
  })
  let stdio: StdioClient | undefined
  let client: RpcClient | undefined
  try {
    if (spec.transport === 'stdio') {
      if (!spec.command) throw new Error('The server has no command.')
      stdio = new StdioClient(resolved, secrets)
      client = stdio
    } else {
      if (!spec.url) throw new Error('The server has no URL.')
      client = new HttpClient(resolved, AbortSignal.timeout(timeoutMs), fetchImpl)
    }
    const details = await Promise.race([handshake(client), timeout])
    return { ok: true, tools: details.map((t) => t.name), toolDetails: details, durationMs: Date.now() - started }
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      const params = parseWwwAuthenticate(e.challenge).map((c) => c.params)
      const found = params.map((p) => p.resource_metadata ?? p.authorization_uri ?? p.realm).find((v) => v)
      const authorizationServer = found ? redact(found, secrets) : undefined
      return { ok: false, needsAuthorization: true, ...(authorizationServer ? { authorizationServer } : {}), error: e.message, durationMs: Date.now() - started }
    }
    // A fetch may throw a non-Error (a string, null): the test still answers { ok: false } with what was thrown.
    const raw = e instanceof Error ? e.message : String(e)
    const described = spec.transport === 'stdio' ? null : describeFetchFailure(e, hostOfUrl(spec.url))
    let message = redact(described ? reachabilityMessage(described) : raw, secrets)
    const tail = stdio?.stderrTail()
    if (tail) message += `\n${tail}`
    return {
      ok: false,
      error: message,
      ...(tail ? { stderr: tail } : {}),
      ...(stdio && stdio.exitCode !== undefined ? { exitCode: stdio.exitCode } : {}),
      durationMs: Date.now() - started
    }
  } finally {
    if (timer) clearTimeout(timer)
    await client?.close().catch(() => {})
  }
}
