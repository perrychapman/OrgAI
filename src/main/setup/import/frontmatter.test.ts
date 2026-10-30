import { describe, expect, it } from 'vitest'
import { parseFrontmatter, parseYamlDoc } from './frontmatter'

describe('parseFrontmatter', () => {
  it('parses scalars, quotes, lists and comments', () => {
    const r = parseFrontmatter(
      '---\nname: reviewer # trailing\ndescription: "Reviews \\"code\\"\\nnow"\nmodel: \'son\'\'net\'\ncount: 3\nflag: true\nnothing: null\ntools: [Read, "Grep", Bash(git:*)]\nlist:\n  - a\n  - "b c"\n# comment\ncolor: blue\n---\nBody here\n'
    )
    expect(r.error).toBeUndefined()
    expect(r.data).toEqual({
      name: 'reviewer',
      description: 'Reviews "code"\nnow',
      model: "son'net",
      count: 3,
      flag: true,
      nothing: null,
      tools: ['Read', 'Grep', 'Bash(git:*)'],
      list: ['a', 'b c'],
      color: 'blue'
    })
    expect(r.body).toBe('Body here')
  })
  it('handles CRLF, BOM and block scalars', () => {
    const r = parseFrontmatter('\uFEFF---\r\ndescription: |\r\n  line one\r\n  line two\r\nfolded: >-\r\n  a\r\n  b\r\nkeep: x\r\n---\r\nBody')
    expect(r.data.description).toBe('line one\nline two\n')
    expect(r.data.folded).toBe('a b')
    expect(r.data.keep).toBe('x')
    expect(r.body).toBe('Body')
  })
  it('parses one-level nested maps and block lists at map indent', () => {
    const r = parseFrontmatter('---\ntools:\n  write: false\n  bash: true\npermission:\n  bash:\n    "*": deny\nitems:\n- x\n- y\n---\n')
    expect(r.data.tools).toEqual({ write: false, bash: true })
    expect(r.data.permission).toEqual({ bash: { '*': 'deny' } })
    expect(r.data.items).toEqual(['x', 'y'])
  })
  it('returns the whole text as body without frontmatter and reports an unclosed one', () => {
    expect(parseFrontmatter('Just text')).toEqual({ data: {}, body: 'Just text' })
    expect(parseFrontmatter('---\nname: x\nbody').error).toMatch(/not closed/)
  })
  it('never throws on junk', () => {
    const r = parseFrontmatter('---\n: : :\n\t- [\nfoo\n&a bar: *a\n---\nok')
    expect(r.body).toBe('ok')
    expect(r.error).toBeTruthy()
  })
  it('ignores prototype keys', () => {
    const r = parseFrontmatter('---\n__proto__: x\nname: n\n---\n')
    expect(Object.keys(r.data)).toEqual(['name'])
  })
})

describe('parseYamlDoc', () => {
  it('parses a list of maps with nested lists and tuples', () => {
    const { data, error } = parseYamlDoc(
      'customModes:\n  - slug: docs\n    name: Docs\n    roleDefinition: |-\n      You write docs.\n      Clearly.\n    groups:\n      - read\n      - - edit\n        - fileRegex: \\.md$\n          description: md only\n      - command\n  - slug: two\n    name: Two\n    groups: [read, browser]\n'
    )
    expect(error).toBeUndefined()
    const modes = (data as { customModes: Record<string, unknown>[] }).customModes
    expect(modes).toHaveLength(2)
    expect(modes[0].roleDefinition).toBe('You write docs.\nClearly.')
    expect(modes[0].groups).toEqual(['read', ['edit', { fileRegex: '\\.md$', description: 'md only' }], 'command'])
    expect(modes[1].groups).toEqual(['read', 'browser'])
  })
})
