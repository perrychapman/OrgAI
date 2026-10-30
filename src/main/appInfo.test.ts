import { describe, expect, it } from 'vitest'
import { buildAppInfo, type AppLike } from './appInfo'

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
