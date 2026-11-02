import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_SETTINGS_PANES,
  APP_SETTINGS_SECTIONS,
  PROJECT_SETTINGS_PANES,
  PROJECT_SETTINGS_SECTIONS,
  projectPaneForSection,
  requestProjectSettingsSection,
  takeProjectSettingsSection,
  appPaneForSection,
  isConnectorId,
  requestAppSettingsSection,
  requestConnector,
  takeConnectorTarget,
  takeAppSettingsSection
} from './settingsTarget'

describe('appPaneForSection', () => {
  it('maps every section to its pane', () => {
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.usage)).toBe('defaults')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.defaults)).toBe('defaults')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.connections)).toBe('connections')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.modelPrices)).toBe('connections')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.mcpLibrary)).toBe('mcp-library')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.skillLibrary)).toBe('skill-library')
    expect(appPaneForSection('skill-library')).toBe('skill-library')
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

describe('project settings section requests', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  it('maps sections to the Agents pane', () => {
    expect(projectPaneForSection(PROJECT_SETTINGS_SECTIONS.permissions)).toBe('agents')
    expect(projectPaneForSection(PROJECT_SETTINGS_SECTIONS.allowedFolders)).toBe('agents')
    expect(projectPaneForSection('nope')).toBeUndefined()
  })
  it('hands the section once to its own pane only', () => {
    requestProjectSettingsSection(PROJECT_SETTINGS_SECTIONS.permissions)
    expect(takeProjectSettingsSection('general')).toBeNull()
    expect(takeProjectSettingsSection('agents')).toBe(PROJECT_SETTINGS_SECTIONS.permissions)
    expect(takeProjectSettingsSection('agents')).toBeNull()
  })
  it('drops unknown ids', () => {
    requestProjectSettingsSection('x' as never)
    expect(takeProjectSettingsSection('agents')).toBeNull()
  })
})

describe('requestConnector', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k)
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  it('validates kebab-case ids', () => {
    expect(isConnectorId('github')).toBe(true)
    expect(isConnectorId('google-drive')).toBe(true)
    for (const bad of ['', 'GitHub', 'a b', 'a--b', '-a', 'a-', '../x', 'a'.repeat(65), 5, null]) expect(isConnectorId(bad)).toBe(false)
  })
  it('stores a valid id once and opens the Connectors pane', () => {
    requestConnector('github')
    expect(takeAppSettingsSection()).toBe('mcp-library')
    expect(takeConnectorTarget()).toBe('github')
    expect(takeConnectorTarget()).toBeNull()
  })
  it('drops a bad id', () => {
    requestConnector('Bad Id')
    expect(takeConnectorTarget()).toBeNull()
  })
})

describe('project settings panes', () => {
  it('keeps the tools pane id (stored choices and links) after its content moved to Team > Catalog', () => {
    expect(PROJECT_SETTINGS_PANES.tools).toBe('tools')
  })
})
