import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorPresetStore, buildPresetEntry, presetConnectorDef, validateUserPreset } from './presets'
import { validateLibraryEntry } from './validate'

const http = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'api',
  label: 'API token',
  transport: 'http',
  url: 'https://mcp.acme.test/mcp',
  headers: { 'X-Region': 'eu' },
  readOnly: true,
  auth: { kind: 'token', header: 'Authorization', prefix: 'Bearer ', label: 'API token', help: 'Needs the read scope.' },
  ...over
})

const stdio = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'local',
  label: 'Local server',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@acme/mcp@1.2.3'],
  env: { ACME_REGION: 'eu' },
  readOnly: false,
  auth: { kind: 'token', header: 'ACME_KEY', label: 'API key', help: '' },
  ...over
})

const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'acme-crm',
  name: 'Acme CRM',
  vendor: 'Acme',
  category: 'crm',
  description: 'Reads Acme CRM records.',
  variants: [http(), stdio()],
  defaultVariant: 'api',
  ...over
})

describe('validateUserPreset', () => {
  it('rebuilds a good preset and forces publisher and verified', () => {
    const def = validateUserPreset({ ...good(), publisher: 'official', verified: true, junk: 1, status: 'preview', docsUrl: 'https://docs.acme.test', setup: ['Make a token'], notes: ['Read only'], aliases: ['Acme', 'acme crm'] })
    expect(def.publisher).toBe('user')
    expect(def.verified).toBe(false)
    expect(def).not.toHaveProperty('junk')
    expect(def.status).toBe('preview')
    expect(def.aliases).toEqual(['acme', 'acme crm'])
    expect(def.variants).toHaveLength(2)
    expect(def.variants[0]).toMatchObject({ transport: 'http', url: 'https://mcp.acme.test/mcp', headers: { 'X-Region': 'eu' }, auth: { kind: 'token', header: 'Authorization', prefix: 'Bearer ' } })
    expect(def.variants[1]).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@acme/mcp@1.2.3'], env: { ACME_REGION: 'eu' } })
    // Round trip: validating its own output changes nothing.
    expect(validateUserPreset(def)).toEqual(def)
  })

  it('refuses a curated id, a bad id and non-objects', () => {
    expect(() => validateUserPreset(good({ id: 'gmail' }))).toThrow('That id belongs to a built-in connector.')
    expect(() => validateUserPreset(good({ id: 'Acme_CRM' }))).toThrow(/id must be/)
    expect(() => validateUserPreset(good({ id: 'a'.repeat(49) }))).toThrow(/at most 48|1-48/)
    expect(() => validateUserPreset(null)).toThrow(/object/)
    expect(() => validateUserPreset([])).toThrow(/object/)
    expect(() => validateUserPreset('x')).toThrow(/object/)
  })

  it('refuses hidden characters in many fields and never echoes the value', () => {
    const bad = 'oops‮evil'
    const cases: Record<string, unknown>[] = [
      good({ name: bad }),
      good({ vendor: bad }),
      good({ description: `fine${'​'}secret-text` }),
      good({ setup: [bad] }),
      good({ notes: ['ok', bad] }),
      good({ aliases: [bad] }),
      good({ variants: [http({ label: bad })] }),
      good({ variants: [http({ description: bad })] }),
      good({ variants: [http({ headers: { 'X-A': bad } })] }),
      good({ variants: [http({ auth: { kind: 'token', header: 'Authorization', label: bad, help: '' } })] }),
      good({ variants: [stdio({ command: bad })], defaultVariant: 'local' }),
      good({ variants: [stdio({ args: ['-y', bad] })], defaultVariant: 'local' }),
      good({ variants: [stdio({ env: { ACME_REGION: bad } })], defaultVariant: 'local' }),
      good({ variants: [http({ auth: { kind: 'oauth', scopes: [bad] } })] })
    ]
    for (const c of cases) {
      let message = ''
      try {
        validateUserPreset(c)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, JSON.stringify(c).slice(0, 80)).not.toBe('')
      expect(message).not.toContain('evil')
      expect(message).not.toContain('secret-text')
      expect(message).not.toContain('‮')
    }
  })

  it('allows line breaks only in prose fields', () => {
    expect(validateUserPreset(good({ description: 'Line one\nLine two' })).description).toBe('Line one\nLine two')
    expect(() => validateUserPreset(good({ name: 'Two\nlines' }))).toThrow(/hidden character/)
  })

  it('checks http and sse variants: https, no command, no env, no user info', () => {
    expect(() => validateUserPreset(good({ variants: [http({ url: 'http://mcp.acme.test/mcp' })] }))).toThrow(/https/)
    expect(() => validateUserPreset(good({ variants: [http({ url: 'not a url' })] }))).toThrow(/https/)
    expect(() => validateUserPreset(good({ variants: [http({ url: 'https://u:p@mcp.acme.test/' })] }))).toThrow(/user name/)
    expect(() => validateUserPreset(good({ variants: [http({ command: 'npx' })] }))).toThrow(/cannot have a command/)
    expect(() => validateUserPreset(good({ variants: [http({ env: { A: 'b' } })] }))).toThrow(/env/)
    expect(() => validateUserPreset(good({ variants: [http({ headers: { 'Bad Name': 'x' } })] }))).toThrow(/header name/)
    expect(() => validateUserPreset(good({ variants: [http({ url: `https://a.test/${'x'.repeat(2000)}` })] }))).toThrow()
    const sse = validateUserPreset(good({ variants: [http({ id: 'sse', transport: 'sse' })], defaultVariant: 'sse' }))
    expect(sse.variants[0].transport).toBe('sse')
  })

  it('checks stdio variants: command, no url or headers, pinned launch', () => {
    expect(() => validateUserPreset(good({ variants: [stdio({ url: 'https://a.test' })], defaultVariant: 'local' }))).toThrow(/cannot have an address/)
    expect(() => validateUserPreset(good({ variants: [stdio({ headers: { A: 'b' } })], defaultVariant: 'local' }))).toThrow(/headers/)
    expect(() => validateUserPreset(good({ variants: [stdio({ command: '' })], defaultVariant: 'local' }))).toThrow(/command/)
    expect(() => validateUserPreset(good({ variants: [stdio({ env: { 'bad-name': 'x' } })], defaultVariant: 'local' }))).toThrow(/environment variable name/)
    // Not pinned: the library-entry check reports it against the variant.
    expect(() => validateUserPreset(good({ variants: [stdio({ args: ['-y', '@acme/mcp@latest'] })], defaultVariant: 'local' }))).toThrow(/Variant "local".*exact version/)
    expect(() => validateUserPreset(good({ variants: [stdio({ args: ['-y', '@acme/mcp'] })], defaultVariant: 'local' }))).toThrow(/Variant "local"/)
  })

  it('checks the sign-in per variant', () => {
    expect(() => validateUserPreset(good({ variants: [stdio({ auth: { kind: 'oauth' } })], defaultVariant: 'local' }))).toThrow(/OAuth sign-in needs/)
    expect(() => validateUserPreset(good({ variants: [http({ auth: { kind: 'oauthClient' } })] }))).toThrow(/none, oauth or token/)
    expect(() => validateUserPreset(good({ variants: [http({ auth: undefined })] }))).toThrow(/sign-in/)
    expect(() => validateUserPreset(good({ variants: [http({ auth: { kind: 'token', header: 'bad header', label: 'x', help: '' } })] }))).toThrow(/header name is not valid/)
    expect(() => validateUserPreset(good({ variants: [stdio({ auth: { kind: 'token', header: 'X-Header', label: 'x', help: '' } })], defaultVariant: 'local' }))).toThrow(/environment variable name is not valid/)
    expect(() => validateUserPreset(good({ variants: [http({ auth: { kind: 'token', header: 'Authorization', label: '', help: '' } })] }))).toThrow(/label/)
    expect(() => validateUserPreset(good({ variants: [http({ auth: { kind: 'token', header: 'Authorization', label: 'x', help: 'y', prefix: 'é' } })] }))).toThrow(/ASCII/)
    expect(() => validateUserPreset(good({ variants: [http({ auth: { kind: 'token', header: 'Authorization', label: 'x', help: 'y', link: 'http://a.test' } })] }))).toThrow(/https/)
    // A token slot that is also a plain header is a library-entry conflict.
    expect(() => validateUserPreset(good({ variants: [http({ headers: { Authorization: 'x' } })] }))).toThrow(/Variant "api"/)
    const oauth = validateUserPreset(good({ variants: [http({ auth: { kind: 'oauth', scopes: ['read', 'write'], extra: 1 } })] }))
    expect(oauth.variants[0].auth).toEqual({ kind: 'oauth', scopes: ['read', 'write'] })
    expect(() => validateUserPreset(good({ variants: [http({ auth: { kind: 'oauth', scopes: ['has space'] } })] }))).toThrow(/scope/)
    expect(() => validateUserPreset(good({ variants: [http({ auth: { kind: 'oauth', scopes: Array(21).fill('s') } })] }))).toThrow(/20/)
    expect(validateUserPreset(good({ variants: [http({ auth: { kind: 'none', header: 'x' } })] })).variants[0].auth).toEqual({ kind: 'none' })
  })

  it('enforces the caps', () => {
    expect(() => validateUserPreset(good({ name: '' }))).toThrow(/name/)
    expect(() => validateUserPreset(good({ name: 'n'.repeat(65) }))).toThrow(/name/)
    expect(() => validateUserPreset(good({ vendor: 'v'.repeat(65) }))).toThrow(/vendor/)
    expect(() => validateUserPreset(good({ description: 'd'.repeat(301) }))).toThrow(/description/)
    expect(() => validateUserPreset(good({ description: '' }))).toThrow(/description/)
    expect(() => validateUserPreset(good({ category: 'weather' }))).toThrow(/category/)
    expect(() => validateUserPreset(good({ status: 'beta' }))).toThrow(/status/)
    expect(() => validateUserPreset(good({ docsUrl: 'http://docs.test' }))).toThrow(/https/)
    expect(() => validateUserPreset(good({ setup: Array(11).fill('step') }))).toThrow(/at most 10/)
    expect(() => validateUserPreset(good({ setup: ['s'.repeat(301)] }))).toThrow()
    expect(() => validateUserPreset(good({ notes: Array(11).fill('n') }))).toThrow(/at most 10/)
    expect(() => validateUserPreset(good({ aliases: Array.from({ length: 21 }, (_, i) => `a${i}`) }))).toThrow(/20/)
    expect(() => validateUserPreset(good({ aliases: ['x'.repeat(33)] }))).toThrow()
    expect(() => validateUserPreset(good({ variants: [] }))).toThrow(/1-5 variants/)
    expect(() => validateUserPreset(good({ variants: Array.from({ length: 6 }, (_, i) => http({ id: `v${i}` })) }))).toThrow(/1-5 variants/)
    expect(() => validateUserPreset(good({ variants: [http(), http()] }))).toThrow(/unique/)
    expect(() => validateUserPreset(good({ variants: [http({ id: 'Bad_Id' })] }))).toThrow(/lowercase/)
    expect(() => validateUserPreset(good({ variants: [http({ id: 'v'.repeat(33) })] }))).toThrow()
    expect(() => validateUserPreset(good({ defaultVariant: 'nope' }))).toThrow(/default variant/)
    expect(() => validateUserPreset(good({ variants: [http({ headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, 'v'])) })] }))).toThrow(/at most 20/)
    expect(() => validateUserPreset(good({ variants: [http({ headers: { 'X-A': 'v'.repeat(2001) } })] }))).toThrow()
  })

  it('defaults the default variant to the first and treats empty optionals as absent', () => {
    const def = validateUserPreset(good({ defaultVariant: undefined, docsUrl: '', status: null, setup: [], aliases: [] }))
    expect(def.defaultVariant).toBe('api')
    expect(def).not.toHaveProperty('docsUrl')
    expect(def).not.toHaveProperty('status')
    expect(def).not.toHaveProperty('setup')
    expect(def).not.toHaveProperty('aliases')
  })

  it("keeps origin only when exactly 'kit'", () => {
    expect(validateUserPreset(good({ origin: 'kit' })).origin).toBe('kit')
    expect(validateUserPreset(good({ origin: 'other' }))).not.toHaveProperty('origin')
    expect(validateUserPreset(good({ origin: 7 }))).not.toHaveProperty('origin')
  })

  it('ignores prototype fields', () => {
    const polluted = Object.create({ id: 'inherited', name: 'x' }) as Record<string, unknown>
    expect(() => validateUserPreset(polluted)).toThrow()
  })
})

describe('presetConnectorDef', () => {
  it('projects the preset as a ConnectorDef', () => {
    const def = validateUserPreset(good())
    const c = presetConnectorDef(def)
    expect(c).toMatchObject({ id: 'acme-crm', publisher: 'user', status: 'stable', docsUrl: '', setup: [], verified: false, defaultVariant: 'api' })
    expect(c.variants[0]).toMatchObject({ id: 'api', transport: 'http', url: 'https://mcp.acme.test/mcp', headers: { 'X-Region': 'eu' } })
    expect(c.variants[1]).toMatchObject({ id: 'local', transport: 'stdio', url: '' })
    expect(c.variants[1]).not.toHaveProperty('command')
    expect(c.variants[1].auth).toMatchObject({ kind: 'token', header: 'ACME_KEY' })
    // A copy: editing the projection does not touch the preset.
    c.variants[0].headers!['X-Region'] = 'us'
    expect(def.variants[0].headers).toEqual({ 'X-Region': 'eu' })
  })
})

describe('buildPresetEntry', () => {
  const def = validateUserPreset(good())
  const now = new Date('2026-06-01T00:00:00.000Z')

  it('builds an http entry with a secret header slot', () => {
    const e = buildPresetEntry(def, def.variants[0], 'mcpl_1', [], now)
    expect(e).toMatchObject({
      id: 'mcpl_1',
      name: 'acme-crm',
      transport: 'http',
      url: 'https://mcp.acme.test/mcp',
      headers: { 'X-Region': 'eu' },
      secretHeaders: ['Authorization'],
      source: 'user',
      connectorId: 'acme-crm',
      connectorVariant: 'api',
      connectorCustom: true
    })
    expect(e).not.toHaveProperty('secretEnv')
    expect(validateLibraryEntry(e, [])).toEqual([])
  })

  it('builds a stdio entry with a secret env slot', () => {
    const e = buildPresetEntry(def, def.variants[1], 'mcpl_2', [], now)
    expect(e).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@acme/mcp@1.2.3'], env: { ACME_REGION: 'eu' }, secretEnv: ['ACME_KEY'], connectorCustom: true })
    expect(e).not.toHaveProperty('url')
    expect(e).not.toHaveProperty('secretHeaders')
    expect(validateLibraryEntry(e, [])).toEqual([])
  })

  it('takes a free name when the id is taken', () => {
    expect(buildPresetEntry(def, def.variants[0], 'mcpl_3', ['acme-crm'], now).name).toBe('acme-crm-2')
  })
})

describe('ConnectorPresetStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orgai-presets-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('saves, lists clones, reloads and removes', () => {
    const store = new ConnectorPresetStore(dir)
    expect(store.list()).toEqual([])
    store.save(validateUserPreset(good()))
    store.save(validateUserPreset(good({ id: 'beta-tool', name: 'Beta' })))
    const first = store.list()
    expect(first.map((p) => p.id)).toEqual(['acme-crm', 'beta-tool'])
    first[0].name = 'Changed'
    expect(store.get('acme-crm')!.name).toBe('Acme CRM')
    store.save(validateUserPreset(good({ name: 'Acme CRM 2' })))
    expect(store.list().map((p) => p.name)).toEqual(['Acme CRM 2', 'Beta'])
    const file = JSON.parse(readFileSync(join(dir, 'connector-presets.json'), 'utf8')) as { version: number; presets: unknown[] }
    expect(file.version).toBe(1)
    expect(file.presets).toHaveLength(2)
    expect(existsSync(join(dir, 'connector-presets.json.tmp'))).toBe(false)
    expect(new ConnectorPresetStore(dir).list().map((p) => p.id)).toEqual(['acme-crm', 'beta-tool'])
    expect(store.remove('acme-crm')).toBe(true)
    expect(store.remove('acme-crm')).toBe(false)
    expect(new ConnectorPresetStore(dir).list().map((p) => p.id)).toEqual(['beta-tool'])
  })

  it('drops invalid records on load without naming field values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = validateUserPreset(good())
    writeFileSync(
      join(dir, 'connector-presets.json'),
      JSON.stringify({
        version: 1,
        presets: [ok, { ...good({ id: 'gmail' }) }, { ...good({ id: 'evil', name: 'x‮y-secret' }) }, 'junk', { ...ok }, { ...good({ id: 'plain-http', variants: [http({ url: 'http://a.test' })] }) }]
      })
    )
    const store = new ConnectorPresetStore(dir)
    expect(store.list().map((p) => p.id)).toEqual(['acme-crm'])
    expect(warn).toHaveBeenCalled()
    for (const call of warn.mock.calls) expect(String(call[0])).not.toMatch(/secret|gmail|evil/)
  })

  it('starts empty on a corrupt file', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(join(dir, 'connector-presets.json'), '{not json')
    expect(new ConnectorPresetStore(dir).list()).toEqual([])
  })

  it('refuses to save an invalid preset', () => {
    const store = new ConnectorPresetStore(dir)
    expect(() => store.save({ ...validateUserPreset(good()), id: 'gmail' })).toThrow('That id belongs to a built-in connector.')
  })
})
