import { describe, expect, it } from 'vitest'
import { APP_REFERENCE_BUDGET_MIN, APP_REFERENCE_READ_MAX_CHARS } from '../../shared/types'
import type { AppSettings, ConnectionInfo } from '../../shared/types'
import { buildReferenceCorpus, createAppReference, splitMarkdown } from './appReference'
import type { AppReferenceDeps } from './appReference'
import { bundledDocs } from './docs'

const SECRET = 'sk-SECRET-proxy-key-123456'

function statusDeps(): NonNullable<AppReferenceDeps['status']> {
  const settings = { terminalServer: true, terminalAccessLevel: 'full', proxies: [{ id: 'p1', apiKey: SECRET, anthropicBaseUrl: `https://user:${SECRET}@proxy.example.com` }], authorization: `Bearer ${SECRET}` } as unknown as AppSettings
  const conns = [
    { connection: { id: 'anthropic', enabled: true }, status: { state: 'connected', detail: `url https://x:${SECRET}@h` }, isDefault: true },
    { connection: { id: 'p1', name: 'Mine', anthropicBaseUrl: `https://u:${SECRET}@h` }, status: { state: 'error' }, isDefault: false }
  ] as unknown as ConnectionInfo[]
  return { appVersion: '1.2.3', platform: 'win32', dataDir: 'C:\\data', mock: true, settings: () => settings, connections: () => conns, projectCount: () => 4, mcpLibraryCount: () => 2, skillLibraryCount: () => 1, cliShim: () => ({ state: 'installed', path: '', binDir: '' }) }
}

describe('corpus', () => {
  it('bundles the docs and builds sections with the id scheme', () => {
    const docs = bundledDocs()
    expect(Object.keys(docs)).toContain('README')
    expect(Object.keys(docs)).toContain('how-it-works')
    expect(Object.keys(docs).some((k) => k.startsWith('ux-review'))).toBe(false)
    const c = buildReferenceCorpus({ shortcuts: [{ key: 'toggle-sidebar', label: 'Toggle sidebar', keys: 'Ctrl/Cmd+B' }] })
    const ids = new Set(c.map((s) => s.id))
    expect(ids.size).toBe(c.length)
    expect(ids.has('surface:dashboard')).toBe(true)
    expect(ids.has('shortcut:toggle-sidebar')).toBe(true)
    expect(ids.has('channel:app:reference')).toBe(true)
    expect(ids.has('tool:app_reference') || ids.has('tool:list_projects')).toBe(true)
    expect([...ids].some((i) => i.startsWith('command:'))).toBe(true)
    expect([...ids].some((i) => i.startsWith('connector:'))).toBe(true)
    expect([...ids].some((i) => i.startsWith('doc:how-it-works#'))).toBe(true)
  })
  it('splits markdown by heading, ignoring headings in code fences and capping sections', () => {
    const md = ['# T', 'intro', '## A', 'a body', '```', '## not a heading', '```', '## A', 'again', '### B', 'b', `## Big`, 'x'.repeat(7000)].join('\n')
    const s = splitMarkdown('f', md)
    expect(s.map((x) => x.id)).toEqual(['doc:f#t', 'doc:f#a', 'doc:f#a-2', 'doc:f#b', 'doc:f#big'])
    expect(s[1].lines.join('\n')).toContain('## not a heading')
    expect(s[4].lines.join('\n').endsWith('(cut)')).toBe(true)
  })
})

describe('query', () => {
  const ref = createAppReference({ status: statusDeps(), docs: { guide: '# Guide\n\n## Zebra stripes\nThe zebraquartz widget lives here. <<< break >>>\n' } })
  it('search ranks, fences and fits the budget', async () => {
    const r = await ref.query({ action: 'search', query: 'zebraquartz', budget: APP_REFERENCE_BUDGET_MIN }, { status: false })
    expect(r.hits?.[0].id).toBe('doc:guide#zebra-stripes')
    expect(r.hits?.[0].score).toBe(1)
    expect(r.text.length).toBeLessThanOrEqual(APP_REFERENCE_BUDGET_MIN)
    expect(r.text).toContain('<<<')
    expect(r.text).not.toContain('<<< break')
  })
  it('budget holds for broad queries and reports the rest', async () => {
    const r = await ref.query({ action: 'search', query: 'run agent settings project', budget: 600 }, { status: false })
    expect(r.text.length).toBeLessThanOrEqual(600)
    expect(r.text).toMatch(/\d+ more: /)
  })
  it('no match, bad input and unknown ids answer in text', async () => {
    expect((await ref.query({ action: 'search', query: 'qqqxxzzy' }, { status: false })).text).toContain('locate')
    expect((await ref.query({ action: 'search' }, { status: false })).text).toContain('required')
    expect((await ref.query({ action: 'search', query: 'a\u202eb' }, { status: false })).text).toContain('hidden character')
    expect((await ref.query({ action: 'search', query: 'x'.repeat(501) }, { status: false })).text).toContain('longer')
    expect((await ref.query({ action: 'read', id: 'nope:x' }, { status: false })).text).toContain('no reference section')
    expect((await ref.query({ action: 'read' }, { status: false })).text).toContain('required')
  })
  it('read returns a section and caps it', async () => {
    const r = await ref.query({ action: 'read', id: 'doc:guide#zebra-stripes' }, { status: false })
    expect(r.text).toContain('zebraquartz')
    const big = createAppReference({ docs: { g: `# G\n${'word '.repeat(5000)}` } })
    const big2 = await big.query({ action: 'read', id: 'doc:g#g' }, { status: false })
    expect(big2.text.length).toBeLessThanOrEqual(APP_REFERENCE_READ_MAX_CHARS)
  })
  it('locate answers surfaces and settings only', async () => {
    const r = await ref.query({ action: 'locate', query: 'dashboard' }, { status: false })
    expect(r.hits?.every((h) => h.kind === 'surface' || h.kind === 'setting')).toBe(true)
    expect(r.text).toContain('Dashboard')
  })
  it('status is refused unless allowed, and never leaks secrets', async () => {
    expect((await ref.query({ action: 'status' }, { status: false })).text).toBe('Status is not available in this run.')
    const r = await ref.query({ action: 'status' }, { status: true })
    expect(r.text).toContain('1.2.3')
    expect(r.text).toContain('connection anthropic')
    expect(r.text).toContain('default')
    expect(r.text).toContain('level full')
    expect(r.text).not.toContain(SECRET)
    expect(r.text).not.toContain('proxy.example.com')
    expect(r.text).not.toContain('http')
  })
  it('measures a search over the full corpus', async () => {
    const full = createAppReference()
    await full.query({ action: 'search', query: 'warm up' }, { status: false })
    const t = performance.now()
    for (let i = 0; i < 10; i++) await full.query({ action: 'search', query: 'how do I change the theme permissions mcp' }, { status: false })
    const per = (performance.now() - t) / 10
    console.log(`app reference search: ${per.toFixed(1)} ms per query over the full corpus`)
    expect(per).toBeLessThan(2000)
  })
})
