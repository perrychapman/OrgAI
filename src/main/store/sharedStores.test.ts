// The config stores on a data folder several orgai sessions share (docs/design/cli-sessions.md): each keeps its file
// in memory and rewrites it whole, so every case here starts with two sessions that both loaded the file and then has
// each of them save something. Without the write lock and the re-read, the second save would undo the first.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpLibraryEntry, Project, SkillLibraryEntry } from '@shared/types'
import { newProject } from '@shared/defaults'
import { SessionBusyError, registerSession, type SessionHandle } from '../host/sessions'
import { McpLibraryStore } from './mcpLibrary'
import { retainRunProject, readRetainedRunProjects } from './projectData'
import { ProjectStore } from './projects'
import { SecretStore } from './secrets'
import { SettingsStore, changedFields } from './settings'
import { SkillLibraryStore } from './skillLibrary'
import { createSharedStoreSync, enableStoreSync, fileStamp, storeSyncFor, SOLO, type StoreSync } from './shared/storeSync'
import { fakeCustody, noCipher } from './vaultTesting'

let root: string
let dataDir: string
const handles: SessionHandle[] = []
const syncs: { close(): void }[] = []

const A = 'aaaaaaaaaaaa'
const B = 'bbbbbbbbbbbb'

function session(id: string): { handle: SessionHandle; sync: StoreSync } {
  const handle = registerSession(dataDir, { hostInstanceId: id, pid: process.pid, startedAt: Date.now(), appVersion: 't', cwd: `/work/${id}`, command: 'tui' })
  handles.push(handle)
  const sync = createSharedStoreSync(handle, { checkMs: 0, liveForMs: 0 })
  syncs.push(sync)
  return { handle, sync }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-shared-stores-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
})
afterEach(() => {
  for (const s of syncs.splice(0)) s.close()
  for (const h of handles.splice(0)) h.release()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const project = (id: string, name: string): Project => ({ ...newProject({ name, path: join(root, name), brief: '' }), id })
const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(dataDir, file), 'utf8')) as Record<string, unknown>

describe('ProjectStore, two sessions', () => {
  it('each saves its own project and neither drops the other\'s', () => {
    const a = new ProjectStore(dataDir, { sync: session(A).sync, home: root })
    const b = new ProjectStore(dataDir, { sync: session(B).sync, home: root })
    a.save(project('proj_a', 'Alpha'))
    b.save(project('proj_b', 'Beta'))
    a.save({ ...(a.get('proj_a') as Project), brief: 'alpha again' })
    expect((read('projects.json').projects as Project[]).map((p) => p.id).sort()).toEqual(['proj_a', 'proj_b'])
    // Each sees what the other saved, without a restart.
    expect(a.get('proj_b')?.name).toBe('Beta')
    expect(b.get('proj_a')?.brief).toBe('alpha again')
    expect(b.list().map((p) => p.id).sort()).toEqual(['proj_a', 'proj_b'])
  })

  it('update() works on what is stored now, not on what this session last saw', () => {
    const a = new ProjectStore(dataDir, { sync: session(A).sync, home: root })
    const b = new ProjectStore(dataDir, { sync: session(B).sync, home: root })
    a.save(project('proj_a', 'Alpha'))
    expect(b.get('proj_a')?.name).toBe('Alpha')
    a.update('proj_a', (p) => ({ ...p, brief: 'set by a' }))
    // b read the project before a's update; its own update must still keep a's field.
    const saved = b.update('proj_a', (p) => ({ ...p, name: 'Alpha renamed by b' }))
    expect(saved).toMatchObject({ name: 'Alpha renamed by b', brief: 'set by a' })
    expect(a.get('proj_a')).toMatchObject({ name: 'Alpha renamed by b', brief: 'set by a' })
  })

  it('remove takes only that project, and a re-read that fails keeps the list instead of saving an empty one', () => {
    const a = new ProjectStore(dataDir, { sync: session(A).sync, home: root })
    const b = new ProjectStore(dataDir, { sync: session(B).sync, home: root })
    a.save(project('proj_a', 'Alpha'))
    b.save(project('proj_b', 'Beta'))
    a.remove('proj_a')
    expect(b.list().map((p) => p.id)).toEqual(['proj_b'])
    writeFileSync(join(dataDir, 'projects.json'), '{ damaged')
    expect(b.list().map((p) => p.id)).toEqual(['proj_b'])
    b.save(project('proj_c', 'Gamma'))
    expect((read('projects.json').projects as Project[]).map((p) => p.id).sort()).toEqual(['proj_b', 'proj_c'])
  })
})

describe('SettingsStore, two sessions', () => {
  it('a save that meets a newer file keeps the fields this caller did not change', () => {
    const a = new SettingsStore(dataDir, { sync: session(A).sync })
    const b = new SettingsStore(dataDir, { sync: session(B).sync })
    // Both hold the same settings. Each changes one field and sends the whole object back, as settings:set does.
    const fromA = { ...a.get(), defaultMaxBudgetUsd: 7 }
    const fromB = { ...b.get(), displayName: 'Ada' }
    a.set(fromA)
    b.set(fromB)
    expect(b.get()).toMatchObject({ defaultMaxBudgetUsd: 7, displayName: 'Ada' })
    expect(a.get()).toMatchObject({ defaultMaxBudgetUsd: 7, displayName: 'Ada' })
    expect((read('settings.json').settings as Record<string, unknown>)).toMatchObject({ defaultMaxBudgetUsd: 7, displayName: 'Ada' })
  })

  it('tells its listeners when another session saved, once, with the new settings', () => {
    const a = new SettingsStore(dataDir, { sync: session(A).sync })
    const b = new SettingsStore(dataDir, { sync: session(B).sync })
    const heard: (string | undefined)[] = []
    b.onChange((s) => heard.push(s.displayName))
    a.set({ ...a.get(), displayName: 'Grace' })
    expect(heard).toEqual([])
    expect(b.get().displayName).toBe('Grace')
    expect(b.get().displayName).toBe('Grace')
    expect(heard).toEqual(['Grace'])
  })

  it('changedFields compares deeply and reports only what differs', () => {
    const base = new SettingsStore(dataDir).get()
    expect(changedFields(base, structuredClone(base))).toEqual({})
    expect(changedFields(base, { ...base, displayName: 'x', appearance: { ...base.appearance } })).toEqual({ displayName: 'x' })
  })
})

describe('library stores, two sessions', () => {
  it('skill and MCP library entries added by each session all stay', () => {
    const sa = session(A).sync
    const sb = session(B).sync
    const skillsA = new SkillLibraryStore(dataDir, { sync: sa })
    const skillsB = new SkillLibraryStore(dataDir, { sync: sb })
    skillsA.save({ id: 'sk_a', name: 'from a' } as SkillLibraryEntry)
    skillsB.save({ id: 'sk_b', name: 'from b' } as SkillLibraryEntry)
    expect(skillsA.list().map((e) => e.id)).toEqual(['sk_a', 'sk_b'])
    expect(skillsB.remove('sk_a')).toBe(true)
    expect(skillsA.get('sk_a')).toBeUndefined()

    const mcpA = new McpLibraryStore(dataDir, { sync: sa })
    const mcpB = new McpLibraryStore(dataDir, { sync: sb })
    mcpA.save({ id: 'm_a', name: 'a', transport: 'stdio', command: 'x' } as McpLibraryEntry)
    mcpB.save({ id: 'm_b', name: 'b', transport: 'stdio', command: 'y' } as McpLibraryEntry)
    expect((read('mcp-library.json').entries as { id: string }[]).map((e) => e.id)).toEqual(['m_a', 'm_b'])
  })

  it('retainRunProject from two sessions keeps both ids (installed sync, as the host installs it)', () => {
    const a = session(A)
    const off = enableStoreSync(dataDir, a.sync)
    try {
      expect(storeSyncFor(dataDir)).toBe(a.sync)
      retainRunProject(dataDir, 'proj_1')
      retainRunProject(dataDir, 'proj_2')
      expect([...readRetainedRunProjects(dataDir)].sort()).toEqual(['proj_1', 'proj_2'])
    } finally {
      off()
    }
    expect(storeSyncFor(dataDir)).toBe(SOLO)
  })
})

describe('SecretStore, two sessions', () => {
  const store = (sync: StoreSync, custody = fakeCustody()): SecretStore => new SecretStore(dataDir, noCipher, { hostKind: 'inproc', product: 'cli', custodian: custody.factory, sync })

  it('a value one session stores is kept when the other stores another, and each reads the other\'s', async () => {
    const custody = fakeCustody()
    const a = store(session(A).sync, custody)
    await a.prepareWrite()
    a.set('k.a', 'from a')
    // b starts with the vault already there and opens it with the same key store.
    const b = store(session(B).sync, custody)
    await b.openVault()
    expect(b.get('k.a')).toBe('from a')
    // Both hold the vault in memory. Each stores a different key; a write of a stale copy would drop the other's.
    a.set('k.a2', 'second from a')
    b.set('k.b', 'from b')
    a.set('k.a3', 'third from a')
    expect([a.get('k.a'), a.get('k.a2'), a.get('k.a3'), a.get('k.b')]).toEqual(['from a', 'second from a', 'third from a', 'from b'])
    expect([b.get('k.a'), b.get('k.a2'), b.get('k.a3'), b.get('k.b')]).toEqual(['from a', 'second from a', 'third from a', 'from b'])
    b.delete('k.a2')
    expect(a.get('k.a2')).toBeUndefined()
    expect(a.keys('k.').sort()).toEqual(['k.a', 'k.a3', 'k.b'])
  })

  it('a session that started before the vault existed can read it once another one created it', async () => {
    const custody = fakeCustody()
    const a = store(session(A).sync, custody)
    const b = store(session(B).sync, custody)
    expect(b.state()).toBe('absent')
    await a.prepareWrite()
    a.set('k.a', 'from a')
    // b notices the new file, and opens the vault in the background with the key store.
    expect(b.get('k.a')).toBeUndefined()
    await b.prepareWrite()
    expect(b.state()).toBe('open')
    expect(b.get('k.a')).toBe('from a')
    // Only one vault was ever created.
    expect(custody.calls.create).toBe(1)
    expect(custody.items.size).toBe(1)
  })

  it('two sessions creating the vault at the same moment end with one vault that both can use', async () => {
    const custody = fakeCustody()
    const a = store(session(A).sync, custody)
    const b = store(session(B).sync, custody)
    // Both see no vault and both ask the key store for a key; the creations are held so that neither has written yet.
    custody.hold()
    const pa = a.prepareWrite()
    const pb = b.prepareWrite()
    await new Promise((r) => setTimeout(r, 20))
    custody.release()
    const results = await Promise.allSettled([pa, pb])
    // At least one created it. The other either opened that vault or was told to try again; it never wrote over it.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true)
    await a.prepareWrite().catch(() => undefined)
    await b.prepareWrite().catch(() => undefined)
    await a.prepareWrite()
    await b.prepareWrite()
    expect([a.state(), b.state()]).toEqual(['open', 'open'])
    a.set('k.a', 'from a')
    b.set('k.b', 'from b')
    expect([a.get('k.b'), b.get('k.a')]).toEqual(['from b', 'from a'])
    const vaultId = (read('vault.json') as { vaultId: string }).vaultId
    expect(custody.items.has(vaultId)).toBe(true)
  })

  it('init and reset are refused while another session runs, and allowed once it is gone', async () => {
    const custody = fakeCustody()
    const sa = session(A)
    const sb = session(B)
    const a = store(sa.sync, custody)
    await a.prepareWrite()
    a.set('k.a', 'from a')
    await expect(a.resetVault({ confirm: true })).rejects.toThrow(SessionBusyError)
    await expect(a.initVault({})).rejects.toThrow(/another one is running \(\/work\/bbbbbbbbbbbb, pid \d+\)\. Quit it first\./)
    expect(a.get('k.a')).toBe('from a')
    sb.handle.release()
    await expect(a.resetVault({ confirm: true })).resolves.toBeDefined()
  })
})

describe('fileStamp', () => {
  it('is "missing" for no file and differs after a replace of the same size (the inode changes with a rename)', () => {
    const file = join(dataDir, 'x.json')
    expect(fileStamp(file)).toBe('missing')
    writeFileSync(file, 'aaaa')
    const first = fileStamp(file)
    expect(fileStamp(file)).toBe(first)
    // What every store does: write a temp file beside it and rename it over the target.
    writeFileSync(`${file}.tmp`, 'bbbb')
    renameSync(`${file}.tmp`, file)
    expect(fileStamp(file)).not.toBe(first)
  })
})
