import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { confinedReal, localPaths, readBoundedText, usablePath } from './paths'

const abs = (...p: string[]): string => join(process.platform === 'win32' ? 'C:\\' : '/', ...p)

describe('localPaths', () => {
  const home = abs('Users', 'me')
  const proj = abs('work', 'proj')
  const base = { projectPath: proj, homeDir: home }

  it('lists the home locations from the injected context', () => {
    const p = localPaths({ ...base, env: {}, platform: 'linux' })
    expect(p.skillRoots.map((s) => s.source)).toEqual(['claude-skills', 'agents-skills', 'copilot-skills'])
    expect(p.skillRoots[0]!.path).toBe(join(home, '.claude', 'skills'))
    expect(p.pluginsFile!.path).toBe(join(home, '.claude', 'plugins', 'installed_plugins.json'))
    expect(p.claudeJson!.path).toBe(join(home, '.claude.json'))
    expect(p.cursor!.path).toBe(join(home, '.cursor', 'mcp.json'))
    expect(p.codex!.path).toBe(join(home, '.codex', 'config.toml'))
    expect(p.claudeDesktop!.path).toBe(join(home, '.config', 'Claude', 'claude_desktop_config.json'))
    expect(p.repo.map((r) => r.display)).toEqual(['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json'])
    expect(p.repo[2]!.key).toBe('servers')
  })

  it('picks the Claude Desktop path per platform', () => {
    const appData = abs('AppData', 'X')
    expect(localPaths({ ...base, env: { APPDATA: appData }, platform: 'win32' }).claudeDesktop!.path).toBe(join(appData, 'Claude', 'claude_desktop_config.json'))
    expect(localPaths({ ...base, env: {}, platform: 'win32' }).claudeDesktop!.path).toBe(join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'))
    expect(localPaths({ ...base, env: {}, platform: 'darwin' }).claudeDesktop!.path).toBe(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'))
    const xdg = abs('xdg')
    expect(localPaths({ ...base, env: { XDG_CONFIG_HOME: xdg }, platform: 'linux' }).claudeDesktop!.path).toBe(join(xdg, 'Claude', 'claude_desktop_config.json'))
  })

  it('honors CODEX_HOME and the plugin cache dir only when absolute', () => {
    const ch = abs('codex')
    const cache = abs('cache')
    const p = localPaths({ ...base, env: { CODEX_HOME: ch, CLAUDE_CODE_PLUGIN_CACHE_DIR: cache }, platform: 'linux' })
    expect(p.codex!.path).toBe(join(ch, 'config.toml'))
    expect(p.pluginRoots).toEqual([join(home, '.claude', 'plugins'), cache])
    const q = localPaths({ ...base, env: { CODEX_HOME: 'rel', CLAUDE_CODE_PLUGIN_CACHE_DIR: '\\\\server\\share', APPDATA: 'rel' }, platform: 'win32' })
    expect(q.codex!.path).toBe(join(home, '.codex', 'config.toml'))
    expect(q.pluginRoots).toEqual([join(home, '.claude', 'plugins')])
    expect(q.claudeDesktop!.path).toContain('Roaming')
  })

  it('returns nothing for a relative or network home or project', () => {
    const p = localPaths({ projectPath: 'rel', homeDir: '\\\\server\\share\\me', env: {}, platform: 'linux' })
    expect(p.skillRoots).toEqual([])
    expect(p.claudeJson).toBeNull()
    expect(p.repo).toEqual([])
    expect(usablePath('//host/share')).toBe(false)
  })
})

describe('readBoundedText', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-paths-')))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reads a file, reports missing, big and directories', () => {
    writeFileSync(join(root, 'a.json'), '\ufeff{"a":1}')
    expect(readBoundedText(join(root, 'a.json'), root, 100)).toEqual({ ok: true, text: '{"a":1}' })
    expect(readBoundedText(join(root, 'none.json'), root, 100)).toMatchObject({ ok: false, state: 'missing' })
    writeFileSync(join(root, 'big.json'), 'x'.repeat(101))
    expect(readBoundedText(join(root, 'big.json'), root, 100)).toMatchObject({ ok: false, state: 'big' })
    mkdirSync(join(root, 'd'))
    expect(readBoundedText(join(root, 'd'), root, 100)).toMatchObject({ ok: false, state: 'unsafe' })
  })

  it('refuses a path outside its base and one through a link', () => {
    writeFileSync(join(root, 'a.json'), '{}')
    mkdirSync(join(root, 'base'))
    expect(readBoundedText(join(root, 'a.json'), join(root, 'base'), 100).ok).toBe(false)
    mkdirSync(join(root, 'real'))
    writeFileSync(join(root, 'real', 'f.json'), '{}')
    try {
      symlinkSync(join(root, 'real'), join(root, 'base', 'lnk'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    expect(readBoundedText(join(root, 'base', 'lnk', 'f.json'), join(root, 'base'), 100)).toMatchObject({ ok: false, state: 'unsafe' })
    expect(confinedReal(join(root, 'base', 'lnk'), join(root, 'base'))).toBeNull()
  })
})
