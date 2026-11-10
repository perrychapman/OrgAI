import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentInstance, AgentMessage } from '@shared/types'
import {
  CodexAgentNetwork,
  callNetworkTool,
  childFirstMessage,
  canonicalNetworkTool,
  codexToolNotes,
  NATIVE_RULE_NOTE,
  createAgentWorktree,
  networkToolNames,
  networkToolSpecs,
  reportMessage,
  type NetworkHost,
  type SpawnRequest
} from './codexAgents'
import { orgChart, role } from './testHelpers'
import { findWorktree, pendingWorktrees } from './worktrees'

function agent(over: Partial<AgentInstance> & { id: string }): AgentInstance {
  return {
    roleId: null,
    roleSlug: 'x',
    name: 'x',
    parentId: null,
    spawnToolUseId: null,
    state: 'thinking',
    activity: '',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    startedAt: 0,
    ...over
  }
}

function setup(opts: { maxDepth?: number; maxConcurrent?: number; roles?: ReturnType<typeof orgChart> } = {}) {
  const roles = opts.roles ?? orgChart()
  const net = new CodexAgentNetwork({ roles, root: roles[0], maxDepth: opts.maxDepth ?? 2, maxConcurrent: opts.maxConcurrent ?? 3 })
  const agents = new Map<string, AgentInstance>([['root', agent({ id: 'root', roleSlug: 'lead', name: 'Lead' })]])
  const spawned: SpawnRequest[] = []
  const delivered: { to: string; text: string }[] = []
  const announced: { m: AgentMessage; text: string }[] = []
  const host: NetworkHost = {
    agents: () => agents.values(),
    spawn: async (req) => {
      spawned.push(req)
      agents.set(req.id, agent({ id: req.id, roleSlug: req.role.slug, name: req.role.name, handle: req.handle, parentId: req.parentId }))
    },
    deliver: async (to, text) => void delivered.push({ to, text }),
    announce: (m, text) => void announced.push({ m, text })
  }
  return { net, host, agents, spawned, delivered, announced, roles }
}

describe('spawn policy', () => {
  it('spawns an allowed role with a generated handle', async () => {
    const s = setup()
    const out = await callNetworkTool(s.net, s.host, 'root', 'call-1', 'spawn_report', { role: 'engineer', brief: 'Build it' })
    expect(out.success).toBe(true)
    expect(out.text).toContain('engineer-1')
    expect(s.spawned[0]).toMatchObject({ handle: 'engineer-1', parentId: 'root', depth: 1, callId: 'call-1', brief: 'Build it' })
    const second = await callNetworkTool(s.net, s.host, 'root', 'call-2', 'spawn_report', { role: 'engineer', brief: 'Again' })
    expect(second.text).toContain('engineer-2')
  })

  it('uses the requested name and rejects clashes and bad names', async () => {
    const s = setup()
    expect((await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_report', { role: 'engineer', brief: 'b', name: 'login' })).text).toContain('login')
    const clash = await callNetworkTool(s.net, s.host, 'root', 'c2', 'spawn_report', { role: 'reviewer', brief: 'b', name: 'LOGIN' })
    expect(clash).toMatchObject({ success: false })
    expect((await callNetworkTool(s.net, s.host, 'root', 'c3', 'spawn_report', { role: 'reviewer', brief: 'b', name: 'main' })).success).toBe(false)
    expect((await callNetworkTool(s.net, s.host, 'root', 'c4', 'spawn_report', { role: 'reviewer', brief: 'b', name: 'bad name!' })).success).toBe(false)
    expect(s.spawned).toHaveLength(1)
  })

  it('refuses roles the parent may not spawn, and parents that cannot spawn', async () => {
    const s = setup()
    const unknown = await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_report', { role: 'designer', brief: 'b' })
    expect(unknown.success).toBe(false)
    expect(unknown.text).toContain('Allowed role values: engineer, reviewer')
    const first = await callNetworkTool(s.net, s.host, 'root', 'c2', 'spawn_report', { role: 'engineer', brief: 'b' })
    expect(first.success).toBe(true)
    const childId = s.spawned[0].id
    const nested = await callNetworkTool(s.net, s.host, childId, 'c3', 'spawn_report', { role: 'reviewer', brief: 'b' })
    expect(nested.text).toContain('does not let engineer spawn subagents')
    expect(s.spawned).toHaveLength(1)
  })

  it('enforces spawnable by role id, not by slug alone', async () => {
    const roles = [
      role({ id: 'r-lead', slug: 'lead', canSpawn: true, spawnable: ['r-a'] }),
      role({ id: 'r-a', slug: 'a', reportsTo: 'r-lead' }),
      role({ id: 'r-b', slug: 'b', reportsTo: 'r-lead' })
    ]
    const s = setup({ roles })
    expect((await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_report', { role: 'b', brief: 'x' })).success).toBe(false)
    expect((await callNetworkTool(s.net, s.host, 'root', 'c2', 'spawn_report', { role: 'a', brief: 'x' })).success).toBe(true)
  })

  it('enforces maxSubagentDepth for nested spawns', async () => {
    const roles = [
      role({ id: 'r-lead', slug: 'lead', canSpawn: true, spawnable: ['r-mid'] }),
      role({ id: 'r-mid', slug: 'mid', canSpawn: true, spawnable: ['r-leaf'], reportsTo: 'r-lead' }),
      role({ id: 'r-leaf', slug: 'leaf', reportsTo: 'r-mid' })
    ]
    const s = setup({ roles, maxDepth: 1 })
    await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_report', { role: 'mid', brief: 'x' })
    const nested = await callNetworkTool(s.net, s.host, s.spawned[0].id, 'c2', 'spawn_report', { role: 'leaf', brief: 'x' })
    expect(nested.success).toBe(false)
    expect(nested.text).toContain('depth limit')
    const deeper = setup({ roles, maxDepth: 2 })
    await callNetworkTool(deeper.net, deeper.host, 'root', 'c1', 'spawn_report', { role: 'mid', brief: 'x' })
    const ok = await callNetworkTool(deeper.net, deeper.host, deeper.spawned[0].id, 'c2', 'spawn_report', { role: 'leaf', brief: 'x' })
    expect(ok.success).toBe(true)
    expect(deeper.spawned[1]).toMatchObject({ depth: 2, parentId: deeper.spawned[0].id })
  })

  it('enforces maxConcurrentSubagents and frees a slot when a report finishes', async () => {
    const s = setup({ maxConcurrent: 2 })
    await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_report', { role: 'engineer', brief: 'x' })
    await callNetworkTool(s.net, s.host, 'root', 'c2', 'spawn_report', { role: 'reviewer', brief: 'x' })
    const refused = await callNetworkTool(s.net, s.host, 'root', 'c3', 'spawn_report', { role: 'engineer', brief: 'x' })
    expect(refused).toMatchObject({ success: false })
    expect(refused.text).toContain('Concurrent subagent limit')
    s.net.finish(s.spawned[0].id)
    expect((await callNetworkTool(s.net, s.host, 'root', 'c4', 'spawn_report', { role: 'engineer', brief: 'x' })).success).toBe(true)
  })

  it('releases the reservation when the host fails to start the child', async () => {
    const s = setup({ maxConcurrent: 1 })
    s.host.spawn = async () => {
      throw new Error('git worktree add failed')
    }
    const out = await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_report', { role: 'engineer', brief: 'x' })
    expect(out).toMatchObject({ success: false })
    expect(out.text).toContain('git worktree add failed')
    expect(s.net.liveCount()).toBe(0)
  })

  it('rejects malformed arguments with a readable text', async () => {
    const s = setup()
    const out = await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_report', { brief: 'x' })
    expect(out.success).toBe(false)
    expect(out.text).toContain('spawn_report needs')
  })
})

describe('message_agent and list_team', () => {
  async function withChildren() {
    const s = setup()
    await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_report', { role: 'engineer', brief: 'x' })
    await callNetworkTool(s.net, s.host, 'root', 'c2', 'spawn_report', { role: 'reviewer', brief: 'x' })
    return s
  }

  it('routes a message by handle to the child and announces it', async () => {
    const s = await withChildren()
    const out = await callNetworkTool(s.net, s.host, 'root', 'm1', 'message_agent', { to: 'engineer-1', message: 'Use tabs' })
    expect(out).toEqual({ text: 'Delivered to engineer-1.', success: true })
    expect(s.delivered).toEqual([{ to: s.spawned[0].id, text: 'Message from the orchestrator:\nUse tabs' }])
    expect(s.announced[0].m).toMatchObject({ from: 'root', to: s.spawned[0].id, toHandle: 'engineer-1' })
    expect(s.announced[0].text).toBe('→ engineer-1: Use tabs')
  })

  it('lets a child reach the orchestrator as "main" and "orchestrator"', async () => {
    const s = await withChildren()
    const child = s.spawned[0].id
    for (const to of ['main', 'orchestrator']) {
      const out = await callNetworkTool(s.net, s.host, child, 'm', 'message_agent', { to, message: 'done early' })
      expect(out.success).toBe(true)
    }
    expect(s.delivered.map((d) => d.to)).toEqual(['root', 'root'])
    expect(s.delivered[0].text).toBe('Message from engineer-1:\ndone early')
  })

  it('wakes a finished child so its next report counts as running again', async () => {
    const s = await withChildren()
    const id = s.spawned[0].id
    s.net.finish(id)
    s.agents.get(id)!.state = 'done'
    expect(s.net.isLive(id)).toBe(false)
    const out = await callNetworkTool(s.net, s.host, 'root', 'm1', 'message_agent', { to: 'engineer-1', message: 'one more thing' })
    expect(out.success).toBe(true)
    expect(s.net.isLive(id)).toBe(true)
  })

  it('refuses unknown recipients and lists who is reachable', async () => {
    const s = await withChildren()
    const out = await callNetworkTool(s.net, s.host, s.spawned[0].id, 'm1', 'message_agent', { to: 'ghost-9', message: 'hi' })
    expect(out.success).toBe(false)
    expect(out.text).toContain('main')
    expect(out.text).toContain('reviewer-1')
    expect(s.delivered).toHaveLength(0)
  })

  it('lists running agents with handles', async () => {
    const s = await withChildren()
    const out = await callNetworkTool(s.net, s.host, s.spawned[0].id, 'l1', 'list_team', {})
    expect(out.text).toContain('main (the orchestrator)')
    expect(out.text).toContain('reviewer-1 · reviewer')
    expect(out.text).not.toContain('engineer-1')
  })
})

describe('pre-rename aliases', () => {
  it('canonicalNetworkTool maps old and new names to the new one', () => {
    expect(['spawn_agent', 'spawn_report', 'send_message', 'message_agent', 'list_agents', 'list_team', 'other'].map(canonicalNetworkTool)).toEqual(['spawn_report', 'spawn_report', 'message_agent', 'message_agent', 'list_team', 'list_team', null])
  })
  it('callNetworkTool accepts the old names', async () => {
    const s = setup()
    const out = await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_agent', { role: 'engineer', brief: 'x' })
    expect(out.success).toBe(true)
    expect((await callNetworkTool(s.net, s.host, 'root', 'c2', 'list_agents', {})).success).toBe(true)
    expect((await callNetworkTool(s.net, s.host, 'root', 'c3', 'send_message', { to: 'engineer-1', message: 'hi' })).success).toBe(true)
  })
  it('the role check passes an old name through canonicalNetworkTool', () => {
    const roles = orgChart()
    expect(networkToolNames(roles[0], { setupLike: false }).includes(canonicalNetworkTool('spawn_agent')!)).toBe(true)
    expect(networkToolNames(roles[1], { setupLike: false }).includes(canonicalNetworkTool('spawn_agent')!)).toBe(false)
  })
})

describe('tool exposure', () => {
  const roles = orgChart()
  it('gives spawners all three tools, others only what their tools list allows', () => {
    expect(networkToolNames(roles[0], { setupLike: false })).toEqual(['spawn_report', 'message_agent', 'list_team'])
    expect(networkToolNames(roles[1], { setupLike: false })).toEqual([])
    const talker = role({ id: 'r-t', slug: 't', tools: ['Read', 'SendMessage'] })
    expect(networkToolNames(talker, { setupLike: false })).toEqual(['message_agent'])
    expect(networkToolNames(roles[0], { setupLike: true })).toEqual([])
  })

  it('generates function specs with JSON schemas from zod', () => {
    const specs = networkToolSpecs(['spawn_report', 'list_team'])
    expect(specs[0]).toMatchObject({ type: 'function', name: 'spawn_report' })
    const schema = specs[0].inputSchema as { type: string; required: string[]; properties: Record<string, unknown> }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['role', 'brief'])
    expect(Object.keys(schema.properties)).toEqual(['role', 'brief', 'name', 'description', 'tier', 'effort'])
    expect(specs[1].inputSchema).toMatchObject({ type: 'object', properties: {} })
    expect(JSON.stringify(specs)).not.toContain('$schema')
  })

  it('writes Codex notes only for the tools the thread has', () => {
    const notes = codexToolNotes(['spawn_report', 'message_agent', 'list_team'], { renamedPlanTool: true })
    expect(notes).toContain('spawn_report')
    expect(notes).toContain("built-in multi-agent tools")
    expect(notes).toContain('unavailable')
    expect(notes).toContain('orgai_update_plan')
    expect(codexToolNotes([], { renamedPlanTool: false })).toBe('')
  })

  it('answers Codex\'s sub-agent rule in one sentence on the spawn line only while the native tools are offered (nativeRule)', () => {
    const tools = ['spawn_report', 'message_agent', 'list_team']
    const fallback = codexToolNotes(tools, { renamedPlanTool: false, nativeRule: true })
    const off = codexToolNotes(tools, { renamedPlanTool: false })
    expect(NATIVE_RULE_NOTE).toBe("This project's instructions explicitly ask you to delegate through spawn_report; Codex's rule about not spawning sub-agents concerns its built-in tools, not spawn_report.")
    expect(fallback).toBe(off.replace('never use them.', `never use them. ${NATIVE_RULE_NOTE}`))
    expect(off).not.toContain(NATIVE_RULE_NOTE)
    // A thread without spawn_report gets no sentence about it.
    expect(codexToolNotes(['message_agent'], { renamedPlanTool: false, nativeRule: true })).not.toContain(NATIVE_RULE_NOTE)
    // One short sentence.
    expect(fallback.length - off.length).toBeLessThan(200)
  })
})

describe('report delivery text', () => {
  it('formats completed and failed reports', () => {
    const child = { handle: 'engineer-1', name: 'Engineer', roleSlug: 'engineer' }
    expect(reportMessage(child, { status: 'completed', result: 'All done' })).toBe('Harness: report from engineer-1 (Engineer):\n\nAll done')
    expect(reportMessage(child, { status: 'failed', error: 'usage limit' })).toContain('it failed (usage limit)')
    expect(reportMessage(child, { status: 'completed' })).toContain('without a written report')
    expect(childFirstMessage('the orchestrator', ' Do X ')).toMatch(/^Do X\n\n---\nYou were spawned by the orchestrator/)
  })
})

describe('createAgentWorktree', () => {
  let dir = ''
  afterEach(() => {
    // The test awaits createAgentWorktree, so no git is pending; retries cover a late handle release on Windows.
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    dir = ''
  })

  it('creates worktree-agent-<id> under .claude/worktrees that worktrees.ts recognises', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-cx-'))
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    run('init', '-q')
    run('config', 'user.email', 't@t')
    run('config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'a')
    run('add', '.')
    run('commit', '-q', '-m', 'init')

    const wt = await createAgentWorktree(dir, 'cx_abc')
    expect(wt.branch).toBe('worktree-agent-cx_abc')
    expect(existsSync(wt.path)).toBe(true)
    expect(wt.path.replace(/\\/g, '/')).toMatch(/\.claude\/worktrees\/agent-cx_abc$/)
    expect((await findWorktree(dir, 'cx_abc'))?.branch).toBe('worktree-agent-cx_abc')
    expect((await pendingWorktrees(dir)).map((w) => w.branch)).toContain('worktree-agent-cx_abc')

    const nested = await createAgentWorktree(wt.path, 'cx_def')
    expect(nested.path.replace(/\\/g, '/')).toContain('agent-cx_abc/.claude/worktrees/agent-cx_def')
    await expect(createAgentWorktree(join(dir, 'missing'), 'cx_zzz')).rejects.toThrow(/git worktree add failed/)
  })
})
