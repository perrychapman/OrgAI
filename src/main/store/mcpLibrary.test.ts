import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLibraryEntry } from '@shared/types'
import { McpLibraryStore } from './mcpLibrary'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-mcplib-store-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const entry = (id: string, over: Partial<McpLibraryEntry> = {}): McpLibraryEntry => ({
  id,
  name: `srv-${id}`,
  transport: 'http',
  url: 'https://x.test/mcp',
  source: 'user',
  addedAt: '2026-01-01T00:00:00.000Z',
  ...over
})

describe('McpLibraryStore', () => {
  it('starts empty, saves new entries in order and replaces by id', () => {
    const s = new McpLibraryStore(dir)
    expect(s.list()).toEqual([])
    s.save(entry('a'))
    s.save(entry('b'))
    s.save(entry('a', { url: 'https://y.test/mcp' }))
    expect(s.list().map((e) => [e.id, e.url])).toEqual([['a', 'https://y.test/mcp'], ['b', 'https://x.test/mcp']])
  })

  it('persists across instances and hands out copies', () => {
    new McpLibraryStore(dir).save(entry('a', { oauth: { clientId: 'c' } }))
    const again = new McpLibraryStore(dir)
    expect(again.get('a')?.oauth?.clientId).toBe('c')
    again.get('a')!.name = 'mutated'
    expect(again.get('a')?.name).toBe('srv-a')
    expect(again.get('missing')).toBeUndefined()
  })

  it('removes entries and reports whether anything was removed', () => {
    const s = new McpLibraryStore(dir)
    s.save(entry('a'))
    expect(s.remove('a')).toBe(true)
    expect(s.remove('a')).toBe(false)
    expect(new McpLibraryStore(dir).list()).toEqual([])
  })

  it('starts empty on a corrupt file and drops malformed entries', () => {
    writeFileSync(join(dir, 'mcp-library.json'), '{oops')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(new McpLibraryStore(dir).list()).toEqual([])
    writeFileSync(join(dir, 'mcp-library.json'), JSON.stringify({ entries: [entry('ok'), { id: 5 }, null] }))
    expect(new McpLibraryStore(dir).list().map((e) => e.id)).toEqual(['ok'])
  })
})
