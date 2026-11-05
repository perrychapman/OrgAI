import { describe, expect, it } from 'vitest'
import { anthropicStatus, candidateLaunch, claudeAuthStatus, runAuthStatus, type CliResult, type RunCli } from './anthropicAuth'
import { claudeRuntimeMissingMessage, type ClaudeExecutableResolution } from '../runtime/claudeBinary'

const found = (path = '/opt/orgai/claude'): (() => ClaudeExecutableResolution) => () => ({ ok: true, path, source: 'sdk' })
const missing = (pathCandidate?: string): (() => ClaudeExecutableResolution) => () => ({ ok: false, reason: claudeRuntimeMissingMessage('linux', 'x64'), ...(pathCandidate ? { pathCandidate } : {}) })

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

describe('claudeAuthStatus with the resolver (cli-standalone 6.1)', () => {
  it('runs auth status only on the resolved binary, never on a PATH claude', async () => {
    const seen: string[] = []
    const run: RunCli = async (bin) => {
      seen.push(bin)
      return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '', code: 0 }
    }
    expect(await claudeAuthStatus({ run, executable: found('/opt/orgai/claude'), env: {} })).toMatchObject({ loggedIn: true })
    expect(seen).toEqual(['/opt/orgai/claude'])
  })

  it('without a runtime: unavailable, the resolver sentence, and a PATH claude only named', async () => {
    const seen: string[] = []
    const run: RunCli = async (bin) => {
      seen.push(bin)
      return { stdout: '{}', stderr: '', code: 0 }
    }
    const none = await claudeAuthStatus({ run, executable: missing('/usr/local/bin/claude'), env: {} })
    expect(none).toMatchObject({ loggedIn: false, unavailable: true })
    expect(none.detail).toBe(
      'The Claude runtime for linux-x64 is not installed; reinstall orgai without --omit=optional, or set ORGAI_CLAUDE_PATH. A claude on PATH at /usr/local/bin/claude is not used; set ORGAI_CLAUDE_PATH to use it.'
    )
    expect(seen).toEqual([])
    const st = await anthropicStatus({ kind: 'subscription' }, {}, { run, executable: missing(), env: {} })
    expect(st.state).toBe('error')
    expect(st.detail).toBe(claudeRuntimeMissingMessage('linux', 'x64'))
  })

  it('reads ORGAI_CLAUDE_PATH from the env it is given', async () => {
    const st = await claudeAuthStatus({ env: { ORGAI_CLAUDE_PATH: 'relative/claude' }, run: async () => ({ stdout: '', stderr: '', code: 1 }) })
    expect(st.unavailable).toBe(true)
    expect(st.detail).toMatch(/^ORGAI_CLAUDE_PATH must be an absolute path/)
  })
})

describe('anthropicStatus (API key)', () => {
  it('is connected only when the env var is set', async () => {
    expect((await anthropicStatus({ kind: 'apiKey', envVar: 'K' }, { K: 'x' }, { executable: found() })).state).toBe('connected')
    expect((await anthropicStatus({ kind: 'apiKey', envVar: 'K' }, {}, { executable: found() })).state).toBe('disconnected')
  })

  it('is an error, never disconnected, when the Claude runtime is missing', async () => {
    const st = await anthropicStatus({ kind: 'apiKey', envVar: 'K' }, { K: 'x' }, { executable: missing() })
    expect(st.state).toBe('error')
    expect(st.detail).toMatch(/Claude runtime for linux-x64 is not installed/)
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
    expect(none.unavailable).toBe(true)
    expect(none.detail).toMatch(/^The Claude runtime at a, b gave no answer to auth status/)
  })

  it('anthropicStatus uses the truthful detail', async () => {
    const run: RunCli = async () => ({ stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }), stderr: '', code: 1 })
    const st = await anthropicStatus({ kind: 'subscription' }, {}, { run, candidates: async () => [{ bin: 'x', shell: false }], env: {} })
    expect(st.state).toBe('disconnected')
    expect(st.detail).toMatch(/choose another default connection/)
  })

  it('anthropicStatus reports a missing or timed-out CLI as error, never disconnected', async () => {
    const none = await anthropicStatus({ kind: 'subscription' }, {}, { candidates: async () => [], env: {} })
    expect(none.state).toBe('error')
    expect(none.detail).toMatch(/No Claude runtime was found/)
    // A timeout surfaces as a failed run with no JSON on stdout.
    const timedOut: RunCli = async () => ({ stdout: '', stderr: 'ETIMEDOUT', code: 1 })
    const st = await anthropicStatus({ kind: 'subscription' }, {}, { run: timedOut, candidates: async () => [{ bin: 'x', shell: false }], env: {} })
    expect(st.state).toBe('error')
  })
})
