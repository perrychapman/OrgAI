import { describe, expect, it } from 'vitest'
import { readableMarkdown } from './markdownBlocks'

describe('readable terminal Markdown', () => {
  it('turns prose tables into separated records without losing column labels', () => {
    const text = readableMarkdown('| Protection | What it does |\n|---|---|\n| **Permissions** | Asks before running commands. |\n| Sandbox | Limits writes. |')
    expect(text).toBe('### Protection / What it does\n\n**Protection:** **Permissions**\n**What it does:** Asks before running commands.\n\n**Protection:** Sandbox\n**What it does:** Limits writes.\n')
    expect(text).not.toContain('|')
  })

  it('accepts alignment markers, optional edge pipes, escaped pipes and code pipes', () => {
    const text = readableMarkdown('Name | Value\n:--- | ---:\ncommand | `a|b`\nother | a\\|b')
    expect(text).toContain('**Value:** `a|b`')
    expect(text).toContain('**Value:** a|b')
  })

  it('keeps malformed tables and ordinary pipe text literal', () => {
    for (const text of ['a | b\n-- | --\nx | y', 'a | b\n---\nx | y', 'run a | b']) expect(readableMarkdown(text)).toBe(text)
  })

  it('moves full link destinations to deduplicated references', () => {
    const text = readableMarkdown('Read [permissions](/Users/me/MyProject/docs/permissions.md:49) and [again](/Users/me/MyProject/docs/permissions.md:49).\n[Spaced path](</Users/me/My Project/a.md>)\n[Docs](https://example.org/a_(b))')
    expect(text).toContain('Read permissions [1] and again [1].')
    expect(text).toContain('Spaced path [2]')
    expect(text).toContain('Docs [3]')
    expect(text).toContain('[1] /Users/me/MyProject/docs/permissions.md:49')
    expect(text).toContain('[2] /Users/me/My Project/a.md')
    expect(text).toContain('[3] https://example.org/a_(b)')
  })

  it('does not interpret code blocks, inline code or incomplete links', () => {
    for (const fence of ['```', '~~~~']) {
      const text = `${fence}\n| a | b |\n|---|---|\n| c | d |\n[label](/path)\n${fence}`
      expect(readableMarkdown(text)).toBe(text)
    }
    for (const text of ['`[label](/path)`', '[unfinished](', '    [code](/path)']) expect(readableMarkdown(text)).toBe(text)
  })
})
