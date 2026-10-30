import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  API_KEY_ENV,
  buildLaunchConfig,
  codexToolName,
  dynamicToolSpec,
  harnessToolName,
  jsonSchemaOf,
  matchesBashRule,
  mcpToolPrefix,
  parseCommandApproval,
  parseFileApproval,
  parsePermissionsApproval,
  parseThreadResult,
  parseToolCall,
  parseTurnId,
  parseUserInputQuestions,
  policyFor,
  tomlKey,
  tomlString,
  unwrapShellCommand,
  untilFromRateLimits,
  userInput
} from './codexProtocol'
import { harnessToolsFor } from './harnessTools'
import { fakeCtx } from './testHelpers'
import type { ResolvedMcpServer, RunConnection } from './types'
import type { McpServerSpec } from '@shared/types'

function spec(over: Partial<McpServerSpec> & { name: string }): McpServerSpec {
  return { id: `id-${over.name}`, transport: 'stdio', enabled: true, source: 'user', addedAt: '', ...over }
}
function resolved(s: McpServerSpec, env: Record<string, string> = {}, headers: Record<string, string> = {}): ResolvedMcpServer {
  return { spec: s, env, headers }
}

describe('policyFor (permission mode -> approval policy + sandbox)', () => {
  const work = { writes: true, setupLike: false }
  it('maps every mode', () => {
    expect(policyFor('auto', work)).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review', autoAcceptEdits: false, denyApprovals: false })
    expect(policyFor('acceptEdits', work)).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'workspace-write', autoAcceptEdits: true })
    expect(policyFor('default', work)).toMatchObject({ approvalPolicy: 'untrusted', sandbox: 'workspace-write', autoAcceptEdits: false, denyApprovals: false })
    expect(policyFor('dontAsk', work)).toMatchObject({ approvalPolicy: 'never', sandbox: 'workspace-write', denyApprovals: true })
    expect(policyFor('plan', work)).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only', denyApprovals: true })
    expect(policyFor('bypassPermissions', work)).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  })

  it('keeps read-only roles read-only, even when the mode would allow writes', () => {
    expect(policyFor('bypassPermissions', { writes: false, setupLike: false }).sandbox).toBe('read-only')
    expect(policyFor('auto', { writes: false, setupLike: false }).sandbox).toBe('read-only')
  })

  it('never lets setup edit files and lets a plan-only project still read', () => {
    expect(policyFor('bypassPermissions', { writes: true, setupLike: true }).sandbox).toBe('read-only')
    const plan = policyFor('plan', { writes: true, setupLike: true })
    expect(plan).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'untrusted', denyApprovals: false })
  })
})

describe('matchesBashRule (saved allow rules)', () => {
  const rules = ['Bash(npm test:*)', 'Bash(git status)', 'Edit', 'Read']
  it('matches prefix and exact rules', () => {
    expect(matchesBashRule('npm test', rules)).toBe(true)
    expect(matchesBashRule('npm test -- --watch', rules)).toBe(true)
    expect(matchesBashRule('git status', rules)).toBe(true)
    expect(matchesBashRule('git status -s', rules)).toBe(false)
    expect(matchesBashRule('npm testing', rules)).toBe(false)
    expect(matchesBashRule('npm install', rules)).toBe(false)
  })

  it('never matches commands with shell control operators', () => {
    for (const c of ['npm test && rm -rf x', 'npm test; ls', 'npm test | tee out', 'npm test > out.txt', 'npm test $(whoami)', 'npm test `id`', 'npm test\nrm x']) {
      expect(matchesBashRule(c, rules)).toBe(false)
    }
  })

  it('unwraps bash -lc and powershell -Command wrappers', () => {
    expect(unwrapShellCommand(`bash -lc 'npm test'`)).toBe('npm test')
    expect(unwrapShellCommand(`"C:\\Program Files\\PowerShell\\pwsh.exe" -Command "npm test"`)).toBe('npm test')
    expect(matchesBashRule(`bash -lc 'npm test --silent'`, rules)).toBe(true)
    expect(matchesBashRule(`bash -lc 'npm test && rm x'`, rules)).toBe(false)
    expect(unwrapShellCommand('ls -la')).toBe('ls -la')
  })
})

describe('approval and tool call parsing', () => {
  it('parses command, file and permission approvals defensively', () => {
    expect(parseCommandApproval({ threadId: 't', itemId: 'i', command: 'ls', cwd: '/r', reason: 'net', extra: 1 })).toEqual({ threadId: 't', itemId: 'i', command: 'ls', cwd: '/r', reason: 'net' })
    expect(parseCommandApproval({ threadId: 't' })).toBeNull()
    expect(parseCommandApproval(null)).toBeNull()
    expect(parseFileApproval({ threadId: 't', itemId: 'i', grantRoot: '/r' })).toEqual({ threadId: 't', itemId: 'i', grantRoot: '/r' })
    expect(parsePermissionsApproval({ threadId: 't', itemId: 'i', reason: 'r', permissions: { network: { enabled: true }, fileSystem: null } })).toEqual({
      threadId: 't',
      itemId: 'i',
      reason: 'r',
      requested: { network: { enabled: true } }
    })
  })

  it('parses dynamic tool calls and thread results', () => {
    expect(parseToolCall({ threadId: 't', turnId: 'u', callId: 'c', namespace: null, tool: 'set_plan', arguments: { goal: 'g' } })).toEqual({ threadId: 't', turnId: 'u', callId: 'c', tool: 'set_plan', arguments: { goal: 'g' } })
    expect(parseToolCall({ threadId: 't' })).toBeNull()
    expect(parseThreadResult({ thread: { id: 'th' }, model: 'gpt-5', cwd: '/r' })).toEqual({ threadId: 'th', model: 'gpt-5', cwd: '/r' })
    expect(parseThreadResult({ thread: {} })).toBeNull()
    expect(parseTurnId({ turn: { id: 'tu' } })).toBe('tu')
    expect(parseTurnId({})).toBeUndefined()
  })

  it('parses request_user_input questions', () => {
    const q = parseUserInputQuestions({ threadId: 't', questions: [{ id: 'q1', header: 'DB', question: 'Which?', isOther: true, isSecret: false, options: [{ label: 'pg', description: 'Postgres' }, { nope: 1 }] }] })
    expect(q?.questions[0]).toEqual({ id: 'q1', header: 'DB', question: 'Which?', isOther: true, options: [{ label: 'pg', description: 'Postgres' }] })
  })

  it('builds user input with images first as data URLs', () => {
    const items = userInput('look', [{ mediaType: 'image/png', data: 'QUJD' }])
    expect(items).toEqual([{ type: 'image', url: 'data:image/png;base64,QUJD' }, { type: 'text', text: 'look', text_elements: [] }])
    expect(userInput('', [{ mediaType: 'image/png', data: 'QUJD' }])).toHaveLength(1)
    expect(userInput('hi')).toEqual([{ type: 'text', text: 'hi', text_elements: [] }])
  })
})

describe('dynamic tool specs', () => {
  it('turns every harness tool into a function spec with a JSON schema from zod', () => {
    const tools = harnessToolsFor(fakeCtx())
    const specs = tools.map(dynamicToolSpec)
    expect(specs.map((s) => s.name)).toEqual(['set_plan', 'orgai_update_plan', 'complete_plan', 'mark_blocked', 'ask_user', 'integrate_worktrees', 'propose_org_change', 'list_mcp_servers', 'search_mcp_registry', 'request_mcp_install', 'request_permission_rules', 'list_runs', 'message_run'])
    const setPlan = specs[0]
    expect(setPlan).toMatchObject({ type: 'function' })
    const schema = setPlan.inputSchema as { type: string; required: string[]; properties: Record<string, { type?: string }> }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['goal', 'steps'])
    expect(schema.properties.steps.type).toBe('array')
    expect(JSON.stringify(specs)).not.toContain('$schema')
    for (const s of specs) expect(s.description.length).toBeGreaterThan(10)
  })

  it('renames update_plan, which collides with a built-in Codex tool, and maps it back', () => {
    expect(codexToolName('update_plan')).toBe('orgai_update_plan')
    expect(harnessToolName('orgai_update_plan')).toBe('update_plan')
    expect(codexToolName('set_plan')).toBe('set_plan')
  })

  it('gives empty objects a properties member and strips $schema', () => {
    expect(jsonSchemaOf(z.object({}))).toMatchObject({ type: 'object', properties: {} })
    expect(jsonSchemaOf(z.object({ a: z.string().optional() }))).not.toHaveProperty('$schema')
  })
})

describe('buildLaunchConfig', () => {
  const secretValue = 'sk-super-secret-1234'
  const conn = (over: Partial<RunConnection> = {}): RunConnection => ({ connection: 'chatgpt' as never, adapter: 'codex', env: { CODEX_HOME: '/data/codex' }, ...over })

  it('ChatGPT login adds no provider and keeps CODEX_HOME', () => {
    const l = buildLaunchConfig(conn({ codexAuth: 'chatgpt' }), [])
    expect(l.config).toEqual([])
    expect(l.env).toEqual({ CODEX_HOME: '/data/codex' })
  })

  it('API key configures an orgai provider with the key only in the environment', () => {
    const l = buildLaunchConfig(conn({ codexAuth: 'apiKey', apiKey: secretValue, openaiBaseUrl: 'http://localhost:4000/v1' }), [])
    expect(l.config).toEqual([
      'model_provider="orgai"',
      'model_providers.orgai.name="OrgAI"',
      'model_providers.orgai.base_url="http://localhost:4000/v1"',
      `model_providers.orgai.env_key="${API_KEY_ENV}"`,
      'model_providers.orgai.wire_api="responses"'
    ])
    expect(l.env[API_KEY_ENV]).toBe(secretValue)
    expect(JSON.stringify(l.config)).not.toContain(secretValue)
    expect(JSON.stringify(l.summary)).not.toContain(secretValue)
  })

  it('falls back to the OpenAI base URL', () => {
    const l = buildLaunchConfig(conn({ codexAuth: 'apiKey', apiKey: 'k' }), [])
    expect(l.config).toContain('model_providers.orgai.base_url="https://api.openai.com/v1"')
  })

  it('configures stdio servers; secret env values are forwarded by name, never in argv or the summary', () => {
    const s = spec({ name: 'files', command: 'npx', args: ['-y', 'srv', '--root=a b'], env: { MODE: 'ro' }, secretEnv: ['API_TOKEN'] })
    const l = buildLaunchConfig(conn(), [resolved(s, { MODE: 'ro', API_TOKEN: secretValue })])
    expect(l.config).toEqual([
      'mcp_servers.files.command="npx"',
      'mcp_servers.files.args=["-y", "srv", "--root=a b"]',
      'mcp_servers.files.env={ MODE = "ro" }',
      'mcp_servers.files.env_vars=["API_TOKEN"]'
    ])
    expect(l.env.API_TOKEN).toBe(secretValue)
    expect(l.config.join('\n')).not.toContain(secretValue)
    expect(l.summary.join('\n')).not.toContain(secretValue)
  })

  it('configures http servers: plain headers inline, secret headers by environment variable', () => {
    const s = spec({ name: 'remote', transport: 'http', url: 'https://x.test/mcp', headers: { 'X-Team': 'a' }, secretHeaders: ['Authorization', 'X-Key'] })
    const l = buildLaunchConfig(conn(), [resolved(s, {}, { 'X-Team': 'a', Authorization: `Bearer ${secretValue}`, 'X-Key': 'kkk-secret' })])
    expect(l.config).toContain('mcp_servers.remote.url="https://x.test/mcp"')
    expect(l.config).toContain('mcp_servers.remote.http_headers={ X-Team = "a" }')
    expect(l.config).toContain('mcp_servers.remote.bearer_token_env_var="ORGAI_MCP_0_H0"')
    expect(l.config).toContain('mcp_servers.remote.env_http_headers={ X-Key = "ORGAI_MCP_0_H1" }')
    expect(l.env.ORGAI_MCP_0_H0).toBe(secretValue)
    expect(l.env.ORGAI_MCP_0_H1).toBe('kkk-secret')
    expect(l.config.join('\n')).not.toMatch(/sk-super|kkk-secret/)
  })

  it('never prints a header value in the summary, config or argv', () => {
    const s = spec({ name: 'remote', transport: 'http', url: 'https://x.test/mcp', headers: {}, secretHeaders: ['Authorization'] })
    const l = buildLaunchConfig(conn(), [resolved(s, {}, { Authorization: 'Bearer secret123' })])
    expect(l.summary.join('\n')).not.toContain('secret123')
    expect(l.config.join('\n')).not.toContain('secret123')
    expect(l.env.ORGAI_MCP_0_H0).toBe('secret123')
  })

  it('hands an OAuth access token to Codex through the environment only', () => {
    const s = spec({ name: 'oauthy', transport: 'http', url: 'https://x.test/mcp', headers: { 'X-Team': 'a' }, oauth: { resource: 'https://x.test/mcp' } as McpServerSpec['oauth'] })
    const l = buildLaunchConfig(conn(), [resolved(s, {}, { 'X-Team': 'a', Authorization: 'Bearer tok-oauth-123' })])
    expect(l.config).toContain('mcp_servers.oauthy.bearer_token_env_var="ORGAI_MCP_0_H0"')
    expect(l.config).toContain('mcp_servers.oauthy.http_headers={ X-Team = "a" }')
    expect(l.env.ORGAI_MCP_0_H0).toBe('tok-oauth-123')
    expect(l.config.join(' ')).not.toContain('tok-oauth-123')
    expect(l.summary.join(' ')).not.toContain('tok-oauth-123')
    expect(Object.values(l.env)).not.toContain('Bearer tok-oauth-123')
  })

  it('treats a resolved header that differs from the declared one as secret', () => {
    const s = spec({ name: 'r', transport: 'http', url: 'https://x.test/mcp', headers: { 'X-Key': 'public' } })
    const l = buildLaunchConfig(conn(), [resolved(s, {}, { 'X-Key': 'overridden-secret' })])
    expect(l.config.join(' ')).not.toContain('overridden-secret')
    expect(l.config).toContain('mcp_servers.r.env_http_headers={ X-Key = "ORGAI_MCP_0_H0" }')
  })

  it('falls back to inline env on a secret name clash between servers and says so', () => {
    const a = spec({ name: 'a', command: 'a', secretEnv: ['TOKEN'] })
    const b = spec({ name: 'b', command: 'b', secretEnv: ['TOKEN'] })
    const l = buildLaunchConfig(conn(), [resolved(a, { TOKEN: 'one' }), resolved(b, { TOKEN: 'two' })])
    expect(l.env.TOKEN).toBe('one')
    expect(l.config).toContain('mcp_servers.a.env_vars=["TOKEN"]')
    expect(l.config).toContain('mcp_servers.b.env={ TOKEN = "two" }')
    expect(l.summary.join('\n')).toContain('WARNING TOKEN passed inline')
    expect(l.summary.join('\n')).not.toContain('two')
  })

  it('skips disabled servers and servers without a command or url', () => {
    const l = buildLaunchConfig(conn(), [resolved(spec({ name: 'off', command: 'x', enabled: false })), resolved(spec({ name: 'nocmd' })), resolved(spec({ name: 'nourl', transport: 'sse' }))])
    expect(l.config).toEqual([])
    expect(l.skipped.map((s) => s.name)).toEqual(['nocmd', 'nourl'])
  })

  it('quotes awkward server names and values as TOML', () => {
    expect(tomlKey('plain-name_1')).toBe('plain-name_1')
    expect(tomlKey('a.b')).toBe('"a.b"')
    expect(tomlString('say "hi"\n\\')).toBe('"say \\"hi\\"\\n\\\\"')
    expect(mcpToolPrefix('github')).toBe('mcp__github__')
  })
})

describe('untilFromRateLimits', () => {
  it('returns the reset of the exhausted window in ms', () => {
    const v = { rateLimits: { primary: { usedPercent: 100, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 40, resetsAt: 1_800_500_000 } }, rateLimitsByLimitId: null }
    expect(untilFromRateLimits(v)).toBe(1_800_000_000_000)
  })
  it('is undefined when nothing is exhausted or the shape is unexpected', () => {
    expect(untilFromRateLimits({ rateLimits: { primary: { usedPercent: 10, resetsAt: 1 } } })).toBeUndefined()
    expect(untilFromRateLimits('x')).toBeUndefined()
  })
})
