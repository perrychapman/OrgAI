/**
 * The pure parts of the widening confirmation of /mcp and /skills: the predicate (what counts as giving more agents a
 * server or skill) and the lines the confirmation shows (names only for env, headers and secrets, nothing cut,
 * nothing unsanitized), plus the dialog's fit check and strict key handling.
 */
import { describe, expect, it } from 'vitest'
import { confirmFits, dialogKey, type Dialog } from './configUi'
import { fixtureProject } from './configTestUtil'
import { mcpConfirmLines, mcpWidens } from './mcpModel'
import { skillConfirmLines, skillWidens } from './skillsModel'
import { char, key } from './panes/testUtil'

const project = fixtureProject() // roles: lead, dev, qa, intern

describe('mcpWidens', () => {
  it('turning a server on widens; turning it off does not', () => {
    expect(mcpWidens(project, { enabled: false, roles: undefined }, { enabled: true, roles: undefined })).toBe(true)
    expect(mcpWidens(project, { enabled: true, roles: undefined }, { enabled: false, roles: undefined })).toBe(false)
  })
  it('a roles change that adds a role widens, including going to every role', () => {
    expect(mcpWidens(project, { enabled: true, roles: ['lead'] }, { enabled: true, roles: ['lead', 'dev'] })).toBe(true)
    expect(mcpWidens(project, { enabled: true, roles: ['lead'] }, { enabled: true, roles: undefined })).toBe(true)
    expect(mcpWidens(project, { enabled: true, roles: [] }, { enabled: true, roles: ['qa'] })).toBe(true)
  })
  it('removing roles, or changing nothing, does not widen', () => {
    expect(mcpWidens(project, { enabled: true, roles: ['lead', 'dev'] }, { enabled: true, roles: ['lead'] })).toBe(false)
    expect(mcpWidens(project, { enabled: true, roles: undefined }, { enabled: true, roles: ['lead'] })).toBe(false)
    expect(mcpWidens(project, { enabled: true, roles: ['lead'] }, { enabled: true, roles: ['lead'] })).toBe(false)
    // A slug this project no longer has is not a role that gains anything.
    expect(mcpWidens(project, { enabled: true, roles: ['lead'] }, { enabled: true, roles: ['lead', 'ghost'] })).toBe(false)
  })
})

describe('skillWidens', () => {
  it('turning on or adding a role widens; the rest does not', () => {
    expect(skillWidens(project, { enabled: false, roleIds: ['lead'] }, { enabled: true, roleIds: ['lead'] })).toBe(true)
    expect(skillWidens(project, { enabled: true, roleIds: ['lead'] }, { enabled: true, roleIds: ['lead', 'qa'] })).toBe(true)
    expect(skillWidens(project, { enabled: true, roleIds: ['lead', 'qa'] }, { enabled: true, roleIds: ['lead'] })).toBe(false)
    expect(skillWidens(project, { enabled: true, roleIds: ['lead'] }, { enabled: false, roleIds: ['lead'] })).toBe(false)
    expect(skillWidens(project, { enabled: true, roleIds: ['lead'] }, { enabled: true, roleIds: ['lead', 'ghost'] })).toBe(false)
  })
})

describe('mcpConfirmLines', () => {
  const spec = {
    name: 'Zed\u001b[31m',
    transport: 'stdio' as const,
    command: 'node',
    args: ['--flag', 'a very long argument '.repeat(30) + 'END', 'x‮y'],
    env: { PLAIN: 'plain-secret-value' },
    secretEnv: ['TOKEN'],
    headers: { 'X-A': 'header-value' },
    secretHeaders: ['Authorization']
  }
  const lines = mcpConfirmLines(spec, 'Turn Zed on?', 'every role')
  const all = lines.join('\n')

  it('shows the command, every argument whole, and names only', () => {
    expect(all).toContain('command: node')
    expect(all).toContain('arguments (3):')
    expect(all).toContain('END')
    expect(all).not.toContain('…')
    expect(all).toContain('PLAIN')
    expect(all).toContain('TOKEN')
    expect(all).toContain('Authorization')
    expect(all).toContain('X-A')
    expect(all).not.toContain('plain-secret-value')
    expect(all).not.toContain('header-value')
    expect(all).toContain('source: this project')
  })
  it('sanitizes every string', () => {
    // eslint-disable-next-line no-control-regex
    expect(/[\u001b‮]/.test(all)).toBe(false)
  })
  it('shows the url of a remote server and the library source', () => {
    const remote = mcpConfirmLines({ name: 'R', transport: 'http', url: 'https://x.example/mcp?a=1' }, 'Add R?', 'every role', 'lib_1')
    expect(remote.join('\n')).toContain('url: https://x.example/mcp?a=1')
    expect(remote.join('\n')).toContain('source: library entry lib_1')
  })
})

describe('skillConfirmLines', () => {
  const spec = { name: 'Docs', description: 'd', files: [{ path: 'SKILL.md' }, { path: 'scripts/\u001b[2Jx.py' }] }
  it('shows files and the first lines of SKILL.md, with the rest counted', () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const out = skillConfirmLines(spec, 'Turn Docs on?', 'Lead', { skillMd: body, body, files: [] }).join('\n')
    expect(out).toContain('files (2):')
    expect(out).toContain('line 0')
    expect(out).toContain('line 11')
    expect(out).not.toContain('line 12')
    expect(out).toContain('18 more lines')
    // eslint-disable-next-line no-control-regex
    expect(/\u001b/.test(out)).toBe(false)
  })
  it('names a library entry as the source and shows its text', () => {
    const out = skillConfirmLines(spec, 'Add Docs?', 'Lead', { skillMd: 'Lib body', body: 'Lib body', files: [] }, 'lib_1').join('\n')
    expect(out).toContain('source: library entry lib_1')
    expect(out).toContain('Lib body')
    expect(out).toContain('Press y to save')
  })
})

describe('confirm dialog', () => {
  it('counts wrapped rows, the title included', () => {
    expect(confirmFits(['a', '', 'b'], 40, 4)).toBe(true)
    expect(confirmFits(['a', '', 'b'], 40, 3)).toBe(false)
    expect(confirmFits(['word '.repeat(50)], 20, 5)).toBe(false)
  })
  it('a strict confirm cancels on any key but y; a plain one keeps waiting', () => {
    const strict: Dialog = { kind: 'confirm', title: 't', lines: [], onYes: () => undefined, strict: true }
    const plain: Dialog = { ...strict, strict: false }
    expect(dialogKey(strict, char('y'), 5).then).toBeDefined()
    expect(dialogKey(strict, char('q'), 5).next).toBeUndefined()
    expect(dialogKey(strict, key('enter'), 5).next).toBeUndefined()
    expect(dialogKey(plain, char('q'), 5).next).toBe(plain)
  })
})
