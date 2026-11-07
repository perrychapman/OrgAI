import { describe, expect, it } from 'vitest'
import { child, descend, parseXml, XmlLiteError } from './xmlLite'

describe('xmlLite', () => {
  it('parses elements, attributes, text, CDATA, comments and the five entities', () => {
    const r = parseXml('<?xml version="1.0"?><a:root xmlns:a="u" id="1"><!-- c --><a:t x=\'q&amp;&quot;\'>x &lt; y &#65;&#x42;<![CDATA[<raw>]]></a:t><b/></a:root>')
    expect(r.name).toBe('root')
    expect(r.prefix).toBe('a')
    expect(r.attrs.id).toBe('1')
    const t = child(r, 't')
    expect(t?.text).toBe('x < y AB<raw>')
    expect(t?.attrs.x).toBe('q&"')
    expect(descend(r, 'b')?.children).toEqual([])
  })
  it('refuses DOCTYPE, ENTITY, unknown entities and billion laughs without expanding anything', () => {
    expect(() => parseXml('<!DOCTYPE x><x/>')).toThrow(XmlLiteError)
    expect(() => parseXml('<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>')).toThrow(/DOCTYPE/)
    expect(() => parseXml('<x>&lol;</x>')).toThrow(/entity/)
    expect(() => parseXml('<x>a & b</x>')).toThrow(/ampersand/)
    expect(() => parseXml('<x a="&#xZZ;"/>')).toThrow(XmlLiteError)
    expect(() => parseXml('<x/><?php echo 1 ?>')).toThrow(/processing/)
  })
  it('refuses malformed documents', () => {
    for (const bad of ['', '<a>', '<a></b>', '<a/><b/>', 'text<a/>', '<a b=c/>', '<a b="1" b="2"/>', '<a b="<"/>', '<a><!-- x </a>']) {
      expect(() => parseXml(bad)).toThrow(XmlLiteError)
    }
  })
  it('caps depth, elements and attributes', () => {
    const deep = '<a>'.repeat(100) + '</a>'.repeat(100)
    expect(() => parseXml(deep)).toThrow(/deeply/)
    expect(parseXml('<a>'.repeat(10) + '</a>'.repeat(10)).name).toBe('a')
    expect(() => parseXml(`<r>${'<e/>'.repeat(50)}</r>`, { maxElements: 40 })).toThrow(/too many elements/)
    const attrs = Array.from({ length: 70 }, (_, i) => `a${i}="1"`).join(' ')
    expect(() => parseXml(`<r ${attrs}/>`)).toThrow(/too many attributes/)
    expect(() => parseXml(`<r>${'x'.repeat(100)}</r>`, { maxTextChars: 50 })).toThrow(/too much text/)
  })
  it('is linear on a large flat document', () => {
    const n = 200_000
    const t0 = Date.now()
    const r = parseXml(`<r>${'<e a="1">t</e>'.repeat(n)}</r>`, { maxElements: n + 10 })
    expect(r.children.length).toBe(n)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
  it('a hostile attribute name or attribute value never becomes a prototype key', () => {
    const r = parseXml('<r __proto__="x" constructor="y"/>')
    expect(Object.getPrototypeOf(r.attrs)).toBeNull()
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })
})
