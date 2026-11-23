import { describe, expect, it } from 'vitest'
import type { ConnectionInfo } from '@shared/types'
import { ASK_OPTIONS, WELCOME_DONE_KEY, askChoiceFor, connectOptions, nextStage, prevStage, readWelcomeDone, writeWelcomeDone } from './welcome'

const info = (id: string, state: 'connected' | 'disconnected' | 'error' | 'connecting', extra: Partial<ConnectionInfo> = {}, enabled = true): ConnectionInfo =>
  ({ connection: { id, enabled }, status: { state }, modelCount: 0, isDefault: false, ...extra }) as unknown as ConnectionInfo

describe('welcome', () => {
  it('lists enabled connections, the default first, then connected ones', () => {
    const list = [info('openai', 'connected'), info('anthropic', 'disconnected', { isDefault: true }), info('proxy-x', 'connected', {}, false), info('proxy-y', 'error')]
    const out = connectOptions(list, null)
    expect(out.map((o) => o.id)).toEqual(['anthropic', 'openai', 'proxy-y'])
    expect(out[0].connected).toBe(false)
    expect(out[1].sub).toBe('Ready for your teams to use.')
    expect(out[2].sub).toMatch(/Not working/)
  })
  it('names the account when the provider reports one, and returns nothing before the list loads', () => {
    expect(connectOptions([info('anthropic', 'connected', { status: { state: 'connected', account: 'Max plan' } })], 'anthropic')[0].sub).toBe('Signed in as Max plan.')
    expect(connectOptions(null, null)).toEqual([])
  })
  it('chat skips the asking step; Back walks one step', () => {
    expect(nextStage(1, 'code')).toBe(2)
    expect(nextStage(2, 'chat')).toBe('start')
    expect(nextStage(2, 'engagement')).toBe(3)
    expect(nextStage(3, 'code')).toBe('start')
    expect(prevStage(3)).toBe(2)
    expect(prevStage(2)).toBe(1)
  })
  it('preselects only one of the three offered modes', () => {
    expect(ASK_OPTIONS.map((o) => o.mode)).toEqual(['default', 'acceptEdits', 'auto'])
    expect(askChoiceFor('acceptEdits')).toBe('acceptEdits')
    expect(askChoiceFor('bypassPermissions')).toBeNull()
    expect(askChoiceFor(undefined)).toBeNull()
  })
  it('remembers that setup is done', () => {
    const m = new Map<string, string>()
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
    expect(readWelcomeDone(s)).toBe(false)
    writeWelcomeDone(s)
    expect(m.get(WELCOME_DONE_KEY)).toBe('1')
    expect(readWelcomeDone(s)).toBe(true)
    expect(readWelcomeDone(null)).toBe(false)
  })
})
