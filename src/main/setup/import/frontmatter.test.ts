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

describe('frontmatter: hostile input', () => {
  it('a long digit run ending in a non-digit parses fast (no regex backtracking)', () => {
    const start = Date.now()
    const r = parseYamlDoc(`count: ${'1'.repeat(250_000)}x`)
    expect(Date.now() - start).toBeLessThan(1000)
    expect(r.error).toMatch(/longer than 4000 characters/)
    expect(typeof (r.data as Record<string, unknown>).count).toBe('string')
    const flow = `n: [${Array.from({ length: 60 }, () => '9'.repeat(60) + 'x').join(', ')}]`
    const t = Date.now()
    const f = parseYamlDoc(flow)
    expect(Date.now() - t).toBeLessThan(500)
    expect(f.error).toBeUndefined()
    expect((f.data as { n: unknown[] }).n).toHaveLength(60)
  })
  it('a long run of blank lines inside a plain scalar parses fast', () => {
    const start = Date.now()
    const r = parseYamlDoc('a: x\n' + '\n'.repeat(200_000) + '  y')
    expect(Date.now() - start).toBeLessThan(1000)
    expect(r.data).toEqual({ a: 'x y' })
  })
  it('still reads ordinary numbers and leaves long digit strings as strings', () => {
    const r = parseYamlDoc(`a: 3\nb: -1.5e3\nc: .5\nd: 2.\ne: ${'7'.repeat(80)}`)
    expect(r.data).toEqual({ a: 3, b: -1500, c: 0.5, d: 2, e: '7'.repeat(80) })
  })
  it('cuts lines over the cap with an error but keeps the rest', () => {
    const r = parseFrontmatter(`---\nname: x\ndescription: ${'d'.repeat(5000)}\n---\nBody`)
    expect(r.error).toMatch(/line 2 is longer than 4000/)
    expect(r.data.name).toBe('x')
    expect((r.data.description as string).length).toBeLessThan(4000)
    expect(r.body).toBe('Body')
  })
  it('maxLineChars raises the cap, keeps the default otherwise, and stays linear', () => {
    const long = 'd'.repeat(60_000)
    const text = `---\nname: x\ndescription: "${long}"\n---\nBody`
    const ok = parseFrontmatter(text, { maxLineChars: 64 * 1024 })
    expect(ok.error).toBeUndefined()
    expect((ok.data.description as string).length).toBe(60_000)
    expect(parseFrontmatter(text).error).toMatch(/longer than 4000/)
    expect(parseYamlDoc(`a: "${long}"`, { maxLineChars: 1000 }).error).toMatch(/longer than 1000/)
    // Junk option values fall back to the default.
    expect(parseFrontmatter(text, { maxLineChars: Number.NaN }).error).toMatch(/longer than 4000/)
    // Time is linear in the text: four times the lines take about four times as long, not sixteen.
    const timeOf = (lines: number): number => {
      const text = `---\n${Array.from({ length: lines }, (_v, i) => `k${i}: "${'v'.repeat(30_000)}"`).join('\n')}\n---\n`
      const start = performance.now()
      const r = parseFrontmatter(text, { maxLineChars: 64 * 1024 })
      expect(r.error).toBeUndefined()
      return performance.now() - start
    }
    // Best of three each: a slow shared CI runner (GC pauses on multi-MB strings) inflates single samples
    // (one run measured 1859 ms against a 127 ms baseline), while quadratic code is 16x slower in every sample.
    const best = (lines: number): number => Math.min(timeOf(lines), timeOf(lines), timeOf(lines))
    timeOf(10)
    const small = Math.max(best(50), 5)
    const big = best(200)
    expect(big).toBeLessThan(small * 12)
    expect(big).toBeLessThan(5000)
  })
})
