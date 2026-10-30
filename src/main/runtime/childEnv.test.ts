import { describe, expect, it } from 'vitest'
import { isClaudeRoutingVar, isolateClaudeEnv } from './childEnv'

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

const kept = { PATH: '/bin', HOME: '/Users/me', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://corp:3128', NO_PROXY: 'localhost', CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel:4317' }
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
