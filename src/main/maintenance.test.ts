import { describe, expect, it } from 'vitest'
import { stripArchitectureBlock } from './maintenance'
import { ARCHITECTURE_PATH, CLAUDE_MD_MARKER } from './setup/service'

/** Mirrors writeArchitecture in setup/service.ts, which is not exported. */
function withBlock(existing: string, projectName = 'Demo'): string {
  const block =
    `${CLAUDE_MD_MARKER}\n## Architecture and conventions\n\n` +
    `Read \`${ARCHITECTURE_PATH}\` before changing code. It records the agreed stack, module layout, conventions and commands for this project. Keep it current when they change.\n`
  return existing.trim() ? `${existing.trimEnd()}\n\n${block}` : `# ${projectName}\n\n${block}`
}

describe('stripArchitectureBlock', () => {
  it('returns the input unchanged without a marker', () => {
    const text = '# Demo\n\nNo OrgAI here.\n\n## Architecture and conventions\n\nHand written.\n'
    expect(stripArchitectureBlock(text)).toBe(text)
    expect(stripArchitectureBlock('')).toBe('')
  })

  it('restores an existing CLAUDE.md after the block was appended', () => {
    const original = '# Demo\n\nUse pnpm.\n\n- Keep tests green.\n'
    const written = withBlock(original)
    expect(written).toContain(CLAUDE_MD_MARKER)
    const stripped = stripArchitectureBlock(written)
    expect(stripped).toBe(original)
    expect(stripped).not.toContain('orgai')
  })

  it('leaves only the title when OrgAI created the file', () => {
    const stripped = stripArchitectureBlock(withBlock('', 'My App'))
    expect(stripped.trim()).toBe('# My App')
  })

  it('keeps content that was added after the block', () => {
    const written = `${withBlock('# Demo\n\nIntro.\n')}\n## Later section\n\nAdded by hand.\n`
    const stripped = stripArchitectureBlock(written)
    expect(stripped).toBe('# Demo\n\nIntro.\n\n## Later section\n\nAdded by hand.\n')
  })

  it('drops trailing blank lines the original had before the block', () => {
    const written = withBlock('# Demo\n\nIntro.\n\n\n\n')
    expect(stripArchitectureBlock(written)).toBe('# Demo\n\nIntro.\n')
  })
})
