import { describe, expect, it } from 'vitest'
import type { ConnectorInfo } from '@shared/types'
import { CONNECTORS, connectorEase } from '@shared/connectors'
import type { UserConnectorDef } from './mcpScope'
import {
  accessOptionCount,
  accessWords,
  canAddPreset,
  clampText,
  customNote,
  defToDraft,
  draftToDef,
  duplicateDraft,
  gallerySections,
  kebabId,
  matchesFilter,
  newPresetDraft,
  newVariantDraft,
  presetErrorOrder,
  presetKindWord,
  presetLocked,
  sameDraft,
  validatePreset,
  variantCommandLine,
  type PresetDraft,
  noteForUser,
  connectMissing,
  connectorInitial,
  filterConnectors,
  filterLibrary,
  libraryMatchRank,
  matchRank,
  honestyNote,
  missingSentence,
  plainToolName,
  removeConsequence,
  roleAccessSummary,
  sortForGallery,
  stateChip
} from './connectors'

import { BRAND_GAPS, BRAND_MARKS, brandMark } from '../components/brand/brandMarks'

describe('brand marks', () => {
  it('every connector and provider id has a mark or is a listed gap', () => {
    for (const id of [...CONNECTORS.map((c) => c.id), 'anthropic', 'openai', 'litellm']) {
      expect(brandMark(id) !== null || (BRAND_GAPS as readonly string[]).includes(id), id).toBe(true)
    }
  })
  it('path data is non-empty SVG path characters and colours are hex', () => {
    for (const [id, m] of Object.entries(BRAND_MARKS)) {
      expect(m.d.length, id).toBeGreaterThan(20)
      for (const d of [m.d, ...(m.extra ?? []).map((p) => p.d)]) expect(d, id).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/)
      for (const h of [m.hex, ...(m.extra ?? []).map((p) => p.hex)]) if (h !== null) expect(h, id).toMatch(/^#[0-9A-F]{6}$/)
      if (m.viewBox) expect(m.viewBox, id).toMatch(/^0 0 \d+ \d+$/)
    }
  })
  it('gaps have no mark', () => {
    for (const id of BRAND_GAPS) expect(brandMark(id)).toBeNull()
  })
})

const info = (i: number, state: ConnectorInfo['state']): ConnectorInfo => ({ connector: CONNECTORS[i], state })

describe('connectors lib', () => {
  it('chips say words', () => {
    expect(stateChip(info(0, 'available')).label).toBe('Not connected')
    expect(stateChip(info(0, 'needsSetup')).label).toBe('Not signed in')
    expect(stateChip(info(0, 'error')).tone).toBe('danger')
    expect(stateChip(info(0, 'connected')).label).toBe('Connected')
  })
  it('names the account', () => {
    const c = { ...info(0, 'connected'), library: { auth: { state: 'authorized', account: 'a@b.c' } } } as unknown as ConnectorInfo
    expect(stateChip(c).label).toBe('Connected as a@b.c')
  })
  it('initials', () => {
    expect(connectorInitial({ name: 'Slack' })).toBe('S')
    expect(connectorInitial({ name: 'Google Drive' })).toBe('GD')
  })
  it('access words', () => {
    expect(accessWords({ readOnly: true })).toBe('Can read')
    expect(accessWords({ readOnly: false })).toBe('Can read and change')
  })
  it('lists what is missing per auth kind', () => {
    expect(connectMissing({ kind: 'oauth' }, { clientId: '', clientSecret: '', token: '' })).toEqual([])
    const oc = { kind: 'oauthClient', consoleUrl: 'https://x.y', clientSecret: 'required' } as const
    expect(connectMissing(oc, { clientId: ' ', clientSecret: '', token: '' })).toEqual(['Client ID', 'Client secret'])
    expect(connectMissing({ ...oc, clientSecret: 'optional' }, { clientId: 'a', clientSecret: '', token: '' })).toEqual([])
    const t = { kind: 'token', header: 'Authorization', label: 'Access token', help: '' } as const
    expect(connectMissing(t, { clientId: '', clientSecret: '', token: '' })).toEqual(['Access token'])
    expect(missingSentence(['Client ID', 'Client secret'])).toBe('Add the Client ID and Client secret to continue.')
    expect(missingSentence([])).toBe('')
  })
  it('honesty note', () => {
    expect(honestyNote({ status: 'preview', verified: false })).toMatch(/not yet tested/i)
    expect(honestyNote({ status: 'stable', verified: true })).toBeUndefined()
  })
  it('plain tool names', () => {
    expect(plainToolName('search_messages')).toBe('Search messages')
    expect(plainToolName('listIssues')).toBe('List issues')
    expect(plainToolName('mcp__slack__send_message')).toBe('Send message')
  })
  it('names roles', () => {
    const roles = [
      { slug: 'a', name: 'Reviewer' },
      { slug: 'b', name: 'Researcher' },
      { slug: 'c', name: 'Lead' }
    ]
    expect(roleAccessSummary(roles, undefined)).toBe('All roles')
    expect(roleAccessSummary(roles, ['a', 'b'])).toBe('Reviewer, Researcher')
    expect(roleAccessSummary(roles, [])).toBe('No roles')
    expect(roleAccessSummary([], undefined)).toBe('No roles yet')
  })
  it('sorts connected first and filters', () => {
    const list = [info(0, 'available'), info(1, 'connected'), info(2, 'needsSetup')]
    expect(sortForGallery(list).map((i) => i.state)).toEqual(['connected', 'needsSetup', 'available'])
    expect(filterConnectors(list, CONNECTORS[1].name.toLowerCase()).length).toBeGreaterThan(0)
    expect(filterConnectors(list, 'zzzz-none')).toEqual([])
  })
  it('consequence names projects', () => {
    expect(removeConsequence([{ projectName: 'Acme' }], 'remove')).toContain('Acme will lose access')
    expect(removeConsequence([], 'disconnect')).toContain('No project')
  })
})

describe('ease keywords', () => {
  it('the bare words "client" and "open" do not match whole methods; phrases still do', () => {
    const own = CONNECTORS.filter((c) => connectorEase(c) === 'ownApp')
    expect(own.length).toBeGreaterThan(0)
    for (const c of own) {
      const text = [c.name, c.vendor, c.description, ...(c.aliases ?? [])].join(' ').toLowerCase()
      if (!text.includes('client')) expect(matchRank(c, 'client')).toBeNull()
      expect(matchRank(c, 'client id')).not.toBeNull()
    }
  })
})

describe('saved server search', () => {
  const idp = { entry: { name: 'client-idp-admin', description: 'Admin tools for the identity provider' } }
  const crm = { entry: { name: 'acme-crm' } }
  it('ranks name start, name word, name substring, then description', () => {
    expect(libraryMatchRank(idp.entry, 'client')).toBe(0)
    expect(libraryMatchRank(idp.entry, 'idp')).toBe(1)
    expect(libraryMatchRank(idp.entry, 'dmin')).toBe(2)
    expect(libraryMatchRank(idp.entry, 'identity')).toBe(3)
    expect(libraryMatchRank(idp.entry, 'zzz')).toBeNull()
  })
  it('needs every word and treats an empty query as a match', () => {
    expect(libraryMatchRank(idp.entry, 'idp provider')).toBe(3)
    expect(libraryMatchRank(idp.entry, 'idp zzz')).toBeNull()
    expect(libraryMatchRank(crm.entry, '  ')).toBe(0)
  })
  it('filters and orders best first', () => {
    expect(filterLibrary([crm, idp], 'idp')).toEqual([idp])
    expect(filterLibrary([crm, idp], '')).toEqual([crm, idp])
    expect(filterLibrary([idp, { entry: { name: 'x', description: 'idp helper' } }], 'idp')[0]).toBe(idp)
  })
})

describe('clampText', () => {
  it('keeps short text and clamps long text with an ellipsis', () => {
    expect(clampText('abc', 5)).toBe('abc')
    expect(clampText('abcdef', 4)).toBe('abc…')
    expect(Array.from(clampText('x'.repeat(500), 200))).toHaveLength(200)
    expect(clampText('abc', 0)).toBe('')
  })
})

describe('noteForUser', () => {
  it('hides developer caveats and implementation details', () => {
    expect(noteForUser(['Unverified: dynamic client registration.', 'The token is stored with Electron safeStorage and sent as Authorization: Bearer.'], 'X')).toEqual([])
  })
  it('drops the preview and untested caveats the dialog already says once', () => {
    expect(noteForUser(['Google lists its Workspace MCP servers as a Developer Preview: join the program.', 'Not yet tested with OrgAI.', 'Keep it.'], 'X')).toEqual(['Keep it.'])
  })
  it('puts the redirect caveat first in plain words and keeps useful notes', () => {
    const out = noteForUser(['The server includes write tools.', 'Slack documents that redirect URLs must use HTTPS. Unverified.', 'Unverified: the token response shape.'], 'Slack')
    expect(out).toEqual(["Slack may refuse OrgAI's sign-in address or need an admin's approval.", 'The server includes write tools.'])
    expect(noteForUser(undefined, 'X')).toEqual([])
  })
})

const custom = (id: string, state: ConnectorInfo['state'] = 'available'): ConnectorInfo =>
  ({ connector: { ...CONNECTORS[0], id, name: id }, state, custom: true }) as unknown as ConnectorInfo

describe('custom presets in the gallery', () => {
  it('the Yours filter matches only presets', () => {
    expect(matchesFilter(custom('acme'), 'custom')).toBe(true)
    expect(matchesFilter(info(0, 'available'), 'custom')).toBe(false)
  })
  it('presets rank like curated entries by state', () => {
    const out = sortForGallery([info(0, 'available'), custom('zzz', 'connected'), custom('aaa')])
    expect(out[0].connector.id).toBe('zzz')
  })
  it('past the threshold an unconnected preset leads its own group', () => {
    const many = CONNECTORS.slice(0, 26).map((c) => ({ connector: c, state: 'available' }) as ConnectorInfo)
    const sections = gallerySections([...many, custom('acme')], { query: '', filter: 'all' })
    expect(sections[0].key).toBe('custom')
    expect(sections[0].title).toBe('Your presets')
    expect(sections.flatMap((s) => s.items).filter((i) => i.connector.id === 'acme')).toHaveLength(1)
  })
  it('a connected preset sits with Connected, not in the presets group', () => {
    const many = CONNECTORS.slice(0, 26).map((c) => ({ connector: c, state: 'available' }) as ConnectorInfo)
    const sections = gallerySections([...many, custom('acme', 'connected')], { query: '', filter: 'all' })
    expect(sections[0].key).toBe('connected')
    expect(sections.some((s) => s.key === 'custom')).toBe(false)
  })
})

describe('preset draft', () => {
  const remote = (): PresetDraft => ({ ...newPresetDraft(), name: 'Acme CRM', url: 'https://crm.acme.test/mcp' })

  it('a valid remote draft saves with no sign-in and one option', () => {
    const d = remote()
    expect(validatePreset(d)).toEqual({})
    const def = draftToDef(d, 'acme-crm')
    expect(def.publisher).toBe('user')
    expect(def.verified).toBe(false)
    expect(def.variants).toHaveLength(1)
    expect(def.variants[0]).toMatchObject({ transport: 'http', url: 'https://crm.acme.test/mcp', auth: { kind: 'none' }, readOnly: false })
    expect(def.defaultVariant).toBe(def.variants[0].id)
    expect(def.description).not.toBe('')
  })
  it('asks for the name and an https address', () => {
    const d = { ...newPresetDraft(), url: 'http://x.test' }
    expect(validatePreset(d).name).toBeTruthy()
    expect(validatePreset(d).url).toMatch(/https/)
    expect(validatePreset({ ...remote(), url: 'https://user:pw@x.test' }).url).toMatch(/user name/)
    expect(validatePreset({ ...remote(), url: '' }).url).toBeTruthy()
  })
  it('a token needs a name that fits a header, or a variable for a program', () => {
    const d: PresetDraft = { ...remote(), auth: 'token', tokenName: 'bad name' }
    expect(validatePreset(d).tokenName).toBeTruthy()
    expect(validatePreset({ ...d, tokenName: 'X-Api-Key' }).tokenName).toBeUndefined()
    const prog: PresetDraft = { ...newPresetDraft(), name: 'Local', transport: 'stdio', command: 'node', auth: 'token', tokenName: 'X-Key' }
    expect(validatePreset(prog).tokenName).toBeTruthy()
    expect(validatePreset({ ...prog, tokenName: 'API_TOKEN' }).tokenName).toBeUndefined()
  })
  it('browser sign-in is refused for a program', () => {
    const prog: PresetDraft = { ...newPresetDraft(), name: 'Local', transport: 'stdio', command: 'node', auth: 'oauth' }
    expect(validatePreset(prog).auth).toMatch(/remote/)
    expect(draftToDef({ ...prog, auth: 'none' }, 'local').variants[0].auth).toEqual({ kind: 'none' })
  })
  it('builds a token auth with a prefix that ends in a space and an optional link', () => {
    const d: PresetDraft = { ...remote(), auth: 'token', tokenPrefix: 'Bearer', tokenHelp: 'https://acme.test/keys' }
    const a = draftToDef(d, 'acme-crm').variants[0].auth
    expect(a).toMatchObject({ kind: 'token', header: 'Authorization', prefix: 'Bearer ', link: 'https://acme.test/keys' })
    expect(validatePreset({ ...d, tokenHelp: 'ftp://x' }).tokenHelp).toBeTruthy()
  })
  it('rejects hidden characters and duplicate fixed values', () => {
    expect(validatePreset({ ...remote(), name: 'Acme​' }).name).toMatch(/hidden/)
    const d = remote()
    const rows = [
      { rid: 'a', name: 'X-One', value: '1' },
      { rid: 'b', name: 'x-one', value: '2' }
    ]
    expect(validatePreset({ ...d, rows })['row:b']).toBe('Already listed.')
    expect(validatePreset({ ...d, rows: [{ rid: 'c', name: '', value: '' }] })).toEqual({})
    expect(validatePreset({ ...d, rows: [{ rid: 'c', name: '', value: 'v' }] })['row:c']).toBeTruthy()
  })
  it('the token name cannot also be a fixed value', () => {
    const d: PresetDraft = { ...remote(), auth: 'token', rows: [{ rid: 'a', name: 'authorization', value: 'x' }] }
    expect(validatePreset(d)['row:a']).toMatch(/token/)
  })
  it('access options: names are unique, at most five, one default', () => {
    const d = remote()
    const a = newVariantDraft('Read only', true)
    const dup = { ...validatePreset({ ...d, variants: [...d.variants, { ...a, label: 'standard' }] }) }
    expect(Object.values(dup).some((m) => /another option/i.test(m))).toBe(true)
    const six = { ...d, variants: Array.from({ length: 6 }, (_, i) => newVariantDraft(`Option ${i}`)) }
    expect(validatePreset(six).variants).toBeTruthy()
    const two: PresetDraft = { ...d, variants: [...d.variants, a] }
    const def = draftToDef({ ...two, defaultRid: a.rid }, 'acme-crm')
    expect(def.variants.map((v) => v.id)).toEqual(['standard', 'read-only'])
    expect(def.defaultVariant).toBe('read-only')
    expect(def.variants[1].readOnly).toBe(true)
  })
  it('an option may use its own address', () => {
    const d = remote()
    const ro = { ...newVariantDraft('Read only', true), extra: 'https://crm.acme.test/mcp?readonly=1' }
    const def = draftToDef({ ...d, variants: [...d.variants, ro] }, 'acme-crm')
    expect(def.variants[1].url).toBe('https://crm.acme.test/mcp?readonly=1')
    expect(validatePreset({ ...d, variants: [...d.variants, { ...ro, extra: 'http://x' }] })[`variant:${ro.rid}`]).toMatch(/https/)
  })
  it('a program keeps its command, arguments, fixed variables and per-option extra arguments', () => {
    const d: PresetDraft = {
      ...newPresetDraft(),
      name: 'Local DB',
      transport: 'stdio',
      command: 'npx',
      args: '-y\n@acme/db-mcp@1.2.3\n',
      rows: [{ rid: 'r', name: 'DB_HOST', value: 'localhost' }]
    }
    const ro = { ...newVariantDraft('Read only', true), extra: '--read-only' }
    const def = draftToDef({ ...d, variants: [...d.variants, ro] }, 'local-db')
    expect(def.variants[0]).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', '@acme/db-mcp@1.2.3'], env: { DB_HOST: 'localhost' } })
    expect(def.variants[1].args).toEqual(['-y', '@acme/db-mcp@1.2.3', '--read-only'])
    expect(variantCommandLine(def.variants[1])).toBe('DB_HOST=localhost npx -y @acme/db-mcp@1.2.3 --read-only')
    expect(presetKindWord(def)).toBe('Program')
  })
  it('round trips through the form', () => {
    const d: PresetDraft = { ...remote(), description: 'Customers', aliases: 'Clients, crm ,CRM', auth: 'token', tokenPrefix: 'Bearer', tokenHelp: 'https://acme.test/k', rows: [{ rid: 'r', name: 'X-Team', value: 'a' }] }
    const ro = { ...newVariantDraft('Read only', true), extra: 'https://crm.acme.test/ro' }
    const def = draftToDef({ ...d, variants: [...d.variants, ro], defaultRid: ro.rid }, 'acme-crm')
    const back = defToDraft(def)
    expect(back.aliases).toBe('clients, crm')
    expect(back.tokenPrefix).toBe('Bearer')
    expect(back.rows.map((r) => [r.name, r.value])).toEqual([['X-Team', 'a']])
    // The default option supplies the shared address, so the other option carries its own.
    expect(back.url).toBe('https://crm.acme.test/ro')
    expect(back.variants.map((v) => [v.label, v.extra])).toEqual([
      ['Standard', 'https://crm.acme.test/mcp'],
      ['Read only', '']
    ])
    expect(back.variants.find((v) => v.rid === back.defaultRid)?.label).toBe('Read only')
    expect(draftToDef(back, 'acme-crm')).toEqual(def)
  })
  it('editing keeps every field the form does not hold', () => {
    const def: UserConnectorDef = {
      id: 'acme-crm',
      name: 'Acme CRM',
      vendor: 'Acme Inc',
      publisher: 'user',
      category: 'data',
      description: 'Customers',
      status: 'preview',
      docsUrl: 'https://acme.test/docs',
      variants: [
        { id: 'full', label: 'Full', description: 'All of it', transport: 'sse', url: 'https://crm.acme.test/sse', readOnly: false, auth: { kind: 'token', header: 'Authorization', prefix: 'Bearer', label: 'Acme key', help: 'Find it in Account', link: 'https://acme.test/k' } },
        { id: 'ro', label: 'Read only', description: 'Reads', transport: 'sse', url: 'https://crm.acme.test/ro', readOnly: true, auth: { kind: 'token', header: 'Authorization', prefix: 'Bearer', label: 'Acme key', help: 'Find it in Account', link: 'https://acme.test/k' } }
      ],
      defaultVariant: 'full',
      setup: ['Open Account'],
      notes: ['Beta'],
      aliases: ['crm'],
      verified: false
    }
    expect(presetLocked(def)).toBe(false)
    expect(draftToDef(defToDraft(def), def.id, undefined, def)).toEqual(def)
    const oauth: UserConnectorDef = { ...def, variants: def.variants.map((v) => ({ ...v, auth: { kind: 'oauth' as const, scopes: ['read', 'write'] } })) }
    expect(draftToDef(defToDraft(oauth), oauth.id, undefined, oauth)).toEqual(oauth)
    const edited = draftToDef({ ...defToDraft(def), name: 'Acme CRM 2' }, def.id, undefined, def)
    expect(edited.vendor).toBe('Acme Inc')
    expect(edited.variants[0].description).toBe('All of it')
    expect(edited.variants[0].auth).toMatchObject({ label: 'Acme key', help: 'Find it in Account', prefix: 'Bearer' })
  })
  it('a preset with divergent options is locked and round trips exactly', () => {
    const def: UserConnectorDef = {
      id: 'local-db',
      name: 'Local DB',
      vendor: 'You',
      publisher: 'user',
      category: 'data',
      description: 'DB',
      variants: [
        { id: 'a', label: 'A', transport: 'stdio', command: 'npx', args: ['-y', 'db@1'], readOnly: false, auth: { kind: 'none' } },
        { id: 'b', label: 'B', transport: 'stdio', command: 'npx', args: ['--other', 'db@2'], env: { X: '1' }, readOnly: true, auth: { kind: 'none' } }
      ],
      defaultVariant: 'a',
      verified: false
    }
    expect(presetLocked(def)).toBe(true)
    expect(draftToDef(defToDraft(def), def.id, undefined, def)).toEqual(def)
    const renamed = draftToDef({ ...defToDraft(def), description: 'Other' }, def.id, undefined, def)
    expect(renamed.variants[1].args).toEqual(['--other', 'db@2'])
    expect(renamed.variants[1].env).toEqual({ X: '1' })
  })
  it('keeps a kit origin and drops it on a duplicate name', () => {
    const def = draftToDef(remote(), 'acme-crm', 'kit')
    expect(def.origin).toBe('kit')
    expect(duplicateDraft(def, ['Acme CRM']).name).toBe('Acme CRM copy')
    expect(duplicateDraft(def, ['Acme CRM', 'Acme CRM copy']).name).toBe('Acme CRM copy 2')
  })
  it('kebab ids are unique and never empty', () => {
    expect(kebabId('Acme CRM!', new Set())).toBe('acme-crm')
    expect(kebabId('Acme CRM', new Set(['acme-crm']))).toBe('acme-crm-2')
    expect(kebabId('!!!', new Set())).toBe('service')
  })
  it('words for the list', () => {
    expect(accessOptionCount(1)).toBe('1 access option')
    expect(accessOptionCount(2)).toBe('2 access options')
    expect(customNote('kit')).toMatch(/imported kit/)
    expect(customNote(undefined)).toMatch(/described this service yourself/)
    expect(canAddPreset(99)).toBe(true)
    expect(canAddPreset(100)).toBe(false)
  })
  it('sameDraft ignores blank rows and row keys', () => {
    const a = remote()
    expect(sameDraft(a, { ...a, rows: [{ rid: 'x', name: '', value: '' }] })).toBe(true)
    expect(sameDraft(a, { ...a, name: 'Other' })).toBe(false)
  })
  it('lists the first problem in form order', () => {
    const d = { ...newPresetDraft(), url: '' }
    const errs = validatePreset(d)
    const order = presetErrorOrder(d)
    expect(order.find((k) => errs[k])).toBe('name')
  })
})
