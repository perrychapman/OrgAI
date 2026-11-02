import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexAppServer, CodexRpcError, STDERR_TAIL_MAX_CHARS, codexExitMessage, codexHomeDir, maskKeyLike, redactSecrets, resolveCodexBinary } from './codexAppServer'
import { buildLaunchConfig } from './codexProtocol'
import { fakeCtx, project } from './testHelpers'
import { harnessToolsFor } from './harnessTools'
import { dynamicToolSpec } from './codexProtocol'
import type { ResolvedMcpServer } from './types'

/**
 * Token-free checks against the real binary: `initialize` and `config/read` only, with an empty temp CODEX_HOME.
 * Skipped unless ORGAI_CODEX_INTEGRATION=1 (needs @openai/codex's native package installed).
 */
const live = process.env.ORGAI_CODEX_INTEGRATION === '1' && !!resolveCodexBinary()

describe('codexHomeDir', () => {
  it('lives under the data dir', () => {
    expect(codexHomeDir('/data').replace(/\\/g, '/')).toBe('/data/codex')
  })
})

describe('resolveCodexBinary', () => {
  // ORGAI_CODEX_PATH overrides the package lookup; keep a developer's setting out of these checks.
  const saved = process.env.ORGAI_CODEX_PATH
  beforeEach(() => {
    delete process.env.ORGAI_CODEX_PATH
  })
  afterEach(() => {
    if (saved !== undefined) process.env.ORGAI_CODEX_PATH = saved
  })

  it('is undefined for a platform without a codex package', () => {
    expect(resolveCodexBinary('aix', 'ppc64')).toBeUndefined()
    expect(resolveCodexBinary('darwin', 'ia32')).toBeUndefined()
  })

  it('never throws for the macOS triples and uses the bare binary name there', () => {
    for (const arch of ['arm64', 'x64']) {
      const bin = resolveCodexBinary('darwin', arch)
      // Only installed on a Mac; elsewhere the optional dependency is absent and the lookup is undefined.
      if (bin) expect(bin.path.replace(/\\/g, '/')).toMatch(/apple-darwin\/bin\/codex$/)
    }
  })
})

describe('request plumbing without a process', () => {
  it('rejects requests before start', async () => {
    const s = new CodexAppServer()
    await expect(s.request('thread/start')).rejects.toThrow(/not running/)
  })

  it('reports a missing binary clearly', async () => {
    const prev = process.env.ORGAI_CODEX_PATH
    process.env.ORGAI_CODEX_PATH = join(tmpdir(), 'definitely-not-codex')
    try {
      await expect(new CodexAppServer().start()).rejects.toThrow(/not installed/)
    } finally {
      if (prev === undefined) delete process.env.ORGAI_CODEX_PATH
      else process.env.ORGAI_CODEX_PATH = prev
    }
  })

  it('exposes the rpc error code', () => {
    const e = new CodexRpcError('thread/start', { code: -32600, message: 'bad' })
    expect(e.message).toBe('thread/start: bad')
    expect(e.error.code).toBe(-32600)
  })
})

/**
 * A fake `codex` that is Node itself: start() runs `node app-server ...` in `cwd`, so a script named `app-server`
 * there plays the server. Token-free, no codex install needed.
 */
describe('fake app-server process', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-codex-fake-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  /** Write the fake server: it prints `chunks` to stderr one write at a time, then exits with `code`. */
  const fake = (chunks: string[], code = 1): void => {
    const body = `const chunks = ${JSON.stringify(chunks)}
let i = 0
const next = () => { if (i < chunks.length) { process.stderr.write(chunks[i++], next) } else { setTimeout(() => process.exit(${code}), 20) } }
next()
`
    writeFileSync(join(dir, 'app-server'), body)
  }

  it('creates a missing CODEX_HOME before spawning', async () => {
    fake([])
    const home = join(dir, 'data', 'codex')
    expect(existsSync(home)).toBe(false)
    const s = new CodexAppServer({ cwd: dir, env: { CODEX_HOME: home }, binary: { path: process.execPath } })
    await expect(s.start()).rejects.toThrow(/codex app-server exited \(code 1\) during initialize$/)
    expect(existsSync(home)).toBe(true)
  })

  it('appends the stderr tail to the exit error, joining split lines and redacting secrets', async () => {
    const key = 'sk-test-SECRET-1234567890'
    const lines = Array.from({ length: 12 }, (_, i) => `noise ${i}\n`)
    fake([...lines, 'Error: CODEX_HOME points to "/x", but ', 'that path does not exist\n', `\nkey was ${key.slice(0, 10)}`, `${key.slice(10)} (extra ${'tok-abcdef'})`])
    const seen: string[] = []
    const s = new CodexAppServer({
      cwd: dir,
      env: { CODEX_HOME: join(dir, 'home'), OPENAI_API_KEY: key },
      redact: ['tok-abcdef'],
      binary: { path: process.execPath },
      onStderr: (line) => seen.push(line)
    })
    const err = await s.start().then(
      () => undefined,
      (e: Error) => e
    )
    expect(err?.message).toMatch(/^codex app-server exited \(code 1\) during initialize: /)
    expect(err?.message).toContain('Error: CODEX_HOME points to "/x", but that path does not exist')
    expect(err?.message).toContain('key was [redacted] (extra [redacted])')
    expect(err?.message).not.toContain('SECRET')
    expect(err?.message).not.toContain('noise 3')
    expect(s.stderrTail().split('\n')).toHaveLength(10)
    expect(seen.join('\n')).not.toContain('SECRET')
    expect(seen).toContain('Error: CODEX_HOME points to "/x", but that path does not exist')
  })
})

describe('stderr helpers', () => {
  it('formats the exit message with and without a tail', () => {
    expect(codexExitMessage(1)).toBe('codex app-server exited (code 1)')
    expect(codexExitMessage(null, 'boom', 'thread/start')).toBe('codex app-server exited (code unknown) during thread/start: boom')
  })

  it('redacts every secret, longest first, and ignores very short values', () => {
    expect(redactSecrets('a abcd abcdef', ['abcd', 'abcdef', 'a'])).toBe('a [redacted] [redacted]')
  })

  it('masks key-like tokens exact redaction cannot match', () => {
    expect(maskKeyLike('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [redacted]')
    expect(maskKeyLike('bad key sk-proj-AbC123')).toBe('bad key [redacted]')
    expect(maskKeyLike('OPENAI_API_KEY=xyz12345 and "access_token": "tkn-9999"')).toBe('OPENAI_API_KEY=[redacted] and "access_token": "[redacted]"')
    expect(maskKeyLike('Error: CODEX_HOME points to "/x", but that path does not exist')).toBe('Error: CODEX_HOME points to "/x", but that path does not exist')
    const long = `${'a'.repeat(50_000)}token`
    const t = Date.now()
    maskKeyLike(long)
    expect(Date.now() - t).toBeLessThan(500)
  })

  it('caps the tail length', async () => {
    const s = new CodexAppServer()
    const feed = (s as unknown as { onStderrData(c: string): void }).onStderrData.bind(s)
    for (let i = 0; i < 10; i++) feed(`${'x'.repeat(500)}\n`)
    expect(s.stderrTail().length).toBeLessThanOrEqual(STDERR_TAIL_MAX_CHARS)
    feed('y'.repeat(STDERR_TAIL_MAX_CHARS * 5))
    expect(s.stderrTail().length).toBeLessThanOrEqual(STDERR_TAIL_MAX_CHARS)
  })
})

describe.skipIf(!live)('real codex app-server (token-free)', () => {
  let home = ''
  let server: CodexAppServer | undefined
  afterEach(async () => {
    server?.close()
    await server?.exited
    server = undefined
    try {
      if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // Windows can hold the directory for a moment after the process exits; the OS temp cleaner gets it.
    }
    home = ''
  })

  it('accepts the api-key provider and MCP overrides we build (config/read shows them)', async () => {
    home = mkdtempSync(join(tmpdir(), 'orgai-codexhome-'))
    const servers: ResolvedMcpServer[] = [
      {
        spec: { id: 'm1', name: 'files', transport: 'stdio', command: 'npx', args: ['-y', 'srv', '--flag'], env: { A: '1' }, secretEnv: ['TOKEN'], enabled: true, source: 'user', addedAt: '' },
        env: { A: '1', TOKEN: 's3cret' },
        headers: {}
      },
      {
        spec: { id: 'm2', name: 'remote', transport: 'http', url: 'https://example.com/mcp', headers: { 'X-A': 'b' }, secretHeaders: ['Authorization'], enabled: true, source: 'user', addedAt: '' },
        env: {},
        headers: { 'X-A': 'b', Authorization: 'Bearer tok' }
      }
    ]
    const launch = buildLaunchConfig({ connection: 'litellm' as never, adapter: 'codex', env: { CODEX_HOME: home }, codexAuth: 'apiKey', apiKey: 'sk-test', openaiBaseUrl: 'http://localhost:4000/v1' }, servers)
    server = new CodexAppServer({ env: launch.env, config: launch.config, cwd: project().path === '/repo' ? tmpdir() : project().path })
    await server.start('test')
    const res = (await server.request('config/read', { includeLayers: false })) as { config: Record<string, unknown> }
    const cfg = res.config as { model_provider?: string; model_providers?: Record<string, Record<string, unknown>>; mcp_servers?: Record<string, Record<string, unknown>> }
    expect(cfg.model_provider).toBe('orgai')
    expect(cfg.model_providers?.orgai).toMatchObject({ base_url: 'http://localhost:4000/v1', env_key: 'ORGAI_CODEX_API_KEY', wire_api: 'responses' })
    expect(cfg.mcp_servers?.files).toMatchObject({ command: 'npx', args: ['-y', 'srv', '--flag'], env: { A: '1' }, env_vars: ['TOKEN'] })
    expect(cfg.mcp_servers?.remote).toMatchObject({ url: 'https://example.com/mcp', http_headers: { 'X-A': 'b' } })
    expect(JSON.stringify(res)).not.toContain('s3cret')
  }, 30_000)

  it('thread/start accepts our dynamic tools, instructions, policy and the auto reviewer, and a turn-less thread cannot be resumed (no model turn)', async () => {
    home = mkdtempSync(join(tmpdir(), 'orgai-codexhome-'))
    server = new CodexAppServer({ env: { CODEX_HOME: home }, cwd: tmpdir() })
    await server.start('test')
    const tools = harnessToolsFor(fakeCtx()).map(dynamicToolSpec)
    const params = {
      cwd: tmpdir(),
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review',
      developerInstructions: 'You are a test role.',
      dynamicTools: tools,
      serviceName: 'orgai'
    }
    const started = (await server.request('thread/start', params)) as { thread: { id: string }; approvalPolicy: unknown; sandbox: { type?: string } }
    expect(started.thread.id).toBeTruthy()
    expect(started.approvalPolicy).toBe('on-request')
    // A thread without a first turn has no rollout on disk yet, so it cannot be resumed (verified): resume only after a turn ran.
    await expect(server.request('thread/resume', { threadId: started.thread.id, cwd: tmpdir() })).rejects.toThrow(/no rollout/)
  }, 30_000)
})
