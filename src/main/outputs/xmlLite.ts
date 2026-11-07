/**
 * A small linear, non-validating XML reader for untrusted Office parts (pptx preview). One pass over the text, no
 * recursion (an explicit stack), nothing fetched, nothing evaluated.
 *
 * Refused (throws XmlLiteError): any `<!DOCTYPE` / `<!ENTITY` / other `<!` declaration (only comments and CDATA pass),
 * processing instructions other than a leading `<?xml ...?>`, any entity other than the five predefined ones and numeric
 * character references (`&foo;`), a stray `<` in an attribute value, duplicate attributes, mismatched tags, text or
 * elements outside one root, and anything past the caps below (depth, elements, attributes per element, attributes in
 * total, text bytes). Element names are stored without their prefix (`a:t` -> `t`, `prefix` 'a'); attribute names keep
 * their prefix (`r:embed`). Namespaces are not resolved: callers match local names and must treat the result as hostile.
 */

export interface XmlEl {
  /** Local name (prefix dropped). */
  name: string
  prefix: string
  attrs: Record<string, string>
  children: XmlEl[]
  /** This element's own character data (CDATA included), concatenated in order; child text is not included. */
  text: string
}

export interface XmlLimits {
  maxDepth: number
  maxElements: number
  maxAttrsPerElement: number
  maxAttrsTotal: number
  maxTextChars: number
}

export const XML_DEFAULT_LIMITS: XmlLimits = {
  maxDepth: 64,
  maxElements: 400_000,
  maxAttrsPerElement: 64,
  maxAttrsTotal: 1_000_000,
  maxTextChars: 16 * 1024 * 1024
}

export class XmlLiteError extends Error {}

const NAME_START = /[A-Za-z_:]/
const NAME_CHAR = /[A-Za-z0-9_:.\-]/

function fail(msg: string): never {
  throw new XmlLiteError(msg)
}

/** Decode the five predefined entities and numeric references; anything else throws. */
export function decodeXmlText(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#?[A-Za-z0-9]{1,10});|&/g, (_m, e: string | undefined) => {
    if (e === undefined) return fail('The XML has a stray ampersand.')
    switch (e) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
    }
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X'
      const digits = hex ? e.slice(2) : e.slice(1)
      if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) fail('The XML has a bad character reference.')
      const cp = parseInt(digits, hex ? 16 : 10)
      if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return '�'
      return String.fromCodePoint(cp)
    }
    return fail('The XML uses an entity that is not predefined.')
  })
}

/** Parse one XML document into an element tree. */
export function parseXml(input: string, limits: Partial<XmlLimits> = {}): XmlEl {
  const L = { ...XML_DEFAULT_LIMITS, ...limits }
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const n = text.length
  const stack: XmlEl[] = []
  let root: XmlEl | null = null
  let elements = 0
  let attrsTotal = 0
  let textChars = 0
  let i = 0
  let first = true

  const addText = (s: string): void => {
    if (!s) return
    const top = stack[stack.length - 1]
    if (!top) {
      if (s.trim()) fail('The XML has text outside its root element.')
      return
    }
    textChars += s.length
    if (textChars > L.maxTextChars) fail('The XML has too much text.')
    top.text += s
  }

  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      addText(decodeXmlText(text.slice(i)))
      break
    }
    if (lt > i) addText(decodeXmlText(text.slice(i, lt)))
    i = lt
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4)
      if (e < 0) fail('The XML has an unclosed comment.')
      i = e + 3
      first = false
      continue
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9)
      if (e < 0) fail('The XML has an unclosed CDATA section.')
      if (!stack.length) fail('The XML has text outside its root element.')
      const raw = text.slice(i + 9, e)
      textChars += raw.length
      if (textChars > L.maxTextChars) fail('The XML has too much text.')
      stack[stack.length - 1].text += raw
      i = e + 3
      first = false
      continue
    }
    if (text.startsWith('<!', i)) fail('The XML has a DOCTYPE or ENTITY declaration, which is not allowed.')
    if (text.startsWith('<?', i)) {
      const e = text.indexOf('?>', i + 2)
      if (e < 0 || !first || !/^xml[ \t\r\n]/.test(text.slice(i + 2, e + 1))) fail('The XML has a processing instruction, which is not allowed.')
      i = e + 2
      first = false
      continue
    }
    first = false
    if (text[i + 1] === '/') {
      let j = i + 2
      while (j < n && NAME_CHAR.test(text[j])) j++
      const full = text.slice(i + 2, j)
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] !== '>' || !full) fail('The XML has a malformed closing tag.')
      const top = stack.pop()
      if (!top || (top.prefix ? `${top.prefix}:${top.name}` : top.name) !== full) fail('The XML has a closing tag that does not match.')
      i = j + 1
      continue
    }
    // start tag
    let j = i + 1
    if (!NAME_START.test(text[j] ?? '')) fail('The XML has a malformed tag.')
    while (j < n && NAME_CHAR.test(text[j])) j++
    const full = text.slice(i + 1, j)
    const colon = full.indexOf(':')
    const el: XmlEl = { name: colon < 0 ? full : full.slice(colon + 1), prefix: colon < 0 ? '' : full.slice(0, colon), attrs: Object.create(null) as Record<string, string>, children: [], text: '' }
    if (++elements > L.maxElements) fail('The XML has too many elements.')
    let selfClose = false
    let nAttrs = 0
    for (;;) {
      const hadSpace = j < n && /\s/.test(text[j])
      while (j < n && /\s/.test(text[j])) j++
      if (j >= n) fail('The XML ends inside a tag.')
      if (text[j] === '>') {
        j++
        break
      }
      if (text[j] === '/') {
        if (text[j + 1] !== '>') fail('The XML has a malformed tag.')
        selfClose = true
        j += 2
        break
      }
      if (!hadSpace) fail('The XML has attributes with no space between them.')
      const a0 = j
      if (!NAME_START.test(text[j])) fail('The XML has a malformed attribute.')
      while (j < n && NAME_CHAR.test(text[j])) j++
      const an = text.slice(a0, j)
      while (j < n && /\s/.test(text[j])) j++
      if (text[j] !== '=') fail('The XML has an attribute with no value.')
      j++
      while (j < n && /\s/.test(text[j])) j++
      const q = text[j]
      if (q !== '"' && q !== "'") fail('The XML has an unquoted attribute value.')
      const e = text.indexOf(q, j + 1)
      if (e < 0) fail('The XML has an unclosed attribute value.')
      const raw = text.slice(j + 1, e)
      if (raw.indexOf('<') >= 0) fail('The XML has "<" inside an attribute value.')
      if (++nAttrs > L.maxAttrsPerElement) fail('The XML has an element with too many attributes.')
      if (++attrsTotal > L.maxAttrsTotal) fail('The XML has too many attributes.')
      if (an in el.attrs) fail('The XML repeats an attribute.')
      el.attrs[an] = decodeXmlText(raw)
      j = e + 1
    }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(el)
    else if (root) fail('The XML has more than one root element.')
    else root = el
    if (!selfClose) {
      stack.push(el)
      if (stack.length > L.maxDepth) fail('The XML is nested too deeply.')
    }
    i = j
  }
  if (stack.length) fail('The XML has a tag that is never closed.')
  if (!root) fail('The XML has no root element.')
  return root
}

/** First direct child with this local name. */
export function child(el: XmlEl | undefined, name: string): XmlEl | undefined {
  if (!el) return undefined
  for (const c of el.children) if (c.name === name) return c
  return undefined
}

/** Direct children with this local name. */
export function childrenNamed(el: XmlEl | undefined, name: string): XmlEl[] {
  return el ? el.children.filter((c) => c.name === name) : []
}

/** Follow a path of local names. */
export function descend(el: XmlEl | undefined, ...names: string[]): XmlEl | undefined {
  let cur = el
  for (const n of names) {
    cur = child(cur, n)
    if (!cur) return undefined
  }
  return cur
}
