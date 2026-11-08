import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0', isPackaged: false, on: () => {} },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  safeStorage: { isEncryptionAvailable: () => false },
  nativeTheme: { on: () => {} },
  Notification: class {}
}))

const { CONNECTOR_TOKEN_MAX_CHARS, PICKED_FOLDERS_PER_SENDER, PickedFolders, connectorArgs, proposalDecideArgs, PROPOSAL_SECRETS_MAX, PERMISSION_RULE_MAX_CHARS, permissionAddRefusal, permissionRuleArgs, settingsSetArgs, connectionIdArg, connectionSecretArgs, proxyCreateArgs, proxyIdArg, CONNECTION_SECRET_MAX_CHARS, modelsQueryArg, withEffectiveDefault } = await import('./ipc')
const { normalizeSettings } = await import('./store/settings')
const { DEFAULT_APP_SETTINGS } = await import('@shared/defaults')
const { openPathRefusal, lstatDirectory, OPEN_PATH_REFUSAL } = await import('./ipc')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const { listIgnoredRules, removeRule, addRules } = await import('./runtime/permissionRules')
const { mcpCopyArgs } = await import('./ipc')
const { repoCloneArgs, repoCancelArg, watchSenderGone } = await import('./ipc')
const { EventEmitter } = await import('node:events')

describe('watchSenderGone (projects:cloneRepo)', () => {
  it('fires once per gone-event: destroyed, render-process-gone and a main-frame navigation', () => {
    for (const [event, args, fires] of [
      ['destroyed', [], true],
      ['render-process-gone', [{}, { reason: 'crashed' }], true],
      ['did-start-navigation', [{ isMainFrame: true, isSameDocument: false }], true],
      ['did-start-navigation', [{ isMainFrame: false, isSameDocument: false }], false],
      ['did-start-navigation', [{ isMainFrame: true, isSameDocument: true }], false],
      ['did-start-navigation', [], false]
    ] as [string, unknown[], boolean][]) {
      const sender = new EventEmitter()
      const onGone = vi.fn()
      watchSenderGone(sender, onGone)
      sender.emit(event, ...args)
      expect(onGone, event).toHaveBeenCalledTimes(fires ? 1 : 0)
    }
  })
  it('removes every listener when the clone ends', () => {
    const sender = new EventEmitter()
    const onGone = vi.fn()
    const stop = watchSenderGone(sender, onGone)
    expect(sender.eventNames().length).toBe(3)
    stop()
    expect(sender.eventNames().length).toBe(0)
    sender.emit('destroyed')
    expect(onGone).not.toHaveBeenCalled()
  })
})

describe('repoCloneArgs / repoCancelArg (projects:cloneRepo)', () => {
  const good = { requestId: 'req_1-A', source: 'https://github.com/o/r', mode: 'clone', destination: '/x/y' }
  it('rebuilds the four fields and drops the rest', () => {
    expect(repoCloneArgs({ ...good, extra: 1, nested: { a: 1 } })).toEqual(good)
    expect(repoCloneArgs({ ...good, mode: 'fork' }).mode).toBe('fork')
    expect(repoCloneArgs(Object.assign(Object.create(null), good))).toEqual(good)
  })
  it('refuses a wrong shape with one fixed line that never quotes the input', () => {
    const secret = 'ghp_secret'
    const bads: unknown[] = [
      null, undefined, 'x', 5, [], new Map(),
      { ...good, requestId: '' }, { ...good, requestId: 'a'.repeat(65) }, { ...good, requestId: 'a b' }, { ...good, requestId: '../x' }, { ...good, requestId: 5 },
      { ...good, source: 5 }, { ...good, source: undefined }, { ...good, source: `https://${secret}@x/` + 'a'.repeat(2000) },
      { ...good, mode: 'copy' }, { ...good, mode: undefined }, { ...good, mode: ['clone'] },
      { ...good, destination: 5 }, { ...good, destination: '' }, { ...good, destination: '   ' }, { ...good, destination: 'x'.repeat(3000) }
    ]
    for (const bad of bads) {
      let message = ''
      try {
        repoCloneArgs(bad)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, JSON.stringify(bad)?.slice(0, 60)).toBeTruthy()
      expect(message).not.toContain(secret)
      expect(message).not.toContain('\n')
    }
  })
  it('lets the service judge the text itself (a bad address still passes the shape check)', () => {
    expect(repoCloneArgs({ ...good, source: 'file:///x' }).source).toBe('file:///x')
  })
  it('repoCancelArg accepts only a request id', () => {
    expect(repoCancelArg('abc_1')).toBe('abc_1')
    for (const bad of [undefined, 5, '', 'a b', 'a'.repeat(65), {}]) expect(() => repoCancelArg(bad)).toThrow('Invalid clone request.')
  })
})

describe('mcpCopyArgs (mcp:copyFromLibrary)', () => {
  it('rebuilds the three fields and drops the rest', () => {
    expect(mcpCopyArgs({ projectId: 'p_1', serverId: 'mcp-1', copySecrets: false, extra: 'x', roles: ['a'] })).toEqual({ projectId: 'p_1', serverId: 'mcp-1', copySecrets: false })
  })
  it('refuses a wrong shape', () => {
    for (const bad of [null, undefined, 'x', [], {}, { projectId: 'p', serverId: 's' }, { projectId: 'p', serverId: 's', copySecrets: 'true' }, { projectId: '../x', serverId: 's', copySecrets: true }, { projectId: 'p', serverId: '', copySecrets: true }, { projectId: 5, serverId: 's', copySecrets: true }]) {
      expect(() => mcpCopyArgs(bad), JSON.stringify(bad)).toThrow('Invalid copy request.')
    }
  })
})

const { mcpSecretArgs, mcpLibrarySecretArgs } = await import('./ipc')

describe('mcpSecretArgs / mcpLibrarySecretArgs', () => {
  it('rebuilds the fields and drops extras', () => {
    expect(mcpSecretArgs({ projectId: 'p_1', serverId: 's-1', kind: 'env', name: 'TOKEN', value: 'abc', extra: 1 })).toEqual({ projectId: 'p_1', serverId: 's-1', kind: 'env', name: 'TOKEN', value: 'abc' })
    expect(mcpSecretArgs({ projectId: 'p_1', serverId: 's-1', kind: 'header', name: 'X-Key', value: null })).toEqual({ projectId: 'p_1', serverId: 's-1', kind: 'header', name: 'X-Key', value: null })
    expect(mcpLibrarySecretArgs({ libraryId: 'lib_1', kind: 'env', name: 'T', value: 'v', junk: true })).toEqual({ libraryId: 'lib_1', kind: 'env', name: 'T', value: 'v' })
  })
  it('refuses bad shapes without echoing the value', () => {
    const base = { projectId: 'p_1', serverId: 's-1', kind: 'env', name: 'T', value: 'v' }
    const bads: unknown[] = [null, 'x', [], { ...base, projectId: '../x' }, { ...base, serverId: '' }, { ...base, kind: 'other' }, { ...base, name: '' }, { ...base, name: 'n'.repeat(129) }, { ...base, value: 5 }, { ...base, value: undefined }, { ...base, value: 'a'.repeat(4001) }, { ...base, value: 'line\nbreak' }, { ...base, value: 'zero​width' }]
    for (const bad of bads) {
      expect(() => mcpSecretArgs(bad)).toThrow('Invalid secret.')
    }
    try {
      mcpSecretArgs({ ...base, value: 'sekrit\nvalue' })
    } catch (e) {
      expect((e as Error).message).not.toContain('sekrit')
    }
    expect(() => mcpLibrarySecretArgs({ ...base, libraryId: '' })).toThrow('Invalid secret.')
    expect(() => mcpLibrarySecretArgs({ libraryId: 'l', kind: 'env', name: 'T' })).toThrow('Invalid secret.')
  })
})

const { mcpOverridesArgs, presetRemoveArgs, OVERRIDES_MAX_KEYS } = await import('./ipc')

describe('mcpOverridesArgs (mcp:setProjectOverrides)', () => {
  it('rebuilds the fields, keeps absent maps absent and drops extras', () => {
    expect(mcpOverridesArgs({ projectId: 'p_1', serverId: 'mcp-1', env: { A: 'b' }, headers: {}, roles: ['x'] })).toEqual({ projectId: 'p_1', serverId: 'mcp-1', env: { A: 'b' }, headers: {} })
    const only = mcpOverridesArgs({ projectId: 'p_1', serverId: 'mcp-1' })
    expect(only).toEqual({ projectId: 'p_1', serverId: 'mcp-1' })
    expect(only).not.toHaveProperty('env')
    expect(mcpOverridesArgs({ projectId: 'p', serverId: 's', env: undefined })).toEqual({ projectId: 'p', serverId: 's' })
  })
  it('returns copies, never the input maps', () => {
    const env = { A: 'b' }
    const out = mcpOverridesArgs({ projectId: 'p', serverId: 's', env })
    expect(out.env).toEqual(env)
    expect(out.env).not.toBe(env)
  })
  it('refuses a wrong shape', () => {
    const many = Object.fromEntries(Array.from({ length: OVERRIDES_MAX_KEYS + 1 }, (_, i) => [`K${i}`, 'v']))
    const proto = JSON.parse('{"__proto__": "x"}') as Record<string, string>
    for (const bad of [
      null,
      undefined,
      'x',
      [],
      {},
      { projectId: 'p' },
      { projectId: '../x', serverId: 's' },
      { projectId: 'p', serverId: 5 },
      { projectId: 'p', serverId: 's', env: null },
      { projectId: 'p', serverId: 's', env: 'A=b' },
      { projectId: 'p', serverId: 's', env: ['A'] },
      { projectId: 'p', serverId: 's', env: { A: 5 } },
      { projectId: 'p', serverId: 's', headers: { A: null } },
      { projectId: 'p', serverId: 's', env: many },
      { projectId: 'p', serverId: 's', env: proto },
      { projectId: 'p', serverId: 's', env: new Map() }
    ]) {
      expect(() => mcpOverridesArgs(bad), JSON.stringify(bad)).toThrow('Invalid overrides.')
    }
    expect(mcpOverridesArgs({ projectId: 'p', serverId: 's', env: Object.fromEntries(Array.from({ length: OVERRIDES_MAX_KEYS }, (_, i) => [`K${i}`, 'v'])) }).env).toBeDefined()
  })
})

describe('presetRemoveArgs (connectorPresets:remove)', () => {
  it('rebuilds { id } and refuses anything else', () => {
    expect(presetRemoveArgs({ id: 'acme-crm', extra: 1 })).toEqual({ id: 'acme-crm' })
    for (const bad of [null, undefined, 'x', [], {}, { id: 5 }, { id: '' }, { id: 'Acme' }, { id: '-a' }, { id: 'a'.repeat(65) }, { id: '../x' }]) {
      expect(() => presetRemoveArgs(bad), JSON.stringify(bad)).toThrow('Unknown connector.')
    }
  })
})

describe('openPathRefusal (app:openPath)', () => {
  const root = mkdtempSync(join(tmpdir(), 'orgai-open-'))
  const data = join(root, 'data')
  const logs = join(data, 'logs')
  const proj = join(root, 'proj')
  const allowed = join(root, 'allowed')
  const other = join(root, 'other')
  const file = join(proj, 'a.txt')
  for (const d of [data, logs, proj, allowed, other]) mkdirSync(d, { recursive: true })
  writeFileSync(file, 'x')
  const ctx = { dataDir: data, projectPaths: [proj], allowedDirectories: [allowed], stat: lstatDirectory }
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('allows a project folder, an allowed folder, the data folder and a subfolder of it', () => {
    expect(openPathRefusal(proj, ctx)).toBeNull()
    expect(openPathRefusal(allowed, ctx)).toBeNull()
    expect(openPathRefusal(data, ctx)).toBeNull()
    expect(openPathRefusal(logs, ctx)).toBeNull()
  })
  it('refuses a file, even inside a project', () => {
    expect(openPathRefusal(file, ctx)).not.toBeNull()
  })
  it('refuses a folder outside every allowed place and a missing one', () => {
    expect(openPathRefusal(other, ctx)).toBe(OPEN_PATH_REFUSAL)
    expect(openPathRefusal(join(data, 'missing'), ctx)).not.toBeNull()
  })
  it('refuses junk types, relative, UNC and hidden characters', () => {
    for (const v of [undefined, null, 5, {}, [], '', 'relative/dir', '\\\\server\\share', '//host/x']) {
      expect(openPathRefusal(v, ctx)).not.toBeNull()
    }
    expect(openPathRefusal(proj + '‮', ctx)).not.toBeNull()
    expect(openPathRefusal(proj + '​', ctx)).not.toBeNull()
    expect(openPathRefusal(proj + '\n', ctx)).not.toBeNull()
    expect(openPathRefusal(proj + '\0', ctx)).not.toBeNull()
    expect(openPathRefusal(join(proj, 'a'.repeat(1100)), ctx)).not.toBeNull()
  })
  it('refuses a symlink or a stat that says not a directory', () => {
    expect(openPathRefusal(proj, { ...ctx, stat: () => ({ isDirectory: false }) })).not.toBeNull()
    expect(openPathRefusal(proj, { ...ctx, stat: () => null })).not.toBeNull()
  })
})

describe('permissionRuleArgs (permissions:add / permissions:remove, review re-check L8)', () => {
  it('rebuilds the input with a trimmed rule and drops extra fields', () => {
    expect(permissionRuleArgs({ projectId: 'p1', rule: '  Bash(npm test:*) ', extra: 1 })).toEqual({ projectId: 'p1', rule: 'Bash(npm test:*)' })
    expect(permissionRuleArgs({ projectId: 'p1', rule: 'x'.repeat(PERMISSION_RULE_MAX_CHARS) }).rule).toHaveLength(1000)
  })

  it('refuses malformed input', () => {
    for (const bad of [null, undefined, 'p1', 42, [], {}, { projectId: 7, rule: 'WebSearch' }, { projectId: '', rule: 'WebSearch' }, { projectId: 'p'.repeat(201), rule: 'WebSearch' }]) {
      expect(() => permissionRuleArgs(bad), JSON.stringify(bad)).toThrow('Project not found')
    }
    for (const rule of [undefined, null, 5, {}, ['WebSearch']]) expect(() => permissionRuleArgs({ projectId: 'p1', rule })).toThrow('must be text')
    expect(() => permissionRuleArgs({ projectId: 'p1', rule: '   ' })).toThrow('empty')
    expect(() => permissionRuleArgs({ projectId: 'p1', rule: 'x'.repeat(PERMISSION_RULE_MAX_CHARS + 1) })).toThrow('too long')
  })

  it('keeps a hidden-character rule intact so permissions:remove can name an ignored rule exactly; add never saves it', () => {
    const hidden = 'Bash(npm test)‮'
    expect(permissionRuleArgs({ projectId: 'p1', rule: hidden }).rule).toBe(hidden)
    const dir = mkdtempSync(join(tmpdir(), 'orgai-ign-'))
    try {
      const file = join(dir, 'rules.json')
      writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(npm:*)', hidden, 'Bash(npm test:*)'] } }))
      expect(listIgnoredRules({ file }).map((i) => i.rule)).toEqual(['Bash(npm:*)', hidden])
      expect(removeRule({ file }, permissionRuleArgs({ projectId: 'p1', rule: hidden }).rule)).toEqual(['Bash(npm test:*)'])
      expect(removeRule({ file }, 'Bash(npm:*)')).toEqual(['Bash(npm test:*)'])
      expect(listIgnoredRules({ file })).toEqual([])
      expect(addRules({ file }, [hidden])).toEqual(['Bash(npm test:*)'])
      expect(listIgnoredRules({ file })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('permissionAddRefusal (permissions:add, reviewer-3 L4)', () => {
  it('refuses destructive, wildcard and too-broad rules with a readable reason', () => {
    expect(permissionAddRefusal('Bash(rm -rf:*)')).toMatch(/destructive or unbounded/)
    expect(permissionAddRefusal('Bash(git push:*)')).toMatch(/destructive/)
    expect(permissionAddRefusal('Bash(*)')).toMatch(/destructive or unbounded/)
    expect(permissionAddRefusal('Bash(curl:*)')).toMatch(/far more than one command.*Bash\(curl\)/)
    expect(permissionAddRefusal('Bash(docker compose:*)')).toMatch(/far more than one command/)
    expect(permissionAddRefusal('Bash(npx tsx *)')).toMatch(/far more than one command/)
    // reviewer-4 M-2: a one-word launcher covers every verb.
    expect(permissionAddRefusal('Bash(docker:*)')).toMatch(/far more than one command/)
    expect(permissionAddRefusal('Bash(gh:*)')).toMatch(/far more than one command/)
    expect(permissionAddRefusal('Bash(bash:*)')).toMatch(/run any other command/)
    expect(permissionAddRefusal('Edit')).toMatch(/edits anywhere/)
    expect(permissionAddRefusal('not a rule(')).toMatch(/A rule looks like/)
  })

  it('accepts plain prefix, exact, tool and MCP server rules', () => {
    for (const r of ['Bash(npm test:*)', 'Bash(npm test *)', 'Bash(git status:*)', 'Bash(curl https://example.com)', 'WebSearch', 'mcp__github', 'PowerShell(npm install:*)']) {
      expect(permissionAddRefusal(r), r).toBeNull()
    }
  })
})

describe('connectorArgs', () => {
  it('rebuilds connectors:add with only the id and variant', () => {
    expect(connectorArgs.add({ connectorId: 'context7', variant: 'key', url: 'https://evil.example', headers: { a: 'b' } })).toEqual({ connectorId: 'context7', variant: 'key' })
    expect(connectorArgs.add({ connectorId: 'microsoft-learn' })).toEqual({ connectorId: 'microsoft-learn' })
  })

  it('refuses a malformed add', () => {
    for (const bad of [null, undefined, 'gmail', 42, [], {}, { connectorId: 7 }, { connectorId: '' }, { connectorId: 'Gmail' }, { connectorId: '../x' }, { connectorId: '-x' }, { connectorId: 'a'.repeat(65) }]) {
      expect(() => connectorArgs.add(bad), JSON.stringify(bad)).toThrow('Unknown connector.')
    }
    for (const variant of [null, 3, '', 'Key', 'a b', 'x'.repeat(65)]) {
      expect(() => connectorArgs.add({ connectorId: 'exa', variant }), String(variant)).toThrow('Unknown connector variant.')
    }
  })

  it('rebuilds connectors:setToken with a bounded token or null', () => {
    expect(connectorArgs.setToken({ connectorId: 'zapier', token: 'abc', extra: 1 })).toEqual({ connectorId: 'zapier', token: 'abc' })
    expect(connectorArgs.setToken({ connectorId: 'zapier', token: null })).toEqual({ connectorId: 'zapier', token: null })
    expect(connectorArgs.setToken({ connectorId: 'zapier', token: 'x'.repeat(CONNECTOR_TOKEN_MAX_CHARS) }).token).toHaveLength(4000)
  })

  it('refuses a malformed setToken', () => {
    expect(() => connectorArgs.setToken({ connectorId: 'zapier', token: 'x'.repeat(CONNECTOR_TOKEN_MAX_CHARS + 1) })).toThrow('too long')
    for (const token of [undefined, 5, {}, ['a']]) expect(() => connectorArgs.setToken({ connectorId: 'zapier', token })).toThrow('must be text')
    expect(() => connectorArgs.setToken({ connectorId: 'ZAPIER', token: 'a' })).toThrow('Unknown connector.')
    expect(() => connectorArgs.setToken(null)).toThrow('Unknown connector.')
  })
})

describe('PickedFolders', () => {
  it('accepts a folder once, only from the renderer that picked it', () => {
    const p = new PickedFolders()
    p.remember(1, 'C:\\skills\\a')
    expect(p.take(2, 'C:\\skills\\a')).toBe(false)
    expect(p.take(1, 'C:\\skills\\b')).toBe(false)
    expect(p.take(1, 'C:\\skills\\a')).toBe(true)
    expect(p.take(1, 'C:\\skills\\a')).toBe(false)
  })

  it('keeps at most the newest folders per renderer and forgets a destroyed renderer', () => {
    const p = new PickedFolders()
    for (let i = 0; i <= PICKED_FOLDERS_PER_SENDER; i++) p.remember(1, `/f${i}`)
    p.remember(1, '/f1') // re-picking moves it to the newest end
    expect(p.take(1, '/f0')).toBe(false)
    expect(p.take(1, '/f1')).toBe(true)
    expect(p.take(1, `/f${PICKED_FOLDERS_PER_SENDER}`)).toBe(true)
    p.remember(3, '/x')
    p.forget(3)
    expect(p.take(3, '/x')).toBe(false)
  })
})

describe('proposalDecideArgs (setup:decide)', () => {
  const head = { runId: 'r1', proposalId: 'p1' }
  it('rebuilds each decision and drops extra fields', () => {
    expect(proposalDecideArgs({ ...head, extra: 1, decision: { behavior: 'approve', spec: {} } })).toEqual({ ...head, decision: { behavior: 'approve' } })
    expect(proposalDecideArgs({ ...head, decision: { behavior: 'approve', secrets: { 'mcp-1:env:TOKEN': 'v', 'mcp-1:env:EMPTY': '' } } })).toEqual({
      ...head,
      decision: { behavior: 'approve', secrets: { 'mcp-1:env:TOKEN': 'v' } }
    })
    expect(proposalDecideArgs({ ...head, decision: { behavior: 'revise', feedback: 'f', secrets: { a: 'b' } } })).toEqual({ ...head, decision: { behavior: 'revise', feedback: 'f' } })
    expect(proposalDecideArgs({ ...head, decision: { behavior: 'decline', note: ' no ' } })).toEqual({ ...head, decision: { behavior: 'decline', note: 'no' } })
    expect(proposalDecideArgs({ ...head, decision: { behavior: 'decline' } })).toEqual({ ...head, decision: { behavior: 'decline' } })
  })
  it('refuses wrong shapes', () => {
    for (const bad of [null, 'x', [], { ...head }, { ...head, decision: 'approve' }, { ...head, decision: { behavior: 'allow' } }, { runId: 1, proposalId: 'p', decision: { behavior: 'approve' } }]) {
      expect(() => proposalDecideArgs(bad)).toThrow()
    }
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'revise' } })).toThrow('must be text')
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'revise', feedback: 'x'.repeat(5000) } })).toThrow('too long')
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'approve', secrets: ['a'] } })).toThrow()
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'approve', secrets: { a: 1 } } })).toThrow('must be text')
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'approve', secrets: { a: 'x'.repeat(4001) } } })).toThrow('too long')
    const many = Object.fromEntries(Array.from({ length: PROPOSAL_SECRETS_MAX + 1 }, (_, i) => ['k' + i, 'v']))
    expect(() => proposalDecideArgs({ ...head, decision: { behavior: 'approve', secrets: many } })).toThrow('At most')
  })
})

describe('settingsSetArgs (settings:set, self-configuration H3 / M3)', () => {
  const stored = {
    ...DEFAULT_APP_SETTINGS,
    defaultConnection: 'openai' as const,
    defaultConnectionChosen: false,
    defaultConnectionReplaced: 'anthropic' as const,
    defaultKeepRuns: 7
  }

  it('refuses a payload that is not a plain object', () => {
    for (const bad of [null, undefined, 'x', 42, [], new Date(), Object.create({ evil: 1 })]) {
      expect(() => settingsSetArgs(bad, stored), String(bad)).toThrow('Settings must be an object.')
    }
  })

  it('never changes the default connection fields or connections', () => {
    const conns = structuredClone(stored.connections)
    conns.openai.enabled = true
    const out = settingsSetArgs(
      {
        defaultConnection: 'litellm',
        defaultConnectionChosen: true,
        defaultConnectionReplaced: 'litellm',
        connections: conns,
        proxies: [{ id: 'proxy-0a1b2c3d', name: 'Evil', kind: 'litellm', anthropicBaseUrl: 'https://example.com', hasApiKey: true, enabled: true, tierModels: {} }],
        providerAuth: { kind: 'apiKey', envVar: 'X' },
        notifications: false
      } as never,
      stored
    )
    expect(out.proxies).toEqual(stored.proxies)
    expect(out.defaultConnection).toBe('openai')
    expect(out.defaultConnectionChosen).toBe(false)
    expect(out.defaultConnectionReplaced).toBe('anthropic')
    expect(out.connections).toEqual(stored.connections)
    expect(out.providerAuth).toEqual(stored.providerAuth)
    expect(out.notifications).toBe(false)
  })

  it('merges onto the stored settings, never onto the defaults, and drops the info extras', () => {
    const out = settingsSetArgs({ notifications: false, dataDir: '/x', appVersion: '9' }, stored)
    expect(out.defaultKeepRuns).toBe(7)
    expect(out).not.toHaveProperty('dataDir')
    expect(out).not.toHaveProperty('appVersion')
    const { defaultConnectionReplaced: _r, ...bare } = stored
    expect(settingsSetArgs({ defaultConnectionReplaced: 'litellm' }, bare)).not.toHaveProperty('defaultConnectionReplaced')
  })
})

describe('settingsSetArgs and the removed Terminal access keys', () => {
  it('a save that still carries them leaves them out of the result the store keeps', () => {
    const out = normalizeSettings(settingsSetArgs({ terminalServer: true, terminalAccessLevel: 'full', notifications: false } as never, DEFAULT_APP_SETTINGS))
    expect(out).not.toHaveProperty('terminalServer')
    expect(out).not.toHaveProperty('terminalAccessLevel')
    expect(out.notifications).toBe(false)
  })
})

describe('connection id guards (connections:test / logout, models:list / refresh)', () => {
  it('connectionIdArg accepts only known ids, never prototype keys', () => {
    for (const id of ['anthropic', 'openai', 'litellm', 'proxy-0a1b2c3d']) expect(connectionIdArg(id)).toBe(id)
    for (const bad of ['proxy-0A1B2C3D', 'proxy-0a1b2c3', 'proxy-0a1b2c3dd', 'Litellm']) expect(() => connectionIdArg(bad), bad).toThrow('Unknown connection')
    for (const bad of ['bogus', '__proto__', 'constructor', 'hasOwnProperty', '', 'Anthropic', null, undefined, 1, {}, ['anthropic']]) {
      expect(() => connectionIdArg(bad), String(bad)).toThrow('Unknown connection')
    }
  })

  it('connectionSecretArgs rebuilds the proxy key input and never echoes the value', () => {
    expect(connectionSecretArgs({ id: 'litellm', apiKey: 'sk-abc', extra: 1 })).toEqual({ id: 'litellm', apiKey: 'sk-abc' })
    expect(connectionSecretArgs({ id: 'litellm', apiKey: null })).toEqual({ id: 'litellm', apiKey: null })
    expect(connectionSecretArgs({ id: 'litellm' })).toEqual({ id: 'litellm', apiKey: null })
    for (const bad of [null, 'litellm', [], { id: 'anthropic', apiKey: 'k' }, { id: '__proto__', apiKey: 'k' }]) {
      expect(() => connectionSecretArgs(bad), JSON.stringify(bad)).toThrow('Only a proxy connection has a stored secret')
    }
    expect(() => connectionSecretArgs({ id: 'litellm', apiKey: 42 })).toThrow('The API key must be text.')
    expect(() => connectionSecretArgs({ id: 'litellm', apiKey: 'k'.repeat(CONNECTION_SECRET_MAX_CHARS + 1) })).toThrow('too long')
    for (const bad of ['sk-a\nb', 'sk-a\rb', 'sk\u200b', 'sk\u202e', 'sk\u0000']) {
      let message = ''
      try {
        connectionSecretArgs({ id: 'litellm', apiKey: bad })
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, JSON.stringify(bad)).toBe('The API key contains line breaks or hidden characters.')
    }
  })

  it('connectionSecretArgs accepts any proxy-shaped id', () => {
    expect(connectionSecretArgs({ id: 'proxy-0a1b2c3d', apiKey: 'k' })).toEqual({ id: 'proxy-0a1b2c3d', apiKey: 'k' })
    expect(() => connectionSecretArgs({ id: 'proxy-zz', apiKey: 'k' })).toThrow('Only a proxy connection has a stored secret')
  })

  it('proxyIdArg and proxyCreateArgs rebuild their input', () => {
    expect(proxyIdArg('proxy-0a1b2c3d')).toBe('proxy-0a1b2c3d')
    for (const bad of ['anthropic', 'proxy-', '', null, 7, ['litellm'], 'constructor']) expect(() => proxyIdArg(bad), String(bad)).toThrow('Unknown connection')
    expect(
      proxyCreateArgs({ name: 'Gateway', kind: 'openai-compatible', anthropicBaseUrl: 'https://example.com', openaiBaseUrl: 'https://example.com/v1', modelsUrl: 'https://example.com/m', apiKey: 'sk-abc', extra: 1 })
    ).toEqual({ name: 'Gateway', kind: 'openai-compatible', anthropicBaseUrl: 'https://example.com', openaiBaseUrl: 'https://example.com/v1', modelsUrl: 'https://example.com/m', apiKey: 'sk-abc' })
    expect(proxyCreateArgs({ name: 'G', anthropicBaseUrl: 'https://example.com' })).toEqual({ name: 'G', anthropicBaseUrl: 'https://example.com' })
    for (const bad of [null, 'x', [], { anthropicBaseUrl: 'https://example.com' }, { name: 'G' }, { name: 'x'.repeat(201), anthropicBaseUrl: 'u' }, { name: 'G', anthropicBaseUrl: 'u'.repeat(2049) }, { name: 'G', anthropicBaseUrl: 'u', kind: 'other' }, { name: 'G', anthropicBaseUrl: 'u', modelsUrl: 5 }, JSON.parse('{"__proto__":{},"name":"G","anthropicBaseUrl":"u"}')]) {
      expect(() => proxyCreateArgs(bad), JSON.stringify(bad)).toThrow()
    }
    const secret = 'sk-secret\nline'
    try {
      proxyCreateArgs({ name: 'G', anthropicBaseUrl: 'u', apiKey: secret })
      throw new Error('should refuse')
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('sk-secret')
      expect(String((e as Error).message)).toContain('hidden characters')
    }
    expect(() => proxyCreateArgs({ name: 'G', anthropicBaseUrl: 'u', apiKey: 'k'.repeat(CONNECTION_SECRET_MAX_CHARS + 1) })).toThrow('too long')
  })

  it('modelsQueryArg rebuilds the query and refuses junk connections', () => {
    expect(modelsQueryArg(undefined)).toBeUndefined()
    expect(modelsQueryArg(null)).toBeUndefined()
    expect(modelsQueryArg({})).toEqual({})
    expect(modelsQueryArg({ connection: 'litellm', extra: 1 })).toEqual({ connection: 'litellm' })
    for (const bad of [{ connection: '__proto__' }, { connection: 'bogus' }, { connection: null }, 'litellm', ['litellm'], 3]) {
      expect(() => modelsQueryArg(bad), JSON.stringify(bad)).toThrow('Unknown connection')
    }
  })
})

describe('settingsSetArgs field kinds (review fix-up)', () => {
  const stored = {
    ...DEFAULT_APP_SETTINGS,
    defaultMaxBudgetUsd: 5,
    modelPrices: [{ model: 'gpt-5', price: { inputPerToken: 0.000001, outputPerToken: 0.000002 } }]
  }

  it('drops an incoming field whose kind differs from the stored one', () => {
    const out = settingsSetArgs({ modelPrices: 'nope', defaultKeepRuns: '9', notifications: 'yes', appearance: [], defaultIsolateWriters: null }, stored)
    expect(out.modelPrices).toEqual(stored.modelPrices)
    expect(out.defaultKeepRuns).toBe(stored.defaultKeepRuns)
    expect(out.notifications).toBe(stored.notifications)
    expect(out.appearance).toEqual(stored.appearance)
    expect(out.defaultIsolateWriters).toBe(stored.defaultIsolateWriters)
    expect(settingsSetArgs({ modelPrices: {} }, stored).modelPrices).toEqual(stored.modelPrices)
  })

  it('keeps same-kind values, undefined clears an optional field, and new fields pass to normalization', () => {
    const out = settingsSetArgs({ modelPrices: [], defaultKeepRuns: 12, defaultMaxBudgetUsd: undefined }, stored)
    expect(out.modelPrices).toEqual([])
    expect(out.defaultKeepRuns).toBe(12)
    expect(out.defaultMaxBudgetUsd).toBeUndefined()
    const { defaultMaxBudgetUsd: _b, ...without } = stored
    expect(settingsSetArgs({ defaultMaxBudgetUsd: 3 }, without).defaultMaxBudgetUsd).toBe(3)
  })
})

describe('settingsSetArgs hostile payloads (QA)', () => {
  const stored = { ...DEFAULT_APP_SETTINGS, defaultConnection: 'openai' as const }

  it('an own __proto__ key from JSON never pollutes Object.prototype or the result', () => {
    const raw = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"notifications":false}')
    const out = settingsSetArgs(raw, stored)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as unknown as Record<string, unknown>).polluted).toBeUndefined()
    expect(out.notifications).toBe(false)
    expect(out.defaultConnection).toBe('openai')
  })

  it('arrays, class instances and null-prototype-with-junk payloads are handled', () => {
    expect(() => settingsSetArgs([{ notifications: false }], stored)).toThrow('Settings must be an object.')
    expect(() => settingsSetArgs(new Map(), stored)).toThrow('Settings must be an object.')
    const nullProto = Object.assign(Object.create(null), { defaultKeepRuns: 3 })
    expect(settingsSetArgs(nullProto, stored).defaultKeepRuns).toBe(3)
  })

  it('a huge string for a same-kind field does not throw and never touches the connection fields', () => {
    const huge = 'x'.repeat(2_000_000)
    const out = settingsSetArgs({ setupModel: huge, defaultConnection: huge, defaultConnectionChosen: huge, connections: huge, providerAuth: huge }, stored)
    expect(out.defaultConnection).toBe('openai')
    expect(out.connections).toEqual(stored.connections)
    expect(out.providerAuth).toEqual(stored.providerAuth)
    expect(out).not.toHaveProperty('defaultConnectionChosen', huge)
  })

  it('connectionIdArg and connectionSecretArgs refuse huge, boxed and hostile ids', () => {
    for (const bad of ['a'.repeat(1_000_000), new String('litellm'), Object.create({ toString: () => 'litellm' }), Symbol.iterator as never]) {
      expect(() => connectionIdArg(bad), typeof bad).toThrow('Unknown connection')
    }
    expect(() => connectionSecretArgs({ id: new String('litellm'), apiKey: 'k' })).toThrow('Only a proxy connection has a stored secret')
    expect(() => connectionSecretArgs({ id: ['litellm'], apiKey: 'k' })).toThrow('Only a proxy connection has a stored secret')
    expect(() => connectionSecretArgs(JSON.parse('{"__proto__":{"id":"litellm"},"apiKey":"k"}'))).toThrow('Only a proxy connection has a stored secret')
    expect(() => connectionSecretArgs({ id: 'litellm', apiKey: 'k'.repeat(10_000_000) })).toThrow('too long')
    expect(() => connectionSecretArgs({ id: 'litellm', apiKey: ['k'] })).toThrow('The API key must be text.')
  })
})

describe('withEffectiveDefault (settings:get / set / changed)', () => {
  it('puts the effective default in defaultConnection and keeps the rest', () => {
    const s = { ...DEFAULT_APP_SETTINGS, defaultConnection: 'anthropic' as const, defaultConnectionChosen: false }
    const out = withEffectiveDefault(s, 'litellm')
    expect(out.defaultConnection).toBe('litellm')
    expect(out.defaultConnectionChosen).toBe(false)
    expect(s.defaultConnection).toBe('anthropic')
    // Echoing it back through settings:set never changes the stored value.
    expect(settingsSetArgs(out, s).defaultConnection).toBe('anthropic')
  })
})

describe('appFacingError (what a window is told about secure storage)', () => {
  it('puts the vault sentences in the app words and leaves every other error alone', async () => {
    const { appFacingError } = await import('./ipc')
    const { VAULT_MESSAGES } = await import('./store/vaultTypes')
    const e = appFacingError(new Error(VAULT_MESSAGES.clearRefusedCorrupt)) as Error
    expect(e.message).not.toMatch(/orgai|`/)
    expect(e.message).toContain('Dashboard')
    const plain = new Error('Something else')
    expect(appFacingError(plain)).toBe(plain)
    expect(appFacingError('text')).toBe('text')
  })
})
