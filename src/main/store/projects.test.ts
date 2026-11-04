import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, sep, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerSpec, PluginSpec, Project, Role, SkillSpec } from '@shared/types'
import { PROJECT_CLIENT_MAX_CHARS, PROJECT_ALLOWED_DIRECTORIES_MAX, PROJECT_ALLOWED_DIRECTORY_MAX_CHARS, PROJECT_REFERENCE_DIRECTORIES_MAX, PROJECT_REFERENCE_DIRECTORY_MAX_CHARS } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { project, role } from '../runtime/testHelpers'
import { ProjectStore, cleanClient, cleanAllowedDirectories, cleanReferenceDirectories,acceptableRoleModel, sanitizeRoleModels, checkProjectPath, cleanProjectPath, createPathError, reconcileNearLimitProject, suggestedProjectName, type PathFs } from './projects'
import { mkdirSync } from 'node:fs'

describe('reconcileNearLimitProject', () => {
  it('lets an older renderer that toggles only the legacy field win, and mirrors both', () => {
    const stored = { ...project(), preferEverydayNearLimit: false, preferSonnetNearLimit: false }
    expect(reconcileNearLimitProject(stored, { ...stored, preferSonnetNearLimit: true })).toMatchObject({ preferEverydayNearLimit: true, preferSonnetNearLimit: true })
    expect(reconcileNearLimitProject(stored, { ...stored, preferEverydayNearLimit: true })).toMatchObject({ preferEverydayNearLimit: true, preferSonnetNearLimit: true })
  })

  it('migrates a legacy-only project and leaves an unset one unset', () => {
    const legacy = { ...project(), preferSonnetNearLimit: true }
    expect(reconcileNearLimitProject(legacy, { ...legacy })).toMatchObject({ preferEverydayNearLimit: true, preferSonnetNearLimit: true })
    const base = project()
    const none = reconcileNearLimitProject(base, { ...base })
    expect(none.preferEverydayNearLimit).toBeUndefined()
    expect(none.preferSonnetNearLimit).toBeUndefined()
  })
})

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
    expect(() => store.saveFromRenderer(project({ id: 'quick' }))).toThrow(/cannot be saved/)
    expect(() => store.saveFromRenderer(project({ id: 'skills' }))).toThrow(/cannot be saved/)
  })
})

describe('Project.client normalization', () => {
  it('trims, cuts at the limit, and drops empty, non-string and hidden-character values on save', () => {
    const store = new ProjectStore(dataDir())
    const clientOf = (client: unknown): unknown => store.save(project({ client } as Partial<Project>)).client
    expect(clientOf('  Acme Corp  ')).toBe('Acme Corp')
    expect(clientOf('   ')).toBeUndefined()
    expect(clientOf(42)).toBeUndefined()
    expect(clientOf('Ac‮me')).toBeUndefined()
    expect(clientOf('Ac​me')).toBeUndefined()
    const cut = clientOf('x'.repeat(PROJECT_CLIENT_MAX_CHARS + 20)) as string
    expect(cut).toBe('x'.repeat(PROJECT_CLIENT_MAX_CHARS))
  })

  it('does not cut an emoji in half', () => {
    const store = new ProjectStore(dataDir())
    const text = `${'x'.repeat(PROJECT_CLIENT_MAX_CHARS - 1)}😀`
    expect(store.save(project({ client: text } as Partial<Project>)).client).toBe('x'.repeat(PROJECT_CLIENT_MAX_CHARS - 1))
  })
})

describe('ProjectStore.save virtual ids (L4)', () => {
  it('refuses the harness, Chat and Skill assistant ids', () => {
    const store = new ProjectStore(dataDir())
    for (const id of ['harness', 'quick', 'skills']) expect(() => store.save(project({ id }))).toThrow(/cannot be stored/)
    expect(store.list().map((p) => p.id)).not.toContain('quick')
  })
})

describe('ProjectStore.saveFromRenderer skills', () => {
  const spec = (id: string): SkillSpec => ({ id, name: id, description: 'd', enabled: true, source: 'user', digest: 'x', files: [], addedAt: 't', updatedAt: 't' })
  const withGrants = (skills: string[] | undefined) => orgRoles(skills)
  function orgRoles(skills: string[] | undefined) {
    const p = project()
    return p.roles.map((r) => (r.id === 'r-eng' && skills ? { ...r, skills } : r))
  }

  it('keeps the stored skills over a stale renderer copy and drops unknown grants (deduped)', () => {
    const store = new ProjectStore(dataDir())
    store.save(project({ skills: [spec('s1'), spec('s2')], roles: withGrants(['s1']) }))
    const saved = store.saveFromRenderer(project({ skills: [], roles: withGrants(['s1', 's1', 's2', 'ghost']) }))
    expect(saved.skills?.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(saved.roles.find((r) => r.id === 'r-eng')?.skills).toEqual(['s1', 's2'])
    expect(saved.roles.find((r) => r.id === 'r-lead')?.skills).toBeUndefined()
  })

  it('does not invent skills and removes every grant when the store has none', () => {
    const store = new ProjectStore(dataDir())
    store.save(project())
    const saved = store.saveFromRenderer(project({ skills: [spec('s1')], roles: withGrants(['s1']) }))
    expect(saved.skills).toBeUndefined()
    expect(saved.roles.find((r) => r.id === 'r-eng')?.skills).toEqual([])
  })

  it('normalizes skillEvaluation and accepts old projects without skills', () => {
    const store = new ProjectStore(dataDir())
    store.save(project())
    expect(store.saveFromRenderer(project()).skillEvaluation).toBeUndefined()
    const saved = store.saveFromRenderer(project({ skillEvaluation: { enabled: true, tokenBudget: 5 } }))
    expect(saved.skillEvaluation).toEqual({ enabled: true, tokenBudget: 1000 })
    const bad = store.saveFromRenderer(project({ skillEvaluation: { enabled: 'yes', tokenBudget: 'lots' } as never }))
    expect(bad.skillEvaluation).toEqual({ tokenBudget: 20000 })
    expect('enabled' in (bad.skillEvaluation ?? {})).toBe(false)
  })

  it('keeps an unset skillEvaluation.enabled unset', () => {
    const store = new ProjectStore(dataDir())
    store.save(project())
    const saved = store.saveFromRenderer(project({ skillEvaluation: { tokenBudget: 30_000 } }))
    expect(saved.skillEvaluation).toEqual({ tokenBudget: 30_000 })
    expect(store.get(saved.id)?.skillEvaluation?.enabled).toBeUndefined()
  })

  it('never fills subagent limits and keeps explicit ones', () => {
    const store = new ProjectStore(dataDir())
    const base = project()
    delete (base as Partial<Project>).maxSubagentDepth
    delete (base as Partial<Project>).maxConcurrentSubagents
    store.save(base)
    const saved = store.saveFromRenderer({ ...base })
    expect(saved.maxSubagentDepth).toBeUndefined()
    expect(saved.maxConcurrentSubagents).toBeUndefined()
    expect(store.get(base.id)?.maxSubagentDepth).toBeUndefined()
    expect(store.get(base.id)?.maxConcurrentSubagents).toBeUndefined()
    const explicit = store.saveFromRenderer({ ...base, maxSubagentDepth: 3, maxConcurrentSubagents: 7 })
    expect(explicit).toMatchObject({ maxSubagentDepth: 3, maxConcurrentSubagents: 7 })
    expect(store.get(base.id)).toMatchObject({ maxSubagentDepth: 3, maxConcurrentSubagents: 7 })
  })

  it('drops the old always-filled limits (3 / 8) once from a version 1 file and keeps other values (L3)', () => {
    const dir = dataDir()
    const legacy = { ...project({ id: 'p_legacy' }), maxSubagentDepth: 3, maxConcurrentSubagents: 8 }
    const custom = { ...project({ id: 'p_custom' }), maxSubagentDepth: 2, maxConcurrentSubagents: 12 }
    const mixed = { ...project({ id: 'p_mixed' }), maxSubagentDepth: 3, maxConcurrentSubagents: 4 }
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, projects: [legacy, custom, mixed] }))
    const store = new ProjectStore(dir)
    expect(store.get('p_legacy')?.maxSubagentDepth).toBeUndefined()
    expect(store.get('p_legacy')?.maxConcurrentSubagents).toBeUndefined()
    expect(store.get('p_custom')).toMatchObject({ maxSubagentDepth: 2, maxConcurrentSubagents: 12 })
    expect(store.get('p_mixed')?.maxSubagentDepth).toBeUndefined()
    expect(store.get('p_mixed')?.maxConcurrentSubagents).toBe(4)
    expect(JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')).version).toBe(2)
    // After the migration an explicit 3 / 8 is the user's and survives a reload.
    store.save({ ...store.get('p_legacy')!, maxSubagentDepth: 3, maxConcurrentSubagents: 8 })
    expect(store.migrateAll()).toBe(0)
    expect(new ProjectStore(dir).get('p_legacy')).toMatchObject({ maxSubagentDepth: 3, maxConcurrentSubagents: 8 })
  })

  it('does not run the limits migration on a version 2 or newer file (3 / 8 stay explicit)', () => {
    for (const version of [2, 3, 99]) {
      const dir = dataDir()
      const p = { ...project({ id: 'p_new' }), maxSubagentDepth: 3, maxConcurrentSubagents: 8 }
      writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version, projects: [p] }))
      const store = new ProjectStore(dir)
      expect(store.get('p_new'), `version ${version}`).toMatchObject({ maxSubagentDepth: 3, maxConcurrentSubagents: 8 })
    }
  })

  it('treats a missing or non-numeric version as 1 and migrates once', () => {
    for (const version of [undefined, 'two', null, '2']) {
      const dir = dataDir()
      const p = { ...project({ id: 'p_old' }), maxSubagentDepth: 3, maxConcurrentSubagents: 8 }
      writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version, projects: [p] }))
      const store = new ProjectStore(dir)
      expect(store.get('p_old')?.maxSubagentDepth, String(version)).toBeUndefined()
      expect(JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')).version).toBe(2)
    }
  })

  it('starts empty on a corrupt, empty or wrongly shaped projects.json without throwing', () => {
    const cases = ['{ not json', '', '   ', 'null', '[]', '"x"', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, projects: 'nope' }), JSON.stringify({ version: 1, projects: {} })]
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const text of cases) {
        const dir = dataDir()
        writeFileSync(join(dir, 'projects.json'), text)
        let store: ProjectStore | undefined
        expect(() => (store = new ProjectStore(dir)), JSON.stringify(text)).not.toThrow()
        expect(store!.list(), JSON.stringify(text)).toEqual([])
        store!.save(project({ id: 'p_after' }))
        expect(new ProjectStore(dir).get('p_after')).not.toBeNull()
      }
    } finally {
      err.mockRestore()
    }
  })

  it('keeps an unset plan guard unset through a renderer save', () => {
    const store = new ProjectStore(dataDir())
    const base = project()
    delete (base as Partial<Project>).preferEverydayNearLimit
    delete (base as Partial<Project>).preferSonnetNearLimit
    store.save(base)
    const saved = store.saveFromRenderer({ ...base })
    expect(saved.preferEverydayNearLimit).toBeUndefined()
    expect(saved.preferSonnetNearLimit).toBeUndefined()
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

describe('Role.model validation', () => {
  const bad = (model: unknown, tier?: Role['tier']) => role({ id: 'r', slug: 'dev', model: model as string, ...(tier ? { tier } : {}) })
  const claudeProvider = (connection: Project['provider']['connection'] = 'anthropic'): Project['provider'] => ({ id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection })

  it('acceptableRoleModel takes inherit, empty, tier names and valid ids only', () => {
    for (const ok of [undefined, '', 'inherit', 'deep', 'opus', 'claude-sonnet-4-5', 'openai/gpt-5.1']) expect(acceptableRoleModel(ok), String(ok)).toBe(true)
    for (const no of ['--some-cli-flag', '-m', 'a b', 'x\ny', 'x'.repeat(201), 42, {}]) expect(acceptableRoleModel(no), JSON.stringify(no)).toBe(false)
  })

  it('sanitizeRoleModels falls back to the tier through the connection, else inherit, and logs once per value', () => {
    const log = vi.fn()
    const p = project({ provider: claudeProvider(), roles: [bad('--evil-a', 'deep'), bad('--evil-b'), role({ id: 'ok', slug: 'ok', model: 'sonnet' })] })
    const out = sanitizeRoleModels(p, undefined, log)
    expect(out.changed).toBe(true)
    expect(out.project.roles[0]).toMatchObject({ model: 'opus', tier: 'deep' })
    expect(out.project.roles[1].model).toBe('inherit')
    expect(out.project.roles[1].tier).toBeUndefined()
    expect(out.project.roles[2].model).toBe('sonnet')
    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls.join(' ')).not.toContain('--evil')
    sanitizeRoleModels(p, undefined, log)
    expect(log).toHaveBeenCalledTimes(2)
    const unchanged = project({ roles: [role({ id: 'ok', slug: 'ok', model: 'sonnet' })] })
    expect(sanitizeRoleModels(unchanged, undefined, log)).toEqual({ project: unchanged, changed: false })
  })

  it('uses the connection tier mapping given to it, and refuses an invalid mapped model', () => {
    const p = project({ provider: claudeProvider('litellm'), roles: [bad('--x1', 'everyday'), bad('--x2', 'deep')] })
    const tierContext = () => ({ connection: 'litellm' as const, tierModels: { everyday: 'claude-sonnet-4-5', deep: '--mapped-evil' } })
    const out = sanitizeRoleModels(p, tierContext, () => {}).project
    expect(out.roles[0]).toMatchObject({ model: 'claude-sonnet-4-5', tier: 'everyday' })
    // deep maps to an invalid id, so the role inherits rather than passing it on.
    expect(out.roles[1].model).toBe('inherit')
  })

  it('saveFromRenderer, update and load never store an invalid model', () => {
    const dir = dataDir()
    const store = new ProjectStore(dir)
    store.save(project({ provider: claudeProvider() }))
    const saved = store.saveFromRenderer(project({ provider: claudeProvider(), roles: [bad('--some-cli-flag', 'everyday')] }))
    expect(saved.roles[0]).toMatchObject({ model: 'sonnet', tier: 'everyday' })
    expect(JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')).projects[0].roles[0].model).toBe('sonnet')
    expect(store.update('p1', (p) => ({ ...p, roles: [bad('a b')] })).roles[0].model).toBe('inherit')

    const dir2 = dataDir()
    writeFileSync(join(dir2, 'projects.json'), JSON.stringify({ version: 1, projects: [project({ provider: claudeProvider(), roles: [bad('--hand-edited', 'fast')] })] }))
    expect(new ProjectStore(dir2).get('p1')!.roles[0]).toMatchObject({ model: 'haiku', tier: 'fast' })
    expect(JSON.parse(readFileSync(join(dir2, 'projects.json'), 'utf8')).projects[0].roles[0].model).toBe('haiku')
  })

  it('create sanitizes imported roles', () => {
    const d = dataDir()
    const store = new ProjectStore(d)
    const importRoles = (p: Project): Project => ({ ...p, roles: [bad('--imported', 'deep')] })
    const p = store.create({ name: 'I', path: d, brief: '', importAgents: ['claude'] }, undefined, { importRoles })
    expect(p.roles[0]).toMatchObject({ model: 'opus', tier: 'deep' })
  })
})

describe('cleanAllowedDirectories', () => {
  const winOpts = { path: win32, touchesData: (d: string) => d.toLowerCase().startsWith('c:\\data'), same: (a: string, b: string) => a.toLowerCase() === b.toLowerCase() }
  const posixOpts = { path: posix, touchesData: (d: string) => d === '/home/u' || d.startsWith('/home/u/.orgai'), same: (a: string, b: string) => a === b }

  it('drops non-arrays and keeps the field absent', () => {
    expect(cleanAllowedDirectories(undefined, 'C:\\data', winOpts)).toBeUndefined()
    expect(cleanAllowedDirectories('C:\\x', 'C:\\data', winOpts)).toBeUndefined()
    expect(cleanAllowedDirectories({ 0: 'C:\\x' }, 'C:\\data', winOpts)).toBeUndefined()
  })

  it('win32: keeps drive-letter paths, trims and normalizes them, drops the rest', () => {
    const out = cleanAllowedDirectories(
      [' D:\\shared\\lib\\ ', 'relative\\dir', '\\rooted-no-drive', 'C:foo', 'C:\\', 'C:', 'C:/', 'D:\\a\\..', '\\\\server\\share', '\\\\?\\C:\\x', '\\\\.\\pipe\\x', '//host/x', 'C:\\data', 'c:\\DATA\\sub', 'E:/other/dir', 42, null, '', 'D:\\a\0b'],
      'C:\\data',
      winOpts
    )
    expect(out).toEqual(['D:\\shared\\lib', 'E:\\other\\dir'])
  })

  it('posix: keeps absolute paths, drops relative, root, UNC-style and the data folder (and a folder that contains it)', () => {
    const out = cleanAllowedDirectories(['/srv/shared/', 'rel/dir', './x', '/', '/a/..', '//host/share', '/home/u', '/home/u/.orgai/projects', '/opt/x'], '/home/u/.orgai', posixOpts)
    expect(out).toEqual(['/srv/shared', '/opt/x'])
  })

  it('collapses duplicates, keeping the first spelling', () => {
    expect(cleanAllowedDirectories(['D:\\Lib', 'd:\\lib\\', 'D:/Lib', 'D:\\lib\\.\\'], 'C:\\data', winOpts)).toEqual(['D:\\Lib'])
    expect(cleanAllowedDirectories(['/srv/a', '/srv/a/', '/srv//a', '/srv/A'], '/home/u/.orgai', posixOpts)).toEqual(['/srv/a', '/srv/A'])
  })

  it('caps the list and the path length', () => {
    const many = Array.from({ length: 30 }, (_, i) => `/srv/d${i}`)
    const out = cleanAllowedDirectories(many, '/home/u/.orgai', posixOpts)!
    expect(out).toHaveLength(PROJECT_ALLOWED_DIRECTORIES_MAX)
    expect(out[PROJECT_ALLOWED_DIRECTORIES_MAX - 1]).toBe(`/srv/d${PROJECT_ALLOWED_DIRECTORIES_MAX - 1}`)
    const exact = '/' + 'a'.repeat(PROJECT_ALLOWED_DIRECTORY_MAX_CHARS - 1)
    expect(cleanAllowedDirectories([exact, exact + 'b'], '/home/u/.orgai', posixOpts)).toEqual([exact])
  })

  it('native defaults: refuses the real data dir, a folder inside it and one that contains it; accepts a missing folder', () => {
    const data = dataDir()
    const outside = join(tmpdir(), `orgai-allowed-missing-${Date.now()}`)
    const out = cleanAllowedDirectories([data, join(data, 'projects'), dirname(data), outside, outside + sep], data)
    expect(out).toEqual([outside])
  })
})

describe('ProjectStore allowedDirectories', () => {
  it('normalizes on saveFromRenderer and on save', () => {
    const data = dataDir()
    const store = new ProjectStore(data)
    store.save(project())
    const keep = join(tmpdir(), 'orgai-allowed-keep')
    const saved = store.saveFromRenderer(project({ allowedDirectories: [keep, 'relative', join(data, 'x'), keep] }))
    expect(saved.allowedDirectories).toEqual([keep])
    expect(store.get('p1')?.allowedDirectories).toEqual([keep])
    const bad = store.save(project({ allowedDirectories: 'nope' as never }))
    expect('allowedDirectories' in bad).toBe(false)
  })

  it('normalizes on read and persists the cleaned list once', () => {
    const dir = dataDir()
    const keep = join(tmpdir(), 'orgai-allowed-keep')
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, projects: [project({ allowedDirectories: [keep, dir, 'x', 7] as never })] }))
    const store = new ProjectStore(dir)
    expect(store.get('p1')?.allowedDirectories).toEqual([keep])
    expect(JSON.parse(readFileSync(join(dir, 'projects.json'), 'utf8')).projects[0].allowedDirectories).toEqual([keep])
    expect(new ProjectStore(dir).migrateAll()).toBe(0)
  })
})

describe('cleanAllowedDirectories: too broad or sensitive (allowedDirectoryRisk, review M2)', () => {
  const winOpts = { path: win32, touchesData: () => false, same: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(), home: 'C:\\Users\\me', projectPath: 'C:\\work\\proj' }
  const posixOpts = { path: posix, touchesData: () => false, same: (a: string, b: string) => a === b, home: '/home/me', projectPath: '/work/proj' }

  it('win32: drops home, its parent, home config folders and the project in every direction; keeps a sibling and another drive', () => {
    const dropped = [
      'C:\\Users\\me',
      'C:\\Users',
      'C:\\Users\\me\\.ssh',
      'c:\\users\\ME\\.SSH\\keys',
      'C:\\Users\\me\\.claude',
      'C:\\Users\\me\\.codex',
      'C:\\Users\\me\\AppData\\Roaming',
      'C:\\Users\\me\\AppData\\Roaming\\Code',
      'C:\\work\\proj',
      'c:\\WORK\\proj\\',
      'C:\\work\\proj\\src',
      'C:\\work'
    ]
    const kept = ['C:\\work\\sibling', 'D:\\shared\\lib', 'C:\\Users\\me\\notes']
    expect(cleanAllowedDirectories([...dropped, ...kept], 'C:\\data', winOpts)).toEqual(kept)
  })

  it('posix: the same rules', () => {
    const dropped = ['/home/me', '/home', '/home/me/.ssh', '/home/me/.claude', '/home/me/.config/gh', '/work/proj', '/work/proj/src', '/work']
    const kept = ['/work/sibling', '/mnt/other/lib']
    expect(cleanAllowedDirectories([...dropped, ...kept], '/data', posixOpts)).toEqual(kept)
  })

  it('without home or project path only the syntax and data rules apply', () => {
    expect(cleanAllowedDirectories(['C:\\Users\\me', 'C:\\work\\proj'], 'C:\\data', { ...winOpts, home: undefined, projectPath: undefined })).toEqual(['C:\\Users\\me', 'C:\\work\\proj'])
  })

  it('ProjectStore drops them on save (returning the cleaned list) and on read, with a home override', () => {
    const data = dataDir()
    const root = dataDir()
    const home = join(root, 'home')
    const proj = join(root, 'work', 'proj')
    const sibling = join(root, 'work', 'sibling')
    const other = process.platform === 'win32' ? (/^z:/i.test(root) ? 'Y:\\lib' : 'Z:\\lib') : '/mnt/other-drive/lib'
    const all = [home, root, join(home, '.ssh'), join(home, '.claude'), join(home, 'AppData', 'Roaming'), proj, join(proj, 'src'), join(root, 'work'), sibling, other]
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const store = new ProjectStore(data, { home })
      store.save(project({ path: proj }))
      const saved = store.saveFromRenderer(project({ path: proj, allowedDirectories: all }))
      expect(saved.allowedDirectories).toEqual([sibling, other])
      expect(store.get('p1')?.allowedDirectories).toEqual([sibling, other])
      expect(debug.mock.calls.some((c) => String(c[0]).includes('too broad or sensitive'))).toBe(true)
      expect(debug.mock.calls.some((c) => String(c[0]).includes('the project folder or inside it'))).toBe(true)
      // A list written before the rule existed is cleaned at boot and persisted once.
      writeFileSync(join(data, 'projects.json'), JSON.stringify({ version: 1, projects: [project({ path: proj, allowedDirectories: all })] }))
      const reread = new ProjectStore(data, { home })
      expect(reread.get('p1')?.allowedDirectories).toEqual([sibling, other])
      expect(JSON.parse(readFileSync(join(data, 'projects.json'), 'utf8')).projects[0].allowedDirectories).toEqual([sibling, other])
    } finally {
      debug.mockRestore()
    }
  })
})

describe('cleanReferenceDirectories', () => {
  const winOpts = { path: win32, touchesData: (d: string) => d.toLowerCase().startsWith('c:\\data'), same: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(), home: 'C:\\Users\\me', projectPath: 'C:\\work\\proj' }
  const posixOpts = { path: posix, touchesData: () => false, same: (a: string, b: string) => a === b, home: '/home/me', projectPath: '/work/proj' }

  it('drops non-arrays', () => {
    expect(cleanReferenceDirectories(undefined, 'C:\\data', winOpts)).toBeUndefined()
    expect(cleanReferenceDirectories('C:\\x', 'C:\\data', winOpts)).toBeUndefined()
  })

  it('applies the allowed-folder rules: relative, root, UNC, data dir, project, containing the project, home, home config, duplicates', () => {
    const out = cleanReferenceDirectories(
      ['relative\\dir', 'C:\\', '\\\\server\\share', 'C:\\data\\sub', 'C:\\work\\proj', 'C:\\work\\proj\\src', 'C:\\work', 'C:\\Users\\me', 'C:\\Users\\me\\.ssh', 42, 'D:\\Docs\\', 'd:\\docs', 'E:\\other'],
      'C:\\data',
      winOpts
    )
    expect(out).toEqual(['D:\\Docs', 'E:\\other'])
    expect(cleanReferenceDirectories(['/home/me/.claude', '/home', '/srv/ref/', '/srv/ref'], '/data', posixOpts)).toEqual(['/srv/ref'])
  })

  it('caps the list and the path length like the allowed list', () => {
    const many = Array.from({ length: 30 }, (_, i) => `/srv/d${i}`)
    expect(cleanReferenceDirectories(many, '/data', posixOpts)).toHaveLength(PROJECT_REFERENCE_DIRECTORIES_MAX)
    const exact = '/' + 'a'.repeat(PROJECT_REFERENCE_DIRECTORY_MAX_CHARS - 1)
    expect(cleanReferenceDirectories([exact, exact + 'b'], '/data', posixOpts)).toEqual([exact])
  })
})

describe('ProjectStore referenceDirectories and kind', () => {
  it('cleans reference folders on save and drops one that is also an allowed folder', () => {
    const data = dataDir()
    const root = dataDir()
    const home = join(root, 'home')
    const proj = join(root, 'work', 'proj')
    const keep = join(root, 'work', 'ref')
    const both = join(root, 'work', 'both')
    const store = new ProjectStore(data, { home })
    store.save(project({ path: proj }))
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      const saved = store.saveFromRenderer(project({ path: proj, allowedDirectories: [both], referenceDirectories: [keep, 'relative', join(data, 'x'), join(proj, 'src'), both, keep] }))
      expect(saved.referenceDirectories).toEqual([keep])
      expect(saved.allowedDirectories).toEqual([both])
      expect(store.get('p1')?.referenceDirectories).toEqual([keep])
      expect(debug.mock.calls.some((c) => String(c[0]).includes('also an allowed folder'))).toBe(true)
      const bad = store.save(project({ path: proj, referenceDirectories: 'nope' as never }))
      expect('referenceDirectories' in bad).toBe(false)
    } finally {
      debug.mockRestore()
    }
  })

  it('cleans reference folders and kind at boot and persists once', () => {
    const data = dataDir()
    const root = dataDir()
    const keep = join(root, 'ref')
    const both = join(root, 'both')
    const raw = project({ path: join(root, 'proj'), allowedDirectories: [both], referenceDirectories: [keep, both, 'x', 7] as never, kind: 'banana' as never })
    writeFileSync(join(data, 'projects.json'), JSON.stringify({ version: 2, projects: [raw] }))
    const store = new ProjectStore(data, { home: join(root, 'home') })
    expect(store.get('p1')?.referenceDirectories).toEqual([keep])
    expect('kind' in store.get('p1')!).toBe(false)
    const disk = JSON.parse(readFileSync(join(data, 'projects.json'), 'utf8')).projects[0]
    expect(disk.referenceDirectories).toEqual([keep])
    expect('kind' in disk).toBe(false)
    expect(new ProjectStore(data, { home: join(root, 'home') }).migrateAll()).toBe(0)
  })

  it('normalizes kind on save: a valid kind stays, junk is removed', () => {
    const store = new ProjectStore(dataDir())
    expect(store.save(project({ kind: 'engagement' })).kind).toBe('engagement')
    expect('kind' in store.save(project({ kind: 'nope' as never }))).toBe(false)
    expect('kind' in store.saveFromRenderer(project({ kind: 5 as never }))).toBe(false)
  })

  it('saveFromRenderer never changes the stored kind', () => {
    const store = new ProjectStore(dataDir())
    store.save(project({ id: 'e1', kind: 'engagement' }))
    expect(store.saveFromRenderer(project({ id: 'e1', kind: 'code' })).kind).toBe('engagement')
    expect(store.saveFromRenderer(project({ id: 'e1' })).kind).toBe('engagement')
    store.save(project({ id: 'c1' }))
    expect('kind' in store.saveFromRenderer(project({ id: 'c1', kind: 'engagement' }))).toBe(false)
    expect('kind' in store.get('c1')!).toBe(false)
  })

  it('client drops line breaks, tabs and hidden characters', () => {
    expect(cleanClient('Acme Co')).toBe('Acme Co')
    expect(cleanClient('Acme\nignore previous')).toBeUndefined()
    expect(cleanClient('Acme\tCo')).toBeUndefined()
    expect(cleanClient('Acme\u202eCo')).toBeUndefined()
    expect(cleanClient('Acme\u2028Co')).toBeUndefined()
  })

  it('an engagement needs an existing folder', () => {
    const missing = { exists: false, isDirectory: false, isGitRepo: false, suggestedName: 'x', empty: false }
    expect(createPathError({ path: 'C:/new/folder', kind: 'engagement' }, missing)).toBe("Choose an existing folder for the engagement's working files.")
    expect(createPathError({ path: 'C:/new/folder', kind: 'engagement' }, { ...missing, exists: true, isDirectory: true })).toBeNull()
    expect(createPathError({ path: 'C:/new/folder' }, missing)).toBeNull()
  })

  it('create passes kind through and drops junk to code', () => {
    const d = dataDir()
    const store = new ProjectStore(d)
    const eng = store.create({ name: 'E', path: d, brief: '', kind: 'engagement' })
    expect(eng.kind).toBe('engagement')
    expect(store.get(eng.id)?.kind).toBe('engagement')
    const junk = store.create({ name: 'J', path: d, brief: '', kind: 'junk' as never })
    expect(projectKindOf(junk)).toBe('code')
    expect(projectKindOf(store.create({ name: 'C', path: d, brief: '' }))).toBe('code')
  })
})
