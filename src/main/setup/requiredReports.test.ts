import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANTHROPIC_BUILTIN_MODELS, defaultRoles, defaultTierModels } from '@shared/defaults'
import type { Role } from '@shared/types'
import { toRoles } from '../ai/draft'
import { convertImport } from './import/convert'
import { buildOrgExport, writeOrgExport } from './import/export'
import { parseOrgExport } from './import/parsers'
import { scanAgentSources } from './import/scan'
import { sanitizeRoleModels } from '../store/projects'
import { mergeOrgChart } from './orgMerge'
import { project } from '../runtime/testHelpers'
import { newProject } from '@shared/defaults'
import { diffOrgChart, type DiffRole } from '@shared/view/orgDiff'

const role = (id: string, name: string, over: Partial<Role> = {}): Role => ({
  id,
  slug: name.toLowerCase(),
  name,
  description: name,
  responsibilities: [],
  prompt: name,
  tools: ['Read'],
  model: 'sonnet',
  canSpawn: false,
  spawnable: [],
  reportsTo: null,
  position: { x: 0, y: 0 },
  color: '#111',
  ...over
})

describe('mergeOrgChart requiredReports', () => {
  const base = () => project({ roles: [role('r-lead', 'Lead', { canSpawn: true, spawnable: ['r-eng', 'r-qa'], requiredReports: ['r-eng'] }), role('r-eng', 'Eng', { reportsTo: 'r-lead' }), role('r-qa', 'Qa', { reportsTo: 'r-lead' })] })

  it('remaps proposed ids, intersects with spawnable and clears when absent or empty', () => {
    const p = base()
    const out = mergeOrgChart(p, [
      role('n1', 'Lead', { canSpawn: true, spawnable: ['n2', 'n3'], requiredReports: ['n3', 'n2', 'nope', 'n1'] }),
      role('n2', 'Eng', { reportsTo: 'n1' }),
      role('n3', 'Qa', { reportsTo: 'n1' })
    ])
    expect(out.roles.find((r) => r.id === 'r-lead')!.requiredReports).toEqual(['r-qa', 'r-eng'])
    const dropped = mergeOrgChart(p, [role('n1', 'Lead', { canSpawn: true, spawnable: ['n2'], requiredReports: ['n3'] }), role('n2', 'Eng', { reportsTo: 'n1' })])
    expect(dropped.roles.find((r) => r.id === 'r-lead')).not.toHaveProperty('requiredReports')
    const absent = mergeOrgChart(p, [role('n1', 'Lead', { canSpawn: true, spawnable: ['n2'] }), role('n2', 'Eng', { reportsTo: 'n1' })])
    expect(absent.roles.find((r) => r.id === 'r-lead')).not.toHaveProperty('requiredReports')
  })
})

describe('toRoles requiredReports', () => {
  it('resolves names among drafts and keeps only spawnable ones', () => {
    const d = (name: string, reportsTo: string | null, over: Record<string, unknown> = {}) => ({ name, description: 'd', responsibilities: [], prompt: 'p', tools: ['Read'], canSpawn: false, spawnable: [] as string[], reportsTo, ...over })
    const roles = toRoles({ rationale: 'r', roles: [d('Lead', null, { canSpawn: true, spawnable: ['Dev'], requiredReports: ['dev', 'QA', 'Ghost'] }), d('Dev', 'Lead'), d('QA', 'Lead')] })
    // QA is a direct report, so it is spawnable too.
    expect(roles[0].requiredReports).toEqual([roles[1].id, roles[2].id])
    expect(roles[1].requiredReports).toBeUndefined()
  })
})

describe('store sanitize', () => {
  it('drops requiredReports ids outside spawnable and the whole key when empty', () => {
    const p = newProject({ name: 'P', path: 'C:/p', brief: '' })
    p.roles = [role('a', 'A', { canSpawn: true, spawnable: ['b'], requiredReports: ['b', 'c', 'a', 'b'] }), role('b', 'B', { requiredReports: ['a'] }), role('c', 'C', { canSpawn: true, spawnable: ['a'], requiredReports: ['a'] })]
    const out = sanitizeRoleModels(p)
    expect(out.changed).toBe(true)
    expect(out.project.roles[0].requiredReports).toEqual(['b'])
    expect(out.project.roles[1]).not.toHaveProperty('requiredReports')
    expect(out.project.roles[2].requiredReports).toEqual(['a'])
    expect(sanitizeRoleModels(out.project).changed).toBe(false)
  })
})

describe('import and export requiredReports', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-reqrep-'))
    mkdirSync(join(dir, 'repo'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('exports slugs, parses them and converts back to ids', () => {
    const roles = defaultRoles()
    const orch = roles.find((r) => r.slug === 'orchestrator')!
    const impl = roles.find((r) => r.slug === 'implementer')!
    orch.requiredReports = [impl.id, 'ghost']
    const doc = buildOrgExport({ name: 'S', roles }, new Date(0))
    expect(doc.roles.find((r) => r.slug === 'orchestrator')!.requiredReports).toEqual(['implementer'])
    expect(doc.roles.find((r) => r.slug === 'implementer')).not.toHaveProperty('requiredReports')
    const parsed = parseOrgExport(JSON.stringify(doc), '.orgai/org.json')
    expect(parsed.agents.find((a) => a.slug === 'orchestrator')!.requiredReports).toEqual(['implementer'])
    const repo = join(dir, 'repo')
    writeOrgExport({ name: 'S', roles, path: repo })
    const { agents } = scanAgentSources(repo)
    const out = convertImport({
      existing: [],
      agents,
      mode: 'replace',
      model: { connection: 'anthropic', catalog: ANTHROPIC_BUILTIN_MODELS, tierModels: defaultTierModels(ANTHROPIC_BUILTIN_MODELS) },
      provider: { id: 'claude', label: 'Claude', auth: { kind: 'subscription' }, connection: 'anthropic' }
    })
    const lead = out.roles.find((r) => r.slug === 'orchestrator')!
    const dev = out.roles.find((r) => r.slug === 'implementer')!
    expect(lead.requiredReports).toEqual([dev.id])
  })
})

describe('orgDiff requiredReports', () => {
  const r = (slug: string, over: Partial<DiffRole> = {}): DiffRole => ({ id: `id-${slug}`, slug, name: slug, model: 'sonnet', reportsTo: null, description: 'd', tools: ['Read'], canSpawn: false, spawnable: [], prompt: 'p', ...over })
  it('shows a changed list as a line', () => {
    const lead = (extra: Partial<DiffRole>, id: string) => r('lead', { id, canSpawn: true, spawnable: [id === 'n1' ? 'n2' : 'id-dev', ], ...extra })
    const cur = [lead({}, 'id-lead'), r('dev', { reportsTo: 'id-lead' })]
    const prop = [lead({ requiredReports: ['n2'] }, 'n1'), r('dev', { id: 'n2', reportsTo: 'n1' })]
    const d = diffOrgChart(cur, prop)
    const change = d.changed[0].changes.find((c) => c.field === 'requiredReports')!
    expect(change).toMatchObject({ label: 'must delegate to', from: 'none', to: 'dev' })
    const same = diffOrgChart(cur, [lead({}, 'n1'), r('dev', { id: 'n2', reportsTo: 'n1' })])
    expect(same.summary).toBe('No changes')
  })
})
