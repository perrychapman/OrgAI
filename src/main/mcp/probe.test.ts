import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { McpServerSpec } from '@shared/types'
import type { ResolvedMcpServer } from '../runtime/types'
import { describeFetchFailure, hostOfUrl, isClosedSocketFailure, parseSse, redact, testServer, usesWindowsShell } from './probe'

/** undici's shape: `TypeError: fetch failed` with the real reason in `cause`. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause })
}

function coded(message: string, code?: string, cause?: unknown): Error {
  const e = new Error(message, cause !== undefined ? { cause } : undefined)
  if (code) Object.assign(e, { code })
  return e
}

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
    expect(r.toolDetails).toEqual([{ name: 'echo', description: 'Echo the input back.' }, { name: 'sum' }])
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
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toContain('boom')
    expect(r.stderr).not.toContain('hunter2-value')
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
    const fake = (async () => new Response('bad token tok-123', { status: 403, statusText: 'Forbidden' })) as unknown as typeof fetch
    const r = await testServer(http({ Authorization: 'Bearer tok-123' }), 5000, fake)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('HTTP 403')
    expect(r.error).not.toContain('tok-123')
  })

  it('turns a 401 challenge into needsAuthorization with the resource metadata URL', async () => {
    const fake = (async () =>
      new Response('Bearer tok-123 unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="mcp", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' }
      })) as unknown as typeof fetch
    const r = await testServer(http({ Authorization: 'Bearer tok-123' }), 5000, fake)
    expect(r).toMatchObject({
      ok: false,
      needsAuthorization: true,
      authorizationServer: 'https://mcp.example.com/.well-known/oauth-protected-resource',
      error: 'This server needs authorization. Use Authorize.'
    })
    expect(JSON.stringify(r)).not.toContain('tok-123')
  })

  it('a 401 without the header is needsAuthorization without a server', async () => {
    const fake = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    const r = await testServer(http(), 5000, fake)
    expect(r.ok).toBe(false)
    expect(r.needsAuthorization).toBe(true)
    expect(r.authorizationServer).toBeUndefined()
  })

  it('redacts bearer values from error text even when the header was not a declared secret', async () => {
    const fake = (async () => new Response('echo: Bearer abc.def-ghi', { status: 500 })) as unknown as typeof fetch
    const r = await testServer(http(), 5000, fake)
    expect(r.error).not.toContain('abc.def-ghi')
  })

  it('names the cause of a bare "fetch failed" with the host, not the raw TypeError', async () => {
    const fake = (async () => {
      throw fetchFailed(coded('getaddrinfo ENOTFOUND mcp.example.com', 'ENOTFOUND'))
    }) as unknown as typeof fetch
    const r = await testServer(http({ Authorization: 'Bearer tok-123' }), 5000, fake)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Could not reach the server: Could not look up mcp.example.com. Check your internet connection, VPN or DNS.')
    expect(r.needsAuthorization).toBeUndefined()
  })

  it('never puts the token into the message when the cause text carries it', async () => {
    const fake = (async () => {
      throw fetchFailed(coded('socket hang up while sending Bearer tok-123 to the server', 'EWEIRD'))
    }) as unknown as typeof fetch
    const r = await testServer(http({ Authorization: 'Bearer tok-123' }), 5000, fake)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Could not reach the server: fetch failed: EWEIRD.')
    const fake2 = (async () => {
      throw fetchFailed(coded('rejected tok-123 at the gateway'))
    }) as unknown as typeof fetch
    const r2 = await testServer(http({ Authorization: 'Bearer tok-123' }), 5000, fake2)
    expect(r2.error).toBe('Could not reach the server: fetch failed: rejected [redacted] at the gateway.')
    expect(JSON.stringify(r2)).not.toContain('tok-123')
  })

  it('keeps other errors as they are', async () => {
    const fake = (async () => {
      throw new Error('Invalid URL')
    }) as unknown as typeof fetch
    const r = await testServer(http(), 5000, fake)
    expect(r.error).toBe('Invalid URL')
  })

  const closedSocket = () => fetchFailed(coded('other side closed', 'UND_ERR_SOCKET'))

  /** A fake fetch that answers the handshake but throws `failures` times for `failMethod` first. */
  function flaky(failMethod: string, failures: number, make: () => Error = closedSocket) {
    const calls: string[] = []
    let left = failures
    const fake = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      calls.push(body.method)
      if (body.method === failMethod && left > 0) {
        left--
        throw make()
      }
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), { headers: { 'content-type': 'application/json' } })
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'issues' }] } }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fake, calls }
  }

  it('retries initialize once after a closed socket', async () => {
    const { fake, calls } = flaky('initialize', 1)
    const r = await testServer(http(), 5000, fake)
    expect(r).toMatchObject({ ok: true, tools: ['issues'] })
    expect(calls).toEqual(['initialize', 'initialize', 'notifications/initialized', 'tools/list'])
  })

  it('retries tools/list once after a closed socket', async () => {
    const { fake, calls } = flaky('tools/list', 1)
    const r = await testServer(http(), 5000, fake)
    expect(r).toMatchObject({ ok: true, tools: ['issues'] })
    expect(calls).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list'])
  })

  it('does not retry a notification', async () => {
    const { fake, calls } = flaky('notifications/initialized', 1)
    const r = await testServer(http(), 5000, fake)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Could not reach the server: mcp.example.com closed the connection before answering.')
    expect(calls).toEqual(['initialize', 'notifications/initialized'])
  })

  it('surfaces a second closed socket after the one retry', async () => {
    const { fake, calls } = flaky('initialize', 2)
    const r = await testServer(http(), 5000, fake)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Could not reach the server: mcp.example.com closed the connection before answering.')
    expect(calls).toEqual(['initialize', 'initialize'])
  })

  it('does not retry a failure that is not a closed socket', async () => {
    const { fake, calls } = flaky('initialize', 1, () => fetchFailed(coded('connect ECONNREFUSED 1.2.3.4:443', 'ECONNREFUSED')))
    const r = await testServer(http(), 5000, fake)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Could not reach the server: Could not connect to mcp.example.com (ECONNREFUSED). Check your internet connection, VPN, firewall or proxy.')
    expect(calls).toEqual(['initialize'])
  })
})

describe('describeFetchFailure', () => {
  const host = 'mcp.example.com'

  it('is null for an error that is neither "fetch failed" nor carries a cause', () => {
    expect(describeFetchFailure(new Error('HTTP 500'), host)).toBeNull()
    expect(describeFetchFailure('fetch failed', host)).toBeNull()
    expect(describeFetchFailure(null, host)).toBeNull()
  })

  it('reports a missing cause', () => {
    expect(describeFetchFailure(new TypeError('fetch failed'), host)).toBe('fetch failed: no further detail.')
  })

  it('names DNS failures', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) {
      expect(describeFetchFailure(fetchFailed(coded('getaddrinfo', code)), host)).toBe('Could not look up mcp.example.com. Check your internet connection, VPN or DNS.')
    }
  })

  it('names connection failures with their code', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH']) {
      expect(describeFetchFailure(fetchFailed(coded('connect', code)), host)).toBe(
        `Could not connect to mcp.example.com (${code}). Check your internet connection, VPN, firewall or proxy.`
      )
    }
  })

  it('names certificate failures', () => {
    for (const code of ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
      expect(describeFetchFailure(fetchFailed(coded('tls', code)), host)).toBe(
        `The TLS certificate of mcp.example.com could not be verified (${code}). A proxy, VPN or antivirus that inspects HTTPS can cause this.`
      )
    }
    expect(describeFetchFailure(fetchFailed(coded('unable to verify the first certificate')), host)).toBe(
      'The TLS certificate of mcp.example.com could not be verified. A proxy, VPN or antivirus that inspects HTTPS can cause this.'
    )
  })

  it('names a refused redirect', () => {
    expect(describeFetchFailure(fetchFailed(coded('unexpected redirect')), host)).toBe(
      'mcp.example.com redirected the request; OrgAI does not follow redirects for MCP servers. Check the URL.'
    )
  })

  it('names a closed socket by code or by message', () => {
    expect(describeFetchFailure(fetchFailed(coded('other side closed', 'UND_ERR_SOCKET')), host)).toBe('mcp.example.com closed the connection before answering.')
    expect(describeFetchFailure(fetchFailed(coded('other side closed')), host)).toBe('mcp.example.com closed the connection before answering.')
  })

  it('names an answer that did not arrive in time', () => {
    expect(describeFetchFailure(fetchFailed(coded('headers timeout', 'UND_ERR_HEADERS_TIMEOUT')), host)).toBe('mcp.example.com did not answer in time (UND_ERR_HEADERS_TIMEOUT).')
  })

  it('walks a nested cause', () => {
    const nested = fetchFailed(coded('request failed', undefined, coded('socket error', undefined, coded('getaddrinfo', 'ENOTFOUND'))))
    expect(describeFetchFailure(nested, host)).toBe('Could not look up mcp.example.com. Check your internet connection, VPN or DNS.')
  })

  it('stops after three cause levels', () => {
    const deep = fetchFailed(coded('a', undefined, coded('b', undefined, coded('c', undefined, coded('getaddrinfo', 'ENOTFOUND')))))
    expect(describeFetchFailure(deep, host)).toBe('fetch failed: c.')
  })

  it('falls back to the cause code, else the deepest cause message', () => {
    expect(describeFetchFailure(fetchFailed(coded('something odd', 'EODD')), host)).toBe('fetch failed: EODD.')
    expect(describeFetchFailure(fetchFailed(coded('outer', undefined, coded('inner detail'))), host)).toBe('fetch failed: inner detail.')
  })

  it('describes an error with a cause even when its message is not "fetch failed"', () => {
    expect(describeFetchFailure(coded('request to server failed', undefined, coded('x', 'ECONNREFUSED')), host)).toBe(
      'Could not connect to mcp.example.com (ECONNREFUSED). Check your internet connection, VPN, firewall or proxy.'
    )
  })

  it('isClosedSocketFailure matches UND_ERR_SOCKET, ECONNRESET and "other side closed" only', () => {
    expect(isClosedSocketFailure(fetchFailed(coded('other side closed', 'UND_ERR_SOCKET')))).toBe(true)
    expect(isClosedSocketFailure(fetchFailed(coded('read', 'ECONNRESET')))).toBe(true)
    expect(isClosedSocketFailure(fetchFailed(coded('other side closed')))).toBe(true)
    expect(isClosedSocketFailure(fetchFailed(coded('connect', 'ECONNREFUSED')))).toBe(false)
    expect(isClosedSocketFailure(new Error('HTTP 500'))).toBe(false)
  })

  it('hostOfUrl keeps the host only, never userinfo, path or an invalid URL', () => {
    expect(hostOfUrl('https://user:pass@mcp.example.com:8443/mcp?x=1')).toBe('mcp.example.com:8443')
    expect(hostOfUrl('not a url')).toBe('the server')
    expect(hostOfUrl(undefined)).toBe('the server')
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
  it('usesWindowsShell only routes non-.exe commands through cmd on win32', () => {
    expect(usesWindowsShell('npx', 'win32')).toBe(true)
    expect(usesWindowsShell('C:\\tools\\server.EXE', 'win32')).toBe(false)
    for (const platform of ['darwin', 'linux'] as const) {
      expect(usesWindowsShell('npx', platform)).toBe(false)
      expect(usesWindowsShell('uvx', platform)).toBe(false)
      expect(usesWindowsShell('/opt/homebrew/bin/node', platform)).toBe(false)
    }
  })
})
