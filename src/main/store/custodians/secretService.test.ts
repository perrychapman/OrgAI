import { describe, expect, it } from 'vitest'
import { fakeSpawner, type FakeAnswer } from './fakeSpawner'
import { NO_SESSION_BUS_REASON, SECRET_SERVICE_LOCKED_REASON, SECRET_TOOL_MISSING_REASON, SecretServiceCustodian } from './secretService'

const ID = '0123456789abcdef0123456789abcdef'
const TOOL = '/usr/bin/secret-tool'
const env = { HOME: '/home/me', PATH: '/usr/local/bin:/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', NODE_OPTIONS: 'x', ORGAI_X: 'y' }
const isFile = (p: string): boolean => p === TOOL

function fakeTool(opts: { items?: Map<string, string>; override?: (args: string[], stdin: string) => FakeAnswer | undefined } = {}) {
  const items = opts.items ?? new Map<string, string>()
  return {
    items,
    ...fakeSpawner(({ args, stdin }) => {
      const o = opts.override?.(args, stdin)
      if (o) return o
      const id = args[args.length - 1]!
      if (args[0] === 'search') return { code: 1 }
      if (args[0] === 'lookup') return items.has(id) ? { code: 0, stdout: items.get(id)! } : { code: 1 }
      if (args[0] === 'store') {
        items.set(id, stdin)
        return { code: 0 }
      }
      if (args[0] === 'clear') {
        items.delete(id)
        return { code: 0 }
      }
      return { code: 2 }
    })
  }
}

const custodian = (f: ReturnType<typeof fakeTool>, extra: Record<string, unknown> = {}) =>
  new SecretServiceCustodian({ spawner: f.spawner, env, platform: 'linux', isFile, ...extra })

describe('SecretServiceCustodian (cli-standalone.md 5.3, Linux)', () => {
  it('probes with secret-tool search on the absolute PATH entry and the Secret Service allowlist', async () => {
    const f = fakeTool()
    await expect(custodian(f).probe()).resolves.toEqual({ ok: true })
    expect(f.calls[0]!.file).toBe(TOOL)
    expect(f.calls[0]!.args).toEqual(['search', 'service', 'orgai-vault-probe'])
    expect(f.calls[0]!.options.env).toEqual({ HOME: '/home/me', PATH: '/usr/local/bin:/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' })
  })

  it('is unavailable without secret-tool or without a session bus, before any child runs', async () => {
    const f = fakeTool()
    await expect(custodian(f, { isFile: () => false }).probe()).resolves.toEqual({ ok: false, kind: 'unavailable', reason: SECRET_TOOL_MISSING_REASON })
    const noBus = new SecretServiceCustodian({ spawner: f.spawner, env: { HOME: '/h', PATH: '/usr/bin' }, platform: 'linux', isFile, exists: () => false })
    await expect(noBus.probe()).resolves.toEqual({ ok: false, kind: 'unavailable', reason: NO_SESSION_BUS_REASON })
    expect(f.calls).toHaveLength(0)
  })

  it('accepts the systemd default bus socket under XDG_RUNTIME_DIR', async () => {
    const f = fakeTool()
    const seen: string[] = []
    const c = new SecretServiceCustodian({
      spawner: f.spawner,
      env: { HOME: '/h', PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000' },
      platform: 'linux',
      isFile,
      exists: (p) => (seen.push(p), true)
    })
    await expect(c.probe()).resolves.toEqual({ ok: true })
    expect(seen).toEqual(['/run/user/1000/bus'])
  })

  it.each([
    [{ hang: true }, 'locked'],
    [{ code: 1, stderr: 'secret-tool: The name org.freedesktop.secrets was not provided by any .service files' }, 'unavailable'],
    [{ code: 1, stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY' }, 'unavailable'],
    [{ code: 1, stderr: 'secret-tool: Prompt dismissed' }, 'locked'],
    [{ code: 3, stderr: 'weird' }, 'unavailable']
  ] as Array<[FakeAnswer, string]>)('classifies a probe answer %j as %s', async (answer, kind) => {
    const f = fakeTool({ override: () => answer })
    const p = await custodian(f, { timeoutMs: 30 }).probe()
    expect(p).toMatchObject({ ok: false, kind })
    if (kind === 'locked') expect((p as { reason: string }).reason).toBe(SECRET_SERVICE_LOCKED_REASON)
  })

  it('creates after a lookup finds none: store with the label and the key on stdin, then lookup again', async () => {
    const f = fakeTool()
    const { dek } = await custodian(f).create(ID)
    expect(f.calls.map((c) => c.args[0])).toEqual(['lookup', 'store', 'lookup'])
    const store = f.calls[1]!
    expect(store.args).toEqual(['store', '--label=OrgAI vault', 'service', 'orgai', 'vault', ID])
    expect(store.stdin).toBe(dek.toString('base64'))
    expect(f.calls[0]!.args).toEqual(['lookup', 'service', 'orgai', 'vault', ID])
    for (const c of f.calls) expect(c.args.join(' ')).not.toContain(dek.toString('base64'))
  })

  it('refuses to create when an item exists (even one that is not a key), and never stores', async () => {
    for (const v of [Buffer.alloc(32, 1).toString('base64'), 'garbage']) {
      const f = fakeTool({ items: new Map([[ID, v]]) })
      await expect(custodian(f).create(ID)).rejects.toMatchObject({ kind: 'denied', reason: expect.stringContaining('already exists') })
      expect(f.calls.some((c) => c.args[0] === 'store')).toBe(false)
    }
  })

  it('fails create when the stored key does not read back', async () => {
    const f = fakeTool({ override: (args) => (args[0] === 'store' ? { code: 0 } : undefined) })
    await expect(custodian(f).create(ID)).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('clears the new item when the read back differs or times out after a successful store (review round 2)', async () => {
    const items = new Map<string, string>()
    const other = fakeTool({
      items,
      override: (args) => {
        if (args[0] === 'store') {
          items.set(ID, Buffer.alloc(32, 9).toString('base64'))
          return { code: 0 }
        }
        return undefined
      }
    })
    await expect(custodian(other).create(ID)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(other.calls.map((c) => c.args[0])).toEqual(['lookup', 'store', 'lookup', 'clear'])
    expect(other.calls[3]!.args).toEqual(['clear', 'service', 'orgai', 'vault', ID])
    expect(items.has(ID)).toBe(false)

    let lookups = 0
    const slow = fakeTool({ override: (args) => (args[0] === 'lookup' && ++lookups === 2 ? { hang: true } : undefined) })
    // 500 ms, not 30: only the hanging lookup may time out, even on a loaded machine.
    await expect(custodian(slow, { timeoutMs: 500 }).create(ID)).rejects.toMatchObject({ kind: 'locked' })
    expect(slow.calls.map((c) => c.args[0])).toEqual(['lookup', 'store', 'lookup', 'clear'])
    expect(slow.items.has(ID)).toBe(false)
  })

  it('never clears when the store itself failed or an item already existed', async () => {
    const failed = fakeTool({ override: (args) => (args[0] === 'store' ? { code: 1, stderr: 'secret-tool: Prompt dismissed' } : undefined) })
    await expect(custodian(failed).create(ID)).rejects.toMatchObject({ kind: 'locked' })
    expect(failed.calls.some((c) => c.args[0] === 'clear')).toBe(false)
    const there = fakeTool({ items: new Map([[ID, Buffer.alloc(32, 1).toString('base64')]]) })
    await expect(custodian(there).create(ID)).rejects.toMatchObject({ kind: 'denied' })
    expect(there.calls.some((c) => c.args[0] === 'clear')).toBe(false)
    expect(there.items.has(ID)).toBe(true)
  })

  it('opens with lookup (trimmed); empty is missing', async () => {
    const key = Buffer.alloc(32, 5)
    const f = fakeTool({ items: new Map([[ID, `${key.toString('base64')}\n`]]) })
    expect((await custodian(f).open(ID, { scheme: 'secret-service' })).equals(key)).toBe(true)
    const empty = fakeTool()
    await expect(custodian(empty).open(ID, { scheme: 'secret-service' })).rejects.toMatchObject({ kind: 'missing' })
  })

  it('maps a lookup timeout to locked, never missing', async () => {
    const f = fakeTool({ override: () => ({ hang: true }) })
    await expect(custodian(f, { timeoutMs: 30 }).open(ID, { scheme: 'secret-service' })).rejects.toMatchObject({ kind: 'locked' })
  })

  it('removes the item with clear', async () => {
    const f = fakeTool({ items: new Map([[ID, 'x']]) })
    await custodian(f).removeItem(ID, { scheme: 'secret-service' })
    expect(f.items.size).toBe(0)
    expect(f.calls[0]!.args).toEqual(['clear', 'service', 'orgai', 'vault', ID])
  })

  it('is not available on macOS or Windows', async () => {
    const f = fakeTool()
    await expect(custodian(f, { platform: 'darwin' }).probe()).resolves.toMatchObject({ ok: false, kind: 'unavailable' })
    await expect(custodian(f, { platform: 'win32' }).open(ID, { scheme: 'secret-service' })).rejects.toMatchObject({ kind: 'missing' })
  })
})
