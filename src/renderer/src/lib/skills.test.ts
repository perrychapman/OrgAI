import { describe, expect, it } from 'vitest'
import type { SkillInfo, SkillSpec } from '@shared/types'
import {
  buildSkillChoices,
  codeSpans,
  defaultIncluded,
  draftProblems,
  droppedKeysLine,
  droppedKeysOf,
  evaluationAnnouncement,
  evaluationSummary,
  evaluationToggleLabel,
  evidenceLines,
  grantSummary,
  hasDraftProblems,
  importBannerLine,
  importFoundLine,
  importNotImportedCount,
  isBodyRefusal,
  libraryRemoveLines,
  loadableByNoRole,
  openSuggestionCount,
  projectProvenance,
  promotedNotice,
  readSkillBannerMemory,
  refusedSkillsLine,
  removeConfirmCopy,
  severityOrder,
  skillActivityText,
  skillAddedNotice,
  skillBannerVisible,
  skillElevatedHint,
  skillImportedSummary,
  skillUseLine,
  skillUseTotal,
  skippedReasonText,
  sortFindings,
  sourceLabel,
  usedByLine,
  usedByList,
  writeSkillBannerMemory
} from './skills'

const roles = [
  { id: 'a', name: 'Writer' },
  { id: 'b', name: 'QA' },
  { id: 'c', name: 'Dev' },
  { id: 'd', name: 'Lead' }
]
const info = (name: string, grantedTo: string[]): SkillInfo => ({
  spec: { id: 's', name } as SkillSpec,
  grantedTo
})

describe('labels', () => {
  it('names sources', () => {
    expect(sourceLabel('repo')).toBe('From the repository')
    expect(sourceLabel('library')).toBe('From the library')
  })
  it('summarizes grants', () => {
    expect(grantSummary({ grantedTo: [] }, roles)).toBe('Roles: none')
    expect(grantSummary({ grantedTo: ['a', 'b'] }, roles)).toBe('Roles: Writer, QA')
    expect(grantSummary({ grantedTo: ['a', 'b', 'c', 'd'] }, roles)).toBe('Roles: all 4 roles')
    expect(grantSummary({ grantedTo: ['a', 'x'] }, roles)).toBe('Roles: Writer')
    expect(grantSummary({ grantedTo: ['a', 'b', 'c'] }, roles)).toBe('Roles: Writer, QA, Dev')
    expect(grantSummary({ grantedTo: ['a', 'b', 'c'] }, [...roles, { id: 'e', name: 'E' }])).toBe('Roles: Writer, QA, Dev')
    expect(grantSummary({ grantedTo: ['a', 'b', 'c', 'd'] }, [...roles, { id: 'e', name: 'E' }])).toBe('Roles: 4 roles')
  })
  it('describes library usage', () => {
    expect(usedByLine([])).toBe('Not used by any project')
    expect(
      usedByLine([
        {
          projectId: '1',
          projectName: 'A',
          skillId: 's',
          roleNames: ['Writer', 'QA']
        },
        { projectId: '2', projectName: 'B', skillId: 's', roleNames: [] }
      ])
    ).toBe('Used by 2 projects: A (Writer, QA), B')
    expect(usedByLine([{ projectId: '1', projectName: 'A', skillId: 's', roleNames: [] }])).toBe('Used by 1 project: A')
  })
})

describe('removeConfirmCopy', () => {
  it('differs for delete and unlink and names the roles', () => {
    const del = removeConfirmCopy(info('pdf', ['a']), ['Writer'], 'delete')
    expect(del.title).toBe('Delete pdf?')
    expect(del.confirmLabel).toBe('Delete')
    expect(del.body).toContain('Writer will lose access')
    const un = removeConfirmCopy(info('pdf', []), [], 'unlink')
    expect(un.confirmLabel).toBe('Unlink')
    expect(un.body).toContain('stays in the library')
    expect(un.body).not.toContain('lose access')
  })
})

describe('draftProblems', () => {
  it('flags every field', () => {
    const p = draftProblems({ name: 'Bad Name', description: '', body: ' ' })
    expect(p.name).toBeTruthy()
    expect(p.description).toBeTruthy()
    expect(p.body).toBe('A skill needs instructions.')
    expect(hasDraftProblems(p)).toBe(true)
  })
  it('accepts a good draft and rejects a huge body', () => {
    expect(
      hasDraftProblems(
        draftProblems({
          name: 'api-design',
          description: 'Use for APIs',
          body: 'Do it.'
        })
      )
    ).toBe(false)
    expect(
      draftProblems({
        name: 'api-design',
        description: 'x',
        body: 'a'.repeat(100_001)
      }).body
    ).toContain('too long')
  })
})

describe('hints and findings', () => {
  it('hints on scripts', () => {
    expect(skillElevatedHint([])).toBeNull()
    expect(skillElevatedHint(['scripts/a.sh'])).toBe('Includes scripts; may run shell commands')
  })
  it('orders warnings first, stable', () => {
    expect(severityOrder('warning')).toBeLessThan(severityOrder('info'))
    const f = (id: string, severity: 'info' | 'warning') => ({
      id,
      kind: 'stale' as const,
      severity,
      skillIds: [],
      title: id,
      detail: ''
    })
    expect(sortFindings([f('1', 'info'), f('2', 'warning'), f('3', 'info')]).map((x) => x.id)).toEqual(['2', '1', '3'])
  })
  it('words skipped reasons', () => {
    expect(skippedReasonText(undefined)).toBeNull()
    expect(skippedReasonText('disabled')).toContain('off')
    expect(skippedReasonText('no-gaps')).toContain('No repeated work')
    expect(skippedReasonText('budget')).toContain('token budget')
    expect(skippedReasonText('error', 'boom')).toContain('boom')
    expect(skippedReasonText('error')).toContain('failed.')
  })
  it('summarizes an evaluation', () => {
    const at = new Date(2026, 4, 3, 14, 5).getTime()
    const s = (suggestions: { appliedSkillId?: string }[]) =>
      evaluationSummary(
        {
          at,
          findings: [{} as never, {} as never],
          suggestions: suggestions as never
        },
        new Date(2026, 5, 1).getTime()
      )
    expect(s([{ appliedSkillId: 'x' }])).toBe('Checked May 3, 14:05 · 2 findings · 1 suggestion · 1 applied')
    expect(s([])).toBe('Checked May 3, 14:05 · 2 findings · 0 suggestions')
  })
})

describe('import', () => {
  const item = (o: object) => ({ key: 'k', root: '.claude/skills', action: 'add', ...o }) as never
  it('words the found line and counts', () => {
    expect(importFoundLine({ items: [] })).toBeNull()
    expect(importFoundLine({ items: [item({}), item({}), item({})] })).toBe('Found 3 skills in .claude/skills.')
    expect(importFoundLine({ items: [item({}), item({ root: '.agents/skills' })] })).toBe('Found 2 skills in .claude/skills and .agents/skills.')
    expect(
      importNotImportedCount({
        items: [item({}), item({ action: 'update' }), item({ action: 'unchanged' }), item({ action: 'skip' })]
      })
    ).toBe(2)
    expect(importNotImportedCount(null)).toBe(0)
  })
  it('includes by default only clean add/update', () => {
    expect(defaultIncluded({ action: 'add' })).toBe(true)
    expect(defaultIncluded({ action: 'add', nameConflict: true })).toBe(false)
    expect(defaultIncluded({ action: 'unchanged' })).toBe(false)
  })
  it('builds choices from edits', () => {
    expect(
      buildSkillChoices({
        a: { include: false },
        b: { roleIds: ['r'] },
        c: {}
      })
    ).toEqual([
      { key: 'a', include: false },
      { key: 'b', include: true, roleIds: ['r'] },
      { key: 'c', include: true }
    ])
  })
  it('summarizes an import', () => {
    expect(skillImportedSummary(1, 0)).toBe('Imported 1 skill.')
    expect(skillImportedSummary(1, 2)).toBe('Imported 3 skills (2 updated).')
  })
  it('remembers banner dismissal per project', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v)
    }
    expect(readSkillBannerMemory(storage, 'p')).toBeNull()
    writeSkillBannerMemory(storage, 'p', 'dismissed')
    expect(readSkillBannerMemory(storage, 'p')).toBe('dismissed')
    expect(readSkillBannerMemory(storage, 'q')).toBeNull()
    expect(readSkillBannerMemory(undefined, 'p')).toBeNull()
    expect(skillBannerVisible(2, null)).toBe(true)
    expect(skillBannerVisible(2, 'dismissed')).toBe(false)
    expect(skillBannerVisible(0, null)).toBe(false)
  })
})

describe('usage text', () => {
  it('lists loads', () => {
    const s = [
      { skillId: '1', name: 'api-design', loads: 3, roles: [] },
      { skillId: '2', name: 'pdf', loads: 1, roles: [] }
    ]
    expect(skillUseLine(s)).toBe('api-design x3, pdf')
    expect(skillUseLine(s, 1)).toBe('api-design x3, +1 more')
    expect(skillUseLine(undefined)).toBe('')
    expect(skillUseTotal(s)).toBe(4)
    expect(skillActivityText('pdf')).toBe('Loaded skill pdf')
  })
})

describe('evaluation results', () => {
  const report = {
    findings: [{}, {}] as never[],
    suggestions: [{ id: 'a' }, { id: 'b', appliedSkillId: 's' }] as never[]
  }
  it('labels the disclosure and the live region', () => {
    expect(evaluationToggleLabel(report, false)).toBe('Show 2 findings, 2 suggestions')
    expect(evaluationToggleLabel(report, true)).toBe('Hide 2 findings, 2 suggestions')
    expect(evaluationToggleLabel({ findings: [], suggestions: [] }, false)).toBe('Show no findings')
    expect(evaluationAnnouncement({ findings: [{}] as never[], suggestions: [] })).toBe('Evaluation finished, 1 finding, 0 suggestions')
  })
  it('counts open suggestions', () => {
    expect(openSuggestionCount(report)).toBe(1)
    expect(openSuggestionCount(report, new Set(['a']))).toBe(0)
    expect(openSuggestionCount(null)).toBe(0)
  })
  it('merges count and runs into one evidence line', () => {
    expect(evidenceLines({ count: 3, runIds: ['1', '2', '3'] })).toEqual(['Seen 3 times in 3 runs'])
    expect(evidenceLines({ count: 1 })).toEqual(['Seen 1 time'])
    expect(evidenceLines({ runIds: ['1'] })).toEqual(['In 1 run'])
    expect(evidenceLines(undefined)).toEqual([])
  })
})

describe('role access wording', () => {
  const spec = (enabled: boolean): SkillSpec => ({ id: 's', name: 'x', enabled }) as SkillSpec
  it('flags an enabled skill nobody can load', () => {
    expect(loadableByNoRole({ spec: spec(true), grantedTo: [] }, roles)).toBe(true)
    expect(loadableByNoRole({ spec: spec(true), grantedTo: ['zz'] }, roles)).toBe(true)
    expect(loadableByNoRole({ spec: spec(true), grantedTo: ['a'] }, roles)).toBe(false)
    expect(loadableByNoRole({ spec: spec(false), grantedTo: [] }, roles)).toBe(false)
    expect(loadableByNoRole({ spec: spec(true), grantedTo: [], libraryMissing: true }, roles)).toBe(false)
  })
  it('says so in the success notice', () => {
    expect(skillAddedNotice('pdf', 'created', 0).tone).toBe('warning')
    expect(skillAddedNotice('pdf', 'created', 0).body).toContain('No role can load it')
    expect(skillAddedNotice('pdf', 'added', 2)).toMatchObject({
      tone: 'success',
      body: '2 roles can load it.'
    })
  })
  it('words promotion and provenance', () => {
    expect(promotedNotice('pdf')).toBe('pdf is now in the library. Edits happen there.')
    expect(projectProvenance({ libraryId: 'l', source: 'library' })).toBe('Library')
    expect(projectProvenance({ source: 'repo' })).toBe('From the repository')
  })
})

describe('library remove copy', () => {
  const usedBy = [
    {
      projectId: '1',
      projectName: 'Atlas',
      skillId: 's',
      roleNames: ['Writer', 'QA']
    },
    {
      projectId: '1',
      projectName: 'Atlas',
      skillId: 't',
      roleNames: ['QA', 'Dev']
    },
    {
      projectId: '2',
      projectName: 'Borealis',
      skillId: 's',
      roleNames: ['Lead']
    },
    { projectId: '3', projectName: 'Cirrus', skillId: 's', roleNames: [] }
  ]
  it('names the roles per project from usedBy', () => {
    expect(libraryRemoveLines(usedBy)).toEqual(['Atlas: Writer, QA and Dev lose access.', 'Borealis: Lead loses access.', 'Cirrus: no role holds it.'])
    expect(libraryRemoveLines([])).toEqual([])
    expect(usedByList(usedBy).map((p) => p.projectName)).toEqual(['Atlas', 'Borealis', 'Cirrus'])
  })
})

describe('import wording', () => {
  it('names the counts once', () => {
    expect(importBannerLine(2, 1, ['.claude/skills'])).toBe('Skills in .claude/skills: 2 can be imported, 1 cannot.')
    expect(importBannerLine(1, 0, [])).toBe('Skills: 1 can be imported.')
    expect(refusedSkillsLine(1)).toBe('1 skill in the repository cannot be imported.')
  })
  it('reads dropped keys from importer notes', () => {
    expect(droppedKeysOf(['Dropped frontmatter keys: allowed-tools, hooks.'])).toEqual(['allowed-tools', 'hooks'])
    expect(droppedKeysOf(['Something else'])).toEqual([])
    expect(droppedKeysLine('deploy-check', ['allowed-tools', 'hooks'])).toBe('deploy-check: dropped allowed-tools, hooks, which OrgAI does not run')
  })
  it('finds the shell-injection refusal and its code span', () => {
    expect(isBodyRefusal('Runs shell commands when loaded (!`...`), which OrgAI does not allow.')).toBe(true)
    expect(isBodyRefusal('Name is taken')).toBe(false)
    expect(codeSpans('Runs (!`...`), no.')).toEqual([
      { text: 'Runs (', code: false },
      { text: '!`...`', code: true },
      { text: '), no.', code: false }
    ])
  })
})
