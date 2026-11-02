import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverLocalMcp } from './localMcp'
import { discoverLocalSkills } from './localSkills'
import { seedMockHome } from './mockHome'
import type { LocalContext } from './types'

let root: string
let home: string
let ctx: LocalContext

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orgai-mockhome-')))
  home = join(root, 'mock-home')
  const proj = join(root, 'proj')
  mkdirSync(proj)
  ctx = { projectPath: proj, homeDir: home, env: {}, platform: process.platform }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('seedMockHome', () => {
  it('creates fixtures that local discovery finds', () => {
    seedMockHome(home)
    const skills = discoverLocalSkills(ctx)
    const skill = skills.candidates.find((c) => c.item.name === 'code-review')
    expect(skill?.item.source).toBe('claude-skills')
    expect(skill?.item.blockedReason).toBeUndefined()

    const mcp = discoverLocalMcp(ctx)
    const fs = mcp.candidates.find((c) => c.item.name === 'mock-fs')
    expect(fs?.item.version).toBe('1.0.0')
    expect(fs?.item.needsSecrets).toEqual(['MOCK_FS_TOKEN'])
    expect(fs?.item.blockedReason).toBeUndefined()
    const docs = mcp.candidates.find((c) => c.item.name === 'mock-docs')
    expect(docs?.item.source).toBe('cursor-mcp')
  })

  it('is idempotent and never overwrites a user edit', () => {
    seedMockHome(home)
    const file = join(home, '.claude.json')
    const before = statSync(file).mtimeMs
    seedMockHome(home)
    expect(statSync(file).mtimeMs).toBe(before)
    writeFileSync(file, '{"mcpServers":{}}')
    seedMockHome(home)
    expect(readFileSync(file, 'utf8')).toBe('{"mcpServers":{}}')
  })

  it('does not throw when the target cannot be created', () => {
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x')
    expect(() => seedMockHome(join(blocker, 'sub'))).not.toThrow()
  })
})
