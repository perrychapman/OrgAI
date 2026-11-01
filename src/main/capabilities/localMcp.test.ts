import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverLocalMcp } from './localMcp'
import type { LocalContext } from './types'

let root: string
let home: string
let proj: string

function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function ctx(over: Partial<LocalContext> = {}): LocalContext {
  return { projectPath: proj, homeDir: home, env: {}, platform: process.platform, ...over }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-lmcp-')))
  home = join(root, 'home')
  proj = join(root, 'proj')
  mkdirSync(home)
  mkdirSync(proj)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const SECRETS = ['SECRET_ENV_VALUE_1', 'Bearer SECRET_BEARER_TOKEN', 'SECRET_CLIENT_SECRET', 'SECRET_QUERY_KEY', 'sk-ant-SECRETKEYVALUE12345', 'ghp_SECRETGITHUBTOKEN0123456789abcd', 'SECRET_FLAG_VALUE', 'SECRET_HELPER']

describe('discoverLocalMcp', () => {
  it('reads ~/.claude.json top-level and per-project servers and ignores the rest', () => {
    const history = Array.from({ length: 2000 }, (_, i) => ({ display: `prompt ${i} SECRET_HISTORY`, pasted: 'x'.repeat(200) }))
    const other = join(root, 'other')
    put(
      join(home, '.claude.json'),
      JSON.stringify({
        history,
        mcpServers: { global: { type: 'stdio', command: 'npx', args: ['-y', 'pkg@1.2.3'], env: { API_TOKEN: 'SECRET_ENV_VALUE_1' } } },
        projects: {
          [proj.replace(/\\/g, '/') + '/']: { mcpServers: { mine: { type: 'http', url: 'https://x.example/mcp?api_key=SECRET_QUERY_KEY', headers: { Authorization: 'Bearer SECRET_BEARER_TOKEN' } } } },
          [other]: { mcpServers: { notmine: { command: 'foo' } } }
        }
      })
    )
    const r = discoverLocalMcp(ctx())
    const names = r.candidates.map((c) => c.item.name).sort()
    expect(names).toEqual(['global', 'mine'])
    const mine = r.candidates.find((c) => c.item.name === 'mine')!
    expect(mine.item.transport).toBe('http')
    expect(mine.item.target).toBe('https://x.example/mcp')
    expect(mine.item.flags).toEqual(['remote'])
    expect(mine.item.needsSecrets).toEqual(['Authorization'])
    const g = r.candidates.find((c) => c.item.name === 'global')!
    expect(g.item.version).toBe('1.2.3')
    expect(g.item.blockedReason).toBeUndefined()
    expect(g.item.flags).toEqual(['runsCode'])
    expect(g.item.origin).toBe('local')
    expect(g.item.needsSecrets).toEqual(['API_TOKEN'])
    expect(g.payload).toMatchObject({ type: 'mcpSpec', spec: { id: '', source: 'local', secretEnv: ['API_TOKEN'] } })
    const spec = (g.payload as unknown as { spec: Record<string, unknown> }).spec
    expect(spec.env).toBeUndefined()
    expect(spec.headers).toBeUndefined()
    const src = r.sources.find((s) => s.source === 'claude-code-mcp')!
    expect(src.state).toBe('found')
    expect(src.count).toBe(2)
    expect(JSON.stringify(r)).not.toContain('SECRET_')
  })

  it('never leaks values from repo, Cursor, VS Code, Desktop and Codex files', () => {
    put(
      join(proj, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          a: { command: 'npx', args: ['-y', 'pkg@1.0.0', 'sk-ant-SECRETKEYVALUE12345', '--token', 'SECRET_FLAG_VALUE', '--api-key=ghp_SECRETGITHUBTOKEN0123456789abcd', '--flag'], env: { K: 'SECRET_ENV_VALUE_1' } },
          b: { type: 'http', url: 'https://u:SECRET_QUERY_KEY@h.example/p?x=1#f', oauth: { clientSecret: 'SECRET_CLIENT_SECRET' }, headersHelper: 'SECRET_HELPER', auth: { token: 'SECRET_CLIENT_SECRET' } }
        }
      })
    )
    put(join(proj, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { cur: { url: 'https://c.example/sse', headers: { 'X-Api-Key': 'SECRET_ENV_VALUE_1' } } } }))
    put(
      join(proj, '.vscode', 'mcp.json'),
      `{
  // a comment
  "inputs": [{ "id": "tok", "type": "promptString", "password": true }],
  "servers": {
    "vs": { "command": "uvx", "args": ["tool==2.0.1"], "env": { "TOKEN": "\${input:tok}" }, "envFile": "\${workspaceFolder}/.env", },
  },
}`
    )
    put(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { usercur: { command: 'node', args: ['server.js'], env: { OPENAI_API_KEY: 'SECRET_ENV_VALUE_1' } } } }))
    const appData = join(home, 'AppData', 'Roaming')
    const desktopPath =
      process.platform === 'win32'
        ? join(appData, 'Claude', 'claude_desktop_config.json')
        : process.platform === 'darwin'
          ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : join(home, '.config', 'Claude', 'claude_desktop_config.json')
    put(desktopPath, JSON.stringify({ mcpServers: { desk: { command: 'npx', args: ['-y', '@scope/pkg@3.1.4'], env: { GH: 'ghp_SECRETGITHUBTOKEN0123456789abcd' } } } }))
    put(
      join(home, '.codex', 'config.toml'),
      `model = "x"\n[mcp_servers.cx]\ncommand = "npx"\nargs = ["-y", "cx@0.1.0"]\n[mcp_servers.cx.env]\nCX_TOKEN = "SECRET_ENV_VALUE_1"\n[mcp_servers.rem]\nurl = "https://r.example/mcp"\nbearer_token_env_var = "REM_TOKEN"\nhttp_headers = { "X-Key" = "SECRET_ENV_VALUE_1" }\n`
    )
    const r = discoverLocalMcp(ctx())
    const json = JSON.stringify(r)
    for (const s of SECRETS) expect(json).not.toContain(s)
    expect(json).not.toContain('SECRET')
    const by = (n: string) => r.candidates.find((c) => c.item.name === n)!
    expect(by('a').item.origin).toBe('repo')
    expect(by('a').item.notes.join(' ')).toMatch(/looked like a key/)
    expect((by('a').payload as { spec: { args: string[] } }).spec.args).toEqual(['-y', 'pkg@1.0.0', '--token', '--flag'])
    expect(by('b').item.target).toBe('https://h.example/p')
    expect(by('b').item.notes.join(' ')).toMatch(/Left out: .*oauth/)
    expect(by('cur').item.needsSecrets).toEqual(['X-Api-Key'])
    expect(by('vs').item.needsSecrets).toEqual(['TOKEN'])
    expect(by('vs').item.notes.join(' ')).toMatch(/env file/)
    expect(by('vs').item.version).toBe('2.0.1')
    expect(by('usercur').item.blockedReason).toBeUndefined()
    expect(by('desk').item.version).toBe('3.1.4')
    expect(by('cx').item.needsSecrets).toEqual(['CX_TOKEN'])
    expect(by('rem').item.needsSecrets).toContain('Authorization')
    expect(r.sources.map((s) => s.source).sort()).toEqual(['claude-code-mcp', 'claude-desktop-mcp', 'codex-mcp', 'cursor-mcp', 'repo-mcp'])
    expect(r.sources.find((s) => s.source === 'claude-code-mcp')!.state).toBe('missing')
  })

  it('uses CODEX_HOME and APPDATA from the injected env', () => {
    const codex = join(root, 'codexhome')
    put(join(codex, 'config.toml'), '[mcp_servers.z]\ncommand = "npx"\nargs = ["-y", "z@1.0.0"]\n')
    put(join(root, 'ad', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { d: { command: 'node' } } }))
    const r = discoverLocalMcp(ctx({ env: { CODEX_HOME: codex, APPDATA: join(root, 'ad') }, platform: 'win32' }))
    expect(r.candidates.map((c) => c.item.name).sort()).toEqual(process.platform === 'win32' ? ['d', 'z'] : ['z'])
  })

  it('blocks an unpinned npx server', () => {
    put(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { loose: { command: 'npx', args: ['-y', 'some-pkg'] }, floating: { command: 'npx', args: ['pkg@latest'] } } }))
    const r = discoverLocalMcp(ctx())
    for (const c of r.candidates) expect(c.item.blockedReason).toMatch(/pin|version|exact/i)
    expect(r.candidates).toHaveLength(2)
  })

  it('skips files that are too large, with a warning', () => {
    put(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'node' } }, pad: 'x'.repeat(1024 * 1024 + 10) }))
    const r = discoverLocalMcp(ctx())
    expect(r.candidates).toHaveLength(0)
    expect(r.warnings.some((w) => /too large/.test(w.message))).toBe(true)
    expect(r.sources.find((s) => s.source === 'repo-mcp')!.state).toBe('error')
  })

  it('allows a big ~/.claude.json up to 8 MB', () => {
    put(join(home, '.claude.json'), JSON.stringify({ blob: 'x'.repeat(3 * 1024 * 1024), mcpServers: { a: { command: 'node' } } }))
    expect(discoverLocalMcp(ctx()).candidates).toHaveLength(1)
  })

  it('refuses a symlinked config file', () => {
    put(join(root, 'real.json'), JSON.stringify({ mcpServers: { a: { command: 'node' } } }))
    try {
      symlinkSync(join(root, 'real.json'), join(proj, '.mcp.json'), 'file')
    } catch {
      return
    }
    const r = discoverLocalMcp(ctx())
    expect(r.candidates).toHaveLength(0)
    expect(r.warnings.some((w) => /link/.test(w.message))).toBe(true)
  })

  it('refuses a config inside a symlinked folder', () => {
    put(join(root, 'realcursor', 'mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'node' } } }))
    try {
      symlinkSync(join(root, 'realcursor'), join(home, '.cursor'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    const r = discoverLocalMcp(ctx())
    expect(r.candidates).toHaveLength(0)
    expect(r.sources.find((s) => s.source === 'cursor-mcp')!.state).toBe('error')
  })

  it('handles bad JSON, odd names, and caps servers per file', () => {
    put(join(home, '.cursor', 'mcp.json'), '{ not json')
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 60; i++) many[`s${i}`] = { command: 'node' }
    many['Bad Name!'] = { command: 'node' }
    many['__proto__'] = { command: 'node' }
    put(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: many }))
    const r = discoverLocalMcp(ctx())
    expect(r.candidates.length).toBe(50)
    expect(r.warnings.some((w) => /bad JSON|not valid JSON/.test(w.message))).toBe(true)
    expect(r.warnings.some((w) => /first 50/.test(w.message))).toBe(true)
  })

  it('refuses control characters in a command and keeps same-named servers from several files apart', () => {
    put(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'no\nde' }, same: { command: 'node' } } }))
    put(join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { same: { command: 'node' } } }))
    const r = discoverLocalMcp(ctx())
    const same = r.candidates.filter((c) => c.item.name === 'same')
    expect(same).toHaveLength(2)
    expect(new Set(same.map((c) => c.item.id)).size).toBe(2)
    expect(r.candidates.some((c) => c.item.name === 'x')).toBe(false)
  })

  it('never throws on a missing home and project', () => {
    const r = discoverLocalMcp({ projectPath: 'relative', homeDir: '', env: {}, platform: 'linux' })
    expect(r.candidates).toEqual([])
  })

})

describe('credential args', () => {
  it('drops userinfo URLs, bearer text, authorization and secret flags with their values', () => {
    put(
      join(home, '.cursor', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          s: {
            command: 'npx',
            args: ['-y', 'pkg@1.0.0', 'postgres://u:SECRETPW@host/db', '--db=postgres://u:SECRETPW2@h', 'Bearer SECRETBEARER1', 'Authorization: abc', '--header', 'X-Key: SECRETHDR', '-H', 'SECRETH2', '--auth=SECRETAUTH', '--bearer', 'SECRETB3', '--port', '3000']
          }
        }
      })
    )
    const c = discoverLocalMcp(ctx()).candidates.find((x) => x.item.name === 's')!
    const args = (c.payload as { spec: { args: string[] } }).spec.args
    expect(args).toEqual(['-y', 'pkg@1.0.0', '--port', '3000'])
    expect(c.item.target).toBe('npx -y pkg@1.0.0 --port 3000')
    const text = JSON.stringify(c)
    expect(text).not.toContain('SECRET')
    expect(c.item.notes.join(' ')).toMatch(/left out.*--header.*-H/)
  })
})

describe('discoverLocalMcp review target', () => {
  it('shows a 300-char tail in full and blocks a command over 400 chars instead of cutting it', () => {
    const tail = `--opt=${'a'.repeat(294)}`
    const long = `--opt=${'b'.repeat(494)}`
    put(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { short: { command: 'npx', args: ['-y', 'pkg@1.0.0', tail] }, long: { command: 'npx', args: ['-y', 'pkg@1.0.0', long] } } }))
    const r = discoverLocalMcp(ctx())
    const short = r.candidates.find((c) => c.item.name === 'short')!
    expect(tail.length).toBe(300)
    expect(short.item.target).toBe(`npx -y pkg@1.0.0 ${tail}`)
    expect(short.item.blockedReason).toBeUndefined()
    const blocked = r.candidates.find((c) => c.item.name === 'long')!
    expect(blocked.item.blockedReason).toBe('Command too long to review')
    expect(blocked.item.target!.length).toBeLessThanOrEqual(400)
    // The payload still holds the real spec; the block keeps it from ever being applied.
    expect((blocked.payload as { spec: { args: string[] } }).spec.args).toContain(long)
  })

  it('quotes args with spaces and blocks hidden characters', () => {
    put(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { spaced: { command: 'node', args: ['server.js', 'two words'] }, hidden: { command: 'node', args: ['a‮b'] } } }))
    const r = discoverLocalMcp(ctx())
    expect(r.candidates.find((c) => c.item.name === 'spaced')!.item.target).toBe('node server.js "two words"')
    expect(r.candidates.find((c) => c.item.name === 'hidden')!.item.blockedReason).toMatch(/hidden or control characters/)
  })
})
