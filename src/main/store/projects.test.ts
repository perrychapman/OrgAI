import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServerSpec, PluginSpec, Project } from '@shared/types'
import { project, role } from '../runtime/testHelpers'
import { ProjectStore, checkProjectPath, cleanProjectPath, createPathError, suggestedProjectName, type PathFs } from './projects'
import { mkdirSync } from 'node:fs'

const dirs: string[] = []
function dataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-projects-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const server = { id: 'mcp1', name: 'github' } as McpServerSpec
const plugin = { id: 'pl1' } as PluginSpec

describe('ProjectStore.saveFromRenderer', () => {
  it('keeps the stored mcpServers and plugins over a stale renderer copy', () => {
    const store = new ProjectStore(dataDir())
    store.save(project({ mcpServers: [server], plugins: [plugin] }))
    const saved = store.saveFromRenderer(project({ name: 'Renamed', mcpServers: [], plugins: undefined }))
    expect(saved.name).toBe('Renamed')
    expect(saved.mcpServers).toEqual([server])
    expect(saved.plugins).toEqual([plugin])
    expect(store.get('p1')?.mcpServers).toEqual([server])
  })

  it('does not invent mcpServers the store does not have', () => {
    const store = new ProjectStore(dataDir())
    store.save(project())
    const saved = store.saveFromRenderer(project({ mcpServers: [server] }))
    expect(saved.mcpServers).toBeUndefined()
  })

  it('refuses unknown ids, unsafe ids and the harness id', () => {
    const store = new ProjectStore(dataDir())
    expect(() => store.saveFromRenderer(project({ id: 'new', mcpServers: [server] }))).toThrow('Project not found')
    expect(store.get('new')).toBeFalsy()
    expect(() => store.saveFromRenderer(project({ id: '../x' }))).toThrow('Invalid project id')
    expect(() => store.saveFromRenderer(project({ id: 'harness' }))).toThrow(/harness/)
  })
})

describe('ProjectStore.update', () => {
  it('applies fn to a copy and saves', () => {
    const store = new ProjectStore(dataDir())
    store.save(project())
    const out = store.update('p1', (p) => ({ ...p, name: 'X' }))
    expect(out.name).toBe('X')
    expect(store.get('p1')?.name).toBe('X')
    expect(() => store.update('nope', (p) => p)).toThrow('Project not found')
  })
})

describe('ProjectStore migration', () => {
  it('migrates old projects on load and persists the result once', () => {
    const dir = dataDir()
    const old = project({
      provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' } },
      roles: [role({ id: 'a', slug: 'a', model: 'opus' })]
    })
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, projects: [old] }))
    const store = new ProjectStore(dir)
    const p = store.get('p1')!
    expect(p.provider.connection).toBe('anthropic')
    expect(p.roles[0].tier).toBe('deep')
    expect(JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')).projects[0].roles[0].tier).toBe('deep')
    expect(new ProjectStore(dir).migrateAll()).toBe(0)
  })
})

describe('checkProjectPath', () => {
  it('reports a missing, empty or bad path without throwing', () => {
    const none = { exists: false, isDirectory: false, isGitRepo: false, empty: false }
    expect(checkProjectPath('')).toEqual({ ...none, suggestedName: '' })
    expect(checkProjectPath(undefined)).toEqual({ ...none, suggestedName: '' })
    expect(checkProjectPath(join(dataDir(), 'nope', 'my-app'))).toEqual({ ...none, suggestedName: 'my-app' })
    const throwing: PathFs = {
      statSync: () => {
        throw new Error('EACCES')
      },
      existsSync: () => false,
      readdirSync: () => []
    }
    expect(checkProjectPath('/x/y', throwing)).toEqual({ ...none, suggestedName: 'y' })
  })

  it('tells files, empty folders and repositories apart', () => {
    const d = dataDir()
    const file = join(d, 'notes.txt')
    writeFileSync(file, 'x')
    expect(checkProjectPath(file)).toMatchObject({ exists: true, isDirectory: false, empty: false, suggestedName: 'notes.txt' })
    const empty = join(d, 'empty')
    mkdirSync(empty)
    expect(checkProjectPath(empty)).toEqual({ exists: true, isDirectory: true, isGitRepo: false, empty: true, suggestedName: 'empty' })
    const repo = join(d, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    expect(checkProjectPath(`${repo}/`)).toEqual({ exists: true, isDirectory: true, isGitRepo: true, empty: false, suggestedName: 'repo' })
    expect(structuredClone(checkProjectPath(repo))).toEqual(checkProjectPath(repo))
  })

  it('suggests a name from either separator and none for a root', () => {
    expect(suggestedProjectName('C:\\work\\shop\\')).toBe('shop')
    expect(suggestedProjectName('/home/me/shop')).toBe('shop')
    expect(suggestedProjectName('C:\\')).toBe('')
    expect(suggestedProjectName('/')).toBe('')
  })
})

describe('creating projects', () => {
  const missing = { exists: false, isDirectory: false, isGitRepo: false, suggestedName: 'x', empty: false }

  it('refuses an existing-repository project at a path that does not exist, and any file path', () => {
    expect(createPathError({ path: ' ', setupKind: 'existing' }, missing)).toBe('Choose a folder for the project.')
    expect(createPathError({ path: 'C:/does/not/exist', setupKind: 'existing' }, missing)).toContain('There is no folder at C:/does/not/exist')
    expect(createPathError({ path: 'C:/a.txt' }, { ...missing, exists: true })).toContain('is a file, not a folder')
    expect(createPathError({ path: 'C:/new/idea', setupKind: 'new' }, missing)).toBeNull()
    expect(createPathError({ path: 'C:/skip' }, missing)).toBeNull()
    expect(createPathError({ path: 'shop' }, missing)).toMatch(/^Use a full path/)
    expect(createPathError({ path: '"C:\\work\\shop"', setupKind: 'new' }, missing)).toBeNull()
    expect(cleanProjectPath(' "C:\\work\\shop" ')).toBe('C:\\work\\shop')
  })

  it('create throws the message, and takes the mock adapter only when it is available', () => {
    const d = dataDir()
    const store = new ProjectStore(d)
    expect(() => store.create({ name: 'X', path: join(d, 'missing'), brief: '', setupKind: 'existing' })).toThrow(/There is no folder/)
    expect(() => store.create({ name: 'X', path: d, brief: '', mock: true })).toThrow(/ORGAI_MOCK=1/)
    const p = store.create({ name: 'X', path: d, brief: '', setupKind: 'existing', mock: true }, undefined, { mockAvailable: true })
    expect(p.provider.id).toBe('mock')
    expect(store.create({ name: 'Y', path: d, brief: '' }).provider.id).toBe('claude')
  })

  it('create applies prepare to real projects but not to mock ones', () => {
    const d = dataDir()
    const store = new ProjectStore(d)
    const prepare = (p: Project): Project => ({ ...p, provider: { ...p.provider, connection: 'litellm', label: 'LiteLLM' } })
    const real = store.create({ name: 'Y', path: d, brief: '' }, undefined, { prepare })
    expect(real.provider.connection).toBe('litellm')
    expect(store.get(real.id)?.provider.label).toBe('LiteLLM')
    const mock = store.create({ name: 'M', path: d, brief: '', mock: true }, undefined, { mockAvailable: true, prepare })
    expect(mock.provider).toMatchObject({ id: 'mock' })
    expect(mock.provider.connection).not.toBe('litellm')
  })

  it('create imports agents after prepare, so their models map to the chosen connection', () => {
    const d = dataDir()
    const store = new ProjectStore(d)
    const order: string[] = []
    const prepare = (p: Project): Project => {
      order.push('prepare')
      return { ...p, provider: { ...p.provider, connection: 'openai' } }
    }
    const importRoles = (p: Project, sources: unknown): Project => {
      order.push(`import:${p.provider.connection}:${JSON.stringify(sources)}`)
      return { ...p, roles: [role({ id: 'r1', slug: 'imported' })] }
    }
    const p = store.create({ name: 'Y', path: d, brief: '', importAgents: ['claude'] }, undefined, { prepare, importRoles })
    expect(order).toEqual(['prepare', 'import:openai:["claude"]'])
    expect(store.get(p.id)?.roles.map((r) => r.slug)).toEqual(['imported'])
    order.length = 0
    store.create({ name: 'Z', path: d, brief: '' }, undefined, { prepare, importRoles })
    expect(order).toEqual(['prepare'])
  })
})
