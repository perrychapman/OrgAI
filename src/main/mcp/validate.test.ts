import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { McpServerSpec } from '@shared/types'
import { parseRegistryResponse } from './registry'
import { nameFromRegistry, pinErrors, specFromRegistry, validateSpec } from './validate'

const entries = parseRegistryResponse(JSON.parse(readFileSync(join(__dirname, 'fixtures', 'registry-response.json'), 'utf8'))).entries

function stdio(command: string, args: string[], over: Partial<McpServerSpec> = {}): McpServerSpec {
  return { id: 'm1', name: 'srv', transport: 'stdio', command, args, enabled: true, source: 'user', addedAt: '', ...over }
}

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
