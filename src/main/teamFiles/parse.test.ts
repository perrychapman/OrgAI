import { describe, expect, it } from 'vitest'
import { TEAM_FILES_AGENTS_DIR, TEAM_FILES_JSON, TEAM_FILES_MCP_JSON } from '@shared/types'
import type { TeamDoc, TeamFile } from './doc'
import { normalizeDoc, teamDigest } from './digest'
import { chartProblem, parseTeamFiles, serverFileRefusal } from './parse'
import { serializeTeam } from './serialize'
import { role, sampleDoc, shuffled, textFile, toCrlf } from './doc.fixture'

const parse = (files: TeamFile[], base: TeamDoc | null = null, extra: { agentsDirExists?: boolean } = {}) =>
  parseTeamFiles(files, { base, agentsDirExists: extra.agentsDirExists ?? true })

const replaceFile = (files: TeamFile[], path: string, text: string | null): TeamFile[] => {
  const rest = files.filter((f) => f.path !== path)
  return text === null ? rest : [...rest, textFile(path, text)]
}
const fileText = (files: TeamFile[], path: string): string => files.find((f) => f.path === path)?.data.toString('utf8') ?? ''

describe('round trip', () => {
  it('parses what serializeTeam wrote into the same document', () => {
    const doc = sampleDoc()
    const files = serializeTeam(doc)
    const p = parse(files)
    expect(p.problems).toEqual([])
    expect(p.present).toBe(true)
    expect(p.doc).toEqual(normalizeDoc(doc))
    expect(p.digest).toBe(teamDigest(doc))
  })

  it('gives the same digest for CRLF-converted files', () => {
    const files = serializeTeam(sampleDoc())
    const a = parse(files)
    const b = parse(toCrlf(files))
    expect(b.problems).toEqual([])
    expect(b.digest).toBe(a.digest)
    expect(b.doc).toEqual(a.doc)
  })

  it('gives the same result whatever the order of the files', () => {
    const files = serializeTeam(sampleDoc())
    expect(parse(shuffled(files)).digest).toBe(parse(files).digest)
  })

  it('tolerates a BOM in team.json and mcp.json', () => {
    let files = serializeTeam(sampleDoc())
    for (const path of [TEAM_FILES_JSON, TEAM_FILES_MCP_JSON]) files = replaceFile(files, path, `\uFEFF${fileText(files, path)}`)
    expect(parse(files).problems).toEqual([])
  })

  it('reads disabledSkills as enabled false', () => {
    const p = parse(serializeTeam(sampleDoc()))
    expect(p.doc?.skills.find((s) => s.name === 'old-skill')?.enabled).toBe(false)
    expect(p.doc?.skills.find((s) => s.name === 'code-style')?.enabled).toBe(true)
  })

  it('keeps binary skill files as base64 and text files as LF text', () => {
    const p = parse(serializeTeam(sampleDoc()))
    const skill = p.doc?.skills.find((s) => s.name === 'code-style')
    expect(skill?.files.find((f) => f.path === 'logo.bin')?.base64).toBe(Buffer.from([0, 1, 2, 255, 254]).toString('base64'))
    expect(skill?.files.find((f) => f.path === 'format.sh')?.text).toBe('#!/bin/sh\necho format\n')
  })
})

describe('whole team', () => {
  it('has no document and says what is missing', () => {
    const files = serializeTeam(sampleDoc())
    const noJson = parse(replaceFile(files, TEAM_FILES_JSON, null))
    expect(noJson.present).toBe(false)
    expect(noJson.doc).toBeNull()
    expect(noJson.problems[0].file).toBe(TEAM_FILES_JSON)
    expect(noJson.problems[0].message).toMatch(/last approved team stays/)
    const noAgents = parse(
      files.filter((f) => !f.path.startsWith(TEAM_FILES_AGENTS_DIR)),
      null,
      { agentsDirExists: false }
    )
    expect(noAgents.doc).toBeNull()
    expect(noAgents.problems.some((p) => p.file === TEAM_FILES_AGENTS_DIR && /missing/.test(p.message))).toBe(true)
    const emptyAgents = parse(
      files.filter((f) => !f.path.startsWith(TEAM_FILES_AGENTS_DIR)),
      null,
      { agentsDirExists: true }
    )
    expect(emptyAgents.doc).toBeNull()
    expect(emptyAgents.problems.some((p) => p.file === TEAM_FILES_AGENTS_DIR && /no usable role/.test(p.message))).toBe(true)
  })

  it('treats a team.json named in readProblems as present, and keeps the base settings', () => {
    const base = sampleDoc()
    const files = serializeTeam(base).filter((f) => f.path !== TEAM_FILES_JSON)
    const p = parseTeamFiles(files, { base, agentsDirExists: true, readProblems: [{ file: TEAM_FILES_JSON, message: 'It is too large to read.' }] })
    expect(p.present).toBe(true)
    expect(p.doc?.settings).toEqual(normalizeDoc(base).settings)
    expect(p.heldPaths).toContain(TEAM_FILES_JSON)
  })

  it('treats a deleted role file as a removal', () => {
    const base = sampleDoc()
    const files = serializeTeam(base).filter((f) => f.path !== `${TEAM_FILES_AGENTS_DIR}/reviewer.md`)
    const p = parse(files, base)
    expect(p.doc?.roles.map((r) => r.slug)).toEqual(['dev', 'lead'])
    // The lead still lists the reviewer as spawnable: dropped with a note.
    expect(p.doc?.roles.find((r) => r.slug === 'lead')?.spawnable).toEqual(['dev'])
    expect(p.notes.length).toBeGreaterThan(0)
  })

  it('has no servers without mcp.json and no skills without a skills folder', () => {
    const files = serializeTeam(sampleDoc()).filter((f) => f.path !== TEAM_FILES_MCP_JSON && !f.path.startsWith('.orgai/skills/'))
    const p = parse(files)
    expect(p.doc?.mcp).toEqual([])
    expect(p.doc?.skills).toEqual([])
    // Grants to things that no longer exist are dropped with a note.
    expect(p.doc?.roles.find((r) => r.slug === 'dev')?.skills).toEqual([])
    expect(p.doc?.roles.find((r) => r.slug === 'dev')?.mcpServers).toEqual([])
  })

  it('refuses a chart with two roots, a missing parent or a cycle', () => {
    expect(chartProblem({ roles: [role('a', { reportsTo: null }), role('b', { reportsTo: null })] })).toMatch(/More than one/)
    expect(chartProblem({ roles: [role('a', { reportsTo: null }), role('b', { reportsTo: 'zz' })] })).toMatch(/not a role/)
    expect(chartProblem({ roles: [role('a', { reportsTo: null }), role('b', { reportsTo: 'c' }), role('c', { reportsTo: 'b' })] })).toMatch(/loop/)
    expect(chartProblem({ roles: [] })).toMatch(/no roles/)
    expect(chartProblem({ roles: [role('a', { reportsTo: null }), role('b', { reportsTo: 'a' })] })).toBeNull()
    const doc = sampleDoc()
    const files = replaceFile(serializeTeam(doc), `${TEAM_FILES_AGENTS_DIR}/dev.md`, fileText(serializeTeam(doc), `${TEAM_FILES_AGENTS_DIR}/dev.md`).replace('reportsTo: "lead"', 'reportsTo: "nobody"'))
    const p = parse(files)
    expect(p.doc).toBeNull()
    expect(p.problems.some((x) => x.file === TEAM_FILES_AGENTS_DIR)).toBe(true)
  })

  it('refuses more roles than the cap', () => {
    const files: TeamFile[] = [textFile(TEAM_FILES_JSON, '{"format":"orgai.team/1"}')]
    for (let i = 0; i < 201; i++) files.push(textFile(`${TEAM_FILES_AGENTS_DIR}/r${i}.md`, '---\nname: "R"\ndescription: "d"\n---\n'))
    const p = parse(files)
    expect(p.doc).toBeNull()
    expect(p.problems[0].file).toBe(TEAM_FILES_AGENTS_DIR)
  })
})

describe('conflict markers and broken files', () => {
  const conflict = '<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> branch\n'

  it('makes a team.json with conflict markers a problem, held, keeping the base settings', () => {
    const base = sampleDoc()
    const files = replaceFile(serializeTeam(base), TEAM_FILES_JSON, conflict)
    const p = parse(files, base)
    expect(p.problems).toEqual([{ file: TEAM_FILES_JSON, message: 'It has merge conflict markers.' }])
    expect(p.heldPaths).toEqual([TEAM_FILES_JSON])
    expect(p.doc?.settings).toEqual(normalizeDoc(base).settings)
  })

  it('makes an mcp.json with conflict markers a problem that keeps the base servers', () => {
    const base = sampleDoc()
    const p = parse(replaceFile(serializeTeam(base), TEAM_FILES_MCP_JSON, conflict), base)
    expect(p.problems.map((x) => x.file)).toEqual([TEAM_FILES_MCP_JSON])
    expect(p.doc?.mcp).toEqual(normalizeDoc(base).mcp)
  })

  it('makes a role with markers in its header or both ends in its body a problem, and keeps the base role', () => {
    const base = sampleDoc()
    const path = `${TEAM_FILES_AGENTS_DIR}/dev.md`
    const header = replaceFile(serializeTeam(base), path, `---\nname: "Dev"\n<<<<<<< HEAD\n=======\n>>>>>>> x\n---\nbody`)
    const a = parse(header, base)
    expect(a.problems).toEqual([{ file: path, message: 'It has merge conflict markers.' }])
    expect(a.doc?.roles.find((r) => r.slug === 'dev')).toEqual(normalizeDoc(base).roles.find((r) => r.slug === 'dev'))
    expect(a.heldPaths).toContain(path)
    const body = replaceFile(serializeTeam(base), path, fileText(serializeTeam(base), path) + '\n' + conflict)
    expect(parse(body, base).problems).toEqual([{ file: path, message: 'It has merge conflict markers.' }])
    // A markdown underline of "=======" alone in the body is not a conflict.
    const heading = replaceFile(serializeTeam(base), path, fileText(serializeTeam(base), path) + '\nTitle\n=======\nmore\n')
    expect(parse(heading, base).problems).toEqual([])
  })

  it('keeps the base for a broken role file, and the item is simply absent without a base', () => {
    const base = sampleDoc()
    const path = `${TEAM_FILES_AGENTS_DIR}/reviewer.md`
    const broken = replaceFile(serializeTeam(base), path, '---\nname: "R"\n')
    const withBase = parse(broken, base)
    expect(withBase.problems.map((x) => x.file)).toEqual([path])
    expect(withBase.doc?.roles.map((r) => r.slug)).toContain('reviewer')
    expect(withBase.heldPaths).toEqual([path])
    const noBase = parse(broken, null)
    expect(noBase.doc?.roles.map((r) => r.slug)).toEqual(['dev', 'lead'])
    expect(noBase.problems).toHaveLength(1)
    // With the broken file, the digest also depends on its content.
    const other = parse(replaceFile(serializeTeam(base), path, '---\nname: "R2"\n'), base)
    expect(other.digest).not.toBe(withBase.digest)
  })

  it('names a different format version without guessing', () => {
    const files = replaceFile(serializeTeam(sampleDoc()), TEAM_FILES_JSON, '{"format":"orgai.team/9"}')
    const p = parse(files)
    expect(p.problems[0].message).toMatch(/different OrgAI version/)
  })

  it('reports problems without quoting file text', () => {
    const secretish = 'SECRET-PHRASE-1234'
    const files = replaceFile(serializeTeam(sampleDoc()), `${TEAM_FILES_AGENTS_DIR}/dev.md`, `---\nname: "${secretish}"\ndescription: 5\n---\n`)
    const p = parse(files)
    expect(JSON.stringify(p.problems)).not.toContain(secretish)
  })
})

describe('team.json validation', () => {
  const withJson = (obj: unknown): TeamFile[] => replaceFile(serializeTeam(sampleDoc()), TEAM_FILES_JSON, JSON.stringify(obj))

  it('rejects a bad value for the whole file and ignores unknown keys with a note', () => {
    const bad = parse(withJson({ format: 'orgai.team/1', permissionMode: 'yolo' }), sampleDoc())
    expect(bad.problems.map((x) => x.file)).toEqual([TEAM_FILES_JSON])
    for (const v of [{ maxBudgetUsd: -1 }, { maxBudgetUsd: 'x' }, { isolateWriters: 'yes' }, { teamReview: { auto: 'maybe' } }, { skillEvaluation: 5 }, { brief: 7 }, { disabledSkills: [1] }]) {
      expect(parse(withJson({ format: 'orgai.team/1', ...v }), sampleDoc()).problems).toHaveLength(1)
    }
    const ok = parse(withJson({ format: 'orgai.team/1', brief: 'x', permissionMode: 'plan', futureThing: 1 }))
    expect(ok.problems).toEqual([])
    expect(ok.notes.some((n) => /does not know/.test(n))).toBe(true)
  })

  it('is safe against __proto__ keys', () => {
    const p = parse(replaceFile(serializeTeam(sampleDoc()), TEAM_FILES_JSON, '{"format":"orgai.team/1","__proto__":{"permissionMode":"bypassPermissions"},"brief":"x"}'))
    expect(p.problems).toEqual([])
    expect(p.doc?.settings.permissionMode).toBe('default')
    expect(({} as Record<string, unknown>).permissionMode).toBeUndefined()
  })

  it('refuses a team.json over the size cap', () => {
    const big = Buffer.alloc(1024 * 1024 + 1, 0x20)
    const p = parse([...serializeTeam(sampleDoc()).filter((f) => f.path !== TEAM_FILES_JSON), { path: TEAM_FILES_JSON, data: big }])
    expect(p.problems[0].message).toMatch(/too large/)
  })
})

describe('role file validation', () => {
  const asRole = (fm: string, body = 'Prompt.'): TeamFile[] => replaceFile(serializeTeam(sampleDoc()), `${TEAM_FILES_AGENTS_DIR}/dev.md`, `---\n${fm}\n---\n\n${body}\n`)
  const base = 'name: "Dev"\ndescription: "d"\nreportsTo: "lead"'

  it('accepts a minimal hand-written role', () => {
    const p = parse(asRole(base))
    expect(p.problems).toEqual([])
    const r = p.doc?.roles.find((x) => x.slug === 'dev')
    expect(r).toMatchObject({ name: 'Dev', model: 'inherit', canSpawn: false, tools: [], prompt: 'Prompt.' })
    expect(r?.color).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('refuses both tier and model, a bad tier, a bad effort, bad tools and hidden characters', () => {
    for (const fm of [
      `${base}\ntier: "deep"\nmodel: "x"`,
      `${base}\ntier: "huge"`,
      `${base}\neffort: "extreme"`,
      `${base}\ntools:\n  - "Bash(rm)"`,
      `${base}\ntools: nope`,
      `${base}\ncanSpawn: "yes"`,
      'name: "Dev\\u202e"\ndescription: "d"\nreportsTo: "lead"',
      'name: ""\ndescription: "d"\nreportsTo: "lead"',
      'description: "d"\nreportsTo: "lead"'
    ]) {
      const p = parse(asRole(fm), sampleDoc())
      expect(p.problems.map((x) => x.file)).toEqual([`${TEAM_FILES_AGENTS_DIR}/dev.md`])
    }
  })

  it('ignores other file names with a note', () => {
    const files = [...serializeTeam(sampleDoc()), textFile(`${TEAM_FILES_AGENTS_DIR}/Reviewer.md`, 'x'), textFile(`${TEAM_FILES_AGENTS_DIR}/notes.txt`, 'x'), textFile(`${TEAM_FILES_AGENTS_DIR}/sub/x.md`, 'x')]
    const p = parse(files)
    expect(p.problems).toEqual([])
    expect(p.notes.length).toBeGreaterThanOrEqual(3)
  })

  it('reads a long description line (64 KB cap) and warns about key-shaped text without quoting it', () => {
    const key = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
    const long = 'x'.repeat(20_000)
    const p = parse(asRole(`name: "Dev"\ndescription: "${long}"\nreportsTo: "lead"`, `Use ${key} to log in.`))
    expect(p.problems).toEqual([])
    expect(p.warnings).toEqual([{ file: `${TEAM_FILES_AGENTS_DIR}/dev.md`, message: expect.stringMatching(/looks like a key/) }])
    expect(JSON.stringify(p.warnings)).not.toContain(key)
  })

  it('drops a malformed staffing key with a note naming it, and says nothing for good or empty ones', () => {
    const notesOf = (fm: string): string[] => {
      const p = parse(asRole(`${base}\ntier: "everyday"\n${fm}`))
      expect(p.problems).toEqual([])
      return p.notes.filter((n) => /staffing/.test(n))
    }
    expect(notesOf('staffing: "sometimes"\nstaffing_max_effort: "low"')).toEqual([
      'dev has staffing settings that are not valid or not used without a staffing mode (staffing, staffing_max_effort); they were ignored.'
    ])
    expect(notesOf('staffing: "auto"\nstaffing_min_tier: "platinum"\nstaffing_max_effort: "low"')).toEqual([
      'dev has a staffing setting that is not valid or not used without a staffing mode (staffing_min_tier); it was ignored.'
    ])
    expect(notesOf('staffing_min_tier: "deep"')).toEqual(['dev has a staffing setting that is not valid or not used without a staffing mode (staffing_min_tier); it was ignored.'])
    expect(notesOf('staffing: "fixed"\nstaffing_min_tier: "fast"\nstaffing_max_effort: "medium"')).toEqual([])
    expect(notesOf('staffing:')).toEqual([])
    const kept = parse(asRole(`${base}\ntier: "everyday"\nstaffing: "auto"\nstaffing_min_tier: "platinum"\nstaffing_max_effort: "low"`)).doc?.roles.find((r) => r.slug === 'dev')
    expect(kept?.staffing).toEqual({ mode: 'auto', maxEffort: 'low' })
  })

  it('picks a stable default colour from the slug', () => {
    const a = parse(asRole(base)).doc?.roles.find((r) => r.slug === 'dev')?.color
    const b = parse(asRole(base)).doc?.roles.find((r) => r.slug === 'dev')?.color
    expect(a).toBe(b)
  })
})

describe('skills', () => {
  const skillMd = (extra = '', body = 'Body.') => `---\nname: code-style\ndescription: "How."\n${extra}---\n\n${body}\n`
  const withSkill = (files: Record<string, string | Buffer>): TeamFile[] => {
    const rest = serializeTeam(sampleDoc()).filter((f) => !f.path.startsWith('.orgai/skills/'))
    return [...rest, ...Object.entries(files).map(([p, d]) => ({ path: `.orgai/skills/code-style/${p}`, data: Buffer.isBuffer(d) ? d : Buffer.from(d, 'utf8') }))]
  }

  it('refuses shell injection, naming the skill folder, and keeps the base skill', () => {
    const base = sampleDoc()
    const p = parse(withSkill({ 'SKILL.md': skillMd('', 'Run !`rm -rf /` now.') }), base)
    expect(p.problems.map((x) => x.file)).toEqual(['.orgai/skills/code-style'])
    expect(p.heldPaths).toContain('.orgai/skills/code-style')
    expect(p.doc?.skills.map((s) => s.name)).toContain('code-style')
    // A fenced form too.
    expect(parse(withSkill({ 'SKILL.md': skillMd('', '```!\nls\n```') }), base).problems).toHaveLength(1)
  })

  it('refuses a folder whose SKILL.md names another skill, a missing SKILL.md, git internals, hidden characters and path tricks', () => {
    expect(parse(withSkill({ 'SKILL.md': '---\nname: other\ndescription: "d"\n---\nb' })).problems).toHaveLength(1)
    expect(parse(withSkill({ 'readme.md': 'x' })).problems).toHaveLength(1)
    expect(parse(withSkill({ 'SKILL.md': skillMd(), '.git/config': 'x' })).problems).toHaveLength(1)
    expect(parse(withSkill({ 'SKILL.md': skillMd(), 'a.txt': 'hi\u202etxt' })).problems).toHaveLength(1)
    expect(parse(withSkill({ 'SKILL.md': skillMd(), 'CON.txt': 'x' })).problems).toHaveLength(1)
    const ok = parse(withSkill({ 'SKILL.md': skillMd(), 'notes/a.txt': 'fine' }))
    expect(ok.problems).toEqual([])
    expect(ok.doc?.skills[0].files).toEqual([{ path: 'notes/a.txt', text: 'fine' }])
  })

  it('drops other frontmatter keys of SKILL.md (they are never stored)', () => {
    const p = parse(withSkill({ 'SKILL.md': skillMd('allowed-tools: Bash\n') }))
    expect(p.problems).toEqual([])
    expect(JSON.stringify(p.doc)).not.toContain('allowed-tools')
  })

  it('warns about key-shaped text in a skill file without quoting it', () => {
    const p = parse(withSkill({ 'SKILL.md': skillMd(), 'env.txt': 'token = sk-abcdefghijklmnopqrstuvwxyz0123456789' }))
    expect(p.warnings.some((w) => w.file === '.orgai/skills/code-style')).toBe(true)
    expect(JSON.stringify(p.warnings)).not.toContain('abcdefghij')
  })
})

describe('mcp.json', () => {
  const server = (over: Record<string, unknown> = {}) => ({ name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs@1.0.0'], enabled: true, ...over })
  const withServers = (servers: unknown[], base: TeamDoc | null = null) => {
    const files = replaceFile(serializeTeam(sampleDoc()), TEAM_FILES_MCP_JSON, JSON.stringify({ format: 'orgai.team/1', servers }))
    return parse(files, base)
  }

  it('accepts a clean server and rebuilds it field by field', () => {
    const p = withServers([server({ junk: 'x', secretEnv: ['TOKEN'] })])
    expect(p.problems).toEqual([])
    expect(p.doc?.mcp[0]).toEqual({ name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs@1.0.0'], secretEnv: ['TOKEN'], enabled: true })
  })

  it('refuses credential-shaped values: one refused server makes mcp.json the problem', () => {
    const base = sampleDoc()
    const sk = 'sk-abcdefghijklmnopqrstuvwxyz0123456789'
    for (const bad of [
      server({ args: ['--token=abcdefgh1234'] }),
      server({ args: [sk] }),
      server({ env: { MODE: sk } }),
      server({ env: { API_KEY: 'plain' } }),
      server({ env: { NODE_OPTIONS: '--require x' } }),
      server({ secretEnv: ['PATH'] }),
      { name: 'web', transport: 'http', url: 'https://user:pw@example.com/mcp', enabled: true },
      { name: 'web', transport: 'http', url: 'https://example.com/mcp?api_key=abcdef123456', enabled: true },
      { name: 'web', transport: 'http', url: 'http://example.com/mcp', enabled: true },
      { name: 'web', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abcdef123456' }, enabled: true },
      { name: 'web', transport: 'http', url: 'https://example.com/mcp', secretHeaders: ['Host'], enabled: true },
      server({ command: 'npx\u202e' }),
      server({ command: 'x'.repeat(500) }),
      server({ name: 'Bad Name' }),
      server({ transport: 'carrier-pigeon' })
    ]) {
      const p = withServers([server({ name: 'good' }), bad], base)
      expect(p.problems.map((x) => x.file)).toEqual([TEAM_FILES_MCP_JSON])
      expect(p.heldPaths).toContain(TEAM_FILES_MCP_JSON)
      expect(p.doc?.mcp).toEqual(normalizeDoc(base).mcp)
    }
  })

  it('allows http for localhost and does not apply the pinned-version rule', () => {
    expect(serverFileRefusal({ name: 'local', transport: 'http', url: 'http://localhost:8080/mcp', enabled: true })).toBeNull()
    expect(serverFileRefusal({ name: 'local', transport: 'sse', url: 'http://127.0.0.1:8080/sse', enabled: true })).toBeNull()
    expect(serverFileRefusal({ name: 'local', transport: 'http', url: 'http://[::1]:8080/mcp', enabled: true })).toBeNull()
    expect(serverFileRefusal({ name: 'unpinned', transport: 'stdio', command: 'npx', args: ['-y', 'some-server'], enabled: true })).toBeNull()
  })

  it('refuses duplicate names and too many servers', () => {
    expect(withServers([server(), server()]).problems).toHaveLength(1)
    const many = Array.from({ length: 201 }, (_v, i) => server({ name: `s${i}` }))
    expect(withServers(many).problems[0].message).toMatch(/more than 200/)
  })

  it('drops server roles that do not exist, with a note', () => {
    const p = withServers([server({ roles: ['dev', 'ghost'] })])
    expect(p.doc?.mcp[0].roles).toEqual(['dev'])
    expect(p.notes.some((n) => /roles that do not exist/.test(n))).toBe(true)
  })
})

describe('hostile input', () => {
  it('never throws on prototype keys, deep nesting and huge lines', () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000)
    const files: TeamFile[] = [
      textFile(TEAM_FILES_JSON, `{"format":"orgai.team/1","brief":${deep}}`),
      textFile(TEAM_FILES_MCP_JSON, `{"format":"orgai.team/1","servers":${deep}}`),
      textFile(`${TEAM_FILES_AGENTS_DIR}/a.md`, `---\n__proto__: x\nname: "${'x'.repeat(2_000_000)}"\n---\n`),
      textFile(`${TEAM_FILES_AGENTS_DIR}/b.md`, `---\n${'a:\n  '.repeat(5000)}\n---\n` + '- '.repeat(100_000)),
      { path: `${TEAM_FILES_AGENTS_DIR}/c.md`, data: Buffer.from([0xff, 0xfe, 0x00, 0x80]) },
      textFile('.orgai/skills/x/../../evil/SKILL.md', 'x'),
      { path: '../outside.md', data: Buffer.from('x') },
      { path: undefined as unknown as string, data: Buffer.from('x') }
    ]
    const start = Date.now()
    const p = parse(files)
    expect(Date.now() - start).toBeLessThan(5000)
    expect(p.doc).toBeNull()
    expect(Array.isArray(p.problems)).toBe(true)
    expect(parseTeamFiles(null as unknown as TeamFile[], { base: null, agentsDirExists: true }).doc).toBeNull()
  })
})

describe('security review fixes', () => {
  const withSettings = (patch: Record<string, unknown>): TeamFile[] => {
    const files = serializeTeam(sampleDoc())
    const j = JSON.parse(fileText(files, TEAM_FILES_JSON)) as Record<string, unknown>
    return replaceFile(files, TEAM_FILES_JSON, JSON.stringify({ ...j, ...patch }))
  }

  it('subagent depth and concurrency above the effective caps are a problem for team.json', () => {
    expect(parse(withSettings({ maxSubagentDepth: 5, maxConcurrentSubagents: 32 })).problems).toEqual([])
    for (const patch of [{ maxSubagentDepth: 6 }, { maxConcurrentSubagents: 33 }, { maxSubagentDepth: 1000 }]) {
      const p = parse(withSettings(patch))
      expect(p.problems.map((x) => x.file), JSON.stringify(patch)).toEqual([TEAM_FILES_JSON])
      expect(p.heldPaths).toContain(TEAM_FILES_JSON)
    }
  })

  it('a key in a server\'s command or description is refused', () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'
    const base = { name: 'docs', transport: 'stdio' as const, command: 'npx', args: ['-y', 'docs@1.0.0'], enabled: true }
    expect(serverFileRefusal(base)).toBeNull()
    expect(serverFileRefusal({ ...base, description: `Use ${key}` })).toMatch(/secret/)
    expect(serverFileRefusal({ ...base, command: `run --token=${key}` })).toMatch(/secret/)
  })

  it('the injected link check makes mcp.json a problem and keeps the approved servers', () => {
    const files = serializeTeam(sampleDoc())
    const base = parse(files).doc!
    const p = parseTeamFiles(files, { base, agentsDirExists: true, linkCheck: (m) => (m.connectorId ? 'Its address is not the one this computer uses.' : null) })
    expect(p.problems.map((x) => x.file)).toEqual([TEAM_FILES_MCP_JSON])
    expect(p.problems[0].message).toContain('Server wiki was refused')
    expect(p.heldPaths).toContain(TEAM_FILES_MCP_JSON)
    expect(p.doc?.mcp).toEqual(base.mcp)
    // A throwing check never takes the parse down.
    expect(parseTeamFiles(files, { base, agentsDirExists: true, linkCheck: () => { throw new Error('boom') } }).problems).toEqual([])
  })
})
