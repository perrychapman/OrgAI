import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ProjectProfile } from '@shared/types'
import { profileRepo, renderProfile } from './profile'

let root: string

function put(rel: string, content = ''): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-profile-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('profileRepo', () => {
  it('returns an empty, non-existent profile for a missing directory', async () => {
    const p = await profileRepo(join(root, 'does-not-exist'))
    expect(p.exists).toBe(false)
    expect(p.isEmpty).toBe(true)
    expect(p.hasGit).toBe(false)
    expect(p.fileCount).toBe(0)
    expect(p.tree).toBe('')
    expect(p.keyFiles).toEqual([])
    expect(typeof p.scannedAt).toBe('string')
  })

  it('lists agent definition locations that the tree leaves out', async () => {
    put('src/a.ts', 'x')
    expect((await profileRepo(root)).agentDefinitions).toBeUndefined()
    put('.claude/agents/a.md', '---\nname: a\n---\nA')
    put('.orgai/org.json', '{}')
    put('.codex/agents/b.toml', 'name = "b"')
    const p = await profileRepo(root)
    expect(p.agentDefinitions).toEqual(['.orgai/org.json', '.claude/agents', '.codex/agents'])
    expect(renderProfile(p)).toContain('Agent definitions present: .orgai/org.json, .claude/agents, .codex/agents.')
  })

  it('treats a file path like a missing directory', async () => {
    put('file.txt', 'x')
    const p = await profileRepo(join(root, 'file.txt'))
    expect(p.exists).toBe(false)
  })

  it('reports an existing empty directory as empty', async () => {
    const p = await profileRepo(root)
    expect(p.exists).toBe(true)
    expect(p.isEmpty).toBe(true)
    expect(p.fileCount).toBe(0)
    expect(p.hasGit).toBe(false)
    expect(p.gitLog).toEqual([])
  })

  it('ignores Finder and Explorer litter when judging emptiness', async () => {
    put('.DS_Store', 'x')
    put('Thumbs.db', 'x')
    const p = await profileRepo(root)
    expect(p.isEmpty).toBe(true)
    expect(p.fileCount).toBe(0)
  })

  it('builds an indented, sorted tree and counts languages', async () => {
    put('package.json', '{"name":"demo"}')
    put('README.md', '# Demo')
    put('src/a.ts', '')
    put('src/b.ts', '')
    put('src/lib/c.js', '')
    const p = await profileRepo(root)
    expect(p.exists).toBe(true)
    expect(p.isEmpty).toBe(false)
    expect(p.fileCount).toBe(5)
    expect(p.tree.split('\n')).toEqual(['package.json', 'README.md', 'src/', '  a.ts', '  b.ts', '  lib/', '    c.js'])
    expect(p.languages[0]).toEqual({ ext: '.ts', files: 2 })
    expect(p.languages).toContainEqual({ ext: '.js', files: 1 })
    expect(p.languages).toContainEqual({ ext: '.json', files: 1 })
  })

  it('skips ignored and hidden directories but keeps .github', async () => {
    put('index.js', '')
    put('node_modules/dep/index.js', '')
    put('dist/bundle.js', '')
    put('.orgai/ARCHITECTURE.md', '')
    put('.hidden/secret.txt', '')
    put('.github/workflows/ci.yml', 'on: push')
    const p = await profileRepo(root)
    expect(p.tree).not.toMatch(/node_modules|dist|\.orgai|\.hidden/)
    expect(p.tree).toContain('.github/')
    expect(p.fileCount).toBe(2)
    expect(p.keyFiles.map((f) => f.path)).toContain('.github/workflows/ci.yml')
  })

  it('collects key files by basename case-insensitively, with repo-relative paths', async () => {
    put('Readme.md', 'hello')
    put('packages/app/package.json', '{"name":"app"}')
    put('src/notes.md', 'not a key file')
    const p = await profileRepo(root)
    const paths = p.keyFiles.map((f) => f.path).sort()
    expect(paths).toEqual(['packages/app/package.json', 'Readme.md'].sort())
    expect(p.keyFiles.find((f) => f.path === 'Readme.md')?.content).toBe('hello')
  })

  it('truncates long key files', async () => {
    put('README.md', 'x'.repeat(10_000))
    const p = await profileRepo(root)
    const content = p.keyFiles[0].content
    expect(content.startsWith('x'.repeat(6000))).toBe(true)
    expect(content).toMatch(/… \(truncated\)$/)
    expect(content.length).toBeLessThan(6100)
  })

  it('caps the number of key files', async () => {
    for (let i = 0; i < 20; i++) put(`pkg${String(i).padStart(2, '0')}/package.json`, '{}')
    const p = await profileRepo(root)
    expect(p.keyFiles.length).toBe(14)
  })

  it('truncates the tree listing past 400 entries', async () => {
    for (let i = 0; i < 450; i++) put(`f${String(i).padStart(3, '0')}.txt`, '')
    const p = await profileRepo(root)
    const lines = p.tree.split('\n')
    expect(lines.length).toBe(401)
    expect(lines[400]).toBe('… (450 files total, listing truncated)')
    expect(p.fileCount).toBe(450)
  })

  it('stops descending past the maximum depth', async () => {
    put('a/b/c/d/e/f/deep.txt', '')
    const p = await profileRepo(root)
    // Directories down to depth 4 are listed; the walk does not enter e/.
    expect(p.tree).toContain('        e/')
    expect(p.tree).not.toContain('f/')
    expect(p.fileCount).toBe(0)
  })
})

describe('renderProfile', () => {
  const base: ProjectProfile = {
    scannedAt: '2026-01-01T00:00:00.000Z',
    exists: true,
    isEmpty: false,
    hasGit: true,
    fileCount: 3,
    tree: 'package.json\nsrc/\n  index.ts',
    languages: [
      { ext: '.ts', files: 2 },
      { ext: '.json', files: 1 }
    ],
    keyFiles: [{ path: 'package.json', content: '{"name":"demo"}' }],
    gitLog: ['abc123 first commit']
  }

  it('describes a missing directory', () => {
    expect(renderProfile({ ...base, exists: false })).toMatch(/does not exist yet/)
  })

  it('describes an empty directory', () => {
    expect(renderProfile({ ...base, isEmpty: true })).toBe('The working directory exists and is empty.')
  })

  it('renders summary, languages, tree, commits and key files in order', () => {
    const text = renderProfile(base)
    const parts = text.split('\n\n')
    expect(parts[0]).toBe('Files: 3. Git: yes.')
    expect(parts[1]).toBe('Languages by file count: .ts (2), .json (1).')
    expect(parts[2]).toBe('Directory tree:\npackage.json\nsrc/\n  index.ts')
    expect(parts[3]).toBe('Recent commits:\nabc123 first commit')
    expect(parts[4]).toBe('--- package.json ---\n{"name":"demo"}')
  })

  it('omits commits when there are none and says when no language was detected', () => {
    const text = renderProfile({ ...base, hasGit: false, gitLog: [], languages: [], keyFiles: [] })
    expect(text).toContain('Git: no.')
    expect(text).toContain('none detected')
    expect(text).not.toContain('Recent commits')
  })
})
