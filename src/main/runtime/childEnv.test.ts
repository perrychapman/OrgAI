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
  VERTEX_REGION_CLAUDE_4_0_OPUS: 'us',
  UNSET: undefined
}

const kept = { PATH: '/bin', HOME: '/Users/me', LANG: 'en_US.UTF-8', HTTPS_PROXY: 'http://corp:3128', NO_PROXY: 'localhost', CLAUDE_CONFIG_DIR: '/Users/me/.claude-work' }

describe('isolateClaudeEnv', () => {
  it('strips every routing, model, gateway and cloud-provider variable and keeps the rest', () => {
    expect(isolateClaudeEnv(leaky)).toEqual({ ...kept, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok' })
  })

  it('keeps ANTHROPIC_API_KEY only when asked (Anthropic connection, API-key project)', () => {
    expect(isolateClaudeEnv(leaky, { keepApiKey: true }).ANTHROPIC_API_KEY).toBe('sk-inherited')
    expect('ANTHROPIC_API_KEY' in isolateClaudeEnv(leaky, { keepApiKey: false })).toBe(false)
  })

  it('on a proxy connection drops the inherited API key and OAuth token whatever keepApiKey says', () => {
    expect(isolateClaudeEnv(leaky, { proxy: true, keepApiKey: true })).toEqual(kept)
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
    for (const n of ['ANTHROPIC_DEFAULT_SONNET_MODEL_NAME', 'CLAUDE_CODE_USE_SOMETHING_NEW', 'ANTHROPIC_FOUNDRY_RESOURCE', 'claude_code_subagent_model']) {
      expect(isClaudeRoutingVar(n)).toBe(true)
    }
    for (const n of ['PATH', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HTTP_PROXY', 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH']) {
      expect(isClaudeRoutingVar(n)).toBe(false)
    }
  })
})
