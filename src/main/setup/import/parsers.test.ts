import { describe, expect, it } from 'vitest'
import {
  parseClaudeAgent,
  parseCodexAgent,
  parseCopilotAgent,
  parseGeminiAgent,
  parseKiroAgent,
  parseOpencodeAgentMd,
  parseOpencodeConfig,
  parseOrgExport,
  parseRooModes
} from './parsers'

describe('parseClaudeAgent', () => {
  it('parses list tools, [1m] model and notes ignored fields', () => {
    const r = parseClaudeAgent(
      '---\nname: code-reviewer\ndescription: Reviews code\ntools:\n  - Read\n  - Grep\ndisallowedTools: Bash, Write\nmodel: opus[1m]\ncolor: red\neffort: high\npermissionMode: plan\nskills: [a]\n---\nYou review code.',
      '.claude/agents/code-reviewer.md'
    )
    expect(r.warnings).toEqual([])
    const a = r.agents[0]
    expect(a).toMatchObject({ source: 'claude', name: 'code-reviewer', description: 'Reviews code', tools: ['Read', 'Grep'], deniedTools: ['Bash', 'Write'], model: 'opus[1m]', color: 'red', effort: 'high', prompt: 'You review code.' })
    expect(a.notes).toEqual(['Ignored "permissionMode" (not imported)', 'Ignored "skills" (not imported)'])
  })
  it('accepts comma tools and rejects bad effort', () => {
    const a = parseClaudeAgent('---\nname: x\ntools: Read, Bash(git:*)\neffort: wild\nmodel: inherit\n---\nP', 'f.md').agents[0]
    expect(a.tools).toEqual(['Read', 'Bash(git:*)'])
    expect(a.effort).toBeUndefined()
    expect(a.model).toBe('inherit')
  })
  it('warns on a missing name or bad frontmatter', () => {
    const r = parseClaudeAgent('---\ndescription: d\n---\nbody', 'a.md')
    expect(r.agents).toEqual([])
    expect(r.warnings[0]).toMatch(/^a\.md: no name/)
    expect(parseClaudeAgent('no frontmatter at all', 'b.md').agents).toEqual([])
    expect(parseClaudeAgent('---\nname: x\nunclosed', 'c.md').warnings.length).toBeGreaterThan(0)
  })
  it('caps name, description and prompt', () => {
    const a = parseClaudeAgent(`---\nname: ${'n'.repeat(200)}\ndescription: ${'d'.repeat(900)}\n---\n${'p'.repeat(30000)}`, 'f.md').agents[0]
    expect(a.name).toHaveLength(80)
    expect(a.description).toHaveLength(500)
    expect(a.prompt).toHaveLength(20000)
    expect(a.notes).toContain('Prompt cut to 20,000 characters')
  })
})

describe('opencode', () => {
  it('parses an agent markdown with tools and permission maps', () => {
    const r = parseOpencodeAgentMd(
      '---\ndescription: Builds\nmode: primary\nmodel: anthropic/claude-sonnet-4-5\ntools:\n  write: false\n  edit: false\n  bash: true\npermission:\n  webfetch: deny\n  bash:\n    "*": deny\n    "git status": allow\n  read: allow\n---\nBuild things.',
      '.opencode/agent/build.md'
    )
    const a = r.agents[0]
    expect(a).toMatchObject({ source: 'opencode', name: 'build', primary: true, model: 'anthropic/claude-sonnet-4-5', prompt: 'Build things.' })
    expect(a.tools).toBeUndefined()
    expect(a.deniedTools).toEqual(['write', 'edit', 'webfetch', 'bash'])
  })
  it('treats subagent mode as non-primary and skips disabled', () => {
    expect(parseOpencodeAgentMd('---\nmode: subagent\n---\nx', '.opencode/agents/s.md').agents[0].primary).toBeUndefined()
    const r = parseOpencodeAgentMd('---\ndisable: true\n---\nx', '.opencode/agents/d.md')
    expect(r.agents).toEqual([])
    expect(r.warnings[0]).toMatch(/disabled/)
  })
  it('parses opencode.jsonc with comments, trailing commas and {file:}', () => {
    const files: Record<string, string> = { './prompts/x.md': 'Prompt from file' }
    const seen: string[] = []
    const r = parseOpencodeConfig(
      '{\n // c\n "$schema": "https://opencode.ai/config.json",\n "agent": {\n  "review": { "description": "R", "mode": "subagent", "prompt": "{file:./prompts/x.md}", "tools": { "write": false, }, },\n  "gone": { "prompt": "{file:./missing.md}" },\n  "off": { "disable": true },\n  "inline": { "prompt": "Inline", "mode": "all" }\n }\n}',
      'opencode.jsonc',
      (p) => {
        seen.push(p)
        return files[p] ?? null
      }
    )
    expect(seen).toEqual(['./prompts/x.md', './missing.md'])
    expect(r.agents.map((a) => a.name)).toEqual(['review', 'gone', 'inline'])
    expect(r.agents[0]).toMatchObject({ prompt: 'Prompt from file', deniedTools: ['write'], description: 'R' })
    expect(r.agents[1].prompt).toBe('')
    expect(r.agents[2].primary).toBe(true)
    expect(r.warnings.some((w) => /missing\.md/.test(w))).toBe(true)
  })
  it('warns on bad JSON', () => {
    const r = parseOpencodeConfig('{ nope', 'opencode.json', () => null)
    expect(r.agents).toEqual([])
    expect(r.warnings[0]).toMatch(/^opencode\.json: invalid JSON/)
  })
})

describe('parseCodexAgent', () => {
  it('parses multi-line developer_instructions, effort and shell_tool=false', () => {
    const r = parseCodexAgent(
      'name = "reviewer"\ndescription = "Reviews"\nmodel = "gpt-5-mini"\nmodel_reasoning_effort = "minimal"\ndeveloper_instructions = """\nBe careful.\nSecond line.\n"""\n\n[features]\nshell_tool = false\n',
      '.codex/agents/reviewer.toml'
    )
    expect(r.warnings).toEqual([])
    expect(r.agents[0]).toMatchObject({ name: 'reviewer', model: 'gpt-5-mini', effort: 'low', prompt: 'Be careful.\nSecond line.', deniedTools: ['bash'] })
    expect(r.agents[0].tools).toBeUndefined()
  })
  it('falls back to the file name, ignores unknown effort, warns on bad TOML', () => {
    const a = parseCodexAgent('model_reasoning_effort = "turbo"\ndeveloper_instructions = "x"', '.codex/agents/helper.toml').agents[0]
    expect(a.name).toBe('helper')
    expect(a.effort).toBeUndefined()
    expect(a.notes[0]).toMatch(/turbo/)
    const bad = parseCodexAgent('this is = = bad', '.codex/agents/bad.toml')
    expect(bad.agents).toEqual([])
    expect(bad.warnings[0]).toMatch(/^\.codex\/agents\/bad\.toml: /)
  })
})

describe('copilot, gemini, kiro', () => {
  it('parses a Copilot agent with the id as fallback name', () => {
    const a = parseCopilotAgent('---\ndescription: Plans\ntools: [read, search, agent, githubRepo]\nmodel: GPT-5\n---\nPlan it.', '.github/agents/planner.agent.md').agents[0]
    expect(a).toMatchObject({ source: 'copilot', name: 'planner', tools: ['read', 'search', 'agent', 'githubRepo'], model: 'GPT-5', prompt: 'Plan it.' })
  })
  it('parses a Gemini agent', () => {
    const a = parseGeminiAgent('---\nname: researcher\ndescription: Researches\ntools:\n  - read_file\n  - google_web_search\nmodel: gemini-2.5-pro\ntemperature: 0.2\n---\nResearch.', '.gemini/agents/researcher.md').agents[0]
    expect(a).toMatchObject({ source: 'gemini', name: 'researcher', tools: ['read_file', 'google_web_search'], model: 'gemini-2.5-pro' })
    expect(a.notes).toEqual(['Ignored "temperature" (not imported)'])
  })
  it('parses Kiro json and md, and resolves file:// prompts', () => {
    const j = parseKiroAgent('{"name":"dev","description":"Dev","prompt":"file://./p.md","tools":["fs_read","execute_bash"],"model":"claude-sonnet-4","mcpServers":{}}', '.kiro/agents/dev.json', (p) => (p === './p.md' ? 'From file' : null))
    expect(j.agents[0]).toMatchObject({ source: 'kiro', name: 'dev', prompt: 'From file', tools: ['fs_read', 'execute_bash'] })
    expect(j.agents[0].notes).toEqual(['Ignored "mcpServers" (not imported)'])
    const star = parseKiroAgent('{"tools":["*"],"prompt":"x"}', '.kiro/agents/all.json').agents[0]
    expect(star.name).toBe('all')
    expect(star.tools).toBeUndefined()
    const md = parseKiroAgent('---\nname: m\n---\nBody', '.kiro/agents/m.md').agents[0]
    expect(md).toMatchObject({ name: 'm', prompt: 'Body' })
    expect(parseKiroAgent('{bad', '.kiro/agents/b.json').warnings[0]).toMatch(/^\.kiro\/agents\/b\.json: invalid JSON/)
  })
})

describe('parseRooModes', () => {
  const yaml =
    'customModes:\n  - slug: docs-writer\n    name: Docs Writer\n    roleDefinition: You write docs. You are precise.\n    customInstructions: Use plain words.\n    groups:\n      - read\n      - - edit\n        - fileRegex: \\.md$\n      - mcp\n  - slug: ask\n    name: Ask\n    roleDefinition: Answer.\n    whenToUse: When the user asks.\n    groups: [read, command, browser]\n'
  it('parses YAML with several modes', () => {
    const r = parseRooModes(yaml, '.roomodes')
    expect(r.warnings).toEqual([])
    expect(r.agents).toHaveLength(2)
    expect(r.agents[0]).toMatchObject({ source: 'roo', slug: 'docs-writer', name: 'Docs Writer', description: 'You write docs.', prompt: 'You write docs. You are precise.\n\nUse plain words.', tools: ['read', 'glob', 'grep', 'edit', 'write'] })
    expect(r.agents[0].notes.length).toBe(2)
    expect(r.agents[1]).toMatchObject({ description: 'When the user asks.', tools: ['read', 'glob', 'grep', 'bash', 'webfetch'] })
  })
  it('parses JSON and warns on junk', () => {
    const r = parseRooModes('{"customModes":[{"slug":"a","name":"A","roleDefinition":"Do a","groups":["read"]},{"slug":"x"},5]}', '.roomodes')
    expect(r.agents.map((a) => a.name)).toEqual(['A', 'x'])
    expect(r.warnings).toHaveLength(1)
    expect(parseRooModes('{"nope":1}', '.roomodes').warnings[0]).toMatch(/no customModes/)
    expect(parseRooModes('{ bad', '.roomodes').warnings[0]).toMatch(/invalid JSON/)
  })
})

describe('parseOrgExport', () => {
  const doc = {
    format: 'orgai.org/1',
    exportedAt: '2026-01-01',
    project: { name: 'P' },
    roles: [
      { slug: 'lead', name: 'Lead', description: 'Runs', responsibilities: ['plan'], prompt: 'Lead it', tools: ['Read'], model: 'opus', tier: 'top', effort: 'high', canSpawn: true, spawnable: ['dev'], reportsTo: null, color: '#fff' },
      { slug: 'dev', name: 'Dev', reportsTo: 'lead', tier: 'bogus', canSpawn: 'yes' },
      { slug: 'noname' },
      'junk'
    ]
  }
  it('parses roles and validates field types', () => {
    const r = parseOrgExport(JSON.stringify(doc), '.orgai/org.json')
    expect(r.agents.map((a) => a.slug)).toEqual(['lead', 'dev', 'noname'])
    expect(r.agents[0]).toMatchObject({ reportsTo: null, canSpawn: true, spawnable: ['dev'], tier: 'top', responsibilities: ['plan'], color: '#fff', effort: 'high' })
    expect(r.agents[1].reportsTo).toBe('lead')
    expect(r.agents[1].tier).toBeUndefined()
    expect(r.agents[1].canSpawn).toBeUndefined()
    expect(r.agents[1].notes).toEqual(['Ignored "canSpawn": wrong type', 'Ignored "tier": wrong type'])
    expect(r.warnings).toHaveLength(1)
  })
  it('refuses other formats and bad JSON', () => {
    const r = parseOrgExport('{"format":"orgai.org/2","roles":[]}', 'o.json')
    expect(r.agents).toEqual([])
    expect(r.warnings[0]).toMatch(/unsupported export format/)
    expect(parseOrgExport('nope', 'o.json').warnings[0]).toMatch(/^o\.json: invalid JSON/)
    expect(parseOrgExport('[]', 'o.json').agents).toEqual([])
  })
})
