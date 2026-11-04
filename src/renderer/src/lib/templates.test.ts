import { describe, expect, it } from 'vitest'
import type { OrgTemplateInfo, Project } from '@shared/types'
import {
  defaultTemplateName,
  duplicateTemplate,
  groupTemplatesByKind,
  initialTemplateId,
  kindNote,
  localItemNames,
  localItemsLine,
  readLastTemplateId,
  roleNamesLine,
  savedDateLine,
  templateKindLabel,
  templateOptionLabel,
  whatGoesIn,
  writeLastTemplateId
} from './templates'

const t = (over: Partial<OrgTemplateInfo>): OrgTemplateInfo => ({
  id: 'a',
  name: 'A',
  description: '',
  kind: 'code',
  roleCount: 2,
  roleNames: ['Lead', 'Dev'],
  createdAt: 0,
  updatedAt: 0,
  ...over
})

describe('role names line', () => {
  it('lists up to four names then counts the rest', () => {
    expect(roleNamesLine(t({ roleCount: 2, roleNames: ['Lead', 'Dev'] }))).toBe('2 roles: Lead, Dev')
    expect(roleNamesLine(t({ roleCount: 7, roleNames: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] }))).toBe('7 roles: A, B, C, D and 3 more')
    expect(roleNamesLine(t({ roleCount: 1, roleNames: ['Solo'] }))).toBe('1 role: Solo')
    expect(roleNamesLine(t({ roleCount: 3, roleNames: [] }))).toBe('3 roles')
  })
})

describe('kinds', () => {
  it('labels and groups', () => {
    expect(templateKindLabel('engagement')).toBe('Engagement')
    expect(templateKindLabel('code')).toBe('Code project')
    const list = [t({ id: '1', kind: 'code' }), t({ id: '2', kind: 'engagement' }), t({ id: '3', kind: 'engagement' })]
    const g = groupTemplatesByKind(list, 'engagement')
    expect(g.same.map((x) => x.id)).toEqual(['2', '3'])
    expect(g.other.map((x) => x.id)).toEqual(['1'])
  })
  it('notes a template of another kind', () => {
    expect(kindNote('code', 'code')).toBeNull()
    expect(kindNote('code', 'engagement')).toBe("Made for a code project. Roles may speak in that kind's terms.")
    expect(kindNote('engagement', 'code')).toBe("Made for an engagement. Roles may speak in that kind's terms.")
  })
  it('labels select options', () => {
    expect(templateOptionLabel({ name: 'Audit', roleCount: 4 })).toBe('Audit (4 roles)')
  })
})

describe('saved date', () => {
  it('reads day, short month and year', () => {
    expect(savedDateLine(Date.UTC(2026, 10, 4, 12))).toBe('Saved 4 Nov 2026')
  })
})

describe('what goes in', () => {
  it('differs by kind', () => {
    const roles = [{}, {}, {}] as Project['roles']
    expect(whatGoesIn({ roles, kind: 'engagement' }).excluded).toContain('engagement plan')
    expect(whatGoesIn({ roles, kind: 'code' }).excluded).not.toContain('engagement plan')
    expect(whatGoesIn({ roles, kind: 'engagement' }).included[0]).toBe('3 roles with their instructions, models as tiers and tools')
    expect(whatGoesIn({ roles, kind: 'code' }).included[2]).toBe('Kind: Code project')
  })
})

describe('items outside the library', () => {
  const project = {
    roles: [
      { id: 'r1', slug: 'lead', skills: ['s1', 's2'], mcpServers: ['m1'] },
      { id: 'r2', slug: 'dev' }
    ],
    skills: [
      { id: 's1', name: 'local-skill' },
      { id: 's2', name: 'linked', libraryId: 'lib' },
      { id: 's3', name: 'nobody' }
    ],
    mcpServers: [
      { id: 'm1', name: 'local-server', roles: ['other'] },
      { id: 'm2', name: 'linked-server', libraryId: 'x' },
      { id: 'm3', name: 'restricted', roles: ['nobody'] }
    ]
  } as unknown as Project
  it('names granted local skills and services only', () => {
    expect(localItemNames(project)).toEqual({ skills: ['local-skill'], services: ['local-server'] })
    expect(localItemsLine(project)).toBe('Not in your library, so a new project will not have them: local-skill, local-server.')
  })
  it('is null when everything is in the library', () => {
    expect(localItemsLine({ roles: [], skills: [], mcpServers: [] })).toBeNull()
  })
})

describe('names', () => {
  it('finds a taken name regardless of case', () => {
    const list = [t({ name: 'Audit team' })]
    expect(duplicateTemplate(list, '  audit TEAM ')?.id).toBe('a')
    expect(duplicateTemplate(list, 'Other')).toBeUndefined()
    expect(duplicateTemplate(null, 'x')).toBeUndefined()
    expect(duplicateTemplate(list, '   ')).toBeUndefined()
  })
  it('defaults to the project name plus team, capped', () => {
    expect(defaultTemplateName('Acme', 80)).toBe('Acme team')
    expect(defaultTemplateName('x'.repeat(100), 80)).toHaveLength(80)
  })
})

describe('last template', () => {
  it('round trips through storage and tolerates failure', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    expect(readLastTemplateId(storage)).toBeNull()
    writeLastTemplateId(storage, 'tpl_1')
    expect(data.get('orgai.lastTemplateId')).toBe('tpl_1')
    expect(readLastTemplateId(storage)).toBe('tpl_1')
    expect(
      readLastTemplateId({
        getItem: () => {
          throw new Error('no')
        }
      })
    ).toBeNull()
  })
  it('preselects the last one while it exists', () => {
    const list = [t({ id: 'x', kind: 'code' }), t({ id: 'y', kind: 'engagement' })]
    expect(initialTemplateId(list, 'engagement', 'x')).toBe('x')
    expect(initialTemplateId(list, 'engagement', 'gone')).toBe('y')
    expect(initialTemplateId(list, 'engagement', null)).toBe('y')
    expect(initialTemplateId([], 'code', null)).toBe('')
  })
})
