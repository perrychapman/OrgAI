import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ENGAGEMENT_DOCUMENT_PROMPT_MAX_CHARS } from '@shared/types'
import { appRulesFile, engagementDocumentFile, projectDataDir, projectRulesFile, readEngagementDocument, removeProjectData } from './projectData'

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

describe('removeProjectData', () => {
  it('removes the project data dir, ignores a missing one and an unsafe id', () => {
    writeDoc('hello')
    removeProjectData(dir, 'p1')
    expect(readEngagementDocument(dir, 'p1')).toBeUndefined()
    expect(() => removeProjectData(dir, 'p1')).not.toThrow()
    expect(() => removeProjectData(dir, '../..')).not.toThrow()
  })
})
