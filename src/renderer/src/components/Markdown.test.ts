import { describe, expect, it } from 'vitest'
import { safeUrl, spoofHost } from './Markdown'

describe('safeUrl', () => {
  it('allows http and https', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeUrl('http://example.com')).toBe('http://example.com')
    expect(safeUrl('mailto:a@b.c')).toBe('')
  })
  it('drops every other scheme and relative paths', () => {
    for (const u of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'file:///c:/x', '/etc/passwd', 'vbscript:x', '//evil.test']) {
      expect(safeUrl(u)).toBe('')
    }
  })
})

describe('spoofHost', () => {
  it('is empty when the text names the host', () => {
    expect(spoofHost('https://www.bank.com/x', 'bank.com')).toBe('')
    expect(spoofHost('https://bank.com/x', ['see ', 'https://bank.com'])).toBe('')
  })
  it('returns the real host when the text does not', () => {
    expect(spoofHost('https://evil.test/x', 'bank.com')).toBe('evil.test')
    expect(spoofHost('https://evil.test/x', 'click here')).toBe('evil.test')
    expect(spoofHost('https://al.com/x', 'paypal.com')).toBe('al.com')
    expect(spoofHost('https://bank.com/x', 'bank.com.evil.test')).toBe('bank.com')
    expect(spoofHost('https://bank.com@evil.test/x', 'https://bank.com')).toBe('evil.test')
  })
})
