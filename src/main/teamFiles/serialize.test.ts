import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TEAM_FILES_AGENTS_DIR, TEAM_FILES_FORMAT, TEAM_FILES_JSON, TEAM_FILES_MCP_JSON } from '@shared/types'
import { parseFrontmatter } from '../setup/import/frontmatter'
import { normalizeDoc, normalizeText, teamDigest } from './digest'
import { parseTeamFiles } from './parse'
import { serializeMcpJson, serializeRole, serializeSkill, serializeTeam, serializeTeamJson, yamlQuote } from './serialize'
import { role, sampleDoc, shuffled } from './doc.fixture'

describe('yamlQuote', () => {
  it('round trips every code unit through the frontmatter parser', () => {
    const all: string[] = []
    for (let c = 0; c < 0x300; c++) all.push(String.fromCharCode(c))
    for (const c of [0x2028, 0x2029, 0xfeff, 0xd800, 0xdc00, 0x200b, 0x202e, 0xfffd]) all.push(String.fromCharCode(c))
    const s = all.join('')
    const fm = parseFrontmatter(`---\nk: ${yamlQuote(s)}\nlist:\n  - ${yamlQuote(s)}\n---\n`)
    expect(fm.error).toBeUndefined()
    expect(fm.data.k).toBe(s)
    expect(fm.data.list).toEqual([s])
  })

  it('does not use JSON escapes the parser would not understand', () => {
    const q = yamlQuote('\b\f\v')
    expect(q).toBe('"\\u0008\\u000c\\u000b"')
  })

  it('keeps emoji and other astral characters raw', () => {
    expect(yamlQuote('a 😀 b')).toBe('"a 😀 b"')
  })
})

describe('serializeRole', () => {
  it('writes keys in a fixed order and omits absent optional keys', () => {
    const text = serializeRole(role('dev', { reportsTo: null, effort: undefined }))
    const keys = text
      .split('\n')
      .filter((l) => /^[a-zA-Z]+:/.test(l))
      .map((l) => l.split(':')[0])
    expect(keys).toEqual(['name', 'description', 'responsibilities', 'tools', 'tier', 'canSpawn', 'spawnable', 'reportsTo', 'color', 'skills', 'mcpServers'])
    expect(text).toContain('reportsTo: null')
    expect(text).toContain('spawnable: []')
    expect(text.endsWith('You are the dev.\n')).toBe(true)
    expect(serializeRole(role('x', { tier: undefined, model: 'gpt-5', effort: 'max' }))).toMatch(/model: "gpt-5"\neffort: "max"\ncanSpawn/)
  })

  it('round trips messy text', () => {
    const messy = role('dev', {
      name: 'Dev: "the" #1 - lead 日本語 😀',
      description: 'Line one\nline two: with colon # and hash\n\tindented — "quotes" \\ backslash   sep',
      responsibilities: ['- leading dash', "it's: tricky # yes", '', '  spaced  '],
      prompt: 'First\n\n---\n\nname: not frontmatter\n---\n\n    code\n\r\nlast line',
      reportsTo: null
    })
    const doc = { ...sampleDoc(), roles: [messy, ...sampleDoc().roles.filter((r) => r.slug !== 'lead' && r.slug !== 'dev').map((r) => ({ ...r, reportsTo: 'dev' }))] }
    doc.skills = []
    doc.mcp = []
    doc.roles = doc.roles.map((r) => ({ ...r, skills: [], mcpServers: [], spawnable: [] }))
    const p = parseTeamFiles(serializeTeam(doc), { base: null, agentsDirExists: true })
    expect(p.problems).toEqual([])
    expect(p.digest).toBe(teamDigest(doc))
    const read = p.doc?.roles.find((r) => r.slug === 'dev')
    expect(read?.name).toBe(messy.name)
    expect(read?.description).toBe(messy.description)
    expect(read?.responsibilities).toEqual(messy.responsibilities)
    expect(read?.prompt).toBe(normalizeText(messy.prompt).trim())
  })

  it('round trips the prompt with CRLF and surrounding blank space (trimmed, LF)', () => {
    const doc = { ...sampleDoc(), skills: [], mcp: [] }
    doc.roles = doc.roles.map((r) => ({ ...r, skills: [], mcpServers: [], prompt: '\r\n\r\nline one\r\nline two\r\n\r\n' }))
    const p = parseTeamFiles(serializeTeam(doc), { base: null, agentsDirExists: true })
    expect(p.doc?.roles[0].prompt).toBe('line one\nline two')
    expect(p.digest).toBe(teamDigest(doc))
  })
})

describe('serializeTeamJson / serializeMcpJson / serializeSkill', () => {
  it('writes team.json in a fixed key order with format first and a trailing newline', () => {
    const text = serializeTeamJson(sampleDoc())
    expect(text.endsWith('}\n')).toBe(true)
    const obj = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(obj)).toEqual(['format', 'brief', 'permissionMode', 'maxBudgetUsd', 'isolateWriters', 'teamReview', 'disabledSkills'])
    expect(obj.format).toBe(TEAM_FILES_FORMAT)
    expect(Object.keys(obj.teamReview as object)).toEqual(['auto', 'everyRuns', 'tokenBudget'])
    expect(obj.disabledSkills).toEqual(['old-skill'])
    expect(text).toContain('\n  "format"')
  })

  it('omits undefined settings and disabledSkills', () => {
    const text = serializeTeamJson({ settings: { brief: '', permissionMode: 'plan', maxBudgetUsd: undefined }, roles: [], skills: [], mcp: [] })
    expect(JSON.parse(text)).toEqual({ format: TEAM_FILES_FORMAT, brief: '', permissionMode: 'plan' })
  })

  it('returns null for no servers and sorts servers, env and headers otherwise', () => {
    expect(serializeMcpJson([])).toBeNull()
    const text = serializeMcpJson([
      { name: 'zeta', transport: 'stdio', command: 'x', env: { B: '2', A: '1' }, enabled: true },
      { name: 'alpha', transport: 'http', url: 'https://a.example', headers: { Z: '1', A: '2' }, enabled: false }
    ]) as string
    const obj = JSON.parse(text) as { servers: { name: string; env?: object; headers?: object }[] }
    expect(obj.servers.map((s) => s.name)).toEqual(['alpha', 'zeta'])
    expect(Object.keys(obj.servers[0].headers ?? {})).toEqual(['A', 'Z'])
    expect(Object.keys(obj.servers[1].env ?? {})).toEqual(['A', 'B'])
  })

  it('writes a skill as SKILL.md plus its files', () => {
    const skill = sampleDoc().skills[0]
    const files = serializeSkill(skill)
    expect(files.map((f) => f.path)).toEqual(['.orgai/skills/code-style/SKILL.md', '.orgai/skills/code-style/format.sh', '.orgai/skills/code-style/logo.bin'])
    expect(files[0].data.toString('utf8')).toBe('---\nname: code-style\ndescription: "How we format code."\n---\n\n# Style\n\nUse two spaces.\n')
    expect(files[2].data).toEqual(Buffer.from([0, 1, 2, 255, 254]))
  })
})

describe('determinism', () => {
  it('writes the same bytes for equal documents whatever the input order', () => {
    const doc = sampleDoc()
    const scrambled = {
      settings: doc.settings,
      roles: shuffled(doc.roles, 3).map((r) => ({ ...r, tools: shuffled(r.tools, 5), spawnable: shuffled(r.spawnable, 2) })),
      skills: shuffled(doc.skills, 4).map((s) => ({ ...s, files: shuffled(s.files, 6) })),
      mcp: shuffled(doc.mcp, 8).map((m) => ({ ...m, secretEnv: m.secretEnv ? shuffled(m.secretEnv) : undefined, roles: m.roles ? shuffled(m.roles) : undefined }))
    }
    const a = serializeTeam(doc)
    const b = serializeTeam(scrambled)
    expect(b.map((f) => [f.path, f.data.toString('base64')])).toEqual(a.map((f) => [f.path, f.data.toString('base64')]))
    expect(teamDigest(scrambled)).toBe(teamDigest(doc))
    expect(normalizeDoc(scrambled)).toEqual(normalizeDoc(doc))
  })

  it('lists the files with the TEAM_FILES paths', () => {
    const paths = serializeTeam(sampleDoc()).map((f) => f.path)
    expect(paths[0]).toBe(TEAM_FILES_JSON)
    expect(paths).toContain(`${TEAM_FILES_AGENTS_DIR}/lead.md`)
    expect(paths).toContain(TEAM_FILES_MCP_JSON)
  })
})

describe('staffing in team files', () => {
  // Pinned from the serializer before staffing existed: the sample team's bytes and parsed digest must not move.
  it('writes an unchanged team byte for byte as before', () => {
    const h = createHash('sha256')
    const files = serializeTeam(sampleDoc())
    for (const f of files) {
      h.update(`${f.path}\0`)
      h.update(f.data)
      h.update('\0')
    }
    expect(files).toHaveLength(9)
    expect(h.digest('hex')).toBe('2eecd52ee4e612dea894a09eddf22e2b7f6a53b946621263c8aaccdfbce52c6c')
    expect(teamDigest(sampleDoc())).toBe('d75939665b00a322004b16d50a327db313bfd5a3eaa484acc3a6cb9bf1672540')
  })

  it('does not write default values', () => {
    const doc = sampleDoc()
    doc.settings.staffing = 'auto'
    doc.settings.staffingGoal = 'balanced'
    doc.settings.reviewPolicy = 'risk'
    const files = serializeTeam(doc)
    expect(files.map((f) => f.data.toString('utf8')).join('\n')).not.toMatch(/staffing|reviewPolicy/)
    expect(teamDigest(doc)).toBe(teamDigest(sampleDoc()))
    expect(serializeTeamJson(doc)).toBe(serializeTeamJson(sampleDoc()))
  })

  it('round trips the role and project fields', () => {
    const doc = sampleDoc()
    doc.settings.staffing = 'fixed'
    doc.settings.staffingGoal = 'cost'
    doc.settings.reviewPolicy = 'never'
    doc.roles.find((r) => r.slug === 'dev')!.staffing = { mode: 'fixed', minTier: 'fast', maxEffort: 'medium' }
    doc.roles.find((r) => r.slug === 'lead')!.staffing = { mode: 'auto' }
    const files = serializeTeam(doc)
    const dev = files.find((f) => f.path.endsWith('/dev.md'))!.data.toString('utf8')
    expect(dev).toMatch(/tier: "everyday"\nstaffing: "fixed"\nstaffing_min_tier: "fast"\nstaffing_max_effort: "medium"\ncanSpawn/)
    const p = parseTeamFiles(files, { base: null, agentsDirExists: true })
    expect(p.problems).toEqual([])
    expect(p.digest).toBe(teamDigest(doc))
    expect(p.doc?.roles.find((r) => r.slug === 'dev')?.staffing).toEqual({ mode: 'fixed', minTier: 'fast', maxEffort: 'medium' })
    expect(p.doc?.roles.find((r) => r.slug === 'lead')?.staffing).toEqual({ mode: 'auto' })
    expect(p.doc?.settings).toMatchObject({ staffing: 'fixed', staffingGoal: 'cost', reviewPolicy: 'never' })
  })

  it('drops malformed values instead of failing the file, and default values on disk', () => {
    const files = serializeTeam(sampleDoc())
    const edit = (path: string, from: string, to: string): void => {
      const f = files.find((x) => x.path === path)!
      f.data = Buffer.from(f.data.toString('utf8').replace(from, to), 'utf8')
    }
    edit(`${TEAM_FILES_AGENTS_DIR}/dev.md`, 'canSpawn:', 'staffing: "sometimes"\nstaffing_max_effort: "huge"\ncanSpawn:')
    edit(`${TEAM_FILES_AGENTS_DIR}/reviewer.md`, 'canSpawn:', 'staffing: "auto"\nstaffing_min_tier: "platinum"\nstaffing_max_effort: "low"\ncanSpawn:')
    edit(`${TEAM_FILES_AGENTS_DIR}/lead.md`, 'canSpawn:', 'staffing_min_tier: "deep"\ncanSpawn:')
    edit(TEAM_FILES_JSON, '"permissionMode"', '"staffing": "auto", "staffingGoal": "bogus", "reviewPolicy": "risk", "permissionMode"')
    const p = parseTeamFiles(files, { base: null, agentsDirExists: true })
    expect(p.problems).toEqual([])
    const byslug = (s: string) => p.doc!.roles.find((r) => r.slug === s)!
    expect(byslug('dev').staffing).toBeUndefined()
    expect(byslug('reviewer').staffing).toEqual({ mode: 'auto', maxEffort: 'low' })
    expect(byslug('lead').staffing).toBeUndefined()
    expect(p.doc!.settings.staffing).toBeUndefined()
    expect(p.doc!.settings.staffingGoal).toBeUndefined()
    expect(p.doc!.settings.reviewPolicy).toBeUndefined()
  })
})

