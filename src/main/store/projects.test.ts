import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpServerSpec, PluginSpec } from '@shared/types'
import { project, role } from '../runtime/testHelpers'
import { ProjectStore } from './projects'

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

  it('keeps what a new project sent', () => {
    const store = new ProjectStore(dataDir())
    const saved = store.saveFromRenderer(project({ id: 'new', mcpServers: [server] }))
    expect(saved.mcpServers).toEqual([server])
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
