import { EventEmitter } from 'node:events'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicStatus, authChildrenInFlight, claudeAuthStatus, EXIT_PIPE_GRACE_MS, makeRunCli, privateAuthCwd, runAuthStatus, type AuthChild, type CliResult, type RunCli } from './anthropicAuth'
import { claudeRuntimeMissingMessage, type ClaudeExecutableResolution } from '../runtime/claudeBinary'

const found = (path = '/opt/orgai/claude'): (() => ClaudeExecutableResolution) => () => ({ ok: true, path, source: 'sdk' })
const missing = (pathCandidate?: string): (() => ClaudeExecutableResolution) => () => ({ ok: false, reason: claudeRuntimeMissingMessage('linux', 'x64'), ...(pathCandidate ? { pathCandidate } : {}) })

describe('privateAuthCwd (review 3)', () => {
  it('uses an empty private folder under the data folder (not inside run/), not the shared temp dir', async () => {
    const data = mkdtempSync(join(tmpdir(), 'orgai-authcwd-'))
    try {
      const dir = await privateAuthCwd({ dataDir: data })
      expect(dir).toBe(join(data, 'auth-cwd'))
      expect(readdirSync(dir)).toEqual([])
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })
  it('wipes a folder that already holds anything (a planted .claude/settings.json)', async () => {
    const data = mkdtempSync(join(tmpdir(), 'orgai-authcwd-'))
    try {
      const dir = await privateAuthCwd({ dataDir: data })
      mkdirSync(join(dir, '.claude'))
      writeFileSync(join(dir, '.claude', 'settings.json'), '{}')
      const again = await privateAuthCwd({ dataDir: data })
      expect(again).toBe(dir)
      expect(readdirSync(again)).toEqual([])
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })
  it('replaces a junction/symlink at auth-cwd by removing only the link: the target survives', async () => {
    const data = mkdtempSync(join(tmpdir(), 'orgai-authcwd-'))
    const target = mkdtempSync(join(tmpdir(), 'orgai-authtarget-'))
    try {
      writeFileSync(join(target, 'keep.txt'), 'precious')
      try {
        symlinkSync(target, join(data, 'auth-cwd'), process.platform === 'win32' ? 'junction' : 'dir')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EPERM') return // SKIP: no link privilege on this machine
        throw e
      }
      const dir = await privateAuthCwd({ dataDir: data })
      expect(lstatSync(dir).isSymbolicLink()).toBe(false)
      expect(readdirSync(dir)).toEqual([])
      expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('precious')
    } finally {
      rmSync(data, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
  it.skipIf(process.platform === 'win32')('POSIX: an existing auth-cwd that others can enter is not reused', async () => {
    const data = mkdtempSync(join(tmpdir(), 'orgai-authcwd-'))
    try {
      const dir = join(data, 'auth-cwd')
      mkdirSync(dir, { mode: 0o755 })
      chmodSync(dir, 0o755)
      const got = await privateAuthCwd({ dataDir: data })
      expect(lstatSync(got).mode & 0o077).toBe(0)
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })
  it('without a data folder makes a fresh mkdtemp under the given temp dir and reuses it while empty', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'orgai-authcwd-tmp-'))
    const winRun = async (): Promise<string> => '"d\\u","S-1-5-21-1-2-3-1001"\r\n'
    try {
      const a = await privateAuthCwd({ tmp, winRun })
      expect(a).not.toBe(tmp)
      expect(a.startsWith(tmp)).toBe(true)
      expect(await privateAuthCwd({ tmp, winRun })).toBe(a)
      writeFileSync(join(a, 'planted'), 'x')
      expect(await privateAuthCwd({ tmp, winRun })).not.toBe(a)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
  it.skipIf(process.platform === 'win32')('refuses a folder owned by someone else', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'orgai-authcwd-tmp-'))
    try {
      await expect(privateAuthCwd({ tmp, uid: (process.getuid?.() ?? 0) + 1 })).rejects.toThrow(/not owned/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
  it('win32 fallback restricts the folder to this SID with icacls (absolute paths) before using it', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'orgai-authcwd-win-'))
    const calls: { bin: string; args: string[] }[] = []
    const winRun = async (bin: string, args: string[]): Promise<string> => {
      calls.push({ bin, args })
      return bin.toLowerCase().endsWith('whoami.exe') ? '"pc\\me","S-1-5-21-1-2-3-1001"\r\n' : ''
    }
    try {
      const dir = await privateAuthCwd({ tmp, platform: 'win32', winRun })
      expect(calls).toHaveLength(2)
      expect(calls[0]!.bin).toMatch(/system32[\\/]whoami\.exe$/i)
      expect(calls[1]!.bin).toMatch(/system32[\\/]icacls\.exe$/i)
      expect(calls[1]!.args).toEqual([dir, '/inheritance:r', '/grant:r', '*S-1-5-21-1-2-3-1001:(OI)(CI)F'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
  it('win32 fallback fails closed: no whoami user or a failing icacls rejects and removes the folder', async () => {
    for (const winRun of [
      async () => 'nonsense',
      async (bin: string): Promise<string> => {
        if (bin.toLowerCase().endsWith('icacls.exe')) throw new Error('denied')
        return '"pc\\me","S-1-5-21-1-2-3-1001"\r\n'
      }
    ]) {
      const tmp = mkdtempSync(join(tmpdir(), 'orgai-authcwd-win-'))
      try {
        await expect(privateAuthCwd({ tmp, platform: 'win32', winRun })).rejects.toThrow()
        expect(readdirSync(tmp)).toEqual([])
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
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

  it('an ORGAI_CLAUDE_PATH shim is refused before anything runs (review round 1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-claude-shim-'))
    try {
      const shim = join(dir, 'claude.cmd')
      writeFileSync(shim, '@echo off')
      const seen: string[] = []
      const st = await claudeAuthStatus({ env: { ORGAI_CLAUDE_PATH: shim }, run: async (bin) => (seen.push(bin), { stdout: '{"loggedIn":true}', stderr: '', code: 0 }) })
      expect(st).toMatchObject({ loggedIn: false, unavailable: true })
      expect(st.detail).toMatch(/a script shim OrgAI cannot run/)
      expect(seen).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
    const calls: { bin: string; args: string[]; env: Record<string, string>; cwd: string }[] = []
    const run: RunCli = async (bin, args, opts) => {
      calls.push({ bin, args, env: opts.env, cwd: opts.cwd })
      return answer(args)
    }
    return { calls, run }
  }
  const leaky = { PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'leak', ANTHROPIC_BASE_URL: 'http://gw', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' }

  it('puts --setting-sources project before auth status, in a temp cwd with an isolated env', async () => {
    const { calls, run } = recorder(() => json({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }))
    const res = await runAuthStatus('claude', { run, env: leaky, cwd: '/tmp/x' })
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['--setting-sources', 'project', 'auth', 'status'])
    expect(calls[0].cwd).toBe('/tmp/x')
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
    const candidates = async () => [{ bin: 'a' }, { bin: 'b' }]
    expect(await claudeAuthStatus({ run, candidates, env: {} })).toMatchObject({ loggedIn: true })
    expect(seen).toEqual(['a', 'b'])
    const none = await claudeAuthStatus({ run: async () => ({ stdout: '', stderr: '', code: 1 }), candidates, env: {} })
    expect(none.loggedIn).toBe(false)
    expect(none.unavailable).toBe(true)
    expect(none.detail).toMatch(/^The Claude runtime at a, b gave no answer to auth status/)
  })

  it('anthropicStatus uses the truthful detail', async () => {
    const run: RunCli = async () => ({ stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }), stderr: '', code: 1 })
    const st = await anthropicStatus({ kind: 'subscription' }, {}, { run, candidates: async () => [{ bin: 'x' }], env: {} })
    expect(st.state).toBe('disconnected')
    expect(st.detail).toMatch(/choose another default connection/)
  })

  it('anthropicStatus reports a missing or timed-out CLI as error, never disconnected', async () => {
    const none = await anthropicStatus({ kind: 'subscription' }, {}, { candidates: async () => [], env: {} })
    expect(none.state).toBe('error')
    expect(none.detail).toMatch(/No Claude runtime was found/)
    // A timeout surfaces as a failed run with no JSON on stdout.
    const timedOut: RunCli = async () => ({ stdout: '', stderr: 'ETIMEDOUT', code: 1 })
    const st = await anthropicStatus({ kind: 'subscription' }, {}, { run: timedOut, candidates: async () => [{ bin: 'x' }], env: {} })
    expect(st.state).toBe('error')
  })
})

describe('makeRunCli: no kill by a possibly reused pid', () => {
  afterEach(() => vi.useRealTimers())
  function setup(platform: NodeJS.Platform) {
    const em = new EventEmitter()
    const destroyed: string[] = []
    const child = Object.assign(em, {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdout: { destroy: () => destroyed.push('out') },
      stderr: { destroy: () => destroyed.push('err') },
      kill: vi.fn()
    })
    let cb!: (err: Error | null, o: string, e: string) => void
    const killTree = vi.fn((_pid: number, done: () => void) => done())
    const run = makeRunCli({ exec: (_b, _a, _o, c) => ((cb = c), child as unknown as AuthChild), killTree, platform })
    return { child, killTree, run, finish: () => cb(null, '{}', ''), destroyed }
  }
  it('timer after the child exited: no taskkill, timer cleared, count held until the pipes close', async () => {
    vi.useFakeTimers()
    const s = setup('win32')
    const before = authChildrenInFlight()
    const p = s.run('claude', [], { env: {}, cwd: '.', timeout: 1000 })
    expect(authChildrenInFlight()).toBe(before + 1)
    s.child.exitCode = 0
    s.child.emit('exit')
    await vi.advanceTimersByTimeAsync(1500)
    expect(s.killTree).not.toHaveBeenCalled()
    expect(s.child.kill).not.toHaveBeenCalled()
    expect(authChildrenInFlight()).toBe(before + 1) // a pipe-holding grandchild may hold the cwd
    await vi.advanceTimersByTimeAsync(EXIT_PIPE_GRACE_MS)
    expect(s.destroyed).toEqual(['out', 'err'])
    s.finish()
    expect((await p).code).toBe(0)
    expect(authChildrenInFlight()).toBe(before)
  })
  it('timer while the child is still running: taskkill /T on win32', async () => {
    vi.useFakeTimers()
    const s = setup('win32')
    const p = s.run('claude', [], { env: {}, cwd: '.', timeout: 1000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.killTree).toHaveBeenCalledWith(4242, expect.any(Function))
    s.finish()
    await p
  })
  it('abort after exit does not kill either', async () => {
    const s = setup('win32')
    const ac = new AbortController()
    const p = s.run('claude', [], { env: {}, cwd: '.', timeout: 60000, signal: ac.signal })
    s.child.signalCode = 'SIGTERM'
    s.child.emit('exit')
    ac.abort()
    expect(s.killTree).not.toHaveBeenCalled()
    s.finish()
    await p
  })
})
