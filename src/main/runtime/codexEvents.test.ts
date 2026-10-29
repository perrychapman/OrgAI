import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexEventMapper, ThrottledPartial, contentText, parseJsonl, type CodexUpdate } from './codexEvents'
import { parseNotification } from './codexProtocol'

function fixture(name: string): { method: string; params: unknown }[] {
  return parseJsonl(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
}

function run(name: string, mapper: CodexEventMapper): CodexUpdate[] {
  return fixture(name).flatMap((n) => mapper.handle(n.method, n.params))
}

describe('basic turn fixture', () => {
  const updates = run('codex-turn-basic.jsonl', new CodexEventMapper())
  const of = <T extends CodexUpdate['type']>(type: T): Extract<CodexUpdate, { type: T }>[] => updates.filter((u): u is Extract<CodexUpdate, { type: T }> => u.type === type)

  it('maps the reasoning summary to a thinking block on completion', () => {
    expect(of('thinking')).toEqual([{ type: 'thinking', threadId: 'th-1', text: 'Check the repo layout first' }])
  })

  it('maps commands to Bash tool_use/tool_result with activity', () => {
    const uses = of('toolUse')
    expect(uses.map((u) => [u.id, u.name, u.activity])).toEqual([
      ['it-c1', 'Bash', '$ git status --short'],
      ['it-c2', 'Bash', '$ npm test']
    ])
    expect(uses[0].input).toEqual({ command: 'git status --short', cwd: '/repo' })
    const results = of('toolResult')
    expect(results[0]).toMatchObject({ toolUseId: 'it-c1', content: ' M src/a.ts\n', isError: false })
    expect(results[1]).toMatchObject({ toolUseId: 'it-c2', isError: true })
    expect(results[1].content).toContain('[exit code 1]')
  })

  it('accumulates agent message deltas into partial text and clears it on completion', () => {
    const partials = of('partial').map((p) => p.text)
    expect(partials.slice(0, 2)).toEqual(['One test ', 'One test fails.'])
    expect(of('text')).toEqual([{ type: 'text', threadId: 'th-1', itemId: 'it-m1', text: 'One test fails.' }])
    const idx = updates.findIndex((u) => u.type === 'text')
    expect(updates[idx - 1]).toEqual({ type: 'partial', threadId: 'th-1', text: '' })
  })

  it('reports cumulative tokens, never cost', () => {
    expect(of('tokens')).toEqual([{ type: 'tokens', threadId: 'th-1', input: 1200, output: 300 }])
    expect(JSON.stringify(updates)).not.toMatch(/cost/i)
  })

  it('completes the turn with the final answer as result', () => {
    expect(of('turnCompleted')).toEqual([{ type: 'turnCompleted', threadId: 'th-1', turnId: 'tu-1', status: 'completed', result: 'One test fails.' }])
    expect(of('turnStarted')).toHaveLength(1)
  })
})

describe('tools fixture', () => {
  const mapper = new CodexEventMapper({
    harnessToolNames: ['set_plan', 'orgai_update_plan', 'ask_user'],
    isBlockingTool: (name) => name === 'ask_user'
  })
  const updates = run('codex-turn-tools.jsonl', mapper)
  const uses = updates.filter((u): u is Extract<CodexUpdate, { type: 'toolUse' }> => u.type === 'toolUse')
  const byId = (id: string) => uses.find((u) => u.id === id)!

  it('exposes harness tools as mcp__orgai__<bare name> with harness activity', () => {
    expect(byId('it-d1')).toMatchObject({ name: 'mcp__orgai__set_plan', activity: 'Writing the plan…', state: 'tool' })
    expect(byId('it-d2')).toMatchObject({ name: 'mcp__orgai__update_plan', activity: 'Updating the plan…' })
  })

  it('marks blocking harness tools as waiting', () => {
    expect(byId('it-d3').state).toBe('waiting')
  })

  it('aliases the network tools to the Claude names', () => {
    expect(byId('it-d4')).toMatchObject({ name: 'Agent', activity: 'Delegating to engineer' })
    expect(byId('it-d4').input).toMatchObject({ subagent_type: 'engineer', name: 'login-eng' })
  })

  it('maps file changes to Edit or Write', () => {
    expect(byId('it-f1')).toMatchObject({ name: 'Edit', activity: 'Editing a.ts' })
    expect(byId('it-f2')).toMatchObject({ name: 'Write', activity: 'Writing new.ts' })
    const results = updates.filter((u): u is Extract<CodexUpdate, { type: 'toolResult' }> => u.type === 'toolResult')
    expect(results.find((r) => r.toolUseId === 'it-f1')).toMatchObject({ content: 'update a.ts', isError: false })
    expect(results.find((r) => r.toolUseId === 'it-f2')).toMatchObject({ isError: true })
  })

  it('maps MCP calls to mcp__<server>__<tool> and web search', () => {
    expect(byId('it-p1')).toMatchObject({ name: 'mcp__github__list_issues', activity: 'Using mcp__github__list_issues' })
    expect(updates).toContainEqual({ type: 'toolResult', threadId: 'th-1', toolUseId: 'it-p1', content: '3 open issues', isError: false })
    expect(byId('it-w1')).toMatchObject({ name: 'WebSearch', activity: 'Searching the web: zod toJSONSchema' })
  })

  it('warns about Codex built-in multi-agent calls', () => {
    expect(updates.filter((u) => u.type === 'log')).toHaveLength(1)
  })

  it('flags a usage limit error and the failed turn', () => {
    expect(updates).toContainEqual({ type: 'error', threadId: 'th-1', message: "You've hit your usage limit.", willRetry: false, usageLimit: true })
    const done = updates.find((u) => u.type === 'turnCompleted') as Extract<CodexUpdate, { type: 'turnCompleted' }>
    expect(done.status).toBe('failed')
    expect(done.error?.info).toBe('usageLimitExceeded')
  })
})

describe('parsing', () => {
  it('ignores unknown or malformed notifications', () => {
    expect(parseNotification('thread/started', {})).toBeNull()
    expect(parseNotification('item/started', { threadId: 't' })).toBeNull()
    expect(new CodexEventMapper().handle('item/completed', 'nope')).toEqual([])
  })

  it('treats a retried transient rate limit as no usage limit', () => {
    const m = new CodexEventMapper()
    const retry = m.handle('error', { threadId: 't', turnId: 'u', willRetry: true, error: { message: 'slow down', codexErrorInfo: 'rateLimitExceeded' } })
    expect(retry[0]).toMatchObject({ usageLimit: false, willRetry: true })
    const final = m.handle('error', { threadId: 't', turnId: 'u', willRetry: false, error: { message: 'slow down', codexErrorInfo: 'rateLimitExceeded' } })
    expect(final[0]).toMatchObject({ usageLimit: true })
  })

  it('reads object-shaped codexErrorInfo and the http status', () => {
    const n = parseNotification('error', { threadId: 't', willRetry: false, error: { message: 'x', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } } } })
    expect(n).toMatchObject({ kind: 'error', error: { info: 'httpConnectionFailed', httpStatus: 502 } })
  })

  it('flattens tool output content', () => {
    expect(contentText([{ type: 'inputText', text: 'a' }, { type: 'inputImage', imageUrl: 'x' }, 'b'])).toBe('a\n[image]\nb')
    expect(contentText(null)).toBe('')
  })

  it('keeps item lookups for approval cards', () => {
    const m = new CodexEventMapper()
    for (const n of fixture('codex-turn-tools.jsonl')) m.handle(n.method, n.params)
    expect(m.item('it-f1')?.type).toBe('fileChange')
  })
})

describe('ThrottledPartial', () => {
  afterEach(() => vi.useRealTimers())

  it('emits the first text at once, throttles the rest and clears', () => {
    vi.useFakeTimers()
    const out: string[] = []
    const p = new ThrottledPartial((_id, text) => out.push(text), 100)
    p.set('a', 'x')
    p.set('a', 'xy')
    p.set('a', 'xyz')
    expect(out).toEqual(['x'])
    vi.advanceTimersByTime(150)
    expect(out).toEqual(['x', 'xyz'])
    p.clear('a')
    expect(out).toEqual(['x', 'xyz', ''])
  })
})
