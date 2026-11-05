import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KIT_MAX_BYTES } from '@shared/types'
import type { KitImportPreview, McpLibraryEntry, UserConnectorDef } from '@shared/types'
import { McpLibraryStore } from '../store/mcpLibrary'
import { ProjectStore } from '../store/projects'
import { SecretStore } from '../store/secrets'
import { McpService } from '../mcp/service'
import { SkillService } from '../skills/service'
import { TemplateService } from '../setup/templates'
import { KitService, STALE_TARGET_MESSAGE, applyArgs, applyBundleArgs, decodeKitBytes, exportBundleArgs, kitBundleFileName, previewBundleArgs } from './service'

const FIXTURE = join(__dirname, '..', 'skills', 'fixtures', 'pdf')
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (b: Buffer) => b.toString().slice(4)
}

const dirs: string[] = []
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-kitbundle-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function world() {
  const dir = temp()
  const data = join(dir, 'data')
  const projects = new ProjectStore(data)
  const secrets = new SecretStore(data, cipher)
  const mcp = new McpService({ projects, secrets, library: new McpLibraryStore(data), dataDir: data })
  const skills = new SkillService({ dataDir: data, projects })
  const templates = new TemplateService({
    dataDir: data,
    projects,
    modelContext: () => {
      throw new Error('not used')
    }
  })
  const kit = new KitService({ appVersion: '9.9.9', platform: 'test', skills, mcp, templates, now: () => new Date('2026-11-04T10:00:00Z') })
  return { dir, projects, secrets, mcp, skills, templates, kit }
}
type World = ReturnType<typeof world>

const stdio = (name: string, over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
  id: `id-${name}`,
  name,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', `@x/${name}@1.4.2`],
  env: { REGION: 'eu' },
  secretEnv: ['API_TOKEN'],
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

const preset = (id: string, over: Partial<UserConnectorDef> = {}): UserConnectorDef => ({
  id,
  name: `Preset ${id}`,
  vendor: 'Acme',
  publisher: 'user',
  category: 'dev',
  description: 'An internal tool.',
  variants: [{ id: 'main', label: 'Main', transport: 'http', url: 'https://acme.test/mcp', readOnly: false, auth: { kind: 'token', header: 'X-Acme-Key', label: 'Acme key', help: '' } }],
  defaultVariant: 'main',
  verified: false,
  ...over
})

function populate(w: World): void {
  w.skills.libraryAddFromFolder({ path: FIXTURE })
  w.mcp.libraryUpsert(stdio('github'))
  w.mcp.libraryUpsert(stdio('docs', { secretEnv: [] }))
  w.mcp.connectorPresetsUpsert(preset('acme-tool'))
  mkdirSync(join(w.dir, 'repo'), { recursive: true })
  const p = w.projects.create({ name: 'Client Alpha', path: join(w.dir, 'repo'), brief: '' })
  w.templates.saveFromProject({ projectId: p.id, name: 'Starter', description: 'A starter team' })
}

const ALL = { skills: 'all', mcpServers: 'all', connectorPresets: 'all', templates: 'all' } as const
const choicesOf = (p: KitImportPreview) => p.items.map((i) => ({ key: i.key, action: i.action }))

/** The library state a test compares before and after a refused apply. */
function snapshot(w: World): string {
  return JSON.stringify({
    skills: w.skills.libraryList().map((i) => i.entry),
    servers: w.mcp.libraryEntries(),
    presets: w.mcp.connectorPresetsList(),
    templates: w.templates.list()
  })
}

function exported(): { bundle: ReturnType<KitService['exportBundle']>; source: World } {
  const source = world()
  populate(source)
  return { bundle: source.kit.exportBundle({ include: { ...ALL } }), source }
}

describe('kit bundles', () => {
  it('exportBundle -> previewBundle -> applyBundle round-trips like the file path', async () => {
    const { bundle, source } = exported()
    expect(bundle.fileName).toBe('orgai-kit-2026-11-04.orgai-kit.json')
    expect(bundle.counts).toEqual({ skills: 1, mcpServers: 2, connectorPresets: 1, templates: 1 })
    expect(bundle.notes.join(' ')).toMatch(/Secret values are not included/)
    const bytes = Buffer.from(bundle.rawBytesBase64, 'base64')
    expect(bundle.bytes).toBe(bytes.length)

    // The same content as the file export (exportedAt comes from the fixed clock).
    const file = join(source.dir, 'k.orgai-kit.json')
    const fileOut = source.kit.export({ path: file, include: { ...ALL } })
    expect(readFileSync(file).equals(bytes)).toBe(true)
    expect(fileOut.notes).toEqual(bundle.notes)

    const viaBundle = world()
    const preview = viaBundle.kit.previewBundle({ fileName: bundle.fileName, rawBytesBase64: bundle.rawBytesBase64 })
    expect(preview.path).toBe('')
    expect(preview.fileName).toBe(bundle.fileName)
    expect(preview.targetDigest).toMatch(/^[0-9a-f]{64}$/)
    const result = await viaBundle.kit.applyBundle({ rawBytesBase64: bundle.rawBytesBase64, digest: preview.digest, targetDigest: preview.targetDigest!, choices: choicesOf(preview) })

    const viaFile = world()
    const filePreview = viaFile.kit.previewImport({ path: file })
    expect(filePreview.targetDigest).toBe(preview.targetDigest)
    expect({ ...filePreview, path: '', fileName: '' }).toEqual({ ...preview, path: '', fileName: '' })
    const fileResult = viaFile.kit.applyImport({ path: file, digest: filePreview.digest, choices: choicesOf(filePreview) })
    expect(result).toEqual(fileResult)
    expect(result.added).toBe(5)

    const names = (w: World) => ({
      skills: w.skills.libraryList().map((i) => i.entry.name),
      servers: w.mcp.libraryEntries().map((e) => e.name).sort(),
      presets: w.mcp.connectorPresetsList().map((p) => p.id),
      templates: w.templates.list().map((t) => t.name)
    })
    expect(names(viaBundle)).toEqual({ skills: ['pdf'], servers: ['docs', 'github'], presets: ['acme-tool'], templates: ['Starter'] })
    expect(names(viaBundle)).toEqual(names(viaFile))
  })

  it('a tampered byte gives a stale digest', async () => {
    const { bundle } = exported()
    const w = world()
    const preview = w.kit.previewBundle({ fileName: 'k', rawBytesBase64: bundle.rawBytesBase64 })
    const bytes = Buffer.from(bundle.rawBytesBase64, 'base64')
    const i = bytes.indexOf('Starter')
    bytes[i] = 'X'.charCodeAt(0)
    const before = snapshot(w)
    await expect(w.kit.applyBundle({ rawBytesBase64: bytes.toString('base64'), digest: preview.digest, targetDigest: preview.targetDigest!, choices: choicesOf(preview) })).rejects.toThrow(
      'The kit file changed since the preview. Preview it again.'
    )
    expect(snapshot(w)).toBe(before)
  })

  it('refuses with stale_target_digest when the destination changed, before any write', async () => {
    const { bundle } = exported()
    const cases: [string, (w: World) => void][] = [
      ['a same-name skill was added', (w) => w.skills.libraryCreate({ name: 'pdf', description: 'Use for pdf work.', body: 'Mine.' })],
      ['a same-name server was added', (w) => w.mcp.libraryUpsert(stdio('github', { id: 'id-mine', args: ['-y', '@x/other@2.0.0'] }))],
      ['a same-id preset was added', (w) => w.mcp.connectorPresetsUpsert(preset('acme-tool', { description: 'Mine.' }))]
    ]
    for (const [label, change] of cases) {
      const w = world()
      const preview = w.kit.previewBundle({ fileName: 'k', rawBytesBase64: bundle.rawBytesBase64 })
      change(w)
      const before = snapshot(w)
      const err = await w.kit.applyBundle({ rawBytesBase64: bundle.rawBytesBase64, digest: preview.digest, targetDigest: preview.targetDigest!, choices: choicesOf(preview) }).catch((e: unknown) => e)
      expect(err, label).toBeInstanceOf(Error)
      expect((err as Error & { code?: string }).code, label).toBe('stale_target_digest')
      expect((err as Error).message).toBe(STALE_TARGET_MESSAGE)
      expect(snapshot(w), label).toBe(before)
    }
  })

  it('refuses when a skill or server an item would replace changed since the preview', async () => {
    const { bundle } = exported()
    const w = world()
    w.skills.libraryCreate({ name: 'pdf', description: 'Use for pdf work.', body: 'Mine.' })
    w.mcp.libraryUpsert(stdio('github', { args: ['-y', '@x/other@2.0.0'] }))
    const preview = w.kit.previewBundle({ fileName: 'k', rawBytesBase64: bundle.rawBytesBase64 })
    const replace = preview.items.map((i) => ({ key: i.key, action: i.status === 'different' ? ('replace' as const) : i.action }))
    expect(preview.items.filter((i) => i.status === 'different').map((i) => i.name).sort()).toEqual(['github', 'pdf'])

    const skillId = w.skills.libraryList()[0].entry.id
    w.skills.libraryUpdate({ libraryId: skillId, draft: { name: 'pdf', description: 'Use for pdf work.', body: 'Mine, edited.' } })
    let before = snapshot(w)
    let err = (await w.kit.applyBundle({ rawBytesBase64: bundle.rawBytesBase64, digest: preview.digest, targetDigest: preview.targetDigest!, choices: replace }).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('stale_target_digest')
    expect(snapshot(w)).toBe(before)

    const again = w.kit.previewBundle({ fileName: 'k', rawBytesBase64: bundle.rawBytesBase64 })
    const github = w.mcp.libraryEntries().find((e) => e.name === 'github')!
    w.mcp.libraryUpsert({ ...github, args: ['-y', '@x/other@3.0.0'] })
    before = snapshot(w)
    err = (await w.kit.applyBundle({ rawBytesBase64: bundle.rawBytesBase64, digest: again.digest, targetDigest: again.targetDigest!, choices: replace }).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('stale_target_digest')
    expect(snapshot(w)).toBe(before)

    // A fresh preview applies.
    const fresh = w.kit.previewBundle({ fileName: 'k', rawBytesBase64: bundle.rawBytesBase64 })
    const ok = await w.kit.applyBundle({ rawBytesBase64: bundle.rawBytesBase64, digest: fresh.digest, targetDigest: fresh.targetDigest!, choices: replace })
    expect(ok.replaced).toBe(2)
  })

  it('refuses a replace when a secret value or sign-in was saved on the server after the preview (review Low)', async () => {
    const { bundle } = exported()
    const w = world()
    w.mcp.libraryUpsert(stdio('github', { args: ['-y', '@x/other@2.0.0'] }))
    const preview = w.kit.previewBundle({ fileName: 'k', rawBytesBase64: bundle.rawBytesBase64 })
    const replace = preview.items.map((i) => ({ key: i.key, action: i.name === 'github' ? ('replace' as const) : ('skip' as const) }))
    const github = w.mcp.libraryEntries().find((e) => e.name === 'github')!
    // The user saves the server's token between the preview and the apply.
    w.mcp.librarySetSecret({ libraryId: github.id, kind: 'env', name: 'API_TOKEN', value: 'tok-123' })
    const before = snapshot(w)
    const err = (await w.kit.applyBundle({ rawBytesBase64: bundle.rawBytesBase64, digest: preview.digest, targetDigest: preview.targetDigest!, choices: replace }).catch((e: unknown) => e)) as Error & { code?: string }
    expect(err.code).toBe('stale_target_digest')
    expect(snapshot(w)).toBe(before)
    expect(w.mcp.libraryList().find((i) => i.entry.id === github.id)?.envSet).toEqual(['API_TOKEN'])
    // The digest never carries the value itself.
    const fresh = w.kit.previewBundle({ fileName: 'k', rawBytesBase64: bundle.rawBytesBase64 })
    expect(JSON.stringify(fresh)).not.toContain('tok-123')
    expect(fresh.targetDigest).not.toBe(preview.targetDigest)
    // A fresh preview (which sees the stored token) applies; the replace then clears it as its note says.
    const ok = await w.kit.applyBundle({ rawBytesBase64: bundle.rawBytesBase64, digest: fresh.digest, targetDigest: fresh.targetDigest!, choices: replace })
    expect(ok.replaced).toBe(1)
  })

  it('serializes concurrent applyBundle calls: the second sees the first and goes stale', async () => {
    const { bundle } = exported()
    const w = world()
    const preview = w.kit.previewBundle({ fileName: 'k', rawBytesBase64: bundle.rawBytesBase64 })
    const input = { rawBytesBase64: bundle.rawBytesBase64, digest: preview.digest, targetDigest: preview.targetDigest!, choices: choicesOf(preview) }
    const [a, b] = await Promise.allSettled([w.kit.applyBundle(input), w.kit.applyBundle(input)])
    expect(a.status).toBe('fulfilled')
    expect(a.status === 'fulfilled' && a.value.added).toBe(5)
    expect(b.status).toBe('rejected')
    expect(b.status === 'rejected' && (b.reason as { code?: string }).code).toBe('stale_target_digest')
    expect(w.skills.libraryList()).toHaveLength(1)
    // A preview after both sees everything as the same.
    const after = w.kit.previewBundle({ fileName: 'k', rawBytesBase64: bundle.rawBytesBase64 })
    expect(after.items.every((i) => i.status === 'same')).toBe(true)
    // The chain keeps working after a rejection.
    const noop = await w.kit.applyBundle({ ...input, targetDigest: after.targetDigest! })
    expect(noop).toMatchObject({ added: 0, skipped: 5 })
  })

  it('refuses an oversized or invalid base64 before decoding', () => {
    const w = world()
    const huge = 'A'.repeat(Math.ceil(KIT_MAX_BYTES / 3) * 4 + 4)
    expect(() => w.kit.previewBundle({ fileName: 'k', rawBytesBase64: huge })).toThrow(/larger than 50 MB/)
    expect(() => decodeKitBytes(huge)).toThrow(/larger than 50 MB/)
    expect(() => previewBundleArgs({ fileName: 'k', rawBytesBase64: huge })).toThrow(/larger than 50 MB/)
    expect(() => w.kit.previewBundle({ fileName: 'k', rawBytesBase64: 'ab$c' })).toThrow(/base64/)
    expect(() => w.kit.previewBundle({ fileName: 'k', rawBytesBase64: 'abc' })).toThrow(/base64/)
  })

  it('previewImport / applyImport on a file still work with and without targetDigest', () => {
    const { bundle } = exported()
    const w = world()
    const file = join(w.dir, 'k.orgai-kit.json')
    writeFileSync(file, Buffer.from(bundle.rawBytesBase64, 'base64'))
    const preview = w.kit.previewImport({ path: file })
    expect(preview.path).toBe(file)
    expect(preview.fileName).toBe('k.orgai-kit.json')
    const pick = (name: string) => [{ key: preview.items.find((i) => i.name === name)!.key, action: 'add' as const }]
    // Without targetDigest: the old contract, applied.
    expect(w.kit.applyImport({ path: file, digest: preview.digest, choices: pick('docs') }).added).toBe(1)
    // With the now-stale targetDigest: refused, nothing written.
    const before = snapshot(w)
    let code: string | undefined
    try {
      w.kit.applyImport({ path: file, digest: preview.digest, targetDigest: preview.targetDigest, choices: pick('github') })
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(code).toBe('stale_target_digest')
    expect(snapshot(w)).toBe(before)
    // With a fresh one: applied.
    const fresh = w.kit.previewImport({ path: file })
    const freshPick = [{ key: fresh.items.find((i) => i.name === 'github')!.key, action: 'add' as const }]
    expect(w.kit.applyImport({ path: file, digest: fresh.digest, targetDigest: fresh.targetDigest, choices: freshPick }).added).toBe(1)
  })
})

describe('bundle input rebuilders', () => {
  const digest = 'a'.repeat(64)
  it('exportBundleArgs keeps include and fileName only', () => {
    expect(exportBundleArgs({ include: { skills: 'all', junk: 1 }, fileName: 'x', path: '/etc/passwd' })).toEqual({ include: { skills: 'all' }, fileName: 'x' })
    expect(exportBundleArgs({ include: {} })).toEqual({ include: {} })
    expect(() => exportBundleArgs({ include: 'all' })).toThrow()
    expect(() => exportBundleArgs({ include: {}, fileName: 3 })).toThrow()
  })
  it('previewBundleArgs and applyBundleArgs rebuild and validate', () => {
    expect(previewBundleArgs({ fileName: 'k', rawBytesBase64: 'eA==', path: '/x' })).toEqual({ fileName: 'k', rawBytesBase64: 'eA==' })
    expect(() => previewBundleArgs({ fileName: 'k' })).toThrow()
    expect(applyBundleArgs({ rawBytesBase64: 'eA==', digest, targetDigest: digest, choices: [{ key: 'skill:0', action: 'add', x: 1 }, { key: 'skill:0', action: 'skip' }], path: '/x' })).toEqual({
      rawBytesBase64: 'eA==',
      digest,
      targetDigest: digest,
      choices: [{ key: 'skill:0', action: 'add' }]
    })
    expect(() => applyBundleArgs({ rawBytesBase64: 'eA==', digest: 'nope', targetDigest: digest, choices: [] })).toThrow(/changed since the preview/)
    const noTarget = (() => {
      try {
        applyBundleArgs({ rawBytesBase64: 'eA==', digest, choices: [] })
      } catch (e) {
        return e as Error & { code?: string }
      }
    })()
    expect(noTarget?.code).toBe('stale_target_digest')
    expect(() => applyBundleArgs({ rawBytesBase64: 'eA==', digest, targetDigest: digest, choices: Array.from({ length: 501 }, () => ({ key: 'skill:0', action: 'add' })) })).toThrow()
    expect(() => applyBundleArgs({ rawBytesBase64: 'eA==', digest, targetDigest: digest, choices: [{ key: 'bad', action: 'add' }] })).toThrow()
  })
  it('applyArgs passes an optional targetDigest through', () => {
    expect(applyArgs({ path: '/k', digest, choices: [] })).toEqual({ path: '/k', digest, choices: [] })
    expect(applyArgs({ path: '/k', digest, choices: [], targetDigest: digest })).toEqual({ path: '/k', digest, choices: [], targetDigest: digest })
    expect(() => applyArgs({ path: '/k', digest, choices: [], targetDigest: 'x' })).toThrow(STALE_TARGET_MESSAGE)
  })
  it('kitBundleFileName cleans names', () => {
    const now = new Date('2026-11-04T10:00:00Z')
    expect(kitBundleFileName(undefined, now)).toBe('orgai-kit-2026-11-04.orgai-kit.json')
    expect(kitBundleFileName('../../etc/team kit.json', now)).toBe('team kit.orgai-kit.json')
    expect(kitBundleFileName('My kit.orgai-kit.json', now)).toBe('My kit.orgai-kit.json')
    expect(kitBundleFileName('..', now)).toBe('orgai-kit-2026-11-04.orgai-kit.json')
    expect(kitBundleFileName('a<b>:c', now)).toBe('a-b-c.orgai-kit.json')
    const long = kitBundleFileName('x'.repeat(500), now)
    expect(long.length).toBe(120)
    expect(long.endsWith('.orgai-kit.json')).toBe(true)
  })
})
