import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { McpTestResult } from '@shared/types'
import type { ResolvedMcpServer } from '../runtime/types'

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

/** Every non-trivial secret value the server was given, to scrub from output. */
function secretValues(r: ResolvedMcpServer): string[] {
  const out: string[] = []
  for (const n of r.spec.secretEnv ?? []) if (r.env[n]) out.push(r.env[n])
  for (const n of r.spec.secretHeaders ?? []) if (r.headers[n]) out.push(r.headers[n])
  // A bearer header value also appears as its token alone in logs.
  for (const v of [...out]) {
    const m = /^(?:Bearer|Basic|Token)\s+(.+)$/i.exec(v)
    if (m) out.push(m[1])
  }
  return out.filter((v) => v.length >= 3).sort((a, b) => b.length - a.length)
}

export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) out = out.split(s).join('[redacted]')
  return out
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
    const winShell = process.platform === 'win32' && !/\.exe$/i.test(command)
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

  private async post(body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.resolved.headers,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json'
    }
    if (this.session) headers['Mcp-Session-Id'] = this.session
    if (this.version) headers['MCP-Protocol-Version'] = this.version
    return this.fetchImpl(this.resolved.spec.url!, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: this.signal })
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const res = await this.post({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    const session = res.headers.get('mcp-session-id')
    if (session) this.session = session
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
    let message = redact((e as Error).message, secrets)
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
