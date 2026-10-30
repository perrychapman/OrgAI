import { describe, expect, it } from 'vitest'
import { SKILL_BODY_MAX_CHARS } from '@shared/types'
import { composeSkillMd, draftProblem, parseSkillMd, skillFromMd, validDraft } from './skillMd'

describe('composeSkillMd / parseSkillMd', () => {
  it('round trips a description with quotes, colons and unicode', () => {
    const description = 'Use when "x": a # b, \\ back - café 日本'
    const md = composeSkillMd({ name: 'my-skill', description, body: '# Title\n\nBody' })
    expect(md.startsWith('---\nname: my-skill\ndescription: "')).toBe(true)
    const p = parseSkillMd(md)
    expect(p.error).toBeUndefined()
    expect(p.name).toBe('my-skill')
    expect(p.description).toBe(description)
    expect(p.body).toBe('# Title\n\nBody')
  })
  it('normalizes a multi-line description to one line on validation', () => {
    expect(validDraft({ name: ' a ', description: 'one\n\ttwo\u0008 three', body: '' })).toEqual({ name: 'a', description: 'one two three', body: '' })
  })
})

describe('draft and frontmatter validation', () => {
  const ok = { name: 'good-name', description: 'Does things.', body: 'x' }
  it('accepts a good draft', () => expect(draftProblem(ok)).toBeNull())
  it.each([
    ['empty name', { ...ok, name: '' }],
    ['65 chars', { ...ok, name: 'a'.repeat(65) }],
    ['uppercase', { ...ok, name: 'Good' }],
    ['claude', { ...ok, name: 'my-claude-skill' }],
    ['anthropic', { ...ok, name: 'anthropic-helper' }],
    ['description with <', { ...ok, description: 'use <b>' }],
    ['description with >', { ...ok, description: 'a > b' }],
    ['empty description', { ...ok, description: '  ' }],
    ['1025 chars', { ...ok, description: 'd'.repeat(1025) }],
    ['long body', { ...ok, body: 'b'.repeat(SKILL_BODY_MAX_CHARS + 1) }],
    ['non-string', { ...ok, body: 3 }]
  ])('refuses %s', (_n, d) => expect(draftProblem(d)).toBeTruthy())
  it('accepts a 64-char name and a 1024-char description', () => {
    expect(draftProblem({ ...ok, name: 'a'.repeat(64), description: 'd'.repeat(1024) })).toBeNull()
  })

  it('skillFromMd defaults the name to the folder and notes a differing name', () => {
    const r = skillFromMd('---\ndescription: Use for x\n---\nBody', 'folder-name')
    expect(r).toMatchObject({ ok: true, name: 'folder-name', body: 'Body' })
    const d = skillFromMd('---\nname: other\ndescription: Use for x\n---\nBody', 'folder-name')
    expect(d.ok && d.notes[0]).toMatch(/folder-name.*other/)
  })
  it('skillFromMd reports invalid frontmatter readably', () => {
    expect(skillFromMd('no frontmatter', 'f')).toMatchObject({ ok: false })
    expect(skillFromMd('---\nname: Bad_Name\ndescription: x\n---\n', 'f')).toMatchObject({ ok: false, reason: expect.stringMatching(/lowercase/) })
    expect(skillFromMd('---\nname: x\ndescription: "a < b"\n---\n', 'f')).toMatchObject({ ok: false, reason: expect.stringMatching(/< or >/) })
    expect(skillFromMd('---\nname: x\n---\n', 'f')).toMatchObject({ ok: false })
    expect(skillFromMd('---\nname: x\ndescription: ' + 'd'.repeat(1025) + '\n---\n', 'f')).toMatchObject({ ok: false })
    expect(skillFromMd('---\nname: claude-x\ndescription: y\n---\n', 'f')).toMatchObject({ ok: false })
  })
  it('folds a block-scalar description', () => {
    const r = skillFromMd('---\nname: x\ndescription: >\n  first line\n  second line\n---\nB', 'x')
    expect(r).toMatchObject({ ok: true, description: 'first line second line' })
  })
  it('parses hostile long lines in linear time', () => {
    const long = 'a'.repeat(250_000)
    const t = Date.now()
    skillFromMd(`---\nname: x\ndescription: ${long}\n---\n${'x '.repeat(50_000)}`, 'x')
    skillFromMd(`---\n${'k: v\n'.repeat(20_000)}description: "${'\\'.repeat(100_000)}\n---\n`, 'x')
    skillFromMd(`---\ndescription: ${' '.repeat(200_000)}x:${'1'.repeat(100_000)}!\n---\n`, 'x')
    expect(Date.now() - t).toBeLessThan(1500)
  })
})

describe('safe SKILL.md', () => {
  const unsafe = '---\nname: x\ndescription: Use for x.\nallowed-tools: Bash(rm:*)\nhooks:\n  PreToolUse:\n    - command: evil\nmodel: opus\n---\nBody'
  it('composeSkillMd writes only name and description', () => {
    const p = skillFromMd(unsafe, 'x')
    if (!p.ok) throw new Error(p.reason)
    expect(p.notes).toContain('Dropped frontmatter keys: allowed-tools, hooks, model.')
    const out = composeSkillMd({ name: p.name, description: p.description, body: p.body })
    expect(out).not.toMatch(/allowed-tools|hooks|model|evil/)
  })
  it('refuses shell injection in the body and in drafts', () => {
    for (const body of ['Run !`git status` now', 'a\n```!\nls\n```', '  ~~~!\nls\n~~~']) {
      const r = skillFromMd(`---\nname: x\ndescription: Use for x.\n---\n${body}`, 'x')
      expect(r).toEqual({ ok: false, reason: expect.stringMatching(/Runs shell commands when loaded/) })
      expect(draftProblem({ name: 'x', description: 'Use for x.', body })).toMatch(/Runs shell commands/)
    }
    expect(draftProblem({ name: 'x', description: 'Use for x.', body: 'Say hi! `code` is fine' })).toBeNull()
  })
})
