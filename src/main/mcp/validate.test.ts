import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { McpLibraryEntry, McpServerSpec } from '@shared/types'
import { MCP_OVERRIDE_VALUE_MAX, MCP_PER_PROJECT_ENV_MAX } from '@shared/types'
import { parseRegistryResponse } from './registry'
import { credentialLikeName, riskyEnvName, cleanOverrides, nameFromRegistry, perProjectEnvProblems, pinErrors, specFromRegistry, validateLibraryEntry, validateSpec } from './validate'

const entries = parseRegistryResponse(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'registry-response.json'), 'utf8'))).entries

describe('perProjectEnvProblems', () => {
  const stdioEntry = (over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
    id: 'mcpl_1',
    name: 'vendor',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg@1.2.3'],
    secretEnv: ['VENDOR_KEY'],
    source: 'user',
    addedAt: '',
    ...over
  })
  const httpEntry = (over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
    id: 'mcpl_2',
    name: 'remote',
    transport: 'http',
    url: 'https://x.test/mcp',
    secretHeaders: ['X-Vendor-Key'],
    source: 'user',
    addedAt: '',
    ...over
  })

  it('accepts clean names and the flag', () => {
    expect(perProjectEnvProblems(stdioEntry({ perProjectSecrets: true, perProjectEnv: ['BASE_URL', 'TENANT_ID'] }))).toEqual([])
    expect(perProjectEnvProblems(httpEntry({ perProjectEnv: ['X-Tenant'] }))).toEqual([])
    expect(perProjectEnvProblems(stdioEntry())).toEqual([])
    expect(validateLibraryEntry(stdioEntry({ perProjectEnv: ['BASE_URL'] }))).toEqual([])
  })

  it('refuses a non-true flag, a non-list, too many names and duplicates', () => {
    expect(perProjectEnvProblems(stdioEntry({ perProjectSecrets: false as unknown as true }))[0]).toMatch(/perProjectSecrets/)
    expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: 'A' as unknown as string[] }))[0]).toMatch(/list of names/)
    const many = Array.from({ length: MCP_PER_PROJECT_ENV_MAX + 1 }, (_, i) => `NAME_${i}`)
    expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: many }))[0]).toMatch(/At most 20/)
    expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: ['A', 'A'] }))[0]).toMatch(/twice/)
    expect(perProjectEnvProblems(httpEntry({ perProjectEnv: ['X-A', 'x-a'] }))[0]).toMatch(/twice/)
    expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: [5 as unknown as string] }))[0]).toMatch(/must be text/)
  })

  it('refuses names that are not valid for the transport', () => {
    expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: ['not valid'] }))[0]).toMatch(/not a valid environment variable name/)
    expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: ['X-Header'] }))[0]).toMatch(/not a valid environment variable name/)
    expect(perProjectEnvProblems(httpEntry({ perProjectEnv: ['bad name'] }))[0]).toMatch(/not a valid header name/)
    expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: ['__proto__'] }))[0]).toMatch(/not a valid/)
  })

  it('refuses secret slots (headers case-insensitively), credential-like and risky names', () => {
    expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: ['VENDOR_KEY'] }))[0]).toMatch(/secret slot/)
    expect(perProjectEnvProblems(httpEntry({ perProjectEnv: ['x-vendor-key'] }))[0]).toMatch(/secret slot/)
    for (const n of ['API_TOKEN', 'DB_PASSWORD', 'CLIENT_SECRET', 'MY_APIKEY', 'AUTH_MODE', 'CREDENTIALS_FILE']) {
      expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: [n] })), n).not.toEqual([])
    }
    for (const n of ['Authorization', 'Proxy-Authorization', 'Cookie', 'X-Api-Key', 'X-Auth-Thing', 'Host', 'X-Forwarded-For']) {
      expect(perProjectEnvProblems(httpEntry({ perProjectEnv: [n] })), n).not.toEqual([])
    }
    for (const n of ['NODE_OPTIONS', 'PATH', 'LD_PRELOAD', 'HTTPS_PROXY', 'PYTHONPATH', 'NPM_CONFIG_REGISTRY', 'GIT_DIR']) {
      expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: [n] })), n).not.toEqual([])
    }
  })

  it('compares stdio names case-insensitively (secret slots and duplicates)', () => {
    expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: ['vendor_key'] }))[0]).toMatch(/secret slot/)
    expect(perProjectEnvProblems(stdioEntry({ perProjectEnv: ['Base_Url', 'BASE_URL'] }))[0]).toMatch(/twice/)
  })

  it('exports the name predicates', () => {
    expect(riskyEnvName('node_options')).toBe(true)
    expect(riskyEnvName('BASE_URL')).toBe(false)
    expect(credentialLikeName('API_TOKEN')).toBe(true)
    expect(credentialLikeName('Cookie')).toBe(false)
    expect(credentialLikeName('Cookie', true)).toBe(true)
  })

  it('refuses hidden characters without echoing them', () => {
    const out = perProjectEnvProblems(stdioEntry({ perProjectEnv: ['BASE​URL'] }))
    expect(out[0]).toMatch(/hidden character \(U\+200B/)
    expect(out[0]).not.toContain('​')
  })

  it('refuses both fields on a connector entry', () => {
    const msg = 'Per-project values are not available for connectors yet; add a custom server instead.'
    expect(perProjectEnvProblems(httpEntry({ connectorId: 'github', perProjectSecrets: true }))).toContain(msg)
    expect(perProjectEnvProblems(httpEntry({ connectorId: 'github', perProjectEnv: ['X-Tenant'] }))).toContain(msg)
    expect(perProjectEnvProblems(httpEntry({ connectorId: 'github' }))).toEqual([])
    expect(validateLibraryEntry(httpEntry({ connectorId: 'github', perProjectSecrets: true }))).toContain(msg)
  })
})

describe('cleanOverrides', () => {
  it('keeps only own allowed string keys and drops the rest silently', () => {
    expect(cleanOverrides({ A: '1', B: '2', C: '3' }, ['A', 'C', 'D'], 'env')).toEqual({ A: '1', C: '3' })
    expect(cleanOverrides({}, ['A'], 'env')).toEqual({})
    expect(cleanOverrides(undefined, ['A'], 'env')).toEqual({})
    const inherited = Object.create({ A: 'x' }) as Record<string, string>
    expect(cleanOverrides(inherited, ['A'], 'env')).toEqual({})
    expect(cleanOverrides(JSON.parse('{"__proto__":"x"}'), ['__proto__'], 'env')).toEqual({})
  })

  it('refuses non-strings, hidden characters, over-long values and a non-object', () => {
    expect(() => cleanOverrides({ A: 5 }, ['A'], 'env')).toThrow(/"A" must have a text value/)
    expect(() => cleanOverrides({ A: 'a\nb' }, ['A'], 'env')).toThrow(/control or hidden/)
    expect(() => cleanOverrides({ A: 'a\tb' }, ['A'], 'env')).toThrow(/control or hidden/)
    expect(() => cleanOverrides({ A: 'a‮b' }, ['A'], 'env')).toThrow(/control or hidden/)
    expect(() => cleanOverrides({ H: 'a\r\nb' }, ['H'], 'header')).toThrow(/single line/)
    expect(() => cleanOverrides({ H: 'a​b' }, ['H'], 'header')).toThrow(/control or hidden/)
    expect(cleanOverrides({ H: 'a\tb' }, ['H'], 'header')).toEqual({ H: 'a\tb' })
    expect(() => cleanOverrides({ A: 'x'.repeat(MCP_OVERRIDE_VALUE_MAX + 1) }, ['A'], 'env')).toThrow(/too long/)
    expect(cleanOverrides({ A: 'x'.repeat(MCP_OVERRIDE_VALUE_MAX) }, ['A'], 'env').A).toHaveLength(MCP_OVERRIDE_VALUE_MAX)
    expect(() => cleanOverrides(['A'], ['A'], 'env')).toThrow(/list of names and values/)
  })

  it('never echoes the value and names only a plain key', () => {
    try {
      cleanOverrides({ A: 'sekret\n' }, ['A'], 'env')
    } catch (e) {
      expect((e as Error).message).not.toContain('sekret')
    }
    try {
      cleanOverrides({ 'X​Y': 5 }, ['X​Y'], 'env')
    } catch (e) {
      expect((e as Error).message).toContain('(unnamed)')
      expect((e as Error).message).not.toContain('​')
    }
  })
})

function stdio(command: string, args: string[], over: Partial<McpServerSpec> = {}): McpServerSpec {
  return { id: 'm1', name: 'srv', transport: 'stdio', command, args, enabled: true, source: 'user', addedAt: '', ...over }
}

describe('validateSpec hidden characters', () => {
  const hidden = (errors: string[], field: string, code: string): boolean => errors.some((e) => e.startsWith(`${field} contains a hidden character (${code}`))

  it('refuses a bidi or zero-width character in every string field and names the field', () => {
    const s = stdio('npx', ['-y', 'pkg@1.2.3', '--root=/a‮/b'], { description: 'Reads​ issues', env: { MODE: 'r‮o' }, roles: ['le​ad'] })
    const errors = validateSpec(s)
    expect(hidden(errors, 'Argument 3', 'U+202E')).toBe(true)
    expect(hidden(errors, 'The description', 'U+200B')).toBe(true)
    expect(hidden(errors, 'Environment variable "MODE"', 'U+202E')).toBe(true)
    expect(hidden(errors, 'A role slug', 'U+200B')).toBe(true)
    expect(hidden(validateSpec(stdio('np​x', ['-y', 'pkg@1.2.3'])), 'The command', 'U+200B')).toBe(true)
    expect(hidden(validateSpec(stdio('npx', ['-y', 'pkg@1.2.3'], { name: 'g​h' })), 'The name', 'U+200B')).toBe(true)
    const http: McpServerSpec = { id: 'm2', name: 'web', transport: 'http', url: 'https://ex‮ample.com/mcp', headers: { 'X-Mode': 'read​' }, enabled: true, source: 'user', addedAt: '' }
    const httpErrors = validateSpec(http)
    expect(hidden(httpErrors, 'The URL', 'U+202E')).toBe(true)
    expect(hidden(httpErrors, 'Header "X-Mode"', 'U+200B')).toBe(true)
    // A name holding hidden characters is never echoed back.
    expect(hidden(validateSpec(stdio('npx', ['-y', 'pkg@1.2.3'], { env: { 'A‮B': 'x' } })), 'An environment variable name', 'U+202E')).toBe(true)
    expect(hidden(validateSpec(stdio('npx', ['-y', 'pkg@1.2.3'], { secretEnv: ['TOK​EN'] })), 'A secret environment variable name', 'U+200B')).toBe(true)
  })

  it('a description is prose: tab, line breaks and emoji / Persian joiners pass; args and env values stay one line', () => {
    // U+200D (ZWJ) in an emoji sequence, U+200C (ZWNJ) in Persian text, a soft hyphen: stored data keeps validating.
    expect(validateSpec(stdio('npx', ['-y', 'pkg@1.2.3'], { description: 'Reads\tissues\nand PRs \u{1F469}‍\u{1F4BB} می‌خواهم co­op' }))).toEqual([])
    expect(validateSpec(stdio('npx', ['-y', 'pkg@1.2.3', 'line1\nline2']))[0]).toMatch(/^Argument 3 contains a hidden character \(U\+000A/)
    expect(validateSpec(stdio('npx', ['-y', 'pkg@1.2.3'], { env: { NODE: 'a\n--require x' } }))[0]).toMatch(/^Environment variable "NODE" contains a hidden character \(U\+000A/)
  })

  it('returns only the hidden-character problems, so later checks never echo the value', () => {
    expect(validateSpec(stdio('npx', ['-y', 'pkg@1.2.3'], { env: { 'A‮B': 'x' } }))).toEqual([
      'An environment variable name contains a hidden character (U+202E, a control, zero-width, bidi or other invisible character); remove it.'
    ])
  })
})

describe('validateSpec names and transports', () => {
  it('accepts a pinned npx server', () => {
    expect(validateSpec(stdio('npx', ['-y', '@scope/pkg@1.2.3']))).toEqual([])
  })
  it('rejects bad and duplicate names', () => {
    expect(validateSpec(stdio('node', ['x.js'], { name: 'Bad Name' })).join()).toMatch(/kebab-case/)
    const other = stdio('node', ['x.js'], { id: 'other' })
    expect(validateSpec(stdio('node', ['x.js']), [other]).join()).toMatch(/already exists/)
    expect(validateSpec(stdio('node', ['x.js']), [stdio('node', ['x.js'])])).toEqual([])
  })
  it('requires transport-consistent fields', () => {
    expect(validateSpec({ ...stdio('', []), command: undefined }).join()).toMatch(/needs a command/)
    const http: McpServerSpec = { id: 'h', name: 'remote', transport: 'http', url: 'ftp://x', enabled: true, source: 'user', addedAt: '' }
    expect(validateSpec(http).join()).toMatch(/http\(s\) URL/)
    expect(validateSpec({ ...http, url: 'https://x.test/mcp' })).toEqual([])
    expect(validateSpec({ ...http, url: 'https://x.test/mcp', command: 'npx' }).join()).toMatch(/cannot have a command/)
    expect(validateSpec(stdio('node', ['x.js'], { url: 'https://x' })).join()).toMatch(/cannot have a URL/)
  })
  it('validates secret slot names', () => {
    expect(validateSpec(stdio('node', ['x.js'], { secretEnv: ['bad name'] })).join()).toMatch(/not a valid name/)
    expect(validateSpec(stdio('node', ['x.js'], { env: { TOKEN: 'x' }, secretEnv: ['TOKEN'] })).join()).toMatch(/both a secret/)
    const http: McpServerSpec = { id: 'h', name: 'remote', transport: 'http', url: 'https://x.test', headers: { authorization: 'x' }, secretHeaders: ['Authorization'], enabled: true, source: 'user', addedAt: '' }
    expect(validateSpec(http).join()).toMatch(/both a secret/)
  })
})

describe('pinned versions', () => {
  it.each([
    ['npx', ['-y', 'pkg@1.2.3']],
    ['npx.cmd', ['-y', '@scope/pkg@1.2.3-beta.1']],
    ['bunx', ['pkg@0.0.1']],
    ['pnpm', ['dlx', 'pkg@2.0.0']],
    ['uvx', ['mcp-server-git==2024.1.5']],
    ['uvx', ['--from', 'pkg==1.0.0', 'cmd']],
    ['uvx', ['--python', '3.12', 'pkg==1.0']],
    ['docker', ['run', '-i', '--rm', '-e', 'TOKEN', 'ghcr.io/a/b:1.2.3']],
    ['docker', ['run', '-i', 'localhost:5000/a/b@sha256:' + 'a'.repeat(64)]],
    ['node', ['server.js']]
  ])('accepts %s %j', (cmd, args) => {
    expect(pinErrors(cmd, args)).toEqual([])
  })

  it.each([
    ['npx', ['-y', 'pkg']],
    ['npx', ['-y', 'pkg@latest']],
    ['npx', ['-y', 'pkg@^1.2.3']],
    ['npx', ['-y', 'pkg@~1.2.3']],
    ['npx', ['-y', 'pkg@1.x']],
    ['npx', ['-y', '@scope/pkg']],
    ['npx', ['-y']],
    ['bunx', ['pkg@1']],
    ['pnpm', ['dlx', 'pkg']],
    ['uvx', ['pkg']],
    ['uvx', ['pkg>=1.0']],
    ['uvx', ['--from', 'pkg', 'cmd']],
    ['uvx', ['pkg==1.*']],
    ['docker', ['run', '-i', 'ghcr.io/a/b']],
    ['docker', ['run', '-i', 'ghcr.io/a/b:latest']],
    ['docker', ['run', '--rm', '-e', 'A', 'localhost:5000/img']]
  ])('rejects %s %j', (cmd, args) => {
    expect(pinErrors(cmd, args).length).toBeGreaterThan(0)
  })

  it('validateSpec surfaces pin errors', () => {
    expect(validateSpec(stdio('npx', ['-y', 'pkg@latest'])).join()).toMatch(/not pinned/)
  })
})

describe('specFromRegistry', () => {
  const files = entries[0]

  it('builds an npx spec pinned to the version with secrets split out', () => {
    const s = specFromRegistry(files, { type: 'package', index: 0 })
    expect(s).toMatchObject({ name: 'files', transport: 'stdio', command: 'npx', args: ['-y', '@example/files-mcp@2.1.4'], source: 'registry', secretEnv: ['API_TOKEN'], env: { ALLOWED_DIR: '.' } })
    expect(s.registry).toEqual({ name: 'io.github.example/files', version: '2.1.4', registryType: 'npm', identifier: '@example/files-mcp' })
    expect(validateSpec(s)).toEqual([])
  })
  it('builds uvx and docker specs that validate', () => {
    const py = specFromRegistry(files, { type: 'package', index: 1 })
    expect(py).toMatchObject({ command: 'uvx', args: ['example-files==2.1.4'] })
    expect(validateSpec(py)).toEqual([])
    const oci = specFromRegistry(files, { type: 'package', index: 2 })
    expect(oci).toMatchObject({ command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/example/files:2.1.4'] })
    expect(validateSpec(oci)).toEqual([])
  })
  it('forwards env vars to docker by name only', () => {
    const e = { ...files, packages: [{ ...files.packages[2], environmentVariables: [{ name: 'TOK', isSecret: true }] }] }
    const s = specFromRegistry(e, { type: 'package', index: 0 })
    expect(s.args).toEqual(['run', '-i', '--rm', '-e', 'TOK', 'ghcr.io/example/files:2.1.4'])
    expect(s.secretEnv).toEqual(['TOK'])
  })
  it('builds an http remote with secret headers', () => {
    const s = specFromRegistry(files, { type: 'remote', index: 0 })
    expect(s).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/mcp', secretHeaders: ['Authorization'] })
    expect(s.registry?.registryType).toBe('remote')
    expect(validateSpec(s)).toEqual([])
  })
  it('produces a spec that validation rejects when the registry version floats', () => {
    const e = { ...files, packages: [{ ...files.packages[0], version: 'latest' }] }
    expect(validateSpec(specFromRegistry(e, { type: 'package', index: 0 })).join()).toMatch(/not pinned/)
  })
  it('refuses unsupported package types and missing choices', () => {
    const e = { ...files, packages: [{ ...files.packages[0], registryType: 'nuget' }] }
    expect(() => specFromRegistry(e, { type: 'package', index: 0 })).toThrow(/cannot launch/)
    expect(() => specFromRegistry(files, { type: 'package', index: 9 })).toThrow()
  })
  it('slugs registry names', () => {
    expect(nameFromRegistry('io.github.Owner/My_Server.v2')).toBe('my-server-v2')
  })
})

describe('validateLibraryEntry', () => {
  const entry = (over: Record<string, unknown> = {}) => ({ id: 'mcpl-1', name: 'github', transport: 'stdio' as const, command: 'npx', args: ['-y', 'pkg@1.2.3'], source: 'user' as const, addedAt: 'x', ...over })
  it('accepts a pinned entry and rejects bad ids, unpinned versions and library name clashes', () => {
    expect(validateLibraryEntry(entry())).toEqual([])
    expect(validateLibraryEntry(entry({ id: 'bad id/..' })).join()).toMatch(/id must be/)
    expect(validateLibraryEntry(entry({ args: ['-y', 'pkg@latest'] })).join()).toMatch(/not pinned/)
    expect(validateLibraryEntry(entry({ id: 'mcpl-2' }), [entry()]).join()).toMatch(/already exists in the MCP library/)
    expect(validateLibraryEntry(entry(), [entry()])).toEqual([])
    expect(validateLibraryEntry(entry({ transport: 'http', command: undefined, args: undefined, url: 'ftp://x' })).join()).toMatch(/http\(s\) URL/)
  })
})

describe('safe ids', () => {
  it('rejects spec and library ids with unsafe characters', () => {
    expect(validateSpec(stdio('node', ['x.js'], { id: '../evil' })).join()).toMatch(/id must be/)
    expect(validateSpec(stdio('node', ['x.js'], { id: '' })).join()).toMatch(/id must be/)
    expect(validateSpec(stdio('node', ['x.js'], { id: 'ok_id-1' }))).toEqual([])
    const entry = { ...stdio('node', ['x.js']), id: 'a/b' } as never
    expect(validateLibraryEntry(entry).join()).toMatch(/id must be/)
  })
})
