import { describe, expect, it } from 'vitest'
import { cancelLogin, expiryOf, listModels, logoutAccount, onLoginCompleted, parseLoginStart, parseModelPage, readAccount, startLogin } from './codexAccount'
import { fakeRpc } from './testHelpers'

describe('codexAccount', () => {
  it('reads a signed-out, chatgpt and api-key account', async () => {
    expect(await readAccount(fakeRpc({ 'account/read': { account: null, requiresOpenaiAuth: true, workspaceRouting: null } }))).toEqual({ account: null, requiresOpenaiAuth: true })
    const rpc = fakeRpc({ 'account/read': { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus', workspaceName: null }, requiresOpenaiAuth: true } })
    expect(await readAccount(rpc)).toEqual({ account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' }, requiresOpenaiAuth: true })
    expect(rpc.calls[0]).toEqual(['account/read', { refreshToken: false }])
    expect((await readAccount(fakeRpc({ 'account/read': { account: { type: 'apiKey' } } }))).account).toEqual({ type: 'apiKey' })
    expect(await readAccount(fakeRpc({ 'account/read': 'garbage' }))).toEqual({ account: null, requiresOpenaiAuth: false })
  })

  it('starts browser and device-code logins', async () => {
    const rpc = fakeRpc({
      'account/login/start': (p: unknown) =>
        (p as { type: string }).type === 'chatgpt'
          ? { type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.example/x' }
          : { type: 'chatgptDeviceCode', loginId: 'L2', verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234' }
    })
    expect(await startLogin(rpc, 'browser')).toEqual({ method: 'browser', loginId: 'L1', authUrl: 'https://auth.example/x' })
    expect(await startLogin(rpc, 'deviceCode')).toEqual({ method: 'deviceCode', loginId: 'L2', verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234' })
    expect(rpc.calls.map((c) => c[1])).toEqual([{ type: 'chatgpt' }, { type: 'chatgptDeviceCode' }])
    expect(() => parseLoginStart({ type: 'chatgpt', loginId: 'x' })).toThrow(/login URL/)
  })

  it('reads an optional device-code expiry in any of the accepted shapes', () => {
    const now = 1_700_000_000_000
    expect(expiryOf({ expiresAt: '2030-01-01T00:00:00Z' }, now)).toBe(Date.parse('2030-01-01T00:00:00Z'))
    expect(expiryOf({ expiresAt: 1_900_000_000 }, now)).toBe(1_900_000_000_000)
    expect(expiryOf({ expiresAt: 1_900_000_000_000 }, now)).toBe(1_900_000_000_000)
    expect(expiryOf({ expiresIn: 900 }, now)).toBe(now + 900_000)
    expect(expiryOf({ expiresAt: 'soon' }, now)).toBeUndefined()
    expect(expiryOf({}, now)).toBeUndefined()
    const start = parseLoginStart({ type: 'chatgptDeviceCode', loginId: 'L', verificationUrl: 'https://v', userCode: 'C', expiresIn: 60 })
    expect(start.method === 'deviceCode' && start.expiresAt).toBeGreaterThan(Date.now())
  })

  it('cancels, logs out and reports login completion', async () => {
    const rpc = fakeRpc({ 'account/login/cancel': {}, 'account/logout': {} })
    await cancelLogin(rpc, 'L1')
    await logoutAccount(rpc)
    expect(rpc.calls).toEqual([['account/login/cancel', { loginId: 'L1' }], ['account/logout', undefined]])
    const seen: unknown[] = []
    const off = onLoginCompleted(rpc, (r) => seen.push(r))
    rpc.emit('account/login/completed', { loginId: 'L1', success: false, error: 'denied' })
    rpc.emit('account/updated', {})
    off()
    rpc.emit('account/login/completed', { loginId: 'L1', success: true, error: null })
    expect(seen).toEqual([{ loginId: 'L1', success: false, error: 'denied' }])
  })

  it('paginates model/list and drops hidden models', async () => {
    const rpc = fakeRpc({
      'model/list': (p: unknown) =>
        (p as { cursor?: string }).cursor
          ? { data: [{ id: 'm3', model: 'gpt-5-mini', displayName: 'GPT-5 mini', hidden: true }], nextCursor: null }
          : { data: [{ id: 'm1', model: 'gpt-5', displayName: 'GPT-5', description: 'd', isDefault: true }, { id: 'm2' }, { nope: 1 }], nextCursor: 'c1' }
    })
    const models = await listModels(rpc)
    expect(models.map((m) => m.id)).toEqual(['gpt-5', 'm2'])
    expect(models[0]).toMatchObject({ label: 'GPT-5', isDefault: true, description: 'd' })
    expect(rpc.calls).toHaveLength(2)
    expect(parseModelPage(null)).toEqual({ models: [], nextCursor: null })
  })
})
