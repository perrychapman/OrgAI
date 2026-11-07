import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HostScope, SecretsStatusResult } from '../../shared/types'
import { VAULT_MESSAGES } from '../../main/store/vaultTypes'
import { manageDeps } from '../manage'
import { fakeContext, FakeHostClient, rpcError, type Answer, type FakeContextOptions } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { KEY_FILE_BACKUP_WARNING, runSecrets, statusLines } from './secrets'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realDeps = { ...manageDeps }
afterEach(() => {
  Object.assign(manageDeps, realDeps)
})

const status = (over: Partial<SecretsStatusResult> = {}): SecretsStatusResult => ({
  state: 'open',
  scheme: 'keychain',
  vaultId: '0123456789abcdef0123456789abcdef',
  counts: { vault: 3, legacy: 2, unreadable: 0, overlay: 0 },
  pendingLegacy: 0,
  softDeletes: [],
  orphanedKeys: 0,
  orphanedVaults: [],
  legacyFile: 'ok',
  canWriteBack: false,
  ...over
})

/** The fake client closes with each command; reopen it so one test can run several commands. */
const clients = new WeakMap<object, FakeHostClient>()

function setup(answers: Record<string, Answer>, o: FakeContextOptions = {}) {
  const client = new FakeHostClient(answers, { hello: ALL })
  const f = fakeContext({ connect: [client], paths: { userDataDir: '/home/u/OrgAI', dataDir: '/home/u/OrgAI/data' }, cwd: '/home/u/work', ...o })
  clients.set(f, client)
  return { client, f }
}

async function run(f: ReturnType<typeof fakeContext>, args: string[]): Promise<number> {
  const c = clients.get(f)
  if (c) c.closed = false
  try {
    return await runSecrets(f.ctx, args)
  } catch (e) {
    if (e instanceof CliError) {
      f.ctx.io.stderr.write(`${e.message}\n`)
      return e.exitCode
    }
    throw e
  }
}

describe('orgai secrets status', () => {
  it('prints state, scheme, counts and kept deletes by key name only; --probe asks the host to probe', async () => {
    const s = status({
      counts: { vault: 3, legacy: 2, unreadable: 2, overlay: 1 },
      pendingLegacy: 2,
      probe: { ok: false, kind: 'locked', reason: 'The macOS keychain is locked.' },
      softDeletes: [{ key: 'mcp:p1:s1:env:TOKEN', by: 'legacy', at: Date.UTC(2026, 10, 4), restorable: 'here' }],
      orphanedVaults: [{ vaultId: 'ffff', scheme: 'keychain', file: 'vault.json.reset-1' }]
    })
    const { f, client } = setup({ 'secrets:status': () => s })
    expect(await run(f, ['status', '--probe'])).toBe(EXIT.ok)
    expect(client.callsOf('secrets:status')).toEqual([[{ probe: true }]])
    const out = f.out()
    expect(out).toContain('Storage:      open (macOS keychain)')
    expect(out).toContain('Key store:    locked: The macOS keychain is locked.')
    expect(out).toContain("3 in secure storage, 2 in the app's older secrets.json (present), 2 unreadable here, 1 from the environment (never saved)")
    expect(out).toContain(`Pending:      2 secrets: ${VAULT_MESSAGES.pendingLegacy}`)
    expect(out).toMatch(/mcp:p1:s1:env:TOKEN {2}removed by an older OrgAI .*, restorable/)
    expect(out).toContain('ffff  macOS keychain  vault.json.reset-1')
  })

  it('json carries the whole report; a plain status call sends no probe', async () => {
    const { f, client } = setup({ 'secrets:status': () => status({ state: 'locked', reason: 'Secure storage is locked: x' }) }, { globals: { outputFormat: 'json' } })
    expect(await run(f, ['status'])).toBe(EXIT.ok)
    expect(client.callsOf('secrets:status')).toEqual([[{}]])
    const j = JSON.parse(f.out())
    expect(j.secrets).toMatchObject({ state: 'locked', scheme: 'keychain', reason: 'Secure storage is locked: x', counts: { vault: 3 } })
  })

  it('statusLines never needs a value: an absent vault with no usable scheme reads plainly', () => {
    const lines = statusLines(status({ state: 'absent', scheme: null, vaultId: undefined, counts: { vault: 0, legacy: 0, unreadable: 0, overlay: 0 }, legacyFile: 'missing' }))
    expect(lines[0]).toBe('Storage:      not created yet (none usable on this host)')
  })
})

describe('orgai secrets init', () => {
  it('sends an absolute key file (resolved against the cwd) and prints the backup warning', async () => {
    const { f, client } = setup({ 'secrets:init': () => ({ action: 'created', status: status({ scheme: 'key-file', keyFile: '/home/u/keys/orgai.key' }) }) })
    expect(await run(f, ['init', '--key-file', '../keys/orgai.key'])).toBe(EXIT.ok)
    expect(client.callsOf('secrets:init')).toEqual([[{ keyFile: resolve('/home/u/keys/orgai.key') }]])
    expect(f.out()).toContain('Created secure storage (key file: /home/u/keys/orgai.key).')
    expect(f.out()).toContain(KEY_FILE_BACKUP_WARNING)
  })

  it('--import goes with --key-file only; a key file inside the data folder is refused before connecting', async () => {
    const { f, client } = setup({ 'secrets:init': () => ({ action: 'opened', status: status({ scheme: 'key-file' }) }) })
    expect(await run(f, ['init', '--import'])).toBe(EXIT.usage)
    expect(await run(f, ['init', '--key-file', '/home/u/OrgAI/data/vault.key'])).toBe(EXIT.usage)
    expect(await run(f, ['init', '--key-file', '/home/u/OrgAI'])).toBe(EXIT.usage)
    expect(f.err()).toContain("outside OrgAI's data folder")
    expect(client.calls).toEqual([])
    expect(await run(f, ['init', '--key-file', '/keys/k', '--import'])).toBe(EXIT.ok)
    expect(client.callsOf('secrets:init')).toEqual([[{ keyFile: resolve('/keys/k'), importKeyFile: true }]])
  })

  it('no flags: the OS scheme; a host refusal is exit 1', async () => {
    const { f, client } = setup({ 'secrets:init': () => ({ action: 'unchanged', status: status() }) })
    expect(await run(f, ['init'])).toBe(EXIT.ok)
    expect(client.callsOf('secrets:init')).toEqual([[{}]])
    expect(f.out()).toContain('Secure storage is already open (macOS keychain).')
    const g = setup({
      'secrets:init': () => {
        throw rpcError({ code: 'bad_request', message: 'The macOS keychain is locked or cannot ask in this session.' })
      }
    })
    expect(await run(g.f, ['init'])).toBe(EXIT.failure)
    expect(g.f.err()).toContain('keychain is locked')
  })
})

describe('orgai secrets reset', () => {
  it('says what is lost before asking; no means nothing is sent', async () => {
    const asked: string[] = []
    manageDeps.ttyConfirm = async (q) => (asked.push(q), false)
    const { f, client } = setup({}, { stdinIsTTY: true })
    expect(await run(f, ['reset'])).toBe(EXIT.failure)
    expect(f.err()).toContain(VAULT_MESSAGES.resetWarning)
    expect(asked).toEqual(['Reset secure storage?'])
    expect(client.calls).toEqual([])
    expect(f.out()).toContain('Nothing changed.')
  })

  it('without a terminal it needs --yes; with --yes it resets and names the moved file', async () => {
    const { f, client } = setup({ 'secrets:reset': () => ({ movedTo: 'vault.json.reset-1762300000000', status: status({ state: 'absent' }) }) })
    expect(await run(f, ['reset'])).toBe(EXIT.usage)
    expect(client.calls).toEqual([])
    expect(await run(f, ['reset', '--yes'])).toBe(EXIT.ok)
    expect(client.callsOf('secrets:reset')).toEqual([[{ confirm: true }]])
    expect(f.out()).toContain('Moved secure storage aside to vault.json.reset-1762300000000 in the data folder.')
    expect(f.err()).toContain(VAULT_MESSAGES.resetWarning)
  })

  it('a busy host refusal is exit 1 with its sentence', async () => {
    const { f } = setup({
      'secrets:reset': () => {
        throw rpcError({ code: 'bad_request', message: VAULT_MESSAGES.resetBusy })
      }
    })
    expect(await run(f, ['reset', '-y'])).toBe(EXIT.failure)
    expect(f.err()).toContain(VAULT_MESSAGES.resetBusy)
  })
})

describe('orgai secrets keep-removed', () => {
  const legacy = (key: string) => ({ key, by: 'legacy' as const, at: Date.UTC(2026, 10, 4), restorable: 'app' as const })
  it('with no key it confirms every soft delete an older OrgAI made, after asking; --yes skips the question', async () => {
    const { f, client } = setup({
      'secrets:status': () => status({ softDeletes: [legacy('a'), { key: 'b', by: 'vault', at: 1, restorable: 'here' }, legacy('c')] }),
      'secrets:confirmDelete': (p) => ({ confirmed: (p as [{ keys: string[] }])[0].keys })
    })
    const code = await run(f, ['keep-removed', '--yes'])
    expect(f.err()).toBe('')
    expect(code).toBe(EXIT.ok)
    expect(client.callsOf('secrets:confirmDelete')[0]).toEqual([{ keys: ['a', 'c'] }])
    expect(f.out()).toContain('Kept 2 secrets removed.')
  })
  it('named keys are sent as given; nothing waiting is exit 0 and sends nothing', async () => {
    const { f, client } = setup({ 'secrets:status': () => status(), 'secrets:confirmDelete': () => ({ confirmed: ['x'] }) })
    expect(await run(f, ['keep-removed'])).toBe(EXIT.ok)
    expect(f.out()).toContain('No secrets removed by an older OrgAI are waiting.')
    expect(client.callsOf('secrets:confirmDelete')).toHaveLength(0)
    expect(await run(f, ['keep-removed', 'x', 'y', '-y'])).toBe(EXIT.ok)
    expect(client.callsOf('secrets:confirmDelete')[0]).toEqual([{ keys: ['x', 'y'] }])
    expect(f.out()).toContain('1 had nothing kept to confirm.')
  })
})

describe('orgai secrets undelete', () => {
  it('restores one key; a refusal with a reason is exit 1; a missing key is exit 2', async () => {
    const answers: Record<string, Answer> = {
      'secrets:undelete': (p) => {
        const key = (p as [{ key: string }])[0].key
        return key === 'mcp:p1:s1:env:TOKEN' ? { restored: true } : { restored: false, reason: VAULT_MESSAGES.undeleteAppOnly }
      }
    }
    const { f, client } = setup(answers)
    expect(await run(f, ['undelete', 'mcp:p1:s1:env:TOKEN'])).toBe(EXIT.ok)
    expect(f.out()).toContain('Restored mcp:p1:s1:env:TOKEN.')
    expect(await run(f, ['undelete', 'connection:litellm:apiKey'])).toBe(EXIT.failure)
    expect(f.out()).toContain(`Not restored: ${VAULT_MESSAGES.undeleteAppOnly}.`)
    expect(await run(f, ['undelete'])).toBe(EXIT.usage)
    expect(await run(f, ['undelete', 'a', 'b'])).toBe(EXIT.usage)
    expect(client.callsOf('secrets:undelete')).toHaveLength(2)
  })

  it('an unknown subcommand is exit 2', async () => {
    const { f } = setup({})
    expect(await run(f, ['show'])).toBe(EXIT.usage)
    expect(await run(f, [])).toBe(EXIT.usage)
  })
})
