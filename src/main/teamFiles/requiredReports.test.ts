import { describe, expect, it } from 'vitest'
import { newProject } from '@shared/defaults'
import type { Project, Role } from '@shared/types'
import type { TeamDoc } from './doc'
import { normalizeDoc, teamDigest } from './digest'
import { gateTeam } from './gate'
import { parseTeamFiles } from './parse'
import { docFromProject, rolesFromDoc, teamKey } from './project'
import { serializeRole, serializeTeam } from './serialize'
import { role, sampleDoc } from './doc.fixture'

const clone = <T>(v: T): T => structuredClone(v)
const withRequired = (names: string[] | undefined): TeamDoc => {
  const d = sampleDoc()
  const lead = d.roles.find((r) => r.slug === 'lead')!
  if (names) lead.requiredReports = names
  return d
}

describe('requiredReports in team files', () => {
  it('serializes required_reports, parses it back and drops it when absent', () => {
    const doc = withRequired(['reviewer', 'dev'])
    const lead = doc.roles.find((r) => r.slug === 'lead')!
    expect(serializeRole(lead)).toContain('required_reports:\n  - "dev"\n  - "reviewer"\n')
    const files = serializeTeam(doc)
    const parsed = parseTeamFiles(files, { base: null, agentsDirExists: true })
    expect(parsed.doc!.roles.find((r) => r.slug === 'lead')!.requiredReports).toEqual(['dev', 'reviewer'])
    expect(parsed.doc).toEqual(normalizeDoc(doc))
    const plain = serializeTeam(withRequired(undefined))
    const again = parseTeamFiles(plain, { base: parsed.doc, agentsDirExists: true })
    expect(again.doc!.roles.find((r) => r.slug === 'lead')!.requiredReports).toBeUndefined()
  })

  it('changes the digest when the list changes', () => {
    const a = teamDigest(withRequired(undefined))
    const b = teamDigest(withRequired(['dev']))
    const c = teamDigest(withRequired(['dev', 'reviewer']))
    expect(new Set([a, b, c]).size).toBe(3)
    expect(teamDigest(withRequired(['reviewer', 'dev']))).toBe(c)
  })

  it('leaves out ids that are not spawnable when parsing', () => {
    const files = serializeTeam(withRequired(['dev']))
    const doc = withRequired(['dev', 'ghost'])
    const parsed = parseTeamFiles(serializeTeam(doc), { base: null, agentsDirExists: true })
    expect(parsed.doc!.roles.find((r) => r.slug === 'lead')!.requiredReports).toEqual(['dev'])
    expect(files.length).toBeGreaterThan(0)
  })

  it('gates an added or removed list through approval and keeps the effective list within spawnable', () => {
    const approved = withRequired(undefined)
    const disk = clone(approved)
    disk.roles.find((r) => r.slug === 'lead')!.requiredReports = ['dev']
    const add = gateTeam(approved, disk, {})
    expect(add.pending.map((c) => c.id)).toEqual(['role:lead:required-reports'])
    expect(add.pending[0].needsApproval).toBe(true)
    expect(add.effective.roles.find((r) => r.slug === 'lead')!.requiredReports).toBeUndefined()

    const approved2 = withRequired(['dev'])
    const gone = gateTeam(approved2, withRequired(undefined), {})
    expect(gone.pending.map((c) => c.id)).toEqual(['role:lead:required-reports'])
    expect(gone.effective.roles.find((r) => r.slug === 'lead')!.requiredReports).toEqual(['dev'])

    // Removing the spawn target applies at once and takes the required id with it.
    const disk3 = withRequired(['dev', 'reviewer'])
    disk3.roles.find((r) => r.slug === 'lead')!.spawnable = ['dev']
    const narrowed = gateTeam(withRequired(['dev', 'reviewer']), disk3, {})
    expect(narrowed.effective.roles.find((r) => r.slug === 'lead')!.requiredReports).toEqual(['dev'])
    expect(role('x').requiredReports).toBeUndefined()
  })
})

function mk(id: string, slug: string, over: Partial<Role> = {}): Role {
  return { id, slug, name: slug, description: slug, responsibilities: [], prompt: slug, tools: ['Read'], model: 'inherit', canSpawn: false, spawnable: [], reportsTo: 'r-lead', position: { x: 0, y: 0 }, color: '#2bb0ff', ...over }
}
const proj = (required: string[] | undefined): Project => ({
  ...newProject({ name: 'D', path: 'C:/d', brief: '' }),
  roles: [mk('r-lead', 'lead', { reportsTo: null, canSpawn: true, spawnable: ['r-dev', 'r-qa'], ...(required ? { requiredReports: required } : {}) }), mk('r-dev', 'dev'), mk('r-qa', 'qa')]
})
const ctx = { tierModel: () => undefined, serverId: () => undefined, skillId: () => undefined, keepServerIds: [] as string[] }

describe('requiredReports project mapping', () => {
  it('docFromProject maps ids to slugs, rolesFromDoc maps back, and an absent list clears it', () => {
    const p = proj(['r-qa', 'r-dev'])
    const { doc } = docFromProject(p, () => null)
    expect(doc.roles.find((r) => r.slug === 'lead')!.requiredReports).toEqual(['dev', 'qa'])
    const back = rolesFromDoc(p, doc, ctx)
    expect(back.find((r) => r.slug === 'lead')!.requiredReports?.slice().sort()).toEqual(['r-dev', 'r-qa'])
    const cleared = clone(doc)
    delete cleared.roles.find((r) => r.slug === 'lead')!.requiredReports
    expect(rolesFromDoc(p, cleared, ctx).find((r) => r.slug === 'lead')!.requiredReports).toBeUndefined()
  })

  it('teamKey changes with the list', () => {
    expect(teamKey(proj(['r-dev']))).not.toBe(teamKey(proj(undefined)))
    expect(teamKey(proj(['r-dev']))).not.toBe(teamKey(proj(['r-dev', 'r-qa'])))
    expect(teamKey(proj(['r-dev', 'r-ghost']))).toBe(teamKey(proj(['r-dev'])))
  })
})
