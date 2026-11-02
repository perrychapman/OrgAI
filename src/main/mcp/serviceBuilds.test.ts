import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpLibraryEntry, McpServerSpec } from '@shared/types'
import { ProjectStore } from '../store/projects'
import { McpLibraryStore } from '../store/mcpLibrary'
import { SecretStore } from '../store/secrets'
import { sweepScratchDirs } from '../quick/scratch'
import { McpService } from './service'
import { BUILD_MAX_FILES, digestBuildDir, stageBuild } from './builds'

const cipher = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`enc:${s}`), decryptString: (b: Buffer) => b.toString().slice(4) }

let dir: string
let data: string
let ws: string
let library: McpLibraryStore
let svc: McpService

const item = (over: Partial<McpServerSpec> = {}) => ({
  id: 'mcpl_b1',
  name: 'built',
  transport: 'stdio' as const,
  command: 'node',
  args: [join(ws, 'server.js')],
  enabled: true,
  source: 'agent' as const,
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})
const apply = (upsert: ReturnType<typeof item>[], buildWorkspace?: string): void =>
  svc.applyLibraryProposal({ scope: 'library', upsert, rationale: 'r' }, buildWorkspace === undefined ? {} : { buildWorkspace })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-builds-'))
  data = join(dir, 'data')
  ws = join(data, 'quick', 'quick_abc123')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'server.js'), 'console.log(1)')
  mkdirSync(join(ws, 'lib'))
  writeFileSync(join(ws, 'lib', 'a.js'), 'a')
  library = new McpLibraryStore(data)
  svc = new McpService({ projects: new ProjectStore(data), secrets: new SecretStore(data, cipher), library, dataDir: data })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('built MCP servers (M5)', () => {
  it('copies the workspace, rewrites paths and sets a digest; skips .git, node_modules, .claude', () => {
    for (const d of ['.git', 'node_modules', '.claude']) {
      mkdirSync(join(ws, d))
      writeFileSync(join(ws, d, 'x'), 'x')
    }
    apply([item({ args: [join(ws, 'server.js'), '--flag', 'plain'] })], ws)
    const e = library.get('mcpl_b1') as McpLibraryEntry
    const copy = join(data, 'mcp-builds', 'mcpl_b1')
    expect(e.args).toEqual([join(copy, 'server.js'), '--flag', 'plain'])
    expect(readFileSync(join(copy, 'lib', 'a.js'), 'utf8')).toBe('a')
    for (const d of ['.git', 'node_modules', '.claude']) expect(existsSync(join(copy, d))).toBe(false)
    expect(e.buildDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(e.buildDigest).toBe(digestBuildDir(copy))
    // later edits to the workspace do not reach the copy
    writeFileSync(join(ws, 'server.js'), 'evil')
    expect(readFileSync(join(copy, 'server.js'), 'utf8')).toBe('console.log(1)')
    // a second approval replaces the build
    apply([item()], ws)
    expect(readFileSync(join(copy, 'server.js'), 'utf8')).toBe('evil')
  })

  it('does not copy links', () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 's')
    symlinkSync(outside, join(ws, 'link'), 'junction')
    try {
      symlinkSync(join(outside, 'secret.txt'), join(ws, 'f.txt'), 'file')
    } catch {
      /* no symlink privilege on this machine: the junction covers the walk */
    }
    apply([item()], ws)
    const copy = join(data, 'mcp-builds', 'mcpl_b1')
    expect(existsSync(join(copy, 'link'))).toBe(false)
    expect(existsSync(join(copy, 'f.txt'))).toBe(false)
    expect(existsSync(join(copy, 'server.js'))).toBe(true)
  })

  it('refuses beyond the file cap and saves nothing', () => {
    for (let i = 0; i <= BUILD_MAX_FILES; i++) writeFileSync(join(ws, `f${i}.txt`), '')
    expect(() => apply([item()], ws)).toThrow(/more than/)
    expect(library.list()).toEqual([])
    expect(existsSync(join(data, 'mcp-builds', 'mcpl_b1'))).toBe(false)
  })

  it('leaves a command outside the workspace alone, and a forged workspace is refused', () => {
    apply([item({ args: ['-y', 'pkg@1.2.3'], command: 'npx' })], ws)
    expect(library.get('mcpl_b1')?.args).toEqual(['-y', 'pkg@1.2.3'])
    expect(library.get('mcpl_b1')?.buildDigest).toBeUndefined()
    expect(existsSync(join(data, 'mcp-builds', 'mcpl_b1'))).toBe(false)
    const forged = join(dir, 'elsewhere')
    mkdirSync(forged)
    writeFileSync(join(forged, 'server.js'), 'x')
    expect(() => apply([item({ id: 'mcpl_b2', name: 'x', args: [join(forged, 'server.js')] })], forged)).toThrow(/not one OrgAI created/)
    expect(library.get('mcpl_b2')).toBeUndefined()
  })

  it('removal deletes the build dir, through the library and through a proposal', () => {
    apply([item()], ws)
    const copy = join(data, 'mcp-builds', 'mcpl_b1')
    expect(existsSync(copy)).toBe(true)
    svc.libraryRemove({ libraryId: 'mcpl_b1' })
    expect(existsSync(copy)).toBe(false)
    apply([item()], ws)
    svc.applyLibraryProposal({ scope: 'library', upsert: [], remove: ['mcpl_b1'], rationale: 'r' })
    expect(existsSync(copy)).toBe(false)
  })

  it('drops a renderer-sent buildDigest and keeps the stored one while the target is unchanged', () => {
    svc.libraryUpsert({ id: 'mcpl_x', name: 'x', transport: 'stdio', command: 'node', args: ['a.js'], source: 'user', addedAt: 'a', buildDigest: 'f'.repeat(64) } as McpLibraryEntry)
    expect(library.get('mcpl_x')?.buildDigest).toBeUndefined()
    apply([item()], ws)
    const digest = library.get('mcpl_b1')?.buildDigest
    expect(digest).toBeTruthy()
    svc.libraryUpsert({ ...(library.get('mcpl_b1') as McpLibraryEntry), buildDigest: '0'.repeat(64) })
    expect(library.get('mcpl_b1')?.buildDigest).toBe(digest)
    svc.libraryUpsert({ ...(library.get('mcpl_b1') as McpLibraryEntry), args: ['other.js'] })
    expect(library.get('mcpl_b1')?.buildDigest).toBeUndefined()
  })

  it('the scratch sweep leaves mcp-builds alone, and staging validates the id', () => {
    apply([item()], ws)
    expect(sweepScratchDirs(data, [])).toBe(1)
    expect(existsSync(join(data, 'mcp-builds', 'mcpl_b1', 'server.js'))).toBe(true)
    expect(() => stageBuild(data, '../evil', ws)).toThrow(/not valid/)
  })
})
