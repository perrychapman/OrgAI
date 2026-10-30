import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANTHROPIC_BUILTIN_MODELS, defaultRoles, defaultTierModels } from '@shared/defaults'
import type { Project } from '@shared/types'
import { convertImport } from './convert'
import { ORG_EXPORT_FORMAT, buildOrgExport, writeOrgExport } from './export'
import { scanAgentSources } from './scan'

let base: string
let root: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orgai-export-'))
  root = join(base, 'repo')
  mkdirSync(root)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const project = (): Pick<Project, 'name' | 'roles' | 'path'> => {
  const roles = defaultRoles()
  roles[1].effort = 'high'
  roles[0].mcpServers = ['secret-server']
  return { name: 'Shop', roles, path: root }
}

describe('buildOrgExport', () => {
  it('writes slugs instead of ids and leaves out positions and MCP grants', () => {
    const p = project()
    const doc = buildOrgExport(p, new Date('2026-10-30T00:00:00Z'))
    expect(doc.format).toBe(ORG_EXPORT_FORMAT)
    expect(doc.exportedAt).toBe('2026-10-30T00:00:00.000Z')
    expect(doc.project).toEqual({ name: 'Shop' })
    const orch = doc.roles.find((r) => r.slug === 'orchestrator')
    expect(orch?.reportsTo).toBeNull()
    expect(orch?.spawnable.sort()).toEqual(['implementer', 'researcher', 'reviewer'])
    expect(doc.roles.find((r) => r.slug === 'implementer')).toMatchObject({ reportsTo: 'orchestrator', effort: 'high', tier: 'everyday' })
    const text = JSON.stringify(doc)
    for (const r of p.roles) expect(text).not.toContain(r.id)
    expect(text).not.toContain('position')
    expect(text).not.toContain('secret-server')
  })
})

describe('writeOrgExport', () => {
  it('round-trips through the scanner and the converter', () => {
    const p = project()
    const path = writeOrgExport(p)
    expect(path).toBe(join(root, '.orgai', 'org.json'))
    expect(readdirSync(join(root, '.orgai'))).toEqual(['org.json'])
    const { agents, scan } = scanAgentSources(root)
    expect(scan.sources.map((s) => s.source)).toEqual(['orgai'])
    const out = convertImport({
      existing: [],
      agents,
      mode: 'replace',
      model: { connection: 'anthropic', catalog: ANTHROPIC_BUILTIN_MODELS, tierModels: defaultTierModels(ANTHROPIC_BUILTIN_MODELS) },
      provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection: 'anthropic' }
    })
    const shape = (roles: Project['roles']) => {
      const slug = new Map(roles.map((r) => [r.id, r.slug]))
      return roles
        .map((r) => ({
          slug: r.slug,
          name: r.name,
          prompt: r.prompt,
          tools: r.tools,
          model: r.model,
          tier: r.tier,
          effort: r.effort,
          canSpawn: r.canSpawn,
          color: r.color,
          responsibilities: r.responsibilities,
          reportsTo: r.reportsTo ? slug.get(r.reportsTo) : null,
          spawnable: r.spawnable.map((s) => slug.get(s)).sort()
        }))
        .sort((a, b) => a.slug.localeCompare(b.slug))
    }
    expect(shape(out.roles)).toEqual(shape(p.roles))
    expect(out.items.every((i) => i.modelReason === 'kept')).toBe(true)
  })

  it('overwrites an earlier export', () => {
    writeOrgExport(project())
    writeOrgExport({ ...project(), name: 'Renamed' })
    expect(JSON.parse(readFileSync(join(root, '.orgai', 'org.json'), 'utf8')).project.name).toBe('Renamed')
  })

  it('refuses a symlinked .orgai folder', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(root, '.orgai'), 'junction')
    expect(() => writeOrgExport(project())).toThrow(/not a plain folder/)
    expect(existsSync(join(outside, 'org.json'))).toBe(false)
  })

  it('refuses a symlinked org.json file', () => {
    mkdirSync(join(root, '.orgai'))
    const target = join(base, 'target.txt')
    writeFileSync(target, 'keep')
    try {
      symlinkSync(target, join(root, '.orgai', 'org.json'), 'file')
    } catch {
      return // no symlink privilege (Windows without developer mode)
    }
    expect(() => writeOrgExport(project())).toThrow(/not a plain file/)
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })

  it('refuses a missing project folder', () => {
    expect(() => writeOrgExport({ ...project(), path: join(base, 'nope') })).toThrow(/does not exist/)
  })
})
