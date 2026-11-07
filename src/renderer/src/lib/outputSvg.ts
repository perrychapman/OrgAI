// The gate for markup Mermaid hands back (docs/design/outputs.md section 4). Mermaid's own sanitizer is the first
// line (securityLevel 'strict'); this is the second: the markup is parsed as XML and refused when it holds anything
// active, so the one place that inserts it (MermaidView) only ever inserts markup that passed. No React, no store.

export type SafeSvg = { ok: true; root: Element } | { ok: false; reason: string }

/** Elements that run code, load other documents or animate attributes. Compared lowercase on the local name. */
const BLOCKED_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'animate', 'set', 'animatetransform', 'animatemotion', 'handler', 'listener'])

/** Drops whitespace and control characters browsers ignore inside a URL scheme ("java\tscript:"). */
function squash(v: string): string {
  let out = ''
  for (const ch of v) {
    const c = ch.codePointAt(0) ?? 0
    const ignored = c <= 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029 || c === 0xfeff
    if (!ignored) out += ch
  }
  return out.toLowerCase()
}

/** A problem in an attribute value or style text, or null. `url(` may only point at a fragment (#id). */
export function activeContentIn(text: string): string | null {
  const s = squash(text)
  if (s.includes('javascript:') || s.includes('vbscript:')) return 'a script address'
  if (s.includes('@import')) return 'a style import'
  if (s.includes('expression(')) return 'a style expression'
  if (s.includes('data:text/html') || s.includes('data:application')) return 'an embedded document'
  const re = /url\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    let rest = s.slice(m.index + 4)
    if (rest.startsWith('"') || rest.startsWith("'")) rest = rest.slice(1)
    if (!rest.startsWith('#')) return 'an address that is not inside the drawing'
  }
  return null
}

function defaultParse(s: string): Document {
  return new DOMParser().parseFromString(s, 'image/svg+xml')
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Attributes that load a resource or submit something; a drawing has no use for them. */
const BLOCKED_ATTRIBUTES = new Set(['src', 'srcset', 'action', 'formaction', 'data', 'poster'])

/**
 * Checks the SVG text Mermaid produced and returns the checked root element. The caller inserts that tree with
 * `document.importNode` and never as text, so no second parse can read it differently. The parse function is
 * injectable so the checks run in a test without a browser.
 */
export function safeMermaidSvg(svgText: string, parse: (s: string) => Document = defaultParse): SafeSvg {
  let doc: Document
  try {
    doc = parse(svgText)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  const root = doc?.documentElement
  if (!root || (root.localName ?? root.nodeName).toLowerCase() !== 'svg') return { ok: false, reason: 'not a drawing' }
  if (doc.getElementsByTagName('parsererror').length > 0) return { ok: false, reason: 'unreadable' }

  let problem: string | null = null
  const visit = (el: Element): void => {
    if (problem) return
    const name = (el.localName ?? el.nodeName).toLowerCase()
    if (el.namespaceURI !== SVG_NS) {
      problem = `contains <${name}> outside the drawing's namespace`
      return
    }
    if (BLOCKED_ELEMENTS.has(name)) {
      problem = `contains <${name}>`
      return
    }
    const attrs = el.attributes
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i]
      const an = (a.localName ?? a.name).toLowerCase()
      const full = a.name.toLowerCase()
      if (an.startsWith('on') || full.startsWith('on')) {
        problem = `contains the ${an} handler`
        return
      }
      if (BLOCKED_ATTRIBUTES.has(an) || BLOCKED_ATTRIBUTES.has(full)) {
        problem = `contains the ${an} attribute`
        return
      }
      if (an === 'href' || full === 'xlink:href') {
        if (!a.value.trim().startsWith('#')) {
          problem = 'contains an outside link'
          return
        }
      }
      const bad = activeContentIn(a.value)
      if (bad) {
        problem = `contains ${bad}`
        return
      }
    }
    if (name === 'style') {
      const bad = activeContentIn(el.textContent ?? '')
      if (bad) {
        problem = `contains ${bad}`
        return
      }
    }
    for (let c = el.firstChild; c && !problem; c = c.nextSibling) {
      // Comments and processing instructions have no place in a drawing; CDATA only inside <style> (checked above).
      if (c.nodeType === 7 || c.nodeType === 8) problem = 'contains a comment or instruction'
      else if (c.nodeType === 4 && name !== 'style') problem = 'contains raw character data'
      else if (c.nodeType === 1) visit(c as Element)
    }
  }
  // Nodes beside the root (a comment or instruction before or after it) are refused too, except the xml declaration.
  for (let c = doc.firstChild; c && !problem; c = c.nextSibling) {
    if (c.nodeType === 7 && (c as ProcessingInstruction).target?.toLowerCase() === 'xml') continue
    if (c.nodeType === 7 || c.nodeType === 8) problem = 'contains a comment or instruction'
  }
  if (!problem) visit(root)
  if (problem) return { ok: false, reason: problem }
  return { ok: true, root }
}
