import { describe, expect, it } from 'vitest'
import {
  ADVANCED_SECTIONS,
  APP_SETTINGS_PANES,
  APP_SETTINGS_SECTIONS,
  APP_SETTING_DOCS,
  ATLAS_SURFACES,
  ATLAS_SURFACE_IDS,
  MENU_ACTION_DOCS,
  PROJECT_ADVANCED_SECTIONS,
  PROJECT_SETTINGS_PANES,
  PROJECT_SETTINGS_SECTIONS,
  PROJECT_SETTING_DOCS,
  appPaneForSection,
  atlasPath,
  atlasSurface,
  isAtlasSurfaceId,
  normalizeProjectPane,
  projectPaneForSection
} from './atlas'
import { hasHidden } from './hiddenChars'
import { SHORTCUTS } from './shortcuts'
import { APP_SETTINGS_PROPOSABLE_FIELDS, MENU_ACTIONS, PROJECT_SETTINGS_PROPOSABLE_FIELDS } from '../types'

const ids = new Set<string>(ATLAS_SURFACE_IDS)

/** Proposable AppSettings fields no screen shows today (the card is the only place they appear). Update with a screen. */
const NO_SCREEN_PROPOSABLE = [
  'defaultMaxBudgetUsd',
  'defaultKeepRuns',
  'defaultIsolateWriters',
  'opusGuardThreshold',
  'defaultAutoContinue',
  'defaultMaxAutoContinues'
]

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out))
  return out
}

describe('atlas surfaces', () => {
  it('has one surface per id and ids are unique', () => {
    expect(ids.size).toBe(ATLAS_SURFACE_IDS.length)
    const surfaceIds = ATLAS_SURFACES.map((s) => s.id)
    expect(new Set(surfaceIds).size).toBe(surfaceIds.length)
    expect([...surfaceIds].sort()).toEqual([...ATLAS_SURFACE_IDS].sort())
    for (const id of ATLAS_SURFACE_IDS) expect(atlasSurface(id).id).toBe(id)
  })

  it('keeps the pinned ids', () => {
    for (const id of [
      'dashboard',
      'dashboard-new-project',
      'project-live',
      'project-history',
      'project-knowledge',
      'project-team',
      'project-settings-general',
      'project-settings-permissions',
      'app-settings-general',
      'app-settings-general-appearance',
      'app-settings-connections',
      'chat-start'
    ])
      expect(ids.has(id)).toBe(true)
  })

  it('has non-empty reach, known button parents and valid deep links', () => {
    const targets = new Set<string>([
      ...Object.values(APP_SETTINGS_SECTIONS),
      ...Object.values(PROJECT_SETTINGS_SECTIONS),
      ...Object.values(APP_SETTINGS_PANES),
      ...Object.values(PROJECT_SETTINGS_PANES)
    ])
    const actions = new Set<string>(MENU_ACTIONS)
    for (const s of ATLAS_SURFACES) {
      expect(s.reach.length, s.id).toBeGreaterThan(0)
      expect(s.path[s.path.length - 1], s.id).toBe(s.label)
      expect(s.summary.length, s.id).toBeGreaterThan(10)
      for (const r of s.reach) {
        if (r.via === 'button') expect(ids.has(r.on), `${s.id} button on ${r.on}`).toBe(true)
        if (r.via === 'deepLink') expect(targets.has(r.target), `${s.id} deep link ${r.target}`).toBe(true)
        if (r.via === 'menu') expect(actions.has(r.action), `${s.id} menu ${r.action}`).toBe(true)
      }
    }
  })

  it('names only documented settings', () => {
    for (const s of ATLAS_SURFACES) {
      for (const path of s.settings ?? []) {
        if (path.startsWith('project.')) expect(path.slice(8) in PROJECT_SETTING_DOCS, `${s.id}: ${path}`).toBe(true)
        else expect(path.split('.')[0] in APP_SETTING_DOCS, `${s.id}: ${path}`).toBe(true)
      }
    }
  })

  it('reaches every menu action', () => {
    const reached = new Set<string>()
    for (const s of ATLAS_SURFACES) for (const r of s.reach) if (r.via === 'menu') reached.add(r.action)
    for (const a of MENU_ACTIONS) {
      expect(reached.has(a) || typeof MENU_ACTION_DOCS[a] === 'string', a).toBe(true)
      expect(MENU_ACTION_DOCS[a].length, a).toBeGreaterThan(10)
    }
    expect(Object.keys(MENU_ACTION_DOCS).sort()).toEqual([...MENU_ACTIONS].sort())
  })

  it('points setting docs at real surfaces', () => {
    for (const d of [...Object.values(APP_SETTING_DOCS), ...Object.values(PROJECT_SETTING_DOCS)]) {
      expect(d.surface === 'none' || ids.has(d.surface)).toBe(true)
      expect(d.summary.length).toBeGreaterThan(5)
    }
  })

  it('marks exactly the proposable fields', () => {
    const appTop = new Set(APP_SETTINGS_PROPOSABLE_FIELDS.map((f) => f.split('.')[0]))
    for (const [k, d] of Object.entries(APP_SETTING_DOCS)) expect(d.proposable === true, `app ${k}`).toBe(appTop.has(k))
    for (const k of appTop) {
      expect(k in APP_SETTING_DOCS, k).toBe(true)
      const d = APP_SETTING_DOCS[k as keyof typeof APP_SETTING_DOCS]
      if (NO_SCREEN_PROPOSABLE.includes(k)) expect(d.surface, k).toBe('none')
      else expect(d.surface, k).not.toBe('none')
    }
    const proj = new Set<string>(PROJECT_SETTINGS_PROPOSABLE_FIELDS)
    for (const [k, d] of Object.entries(PROJECT_SETTING_DOCS)) expect(d.proposable === true, `project ${k}`).toBe(proj.has(k))
    for (const k of proj) expect(PROJECT_SETTING_DOCS[k as keyof typeof PROJECT_SETTING_DOCS].surface, k).not.toBe('none')
  })

  it('does not mark main-owned or deprecated fields proposable', () => {
    for (const d of [...Object.values(APP_SETTING_DOCS), ...Object.values(PROJECT_SETTING_DOCS)]) {
      if (d.control === 'main' || d.control === 'deprecated') expect(d.proposable).toBeUndefined()
    }
  })

  it('builds paths and checks ids', () => {
    expect(atlasPath('app-settings-general-appearance')).toBe('App settings › General › Appearance')
    expect(isAtlasSurfaceId('chat-start')).toBe(true)
    expect(isAtlasSurfaceId('')).toBe(false)
    expect(isAtlasSurfaceId('nope')).toBe(false)
    expect(isAtlasSurfaceId(5)).toBe(false)
    expect(isAtlasSurfaceId(undefined)).toBe(false)
  })

  it('has no hidden characters anywhere', () => {
    const all = [...strings(ATLAS_SURFACES), ...strings(APP_SETTING_DOCS), ...strings(PROJECT_SETTING_DOCS), ...strings(MENU_ACTION_DOCS), ...strings(SHORTCUTS)]
    expect(all.length).toBeGreaterThan(100)
    for (const s of all) expect(hasHidden(s), JSON.stringify(s)).toBe(false)
  })
})

describe('deep-link tables', () => {
  it('map sections to panes', () => {
    expect(appPaneForSection(APP_SETTINGS_SECTIONS.costs)).toBe('connections')
    expect(appPaneForSection('about')).toBe('about')
    expect(appPaneForSection('nope')).toBeUndefined()
    expect(projectPaneForSection(PROJECT_SETTINGS_SECTIONS.teamAssistant)).toBe('permissions')
    expect(normalizeProjectPane('agents')).toBe('permissions')
    expect(normalizeProjectPane('junk')).toBe('general')
    expect(ADVANCED_SECTIONS[APP_SETTINGS_SECTIONS.modelPrices]).toBe('app-connections')
    expect(PROJECT_ADVANCED_SECTIONS[PROJECT_SETTINGS_SECTIONS.teamAssistant]).toBe('project-permissions')
  })
})
