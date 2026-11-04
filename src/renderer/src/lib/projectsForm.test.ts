import { describe, expect, it } from 'vitest'
import type { ProjectPathCheck } from '@shared/types'
import { LAST_PROJECT_KIND_KEY, addReferenceFolder, effectiveName, isFullPath, newProjectConnectionView, pathStatus, readLastProjectKind, submitBlocker, writeLastProjectKind } from './projectsForm'

describe('newProjectConnectionView', () => {
  const info = (id: 'anthropic' | 'openai' | 'litellm', state: string, isDefault: boolean, auth?: object): never =>
    ({ connection: { id, enabled: true, tierModels: {}, auth: auth ?? { kind: 'subscription' }, baseUrl: 'http://x', hasApiKey: true }, status: { state }, modelCount: 0, isDefault }) as never
  it('names the effective default with its auth method and offers Change', () => {
    expect(newProjectConnectionView([info('anthropic', 'connected', true)])).toEqual({ text: 'Runs on Anthropic (Claude Code login).', link: 'Change' })
    expect(newProjectConnectionView([info('anthropic', 'disconnected', false), info('openai', 'connected', true, { kind: 'chatgpt' })])).toEqual({
      text: 'Runs on OpenAI (ChatGPT sign-in).',
      link: 'Change'
    })
    expect(newProjectConnectionView([info('litellm', 'connected', true)]).text).toBe('Runs on LiteLLM (proxy key).')
  })
  it('says nothing is connected when there is no connected default', () => {
    expect(newProjectConnectionView([info('anthropic', 'disconnected', false)])).toEqual({ text: 'Nothing is connected yet.', link: 'Connect' })
    expect(newProjectConnectionView([info('anthropic', 'error', true)]).link).toBe('Connect')
  })
  it('names a chosen default that is not connected while another connection is', () => {
    expect(newProjectConnectionView([info('anthropic', 'connected', false), info('openai', 'disconnected', true, { kind: 'chatgpt' })])).toEqual({
      text: 'Runs on OpenAI (ChatGPT sign-in), which is not connected.',
      link: 'Change'
    })
  })
  it('says the mock adapter when it is ticked, with no link', () => {
    expect(newProjectConnectionView([info('litellm', 'connected', true)], true)).toEqual({ text: 'Runs on the mock adapter (no tokens).', link: null })
  })
  it('is empty until the list loads', () => {
    expect(newProjectConnectionView(null)).toEqual({ text: '', link: null })
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

describe('engagement kind', () => {
  it('says nothing about git or emptiness for the working folder', () => {
    expect(pathStatus('existing', '/x', chk({ isGitRepo: false }), 'engagement')).toBeNull()
    expect(pathStatus('existing', '/x', chk({ empty: true }), 'engagement')).toBeNull()
    expect(pathStatus('existing', '/x', chk({ exists: false, isDirectory: false }), 'engagement')).toMatchObject({ tone: 'error', blocking: true })
    expect(pathStatus('existing', '/x', chk({ isDirectory: false }), 'engagement')?.text).toMatch(/file/)
  })
  it('needs only a working folder', () => {
    const base = { kind: 'existing' as const, name: '', path: '', brief: '', status: null, projectKind: 'engagement' as const }
    expect(submitBlocker(base)).toBe('Choose the working folder.')
    expect(submitBlocker({ ...base, path: '/x' })).toBeNull()
  })
})

describe('last project kind', () => {
  const store = (): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } => {
    const m = new Map<string, string>()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
  }
  it('is null until one is written, then round trips', () => {
    const s = store()
    expect(readLastProjectKind(s)).toBeNull()
    writeLastProjectKind('engagement', s)
    expect(readLastProjectKind(s)).toBe('engagement')
  })
  it('ignores junk and a missing or throwing storage', () => {
    const s = store()
    s.setItem(LAST_PROJECT_KIND_KEY, 'nope')
    expect(readLastProjectKind(s)).toBeNull()
    expect(readLastProjectKind(null)).toBeNull()
    expect(readLastProjectKind({ getItem: () => { throw new Error('x') }, setItem: () => undefined })).toBeNull()
  })
})

describe('addReferenceFolder', () => {
  it('adds a full path', () => {
    expect(addReferenceFolder(['/a'], ' /b ', '/w')).toEqual({ list: ['/a', '/b'] })
  })
  it('refuses the working folder, duplicates, relative paths, empty input and a full list', () => {
    expect(addReferenceFolder([], '/w/', '/w')).toEqual({ error: 'This is the working folder. Pick a folder inside it or elsewhere.' })
    expect(addReferenceFolder([], 'C:\\Work\\', 'c:/work')).toMatchObject({ error: expect.stringMatching(/working folder/) })
    expect(addReferenceFolder(['/a'], '/a', '/w')).toMatchObject({ error: expect.stringMatching(/already/) })
    expect(addReferenceFolder([], 'rel/x', '/w')).toMatchObject({ error: expect.stringMatching(/full path/) })
    expect(addReferenceFolder([], '  ', '/w')).toMatchObject({ error: expect.any(String) })
    const full = Array.from({ length: 20 }, (_, i) => `/f${i}`)
    expect(addReferenceFolder(full, '/new', '/w')).toMatchObject({ error: expect.stringMatching(/20/) })
  })
})

describe('effectiveName', () => {
  it('prefers typed, then suggested, then the leaf', () => {
    expect(effectiveName(' A ', '/x/y', chk())).toBe('A')
    expect(effectiveName('', '/x/y', chk())).toBe('app')
    expect(effectiveName('', 'C:\\x\\y\\', null)).toBe('y')
  })
})
