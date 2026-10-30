import { describe, expect, it } from 'vitest'
import { PROPOSAL_TOOLS } from '@shared/setup'
import type { AgentInstance } from '@shared/types'
import { TERMINAL_ACTIVITY, authFailureMessage, describeTool, harnessToolActivity, isAuthFailure, runOutcome, scrubAuthDetail, settleAgent } from './activity'

describe('isAuthFailure', () => {
  it('trusts the SDK error code', () => {
    expect(isAuthFailure({ errorCode: 'authentication_failed' })).toBe(true)
    expect(isAuthFailure({ errorCode: 'rate_limit', text: 'Rate limited' })).toBe(false)
  })
  it("matches the CLI's exact bare logged-out reply without an error flag", () => {
    expect(isAuthFailure({ text: 'Invalid API key · Please run /login' })).toBe(true)
    expect(isAuthFailure({ text: 'invalid api key - please run /login  \n' })).toBe(true)
    expect(isAuthFailure({ text: 'Invalid API key. Please run /login' })).toBe(true)
    expect(isAuthFailure({ text: 'Invalid API key · Please run /login and retry' })).toBe(false)
  })
  it("matches the CLI's leading auth wording only on an error", () => {
    const apiError = 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'
    expect(isAuthFailure({ text: apiError })).toBe(false)
    expect(isAuthFailure({ text: apiError, isError: true })).toBe(true)
    expect(isAuthFailure({ text: 'OAuth token has expired. Please obtain a new token.' })).toBe(false)
    expect(isAuthFailure({ text: 'OAuth token has expired. Please obtain a new token.', isError: true })).toBe(true)
    expect(isAuthFailure({ text: 'Failed to authenticate. API Error: 401', errorCode: 'oauth_org_not_allowed', isError: true })).toBe(true)
    // A non-auth error code alone never makes leading auth wording a failure
    expect(isAuthFailure({ text: 'API Error: 401 from upstream', errorCode: 'rate_limit' })).toBe(false)
  })
  it('never flags model text that starts with auth wording', () => {
    expect(isAuthFailure({ text: 'Invalid API key handling is fixed' })).toBe(false)
    expect(isAuthFailure({ text: 'Failed to authenticate users via SSO is now handled.' })).toBe(false)
  })
  it('counts auth words, a 401 or unauthorized anywhere only on an error result', () => {
    expect(isAuthFailure({ text: 'Request failed: HTTP 401 Unauthorized' })).toBe(false)
    expect(isAuthFailure({ text: 'Request failed: HTTP 401 Unauthorized', isError: true })).toBe(true)
    expect(isAuthFailure({ text: 'Proxy said: authentication_error', isError: true })).toBe(true)
  })
  it('never flags a short reply or title that only mentions the words', () => {
    expect(isAuthFailure({ text: 'Fix invalid API key handling' })).toBe(false)
    expect(isAuthFailure({ text: 'The docs say: "Invalid API key · Please run /login" means you are logged out.' })).toBe(false)
  })
  it('never flags an ordinary or long answer', () => {
    expect(isAuthFailure({ text: 'Done. I added the login page.' })).toBe(false)
    expect(isAuthFailure({ text: `${'x'.repeat(500)} invalid api key` })).toBe(false)
    expect(isAuthFailure({})).toBe(false)
  })
})

describe('scrubAuthDetail', () => {
  it('masks key-like tokens and bearer values and keeps one capped line', () => {
    const out = scrubAuthDetail('401: Received API Key = sk-...1234,\nAuthorization: Bearer abc.def key pk-live_xyz')
    expect(out).toBe('401: Received API Key = ***, Authorization: Bearer *** key ***')
    expect(scrubAuthDetail('x'.repeat(900))).toHaveLength(400)
  })
})

describe('authFailureMessage', () => {
  it('names the connection on one line and points to Settings > Connections', () => {
    for (const c of ['anthropic', 'openai', 'litellm', undefined] as const) {
      const m = authFailureMessage(c)
      expect(m).toMatch(/Settings > Connections/)
      expect(m).not.toMatch(/\n/)
    }
    expect(authFailureMessage('litellm')).toMatch(/LiteLLM/)
    expect(authFailureMessage('anthropic')).toMatch(/Anthropic/)
  })
})

describe('describeTool', () => {
  it.each([
    ['Read', { file_path: '/repo/src/app.ts' }, 'Reading app.ts'],
    ['Edit', { file_path: 'src/lib/app.ts' }, 'Editing app.ts'],
    ['Write', { file_path: 'README.md' }, 'Writing README.md'],
    ['NotebookEdit', { notebook_path: '/n/a.ipynb' }, 'Editing notebook a.ipynb'],
    ['Bash', { command: 'npm   run\n  build' }, '$ npm run build'],
    ['Grep', { pattern: 'TODO' }, 'Searching for "TODO"'],
    ['Glob', { pattern: 'src/**/*.ts' }, 'Finding src/**/*.ts'],
    ['WebSearch', { query: 'zod v4' }, 'Searching the web: zod v4'],
    ['WebFetch', { url: 'https://example.com' }, 'Fetching https://example.com'],
    ['Agent', { subagent_type: 'engineer' }, 'Delegating to engineer'],
    ['Task', {}, 'Delegating to a subagent'],
    ['TodoWrite', {}, 'Updating task list'],
    ['mcp__other__thing', {}, 'Using mcp__other__thing']
  ])('%s', (name, input, expected) => {
    expect(describeTool(name, input)).toBe(expected)
  })

  it('truncates long shell commands to 70 characters', () => {
    const text = describeTool('Bash', { command: 'x'.repeat(200) })
    expect(text).toBe(`$ ${'x'.repeat(70)}`)
  })

  it('labels agent messaging tools', () => {
    expect(describeTool('SendMessage', { to: 'implementer-2', message: 'hi' })).toBe('Messaging implementer-2')
    expect(describeTool('SendMessage', {})).toBe('Messaging an agent')
    expect(describeTool('ListAgents', {})).toBe('Checking who is running')
  })

  it('tolerates missing input', () => {
    expect(describeTool('Read', undefined)).toBe('Reading ')
    expect(describeTool('Bash', null)).toBe('$ ')
  })

  it('labels harness tools by bare name', () => {
    expect(describeTool(PROPOSAL_TOOLS.architecture, {}, { harness: true })).toBe('Proposing the architecture…')
    expect(describeTool(PROPOSAL_TOOLS.question, {}, { harness: true })).toBe('Asking you a question…')
    expect(describeTool('integrate_worktrees', {}, { harness: true })).toBe('Talking to the harness')
    expect(harnessToolActivity(PROPOSAL_TOOLS.complete)).toBe('Wrapping up setup…')
    expect(harnessToolActivity('set_plan')).toBe('Writing the plan…')
    expect(harnessToolActivity('update_plan')).toBe('Updating the plan…')
    expect(harnessToolActivity('mark_blocked')).toBe('Marking the plan blocked…')
  })

  it('labels the cross-run tools', () => {
    expect(harnessToolActivity('list_runs')).toBe('Checking other runs…')
    expect(harnessToolActivity('message_run')).toBe('Messaging another run…')
    expect(describeTool('message_run', { runId: 'r' }, { harness: true })).toBe('Messaging another run…')
  })

  it('labels the MCP harness tools, naming the server or query when given', () => {
    expect(harnessToolActivity('list_mcp_servers')).toBe('Checking the MCP servers…')
    expect(harnessToolActivity('search_mcp_registry')).toBe('Searching the MCP registry…')
    expect(harnessToolActivity('request_mcp_install')).toBe('Asking you to add an MCP server…')
    expect(harnessToolActivity('propose_mcp_servers')).toBe('Proposing MCP servers…')
    expect(describeTool('search_mcp_registry', { query: '  post\ngres ' }, { harness: true })).toBe('Searching the MCP registry for "post gres"…')
    expect(describeTool('search_mcp_registry', {}, { harness: true })).toBe('Searching the MCP registry…')
    expect(describeTool('request_mcp_install', { reason: 'r', registry: { name: 'io.github.x/github' } }, { harness: true })).toBe(
      'Asking you to add the io.github.x/github MCP server…'
    )
    expect(describeTool('request_mcp_install', { reason: 'r', manual: { name: 'pg' } }, { harness: true })).toBe('Asking you to add the pg MCP server…')
    expect(describeTool('request_mcp_install', { reason: 'r', manual: { name: 'x'.repeat(80) } }, { harness: true }).length).toBeLessThan(80)
    expect(describeTool('request_mcp_install', null, { harness: true })).toBe('Asking you to add an MCP server…')
  })

  it('does not treat a bare non-harness call as a harness tool', () => {
    expect(describeTool(PROPOSAL_TOOLS.architecture, {})).toBe('Using propose_architecture')
  })
})

describe('terminal labels', () => {
  const agent = (over: Partial<AgentInstance>): AgentInstance => ({
    id: 'r1',
    roleId: null,
    roleSlug: 'engineer',
    name: 'Engineer',
    parentId: 'root',
    spawnToolUseId: null,
    state: 'done',
    activity: 'Reported back',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    startedAt: 1,
    ...over
  })

  it('maps terminal statuses to one outcome and ignores live and paused runs', () => {
    expect(runOutcome('finished', false)).toBe('finished')
    expect(runOutcome('finished', true)).toBe('stopped')
    expect(runOutcome('error', true)).toBe('failed')
    for (const s of ['starting', 'running', 'idle', 'stopping', 'paused'] as const) expect(runOutcome(s, false)).toBeNull()
  })

  it('gives the root the run label instead of "Waiting for you"', () => {
    const root = agent({ id: 'root', parentId: null, state: 'idle', activity: 'Waiting for you' })
    expect(settleAgent(root, false, 'finished', 'root')).toMatchObject({ state: 'done', activity: TERMINAL_ACTIVITY.finished })
    expect(settleAgent(root, false, 'stopped', 'root').activity).toBe('Stopped')
    expect(settleAgent({ ...root, state: 'error' }, false, 'failed', 'root')).toMatchObject({ state: 'error', activity: 'Failed' })
    expect(settleAgent(root, false, 'failed', 'root').state).toBe('error')
  })

  it('relabels cut-off reports and keeps finished ones', () => {
    const waiting = agent({ state: 'waiting', activity: 'Needs approval: Editing a.ts' })
    expect(settleAgent(waiting, false, 'finished', 'root')).toMatchObject({ state: 'done', activity: 'Stopped' })
    expect(settleAgent(waiting, false, 'failed', 'root')).toMatchObject({ state: 'error', activity: 'Failed' })
    // Already marked done by the adapter, but the harness saw it live when the run ended.
    expect(settleAgent(agent({ activity: 'Thinking…' }), true, 'stopped', 'root').activity).toBe('Stopped')
    // Marked done before the terminal status with a waiting label (Codex order).
    expect(settleAgent(agent({ activity: 'Needs approval: Editing a.ts' }), false, 'stopped', 'root').activity).toBe('Stopped')
    const reported = agent({})
    expect(settleAgent(reported, false, 'stopped', 'root')).toBe(reported)
  })

  it('sets endedAt only when it settles a live agent and keeps an existing one', () => {
    expect(settleAgent(agent({ state: 'thinking', activity: 'x' }), false, 'stopped', 'root').endedAt).toBeTypeOf('number')
    expect(settleAgent(agent({ state: 'thinking', activity: 'x', endedAt: 5 }), false, 'stopped', 'root').endedAt).toBe(5)
    expect('endedAt' in settleAgent(agent({ activity: 'Waiting for you' }), false, 'stopped', 'root')).toBe(false)
    // A finished report keeps a label that merely starts with "Waiting".
    const done = agent({ activity: 'Waiting on the build, then reported' })
    expect(settleAgent(done, false, 'finished', 'root')).toBe(done)
  })
})
