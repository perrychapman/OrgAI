import { describe, expect, it } from 'vitest'
import type { ProjectPathCheck } from '@shared/types'
import { effectiveName, pathStatus, submitBlocker } from './projectsForm'

const chk = (o: Partial<ProjectPathCheck> = {}): ProjectPathCheck => ({ exists: true, isDirectory: true, isGitRepo: true, suggestedName: 'app', empty: false, ...o })

describe('pathStatus', () => {
  it('is silent without a path or a check', () => {
    expect(pathStatus('new', '', chk())).toBeNull()
    expect(pathStatus('new', '/x', null)).toBeNull()
  })
  it('flags missing folders and files for existing repos', () => {
    expect(pathStatus('existing', '/x', chk({ exists: false, isDirectory: false }))).toMatchObject({ tone: 'error', blocking: true })
    expect(pathStatus('existing', '/x', chk({ isDirectory: false }))?.text).toMatch(/file/)
  })
  it('accepts a missing folder for a new idea', () => {
    const s = pathStatus('new', '/x/y', chk({ exists: false, isDirectory: false }))
    expect(s?.blocking).toBe(false)
    expect(s?.text).toContain('/x/y')
  })
  it('notes non-git and empty folders without blocking', () => {
    expect(pathStatus('existing', '/x', chk({ isGitRepo: false }))).toMatchObject({ tone: 'warn', blocking: false })
    expect(pathStatus('existing', '/x', chk({ empty: true }))?.blocking).toBe(false)
  })
})

describe('submitBlocker', () => {
  const base = { kind: 'existing' as const, name: '', path: '/x', brief: '', status: null }
  it('lets an existing repo through with just a path', () => expect(submitBlocker(base)).toBeNull())
  it('explains each missing piece', () => {
    expect(submitBlocker({ ...base, path: '' })).toMatch(/repository folder/)
    expect(submitBlocker({ ...base, kind: 'new' })).toMatch(/name/)
    expect(submitBlocker({ ...base, kind: 'new', name: 'a' })).toMatch(/Describe/)
    expect(submitBlocker({ ...base, status: { tone: 'error', text: 'No folder', blocking: true } })).toBe('No folder')
  })
})

describe('effectiveName', () => {
  it('prefers typed, then suggested, then the leaf', () => {
    expect(effectiveName(' A ', '/x/y', chk())).toBe('A')
    expect(effectiveName('', '/x/y', chk())).toBe('app')
    expect(effectiveName('', 'C:\\x\\y\\', null)).toBe('y')
  })
})
