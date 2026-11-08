import { describe, expect, it } from 'vitest'
import { FakeHostClient, fakeContext, fakeInproc, noHost } from '../testing/fakeContext'
import { CliError, EXIT, HOST_STARTING_WAIT_MS } from '../types'
import { ENSURE_HOST_STARTING_WAIT_MS, ensureHost, MANAGEMENT_INPROC, missingScopesError } from './ensureHost'

describe('ensureHost (cli-standalone-default.md 4.1)', () => {
  it('starts this process\'s own host, then connects to it with the scopes, waiting up to 15 s while it starts', async () => {
    const inproc = fakeInproc()
    const h = new FakeHostClient()
    const f = fakeContext({ connect: [h], inproc: async () => inproc })
    const r = await ensureHost(f.ctx, ['read', 'operate'], { interactive: false })
    expect(r).toEqual({ client: h, inproc })
    expect(ENSURE_HOST_STARTING_WAIT_MS).toBe(HOST_STARTING_WAIT_MS)
    expect(HOST_STARTING_WAIT_MS).toBe(15_000)
    expect(f.inprocCalls).toEqual([undefined])
    expect(f.connectCalls).toEqual([{ scopes: ['read', 'operate'], opts: { clientKind: 'cli', waitStartingMs: HOST_STARTING_WAIT_MS } }])
  })

  it('never connects before it started its own host, and never looks for a running one', async () => {
    const order: string[] = []
    const f = fakeContext({
      connect: [new FakeHostClient()],
      inproc: async () => {
        order.push('start')
        return fakeInproc()
      }
    })
    const connect = f.ctx.connect
    f.ctx.connect = async (...a) => {
      order.push('connect')
      return connect(...a)
    }
    await ensureHost(f.ctx, ['read'])
    expect(order).toEqual(['start', 'connect'])
  })

  it('the terminal UI connects as a tui client; a management command boots its host with MANAGEMENT_INPROC', async () => {
    const h = new FakeHostClient()
    const t = fakeContext({ connect: [h] })
    await ensureHost(t.ctx, ['read', 'operate', 'decide'], { clientKind: 'tui' })
    expect(t.connectCalls[0].opts).toMatchObject({ clientKind: 'tui' })
    const g = fakeContext({ connect: [h] })
    await ensureHost(g.ctx, ['read'], { inproc: MANAGEMENT_INPROC })
    expect(g.inprocCalls).toEqual([MANAGEMENT_INPROC])
  })

  it('another orgai owning the folder: the start is refused at once with exit 6 and nothing connects', async () => {
    const refusal = new CliError('orgai is already running in another terminal (/work/a, pid 4242). Use that one, or quit it first.', EXIT.hostBusy)
    const f = fakeContext({
      connect: [new FakeHostClient()],
      inproc: async () => {
        throw refusal
      }
    })
    await expect(ensureHost(f.ctx, ['read'])).rejects.toBe(refusal)
    expect(f.connectCalls).toEqual([])
  })

  it('a failed connect stops the host it started again and maps the reason', async () => {
    for (const [reason, code] of [['auth_failed', EXIT.auth], ['starting', EXIT.hostBusy], ['draining', EXIT.hostBusy], ['not_owner', EXIT.failure], ['no_host', EXIT.failure]] as const) {
      const inproc = fakeInproc()
      const f = fakeContext({ connect: [{ ok: false, reason, message: `x ${reason}` }], inproc: async () => inproc })
      await expect(ensureHost(f.ctx, ['read'])).rejects.toMatchObject({ exitCode: code })
      expect(inproc.stops).toEqual([true])
    }
    const inproc = fakeInproc()
    const f = fakeContext({ connect: [noHost()], inproc: async () => inproc })
    f.ctx.connect = async () => {
      throw new Error('socket exploded')
    }
    await expect(ensureHost(f.ctx, ['read'])).rejects.toThrow('socket exploded')
    expect(inproc.stops).toEqual([true])
  })

  it('missingScopesError names the scopes the host did not grant, and nothing when all are granted', () => {
    const c = new FakeHostClient({}, { hello: { grantedScopes: ['read', 'operate'] } })
    expect(missingScopesError(c, ['read', 'operate'])).toBeUndefined()
    const e = missingScopesError(c, ['read', 'decide', 'configure'])
    expect(e).toBeInstanceOf(CliError)
    expect(e?.message).toContain("'decide', 'configure'")
    expect(e?.exitCode).toBe(EXIT.failure)
  })
})
