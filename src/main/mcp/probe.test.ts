import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { McpServerSpec } from '@shared/types'
import type { ResolvedMcpServer } from '../runtime/types'
import { describeFetchFailure, hostOfUrl, isClosedSocketFailure, parseSse, reachabilityMessage, redact, testServer, usesWindowsShell } from './probe'

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
    expect(r.error).toBe('Could not look up mcp.example.com. Check your internet connection, VPN or DNS.')
    expect(r.needsAuthorization).toBeUndefined()
  })

  it('never doubles the "Could not" prefix, and prefixes sentences that start otherwise', async () => {
    const fail = (cause: Error) =>
      testServer(http(), 5000, (async () => {
        throw fetchFailed(cause)
      }) as unknown as typeof fetch)
    const refused = await fail(coded('connect ECONNREFUSED 1.2.3.4:443', 'ECONNREFUSED'))
    expect(refused.error).toBe('Could not connect to mcp.example.com (ECONNREFUSED). Check your internet connection, VPN, firewall or proxy.')
    expect(refused.error).not.toContain('Could not reach the server')
    const reset = await fail(coded('read ECONNRESET', 'ECONNRESET'))
    expect(reset.error).toBe('Could not reach the server: mcp.example.com closed the connection before answering.')
    const timeout = await fail(coded('headers timeout', 'UND_ERR_HEADERS_TIMEOUT'))
    expect(timeout.error).toBe('Could not reach the server: mcp.example.com did not answer in time (UND_ERR_HEADERS_TIMEOUT).')
  })

  it('scrubs an OAuth bearer injected as the Authorization header even when secretHeaders does not name it', async () => {
    const oauth: ResolvedMcpServer = {
      spec: { id: 'h', name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', enabled: true, source: 'user', addedAt: '' },
      env: {},
      headers: { Authorization: 'Bearer AT-oauth-1' }
    }
    expect(oauth.spec.secretHeaders).toBeUndefined()
    const fake = (async () => new Response('upstream rejected AT-oauth-1 for this account', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch
    const r = await testServer(oauth, 5000, fake)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('HTTP 500')
    expect(r.error).toContain('[redacted]')
    expect(JSON.stringify(r)).not.toContain('AT-oauth-1')
    // The same through a cause message, and with a lower-case header name.
    const lower: ResolvedMcpServer = { ...oauth, headers: { authorization: 'Bearer AT-oauth-2' } }
    const fake2 = (async () => {
      throw fetchFailed(coded('gateway dropped AT-oauth-2'))
    }) as unknown as typeof fetch
    const r2 = await testServer(lower, 5000, fake2)
    expect(r2.error).toBe('Could not reach the server: fetch failed: gateway dropped [redacted].')
    expect(JSON.stringify(r2)).not.toContain('AT-oauth-2')
  })

  it('answers { ok: false } when the fetch throws something that is not an Error', async () => {
    const r = await testServer(http(), 5000, (async () => {
      throw null
    }) as unknown as typeof fetch)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('null')
    const r2 = await testServer(http({ Authorization: 'Bearer tok-123' }), 5000, (async () => {
      throw 'proxy said no to tok-123'
    }) as unknown as typeof fetch)
    expect(r2.ok).toBe(false)
    expect(r2.error).toBe('proxy said no to [redacted]')
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

  /** A fake fetch that answers the handshake (with a session id) but throws `failures` times for `failMethod` first. */
  function flaky(failMethod: string, failures: number, make: () => unknown = closedSocket) {
    const calls: string[] = []
    const headersSeen: Record<string, string>[] = []
    let left = failures
    const fake = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      calls.push(body.method)
      headersSeen.push({ ...(init.headers as Record<string, string>) })
      if (body.method === failMethod && left > 0) {
        left--
        throw make()
      }
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), {
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-9' }
        })
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'issues' }] } }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fake, calls, headersSeen }
  }

  it('retries initialize once after a closed socket', async () => {
    const { fake, calls } = flaky('initialize', 1)
    const r = await testServer(http(), 5000, fake)
    expect(r).toMatchObject({ ok: true, tools: ['issues'] })
    expect(calls).toEqual(['initialize', 'initialize', 'notifications/initialized', 'tools/list'])
  })

  it('retries tools/list once after a closed socket, re-sending the same Mcp-Session-Id', async () => {
    const { fake, calls, headersSeen } = flaky('tools/list', 1)
    const r = await testServer(http(), 5000, fake)
    expect(r).toMatchObject({ ok: true, tools: ['issues'] })
    expect(calls).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list'])
    expect(headersSeen[0]['Mcp-Session-Id']).toBeUndefined()
    expect(headersSeen[2]['Mcp-Session-Id']).toBe('sess-9')
    expect(headersSeen[3]['Mcp-Session-Id']).toBe('sess-9')
    expect(headersSeen[3]['MCP-Protocol-Version']).toBe('2025-06-18')
  })

  it('retries after a string cause that says the other side closed', async () => {
    const { fake, calls } = flaky('initialize', 1, () => new TypeError('fetch failed', { cause: 'other side closed' }))
    const r = await testServer(http(), 5000, fake)
    expect(r).toMatchObject({ ok: true, tools: ['issues'] })
    expect(calls).toEqual(['initialize', 'initialize', 'notifications/initialized', 'tools/list'])
  })

  it('does not retry when the request signal is already aborted', async () => {
    const calls: string[] = []
    const fake = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)).method)
      const signal = init.signal!
      // Throw the closed socket only once the test's own timeout has aborted the signal.
      await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true })))
      throw closedSocket()
    }) as unknown as typeof fetch
    const r = await testServer(http(), 20, fake)
    expect(r.ok).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(calls).toEqual(['initialize'])
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
    expect(r.error).toBe('Could not connect to mcp.example.com (ECONNREFUSED). Check your internet connection, VPN, firewall or proxy.')
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
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']) {
      expect(describeFetchFailure(fetchFailed(coded('connect', code)), host)).toBe(
        `Could not connect to mcp.example.com (${code}). Check your internet connection, VPN, firewall or proxy.`
      )
    }
  })

  it('names certificate failures', () => {
    const store = " If this network inspects HTTPS, its root certificate must be in your system's certificate store. Otherwise the server's own certificate chain may be incomplete or self-signed."
    const base = 'A proxy, VPN or antivirus that inspects HTTPS can cause this.'
    for (const code of ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED']) {
      expect(describeFetchFailure(fetchFailed(coded('tls', code)), host, 'applied')).toBe(
        `The TLS certificate of mcp.example.com could not be verified (${code}). ${base}${store}`
      )
    }
    for (const code of ['CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_TLS_INVALID_PROTOCOL_VERSION']) {
      for (const state of ['applied', 'pending', 'unavailable'] as const) {
        expect(describeFetchFailure(fetchFailed(coded('tls', code)), host, state)).toBe(
          `The TLS certificate of mcp.example.com could not be verified (${code}). ${base}`
        )
      }
    }
    expect(describeFetchFailure(fetchFailed(coded('unable to verify the first certificate')), host, 'applied')).toBe(
      `The TLS certificate of mcp.example.com could not be verified. ${base}${store}`
    )
    expect(describeFetchFailure(fetchFailed(coded('certificate not trusted')), host, 'applied')).toBe(
      `The TLS certificate of mcp.example.com could not be verified. ${base}${store}`
    )
    expect(describeFetchFailure(fetchFailed(coded('certificate has expired')), host, 'applied')).toBe(
      `The TLS certificate of mcp.example.com could not be verified. ${base}`
    )
  })

  it('does not claim store trust while the system store is still being read or could not be read', () => {
    const err = fetchFailed(coded('tls', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'))
    const pending = describeFetchFailure(err, host, 'pending')!
    expect(pending).toContain('still reading the system certificate store')
    expect(pending).toContain('try again in a moment')
    expect(pending).not.toContain('incomplete or self-signed')
    const unavailable = describeFetchFailure(err, host, 'unavailable')!
    expect(unavailable).toContain('could not read the system certificate store')
    expect(unavailable).not.toContain('must be in your')
  })

  it('names a refused redirect', () => {
    expect(describeFetchFailure(fetchFailed(coded('unexpected redirect')), host)).toBe(
      'mcp.example.com redirected the request; OrgAI does not follow redirects for MCP servers. Check the URL.'
    )
  })

  it('names a closed socket by code (UND_ERR_SOCKET, ECONNRESET), by message, or by a string cause', () => {
    expect(describeFetchFailure(fetchFailed(coded('other side closed', 'UND_ERR_SOCKET')), host)).toBe('mcp.example.com closed the connection before answering.')
    expect(describeFetchFailure(fetchFailed(coded('read ECONNRESET', 'ECONNRESET')), host)).toBe('mcp.example.com closed the connection before answering.')
    expect(describeFetchFailure(fetchFailed(coded('other side closed')), host)).toBe('mcp.example.com closed the connection before answering.')
    expect(describeFetchFailure(new TypeError('fetch failed', { cause: 'other side closed' }), host)).toBe('mcp.example.com closed the connection before answering.')
  })

  it('reads a string cause as the last link and still falls back to it', () => {
    expect(describeFetchFailure(new TypeError('fetch failed', { cause: 'the proxy hung up' }), host)).toBe('fetch failed: the proxy hung up.')
    expect(describeFetchFailure(fetchFailed(coded('outer', undefined, 'inner text')), host)).toBe('fetch failed: inner text.')
    expect(isClosedSocketFailure(new TypeError('fetch failed', { cause: 'other side closed' }))).toBe(true)
    expect(isClosedSocketFailure(new TypeError('fetch failed', { cause: 'something else' }))).toBe(false)
  })

  it('caps the fallback detail at 300 characters', () => {
    const long = 'x'.repeat(1000)
    const byMessage = describeFetchFailure(fetchFailed(coded(long)), host)!
    expect(byMessage).toBe(`fetch failed: ${'x'.repeat(300)}.`)
    const byCode = describeFetchFailure(fetchFailed(coded('odd', `E${'Y'.repeat(1000)}`)), host)!
    expect(byCode.length).toBe('fetch failed: '.length + 300 + 1)
    expect(byCode.endsWith('.')).toBe(true)
  })

  it('reachabilityMessage adds the prefix only to a sentence that does not start with "Could not"', () => {
    expect(reachabilityMessage('Could not look up h. Check.')).toBe('Could not look up h. Check.')
    expect(reachabilityMessage('h closed the connection before answering.')).toBe('Could not reach the server: h closed the connection before answering.')
    expect(reachabilityMessage('fetch failed: EODD.')).toBe('Could not reach the server: fetch failed: EODD.')
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
