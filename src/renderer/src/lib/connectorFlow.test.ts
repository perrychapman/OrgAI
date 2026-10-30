import { describe, expect, it } from 'vitest'
import { authFailure, disconnectKind, httpsUrl, testFailure } from './connectorFlow'

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
  })
  it('reports sign-in failures but not cancels or successes', () => {
    expect(authFailure({ state: 'authorized' }, false)).toBeUndefined()
    expect(authFailure({ state: 'error', error: 'Authorization was cancelled.' }, true)).toBeUndefined()
    expect(authFailure({ state: 'error', error: 'Port busy' }, false)).toBe('Port busy')
    expect(authFailure({ state: 'error' }, false)).toMatch(/Try again/)
    expect(authFailure({ state: 'error', needsClientId: true }, false)).toMatch(/sign-in app/)
  })
  it('hints at signing in again', () => {
    expect(testFailure({ ok: false, error: 'x', needsAuthorization: true }, 'oauth').hint).toMatch(/Connect/)
    expect(testFailure({ ok: false }, 'oauth')).toEqual({ message: 'The service did not answer.' })
  })
})
