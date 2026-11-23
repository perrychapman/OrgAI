/**
 * /skills' model: the row text (order, the three wordings of who holds a skill, the flags and their order), the row
 * never exceeding the width at 40 and at 120 columns, one skill's detail lines with and without its text (the 40-line
 * and 20-file cuts, the loading line, the failed read), the role choices in the project's order, and the library choices
 * leaving out what this project already links.
 */
import { describe, expect, it } from 'vitest'
import type { SkillContent, SkillFileInfo, SkillInfo, SkillLibraryInfo, SkillSpec } from '../../shared/types'
import { fixtureProject, role } from './configTestUtil'
import { grantedInProject, skillDetailLines, skillLibraryOptions, skillRoleOptions, skillRowSegs, skillRows, type SkillsData } from './skillsModel'
import { textWidth } from './panes/text'

const file = (path: string, bytes = 100): SkillFileInfo => ({ path, bytes })

const skill = (over: Partial<SkillSpec> & Pick<SkillSpec, 'id' | 'name'> & { grantedTo?: string[]; libraryMissing?: true }): SkillInfo => ({
  spec: {
    id: over.id,
    name: over.name,
    description: over.description ?? 'Use it for this work.',
    enabled: over.enabled ?? true,
    source: over.source ?? 'user',
    digest: over.digest ?? 'digest',
    files: over.files ?? [file('SKILL.md')],
    addedAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...(over.libraryId ? { libraryId: over.libraryId } : {})
  },
  grantedTo: over.grantedTo ?? [],
  ...(over.libraryMissing ? { libraryMissing: true } : {})
})

const entry = (id: string, name: string, description?: string): SkillLibraryInfo => ({
  entry: { id, name, description: description ?? '', source: 'user', digest: 'digest', files: [file('SKILL.md')], addedAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' },
  usedBy: []
})

const content = (body: string, files: SkillFileInfo[] = [file('SKILL.md', 200)]): SkillContent => ({ skillMd: `---\nname: x\n---\n${body}`, body, files })

const data = (skills: SkillInfo[], project = fixtureProject()): SkillsData => ({ project, skills })
const joined = (segs: { text: string }[]): string => segs.map((s) => s.text).join('')

describe('skillRows', () => {
  it('one row per skill, sorted by name whatever the case', () => {
    const rows = skillRows(data([skill({ id: 'a', name: 'zeta' }), skill({ id: 'b', name: 'Alpha' }), skill({ id: 'c', name: 'Beta' })]))
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Beta', 'zeta'])
  })

  it('says on or off', () => {
    const rows = skillRows(data([skill({ id: 'a', name: 'Docs' }), skill({ id: 'b', name: 'Search', enabled: false })]))
    expect(rows.map((r) => r.state)).toEqual(['on', 'off'])
  })

  it('names no role, one role, two roles, and counts three or more', () => {
    const rows = skillRows(data([skill({ id: 'a', name: 'none' }), skill({ id: 'b', name: 'one', grantedTo: ['lead'] }), skill({ id: 'c', name: 'two', grantedTo: ['lead', 'dev'] }), skill({ id: 'd', name: 'three', grantedTo: ['lead', 'dev', 'qa'] })]))
    // Rows are by name: none, one, three, two.
    expect(rows.map((r) => r.name)).toEqual(['none', 'one', 'three', 'two'])
    expect(rows.map((r) => r.roles)).toEqual(['no role', 'Lead', '3 roles', 'Lead, Dev'])
  })

  it('ignores a granted id this project does not have as a role', () => {
    const rows = skillRows(data([skill({ id: 'a', name: 'one', grantedTo: ['lead', 'ghost'] })]))
    expect(rows[0].roles).toBe('Lead')
    expect(rows[0].flags).toEqual([])
    const gone = skillRows(data([skill({ id: 'b', name: 'orphan', grantedTo: ['ghost'] })]))
    expect(gone[0].roles).toBe('no role')
    expect(gone[0].flags).toEqual(['no agent can load it'])
  })

  it('shows the flags in their order', () => {
    const rows = skillRows(data([skill({ id: 'a', name: 'gone', libraryId: 'l1', libraryMissing: true })]))
    expect(rows[0].flags).toEqual(['library entry gone', 'no agent can load it'])
  })

  it('flags nothing for a skill that is off but a role holds', () => {
    const rows = skillRows(data([skill({ id: 'a', name: 'quiet', enabled: false, grantedTo: ['lead'] }), skill({ id: 'b', name: 'held', grantedTo: ['dev', 'qa'] })]))
    expect(rows.map((r) => r.flags)).toEqual([[], []])
  })
})

describe('grantedInProject', () => {
  it('keeps the project role order and drops ids the project does not have', () => {
    const p = fixtureProject()
    expect(grantedInProject(p, ['intern', 'lead'])).toEqual(['lead', 'intern'])
    expect(grantedInProject(p, ['lead', 'ghost'])).toEqual(['lead'])
    expect(grantedInProject(p, [])).toEqual([])
    expect(grantedInProject(p, ['ghost'])).toEqual([])
  })
})

describe('skillRowSegs', () => {
  const rows = skillRows(data([skill({ id: 'a', name: 'a-skill-name-long-enough', enabled: false, libraryId: 'l1', libraryMissing: true }), skill({ id: 'b', name: 'Docs', grantedTo: ['lead', 'dev'] })]))
  const nameWidth = Math.min(28, Math.max(...rows.map((r) => textWidth(r.name))))

  it('keeps every part at 120 columns, flags last', () => {
    const line = joined(skillRowSegs(rows[0], 120, nameWidth, ' · ', '…', false))
    expect(line).toContain('a-skill-name-long-enough')
    expect(line).toContain('off · no role · library entry gone · no agent can load it')
    expect(textWidth(line)).toBeLessThanOrEqual(120)
  })

  it('never exceeds the width at 40 or at 120 columns', () => {
    for (const width of [40, 120]) {
      for (const row of rows) {
        for (const selected of [false, true]) {
          expect(textWidth(joined(skillRowSegs(row, width, nameWidth, ' · ', '…', selected)))).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  it('drops the flags, then the roles, before it cuts the name', () => {
    const at40 = joined(skillRowSegs(rows[0], 40, nameWidth, ' · ', '…', false))
    expect(at40).toContain('off')
    expect(at40).not.toContain('no agent can load it')
    expect(at40).not.toContain('library entry gone')
    expect(at40).not.toContain('no role')
    const at20 = joined(skillRowSegs(rows[0], 20, nameWidth, ' · ', '…', false))
    expect(at20.endsWith('…')).toBe(true)
    const marked = skillRowSegs(rows[1], 120, nameWidth, ' · ', '…', true)
    expect(marked[0].text).toBe('> ')
    expect(marked[0].tone).toBe('accent')
    expect(joined(marked)).toContain('Lead, Dev')
  })
})

describe('skillDetailLines', () => {
  it('lists the facts of one skill, its files, its description, then its text', () => {
    const project = fixtureProject({ roles: [role({ id: 'lead', reportsTo: null }), role({ id: 'dev' })] })
    const lines = skillDetailLines(data([skill({ id: 's1', name: 'Docs', description: 'Reads the docs.', grantedTo: ['dev', 'lead'], files: [file('SKILL.md'), file('scripts/fill.py', 900)] })], project), 's1', content('Use it when the docs matter.\n\nRead one file at a time.'))
    expect(lines).toEqual([
      'Docs',
      'state: on',
      'granted to: Lead, Dev',
      'source: this project',
      'files: 2',
      '  SKILL.md',
      '  scripts/fill.py',
      '',
      'Reads the docs.',
      '',
      'SKILL.md',
      'Use it when the docs matter.',
      '',
      'Read one file at a time.'
    ])
  })

  it('says no role, shows the library entry, and ends with the loading line while the text is out', () => {
    const lines = skillDetailLines(data([skill({ id: 's2', name: 'Notion', enabled: false, libraryId: 'l9', grantedTo: ['ghost'] })]), 's2', undefined)
    expect(lines).toContain('state: off')
    expect(lines).toContain('granted to: no role')
    expect(lines).toContain('source: library entry l9')
    expect(lines.at(-1)).toBe('Loading the text...')
    expect(skillDetailLines(data([]), 'nope', undefined)).toEqual(['This skill is gone.'])
  })

  it('ends with the failed line when the text could not be read', () => {
    const lines = skillDetailLines(data([skill({ id: 's6', name: 'Broken' })]), 's6', 'failed')
    expect(lines.at(-1)).toBe('The text could not be read.')
    expect(lines).not.toContain('Loading the text...')
    expect(lines).not.toContain('SKILL.md')
    expect(skillDetailLines(data([]), 'nope', 'failed')).toEqual(['This skill is gone.'])
  })

  it('shows at most 40 lines of the body and counts the rest, each line cut to 300 characters', () => {
    const many = Array.from({ length: 45 }, (_u, i) => `line ${i + 1}`).join('\n')
    const lines = skillDetailLines(data([skill({ id: 's3', name: 'Long' })]), 's3', content(many))
    const body = lines.slice(lines.indexOf('SKILL.md') + 1)
    expect(body[0]).toBe('line 1')
    expect(body[39]).toBe('line 40')
    expect(body[40]).toBe('... (5 more lines)')
    expect(body).toHaveLength(41)
    const long = skillDetailLines(data([skill({ id: 's4', name: 'Wide' })]), 's4', content(`${'x'.repeat(400)}\ny`))
    expect(long.at(-2)).toBe(`${'x'.repeat(299)}…`)
    expect(long.at(-1)).toBe('y')
  })

  it('lists at most 20 files and counts the rest', () => {
    const files = Array.from({ length: 25 }, (_u, i) => file(`f${i + 1}.md`))
    const lines = skillDetailLines(data([skill({ id: 's5', name: 'Many', files })]), 's5', undefined)
    expect(lines).toContain('files: 25')
    expect(lines).toContain('  f20.md')
    expect(lines).not.toContain('  f21.md')
    expect(lines).toContain('  ... and 5 more')
  })
})

describe('skillRoleOptions', () => {
  it('offers one option per role, by id', () => {
    expect(skillRoleOptions(fixtureProject())).toEqual([
      { value: 'lead', label: 'Lead' },
      { value: 'dev', label: 'Dev' },
      { value: 'qa', label: 'Qa' },
      { value: 'intern', label: 'Intern' }
    ])
  })
})

describe('skillLibraryOptions', () => {
  it('leaves out the entries this project already links and sorts the rest by name', () => {
    const options = skillLibraryOptions([entry('l1', 'Zeta'), entry('l2', 'Docs'), entry('l3', 'Notion', 'Reads and writes Notion pages.')], [skill({ id: 's1', name: 'Zeta', libraryId: 'l1' })])
    expect(options.map((o) => o.value)).toEqual(['l2', 'l3'])
    expect(options.map((o) => o.label)).toEqual(['Docs', 'Notion'])
    expect(options[0].detail).toBe('')
    expect(options[1].detail).toBe('Reads and writes Notion pages.')
  })
})
