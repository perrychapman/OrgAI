import { describe, expect, it } from 'vitest'
import { parseToml } from './toml'

describe('parseToml', () => {
  it('parses scalars, strings, arrays, tables and comments', () => {
    const r = parseToml(
      '# top\nname = "reviewer" # c\nlit = \'C:\\path\'\nn = 1_000\nf = 1.5\nok = true\narr = ["a", \'b\',\n  "c",\n]\n"quoted key" = 1\n\n[features]\nshell_tool = false\n\n[a.b]\nx = "y"\n[[items]]\nid = 1\n[[items]]\nid = 2\n'
    )
    expect(r.error).toBeUndefined()
    expect(r.data).toEqual({
      name: 'reviewer',
      lit: 'C:\\path',
      n: 1000,
      f: 1.5,
      ok: true,
      arr: ['a', 'b', 'c'],
      'quoted key': 1,
      features: { shell_tool: false },
      a: { b: { x: 'y' } },
      items: [{ id: 1 }, { id: 2 }]
    })
  })
  it('handles multi-line strings and escapes', () => {
    const r = parseToml('a = """\nline1\n  line2 \\u00e9\n"""\nb = \'\'\'\nraw \\n\n\'\'\'\nc = "t\\tab"\nd = """one \\\n   two"""\r\n')
    expect(r.error).toBeUndefined()
    expect(r.data.a).toBe('line1\n  line2 \u00e9\n')
    expect(r.data.b).toBe('raw \\n\n')
    expect(r.data.c).toBe('t\tab')
    expect(r.data.d).toBe('one two')
  })
  it('keeps going after a bad line and reports it', () => {
    const r = parseToml('a = 1\nb = nope\nc = 3\n[x\nd = 4\n')
    expect(r.error).toMatch(/line 2/)
    expect(r.data.a).toBe(1)
    expect(r.data.c).toBe(3)
  })
  it('rejects duplicate and prototype keys, never throws', () => {
    expect(parseToml('a = 1\na = 2').error).toMatch(/duplicate/)
    expect(parseToml('__proto__ = 1').error).toBeTruthy()
    expect(parseToml('a = """unterminated').error).toBeTruthy()
  })
})
