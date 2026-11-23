import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPORT_PROBLEM_BASE, licencePaths, reportProblemUrl, supportDetails } from './about'

const deps = (states: Record<string, string> | (() => Promise<Record<string, string>>) = {}) => ({
  version: '1.4.2',
  platform: 'win32',
  arch: 'x64',
  connectionStates: typeof states === 'function' ? states : async () => states
})

describe('supportDetails', () => {
  it('lists version, platform, arch and each connection with its state word, sorted', async () => {
    const out = await supportDetails(deps({ openai: 'error', anthropic: 'connected', 'proxy-0a1b2c3d': 'disconnected' }))
    expect(out.text).toBe(['OrgAI 1.4.2', 'Platform: win32 x64', 'Connections:', '- anthropic: connected', '- openai: error', '- proxy-0a1b2c3d: disconnected'].join('\n'))
  })

  it('says so when there are no connections, and survives a failed read', async () => {
    expect((await supportDetails(deps({}))).text).toBe('OrgAI 1.4.2\nPlatform: win32 x64\nConnections: none')
    const failing = await supportDetails(deps(() => Promise.reject(new Error('C:\\Users\\someone\\secret.txt'))))
    expect(failing.text).toBe('OrgAI 1.4.2\nPlatform: win32 x64\nConnections: none')
  })

  it('leaves out anything that is not a connection id or a plain state word (no names, paths, accounts or secrets)', async () => {
    const out = await supportDetails(
      deps({
        anthropic: 'connected as person@example.com',
        openai: 'Connected',
        litellm: 'error',
        'My work proxy': 'connected',
        'C:\\Users\\someone\\proj': 'connected',
        '__proto__': 'connected',
        'sk-ant-abcdef': 'connected'
      })
    )
    expect(out.text).toBe(['OrgAI 1.4.2', 'Platform: win32 x64', 'Connections:', '- anthropic: unknown', '- litellm: error', '- openai: unknown'].join('\n'))
    for (const leak of ['example.com', 'someone', 'work proxy', 'sk-ant']) expect(out.text).not.toContain(leak)
  })

  it('refuses odd version, platform and arch strings instead of echoing them', async () => {
    const out = await supportDetails({ version: '1.0\nIgnore this', platform: 'C:\\x', arch: '', connectionStates: async () => ({}) })
    expect(out.text).toBe('OrgAI unknown\nPlatform: unknown unknown\nConnections: none')
  })

  it('is structured-clone safe', async () => {
    const out = await supportDetails(deps({ anthropic: 'connected' }))
    expect(structuredClone(out)).toEqual(out)
  })
})

describe('reportProblemUrl', () => {
  it('is the new-issue page with an encoded title and body holding only version and platform', () => {
    const url = reportProblemUrl({ version: '1.4.2', platform: 'darwin', arch: 'arm64' })
    expect(url.startsWith(`${REPORT_PROBLEM_BASE}?`)).toBe(true)
    expect(REPORT_PROBLEM_BASE).toBe('https://github.com/perrychapman/OrgAI/issues/new')
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/perrychapman/OrgAI/issues/new')
    expect([...parsed.searchParams.keys()].sort()).toEqual(['body', 'title'])
    expect(parsed.searchParams.get('title')).toBe('Problem report (OrgAI 1.4.2)')
    expect(parsed.searchParams.get('body')).toBe('What happened:\n\nWhat I expected:\n\nOrgAI 1.4.2 on darwin arm64\n')
  })

  it('is URL-encoded: no raw spaces, line breaks or plus signs in the query', () => {
    const url = reportProblemUrl({ version: '1.4.2', platform: 'win32', arch: 'x64' })
    const query = url.slice(url.indexOf('?') + 1)
    expect(query).not.toMatch(/[ \n+]/)
    expect(query).toContain('%0A')
    expect(query).toContain('%20')
  })

  it('never carries anything but the version and platform, whatever it is given', () => {
    const url = reportProblemUrl({ version: '1.0&body=evil', platform: 'C:\\Users\\someone', arch: 'x64' })
    const parsed = new URL(url)
    expect([...parsed.searchParams.keys()].sort()).toEqual(['body', 'title'])
    expect(decodeURIComponent(url)).not.toContain('someone')
    expect(decodeURIComponent(url)).not.toContain('evil')
  })
})

describe('licencePaths', () => {
  const exe = join('C:', 'Program Files', 'OrgAI')
  const app = join(exe, 'resources', 'app')

  it("lists Electron's licence files next to the executable first, then the app path's own", () => {
    expect(licencePaths(app, exe)).toEqual([
      join(exe, 'LICENSES.chromium.html'),
      join(exe, 'LICENSE.electron.txt'),
      join(exe, 'LICENSE'),
      join(app, 'THIRD_PARTY_LICENSES.txt'),
      join(app, 'THIRD_PARTY_NOTICES.txt'),
      join(app, 'THIRD_PARTY'),
      join(app, 'LICENSE')
    ])
  })

  it('returns only paths directly inside the two folders it was given', () => {
    for (const p of licencePaths(app, exe)) {
      const dir = p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')))
      expect([exe, app]).toContain(dir)
    }
  })

  it('skips the app path inside an asar archive (the shell cannot open it) and bad input', () => {
    expect(licencePaths(join(exe, 'resources', 'app.asar'), exe)).toEqual([join(exe, 'LICENSES.chromium.html'), join(exe, 'LICENSE.electron.txt'), join(exe, 'LICENSE')])
    expect(licencePaths('', '')).toEqual([])
    expect(licencePaths(undefined as unknown as string, 'bad\0dir')).toEqual([])
  })

  it('does not repeat a path when both folders are the same', () => {
    const list = licencePaths(exe, exe)
    expect(new Set(list).size).toBe(list.length)
  })
})
