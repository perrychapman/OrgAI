import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalToolResponse, ProviderToolNames, startClaudeToolGateway, type ClaudeToolGateway } from './claudeToolGateway'

const long = 'mcp__server_' + 's'.repeat(40) + '__' + 'tool'.repeat(15)
const gateways: ClaudeToolGateway[] = []
const servers: Server[] = []
afterEach(() => {
  for (const gateway of gateways.splice(0)) gateway.close()
  for (const server of servers.splice(0)) { server.closeAllConnections(); server.close() }
})
async function upstream(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}/anthropic`
}
async function gateway(base: string): Promise<ClaudeToolGateway> {
  const result = await startClaudeToolGateway(base, { token: 'configured-token', apiKey: 'configured-key' })
  gateways.push(result)
  return result
}
const post = (base: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + '/v1/messages?beta=true', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
})
const tool = (name: string) => ({ name, input_schema: { type: 'object' } })

describe('provider tool names', () => {
  it('keeps the supplied 60-character fixture and aliases its full SDK-prefixed identity', () => {
    const name = 'mcp__iga_lumos_write_entitlement_deprovisioning_workflow_set'
    expect(name.length).toBe(60)
    const registry = new ProviderToolNames()
    expect(registry.encode(name)).toBe(name)
    const full = `mcp__iga__${name}`
    expect(full.length).toBeGreaterThan(64)
    const mapped = registry.request({ tools: [tool(full)] })
    expect(canonicalToolResponse({ type: 'tool_use', name: (mapped.body.tools as { name: string }[])[0]!.name }, mapped.names)).toMatchObject({ name: full })
  })
  it('bounds complete names, reserves alias lookalikes, keeps 64-char/native names and roundtrips only advertised tools', () => {
    const registry = new ProviderToolNames()
    const alias = registry.encode(long)
    expect(alias.length).toBeLessThanOrEqual(64)
    expect(registry.encode(long)).toBe(alias)
    expect(registry.encode(alias)).not.toBe(alias)
    expect(registry.encode('a'.repeat(64))).toBe('a'.repeat(64))
    const { body, names } = registry.request({ model: 'us.openai.gpt-6.1-terra', tools: [tool(long), tool(alias), tool('Read')],
      tool_choice: { type: 'tool', name: long }, messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: '1', name: long, input: { name: long } }] }] })
    expect(body.model).toBe('us.openai.gpt-6.1-terra')
    expect(body.tool_choice).toEqual({ type: 'tool', name: alias })
    expect(body.messages).toEqual([{ role: 'assistant', content: [{ type: 'tool_use', id: '1', name: alias, input: { name: long } }] }])
    expect(canonicalToolResponse({ content: [{ type: 'tool_use', name: alias, input: { name: alias } }, { type: 'server_tool_use', name: 'web_search' }] }, names))
      .toEqual({ content: [{ type: 'tool_use', name: long, input: { name: alias } }, { type: 'server_tool_use', name: 'web_search' }] })
    expect(() => canonicalToolResponse({ type: 'tool_use', name: 'unknown' }, names)).toThrow('Unknown')
    expect(() => registry.request({ tools: [tool(long), tool(long)] })).toThrow('Duplicate')
    const historyOnly = registry.request({ messages: [{ content: [{ type: 'tool_use', name: long }] }] })
    expect(() => canonicalToolResponse({ type: 'tool_use', name: alias }, historyOnly.names)).toThrow('Unknown')
  })

  it('detects hash collisions rather than routing to another identity; registry survives added and removed tools', () => {
    const registry = new ProviderToolNames(s => s.includes('other') && s.endsWith(',0]') ? 'a'.repeat(64) : s.includes('other') ? 'b'.repeat(64) : 'a'.repeat(64))
    const first = registry.request({ tools: [tool(long)] })
    const second = registry.request({ tools: [tool(long), tool(long + 'other')] })
    expect(new Set((second.body.tools as { name: string }[]).map(t => t.name)).size).toBe(2)
    expect((first.body.tools as { name: string }[])[0]!.name).toBe((second.body.tools as { name: string }[])[0]!.name)
    const removed = registry.request({ tools: [tool(long + 'other')] })
    expect(() => canonicalToolResponse({ type: 'tool_use', name: (first.body.tools as { name: string }[])[0]!.name }, removed.names)).toThrow()
    expect(() => new ProviderToolNames(() => 'a'.repeat(64)).request({ tools: [tool(long), tool(long + 'other')] })).toThrow('collision')
  })
})

describe('Claude proxy HTTP tool gateway', () => {
  it('injects configured auth, drops caller credentials/routing/cookies, preserves model/path and reverses JSON names', async () => {
    let observed: { headers: IncomingMessage['headers']; url: string; body: any } | undefined
    const base = await upstream(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      observed = { headers: request.headers, url: request.url!, body }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ content: [{ type: 'tool_use', name: body.tools[0].name, id: 'call1', input: {} }] }))
    })
    const g = await gateway(base)
    const result = await post(g.baseUrl, { model: 'us.openai.gpt-6.1-terra', tools: [tool(long)] }, {
      authorization: 'Bearer caller', 'x-api-key': 'caller', cookie: 'private', 'x-forwarded-host': 'evil', 'anthropic-version': '2023-06-01'
    })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ content: [{ name: long }] })
    expect(observed!.url).toBe('/anthropic/v1/messages?beta=true')
    expect(observed!.body.model).toBe('us.openai.gpt-6.1-terra')
    expect(observed!.body.tools[0].name.length).toBeLessThanOrEqual(64)
    expect(observed!.headers).toMatchObject({ authorization: 'Bearer configured-token', 'x-api-key': 'configured-key', 'anthropic-version': '2023-06-01' })
    expect(observed!.headers.cookie).toBeUndefined()
    expect(observed!.headers['x-forwarded-host']).toBeUndefined()
  })

  it('authenticates before body read, rejects unknown routes and does not follow redirects or reflect error secrets', async () => {
    let requests = 0
    const base = await upstream((_request, response) => { requests++; response.writeHead(307, { location: base + '/redirect', 'retry-after': '3' }).end('configured-token') })
    const g = await gateway(base)
    expect((await post(g.baseUrl.replace(/\/[a-f0-9]{64}$/, '/wrong'), {})).status).toBe(403)
    expect((await fetch(g.baseUrl + '/other', { method: 'POST', body: 'invalid' })).status).toBe(404)
    expect(requests).toBe(0)
    const result = await post(g.baseUrl, {})
    expect(result.status).toBe(502)
    expect(await result.text()).not.toContain('configured-token')
    expect(requests).toBe(1)
  })

  it('reverses chunked CRLF SSE frames while preserving native tools, text and arguments', async () => {
    const base = await upstream(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const name = JSON.parse(Buffer.concat(chunks).toString()).tools[0].name
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const frames = `event: content_block_start\r\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: '1', name, input: {} } })}\r\n\r\nevent: content_block_delta\r\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: name } })}\r\n\r\ndata: [DONE]\r\n\r\n`
      for (let i = 0; i < frames.length; i += 7) response.write(frames.slice(i, i + 7))
      response.end()
    })
    const g = await gateway(base)
    const result = await post(g.baseUrl, { tools: [tool(long)] })
    const text = await result.text()
    expect(text).toContain(`"name":"${long}"`)
    expect(text).toMatch(/"partial_json":"orgai_fn_/)
    expect(text).toContain('data: [DONE]')
  })

  it('bounds request and JSON response bodies and refuses unknown response tool names', async () => {
    let mode = 'unknown'
    const base = await upstream((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(mode === 'unknown' ? JSON.stringify({ content: [{ type: 'tool_use', name: 'spoof' }] }) : ' '.repeat(16 * 1024 * 1024 + 1)) })
    const g = await gateway(base)
    expect((await post(g.baseUrl, { tools: [tool(long)] })).status).toBe(502)
    mode = 'large'
    expect((await post(g.baseUrl, {})).status).toBe(502)
    expect((await post(g.baseUrl, { text: 'x'.repeat(16 * 1024 * 1024) })).status).toBe(502)
  })

  it('aborts upstream streaming when the downstream disconnects or the session closes', async () => {
    let closed!: () => void
    const disconnected = new Promise<void>(resolve => { closed = resolve })
    const base = await upstream((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('event: ping\ndata: {"type":"ping"}\n\n'); response.once('close', closed) })
    const g = await gateway(base)
    const abort = new AbortController()
    const result = await fetch(g.baseUrl + '/v1/messages', { method: 'POST', body: '{}', signal: abort.signal })
    expect((await result.body!.getReader().read()).done).toBe(false)
    abort.abort()
    await disconnected
    g.close()
    await expect(post(g.baseUrl, {})).rejects.toThrow()
  })

  it('closes an active upstream stream on session teardown', async () => {
    let closed!: () => void
    const disconnected = new Promise<void>(resolve => { closed = resolve })
    const base = await upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"type":"ping"}\n\n')
      response.once('close', closed)
    })
    const g = await gateway(base)
    const result = await post(g.baseUrl, {})
    const reader = result.body!.getReader()
    await reader.read()
    g.close()
    await disconnected
    await expect(reader.read()).rejects.toThrow()
  })

  it('bounds SSE frames and hides provider diagnostics in HTTP200 JSON and SSE error payloads', async () => {
    let mode = 'json'
    const base = await upstream((_request, response) => {
      response.setHeader('content-type', mode === 'json' ? 'application/json' : 'text/event-stream')
      const error = JSON.stringify({ type: 'error', error: { message: 'configured-token secret diagnostics' } })
      response.end(mode === 'json' ? error : mode === 'sse' ? `event: error\ndata: ${error}\n\n` : 'data: ' + 'x'.repeat(1024 * 1024 + 1))
    })
    const g = await gateway(base)
    expect(await (await post(g.baseUrl, {})).text()).not.toContain('configured-token')
    mode = 'sse'
    expect(await (await post(g.baseUrl, {})).text()).not.toContain('configured-token')
    mode = 'large'
    const result = await post(g.baseUrl, {})
    expect(result.status).toBe(502)
  })
})
