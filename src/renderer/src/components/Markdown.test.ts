import { describe, expect, it } from 'vitest'
import { safeUrl } from './Markdown'

describe('safeUrl', () => {
  it('allows http, https and mailto', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeUrl('http://example.com')).toBe('http://example.com')
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c')
  })
  it('drops every other scheme and relative paths', () => {
    for (const u of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'file:///c:/x', '/etc/passwd', 'vbscript:x', '//evil.test']) {
      expect(safeUrl(u)).toBe('')
    }
  })
})
