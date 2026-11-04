import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENGAGEMENT_DOCUMENT_MAX_CHARS, ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS, ENGAGEMENT_NOTES_MAX, ENGAGEMENT_NOTE_MAX_CHARS, ENGAGEMENT_NOTE_TITLE_MAX_CHARS } from '@shared/types'
import {
  appRulesExist,
  appRulesFile,
  contextDir,
  engagementDocumentExists,
  engagementDocumentFile,
  listNotes,
  orphanRunProjects,
  readRetainedRunProjects,
  retainRunProject,
  projectDataDir,
  projectRulesFile,
  readEngagementDocument,
  readEngagementDocumentInfo,
  readNote,
  removeNote,
  removeProjectData,
  removeSkillEvaluation,
  saveNote,
  skillEvaluationFile,
  teamReviewFile,
  engagementMetaFile,
  updateEngagementDocument,
  writeEngagementDocument,
  writeEngagementDocumentFromSetup
} from './projectData'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-pd-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const writeDoc = (text: string): void => {
  mkdirSync(projectDataDir(dir, 'p1'), { recursive: true })
  writeFileSync(engagementDocumentFile(dir, 'p1'), text, 'utf8')
}

describe('projectData paths', () => {
  it('builds the three paths under <data>/projects/<id>', () => {
    expect(projectDataDir(dir, 'p1')).toBe(join(dir, 'projects', 'p1'))
    expect(engagementDocumentFile(dir, 'p1')).toBe(join(dir, 'projects', 'p1', 'ENGAGEMENT.md'))
    expect(appRulesFile(dir, 'p1')).toBe(join(dir, 'projects', 'p1', 'permission-rules.json'))
  })

  it('throws on an unsafe id', () => {
    for (const id of ['', '..', '../x', 'a/b', 'a\\b']) expect(() => projectDataDir(dir, id)).toThrow()
  })

  it('puts the rules file in the folder for code and in the data dir for engagements', () => {
    const base = { id: 'p1', path: join(dir, 'repo') }
    expect(projectRulesFile({ ...base, kind: 'code' }, dir)).toBe(join(dir, 'repo', '.claude', 'settings.local.json'))
    expect(projectRulesFile(base, dir)).toBe(join(dir, 'repo', '.claude', 'settings.local.json'))
    expect(projectRulesFile({ ...base, kind: 'engagement' }, dir)).toBe(appRulesFile(dir, 'p1'))
  })
})

describe('readEngagementDocument', () => {
  it('is undefined when missing, empty or blank', () => {
    expect(readEngagementDocument(dir, 'p1')).toBeUndefined()
    writeDoc('')
    expect(readEngagementDocument(dir, 'p1')).toBeUndefined()
    writeDoc('  \n ')
    expect(readEngagementDocument(dir, 'p1')).toBeUndefined()
  })

  it('returns the text and strips a BOM', () => {
    writeDoc('﻿# Scope')
    expect(readEngagementDocument(dir, 'p1')).toBe('# Scope')
  })

  it('cuts at the cap with a note', () => {
    writeDoc('x'.repeat(ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS + 50))
    const text = readEngagementDocument(dir, 'p1')!
    expect(text.startsWith('x'.repeat(ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS))).toBe(true)
    expect(text).toContain('truncated')
    writeDoc('x'.repeat(ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS))
    expect(readEngagementDocument(dir, 'p1')).toBe('x'.repeat(ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS))
  })

  it('is undefined when the path is a directory, and for an unsafe id', () => {
    mkdirSync(engagementDocumentFile(dir, 'p1'), { recursive: true })
    expect(readEngagementDocument(dir, 'p1')).toBeUndefined()
    expect(readEngagementDocument(dir, '../x')).toBeUndefined()
  })
})

describe('engagement document (whole file)', () => {
  it('reads nothing when missing, the whole text beyond the prompt cap otherwise', () => {
    expect(readEngagementDocumentInfo(dir, 'p1')).toEqual({ text: '' })
    expect(readEngagementDocumentInfo(dir, '../x')).toEqual({ text: '' })
    const big = 'x'.repeat(ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS + 500)
    writeDoc(big)
    const info = readEngagementDocumentInfo(dir, 'p1')
    expect(info.text).toBe(big)
    expect(typeof info.updatedAt).toBe('number')
  })

  it('writes atomically, replaces, and leaves no temp files', () => {
    expect(writeEngagementDocument(dir, 'p1', 'Line 1\n\tLine 2\r\n').text).toBe('Line 1\n\tLine 2\r\n')
    writeEngagementDocument(dir, 'p1', 'Second')
    expect(readEngagementDocumentInfo(dir, 'p1').text).toBe('Second')
    expect(readdirSync(projectDataDir(dir, 'p1')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('refuses text over the cap (never cuts) and hidden characters, keeping the old file', () => {
    writeEngagementDocument(dir, 'p1', 'keep')
    expect(() => writeEngagementDocument(dir, 'p1', 'x'.repeat(ENGAGEMENT_DOCUMENT_MAX_CHARS + 1))).toThrow(/longer than/)
    expect(() => writeEngagementDocument(dir, 'p1', 'a​b')).toThrow(/hidden character/)
    expect(() => writeEngagementDocument(dir, 'p1', 'a\u0007b')).toThrow(/hidden character/)
    expect(() => writeEngagementDocument(dir, 'p1', 'x'.repeat(ENGAGEMENT_DOCUMENT_MAX_CHARS))).not.toThrow()
    writeEngagementDocument(dir, 'p1', 'keep')
    expect(() => writeEngagementDocument(dir, 'p1', 42 as unknown as string)).toThrow()
    expect(readEngagementDocumentInfo(dir, 'p1').text).toBe('keep')
  })

  it('empty text deletes the file', () => {
    writeEngagementDocument(dir, 'p1', 'something')
    expect(engagementDocumentExists(dir, 'p1')).toBe(true)
    expect(writeEngagementDocument(dir, 'p1', '  \n')).toEqual({ text: '' })
    expect(engagementDocumentExists(dir, 'p1')).toBe(false)
    expect(() => writeEngagementDocument(dir, 'p1', '')).not.toThrow()
  })

  it('refuses an unsafe project id', () => {
    expect(() => writeEngagementDocument(dir, '../x', 'hi')).toThrow()
  })

  it('refuses to write through a linked project folder', () => {
    const outside = mkdtempSync(join(tmpdir(), 'orgai-pd-out-'))
    try {
      mkdirSync(join(dir, 'projects'), { recursive: true })
      try {
        symlinkSync(outside, projectDataDir(dir, 'p1'), 'junction')
      } catch {
        return // no link support here
      }
      expect(() => writeEngagementDocument(dir, 'p1', 'hi')).toThrow()
      expect(readdirSync(outside)).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('engagement document sidecar and stale saves', () => {
  it('records who wrote it and when, for both writers', () => {
    expect(updateEngagementDocument(dir, 'p1', 'mine', undefined)).toMatchObject({ text: 'mine', updatedBy: 'user' })
    const a = readEngagementDocumentInfo(dir, 'p1')
    expect(a.updatedAt).toBeGreaterThan(0)
    expect(JSON.parse(readFileSync(engagementMetaFile(dir, 'p1'), 'utf8'))).toEqual({ updatedAt: a.updatedAt, updatedBy: 'user' })
    writeEngagementDocumentFromSetup(dir, 'p1', '# Charter')
    const b = readEngagementDocumentInfo(dir, 'p1')
    expect(b).toMatchObject({ text: '# Charter', updatedBy: 'setup' })
    expect(b.updatedAt!).toBeGreaterThan(a.updatedAt!)
  })

  it('falls back to the mtime and setup without a sidecar, and ignores a junk sidecar', () => {
    writeDoc('old')
    expect(readEngagementDocumentInfo(dir, 'p1')).toMatchObject({ text: 'old', updatedBy: 'setup' })
    writeFileSync(engagementMetaFile(dir, 'p1'), '{ nope')
    expect(readEngagementDocumentInfo(dir, 'p1').updatedBy).toBe('setup')
    writeFileSync(engagementMetaFile(dir, 'p1'), JSON.stringify({ updatedAt: 5, updatedBy: 'robot' }))
    expect(readEngagementDocumentInfo(dir, 'p1').updatedBy).toBe('setup')
  })

  it('refuses a stale or omitted expectedUpdatedAt and accepts the current one', () => {
    expect(() => updateEngagementDocument(dir, 'p1', 'x', 123)).toThrow(/changed since you opened it/)
    updateEngagementDocument(dir, 'p1', 'v1', 0)
    expect(() => updateEngagementDocument(dir, 'p1', 'v2', undefined)).toThrow(/changed since/)
    const t = readEngagementDocumentInfo(dir, 'p1').updatedAt!
    expect(() => updateEngagementDocument(dir, 'p1', 'v2', t - 1)).toThrow(/changed since/)
    updateEngagementDocument(dir, 'p1', 'v2', t)
    expect(readEngagementDocumentInfo(dir, 'p1').text).toBe('v2')
    // A setup write in between makes the editor's copy stale.
    writeEngagementDocumentFromSetup(dir, 'p1', 'from setup')
    expect(() => updateEngagementDocument(dir, 'p1', 'v3', t)).toThrow(/changed since/)
    expect(readEngagementDocumentInfo(dir, 'p1').text).toBe('from setup')
  })

  it('deleting the document removes the sidecar so a new editor starts from 0', () => {
    updateEngagementDocument(dir, 'p1', 'v1', 0)
    updateEngagementDocument(dir, 'p1', '', readEngagementDocumentInfo(dir, 'p1').updatedAt)
    expect(readEngagementDocumentInfo(dir, 'p1')).toEqual({ text: '' })
    expect(() => updateEngagementDocument(dir, 'p1', 'again', undefined)).not.toThrow()
  })
})

describe('context notes', () => {
  it('creates, lists (newest first), reads, replaces and removes', async () => {
    const a = saveNote(dir, 'p1', { title: ' First ', text: 'alpha' })
    expect(a.id).toMatch(/^note_[0-9a-f]{12}$/)
    expect(a).toMatchObject({ title: 'First', chars: 5 })
    await new Promise((r) => setTimeout(r, 5))
    const b = saveNote(dir, 'p1', { title: 'Second', text: 'bravo\nline' })
    expect(listNotes(dir, 'p1').map((n) => n.id)).toEqual([b.id, a.id])
    expect(readNote(dir, 'p1', a.id)).toMatchObject({ id: a.id, title: 'First', text: 'alpha', chars: 5 })
    const a2 = saveNote(dir, 'p1', { noteId: a.id, title: 'First v2', text: 'alpha two' })
    expect(a2.id).toBe(a.id)
    expect(listNotes(dir, 'p1')).toHaveLength(2)
    expect(readNote(dir, 'p1', a.id)!.text).toBe('alpha two')
    const rest = removeNote(dir, 'p1', a.id)
    expect(rest.map((n) => n.id)).toEqual([b.id])
    expect(readNote(dir, 'p1', a.id)).toBeNull()
    expect(removeNote(dir, 'p1', 'note_nope').map((n) => n.id)).toEqual([b.id])
  })

  it('throws for an unknown noteId on save', () => {
    expect(() => saveNote(dir, 'p1', { noteId: 'note_deadbeef', title: 't', text: 'x' })).toThrow('Note not found')
    expect(() => saveNote(dir, 'p1', { noteId: '../x', title: 't', text: 'x' })).toThrow('Note not found')
  })

  it('enforces title, text and count limits', () => {
    expect(() => saveNote(dir, 'p1', { title: '   ', text: 'x' })).toThrow(/title/)
    expect(() => saveNote(dir, 'p1', { title: 'x'.repeat(ENGAGEMENT_NOTE_TITLE_MAX_CHARS + 1), text: 'x' })).toThrow(/title/)
    expect(() => saveNote(dir, 'p1', { title: 'a​b', text: 'x' })).toThrow(/hidden/)
    expect(() => saveNote(dir, 'p1', { title: 'a\nb', text: 'x' })).toThrow(/hidden/)
    expect(() => saveNote(dir, 'p1', { title: 't', text: 'x'.repeat(ENGAGEMENT_NOTE_MAX_CHARS + 1) })).toThrow(/longer than/)
    expect(() => saveNote(dir, 'p1', { title: 't', text: 'a‮b' })).toThrow(/hidden/)
    expect(() => saveNote(dir, 'p1', { title: 't', text: 'tab\there\r\nok' })).not.toThrow()
    expect(() => saveNote(dir, 'p1', { title: 'big', text: 'x'.repeat(ENGAGEMENT_NOTE_MAX_CHARS) })).not.toThrow()
    for (let i = 0; i < ENGAGEMENT_NOTES_MAX - 2; i++) saveNote(dir, 'p1', { title: `n${i}`, text: 'x' })
    expect(listNotes(dir, 'p1')).toHaveLength(ENGAGEMENT_NOTES_MAX)
    expect(() => saveNote(dir, 'p1', { title: 'one more', text: 'x' })).toThrow(/at most 50/)
    // Replacing at the cap still works.
    const first = listNotes(dir, 'p1')[0]
    expect(() => saveNote(dir, 'p1', { noteId: first.id, title: 'again', text: 'y' })).not.toThrow()
  })

  it('ignores a note file with no index entry and drops an entry whose file is missing', () => {
    const a = saveNote(dir, 'p1', { title: 'A', text: 'a' })
    const b = saveNote(dir, 'p1', { title: 'B', text: 'b' })
    writeFileSync(join(contextDir(dir, 'p1'), 'note_orphan01.md'), 'orphan', 'utf8')
    rmSync(join(contextDir(dir, 'p1'), `${b.id}.md`))
    expect(listNotes(dir, 'p1').map((n) => n.id)).toEqual([a.id])
    expect(readNote(dir, 'p1', 'note_orphan01')).toBeNull()
    expect(readNote(dir, 'p1', b.id)).toBeNull()
    // The next save keeps only live entries.
    saveNote(dir, 'p1', { title: 'C', text: 'c' })
    expect(listNotes(dir, 'p1')).toHaveLength(2)
  })

  it('survives a junk index and junk entries', () => {
    const a = saveNote(dir, 'p1', { title: 'A', text: 'a' })
    writeFileSync(join(contextDir(dir, 'p1'), 'index.json'), '{ nope', 'utf8')
    expect(listNotes(dir, 'p1')).toEqual([])
    writeFileSync(join(contextDir(dir, 'p1'), 'index.json'), JSON.stringify({ notes: [null, 5, { id: '../x' }, { id: a.id, title: '', updatedAt: 1 }, { id: a.id, title: 'ok', updatedAt: 1, chars: 1 }] }), 'utf8')
    expect(listNotes(dir, 'p1').map((n) => n.title)).toEqual(['ok'])
  })

  it('leaves no temp files and never throws on listing an unsafe id', () => {
    saveNote(dir, 'p1', { title: 'A', text: 'a' })
    expect(readdirSync(contextDir(dir, 'p1')).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(listNotes(dir, '../x')).toEqual([])
    expect(readNote(dir, '../x', 'note_a')).toBeNull()
  })
})

describe('file helpers for project removal', () => {
  it('removes the skill evaluation file and reports whether it existed', () => {
    mkdirSync(join(dir, 'skill-evaluations'), { recursive: true })
    writeFileSync(join(dir, 'skill-evaluations', 'p1.json'), '{}')
    expect(removeSkillEvaluation(dir, 'p1')).toBe(true)
    expect(removeSkillEvaluation(dir, 'p1')).toBe(false)
    expect(removeSkillEvaluation(dir, '../x')).toBe(false)
    expect(skillEvaluationFile(dir, 'p1')).toBe(join(dir, 'skill-evaluations', 'p1.json'))
    expect(teamReviewFile(dir, 'p1')).toBe(join(dir, 'team-reviews', 'p1.json'))
  })

  it('reports the document and rules files', () => {
    expect(engagementDocumentExists(dir, 'p1')).toBe(false)
    expect(appRulesExist(dir, 'p1')).toBe(false)
    writeDoc('x')
    writeFileSync(appRulesFile(dir, 'p1'), '{}')
    expect(engagementDocumentExists(dir, 'p1')).toBe(true)
    expect(appRulesExist(dir, 'p1')).toBe(true)
  })
})

describe('retained run projects', () => {
  it('records ids, ignores repeats, drops junk and unsafe ids on read', () => {
    expect(readRetainedRunProjects(dir).size).toBe(0)
    retainRunProject(dir, 'p1')
    retainRunProject(dir, 'p1')
    retainRunProject(dir, 'p2')
    expect([...readRetainedRunProjects(dir)]).toEqual(['p1', 'p2'])
    expect(() => retainRunProject(dir, '../x')).toThrow()
    writeFileSync(join(dir, 'retained-run-projects.json'), JSON.stringify({ version: 1, projectIds: ['ok', '../x', 5, null, 'ok2'] }))
    expect([...readRetainedRunProjects(dir)]).toEqual(['ok', 'ok2'])
    writeFileSync(join(dir, 'retained-run-projects.json'), '{nope')
    expect(readRetainedRunProjects(dir).size).toBe(0)
  })

  it('orphanRunProjects skips live and retained ids', () => {
    expect(orphanRunProjects(['a', 'b', 'c', 'a'], new Set(['a']), new Set(['b']))).toEqual(['c'])
  })
})

describe('saveNote index failure', () => {
  it('removes a new note file when the index cannot be written', () => {
    mkdirSync(join(contextDir(dir, 'p1'), 'index.json'), { recursive: true })
    expect(() => saveNote(dir, 'p1', { title: 'A', text: 'a' })).toThrow()
    expect(readdirSync(contextDir(dir, 'p1')).filter((f) => f.endsWith('.md'))).toEqual([])
  })
})

describe('removeProjectData', () => {
  it('removes the project data dir, ignores a missing one and an unsafe id', () => {
    writeDoc('hello')
    removeProjectData(dir, 'p1')
    expect(readEngagementDocument(dir, 'p1')).toBeUndefined()
    expect(() => removeProjectData(dir, 'p1')).not.toThrow()
    expect(() => removeProjectData(dir, '../..')).not.toThrow()
  })
})
