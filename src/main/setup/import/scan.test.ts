import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentDefinitionLocations, importKey, inGitDir, scanAgentSources } from './scan'

let base: string
let root: string
let outside: string

function put(rel: string, text: string, dir = root): void {
  const p = join(dir, ...rel.split('/'))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}
const claude = (name: string, prompt = 'P'): string => `---\nname: ${name}\ndescription: d\n---\n${prompt}`

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orgai-scan-'))
  root = join(base, 'repo')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('scanAgentSources', () => {
  it('returns empty lists for a missing or non-directory root', () => {
    expect(scanAgentSources(join(base, 'nope')).scan).toEqual({ sources: [], instructionFiles: [], warnings: [] })
    put('file.txt', 'x', base)
    expect(scanAgentSources(join(base, 'file.txt')).agents).toEqual([])
  })

  it('finds every source at its known location', () => {
    put('.orgai/org.json', JSON.stringify({ format: 'orgai.org/1', roles: [{ slug: 'a', name: 'A' }] }))
    put('.claude/agents/sub/rev.md', claude('rev'))
    put('.claude/agents/a.md', claude('a'))
    put('.opencode/agent/build.md', '---\nmode: primary\n---\nB')
    put('opencode.jsonc', '{ // c\n "agent": { "x": { "prompt": "{file:./prompts/x.md}" }, }, }')
    put('prompts/x.md', 'From file')
    put('.codex/agents/c.toml', 'developer_instructions = "C"')
    put('.github/agents/g.agent.md', '---\ndescription: g\n---\nG')
    put('.gemini/agents/m.md', '---\nname: m\n---\nM')
    put('.kiro/agents/k.json', '{"name":"k","prompt":"K"}')
    put('.roomodes', '{"customModes":[{"slug":"r","name":"R","roleDefinition":"R"}]}')
    put('AGENTS.md', 'x')
    put('CLAUDE.md', 'x')
    put('.claude/CLAUDE.md', 'x')
    put('GEMINI.md', 'x')
    put('.cursor/rules/a.mdc', 'x')
    const r = scanAgentSources(root)
    expect(r.scan.warnings).toEqual([])
    expect(r.scan.sources.map((s) => [s.source, s.agentCount])).toEqual([
      ['orgai', 1], ['claude', 2], ['opencode', 2], ['codex', 1], ['copilot', 1], ['gemini', 1], ['kiro', 1], ['roo', 1]
    ])
    expect(r.scan.sources[1]).toMatchObject({ label: 'Claude Code', files: ['.claude/agents/a.md', '.claude/agents/sub/rev.md'] })
    expect(r.scan.instructionFiles.sort()).toEqual(['.claude/CLAUDE.md', '.cursor/rules/a.mdc', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'])
    expect(r.agents.find((a) => a.name === 'x')?.prompt).toBe('From file')
    expect(importKey(r.agents[0])).toBe('orgai:.orgai/org.json#A')
    expect(agentDefinitionLocations(root)).toEqual(expect.arrayContaining(['.orgai/org.json', '.claude/agents', 'opencode.jsonc', '.roomodes']))
    expect(agentDefinitionLocations(join(base, 'empty'))).toEqual([])
  })

  it('filters by sources but still lists instruction files', () => {
    put('.claude/agents/a.md', claude('a'))
    put('.codex/agents/c.toml', 'developer_instructions = "C"')
    put('AGENTS.md', 'x')
    const r = scanAgentSources(root, { sources: ['codex'] })
    expect(r.scan.sources.map((s) => s.source)).toEqual(['codex'])
    expect(r.agents.map((a) => a.source)).toEqual(['codex'])
    expect(r.scan.instructionFiles).toEqual(['AGENTS.md'])
  })

  it('turns bad files into warnings', () => {
    put('.claude/agents/noname.md', '---\ndescription: x\n---\nb')
    put('.codex/agents/bad.toml', 'a = = =')
    put('opencode.json', '{ nope')
    const r = scanAgentSources(root)
    expect(r.agents).toEqual([])
    expect(r.scan.warnings.length).toBe(3)
  })

  it('refuses {file:} references that leave the root', () => {
    put('secret.md', 'SECRET', base)
    put('opencode.json', JSON.stringify({ agent: { a: { prompt: '{file:../secret.md}' }, b: { prompt: '{file:../../outside/x}' }, c: { prompt: '{file:/etc/passwd}' } } }))
    const r = scanAgentSources(root)
    expect(r.agents.map((a) => a.prompt)).toEqual(['', '', ''])
    expect(r.scan.warnings).toHaveLength(3)
  })

  it('skips a symlinked directory that escapes the root', () => {
    put('evil.md', claude('evil'), outside)
    try {
      symlinkSync(outside, join(root, 'agents-link'), 'junction')
      mkdirSync(join(root, '.claude'))
      symlinkSync(outside, join(root, '.claude', 'agents'), 'junction')
    } catch {
      return
    }
    const r = scanAgentSources(root)
    expect(r.agents).toEqual([])
    expect(r.scan.warnings.some((w) => /outside the project/.test(w))).toBe(true)
  })

  it('skips a symlinked file that escapes the root, follows one that stays inside', () => {
    put('evil.md', claude('evil'), outside)
    put('real.md', claude('real'), root)
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
    try {
      symlinkSync(join(outside, 'evil.md'), join(root, '.claude', 'agents', 'evil.md'), 'file')
      symlinkSync(join(root, 'real.md'), join(root, '.claude', 'agents', 'real.md'), 'file')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return
      throw err
    }
    const r = scanAgentSources(root)
    expect(r.agents.map((a) => a.name)).toEqual(['real'])
    expect(r.scan.warnings.some((w) => /evil\.md.*outside/.test(w))).toBe(true)
  })

  it('skips a link whose real path lands in .git', () => {
    put('.git/hooks/agent.md', claude('githook'))
    try {
      mkdirSync(join(root, '.claude'))
      symlinkSync(join(root, '.git', 'hooks'), join(root, '.claude', 'agents'), 'junction')
    } catch {
      return
    }
    const r = scanAgentSources(root)
    expect(r.agents).toEqual([])
    expect(r.scan.warnings.some((w) => /into \.git/.test(w))).toBe(true)
  })

  it('treats Windows aliases of .git as .git', () => {
    expect(inGitDir('.git/hooks/a.md')).toBe(true)
    expect(inGitDir('sub\\.GIT. \\a.md')).toBe(true)
    expect(inGitDir('GIT~1/a.md')).toBe(true)
    expect(inGitDir('.github/agents/a.md')).toBe(false)
    expect(inGitDir('.gitignore')).toBe(false)
  })

  it('refuses a relative root', () => {
    put('.claude/agents/a.md', claude('a'))
    expect(scanAgentSources('relative/root')).toEqual({ scan: { sources: [], instructionFiles: [], warnings: [] }, agents: [] })
  })

  it('skips oversized files', () => {
    put('.claude/agents/big.md', claude('big', 'x'.repeat(300 * 1024)))
    put('.claude/agents/ok.md', claude('ok'))
    const r = scanAgentSources(root)
    expect(r.agents.map((a) => a.name)).toEqual(['ok'])
    expect(r.scan.warnings[0]).toMatch(/big\.md.*limit/)
    expect(r.scan.sources[0].files).toEqual(['.claude/agents/ok.md'])
  })

  it('keeps at most 40 agents in source order and warns', () => {
    for (let i = 0; i < 30; i++) put(`.claude/agents/a${String(i).padStart(2, '0')}.md`, claude(`a${i}`))
    for (let i = 0; i < 20; i++) put(`.gemini/agents/g${String(i).padStart(2, '0')}.md`, `---\nname: g${i}\n---\nG`)
    const r = scanAgentSources(root)
    expect(r.agents).toHaveLength(40)
    expect(r.scan.sources.map((s) => s.agentCount)).toEqual([30, 10])
    expect(r.scan.warnings.some((w) => /10 more dropped/.test(w))).toBe(true)
  })

  it('stops after 200 files', () => {
    for (let i = 0; i < 210; i++) put(`.claude/agents/f${String(i).padStart(3, '0')}.md`, claude(`f${i}`))
    const r = scanAgentSources(root)
    expect(r.scan.sources[0].files).toHaveLength(200)
    expect(r.scan.warnings.some((w) => /File limit/.test(w))).toBe(true)
  })

  it('cuts a long prompt with a note', () => {
    put('.claude/agents/long.md', claude('long', 'p'.repeat(25000)))
    const a = scanAgentSources(root).agents[0]
    expect(a.prompt).toHaveLength(20000)
    expect(a.notes).toContain('Prompt cut to 20,000 characters')
  })

  it('respects the Claude depth limit', () => {
    put('.claude/agents/a/b/c/d/ok.md', claude('ok'))
    put('.claude/agents/a/b/c/d/e/deep.md', claude('deep'))
    expect(scanAgentSources(root).agents.map((a) => a.name)).toEqual(['ok'])
  })
})

describe('scanAgentSources hardening', () => {
  it('reads referenced prompts only from .md/.txt/.prompt files outside .git, once each', () => {
    put('.env', 'SECRET=1')
    put('.git/notes.md', 'git internals')
    put('.opencode/prompts/a.md', 'Shared prompt')
    put(
      'opencode.json',
      JSON.stringify({
        agent: {
          env: { prompt: '{file:./.env}' },
          git: { prompt: '{file:./.git/notes.md}' },
          a: { prompt: '{file:./.opencode/prompts/a.md}' },
          b: { prompt: '{file:./.opencode/prompts/a.md}' }
        }
      })
    )
    const r = scanAgentSources(root)
    const byName = new Map(r.agents.map((a) => [a.name, a.prompt]))
    expect(byName.get('env')).toBe('')
    expect(byName.get('git')).toBe('')
    expect(byName.get('a')).toBe('Shared prompt')
    expect(byName.get('b')).toBe('Shared prompt')
    expect(r.scan.warnings.some((w) => w.includes('.env'))).toBe(true)
  })

  it('caps agents per config file before resolving prompt files', () => {
    const agent: Record<string, unknown> = {}
    for (let i = 0; i < 300; i++) agent[`a${i}`] = { prompt: `{file:./p${i}.md}` }
    put('opencode.json', JSON.stringify({ agent }))
    for (let i = 0; i < 300; i++) put(`p${i}.md`, `prompt ${i}`)
    const r = scanAgentSources(root)
    expect(r.agents).toHaveLength(40)
    expect(r.scan.warnings.some((w) => w.includes('only the first 40 of 300'))).toBe(true)
  })

  it('bounds the directory entries it looks at', () => {
    for (let i = 0; i < 5100; i++) put(`.claude/agents/x${String(i).padStart(5, '0')}.txt`, '')
    put('.claude/agents/zz.md', claude('late'))
    const r = scanAgentSources(root)
    expect(r.agents).toHaveLength(0)
    expect(r.scan.warnings.some((w) => w.includes('More than 5000 entries'))).toBe(true)
  })
})
