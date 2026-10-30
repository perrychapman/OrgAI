import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS } from '@shared/defaults'
import { buildAppInfo, buildSettingsInfo, stripSettingsInfo, windowBackground, type AppLike } from './appInfo'

const app = (packaged: boolean): AppLike => ({
  getVersion: () => '1.2.3',
  getPath: (name) => (name === 'userData' ? '/data/OrgAI' : ''),
  isPackaged: packaged
})

describe('buildAppInfo', () => {
  it('reports the mock adapter only when it is registered', () => {
    const base = { platform: 'win32', logsDir: '/data/OrgAI/logs' }
    expect(buildAppInfo(app(false), { ...base, adapterIds: ['claude', 'codex', 'mock'] }).mockAdapter).toBe(true)
    expect(buildAppInfo(app(false), { ...base, adapterIds: ['claude', 'codex'] }).mockAdapter).toBe(false)
  })

  it('copies version, platform, folders and packaging into a structured-clone safe object', () => {
    const info = buildAppInfo(app(true), { platform: 'darwin', logsDir: '/Users/x/Library/Logs/OrgAI', adapterIds: ['claude'] })
    expect(info).toEqual({
      version: '1.2.3',
      platform: 'darwin',
      dataDir: '/data/OrgAI',
      logsDir: '/Users/x/Library/Logs/OrgAI',
      mockAdapter: false,
      packaged: true
    })
    expect(structuredClone(info)).toEqual(info)
  })
})

describe('settings info and window background', () => {
  it('adds and strips the read-only fields', () => {
    const info = buildSettingsInfo(DEFAULT_APP_SETTINGS, { dataDir: '/d', appVersion: '0.1.2' })
    expect(info).toMatchObject({ dataDir: '/d', appVersion: '0.1.2' })
    expect(stripSettingsInfo(info)).toEqual(DEFAULT_APP_SETTINGS)
    expect(structuredClone(info)).toEqual(info)
  })

  it('picks the background from the theme, asking the OS only for system', () => {
    expect(windowBackground('dark', false)).toBe('#0b0d12')
    expect(windowBackground('light', true)).toBe('#f4f5f9')
    expect(windowBackground('system', true)).toBe('#0b0d12')
    expect(windowBackground('system', false)).toBe('#f4f5f9')
  })
})
