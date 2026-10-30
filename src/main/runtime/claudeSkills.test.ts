import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKILL_MAX_FILE_BYTES } from '@shared/types'
import type { RunSkill } from './types'

const captured: { options?: Record<string, any> } = {}
vi.mock('@anthropic-ai/claude-agent-sdk', async (orig) => {
  const real = await orig<typeof import('@anthropic-ai/claude-agent-sdk')>()
  return {
    ...real,
    query: (args: { options: Record<string, any> }) => {
      captured.options = args.options
      return { [Symbol.asyncIterator]: async function* () {}, interrupt: async () => {} }
    }
  }
})

import { buildSkillPlugin, qualifiedSkillName, skillGate } from './claudeSkills'
import { ClaudeSession, buildAgents, buildEnv } from './claude'
import { fakeCtx, project } from './testHelpers'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orgai-skilltest-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function skillDir(name: string, files: Record<string, string | Buffer> = { 'SKILL.md': `---\nname: ${name}\ndescription: d\n---\nbody` }): { dir: string; skill: RunSkill } {
  const dir = join(tmp(), name)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, ...rel.split('/'))
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content)
  }
  return {
    dir,
    skill: { id: `id-${name}`, name, description: `${name} desc`, dir, files: Object.keys(files).map((path) => ({ path, bytes: 1 })), roleIds: ['r-eng'] }
  }
}

describe('buildSkillPlugin', () => {
  it('lays out plugin.json and skills/<name> with only the listed files', () => {
    const { dir, skill } = skillDir('alpha', { 'SKILL.md': 'x', 'scripts/run.py': 'print(1)' })
    writeFileSync(join(dir, 'unlisted.txt'), 'no')
    const plugin = buildSkillPlugin([skill], 'run-1')
    expect(JSON.parse(readFileSync(join(plugin.path, '.claude-plugin', 'plugin.json'), 'utf8'))).toEqual({
      name: 'orgai',
      version: '1.0.0',
      description: 'Skills granted in this OrgAI run'
    })
    expect(readFileSync(join(plugin.path, 'skills', 'alpha', 'scripts', 'run.py'), 'utf8')).toBe('print(1)')
    expect(existsSync(join(plugin.path, 'skills', 'alpha', 'unlisted.txt'))).toBe(false)
    expect([...plugin.names.keys()]).toEqual(['orgai:alpha'])
    plugin.cleanup()
  })

  it('leaves out a skill with an oversized, escaping or missing file, and keeps the others', () => {
    const warn = vi.fn()
    const big = skillDir('big', { 'SKILL.md': 'x' })
    writeFileSync(join(big.dir, 'huge.bin'), Buffer.alloc(SKILL_MAX_FILE_BYTES + 1))
    big.skill.files.push({ path: 'huge.bin', bytes: 1 })
    const esc = skillDir('esc')
    esc.skill.files.push({ path: '../secret.txt', bytes: 1 })
    const abs = skillDir('abs')
    abs.skill.files.push({ path: '/etc/passwd', bytes: 1 })
    const missing = skillDir('missing')
    missing.skill.files.push({ path: 'nope.md', bytes: 1 })
    const good = skillDir('good')
    const plugin = buildSkillPlugin([big.skill, esc.skill, abs.skill, missing.skill, good.skill], 'run-1', warn)
    expect([...plugin.names.keys()]).toEqual(['orgai:good'])
    expect(readdirSync(join(plugin.path, 'skills'))).toEqual(['good'])
    expect(warn).toHaveBeenCalledTimes(4)
    plugin.cleanup()
  })

  it('skips symlinks', () => {
    const { dir, skill } = skillDir('link')
    const outside = join(tmp(), 'outside.txt')
    writeFileSync(outside, 'secret')
    try {
      symlinkSync(outside, join(dir, 'linked.txt'))
    } catch {
      return // symlinks need privileges on Windows
    }
    skill.files.push({ path: 'linked.txt', bytes: 1 })
    const plugin = buildSkillPlugin([skill], 'run-1')
    expect(plugin.names.size).toBe(0)
    plugin.cleanup()
  })

  it('cleanup removes the directory and is idempotent', () => {
    const plugin = buildSkillPlugin([skillDir('alpha').skill], 'run-1')
    expect(existsSync(plugin.path)).toBe(true)
    plugin.cleanup()
    expect(existsSync(plugin.path)).toBe(false)
    expect(() => plugin.cleanup()).not.toThrow()
  })
})

describe('skillGate', () => {
  const alpha: RunSkill = { id: 's1', name: 'alpha', description: 'a', dir: '/x', files: [], roleIds: ['r-eng'] }
  const beta: RunSkill = { id: 's2', name: 'beta', description: 'b', dir: '/x', files: [], roleIds: ['r-lead'] }
  const names = new Map([[qualifiedSkillName('alpha'), alpha], [qualifiedSkillName('beta'), beta]])

  it('allows a granted orgai: skill, with or without a leading slash', () => {
    expect(skillGate({ skill: 'orgai:alpha' }, 'r-eng', names)).toEqual({ allow: true, skill: alpha })
    expect(skillGate({ skill: '/orgai:alpha', args: 'x' }, 'r-eng', names)).toEqual({ allow: true, skill: alpha })
  })

  it('denies a skill granted to another role and lists the caller own skills', () => {
    const r = skillGate({ skill: 'orgai:beta' }, 'r-eng', names)
    expect(r.allow).toBe(false)
    if (!r.allow) expect(r.reason).toContain('Skill with skill: "orgai:alpha"')
  })

  it('denies bare names, other plugins, repo skills and malformed input', () => {
    for (const input of [{ skill: 'alpha' }, { skill: 'other:alpha' }, { skill: 'repo-skill' }, { skill: 'orgai:zzz' }, {}, null, 'orgai:alpha']) {
      expect(skillGate(input, 'r-eng', names).allow).toBe(false)
    }
  })

  it('says the role has no skills, or that none are granted in the run', () => {
    const none = skillGate({ skill: 'orgai:alpha' }, 'r-rev', names)
    expect(!none.allow && none.reason).toContain('no skills')
    const empty = skillGate({ skill: 'orgai:alpha' }, 'r-eng', new Map())
    expect(!empty.allow && empty.reason).toBe('No skills are granted in this run.')
  })
})

describe('buildAgents and buildEnv with skills', () => {
  it('adds Skill only for granted roles and never sets AgentDefinition.skills', () => {
    const ctx = fakeCtx()
    const skill: RunSkill = { id: 's1', name: 'alpha', description: 'does a', dir: '/x', files: [], roleIds: ['r-eng'] }
    const agents = buildAgents(ctx, [], false, ctx.project, [skill])
    expect(agents.engineer.tools).toContain('Skill')
    expect(agents.reviewer.tools).not.toContain('Skill')
    expect(agents.lead.tools).not.toContain('Skill')
    expect(agents.engineer.skills).toBeUndefined()
  })

  it('disables bundled skills for work runs', () => {
    expect(buildEnv(fakeCtx(), {}).CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe('1')
  })
})

describe('ClaudeSession Skill gate', () => {
  type Hook = (i: unknown) => Promise<any>
  async function session(rules: string[] = []) {
    const { skill } = skillDir('alpha')
    skill.roleIds = ['r-lead']
    const ctx = fakeCtx({ skills: () => [skill], allowedRules: () => rules, project: project({ path: tmp() }) })
    await new ClaudeSession(ctx).finished
    const hook = captured.options!.hooks.PreToolUse[0].hooks[0] as Hook
    return { ctx, hook }
  }
  const call = (tool_input: unknown, extra: Record<string, unknown> = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input, tool_use_id: 't1', cwd: '/', ...extra })

  it('loads the plugin, sets skills and denies even when a saved rule allows Skill', async () => {
    const { ctx, hook } = await session(['Skill'])
    expect(captured.options!.plugins[0]).toMatchObject({ type: 'local', skipMcpDiscovery: true })
    expect(captured.options!.skills).toEqual(['orgai:alpha'])
    expect(captured.options!.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe('1')
    for (const name of ['repo-skill', 'alpha', 'orgai:beta']) {
      const out = await hook(call({ skill: name }))
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    }
    expect(ctx.events.some((e) => e.type === 'skill.used')).toBe(false)
  })

  it('emits skill.used for the root granted skill and lets the call proceed', async () => {
    const { ctx, hook } = await session()
    const out = await hook(call({ skill: 'orgai:alpha' }))
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe('deny')
    expect(ctx.events.find((e) => e.type === 'skill.used')).toMatchObject({ type: 'skill.used', runId: 'run-1', skillId: 'id-alpha', name: 'alpha' })
  })

  it('denies a subagent of a role without the grant', async () => {
    const { hook } = await session()
    const out = await hook(call({ skill: 'orgai:alpha' }, { agent_id: 'a1', agent_type: 'reviewer' }))
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  it('denies every Skill call when the run has no skills', async () => {
    const ctx = fakeCtx({ project: project({ path: tmp() }) })
    await new ClaudeSession(ctx).finished
    const hook = captured.options!.hooks.PreToolUse[0].hooks[0] as Hook
    const out = await hook(call({ skill: 'orgai:alpha' }))
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe('No skills are granted in this run.')
    expect(captured.options!.plugins).toBeUndefined()
  })
})
