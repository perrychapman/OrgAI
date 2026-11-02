import { describe, expect, it } from 'vitest'
import { authFailure, connectStep, disconnectKind, httpsUrl, testFailure } from './connectorFlow'

describe('connectorFlow', () => {
  it('opens only https links', () => {
    expect(httpsUrl('https://docs.slack.dev/x')).toBe('https://docs.slack.dev/x')
    expect(httpsUrl('http://x.dev')).toBeUndefined()
    expect(httpsUrl('javascript:alert(1)')).toBeUndefined()
    expect(httpsUrl(undefined)).toBeUndefined()
  })
  it('picks the disconnect action by auth kind', () => {
    expect(disconnectKind({ kind: 'oauth' })).toBe('signOut')
    expect(disconnectKind({ kind: 'token', header: 'A', label: 'T', help: '' })).toBe('clearToken')
    expect(disconnectKind({ kind: 'none' })).toBe('none')
  })
  it('connects by auth kind: a service with no sign-in needs no browser and no token', () => {
    expect(connectStep({ kind: 'none' })).toBe('none')
    expect(connectStep({ kind: 'oauth' })).toBe('authorize')
    expect(connectStep({ kind: 'oauthClient', consoleUrl: 'https://x.y', clientSecret: 'required' })).toBe('authorize')
    expect(connectStep({ kind: 'token', header: 'A', label: 'T', help: '' })).toBe('token')
  })
  it('reports sign-in failures but not cancels or successes', () => {
    expect(authFailure({ state: 'authorized' }, false)).toBeUndefined()
    expect(authFailure({ state: 'notRequired' }, false)).toBeUndefined()
    expect(authFailure({ state: 'error', error: 'Authorization was cancelled.' }, true)).toBeUndefined()
    expect(authFailure({ state: 'error', error: 'Port busy' }, false)).toBe('Port busy')
    expect(authFailure({ state: 'error' }, false)).toMatch(/Try again/)
    expect(authFailure({ state: 'error', needsClientId: true }, false)).toMatch(/sign-in app/)
  })
  it('hints at signing in again', () => {
    expect(testFailure({ ok: false, error: 'x', needsAuthorization: true }, 'oauth').hint).toMatch(/Disconnect/)
    expect(testFailure({ ok: false }, 'oauth')).toEqual({ message: 'The service did not answer.' })
  })
})
