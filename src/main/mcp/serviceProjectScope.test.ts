import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLibraryEntry, McpServerSpec, McpServersProposalPayload } from '@shared/types'
import { MCP_OVERRIDE_VALUE_MAX, proposalSecretKey } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { SecretStore, mcpLibraryOAuthKey, mcpLibrarySecretKey, mcpSecretKey, mcpSecretPrefix } from '../store/secrets'
import { McpService } from './service'

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4)
}

const NOW = Date.parse('2026-06-01T00:00:00.000Z')

let dir: string
let projects: ProjectStore
let secrets: SecretStore
let library: McpLibraryStore
let svc: McpService
let pid: string
let pid2: string

/** A stdio entry with per-project secrets and one overridable env name. */
const vendor = (over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
  id: 'mcpl_s',
  name: 'vendor',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@x/vendor@1.0.0'],
  env: { BASE_URL: 'https://default.test' },
  secretEnv: ['VENDOR_KEY'],
  perProjectSecrets: true,
  perProjectEnv: ['BASE_URL'],
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

const remote = (over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
  id: 'mcpl_h',
  name: 'remote',
  transport: 'http',
  url: 'https://remote.test/mcp',
  headers: { 'X-Tenant': 'default' },
  secretHeaders: ['X-Vendor-Key'],
  perProjectSecrets: true,
  perProjectEnv: ['X-Tenant'],
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

const projectOnly = (over: Partial<McpServerSpec> = {}): McpServerSpec => ({
  id: 'mcp-own',
  name: 'own',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'own@1.0.0'],
  secretEnv: ['OWN_KEY'],
  enabled: true,
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

function link(projectId: string, libraryId: string, extra: { roles?: string[] } = {}): McpServerSpec {
  const r = svc.linkLibrary({ projectId, libraryId, ...extra })
  return r.project.mcpServers!.find((s) => s.libraryId === libraryId)!
}

const projectKeys = (p: string, s: string): string[] => secrets.keys(mcpSecretPrefix(p, s))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-mcpscope-'))
  projects = new ProjectStore(join(dir, 'data'))
  secrets = new SecretStore(join(dir, 'data'), cipher)
  library = new McpLibraryStore(join(dir, 'data'))
  svc = new McpService({ projects, secrets, library, now: () => NOW, openExternal: async () => {} })
  pid = projects.create({ name: 'client-a', path: join(dir, 'a'), brief: '' }).id
  pid2 = projects.create({ name: 'client-b', path: join(dir, 'b'), brief: '' }).id
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('perProjectSecrets: where values are read', () => {
  it('a flagged link uses only this project\'s values, never the entry\'s', () => {
    svc.libraryUpsert(vendor())
    svc.librarySetSecret({ libraryId: 'mcpl_s', kind: 'env', name: 'VENDOR_KEY', value: 'ENTRY' })
    const l = link(pid, 'mcpl_s')
    // The entry's value is set but the link has none: it does not start and nothing falls back.
    expect(svc.enabledServers(projects.get(pid)!)).toEqual([])
    expect(svc.resolve(pid, l).env.VENDOR_KEY).toBeUndefined()
    expect(svc.skippedServers(projects.get(pid)!)).toEqual([{ name: 'vendor', missing: ['VENDOR_KEY'], scope: 'project' }])
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'env', name: 'VENDOR_KEY', value: 'PROJ' })
    expect(secrets.has(mcpSecretKey(pid, l.id, 'env', 'VENDOR_KEY'))).toBe(true)
    expect(svc.enabledServers(projects.get(pid)!).map((s) => s.name)).toEqual(['vendor'])
    expect(svc.resolve(pid, l).env.VENDOR_KEY).toBe('PROJ')
    expect(svc.skippedServers(projects.get(pid)!)).toEqual([])
    // The other project is unaffected: its own scope is still empty.
    const l2 = link(pid2, 'mcpl_s')
    expect(svc.resolve(pid2, l2).env.VENDOR_KEY).toBeUndefined()
  })

  it('a link without the flag keeps using the entry\'s values and refuses a project write', () => {
    svc.libraryUpsert(vendor({ perProjectSecrets: undefined, perProjectEnv: undefined }))
    svc.librarySetSecret({ libraryId: 'mcpl_s', kind: 'env', name: 'VENDOR_KEY', value: 'ENTRY' })
    const l = link(pid, 'mcpl_s')
    expect(svc.resolve(pid, l).env.VENDOR_KEY).toBe('ENTRY')
    expect(svc.skippedServers(projects.get(pid)!)).toEqual([])
    expect(() => svc.setSecret({ projectId: pid, serverId: l.id, kind: 'env', name: 'VENDOR_KEY', value: 'x' })).toThrow(/comes from your MCP library/)
    expect(svc.list(pid)[0].secretScope).toBe('library')
  })

  it('info reports the scope and has-flags from the project scope', () => {
    svc.libraryUpsert(vendor())
    svc.librarySetSecret({ libraryId: 'mcpl_s', kind: 'env', name: 'VENDOR_KEY', value: 'ENTRY' })
    const l = link(pid, 'mcpl_s')
    expect(svc.list(pid)[0]).toMatchObject({ secretScope: 'project', envSet: [], missingSecrets: ['VENDOR_KEY'] })
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'env', name: 'VENDOR_KEY', value: 'PROJ' })
    expect(svc.list(pid)[0]).toMatchObject({ secretScope: 'project', envSet: ['VENDOR_KEY'], missingSecrets: [] })
    expect(JSON.stringify(svc.list(pid))).not.toContain('PROJ')
    expect(svc.list(pid2)).toEqual([])
    projects.save({ ...projects.get(pid2)!, mcpServers: [projectOnly()] })
    expect(svc.list(pid2)[0].secretScope).toBe('project')
  })

  it('libraryInfo lists every linking project with the slots still empty there', () => {
    svc.libraryUpsert(vendor())
    const a = link(pid, 'mcpl_s')
    const b = link(pid2, 'mcpl_s')
    svc.setSecret({ projectId: pid, serverId: a.id, kind: 'env', name: 'VENDOR_KEY', value: 'A' })
    const info = svc.libraryList()[0]
    expect(info.projectSecrets).toHaveLength(2)
    expect(info.projectSecrets).toEqual(
      expect.arrayContaining([
        { projectId: pid, projectName: 'client-a', serverId: a.id, missingSecrets: [] },
        { projectId: pid2, projectName: 'client-b', serverId: b.id, missingSecrets: ['VENDOR_KEY'] }
      ])
    )
    svc.libraryUpsert(vendor({ perProjectSecrets: undefined }))
    expect(svc.libraryList()[0].projectSecrets).toBeUndefined()
  })

  it('setSecret keeps its slot, kind and single-line checks for a flagged link', () => {
    svc.libraryUpsert(remote())
    const l = link(pid, 'mcpl_h')
    expect(() => svc.setSecret({ projectId: pid, serverId: l.id, kind: 'header', name: 'Other', value: 'x' })).toThrow(/not a secret header/)
    expect(() => svc.setSecret({ projectId: pid, serverId: l.id, kind: 'env', name: 'X-Vendor-Key', value: 'x' })).toThrow(/not a secret environment variable/)
    expect(() => svc.setSecret({ projectId: pid, serverId: l.id, kind: 'header', name: 'X-Vendor-Key', value: 'a\nb' })).toThrow(/single line/)
    expect(() => svc.setSecret({ projectId: pid, serverId: l.id, kind: 'cookie' as 'env', name: 'X-Vendor-Key', value: 'x' })).toThrow(/Unknown secret kind/)
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'header', name: 'X-Vendor-Key', value: 'k' })
    expect(svc.resolve(pid, l).headers['X-Vendor-Key']).toBe('k')
    // null clears it again
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'header', name: 'X-Vendor-Key', value: null })
    expect(svc.resolve(pid, l).headers['X-Vendor-Key']).toBeUndefined()
  })

  it('toggling the flag keeps both stores; only the active scope is read', () => {
    svc.libraryUpsert(vendor())
    svc.librarySetSecret({ libraryId: 'mcpl_s', kind: 'env', name: 'VENDOR_KEY', value: 'ENTRY' })
    const l = link(pid, 'mcpl_s')
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'env', name: 'VENDOR_KEY', value: 'PROJ' })
    svc.libraryUpsert(vendor({ perProjectSecrets: undefined }))
    expect(svc.resolve(pid, l).env.VENDOR_KEY).toBe('ENTRY')
    expect(secrets.has(mcpSecretKey(pid, l.id, 'env', 'VENDOR_KEY'))).toBe(true)
    svc.libraryUpsert(vendor())
    expect(svc.resolve(pid, l).env.VENDOR_KEY).toBe('PROJ')
    expect(secrets.has(mcpLibrarySecretKey('mcpl_s', 'env', 'VENDOR_KEY'))).toBe(true)
  })

  it('stores a proposal card secret for a flagged link in the project scope', () => {
    svc.libraryUpsert(vendor())
    const l = link(pid, 'mcpl_s')
    const slot = { serverId: l.id, kind: 'env' as const, name: 'VENDOR_KEY' }
    const payload = { scope: 'project', upsert: [{ ...l, enabled: true }], secrets: [slot], rationale: 'r' } as McpServersProposalPayload
    const waiting = svc.storeProposalSecrets(pid, payload, { [proposalSecretKey(slot)]: 'FROMCARD' })
    expect(waiting).toEqual([])
    expect(secrets.has(mcpSecretKey(pid, l.id, 'env', 'VENDOR_KEY'))).toBe(true)
    expect(secrets.has(mcpLibrarySecretKey('mcpl_s', 'env', 'VENDOR_KEY'))).toBe(false)
  })
})

describe('overrides', () => {
  it('replaces, keeps and clears the stored overrides and drops names outside the entry\'s list', () => {
    svc.libraryUpsert(vendor())
    const l = link(pid, 'mcpl_s')
    let r = svc.upsert({ projectId: pid, spec: { ...l, envOverrides: { BASE_URL: 'https://a.test', EVIL: 'x', NODE_OPTIONS: '--require x' } } })
    expect(r.project.mcpServers![0].envOverrides).toEqual({ BASE_URL: 'https://a.test' })
    expect(projects.get(pid)!.mcpServers![0].envOverrides).toEqual({ BASE_URL: 'https://a.test' })
    // absent keeps
    r = svc.upsert({ projectId: pid, spec: { ...l, enabled: false } })
    expect(r.project.mcpServers![0].envOverrides).toEqual({ BASE_URL: 'https://a.test' })
    expect(r.project.mcpServers![0].enabled).toBe(false)
    // present replaces
    r = svc.upsert({ projectId: pid, spec: { ...l, envOverrides: { BASE_URL: 'https://b.test' } } })
    expect(r.project.mcpServers![0].envOverrides).toEqual({ BASE_URL: 'https://b.test' })
    // {} clears and stores no empty object
    r = svc.upsert({ projectId: pid, spec: { ...l, envOverrides: {} } })
    expect(r.project.mcpServers![0]).not.toHaveProperty('envOverrides')
    expect('envOverrides' in projects.get(pid)!.mcpServers![0]).toBe(false)
  })

  it('refuses a control or hidden character and an over-long value without echoing it', () => {
    svc.libraryUpsert(vendor())
    const l = link(pid, 'mcpl_s')
    expect(() => svc.upsert({ projectId: pid, spec: { ...l, envOverrides: { BASE_URL: 'https://a\nb' } } })).toThrow(/control or hidden/)
    expect(() => svc.upsert({ projectId: pid, spec: { ...l, envOverrides: { BASE_URL: 'https://a‮b' } } })).toThrow(/control or hidden/)
    expect(() => svc.upsert({ projectId: pid, spec: { ...l, envOverrides: { BASE_URL: 'x'.repeat(MCP_OVERRIDE_VALUE_MAX + 1) } } })).toThrow(/too long/)
    expect(() => svc.upsert({ projectId: pid, spec: { ...l, envOverrides: { BASE_URL: 5 as unknown as string } } })).toThrow(/text value/)
    try {
      svc.upsert({ projectId: pid, spec: { ...l, envOverrides: { BASE_URL: 'secretvalue\n' } } })
    } catch (e) {
      expect((e as Error).message).not.toContain('secretvalue')
    }
    expect(projects.get(pid)!.mcpServers![0].envOverrides).toBeUndefined()
  })

  it('uses headerOverrides for http entries and ignores the other kind', () => {
    svc.libraryUpsert(remote())
    const l = link(pid, 'mcpl_h')
    const r = svc.upsert({ projectId: pid, spec: { ...l, headerOverrides: { 'X-Tenant': 'acme', Authorization: 'Bearer x' }, envOverrides: { BASE_URL: 'x' } } })
    expect(r.project.mcpServers![0].headerOverrides).toEqual({ 'X-Tenant': 'acme' })
    expect(r.project.mcpServers![0]).not.toHaveProperty('envOverrides')
    expect(() => svc.upsert({ projectId: pid, spec: { ...l, headerOverrides: { 'X-Tenant': 'a\r\nHost: evil' } } })).toThrow(/single line/)
  })

  it('a project-only server never keeps per-project fields or overrides', () => {
    const polluted = { ...projectOnly(), perProjectSecrets: true, perProjectEnv: ['A'], envOverrides: { A: '1' }, headerOverrides: { B: '2' } } as McpServerSpec
    const r = svc.upsert({ projectId: pid, spec: polluted })
    const s = r.project.mcpServers![0]
    for (const k of ['perProjectSecrets', 'perProjectEnv', 'envOverrides', 'headerOverrides']) expect(s, k).not.toHaveProperty(k)
  })

  it('resolve merges the overrides over the entry\'s env, after plain values and before secrets', () => {
    svc.libraryUpsert(vendor())
    svc.librarySetSecret({ libraryId: 'mcpl_s', kind: 'env', name: 'VENDOR_KEY', value: 'ENTRY' })
    const l = link(pid, 'mcpl_s')
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'env', name: 'VENDOR_KEY', value: 'PROJ' })
    svc.upsert({ projectId: pid, spec: { ...l, envOverrides: { BASE_URL: 'https://tenant.test' } } })
    const live = svc.enabledServers(projects.get(pid)!)[0]
    expect(live.envOverrides).toEqual({ BASE_URL: 'https://tenant.test' })
    expect(svc.resolve(pid, live).env).toEqual({ BASE_URL: 'https://tenant.test', VENDOR_KEY: 'PROJ' })
    // another project without overrides sees the entry's default
    projects.save({ ...projects.get(pid2)!, mcpServers: [] })
    const l2 = link(pid2, 'mcpl_s')
    svc.setSecret({ projectId: pid2, serverId: l2.id, kind: 'env', name: 'VENDOR_KEY', value: 'B' })
    expect(svc.resolve(pid2, l2).env.BASE_URL).toBe('https://default.test')
  })

  it('a secret value wins over an override of the same name', () => {
    // Validation keeps a slot out of perProjectEnv; a hand-edited library file could still list it.
    svc.libraryUpsert(vendor())
    const l = link(pid, 'mcpl_s')
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'env', name: 'VENDOR_KEY', value: 'PROJ' })
    library.save({ ...library.get('mcpl_s')!, perProjectEnv: ['BASE_URL', 'VENDOR_KEY'] })
    projects.save({ ...projects.get(pid)!, mcpServers: [{ ...projects.get(pid)!.mcpServers![0], envOverrides: { VENDOR_KEY: 'override' } }] })
    expect(svc.resolve(pid, projects.get(pid)!.mcpServers![0]).env.VENDOR_KEY).toBe('PROJ')
  })

  it('ignores an override whose name left the entry\'s list and a stored bad value (warning names the server only)', () => {
    svc.libraryUpsert(vendor())
    const l = link(pid, 'mcpl_s')
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'env', name: 'VENDOR_KEY', value: 'PROJ' })
    projects.save({ ...projects.get(pid)!, mcpServers: [{ ...projects.get(pid)!.mcpServers![0], envOverrides: { BASE_URL: 'https://t.test' } }] })
    library.save({ ...library.get('mcpl_s')!, perProjectEnv: [] })
    expect(svc.resolve(pid, projects.get(pid)!.mcpServers![0]).env.BASE_URL).toBe('https://default.test')
    library.save({ ...library.get('mcpl_s')!, perProjectEnv: ['BASE_URL'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    projects.save({ ...projects.get(pid)!, mcpServers: [{ ...projects.get(pid)!.mcpServers![0], envOverrides: { BASE_URL: 'bad\nvalue' } }] })
    expect(svc.resolve(pid, projects.get(pid)!.mcpServers![0]).env.BASE_URL).toBe('https://default.test')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('vendor')
    expect(String(warn.mock.calls[0][0])).not.toContain('bad')
  })

  it('header overrides replace an existing header of any letter case', () => {
    svc.libraryUpsert(remote())
    const l = link(pid, 'mcpl_h')
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'header', name: 'X-Vendor-Key', value: 'k' })
    svc.upsert({ projectId: pid, spec: { ...l, headerOverrides: { 'X-Tenant': 'acme' } } })
    expect(svc.resolve(pid, projects.get(pid)!.mcpServers![0]).headers).toEqual({ 'X-Tenant': 'acme', 'X-Vendor-Key': 'k' })
  })
})

describe('entry rules', () => {
  it('the user may set and clear the flags; proposals and installs never do', () => {
    svc.libraryUpsert(vendor())
    expect(library.get('mcpl_s')).toMatchObject({ perProjectSecrets: true, perProjectEnv: ['BASE_URL'] })
    // an approved redefinition without the flags keeps them
    svc.applyLibraryProposal({ scope: 'library', upsert: [{ ...vendor(), perProjectSecrets: undefined, perProjectEnv: undefined, enabled: true, description: 'new text' }], rationale: 'r' })
    expect(library.get('mcpl_s')).toMatchObject({ description: 'new text', perProjectSecrets: true, perProjectEnv: ['BASE_URL'] })
    // an approved redefinition cannot set other values either
    svc.applyLibraryProposal({ scope: 'library', upsert: [{ ...vendor(), perProjectEnv: ['OTHER'], enabled: true }], rationale: 'r' })
    expect(library.get('mcpl_s')!.perProjectEnv).toEqual(['BASE_URL'])
    // a new entry from a proposal never gets them
    svc.applyLibraryProposal({
      scope: 'library',
      upsert: [{ ...vendor({ id: 'mcpl_new', name: 'fresh' }), enabled: true }],
      rationale: 'r'
    })
    expect(library.get('mcpl_new')).not.toHaveProperty('perProjectSecrets')
    expect(library.get('mcpl_new')).not.toHaveProperty('perProjectEnv')
    // the user clears them
    svc.libraryUpsert(vendor({ perProjectSecrets: undefined, perProjectEnv: undefined }))
    expect(library.get('mcpl_s')).not.toHaveProperty('perProjectSecrets')
    expect(library.get('mcpl_s')).not.toHaveProperty('perProjectEnv')
  })

  it('a redefinition that turns a listed name into a secret slot drops the list, not the flag', () => {
    svc.libraryUpsert(vendor())
    svc.applyLibraryProposal({ scope: 'library', upsert: [{ ...vendor({ secretEnv: ['VENDOR_KEY', 'BASE_URL'], env: undefined }), enabled: true }], rationale: 'r' })
    expect(library.get('mcpl_s')).toMatchObject({ perProjectSecrets: true })
    expect(library.get('mcpl_s')).not.toHaveProperty('perProjectEnv')
  })

  it('project proposals and installs strip the per-project fields from new servers', () => {
    const polluted = { ...projectOnly({ id: 'mcp-new', name: 'fresh' }), perProjectSecrets: true, perProjectEnv: ['A'], envOverrides: { A: '1' } } as McpServerSpec
    svc.applyProposal(pid, { scope: 'project', upsert: [{ ...polluted, projectOnly: true }], rationale: 'r' } as McpServersProposalPayload)
    const s = projects.get(pid)!.mcpServers!.find((x) => x.id === 'mcp-new')!
    for (const k of ['perProjectSecrets', 'perProjectEnv', 'envOverrides']) expect(s, k).not.toHaveProperty(k)
    svc.persistInstall(pid, { ...polluted, id: 'mcp-inst', name: 'inst' }, {}, 'library')
    expect(library.list().find((e) => e.name === 'inst')).not.toHaveProperty('perProjectSecrets')
    expect(projects.get(pid)!.mcpServers!.find((x) => x.id === 'mcp-inst')).not.toHaveProperty('envOverrides')
  })

  it('a project proposal on a linked server keeps the stored overrides', () => {
    svc.libraryUpsert(vendor())
    const l = link(pid, 'mcpl_s')
    svc.upsert({ projectId: pid, spec: { ...l, envOverrides: { BASE_URL: 'https://t.test' } } })
    svc.applyProposal(pid, { scope: 'project', upsert: [{ ...l, enabled: false, envOverrides: { BASE_URL: 'https://hijack.test' } }], rationale: 'r' } as McpServersProposalPayload)
    expect(projects.get(pid)!.mcpServers![0]).toMatchObject({ enabled: false, envOverrides: { BASE_URL: 'https://t.test' } })
  })

  it('the entry validation runs on libraryUpsert and refuses connector entries', () => {
    expect(() => svc.libraryUpsert(vendor({ perProjectEnv: ['VENDOR_KEY'] }))).toThrow(/secret slot/)
    expect(() => svc.libraryUpsert(vendor({ perProjectEnv: ['NODE_OPTIONS'] }))).toThrow(/changes what runs/)
    library.save(remote({ id: 'mcpl_c', name: 'conn', connectorId: 'github', perProjectSecrets: undefined, perProjectEnv: undefined }))
    expect(() => svc.libraryUpsert(remote({ id: 'mcpl_c', name: 'conn', perProjectSecrets: true, perProjectEnv: undefined }))).toThrow(/not available for connectors/)
  })

  it('a connector entry keeps connectorCustom through an edit and a renderer cannot set it', () => {
    library.save(remote({ id: 'mcpl_c', name: 'conn', connectorId: 'my-vendor', connectorCustom: true, perProjectSecrets: undefined, perProjectEnv: undefined }))
    const same = { ...library.get('mcpl_c')! }
    delete (same as { connectorCustom?: true }).connectorCustom
    svc.libraryUpsert({ ...same, description: 'edited' })
    expect(library.get('mcpl_c')).toMatchObject({ connectorId: 'my-vendor', connectorCustom: true, description: 'edited' })
    svc.libraryUpsert(remote({ connectorCustom: true } as Partial<McpLibraryEntry>))
    expect(library.get('mcpl_h')).not.toHaveProperty('connectorCustom')
  })
})

describe('retarget and cleanup', () => {
  function seed(): { a: McpServerSpec; b: McpServerSpec } {
    svc.libraryUpsert(vendor())
    const a = link(pid, 'mcpl_s')
    const b = link(pid2, 'mcpl_s')
    svc.setSecret({ projectId: pid, serverId: a.id, kind: 'env', name: 'VENDOR_KEY', value: 'A' })
    svc.setSecret({ projectId: pid2, serverId: b.id, kind: 'env', name: 'VENDOR_KEY', value: 'B' })
    return { a, b }
  }

  it('an approved launch change clears every project\'s own values; the same launch and the user\'s edit do not', () => {
    const { a, b } = seed()
    svc.applyLibraryProposal({ scope: 'library', upsert: [{ ...vendor(), description: 'same launch', enabled: true }], rationale: 'r' })
    expect(projectKeys(pid, a.id)).toHaveLength(1)
    svc.libraryUpsert(vendor({ args: ['-y', '@x/vendor@1.0.1'] }))
    expect(projectKeys(pid, a.id)).toHaveLength(1)
    svc.applyLibraryProposal({ scope: 'library', upsert: [{ ...vendor({ args: ['-y', '@evil/vendor@9.9.9'] }), enabled: true }], rationale: 'r' })
    expect(projectKeys(pid, a.id)).toEqual([])
    expect(projectKeys(pid2, b.id)).toEqual([])
    expect(library.get('mcpl_s')!.perProjectSecrets).toBe(true)
  })

  it('removing a secret slot from the entry deletes it from every link\'s project scope', () => {
    const { a, b } = seed()
    svc.libraryUpsert(vendor({ secretEnv: undefined }))
    expect(projectKeys(pid, a.id)).toEqual([])
    expect(projectKeys(pid2, b.id)).toEqual([])
  })

  it('remove() of a link deletes its project prefix and keeps the entry\'s values and tokens', () => {
    const { a } = seed()
    svc.libraryUpsert(vendor({ perProjectSecrets: undefined }))
    svc.librarySetSecret({ libraryId: 'mcpl_s', kind: 'env', name: 'VENDOR_KEY', value: 'ENTRY' })
    secrets.set(mcpLibraryOAuthKey('mcpl_s', 'accessToken'), 'AT')
    svc.remove({ projectId: pid, serverId: a.id })
    expect(projectKeys(pid, a.id)).toEqual([])
    expect(secrets.has(mcpLibrarySecretKey('mcpl_s', 'env', 'VENDOR_KEY'))).toBe(true)
    expect(secrets.has(mcpLibraryOAuthKey('mcpl_s', 'accessToken'))).toBe(true)
  })

  it('libraryRemove deletes the project prefix of every link', () => {
    const { a, b } = seed()
    svc.libraryRemove({ libraryId: 'mcpl_s' })
    expect(projectKeys(pid, a.id)).toEqual([])
    expect(projectKeys(pid2, b.id)).toEqual([])
    expect(projects.get(pid)!.mcpServers).toEqual([])
  })
})

describe('copyFromLibrary', () => {
  it('copies a flagged link: overrides baked, own values moved, grants and enabled kept, entry values not copied', () => {
    svc.libraryUpsert(vendor())
    svc.librarySetSecret({ libraryId: 'mcpl_s', kind: 'env', name: 'VENDOR_KEY', value: 'ENTRY' })
    secrets.set(mcpLibraryOAuthKey('mcpl_s', 'accessToken'), 'AT')
    const slug = projects.get(pid)!.roles[0].slug
    const l = link(pid, 'mcpl_s', { roles: [slug] })
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'env', name: 'VENDOR_KEY', value: 'PROJ' })
    svc.upsert({ projectId: pid, spec: { ...l, enabled: false, envOverrides: { BASE_URL: 'https://tenant.test' } } })
    const p0 = projects.get(pid)!
    projects.save({ ...p0, roles: p0.roles.map((r, i) => (i === 0 ? { ...r, mcpServers: [l.id] } : r)) })

    const r = svc.copyFromLibrary({ projectId: pid, serverId: l.id, copySecrets: false })
    const copy = r.project.mcpServers![0]
    expect(copy.id).not.toBe(l.id)
    expect(copy).toMatchObject({ name: 'vendor', source: 'user', enabled: false, roles: [slug], env: { BASE_URL: 'https://tenant.test' }, secretEnv: ['VENDOR_KEY'], command: 'npx' })
    for (const k of ['libraryId', 'connectorId', 'connectorVariant', 'connectorCustom', 'oauth', 'buildDigest', 'perProjectSecrets', 'perProjectEnv', 'envOverrides', 'headerOverrides']) {
      expect(copy, k).not.toHaveProperty(k)
    }
    expect(r.servers[0]).toMatchObject({ secretScope: 'project', envSet: ['VENDOR_KEY'] })
    expect(secrets.get(mcpSecretKey(pid, copy.id, 'env', 'VENDOR_KEY'))).toBe('PROJ')
    expect(projectKeys(pid, l.id)).toEqual([])
    expect(projectKeys(pid, copy.id)).toEqual([mcpSecretKey(pid, copy.id, 'env', 'VENDOR_KEY')])
    expect(projects.get(pid)!.roles[0].mcpServers).toEqual([copy.id])
    // the entry is untouched
    expect(library.get('mcpl_s')).toBeDefined()
    expect(secrets.has(mcpLibraryOAuthKey('mcpl_s', 'accessToken'))).toBe(true)
  })

  it('without the flag, copySecrets copies the entry\'s values and false copies none; OAuth is never copied', () => {
    svc.libraryUpsert(vendor({ perProjectSecrets: undefined, perProjectEnv: undefined }))
    svc.librarySetSecret({ libraryId: 'mcpl_s', kind: 'env', name: 'VENDOR_KEY', value: 'ENTRY' })
    secrets.set(mcpLibraryOAuthKey('mcpl_s', 'accessToken'), 'AT')
    secrets.set(mcpLibraryOAuthKey('mcpl_s', 'refreshToken'), 'RT')
    const a = link(pid, 'mcpl_s')
    const b = link(pid2, 'mcpl_s')
    const withCopy = svc.copyFromLibrary({ projectId: pid, serverId: a.id, copySecrets: true }).project.mcpServers![0]
    expect(secrets.get(mcpSecretKey(pid, withCopy.id, 'env', 'VENDOR_KEY'))).toBe('ENTRY')
    expect(projectKeys(pid, withCopy.id).filter((k) => k.includes(':oauth:'))).toEqual([])
    const without = svc.copyFromLibrary({ projectId: pid2, serverId: b.id, copySecrets: false }).project.mcpServers![0]
    expect(projectKeys(pid2, without.id)).toEqual([])
    expect(svc.skippedServers(projects.get(pid2)!)).toEqual([{ name: 'vendor', missing: ['VENDOR_KEY'] }])
    // the library entry's own values stay for other links
    expect(secrets.get(mcpLibrarySecretKey('mcpl_s', 'env', 'VENDOR_KEY'))).toBe('ENTRY')
  })

  it('bakes a header override into an http copy', () => {
    svc.libraryUpsert(remote())
    const l = link(pid, 'mcpl_h')
    svc.upsert({ projectId: pid, spec: { ...l, headerOverrides: { 'X-Tenant': 'acme' } } })
    const copy = svc.copyFromLibrary({ projectId: pid, serverId: l.id, copySecrets: false }).project.mcpServers![0]
    expect(copy.headers).toEqual({ 'X-Tenant': 'acme' })
    expect(copy.url).toBe('https://remote.test/mcp')
  })

  it('refuses a project-only server, a missing entry, a built server and an unknown server', () => {
    projects.save({ ...projects.get(pid)!, mcpServers: [projectOnly()] })
    expect(() => svc.copyFromLibrary({ projectId: pid, serverId: 'mcp-own', copySecrets: false })).toThrow('own is already project-only.')
    expect(() => svc.copyFromLibrary({ projectId: pid, serverId: 'nope', copySecrets: false })).toThrow(/not found/)
    svc.libraryUpsert(vendor())
    const l = link(pid2, 'mcpl_s')
    library.remove('mcpl_s')
    expect(() => svc.copyFromLibrary({ projectId: pid2, serverId: l.id, copySecrets: false })).toThrow('vendor was removed from your MCP library.')
    library.save({ ...vendor(), buildDigest: 'a'.repeat(64) })
    expect(() => svc.copyFromLibrary({ projectId: pid2, serverId: l.id, copySecrets: false })).toThrow(/is a built server; its files live with the library entry, so it cannot be copied\./)
    expect(projects.get(pid2)!.mcpServers![0].id).toBe(l.id)
  })

  it('rolls back the new keys when the project save fails and keeps the old ones', () => {
    svc.libraryUpsert(vendor())
    const l = link(pid, 'mcpl_s')
    svc.setSecret({ projectId: pid, serverId: l.id, kind: 'env', name: 'VENDOR_KEY', value: 'PROJ' })
    const before = secrets.keys('mcp:')
    vi.spyOn(projects, 'save').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => svc.copyFromLibrary({ projectId: pid, serverId: l.id, copySecrets: true })).toThrow('disk full')
    expect(secrets.keys('mcp:')).toEqual(before)
    expect(projects.get(pid)!.mcpServers![0].id).toBe(l.id)
    expect(secrets.get(mcpSecretKey(pid, l.id, 'env', 'VENDOR_KEY'))).toBe('PROJ')
  })

  it('checks the copy against the other servers (a name clash is refused before anything is written)', () => {
    svc.libraryUpsert(vendor())
    const l = link(pid, 'mcpl_s')
    projects.save({ ...projects.get(pid)!, mcpServers: [...projects.get(pid)!.mcpServers!, projectOnly({ id: 'mcp-x', name: 'vendor' })] })
    const before = secrets.keys('mcp:')
    expect(() => svc.copyFromLibrary({ projectId: pid, serverId: l.id, copySecrets: true })).toThrow(/already exists/)
    expect(secrets.keys('mcp:')).toEqual(before)
  })
})

describe('store normalization', () => {
  it('drops junk per-project fields on read and keeps valid ones', () => {
    library.save({
      ...vendor({ id: 'mcpl_j1', name: 'j1' }),
      perProjectSecrets: 'yes' as unknown as true,
      perProjectEnv: [1] as unknown as string[],
      connectorCustom: true as const
    })
    library.save({ ...vendor({ id: 'mcpl_j2', name: 'j2' }), perProjectEnv: Array.from({ length: 21 }, (_, i) => `N${i}`) })
    library.save({ ...vendor({ id: 'mcpl_ok', name: 'ok' }), connectorId: 'my-vendor', connectorCustom: true })
    const again = new McpLibraryStore(join(dir, 'data'))
    const j1 = again.get('mcpl_j1')!
    for (const k of ['perProjectSecrets', 'perProjectEnv', 'connectorCustom']) expect(j1, k).not.toHaveProperty(k)
    expect(again.get('mcpl_j2')).not.toHaveProperty('perProjectEnv')
    expect(again.get('mcpl_j2')!.perProjectSecrets).toBe(true)
    // Connector entries (custom included) never carry per-project fields: validate refuses them, so a read drops them.
    expect(again.get('mcpl_ok')).toMatchObject({ connectorCustom: true })
    for (const k of ['perProjectSecrets', 'perProjectEnv']) expect(again.get('mcpl_ok'), k).not.toHaveProperty(k)
  })
})
