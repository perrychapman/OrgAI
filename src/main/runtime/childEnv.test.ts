import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { testServer } from '../mcp/probe'
import { buildEnv, completionEnv, toClaudeMcpServers } from './claude'
import { CodexAppServer } from './codexAppServer'
import { fakeCtx } from './testHelpers'
import type { RunConnection } from './types'
import { ORGAI_CONTROL_ENV_PATTERNS, isClaudeRoutingVar, isolateClaudeEnv, scrubControlEnv } from './childEnv'

describe('scrubControlEnv (cli-spec 3.4(3))', () => {
  const control = {
    ORGAI_DATA_DIR: '/data',
    orgai_data_dir: '/data2',
    ORGAI_DAEMON_SOCKET: '/s',
    Orgai_Daemon_Secret: 'x',
    ORGAI_SECRET_OVERLAY: 'y',
    orgai_secret_file: 'z',
    ORGAI_VAULT_KEY_FILE: '/k',
    orgai_vault_custody: 'file',
    ORGAI_CLI_DATA_DIR: '/cli-data',
    orgai_cli_data_dir: '/cli-data2',
    ORGAI_CLI_VAULT_KEY_FILE: '/ck',
    orgai_cli_vault_no_os_keystore: '1',
    ELECTRON_RUN_AS_NODE: '1',
    electron_run_as_node: '1'
  }
  const kept = { PATH: '/bin', ORGAI_MOCK: '1', ORGAI_CODEX_PATH: '/c', ORGAI_CLAUDE_PATH: '/cl', ORGAI_VAULTX: 'v', MY_ORGAI_VAULT_KEY: 'w', ORGAI_CODEX_API_KEY: 'k', ORGAI_DATA_DIRX: 'q', ORGAI_CLI_DATA_DIRX: 'q2', ORGAI_CLI_VAULTX: 'q3', MY_ORGAI_DATA_DIR: 'r', HOME: '/h' }

  it('drops each name and pattern case-insensitively and keeps the rest (ORGAI_MOCK included)', () => {
    const input = { ...control, ...kept, UNDEF: undefined }
    const copy = { ...input }
    const out = scrubControlEnv(input)
    expect(out).toEqual({ ...kept, UNDEF: undefined })
    expect(input).toEqual(copy)
    for (const name of Object.keys(control)) expect(ORGAI_CONTROL_ENV_PATTERNS.some((re) => re.test(name))).toBe(true)
  })

  it('Claude child envs drop them, connection-set values and MCP specs included', () => {
    const base = { ...control, ...kept }
    const conn = { connection: 'anthropic', adapter: 'claude', env: { ORGAI_DATA_DIR: '/evil', ELECTRON_RUN_AS_NODE: '1', ANTHROPIC_API_KEY: 'k' } } as unknown as RunConnection
    const ctx = fakeCtx({ connection: conn })
    for (const env of [buildEnv(ctx, base), completionEnv(conn, base), completionEnv(undefined, base)]) {
      for (const name of Object.keys(control)) expect(name in env, name).toBe(false)
      expect(env.ORGAI_MOCK).toBe('1')
    }
    expect(buildEnv(ctx, base).ANTHROPIC_API_KEY).toBe('k')
    const mcp = toClaudeMcpServers([
      { spec: { id: 'm', name: 'srv', transport: 'stdio', command: 'node', enabled: true, source: 'user', addedAt: '' }, env: { ORGAI_DAEMON_X: '1', A: '1' }, headers: {} },
      { spec: { id: 'n', name: 'bare', transport: 'stdio', command: 'node', enabled: true, source: 'user', addedAt: '' }, env: { ELECTRON_RUN_AS_NODE: '1' }, headers: {} }
    ])
    expect((mcp.srv as { env?: Record<string, string> }).env).toEqual({ A: '1' })
    expect('env' in mcp.bare!).toBe(false)
  })

  it('the Codex app-server and an MCP probe spawn without them', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-childenv-')))
    const saved: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries({ ORGAI_DATA_DIR: '/data', ORGAI_DAEMON_SOCKET: '/s', ORGAI_SECRET_OVERLAY: 'y', ELECTRON_RUN_AS_NODE: '1' })) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    try {
      // A fake `codex` that is Node itself: start() runs `node app-server ...` in cwd; the script records its env.
      const codexOut = join(dir, 'codex-env.json')
      writeFileSync(join(dir, 'app-server'), `require('fs').writeFileSync(${JSON.stringify(codexOut)}, JSON.stringify(process.env)); process.exit(1)`)
      const server = new CodexAppServer({ cwd: dir, env: { CODEX_HOME: join(dir, 'home'), ORGAI_SECRET_X: 'conn' }, binary: { path: process.execPath } })
      await expect(server.start()).rejects.toThrow()
      server.close()
      const codexEnv = JSON.parse(readFileSync(codexOut, 'utf8')) as Record<string, string>
      for (const name of ['ORGAI_DATA_DIR', 'ORGAI_DAEMON_SOCKET', 'ORGAI_SECRET_OVERLAY', 'ORGAI_SECRET_X', 'ELECTRON_RUN_AS_NODE']) expect(name in codexEnv, name).toBe(false)
      expect(codexEnv.CODEX_HOME).toBe(join(dir, 'home'))
      // An MCP probe: a stdio "server" that records its env and exits.
      const probeOut = join(dir, 'probe-env.json')
      const script = join(dir, 'probe.js')
      writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify(process.env)); process.exit(1)`)
      const result = await testServer(
        { spec: { id: 'p', name: 'p', transport: 'stdio', command: process.execPath, args: [script], enabled: true, source: 'user', addedAt: '' }, env: { ORGAI_DATA_DIR: '/spec', B: '2' }, headers: {} },
        5000
      )
      expect(result.ok).toBe(false)
      const probeEnv = JSON.parse(readFileSync(probeOut, 'utf8')) as Record<string, string>
      for (const name of ['ORGAI_DATA_DIR', 'ORGAI_DAEMON_SOCKET', 'ORGAI_SECRET_OVERLAY']) expect(name in probeEnv, name).toBe(false)
      expect(probeEnv.B).toBe('2')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('isolateClaudeEnv drops them too, whatever the options', () => {
    for (const opts of [{}, { keepApiKey: true }, { proxy: true }]) {
      const out = isolateClaudeEnv({ ...control, ...kept }, opts)
      for (const name of Object.keys(control)) expect(name in out).toBe(false)
      expect(out.ORGAI_MOCK).toBe('1')
      expect(out.PATH).toBe('/bin')
    }
  })
})

const leaky = {
  PATH: '/bin',
  HOME: '/Users/me',
  LANG: 'en_US.UTF-8',
  HTTPS_PROXY: 'http://corp:3128',
  NO_PROXY: 'localhost',
  CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok',
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh-tok',
  ANTHROPIC_API_KEY: 'sk-inherited',
  ANTHROPIC_BASE_URL: 'http://my-gateway:4000',
  ANTHROPIC_AUTH_TOKEN: 'gateway-key',
  ANTHROPIC_MODEL: 'gpt-x',
  ANTHROPIC_SMALL_FAST_MODEL: 'gpt-mini',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'o',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 's',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'f',
  CLAUDE_CODE_SUBAGENT_MODEL: 'sub',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
  ANTHROPIC_CUSTOM_HEADERS: 'x: y',
  ANTHROPIC_BETAS: 'b',
  ANTHROPIC_PROFILE: 'p',
  ANTHROPIC_FEDERATION_RULE_ID: 'r',
  ANTHROPIC_ORGANIZATION_ID: 'org',
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
  CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '1',
  ANTHROPIC_VERTEX_PROJECT_ID: 'proj',
  ANTHROPIC_BEDROCK_BASE_URL: 'u',
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
  AWS_BEARER_TOKEN_BEDROCK: 'aws',
  CLOUD_ML_REGION: 'us',
  ANTHROPIC_UNIX_SOCKET: '/tmp/s',
  ANTHROPIC_AWS_WORKSPACE_ID: 'w',
  VERTEX_REGION_CLAUDE_4_0_OPUS: 'us',
  ANTHROPIC_IDENTITY_TOKEN: 'jwt',
  ANTHROPIC_IDENTITY_TOKEN_FILE: '/var/run/token',
  ANTHROPIC_SERVICE_ACCOUNT_ID: 'sa',
  ANTHROPIC_WORKSPACE_ID: 'ws',
  CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER: '1',
  CLAUDE_CODE_DISABLE_AUTH_REFRESH_LOCK: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4317',
  UNSET: undefined
}

const kept = { PATH: '/bin', HOME: '/Users/me', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://corp:3128', NO_PROXY: 'localhost', CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4317', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
const anthropicKept = { ...kept, CLAUDE_CONFIG_DIR: '/Users/me/.claude-work' }

describe('isolateClaudeEnv', () => {
  it('strips every routing, model, gateway and cloud-provider variable and keeps the rest', () => {
    expect(isolateClaudeEnv(leaky)).toEqual({ ...anthropicKept, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok', CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh-tok' })
  })

  it('keeps ANTHROPIC_API_KEY only when asked (Anthropic connection, API-key project)', () => {
    expect(isolateClaudeEnv(leaky, { keepApiKey: true }).ANTHROPIC_API_KEY).toBe('sk-inherited')
    expect('ANTHROPIC_API_KEY' in isolateClaudeEnv(leaky, { keepApiKey: false })).toBe(false)
  })

  it('on a proxy connection drops the inherited API key, OAuth token and CLAUDE_CONFIG_DIR whatever keepApiKey says', () => {
    expect(isolateClaudeEnv(leaky, { proxy: true, keepApiKey: true })).toEqual(kept)
    expect('claude_config_dir' in isolateClaudeEnv({ claude_config_dir: '/x' }, { proxy: true })).toBe(false)
  })

  it('matches names case-insensitively (Windows env) and never mutates its input', () => {
    const base = { Anthropic_Base_Url: 'http://x', Path: 'C:\\bin' }
    const copy = { ...base }
    expect(isolateClaudeEnv(base)).toEqual({ Path: 'C:\\bin' })
    expect(base).toEqual(copy)
  })
})

describe('isClaudeRoutingVar', () => {
  it('covers the families and leaves ordinary variables alone', () => {
    for (const n of ['ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'CLAUDE_CODE_USE_SOMETHING_NEW', 'ANTHROPIC_FOUNDRY_RESOURCE', 'claude_code_subagent_model', 'ANTHROPIC_IDENTITY_NEW', 'ANTHROPIC_FEDERATION_RULE_ID', 'CLAUDE_CODE_DISABLE_SOMETHING_NEW', 'CLAUDE_CODE_ENABLE_XAA']) {
      expect(isClaudeRoutingVar(n)).toBe(true)
    }
    for (const n of ['PATH', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'claude_code_enable_telemetry']) {
      expect(isClaudeRoutingVar(n)).toBe(false)
    }
  })
})
