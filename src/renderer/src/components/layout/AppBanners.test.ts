import { describe, expect, it } from 'vitest'
import type { UpdateState } from '@shared/types'
import { projectsUsing, readyUpdate, signInNeeded } from './AppBanners'

const update = (over: Partial<UpdateState>): UpdateState => ({ capability: 'auto', status: 'downloaded', currentVersion: '1.4.0', availableVersion: '1.5.0', releaseUrl: '', ...over }) as UpdateState

describe('signInNeeded', () => {
  const base = { mock: false, defaultConnection: 'anthropic' as const, status: { state: 'disconnected' as const }, auth: null }
  it('names the default connection when it is signed out or errored', () => {
    expect(signInNeeded(base)).toBe('anthropic')
    expect(signInNeeded({ ...base, status: { state: 'error' } })).toBe('anthropic')
    expect(signInNeeded({ ...base, defaultConnection: 'openai' })).toBe('openai')
  })
  it('says nothing while connected or connecting, on the mock adapter, before the status loads and for a proxy', () => {
    expect(signInNeeded({ ...base, status: { state: 'connected' } })).toBeNull()
    expect(signInNeeded({ ...base, status: { state: 'connecting' } })).toBeNull()
    expect(signInNeeded({ ...base, mock: true })).toBeNull()
    expect(signInNeeded({ ...base, status: undefined })).toBeNull()
    expect(signInNeeded({ ...base, defaultConnection: null })).toBeNull()
    expect(signInNeeded({ ...base, defaultConnection: 'litellm' as never })).toBeNull()
  })
  it('has nothing to sign in to with an API key', () => {
    expect(signInNeeded({ ...base, auth: { loggedIn: false, mode: 'apiKey', envVar: 'ANTHROPIC_API_KEY', envVarSet: false } })).toBeNull()
  })
})

describe('projectsUsing', () => {
  it('counts projects on a connection, an older project counting as Anthropic', () => {
    const projects = [{ provider: { id: 'claude' } }, { provider: { id: 'codex' } }, { provider: { id: 'claude', connection: 'anthropic' } }] as never
    expect(projectsUsing(projects, 'anthropic')).toBe(2)
    expect(projectsUsing(projects, 'openai')).toBe(1)
  })
})

describe('readyUpdate', () => {
  it('offers a downloaded update the app installs itself', () => {
    expect(readyUpdate(update({}), null)).toBe('1.5.0')
  })
  it('stays quiet when dismissed for the version, installing, manual or not downloaded', () => {
    expect(readyUpdate(update({}), '1.5.0')).toBeNull()
    expect(readyUpdate(update({ installing: true }), null)).toBeNull()
    expect(readyUpdate(update({ capability: 'manual' }), null)).toBeNull()
    expect(readyUpdate(update({ status: 'available' }), null)).toBeNull()
    expect(readyUpdate(null, null)).toBeNull()
  })
})
