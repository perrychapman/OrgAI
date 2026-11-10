import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { CodexAppServer } from './codexAppServer'
import { startCodexToolGateway } from './codexToolGateway'

/** Explicit offline installed-binary check: all model and MCP traffic terminates at this loopback fake server. */
it.skipIf(process.env.ORGAI_TEST_INSTALLED_CODEX !== '1' || process.platform !== 'win32').each([false, true])('installed Codex MCP wire identity and exact unknown model id (gateway=%s)', async (useGateway) => {
  const home = mkdtempSync(join(tmpdir(), 'orgai-codex-installed-'))
  const bare = 'mcp__iga_lumos_write_entitlement_deprovisioning_workflow_set'
  expect(bare.length).toBe(60)
  const serverName = 'server_' + 's'.repeat(40)
  let capture!: (body: any) => void
  const captured = new Promise<any>(resolve => { capture = resolve })
  let called!: (body: any) => void
  const toolCalled = new Promise<any>(resolve => { called = resolve })
  let replayed!: (body: any) => void
  const replay = new Promise<any>(resolve => { replayed = resolve })
  let responses = 0
  const http = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(request.url?.startsWith('/mcp') ? 405 : 404).end(); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString()
    const body = text ? JSON.parse(text) : {}
    response.setHeader('content-type', 'application/json')
    if (request.url?.startsWith('/mcp')) {
      if (body.method === 'initialize') response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'offline', version: '1' } } }))
      else if (body.method === 'tools/list') response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [bare, bare + 'x', 'short'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) } }))
      else if (body.method === 'resources/list') response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { resources: [] } }))
      else if (body.method === 'resources/templates/list') response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { resourceTemplates: [] } }))
      else if (body.method === 'tools/call') { called(body.params); response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'offline tool result' }] } })) }
      else if (body.id !== undefined) response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }))
      else response.writeHead(202).end()
    } else {
      responses++
      if (responses === 1) capture(body)
      else replayed(body)
      if (!useGateway || responses > 1) { response.writeHead(400).end(JSON.stringify({ error: { message: 'Offline capture complete', type: 'invalid_request_error' } })); return }
      const fn = body.tools.find((tool: any) => tool.type === 'function' && tool.description === bare)
      const item = { id: 'fc-1', type: 'function_call', call_id: 'call-1', name: fn.name, arguments: '{"key":"value"}' }
      const completed = { id: 'resp-1', object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        { type: 'response.created', response: { ...completed, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: completed }
      ]
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    }
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  const gateway = useGateway ? await startCodexToolGateway(base + '/v1', 'offline-key') : undefined
  const require = createRequire(import.meta.url)
  const binary = join(require.resolve('@openai/codex-win32-x64/package.json'), '..', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
  const stderr: string[] = []
  const codex = new CodexAppServer({ binary: { path: binary }, cwd: home, env: { CODEX_HOME: home, OFFLINE_API_KEY: 'offline-key', RUST_LOG: 'warn' }, onStderr: line => stderr.push(line), config: [
    'model_provider="offline"', 'model_providers.offline.name="Offline"', `model_providers.offline.base_url=${JSON.stringify(gateway?.baseUrl ?? base + '/v1')}`, `chatgpt_base_url=${JSON.stringify(base)}`,
    'model_providers.offline.env_key="OFFLINE_API_KEY"', 'model_providers.offline.wire_api="responses"',
    `mcp_servers.${serverName}.url=${JSON.stringify(base + '/mcp')}`, 'features.apps=false', 'features.plugins=false', 'features.multi_agent=false'
  ] })
  try {
    // Only this offline fixture accepts its fake server's approval. The production adapter still declines elicitation.
    codex.onServerRequest(async () => ({ action: 'accept', content: {}, _meta: null }))
    await codex.start()
    const started: any = await codex.request('thread/start', { model: 'us.openai.gpt-6.1-terra', cwd: home, approvalPolicy: 'on-request', sandbox: 'read-only', experimentalRawEvents: false, persistExtendedHistory: false })
    const status: any = await codex.request('mcpServerStatus/list', {})
    expect(Object.keys(status.data[0].tools)).toEqual(expect.arrayContaining([bare, bare + 'x', 'short']))
    await codex.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'offline fixture' }] })
    const body = await Promise.race([captured, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Offline capture timed out: ' + stderr.join('\n'))), 15000).unref())])
    expect(body.model).toBe('us.openai.gpt-6.1-terra')
    const namespace = body.tools.find((tool: any) => tool.type === 'namespace' && tool.name === `mcp__${serverName}`)
    const names = useGateway ? body.tools.filter((tool: any) => tool.type === 'function').map((tool: any) => tool.name) : namespace.tools.map((tool: any) => tool.name)
    if (useGateway) {
      expect(namespace).toBeUndefined()
      const calledTool = await Promise.race([toolCalled, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Native tool call timed out: ' + stderr.join('\n'))), 10000).unref())])
      expect(calledTool).toMatchObject({ name: bare, arguments: { key: 'value' } })
      const history = await replay
      const call = history.input.find((item: any) => item.type === 'function_call')
      expect(call).toMatchObject({ name: body.tools.find((tool: any) => tool.description === bare).name, call_id: 'call-1' })
      expect(call.namespace).toBeUndefined()
    } else {
      expect(names).toEqual(expect.arrayContaining([bare, bare + 'x', 'short']))
      expect(namespace.name.length).toBeLessThanOrEqual(64)
      expect((namespace.name + '__' + bare).length).toBeGreaterThan(64)
    }
    expect(names.every((name: string) => name.length <= 64)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
    expect(stderr.join('\n')).toContain('This will use fallback model metadata.')
    console.log('Offline installed Codex: gateway', useGateway, 'functions', names, 'exact model', body.model, 'fallback metadata confirmed')
  } finally {
    codex.close()
    gateway?.close()
    await codex.exited
    http.closeAllConnections()
    http.close()
    rmSync(home, { recursive: true, force: true })
  }
}, 30000)
