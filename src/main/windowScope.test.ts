import { describe, expect, it } from 'vitest'
import { HARNESS_PROJECT_ID, parseRunWindowHash, runWindowHash } from '@shared/types'
import { appUrlMatcher, checkRunTarget, isExternalWebUrl, isValidId, pickFocusWindow, scopedWindow, shouldBlockNavigation } from './windowScope'

const lookup = {
  project: (id: string) => (id === 'proj_a' || id === 'proj_b' ? { id } : null),
  runProject: (runId: string) => ({ run_1: 'proj_a', run_2: 'proj_b' })[runId]
}

describe('checkRunTarget', () => {
  it('accepts a known run of a known project', () => {
    expect(checkRunTarget({ projectId: 'proj_a', runId: 'run_1', extra: 1 }, lookup)).toEqual({ projectId: 'proj_a', runId: 'run_1' })
  })

  it('accepts a harness run when the lookup knows the virtual harness project', () => {
    const harnessLookup = {
      project: (id: string) => (id === HARNESS_PROJECT_ID ? { id } : lookup.project(id)),
      runProject: (runId: string) => (runId === 'run_h' ? HARNESS_PROJECT_ID : lookup.runProject(runId))
    }
    expect(checkRunTarget({ projectId: 'harness', runId: 'run_h' }, harnessLookup)).toEqual({ projectId: 'harness', runId: 'run_h' })
    // the stored-project lookup alone does not know it
    expect(() => checkRunTarget({ projectId: 'harness', runId: 'run_h' }, lookup)).toThrow('Project not found')
    expect(() => checkRunTarget({ projectId: 'proj_a', runId: 'run_h' }, harnessLookup)).toThrow('another project')
    expect(parseRunWindowHash(runWindowHash({ projectId: 'harness', runId: 'run_h' }))).toEqual({ projectId: 'harness', runId: 'run_h' })
  })

  it('refuses unknown, mismatched and malformed targets', () => {
    expect(() => checkRunTarget({ projectId: 'proj_x', runId: 'run_1' }, lookup)).toThrow('Project not found')
    expect(() => checkRunTarget({ projectId: 'proj_a', runId: 'run_9' }, lookup)).toThrow('Run not found')
    expect(() => checkRunTarget({ projectId: 'proj_a', runId: 'run_2' }, lookup)).toThrow('another project')
    expect(() => checkRunTarget(null, lookup)).toThrow('Invalid')
    expect(() => checkRunTarget({ projectId: 'proj_a', runId: '../x' }, lookup)).toThrow('Invalid')
    expect(() => checkRunTarget({ projectId: 'proj_a', runId: 'run_1#/x' }, lookup)).toThrow('Invalid')
    expect(() => checkRunTarget({ projectId: 7, runId: 'run_1' }, lookup)).toThrow('Invalid')
  })
})

describe('window picking', () => {
  const main = 'main'
  const scoped = 'scoped'
  const other = 'other'
  const wins: [string, { projectId: string; runId: string } | undefined][] = [
    [other, { projectId: 'proj_b', runId: 'run_2' }],
    [main, undefined],
    [scoped, { projectId: 'proj_a', runId: 'run_1' }]
  ]

  it('prefers the window scoped to the run, then the main window, then any', () => {
    expect(pickFocusWindow(wins, { projectId: 'proj_a', runId: 'run_1' })).toBe(scoped)
    expect(pickFocusWindow(wins, { projectId: 'proj_a', runId: 'run_3' })).toBe(main)
    expect(pickFocusWindow([wins[0]], { projectId: 'proj_a', runId: 'run_3' })).toBe(other)
    expect(pickFocusWindow([], { projectId: 'proj_a', runId: 'run_3' })).toBeUndefined()
  })

  it('finds an existing scoped window', () => {
    expect(scopedWindow(wins, 'run_2')).toBe(other)
    expect(scopedWindow(wins, 'run_3')).toBeUndefined()
  })
})

describe('run window hash', () => {
  it('round-trips and rejects the main window and malformed hashes', () => {
    const t = { projectId: 'proj_a', runId: 'run_1' }
    expect(runWindowHash(t)).toBe('#/run/proj_a/run_1')
    expect(parseRunWindowHash(runWindowHash(t))).toEqual(t)
    expect(parseRunWindowHash('')).toBeNull()
    expect(parseRunWindowHash('#/run/proj_a')).toBeNull()
    expect(parseRunWindowHash('#/run/a/b/c')).toBeNull()
    expect(parseRunWindowHash('#/run/%E0%A4%A/b')).toBeNull()
  })
})

describe('navigation guards', () => {
  it('opens only http and https links externally', () => {
    expect(isExternalWebUrl('https://example.com/a?b#c')).toBe(true)
    expect(isExternalWebUrl('http://localhost:3000')).toBe(true)
    for (const url of ['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', 'ms-settings:privacy', 'smb://host/share', 'mailto:a@b.c', 'data:text/html,hi', 'not a url', ''])
      expect(isExternalWebUrl(url)).toBe(false)
  })

  it('keeps a dev window on the dev server origin, hash routes included', () => {
    const isApp = appUrlMatcher('http://localhost:5173', 'file:///unused/index.html')
    expect(isApp('http://localhost:5173/')).toBe(true)
    expect(isApp('http://localhost:5173/#/run/proj_a/run_1')).toBe(true)
    expect(isApp('http://localhost:5174/')).toBe(false)
    expect(isApp('https://localhost:5173/')).toBe(false)
    expect(isApp('https://evil.example/')).toBe(false)
    expect(isApp('file:///C:/app/out/renderer/index.html')).toBe(false)
    expect(isApp('garbage')).toBe(false)
  })

  it('keeps a packaged window on its own index.html', () => {
    const isApp = appUrlMatcher(undefined, 'file:///C:/Program%20Files/OrgAI/resources/app.asar/out/renderer/index.html', 'win32')
    expect(isApp('file:///C:/Program%20Files/OrgAI/resources/app.asar/out/renderer/index.html')).toBe(true)
    expect(isApp('file:///c:/Program%20Files/OrgAI/resources/app.asar/out/renderer/index.html#/run/proj_a/run_1')).toBe(true)
    expect(isApp('file:///C:/Program%20Files/OrgAI/resources/app.asar/out/renderer/other.html')).toBe(false)
    expect(isApp('file:///C:/Users/me/Downloads/evil.html')).toBe(false)
    expect(isApp('file://remote-host/C:/Program%20Files/OrgAI/resources/app.asar/out/renderer/index.html')).toBe(false)
    expect(isApp('https://evil.example/index.html')).toBe(false)
  })

  it('never decodes file paths, so malformed and encoded escapes neither throw nor match', () => {
    const isApp = appUrlMatcher(undefined, 'file:///C:/app/out/renderer/index.html', 'win32')
    expect(() => isApp('file:///%zz')).not.toThrow()
    expect(isApp('file:///%zz')).toBe(false)
    expect(() => isApp('file:///x/%E0%A4%A')).not.toThrow()
    expect(isApp('file:///x/%E0%A4%A')).toBe(false)
    // An encoded slash is a different path, not the same file.
    expect(isApp('file:///C:/app/out/renderer%2Findex.html')).toBe(false)
    expect(isApp('file:///C:/app/out%2Frenderer/index.html')).toBe(false)
    expect(shouldBlockNavigation(isApp, 'file:///%zz')).toBe(true)
    expect(shouldBlockNavigation(isApp, 'file:///C:/app/out/renderer/index.html#/run/p/r')).toBe(false)
  })

  it('compares file paths case-sensitively off Windows', () => {
    const mac = appUrlMatcher(undefined, 'file:///Applications/OrgAI.app/Contents/Resources/app.asar/out/renderer/index.html', 'darwin')
    expect(mac('file:///Applications/OrgAI.app/Contents/Resources/app.asar/out/renderer/index.html')).toBe(true)
    expect(mac('file:///applications/orgai.app/contents/resources/app.asar/out/renderer/index.html')).toBe(false)
    const win = appUrlMatcher(undefined, 'file:///C:/App/index.html', 'win32')
    expect(win('file:///c:/app/INDEX.html')).toBe(true)
  })

  it('blocks when the matcher throws and lets subframes load only about:blank and about:srcdoc besides the app', () => {
    const throwing = (): boolean => {
      throw new Error('boom')
    }
    expect(shouldBlockNavigation(throwing, 'file:///C:/app/index.html')).toBe(true)
    expect(shouldBlockNavigation(throwing, 'https://evil.example/', false)).toBe(true)
    const isApp = appUrlMatcher('http://localhost:5173', 'file:///unused/index.html')
    expect(shouldBlockNavigation(isApp, 'http://localhost:5173/#/x')).toBe(false)
    expect(shouldBlockNavigation(isApp, 'https://evil.example/')).toBe(true)
    expect(shouldBlockNavigation(isApp, 'about:blank', false)).toBe(false)
    expect(shouldBlockNavigation(isApp, 'about:srcdoc', false)).toBe(false)
    expect(shouldBlockNavigation(isApp, 'about:blank')).toBe(true)
    expect(shouldBlockNavigation(isApp, 'https://evil.example/', false)).toBe(true)
  })
})

describe('isValidId', () => {
  it('accepts newId-style ids and rejects anything else', () => {
    expect(isValidId('run-abc_123')).toBe(true)
    expect(isValidId('a'.repeat(128))).toBe(true)
    for (const bad of ['', 'a'.repeat(129), '../x', 'a b', 'run/1', 42, null, undefined, {}]) expect(isValidId(bad)).toBe(false)
  })
})
