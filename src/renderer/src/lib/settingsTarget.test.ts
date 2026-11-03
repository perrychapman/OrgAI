import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_SETTINGS_PANES,
  APP_SETTINGS_SECTIONS,
  PROJECT_SETTINGS_PANES,
  PROJECT_SETTINGS_SECTIONS,
  advancedPaneForSection,
  normalizeProjectPane,
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
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.newProjects)).toBe('general')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.assistantModels)).toBe('general')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.costs)).toBe('connections')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.connections)).toBe('connections')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.modelPrices)).toBe('connections')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.mcpLibrary)).toBe('mcp-library')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.skillLibrary)).toBe('skill-library')
    expect(appPaneForSection('skill-library')).toBe('skill-library')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.appearance)).toBe('general')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.notifications)).toBe('general')
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.about)).toBe('about')
  })
  it('returns undefined for the removed Defaults pane and its rows (the page opens on General)', () => {
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.usage)).toBeUndefined()
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.defaults)).toBeUndefined()
    expect(appPaneForSection('defaults')).toBeUndefined()
  })
  it('names the Advanced disclosure a deep link must open first', () => {
    expect(advancedPaneForSection(APP_SETTINGS_SECTIONS.assistantModels)).toBe('app-general')
    expect(advancedPaneForSection(APP_SETTINGS_SECTIONS.costs)).toBe('app-connections')
    expect(advancedPaneForSection(APP_SETTINGS_SECTIONS.modelPrices)).toBe('app-connections')
    expect(advancedPaneForSection(APP_SETTINGS_SECTIONS.connections)).toBeUndefined()
    expect(advancedPaneForSection(APP_SETTINGS_SECTIONS.newProjects)).toBeUndefined()
  })
  it('maps a pane id to itself', () => {
    for (const p of Object.values(APP_SETTINGS_PANES)) if (p !== 'defaults') expect(appPaneForSection(p)).toBe(p)
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
  it('maps sections to the Permissions pane', () => {
    expect(projectPaneForSection(PROJECT_SETTINGS_SECTIONS.permissions)).toBe('permissions')
    expect(projectPaneForSection(PROJECT_SETTINGS_SECTIONS.allowedFolders)).toBe('permissions')
    expect(projectPaneForSection(PROJECT_SETTINGS_SECTIONS.rules)).toBe('permissions')
    expect(projectPaneForSection(PROJECT_SETTINGS_SECTIONS.connection)).toBe('general')
    expect(projectPaneForSection('nope')).toBeUndefined()
  })
  it('hands the section once to its own pane only', () => {
    requestProjectSettingsSection(PROJECT_SETTINGS_SECTIONS.permissions)
    expect(takeProjectSettingsSection('general')).toBeNull()
    expect(takeProjectSettingsSection('permissions')).toBe(PROJECT_SETTINGS_SECTIONS.permissions)
    expect(takeProjectSettingsSection('permissions')).toBeNull()
  })
  it('drops unknown ids', () => {
    requestProjectSettingsSection('x' as never)
    expect(takeProjectSettingsSection('permissions')).toBeNull()
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
  it('has four panes in nav order', () => {
    expect(Object.values(PROJECT_SETTINGS_PANES)).toEqual(['general', 'permissions', 'limits', 'maintenance'])
  })
  it('maps stored legacy pane ids to their new pane', () => {
    expect(normalizeProjectPane('agents')).toBe('permissions')
    expect(normalizeProjectPane('connection')).toBe('general')
    expect(normalizeProjectPane('tools')).toBe('general')
    expect(normalizeProjectPane('limits')).toBe('limits')
    expect(normalizeProjectPane('nope')).toBe('general')
    expect(normalizeProjectPane(undefined)).toBe('general')
  })
})
