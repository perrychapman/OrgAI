import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexEventMapper, NETWORK_TOOLS, ThrottledPartial, canonicalNetworkTool, contentText, fileChangeTargets, fileChanges, parseJsonl, type CodexUpdate } from './codexEvents'
import { parseNotification } from './codexProtocol'

describe('returned media', () => {
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  it('retains MCP source order and unsupported audio alongside text', () => {
    const mapper = new CodexEventMapper()
    const updates = mapper.handle('item/completed', { threadId: 't', item: { type: 'mcpToolCall', id: 'm', status: 'completed', result: { content: [
      { type: 'text', text: 'Before' }, { type: 'image', mimeType: 'image/png', data }, { type: 'text', text: 'After' }, { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }
    ] } } })
    expect(updates).toEqual([expect.objectContaining({ type: 'toolResult', toolUseId: 'm', isError: false, parts: [
      { type: 'text', text: 'Before' }, { type: 'media', media: expect.objectContaining({ kind: 'image' }) }, { type: 'text', text: 'After' }, { type: 'media', media: expect.objectContaining({ kind: 'unsupported' }) }
    ] })])
  })
  it('shows native imageView as unavailable without reading its arbitrary path', () => {
    const updates = new CodexEventMapper().handle('item/completed', { threadId: 't', item: { type: 'imageView', id: 'i', path: 'C:/private/secret.png' } })
    expect(updates).toEqual([{ type: 'media', threadId: 't', media: expect.objectContaining({ kind: 'unsupported', reason: expect.any(String) }) }])
  })
  it('retains structured-only MCP result JSON', () => {
    const updates = new CodexEventMapper().handle('item/completed', { threadId: 't', item: { type: 'mcpToolCall', id: 'json', status: 'completed', result: { structuredContent: { count: 3 } } } })
    expect(updates).toEqual([{ type: 'toolResult', threadId: 't', toolUseId: 'json', content: JSON.stringify({ count: 3 }), isError: false }])
  })
})

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
    expect(of('tokens')).toEqual([{ type: 'tokens', threadId: 'th-1', input: 1200, output: 300, cachedInput: 800 }])
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

  it('warns about Codex built-in multi-agent calls and reports one nativeSpawn for the started+completed pair', () => {
    expect(updates.filter((u) => u.type === 'log')).toHaveLength(1)
    expect(updates.filter((u) => u.type === 'nativeSpawn')).toEqual([{ type: 'nativeSpawn', threadId: 'th-1', tool: 'spawnAgent', itemId: 'it-x1' }])
    expect(byId('it-x1')).toMatchObject({ name: 'codex:spawnAgent' })
    expect(updates).toContainEqual({ type: 'toolResult', threadId: 'th-1', toolUseId: 'it-x1', content: "Codex's built-in multi-agent tools are not available in OrgAI.", isError: true })
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
    // The fixture's `move_path: null` is no move: no movePath key.
    expect(fileChanges(m.item('it-f1')!)).toEqual([{ path: '/repo/src/a.ts', kind: 'update' }])
  })

  it('keeps a raw change with no usable path as path "" so every check fails closed (review NL2)', () => {
    const item = (changes: unknown[]) => ({ type: 'fileChange', id: 'f', changes }) as never
    expect(fileChanges(item([{ path: '/r/a.md', kind: 'add' }, { kind: 'update' }, { path: 7, kind: 'delete' }, { path: '' }, null, 'x']))).toEqual([
      { path: '/r/a.md', kind: 'add' },
      { path: '', kind: 'update' },
      { path: '', kind: 'delete' },
      { path: '', kind: 'update' },
      { path: '', kind: 'update' },
      { path: '', kind: 'update' }
    ])
    expect(fileChangeTargets(fileChanges(item([{ path: '/r/a.md' }, {}])))).toEqual(['/r/a.md', ''])
    // A missing or non-array list is still no changes.
    expect(fileChanges({ type: 'fileChange', id: 'f' } as never)).toEqual([])
  })

  it('carries a move destination on each change and lists it as a write target (review H1)', () => {
    const item = (changes: unknown[]) => ({ type: 'fileChange', id: 'f', changes }) as never
    const changes = fileChanges(
      item([
        { path: '/r/a.md', kind: { type: 'update', move_path: '/home/u/.bashrc' }, diff: '' },
        { path: '/r/b.md', kind: { type: 'update', move_path: null }, diff: '' },
        { path: '/r/c.md', kind: { type: 'update', movePath: '/r/.claude/settings.json' }, diff: '' },
        { path: '/r/d.md', kind: { type: 'update', move_path: 7 }, diff: '' },
        { path: '/r/e.md', kind: { type: 'update', move_path: '  ' }, diff: '' },
        { path: '/r/f.md', kind: 'add' }
      ])
    )
    expect(changes).toEqual([
      { path: '/r/a.md', kind: 'update', movePath: '/home/u/.bashrc' },
      { path: '/r/b.md', kind: 'update' },
      { path: '/r/c.md', kind: 'update', movePath: '/r/.claude/settings.json' },
      // Malformed destinations become '' so every check fails closed.
      { path: '/r/d.md', kind: 'update', movePath: '' },
      { path: '/r/e.md', kind: 'update', movePath: '' },
      { path: '/r/f.md', kind: 'add' }
    ])
    expect(fileChangeTargets(changes)).toEqual(['/r/a.md', '/home/u/.bashrc', '/r/b.md', '/r/c.md', '/r/.claude/settings.json', '/r/d.md', '', '/r/e.md', '', '/r/f.md'])
    // The transcript tool input and result show the move.
    const m = new CodexEventMapper()
    const started = m.handle('item/started', { threadId: 't', turnId: 'u', item: { type: 'fileChange', id: 'mv', status: 'inProgress', changes: [{ path: '/r/a.md', kind: { type: 'update', move_path: '/home/u/.bashrc' }, diff: '' }] } })
    expect(JSON.stringify(started)).toContain('"movePath":"/home/u/.bashrc"')
    const done = m.handle('item/completed', { threadId: 't', turnId: 'u', item: { type: 'fileChange', id: 'mv', status: 'completed', changes: [{ path: '/r/a.md', kind: { type: 'update', move_path: '/home/u/.bashrc' }, diff: '' }] } })
    expect(JSON.stringify(done)).toContain('update a.md -> .bashrc')
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

describe('network tool names', () => {
  it('uses the renamed tools and maps the old names to them', () => {
    expect(NETWORK_TOOLS).toEqual({ spawn: 'spawn_report', message: 'message_agent', list: 'list_team' })
    expect(canonicalNetworkTool('spawn_agent')).toBe('spawn_report')
    expect(canonicalNetworkTool('send_message')).toBe('message_agent')
    expect(canonicalNetworkTool('list_agents')).toBe('list_team')
    expect(canonicalNetworkTool('spawn_report')).toBe('spawn_report')
    expect(canonicalNetworkTool('Agent')).toBeNull()
  })
  it('maps both the new and the old names back to the Claude names', () => {
    const m = new CodexEventMapper()
    const use = (tool: string) => m.handle('item/started', { threadId: 't', item: { type: 'dynamicToolCall', id: `i-${tool}`, tool, arguments: { role: 'engineer', brief: 'b', to: 'x', message: 'm' } } })[0] as Extract<CodexUpdate, { type: 'toolUse' }>
    expect(use('spawn_report').name).toBe('Agent')
    expect(use('spawn_agent').name).toBe('Agent')
    expect(use('message_agent').name).toBe('SendMessage')
    expect(use('send_message').name).toBe('SendMessage')
    expect(use('list_team').name).toBe('ListAgents')
    expect(use('list_agents').name).toBe('ListAgents')
  })
})

describe('native multi-agent items', () => {
  it('emits one nativeSpawn per item id, on item/started only', () => {
    const m = new CodexEventMapper()
    const item = { type: 'subAgentActivity', id: 'n1', tool: 'wait' }
    const started = m.handle('item/started', { threadId: 't', item })
    expect(started.map((u) => u.type)).toEqual(['toolUse', 'toolResult', 'nativeSpawn'])
    expect(started[0]).toMatchObject({ name: 'codex:wait' })
    expect(m.handle('item/started', { threadId: 't', item })).toEqual([])
    expect(m.handle('item/completed', { threadId: 't', item }).map((u) => u.type)).toEqual(['log'])
    expect(m.handle('item/started', { threadId: 't', item: { ...item, id: 'n2' } }).filter((u) => u.type === 'nativeSpawn')).toHaveLength(1)
  })
})
