import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/types'

vi.mock('electron', () => {
  throw new Error('electron must not be imported by the host')
})
vi.mock('../log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, logPath: () => '/logs/main.log', logsDir: () => '/logs' }))

const { applyAppSettingsPayload } = await import('./bootstrap')
const { HostDispatcher } = await import('./dispatcher')
const { SettingsStore } = await import('../store/settings')
const { createAppReference } = await import('../reference/appReference')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-selfk-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('applyAppSettingsPayload (an approved appSettings card behaves like settings:set)', () => {
  it('saves the changes, keeps main-owned fields and notifies listeners once', () => {
    const store = new SettingsStore(dir)
    const before = store.get()
    const seen: unknown[] = []
    store.onChange((s) => seen.push(s))
    applyAppSettingsPayload(store, { rationale: 'because', changes: [{ field: 'appearance.theme', from: before.appearance.theme, to: 'light' }] as never })
    const after = store.get()
    expect(after.appearance.theme).toBe('light')
    expect(after.defaultConnection).toBe(before.defaultConnection)
    expect(after.proxies).toEqual(before.proxies)
    expect(seen).toHaveLength(1)
    // persisted
    expect(new SettingsStore(dir).get().appearance.theme).toBe('light')
  })
  it('clears an optional field (null = no spend cap) like settings:set does (review M1)', () => {
    const store = new SettingsStore(dir)
    store.set({ ...store.get(), defaultMaxBudgetUsd: 5 })
    expect(store.get().defaultMaxBudgetUsd).toBe(5)
    applyAppSettingsPayload(store, { rationale: 'no cap', changes: [{ field: 'defaultMaxBudgetUsd', from: 5, to: null, label: 'cap' }] })
    expect(store.get().defaultMaxBudgetUsd).toBeUndefined()
    expect(new SettingsStore(dir).get().defaultMaxBudgetUsd).toBeUndefined()
  })
  it('refuses a bad value with a readable error and saves nothing', () => {
    const store = new SettingsStore(dir)
    const before = store.get().appearance.theme
    expect(() => applyAppSettingsPayload(store, { rationale: 'x', changes: [{ field: 'appearance.theme', from: before, to: 'neon' }] as never })).toThrow()
    expect(store.get().appearance.theme).toBe(before)
  })
})

describe('app:reference through the dispatcher', () => {
  const DESKTOP = { surface: 'desktop' as const }
  const base = (reference?: never) =>
    ({ projects: {}, runs: {}, setup: {}, maintenance: {}, settings: { get: () => ({}), dataDir: dir }, connections: {}, mcp: {}, adapterIds: [], harnessProject: () => ({}), importer: {}, skills: {}, skillEvaluation: {}, capabilities: {}, quick: {}, templates: {}, ...(reference ? { reference } : {}) }) as never

  it('answers a search and allows status (the user may see the secret-free snapshot)', async () => {
    const reference = createAppReference({
      status: { appVersion: '1.0.0', platform: 'linux', dataDir: '/d', mock: false, settings: () => ({}) as never, connections: () => [], projectCount: () => 0, mcpLibraryCount: () => 0, skillLibraryCount: () => 0 }
    })
    const d = new HostDispatcher(base(reference as never))
    const found = (await d.invoke(IPC.appReference, [{ action: 'search', query: 'dashboard' }], DESKTOP)) as { text: string; hits: unknown[] }
    expect(found.hits.length).toBeGreaterThan(0)
    const st = (await d.invoke(IPC.appReference, [{ action: 'status' }], DESKTOP)) as { text: string }
    expect(st.text).toContain('1.0.0')
  })
  it('rejects a malformed query and says so when no service is wired', async () => {
    const d = new HostDispatcher(base())
    expect(() => d.invoke(IPC.appReference, [{ action: 'nope' }], DESKTOP)).toThrow(/reference action/)
    expect(((await d.invoke(IPC.appReference, [{ action: 'search', query: 'x' }], DESKTOP)) as { text: string }).text).toContain('not available')
  })
})
