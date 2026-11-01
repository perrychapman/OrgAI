import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * ORGAI_MOCK=1 only: fixture files under `<data>/mock-home` so local discovery has something to find without reading
 * the real profile. Idempotent: only files that are missing are written. Never throws.
 */

const SKILL_MD = `---
name: code-review
description: Use when reviewing a change for bugs, style and missing tests.
---

# Code review

Read the diff, check edge cases and tests, then list findings by severity.
`

const CLAUDE_JSON = {
  mcpServers: { 'mock-fs': { command: 'npx', args: ['-y', 'mock-fs-server@1.0.0'], env: { MOCK_FS_TOKEN: '' } } }
}
const CURSOR_JSON = { mcpServers: { 'mock-docs': { url: 'https://mock-docs.example.com/mcp' } } }

export function seedMockHome(dir: string): void {
  try {
    const files: [string, string][] = [
      [join(dir, '.claude', 'skills', 'code-review', 'SKILL.md'), SKILL_MD],
      [join(dir, '.claude.json'), `${JSON.stringify(CLAUDE_JSON, null, 2)}\n`],
      [join(dir, '.cursor', 'mcp.json'), `${JSON.stringify(CURSOR_JSON, null, 2)}\n`]
    ]
    for (const [path, text] of files) {
      if (existsSync(path)) continue
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
    }
  } catch (e) {
    console.warn(`[capabilities] could not seed the mock home: ${(e as Error).message}`)
  }
}
