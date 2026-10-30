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
  codexToolNotes,
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
    const out = await callNetworkTool(s.net, s.host, 'root', 'call-1', 'spawn_agent', { role: 'engineer', brief: 'Build it' })
    expect(out.success).toBe(true)
    expect(out.text).toContain('engineer-1')
    expect(s.spawned[0]).toMatchObject({ handle: 'engineer-1', parentId: 'root', depth: 1, callId: 'call-1', brief: 'Build it' })
    const second = await callNetworkTool(s.net, s.host, 'root', 'call-2', 'spawn_agent', { role: 'engineer', brief: 'Again' })
    expect(second.text).toContain('engineer-2')
  })

  it('uses the requested name and rejects clashes and bad names', async () => {
    const s = setup()
    expect((await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_agent', { role: 'engineer', brief: 'b', name: 'login' })).text).toContain('login')
    const clash = await callNetworkTool(s.net, s.host, 'root', 'c2', 'spawn_agent', { role: 'reviewer', brief: 'b', name: 'LOGIN' })
    expect(clash).toMatchObject({ success: false })
    expect((await callNetworkTool(s.net, s.host, 'root', 'c3', 'spawn_agent', { role: 'reviewer', brief: 'b', name: 'main' })).success).toBe(false)
    expect((await callNetworkTool(s.net, s.host, 'root', 'c4', 'spawn_agent', { role: 'reviewer', brief: 'b', name: 'bad name!' })).success).toBe(false)
    expect(s.spawned).toHaveLength(1)
  })

  it('refuses roles the parent may not spawn, and parents that cannot spawn', async () => {
    const s = setup()
    const unknown = await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_agent', { role: 'designer', brief: 'b' })
    expect(unknown.success).toBe(false)
    expect(unknown.text).toContain('Allowed role values: engineer, reviewer')
    const first = await callNetworkTool(s.net, s.host, 'root', 'c2', 'spawn_agent', { role: 'engineer', brief: 'b' })
    expect(first.success).toBe(true)
    const childId = s.spawned[0].id
    const nested = await callNetworkTool(s.net, s.host, childId, 'c3', 'spawn_agent', { role: 'reviewer', brief: 'b' })
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
    expect((await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_agent', { role: 'b', brief: 'x' })).success).toBe(false)
    expect((await callNetworkTool(s.net, s.host, 'root', 'c2', 'spawn_agent', { role: 'a', brief: 'x' })).success).toBe(true)
  })

  it('enforces maxSubagentDepth for nested spawns', async () => {
    const roles = [
      role({ id: 'r-lead', slug: 'lead', canSpawn: true, spawnable: ['r-mid'] }),
      role({ id: 'r-mid', slug: 'mid', canSpawn: true, spawnable: ['r-leaf'], reportsTo: 'r-lead' }),
      role({ id: 'r-leaf', slug: 'leaf', reportsTo: 'r-mid' })
    ]
    const s = setup({ roles, maxDepth: 1 })
    await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_agent', { role: 'mid', brief: 'x' })
    const nested = await callNetworkTool(s.net, s.host, s.spawned[0].id, 'c2', 'spawn_agent', { role: 'leaf', brief: 'x' })
    expect(nested.success).toBe(false)
    expect(nested.text).toContain('depth limit')
    const deeper = setup({ roles, maxDepth: 2 })
    await callNetworkTool(deeper.net, deeper.host, 'root', 'c1', 'spawn_agent', { role: 'mid', brief: 'x' })
    const ok = await callNetworkTool(deeper.net, deeper.host, deeper.spawned[0].id, 'c2', 'spawn_agent', { role: 'leaf', brief: 'x' })
    expect(ok.success).toBe(true)
    expect(deeper.spawned[1]).toMatchObject({ depth: 2, parentId: deeper.spawned[0].id })
  })

  it('enforces maxConcurrentSubagents and frees a slot when a report finishes', async () => {
    const s = setup({ maxConcurrent: 2 })
    await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_agent', { role: 'engineer', brief: 'x' })
    await callNetworkTool(s.net, s.host, 'root', 'c2', 'spawn_agent', { role: 'reviewer', brief: 'x' })
    const refused = await callNetworkTool(s.net, s.host, 'root', 'c3', 'spawn_agent', { role: 'engineer', brief: 'x' })
    expect(refused).toMatchObject({ success: false })
    expect(refused.text).toContain('Concurrent subagent limit')
    s.net.finish(s.spawned[0].id)
    expect((await callNetworkTool(s.net, s.host, 'root', 'c4', 'spawn_agent', { role: 'engineer', brief: 'x' })).success).toBe(true)
  })

  it('releases the reservation when the host fails to start the child', async () => {
    const s = setup({ maxConcurrent: 1 })
    s.host.spawn = async () => {
      throw new Error('git worktree add failed')
    }
    const out = await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_agent', { role: 'engineer', brief: 'x' })
    expect(out).toMatchObject({ success: false })
    expect(out.text).toContain('git worktree add failed')
    expect(s.net.liveCount()).toBe(0)
  })

  it('rejects malformed arguments with a readable text', async () => {
    const s = setup()
    const out = await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_agent', { brief: 'x' })
    expect(out.success).toBe(false)
    expect(out.text).toContain('spawn_agent needs')
  })
})

describe('send_message and list_agents', () => {
  async function withChildren() {
    const s = setup()
    await callNetworkTool(s.net, s.host, 'root', 'c1', 'spawn_agent', { role: 'engineer', brief: 'x' })
    await callNetworkTool(s.net, s.host, 'root', 'c2', 'spawn_agent', { role: 'reviewer', brief: 'x' })
    return s
  }

  it('routes a message by handle to the child and announces it', async () => {
    const s = await withChildren()
    const out = await callNetworkTool(s.net, s.host, 'root', 'm1', 'send_message', { to: 'engineer-1', message: 'Use tabs' })
    expect(out).toEqual({ text: 'Delivered to engineer-1.', success: true })
    expect(s.delivered).toEqual([{ to: s.spawned[0].id, text: 'Message from the orchestrator:\nUse tabs' }])
    expect(s.announced[0].m).toMatchObject({ from: 'root', to: s.spawned[0].id, toHandle: 'engineer-1' })
    expect(s.announced[0].text).toBe('→ engineer-1: Use tabs')
  })

  it('lets a child reach the orchestrator as "main" and "orchestrator"', async () => {
    const s = await withChildren()
    const child = s.spawned[0].id
    for (const to of ['main', 'orchestrator']) {
      const out = await callNetworkTool(s.net, s.host, child, 'm', 'send_message', { to, message: 'done early' })
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
    const out = await callNetworkTool(s.net, s.host, 'root', 'm1', 'send_message', { to: 'engineer-1', message: 'one more thing' })
    expect(out.success).toBe(true)
    expect(s.net.isLive(id)).toBe(true)
  })

  it('refuses unknown recipients and lists who is reachable', async () => {
    const s = await withChildren()
    const out = await callNetworkTool(s.net, s.host, s.spawned[0].id, 'm1', 'send_message', { to: 'ghost-9', message: 'hi' })
    expect(out.success).toBe(false)
    expect(out.text).toContain('main')
    expect(out.text).toContain('reviewer-1')
    expect(s.delivered).toHaveLength(0)
  })

  it('lists running agents with handles', async () => {
    const s = await withChildren()
    const out = await callNetworkTool(s.net, s.host, s.spawned[0].id, 'l1', 'list_agents', {})
    expect(out.text).toContain('main (the orchestrator)')
    expect(out.text).toContain('reviewer-1 · reviewer')
    expect(out.text).not.toContain('engineer-1')
  })
})

describe('tool exposure', () => {
  const roles = orgChart()
  it('gives spawners all three tools, others only what their tools list allows', () => {
    expect(networkToolNames(roles[0], { setupLike: false })).toEqual(['spawn_agent', 'send_message', 'list_agents'])
    expect(networkToolNames(roles[1], { setupLike: false })).toEqual([])
    const talker = role({ id: 'r-t', slug: 't', tools: ['Read', 'SendMessage'] })
    expect(networkToolNames(talker, { setupLike: false })).toEqual(['send_message'])
    expect(networkToolNames(roles[0], { setupLike: true })).toEqual([])
  })

  it('generates function specs with JSON schemas from zod', () => {
    const specs = networkToolSpecs(['spawn_agent', 'list_agents'])
    expect(specs[0]).toMatchObject({ type: 'function', name: 'spawn_agent' })
    const schema = specs[0].inputSchema as { type: string; required: string[]; properties: Record<string, unknown> }
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['role', 'brief'])
    expect(Object.keys(schema.properties)).toEqual(['role', 'brief', 'name', 'description'])
    expect(specs[1].inputSchema).toMatchObject({ type: 'object', properties: {} })
    expect(JSON.stringify(specs)).not.toContain('$schema')
  })

  it('writes Codex notes only for the tools the thread has', () => {
    const notes = codexToolNotes(['spawn_agent', 'send_message', 'list_agents'], { renamedPlanTool: true })
    expect(notes).toContain('spawn_agent')
    expect(notes).toContain('orgai_update_plan')
    expect(codexToolNotes([], { renamedPlanTool: false })).toBe('')
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
    if (dir) rmSync(dir, { recursive: true, force: true })
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

  it('refuses to create a worktree when local executable filters are configured', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-cx-filter-'))
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    run('init', '-q')
    run('config', 'user.email', 't@t')
    run('config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, '.gitattributes'), '*.txt filter=untrusted\n')
    run('add', '.')
    run('commit', '-q', '-m', 'init')
    run('config', 'filter.untrusted.smudge', 'false')

    await expect(createAgentWorktree(dir, 'cx_filter')).rejects.toThrow(/filter\.untrusted\.smudge/)
    expect(existsSync(join(dir, '.claude', 'worktrees', 'agent-cx_filter'))).toBe(false)
  })

  it('rejects an effective global driver only when repository attributes select it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-cx-global-filter-'))
    const globalConfig = join(dir, 'global.gitconfig')
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    run('init', '-q')
    run('config', 'user.email', 't@t')
    run('config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, '.gitattributes'), '*.txt filter=global-danger\n')
    run('add', '.')
    run('commit', '-q', '-m', 'init')
    execFileSync('git', ['config', '--file', globalConfig, 'filter.global-danger.smudge', 'false'])
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    try {
      await expect(createAgentWorktree(dir, 'cx_global_filter')).rejects.toThrow(/filter\.global-danger\.smudge/)
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous
    }
    expect(existsSync(join(dir, '.claude', 'worktrees', 'agent-cx_global_filter'))).toBe(false)
  })

  it('allows an effective global driver that no repository attribute selects', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-cx-unused-filter-'))
    const globalConfig = join(dir, 'global.gitconfig')
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    run('init', '-q')
    run('config', 'user.email', 't@t')
    run('config', 'user.name', 't')
    writeFileSync(join(dir, 'a.txt'), 'a')
    run('add', '.')
    run('commit', '-q', '-m', 'init')
    execFileSync('git', ['config', '--file', globalConfig, 'filter.unused.smudge', 'false'])
    const previous = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    try {
      const wt = await createAgentWorktree(dir, 'cx_unused_filter')
      expect(existsSync(wt.path)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = previous
    }
  })

  it('checks committed HEAD attributes even when the working tree removes them', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-cx-head-filter-'))
    const marker = join(dir, 'head-filter-ran.marker').replace(/\\/g, '/')
    const script = join(dir, 'head-filter-marker.sh')
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    run('init', '-q')
    run('config', 'user.email', 't@t')
    run('config', 'user.name', 't')
    writeFileSync(join(dir, '.gitattributes'), 'payload.txt filter=head-marker\n')
    writeFileSync(join(dir, 'payload.txt'), 'payload\n')
    run('add', '.gitattributes', 'payload.txt')
    run('commit', '-q', '-m', 'malicious committed attributes')
    writeFileSync(join(dir, 'head-filter-marker.sh'), `#!/bin/sh\nprintf hit > "${marker}"\ncat\n`)
    run('config', 'filter.head-marker.smudge', `sh "${script.replace(/\\/g, '/')}"`)
    // The mutable working tree is benign, but the worktree command checks out committed HEAD.
    writeFileSync(join(dir, '.gitattributes'), '')

    await expect(createAgentWorktree(dir, 'cx_head_filter')).rejects.toThrow(/filter\.head-marker\.smudge/)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(dir, '.claude', 'worktrees', 'agent-cx_head_filter'))).toBe(false)
  })
})
