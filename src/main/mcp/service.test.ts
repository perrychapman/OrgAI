import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpServerSpec } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { SecretStore, mcpSecretKey } from '../store/secrets'
import { McpService } from './service'

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4)
}

let dir: string
let projects: ProjectStore
let secrets: SecretStore
let svc: McpService
let pid: string

const spec = (over: Partial<McpServerSpec> = {}): McpServerSpec => ({
  id: 'mcp-1',
  name: 'github',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@x/github@1.4.2'],
  secretEnv: ['GITHUB_TOKEN'],
  enabled: true,
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-mcp-'))
  projects = new ProjectStore(join(dir, 'data'))
  secrets = new SecretStore(join(dir, 'data'), cipher)
  svc = new McpService({ projects, secrets })
  pid = projects.create({ name: 'p', path: join(dir, 'repo'), brief: '' }).id
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('McpService servers', () => {
  it('upserts, lists and reports missing secrets', () => {
    const r = svc.upsert({ projectId: pid, spec: spec() })
    expect(r.servers[0].missingSecrets).toEqual(['GITHUB_TOKEN'])
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'GITHUB_TOKEN', value: 'ghp_secret' })
    const info = svc.list(pid)[0]
    expect(info.envSet).toEqual(['GITHUB_TOKEN'])
    expect(info.missingSecrets).toEqual([])
    expect(JSON.stringify(svc.list(pid))).not.toContain('ghp_secret')
    expect(JSON.stringify(projects.get(pid))).not.toContain('ghp_secret')
  })

  it('rejects invalid specs with a readable error', () => {
    expect(() => svc.upsert({ projectId: pid, spec: spec({ args: ['-y', 'pkg@latest'] }) })).toThrow(/not pinned/)
    svc.upsert({ projectId: pid, spec: spec() })
    expect(() => svc.upsert({ projectId: pid, spec: spec({ id: 'mcp-2' }) })).toThrow(/already exists/)
  })

  it('replaces by id and drops secrets of removed slots', () => {
    svc.upsert({ projectId: pid, spec: spec() })
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'GITHUB_TOKEN', value: 'v' })
    svc.upsert({ projectId: pid, spec: spec({ secretEnv: [] }) })
    expect(secrets.has(mcpSecretKey(pid, 'mcp-1', 'env', 'GITHUB_TOKEN'))).toBe(false)
  })

  it('setSecret only accepts declared slots', () => {
    svc.upsert({ projectId: pid, spec: spec() })
    expect(() => svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'OTHER', value: 'x' })).toThrow()
    expect(() => svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'header', name: 'GITHUB_TOKEN', value: 'x' })).toThrow()
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'GITHUB_TOKEN', value: 'x' })
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'GITHUB_TOKEN', value: null })
    expect(svc.list(pid)[0].missingSecrets).toEqual(['GITHUB_TOKEN'])
  })

  it('remove deletes secrets and role grants', () => {
    svc.upsert({ projectId: pid, spec: spec() })
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'GITHUB_TOKEN', value: 'v' })
    const p = projects.get(pid)!
    projects.save({ ...p, roles: p.roles.map((r, i) => (i === 0 ? { ...r, mcpServers: ['mcp-1', 'mcp-9'] } : r)) })
    const r = svc.remove({ projectId: pid, serverId: 'mcp-1' })
    expect(r.servers).toEqual([])
    expect(secrets.keys()).toEqual([])
    expect(r.project.roles.every((x) => !x.mcpServers?.includes('mcp-1'))).toBe(true)
    expect(r.project.roles[0].mcpServers).toEqual(['mcp-9'])
  })

  it('resolve fills secrets, extra values win, and removeProjectSecrets clears everything', () => {
    svc.upsert({ projectId: pid, spec: spec({ env: { A: '1' } }) })
    svc.setSecret({ projectId: pid, serverId: 'mcp-1', kind: 'env', name: 'GITHUB_TOKEN', value: 'stored' })
    const s = svc.list(pid)[0].spec
    expect(svc.resolve(pid, s).env).toEqual({ A: '1', GITHUB_TOKEN: 'stored' })
    expect(svc.resolve(pid, s, { GITHUB_TOKEN: 'run' }).env.GITHUB_TOKEN).toBe('run')
    svc.removeProjectSecrets(pid)
    expect(svc.resolve(pid, s).env).toEqual({ A: '1' })
  })

  it('persistInstall saves the spec as agent-sourced and stores the secrets', () => {
    const p = svc.persistInstall(pid, spec(), { GITHUB_TOKEN: 'tok' })
    expect(p.mcpServers?.[0].source).toBe('agent')
    expect(JSON.stringify(p)).not.toContain('tok')
    expect(svc.resolve(pid, p.mcpServers![0]).env.GITHUB_TOKEN).toBe('tok')
    expect(svc.enabledServers(p)).toHaveLength(1)
    expect(svc.enabledServers({ ...p, mcpServers: [{ ...p.mcpServers![0], enabled: false }] })).toHaveLength(0)
  })

  it('tests a saved stdio server through the probe', async () => {
    const script = join(__dirname, 'fixtures', 'stdio-server.cjs')
    svc.upsert({ projectId: pid, spec: spec({ command: process.execPath, args: [script], secretEnv: [] }) })
    const r = await svc.test({ projectId: pid, serverId: 'mcp-1' })
    expect(r).toMatchObject({ ok: true, tools: ['echo', 'sum'] })
  }, 30000)
})

describe('McpService plugins', () => {
  function pluginDir(manifest: string | null): string {
    const d = join(dir, 'plug')
    mkdirSync(join(d, '.claude-plugin'), { recursive: true })
    if (manifest !== null) writeFileSync(join(d, '.claude-plugin', 'plugin.json'), manifest)
    return d
  }
  const plugin = (path: string) => ({ id: 'plugin-1', name: '', path, enabled: true })

  it('adds a plugin with a valid manifest and names it from the manifest', () => {
    const p = svc.upsertPlugin({ projectId: pid, plugin: plugin(pluginDir('{"name":"my-plugin"}')) })
    expect(p.plugins).toHaveLength(1)
    expect(p.plugins![0].name).toBe('my-plugin')
    expect(svc.removePlugin({ projectId: pid, pluginId: 'plugin-1' }).plugins).toEqual([])
  })
  it('rejects relative paths, missing and broken manifests', () => {
    expect(() => svc.upsertPlugin({ projectId: pid, plugin: plugin('relative/dir') })).toThrow(/absolute/)
    expect(() => svc.upsertPlugin({ projectId: pid, plugin: plugin(join(dir, 'nope')) })).toThrow(/No plugin manifest/)
    expect(() => svc.upsertPlugin({ projectId: pid, plugin: plugin(pluginDir('{oops')) })).toThrow(/not valid JSON/)
  })
})
