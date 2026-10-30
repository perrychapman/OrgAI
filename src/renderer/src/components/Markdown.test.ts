import { describe, expect, it } from 'vitest'
import { safeMarkdownUrl } from './Markdown'

describe('safeMarkdownUrl', () => {
  it('allows only absolute http(s) links without credentials', () => {
    expect(safeMarkdownUrl('https://example.com/docs')).toBe('https://example.com/docs')
    expect(safeMarkdownUrl('http://localhost:3000/path')).toBe('http://localhost:3000/path')
    for (const url of ['docs/readme.md', 'file:///tmp/a', 'javascript:alert(1)', 'mailto:user@example.com', 'https://user:pass@example.com/']) {
      expect(safeMarkdownUrl(url), url).toBe('')
    }
  })
})
