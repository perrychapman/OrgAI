import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'

const PREFIX = 'orgai_fn_'
const BODY_LIMIT = 16 * 1024 * 1024
const FRAME_LIMIT = 1024 * 1024
type Json = Record<string, unknown>
const record = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** Reserved namespace prevents a later tool from impersonating an earlier alias, including across MCP restarts. */
export class ProviderToolNames {
  private forward = new Map<string, string>()
  private reverse = new Map<string, string>()
  constructor(private digest: (s: string) => string = s => createHash('sha256').update(s).digest('hex')) {}

  encode(name: string): string {
    if (name.length <= 64 && !name.startsWith(PREFIX)) return name
    const existing = this.forward.get(name)
    if (existing) return existing
    if (name.length > 1024 || this.forward.size >= 10000) throw new Error('Provider tool registry limit exceeded.')
    for (let salt = 0; salt < 1000; salt++) {
      const alias = PREFIX + this.digest(JSON.stringify([name, salt])).slice(0, 64 - PREFIX.length)
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(alias)) throw new Error('Invalid provider tool alias.')
      if (this.reverse.has(alias)) continue
      this.forward.set(name, alias)
      this.reverse.set(alias, name)
      return alias
    }
    throw new Error('Provider tool alias collision.')
  }

  request(body: Json): { body: Json; names: Map<string, string> } {
    const names = new Map<string, string>()
    const definitions = Array.isArray(body.tools) ? body.tools : []
    if (definitions.length > 10000) throw new Error('Provider tool definition limit exceeded.')
    const tools = definitions.map(value => {
      if (!record(value) || typeof value.name !== 'string') return value
      const alias = this.encode(value.name)
      if (names.has(alias)) throw new Error('Duplicate provider tool name.')
      names.set(alias, value.name)
      return { ...value, name: alias }
    })
    const content = (value: unknown): unknown => Array.isArray(value) ? value.map(part => {
      if (!record(part) || part.type !== 'tool_use' || typeof part.name !== 'string') return part
      return { ...part, name: this.encode(part.name) }
    }) : value
    const messages = Array.isArray(body.messages) ? body.messages.map(message => record(message)
      ? { ...message, content: content(message.content) } : message) : body.messages
    const choice = record(body.tool_choice) && body.tool_choice.type === 'tool' && typeof body.tool_choice.name === 'string'
      ? { ...body.tool_choice, name: this.encode(body.tool_choice.name) } : body.tool_choice
    return { body: { ...body, ...(body.tools !== undefined ? { tools } : {}), ...(messages !== undefined ? { messages } : {}), ...(choice !== undefined ? { tool_choice: choice } : {}) }, names }
  }
}

/** Only structured custom tool names are decoded; arguments, text and native server tools are opaque. */
export function canonicalToolResponse(value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (!record(value)) return value
  if (value.type === 'error') return { type: 'error', error: { type: 'api_error', message: 'Provider request failed.' } }
  if (value.type === 'tool_use') {
    if (typeof value.name !== 'string' || !names.has(value.name)) throw new Error('Unknown provider tool name.')
    return { ...value, name: names.get(value.name) }
  }
  const out = { ...value }
  if (Array.isArray(value.content)) out.content = value.content.map(part => canonicalToolResponse(part, names))
  if (record(value.content_block)) out.content_block = canonicalToolResponse(value.content_block, names)
  if (record(value.message)) out.message = canonicalToolResponse(value.message, names)
  return out
}

async function boundedBody(source: AsyncIterable<Uint8Array>, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of source) {
    bytes += chunk.byteLength
    if (bytes > limit) throw new Error('Provider gateway body limit exceeded.')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function write(response: ServerResponse, text: string): Promise<void> {
  if (response.destroyed) throw new Error('Provider gateway client disconnected.')
  if (!response.write(text)) {
    const abort = new AbortController()
    const close = (): void => abort.abort()
    response.once('close', close)
    try { await once(response, 'drain', { signal: abort.signal }) }
    finally { response.off('close', close) }
  }
}

/** Streaming is frame-bounded and awaits downstream backpressure before reading another upstream chunk. */
export async function relayToolEvents(source: AsyncIterable<Uint8Array>, response: ServerResponse, names: ReadonlyMap<string, string> | ((value: unknown) => unknown)): Promise<void> {
  const decoder = new TextDecoder()
  let pending = ''
  const frame = (text: string): string => {
    const lines = text.split('\n')
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (!data || data === '[DONE]') return text + '\n\n'
    const decoded = typeof names === 'function' ? names(JSON.parse(data)) : canonicalToolResponse(JSON.parse(data), names)
    return lines.filter(line => !line.startsWith('data:')).concat(`data: ${JSON.stringify(decoded)}`).join('\n') + '\n\n'
  }
  for await (const chunk of source) {
    pending += decoder.decode(chunk, { stream: true })
    // CRLF is normalized only when the complete frame is available, so split CR/LF chunks remain valid.
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      if (Buffer.byteLength(pending.slice(0, match.index)) > FRAME_LIMIT) throw new Error('Provider gateway event limit exceeded.')
      await write(response, frame(pending.slice(0, match.index).replaceAll('\r\n', '\n')))
      pending = pending.slice(match.index + match[0].length)
    }
    if (Buffer.byteLength(pending) > FRAME_LIMIT) throw new Error('Provider gateway event limit exceeded.')
  }
  pending += decoder.decode()
  if (pending.trim()) throw new Error('Incomplete provider event.')
}

export interface ClaudeToolGateway {
  baseUrl: string
  close(): void
}

export interface ProviderGatewayProtocol {
  route: RegExp
  request(body: Json): { body: Json; decode(value: unknown): unknown }
}

/** Proxy connections only: the SDK and all hook/permission/native-MCP paths continue to see canonical identities. */
export async function startClaudeToolGateway(upstreamBase: string, credentials: { token?: string; apiKey?: string }): Promise<ClaudeToolGateway> {
  const registry = new ProviderToolNames()
  return startProviderToolGateway(upstreamBase, credentials, {
    route: /^v1\/messages(?:\/count_tokens)?(?:\?[^#]*)?$/,
    request(body) {
      const mapped = registry.request(body)
      return { body: mapped.body, decode: value => canonicalToolResponse(value, mapped.names) }
    }
  })
}

/** Shared adapter transport; protocol mappers touch structured identities only. */
export async function startProviderToolGateway(upstreamBase: string, credentials: { token?: string; apiKey?: string }, protocol: ProviderGatewayProtocol): Promise<ClaudeToolGateway> {
  const upstream = new URL(upstreamBase)
  if (!['https:', 'http:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Invalid provider gateway upstream URL.')
  const secret = randomBytes(32).toString('hex')
  const active = new Set<AbortController>()
  const server = createServer(async (request, response) => {
    const path = request.url ?? ''
    const prefix = `/${secret}/`
    if (!path.startsWith(prefix)) { response.writeHead(403).end(); return }
    const suffix = path.slice(prefix.length)
    if (request.method !== 'POST' || !protocol.route.test(suffix)) { response.writeHead(404).end(); return }
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 10 * 60 * 1000)
    timeout.unref()
    active.add(abort)
    const cancel = (): void => { abort.abort() }
    response.once('close', cancel)
    try {
      const body: unknown = JSON.parse(await boundedBody(request, BODY_LIMIT))
      if (!record(body)) throw new Error('Invalid provider request.')
      const mapped = protocol.request(body)
      const headers: Record<string, string> = { 'content-type': 'application/json', 'accept-encoding': 'identity' }
      for (const name of ['anthropic-version', 'anthropic-beta', 'accept']) {
        const value = request.headers[name]
        if (typeof value === 'string') headers[name] = value
      }
      if (credentials.token) headers.authorization = `Bearer ${credentials.token}`
      if (credentials.apiKey) headers['x-api-key'] = credentials.apiKey
      const result = await fetch(upstreamBase.replace(/\/$/, '') + '/' + suffix, {
        method: 'POST', headers, body: JSON.stringify(mapped.body), redirect: 'error', signal: abort.signal
      })
      response.statusCode = result.status
      const type = result.headers.get('content-type') ?? 'application/json'
      response.setHeader('content-type', result.ok ? type : 'application/json')
      for (const name of ['request-id', 'retry-after']) {
        const value = result.headers.get(name)
        if (value) response.setHeader(name, value)
      }
      if (!result.body) { response.end(); return }
      if (!result.ok) {
        await result.body.cancel()
        response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Provider request failed (HTTP ${result.status}).` } }))
        return
      }
      if (type.includes('text/event-stream') && result.ok) await relayToolEvents(result.body, response, mapped.decode)
      else {
        const text = await boundedBody(result.body, BODY_LIMIT)
        await write(response, result.ok && type.includes('application/json')
          ? JSON.stringify(mapped.decode(JSON.parse(text))) : text)
      }
      response.end()
    } catch {
      // Never reflect credentials, request content or upstream addresses in SDK-visible errors.
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Provider tool gateway request failed.' } }))
      else response.destroy()
    } finally {
      clearTimeout(timeout)
      response.off('close', cancel)
      abort.abort()
      active.delete(abort)
    }
  })
  server.headersTimeout = 15000
  server.requestTimeout = 60000
  server.maxHeadersCount = 100
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('Provider gateway failed to listen.') }
  return { baseUrl: `http://127.0.0.1:${address.port}/${secret}`, close() {
    for (const abort of active) abort.abort()
    server.closeAllConnections()
    server.close()
  } }
}
