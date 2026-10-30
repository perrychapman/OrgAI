import { describe, expect, it } from 'vitest'
import type { ProjectPathCheck } from '@shared/types'
import { effectiveName, isFullPath, newProjectConnectionLine, pathStatus, submitBlocker } from './projectsForm'

describe('newProjectConnectionLine', () => {
  const status = { state: 'connected' }
  const lite = (baseUrl: string, hasApiKey: boolean): never => ({ connection: { id: 'litellm', enabled: true, tierModels: {}, baseUrl, hasApiKey }, status, modelCount: 0 }) as never
  const oai = (enabled: boolean): never => ({ connection: { id: 'openai', enabled, tierModels: {}, auth: { kind: 'chatgpt' } }, status, modelCount: 0 }) as never
  it('uses the default when it is usable', () => {
    expect(newProjectConnectionLine('litellm', [lite('http://x', true)])).toContain('Runs on LiteLLM.')
    expect(newProjectConnectionLine('openai', [oai(true)])).toContain('Runs on OpenAI.')
  })
  it('says the mock adapter when it is ticked', () => {
    expect(newProjectConnectionLine('litellm', [lite('http://x', true)], true)).toBe('Runs on the mock adapter (no tokens).')
  })
  it('falls back to Anthropic when it is not', () => {
    expect(newProjectConnectionLine('litellm', [lite('', true)])).toContain('so this project runs on Anthropic.')
    expect(newProjectConnectionLine('litellm', [lite('http://x', false)])).toContain('so this project runs on Anthropic.')
    expect(newProjectConnectionLine('openai', [oai(false)])).toBe('OpenAI is not connected, so this project runs on Anthropic. Change in App settings > Defaults.')
    expect(newProjectConnectionLine('litellm', null)).toContain('LiteLLM is not connected, so this project runs on Anthropic.')
    expect(newProjectConnectionLine(null, null)).toContain('Runs on Anthropic.')
  })
})

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

describe('pathStatus precedence and full paths', () => {
  it('a missing folder in existing mode blocks, even when the check also says empty', () => {
    const missing = chk({ exists: false, isDirectory: false, empty: true })
    expect(pathStatus('existing', '/nope', missing)).toEqual({ tone: 'error', text: 'No folder at this path.', blocking: true })
    expect(submitBlocker({ kind: 'existing', name: '', path: '/nope', brief: '', status: pathStatus('existing', '/nope', missing) })).toBe('No folder at this path.')
  })
  it('refuses a relative path in both modes, before any check answers', () => {
    for (const kind of ['new', 'existing'] as const) {
      const s = pathStatus(kind, 'projects/shop', null)
      expect(s).toMatchObject({ tone: 'error', blocking: true })
      expect(s?.text).toMatch(/^Use a full path, for example /)
      expect(pathStatus(kind, 'shop', chk())).toMatchObject({ blocking: true })
    }
  })
  it('accepts drive, UNC and rooted paths', () => {
    expect(isFullPath('C:\\x\\y')).toBe(true)
    expect(isFullPath('d:/x')).toBe(true)
    expect(isFullPath('\\\\server\\share')).toBe(true)
    expect(isFullPath('/Users/x')).toBe(true)
    expect(isFullPath('x/y')).toBe(false)
    expect(isFullPath('~/x')).toBe(false)
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
