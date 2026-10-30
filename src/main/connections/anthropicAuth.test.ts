import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { anthropicStatus, candidateLaunch, claudeAuthStatus, claudeCandidatePaths, dedupeByRealpath, listClaudeBinaries, parseWhichOutput, runAuthStatus, type CliResult, type RunCli } from './anthropicAuth'

describe('candidateLaunch', () => {
  it('runs every non-shim candidate without a shell, metacharacters included', () => {
    expect(candidateLaunch('/usr/local/bin/claude', 'darwin')).toEqual({ bin: '/usr/local/bin/claude', shell: false })
    expect(candidateLaunch('/tmp/a;rm -rf x/claude', 'linux')).toEqual({ bin: '/tmp/a;rm -rf x/claude', shell: false })
    expect(candidateLaunch('C:\\Users\\me\\.local\\bin\\claude.exe', 'win32')).toEqual({ bin: 'C:\\Users\\me\\.local\\bin\\claude.exe', shell: false })
  })
  it('uses a shell only for Windows .cmd/.bat shims and drops shims with shell metacharacters', () => {
    expect(candidateLaunch('C:\\Program Files (x86)\\nodejs\\claude.cmd', 'win32')).toEqual({ bin: 'C:\\Program Files (x86)\\nodejs\\claude.cmd', shell: true })
    for (const bad of ['C:\\a&calc\\claude.cmd', 'C:\\%PATH%\\claude.bat', 'C:\\a"b\\claude.cmd', 'C:\\a|b\\claude.cmd']) {
      expect(candidateLaunch(bad, 'win32')).toBeNull()
    }
  })
})

describe('listClaudeBinaries', () => {
  it('runs where/which without a shell and keeps absolute paths only, with no bare fallback', async () => {
    const calls: [string, string[]][] = []
    const which = async (cmd: string, args: string[]): Promise<string> => {
      calls.push([cmd, args])
      return 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd\r\nclaude.cmd\r\n.\\claude\r\n'
    }
    expect(await listClaudeBinaries('win32', which)).toEqual(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'])
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toMatch(/System32[\\/]where\.exe$/i)
    expect(calls[0][1]).toEqual(['$PATH:claude'])
    expect(await listClaudeBinaries('win32', async () => '')).toEqual([])
  })
  it('parses which -a output on POSIX', () => {
    expect(parseWhichOutput('/usr/local/bin/claude\nclaude\n\n', 'darwin')).toEqual(['/usr/local/bin/claude'])
  })
  it('names the places it looked in the not-found message', async () => {
    const none = await claudeAuthStatus({ candidates: async () => [], env: {} })
    expect(none.detail).toMatch(/CLI not found \(looked in the bundled CLI, PATH/)
  })
})

describe('claudeCandidatePaths', () => {
  it('lists the native installer and Homebrew locations that exist on macOS', () => {
    const home = '/Users/me'
    const present = new Set([join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude'])
    expect(claudeCandidatePaths('darwin', home, (p) => present.has(p))).toEqual([join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude'])
  })

  it('is empty on Windows and survives a throwing exists()', () => {
    expect(claudeCandidatePaths('win32', 'C:/Users/me', () => true)).toEqual([])
    expect(
      claudeCandidatePaths('linux', '/home/me', () => {
        throw new Error('EACCES')
      })
    ).toEqual([])
  })
})

describe('dedupeByRealpath', () => {
  it('keeps the first spelling of paths that resolve to the same file', () => {
    const links: Record<string, string> = {
      '/opt/homebrew/bin/claude': '/opt/homebrew/Cellar/claude/1.0/bin/claude',
      '/opt/homebrew/Cellar/claude/1.0/bin/claude': '/opt/homebrew/Cellar/claude/1.0/bin/claude',
      '/Users/me/.local/bin/claude': '/Users/me/.claude/local/claude',
      '/Users/me/.claude/local/claude': '/Users/me/.claude/local/claude'
    }
    const real = (p: string): string => {
      if (!(p in links)) throw new Error('ENOENT')
      return links[p]
    }
    expect(
      dedupeByRealpath(
        ['/opt/homebrew/bin/claude', '/Users/me/.local/bin/claude', '/opt/homebrew/Cellar/claude/1.0/bin/claude', '/Users/me/.claude/local/claude', 'claude'],
        real
      )
    ).toEqual(['/opt/homebrew/bin/claude', '/Users/me/.local/bin/claude', 'claude'])
  })
})

describe('anthropicStatus (API key)', () => {
  it('is connected only when the env var is set', async () => {
    expect((await anthropicStatus({ kind: 'apiKey', envVar: 'K' }, { K: 'x' })).state).toBe('connected')
    expect((await anthropicStatus({ kind: 'apiKey', envVar: 'K' }, {})).state).toBe('disconnected')
  })
})

describe('runAuthStatus', () => {
  const json = (o: object, code = 0): CliResult => ({ stdout: JSON.stringify(o), stderr: '', code })
  const recorder = (answer: (args: string[]) => CliResult) => {
    const calls: { bin: string; args: string[]; env: Record<string, string>; cwd: string; shell: boolean }[] = []
    const run: RunCli = async (bin, args, opts) => {
      calls.push({ bin, args, env: opts.env, cwd: opts.cwd, shell: opts.shell })
      return answer(args)
    }
    return { calls, run }
  }
  const leaky = { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'leak', ANTHROPIC_BASE_URL: 'http://gw', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }

  it('puts --setting-sources project before auth status, in a temp cwd with an isolated env', async () => {
    const { calls, run } = recorder(() => json({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }))
    const res = await runAuthStatus('claude', { run, env: leaky, cwd: '/tmp/x', shell: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['--setting-sources', 'project', 'auth', 'status'])
    expect(calls[0].cwd).toBe('/tmp/x')
    expect(calls[0].shell).toBe(false)
    expect(calls[0].env.PATH).toBe('/bin')
    expect(calls[0].env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(calls[0].env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(calls[0].env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(res).toMatchObject({ loggedIn: true, method: 'Claude Code login (claude.ai)', detail: 'Claude Code login (claude.ai)', restricted: true })
  })

  it('treats a non-zero exit with JSON as not logged in, with an actionable detail', async () => {
    const { run } = recorder(() => json({ loggedIn: false, authMethod: 'none' }, 1))
    const res = await runAuthStatus('claude', { run, env: {} })
    expect(res?.loggedIn).toBe(false)
    expect(res?.detail).toBe('Not logged in for OrgAI runs. Run claude and /login, set an API key, or choose another default connection.')
  })

  it('retries without --setting-sources on unknown option and says so', async () => {
    const { calls, run } = recorder((args) =>
      args[0] === '--setting-sources' ? { stdout: '', stderr: "error: unknown option '--setting-sources'", code: 1 } : json({ loggedIn: true, authMethod: 'claude.ai' })
    )
    const res = await runAuthStatus('claude', { run, env: {} })
    expect(calls.map((c) => c.args)).toEqual([['--setting-sources', 'project', 'auth', 'status'], ['auth', 'status']])
    expect(res).toMatchObject({ loggedIn: true, restricted: false })
    expect(res?.detail).toContain('user settings could not be excluded')
  })

  it('maps oauth_token, api_key and non-firstParty providers', async () => {
    const one = async (o: object) => (await runAuthStatus('claude', { run: async () => json(o), env: {} }))?.detail
    expect(await one({ loggedIn: true, authMethod: 'oauth_token' })).toBe('OAuth token (CLAUDE_CODE_OAUTH_TOKEN)')
    expect(await one({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' })).toBe('API key (ANTHROPIC_API_KEY)')
    expect(await one({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' })).toBe('Claude Code login (claude.ai) via bedrock')
  })

  it('gives null for unparseable output', async () => {
    expect(await runAuthStatus('claude', { run: async () => ({ stdout: 'boom', stderr: '', code: 1 }), env: {} })).toBeNull()
  })
})

describe('claudeAuthStatus', () => {
  it('tries candidates in order and reports a readable not-found', async () => {
    const seen: string[] = []
    const run: RunCli = async (bin) => {
      seen.push(bin)
      return bin === 'b' ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '', code: 0 } : { stdout: '', stderr: 'nope', code: 1 }
    }
    const candidates = async () => [{ bin: 'a', shell: false }, { bin: 'b', shell: true }]
    expect(await claudeAuthStatus({ run, candidates, env: {} })).toMatchObject({ loggedIn: true })
    expect(seen).toEqual(['a', 'b'])
    const none = await claudeAuthStatus({ run: async () => ({ stdout: '', stderr: '', code: 1 }), candidates, env: {} })
    expect(none.loggedIn).toBe(false)
    expect(none.detail).toMatch(/CLI not found/)
  })

  it('anthropicStatus uses the truthful detail', async () => {
    const run: RunCli = async () => ({ stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }), stderr: '', code: 1 })
    const st = await anthropicStatus({ kind: 'subscription' }, {}, { run, candidates: async () => [{ bin: 'x', shell: false }], env: {} })
    expect(st.state).toBe('disconnected')
    expect(st.detail).toMatch(/choose another default connection/)
  })
})
