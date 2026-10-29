import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseRegistryResponse, searchRegistry } from './registry'

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'registry-response.json'), 'utf8'))

describe('parseRegistryResponse', () => {
  const r = parseRegistryResponse(fixture)

  it('normalizes entries and drops malformed or deleted ones', () => {
    expect(r.entries.map((e) => e.name)).toEqual(['io.github.example/files', 'io.github.example/minimal'])
    expect(r.nextCursor).toBe('io.github.example/minimal:0.1.0')
  })

  it('maps the server fields and _meta', () => {
    const e = r.entries[0]
    expect(e).toMatchObject({
      title: 'Example Files',
      version: '2.1.4',
      repositoryUrl: 'https://github.com/example/files',
      websiteUrl: 'https://example.com',
      status: 'active',
      publishedAt: '2026-03-01T00:00:00Z'
    })
  })

  it('keeps well-formed packages only and never keeps defaults of secret variables', () => {
    const e = r.entries[0]
    expect(e.packages.map((p) => p.registryType)).toEqual(['npm', 'pypi', 'oci'])
    const vars = e.packages[0].environmentVariables
    expect(vars[0]).toMatchObject({ name: 'ALLOWED_DIR', isSecret: false, isRequired: true, default: '.' })
    expect(vars[1]).toMatchObject({ name: 'API_TOKEN', isSecret: true })
    expect(vars[1].default).toBeUndefined()
  })

  it('maps remotes and ignores unknown transports', () => {
    const e = r.entries[0]
    expect(e.remotes).toEqual([{ type: 'streamable-http', url: 'https://mcp.example.com/mcp', headers: [{ name: 'Authorization', isSecret: true, isRequired: true }] }])
  })

  it('tolerates a minimal entry and garbage bodies', () => {
    expect(r.entries[1]).toMatchObject({ description: '', packages: [], remotes: [], version: '0.1.0' })
    expect(parseRegistryResponse(null)).toEqual({ entries: [] })
    expect(parseRegistryResponse({ servers: 'x' })).toEqual({ entries: [] })
  })

  it('clamps long strings', () => {
    const long = parseRegistryResponse({ servers: [{ server: { name: 'a/b', description: 'x'.repeat(5000), version: '1.0.0' } }] })
    expect(long.entries[0].description.length).toBeLessThanOrEqual(600)
  })
})

describe('searchRegistry', () => {
  it('builds the request and caps the limit', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch
    const res = await searchRegistry({ query: 'files', limit: 5000, cursor: 'abc' }, fetchImpl)
    expect(res.entries).toHaveLength(2)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://registry.modelcontextprotocol.io/v0.1/servers')
    expect(u.searchParams.get('search')).toBe('files')
    expect(u.searchParams.get('limit')).toBe('50')
    expect(u.searchParams.get('cursor')).toBe('abc')
    expect(u.searchParams.get('version')).toBe('latest')
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('omits search for an empty query', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"servers":[]}')) as unknown as typeof fetch
    await searchRegistry({ query: '' }, fetchImpl)
    const url = new URL(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string])[0])
    expect(url.searchParams.has('search')).toBe(false)
  })

  it('turns HTTP and network failures into readable errors', async () => {
    await expect(searchRegistry({ query: 'x' }, (async () => new Response('', { status: 503 })) as unknown as typeof fetch)).rejects.toThrow('503')
    await expect(
      searchRegistry({ query: 'x' }, (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch)
    ).rejects.toThrow(/could not be reached/)
  })
})
