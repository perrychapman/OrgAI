import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { McpServerSpec } from '@shared/types'
import type { ResolvedMcpServer } from '../runtime/types'
import { parseSse, redact, testServer } from './probe'

const script = join(__dirname, 'fixtures', 'stdio-server.cjs')

function stdio(mode: string, env: Record<string, string> = {}, secretEnv: string[] = []): ResolvedMcpServer {
  const spec: McpServerSpec = {
    id: 'm1',
    name: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [script, mode],
    secretEnv,
    enabled: true,
    source: 'user',
    addedAt: ''
  }
  return { spec, env, headers: {} }
}

describe('testServer (stdio)', () => {
  it('lists tools from the fixture server', async () => {
    const r = await testServer(stdio('ok'))
    expect(r).toMatchObject({ ok: true, tools: ['echo', 'sum'] })
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  }, 30000)

  it('follows nextCursor', async () => {
    const r = await testServer(stdio('pages'))
    expect(r.tools).toEqual(['alpha', 'beta'])
  }, 30000)

  it('reports a crash with the stderr tail, redacting secret values', async () => {
    const r = await testServer(stdio('crash', { SECRET_TOKEN: 'hunter2-value' }, ['SECRET_TOKEN']))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('code 3')
    expect(r.error).toContain('boom')
    expect(r.error).not.toContain('hunter2-value')
    expect(r.error).toContain('[redacted]')
  }, 30000)

  it('times out on a silent server', async () => {
    const r = await testServer(stdio('silent'), 600)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/No answer/)
  }, 30000)

  it('explains a missing executable', async () => {
    const res = stdio('ok')
    res.spec.command = 'definitely-not-a-real-command-xyz'
    const r = await testServer(res, 5000)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  }, 30000)

  it('says sse is not supported by the tester', async () => {
    const r = await testServer({ spec: { ...stdio('ok').spec, transport: 'sse', url: 'https://x.test/sse' }, env: {}, headers: {} })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/SSE/)
  })
})

describe('testServer (http)', () => {
  const http = (headers: Record<string, string> = {}): ResolvedMcpServer => ({
    spec: { id: 'h', name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', secretHeaders: ['Authorization'], enabled: true, source: 'user', addedAt: '' },
    env: {},
    headers
  })

  it('handles JSON and SSE answers and the session header', async () => {
    const seen: { method: string; headers: Record<string, string> }[] = []
    const fake = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      seen.push({ method: body.method, headers: init.headers as Record<string, string> })
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }
        })
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'issues' }] } })
      return new Response(`event: message\ndata: ${payload}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const r = await testServer(http({ Authorization: 'Bearer tok-123' }), 5000, fake)
    expect(r).toMatchObject({ ok: true, tools: ['issues'] })
    const list = seen.find((s) => s.method === 'tools/list')!
    expect(list.headers['Mcp-Session-Id']).toBe('sess-1')
    expect(list.headers.Authorization).toBe('Bearer tok-123')
  })

  it('reports HTTP errors without the secret', async () => {
    const fake = (async () => new Response('bad token tok-123', { status: 401, statusText: 'Unauthorized' })) as unknown as typeof fetch
    const r = await testServer(http({ Authorization: 'Bearer tok-123' }), 5000, fake)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('HTTP 401')
    expect(r.error).not.toContain('tok-123')
  })
})

describe('helpers', () => {
  it('parseSse finds the response by id', () => {
    expect(parseSse('data: {"id":2,"result":{"a":1}}\n\n', 2)).toEqual({ id: 2, result: { a: 1 } })
    expect(parseSse('data: {"id":3}\n\n', 2)).toBeNull()
  })
  it('redact replaces every occurrence', () => {
    expect(redact('a abc b abc', ['abc'])).toBe('a [redacted] b [redacted]')
  })
})
