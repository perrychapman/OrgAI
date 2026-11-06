import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import { MaintenanceService, stripArchitectureBlock } from './maintenance'
import { ARCHITECTURE_PATH, CLAUDE_MD_MARKER } from './setup/service'
import type { ProjectStore } from './store/projects'

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

describe('uninstallRepo for an engagement', () => {
  it('removes nothing and never touches the folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orgai-maint-'))
    try {
      mkdirSync(join(root, '.orgai'))
      writeFileSync(join(root, '.orgai', 'ENGAGEMENT.md'), '# the client\'s own file', 'utf8')
      writeFileSync(join(root, 'CLAUDE.md'), withBlock('', 'Client'), 'utf8')
      const saved: Project[] = []
      const project = { id: 'p1', name: 'Client', path: root, kind: 'engagement', roles: [], setup: { kind: 'new', state: 'complete', architecturePath: 'x' } } as unknown as Project
      const store = { get: () => project, save: (p: Project) => (saved.push(p), p) } as unknown as ProjectStore
      const svc = new MaintenanceService(store)
      expect(await svc.uninstallRepo('p1')).toEqual({ ok: true, message: 'Nothing to remove.' })
      expect(existsSync(join(root, '.orgai', 'ENGAGEMENT.md'))).toBe(true)
      expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true)
      expect(saved).toEqual([])
      // Not a git repo: nothing to list or act on.
      expect(await svc.listWorktrees('p1')).toEqual([])
      await expect(svc.discardWorktree('p1', 'worktree-agent-x')).rejects.toThrow(/not a pending report branch/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
