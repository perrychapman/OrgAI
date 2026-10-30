import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_SETTINGS_PANES,
  APP_SETTINGS_SECTIONS,
  appPaneForSection,
  requestAppSettingsSection,
  takeAppSettingsSection
} from './settingsTarget'

describe('appPaneForSection', () => {
  it('maps every section to its pane', () => {
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.usage)).toBe('defaults')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.defaults)).toBe('defaults')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.connections)).toBe('connections')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.mcpLibrary)).toBe('mcp-library')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.appearance)).toBe('general')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.notifications)).toBe('general')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.about)).toBe('about')
  })
  it('maps a pane id to itself', () => {
    for (const p of Object.values(APP_SETTINGS_PANES)) expect(appPaneForSection(p)).toBe(p)
  })
  it('returns undefined for unknown ids', () => {
    expect(appPaneForSection('nope')).toBeUndefined()
    expect(appPaneForSection('')).toBeUndefined()
  })
})

describe('section request round trip', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('returns the requested id once, then clears it', () => {
    requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)
    expect(takeAppSettingsSection()).toBe(APP_SETTINGS_SECTIONS.connections)
    expect(takeAppSettingsSection()).toBeNull()
  })
  it('returns null when nothing was requested', () => {
    expect(takeAppSettingsSection()).toBeNull()
  })
  it('does not throw when storage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('x')
      },
      setItem: () => {
        throw new Error('x')
      },
      removeItem: () => {}
    })
    expect(() => requestAppSettingsSection('a')).not.toThrow()
    expect(takeAppSettingsSection()).toBeNull()
  })
})
