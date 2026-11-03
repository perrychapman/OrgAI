import { describe, expect, it, vi } from 'vitest'

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

const { CONNECTOR_TOKEN_MAX_CHARS, PICKED_FOLDERS_PER_SENDER, PickedFolders, connectorArgs, proposalDecideArgs, PROPOSAL_SECRETS_MAX, PERMISSION_RULE_MAX_CHARS, permissionAddRefusal, permissionRuleArgs, settingsSetArgs, connectionIdArg, connectionSecretArgs, CONNECTION_SECRET_MAX_CHARS, modelsQueryArg, withEffectiveDefault } = await import('./ipc')
const { DEFAULT_APP_SETTINGS } = await import('@shared/defaults')

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
        providerAuth: { kind: 'apiKey', envVar: 'X' },
        notifications: false
      },
      stored
    )
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

describe('connection id guards (connections:test / logout, models:list / refresh)', () => {
  it('connectionIdArg accepts only known ids, never prototype keys', () => {
    for (const id of ['anthropic', 'openai', 'litellm']) expect(connectionIdArg(id)).toBe(id)
    for (const bad of ['bogus', '__proto__', 'constructor', 'hasOwnProperty', '', 'Anthropic', null, undefined, 1, {}, ['anthropic']]) {
      expect(() => connectionIdArg(bad), String(bad)).toThrow('Unknown connection')
    }
  })

  it('connectionSecretArgs rebuilds the LiteLLM key input and never echoes the value', () => {
    expect(connectionSecretArgs({ id: 'litellm', apiKey: 'sk-abc', extra: 1 })).toEqual({ id: 'litellm', apiKey: 'sk-abc' })
    expect(connectionSecretArgs({ id: 'litellm', apiKey: null })).toEqual({ id: 'litellm', apiKey: null })
    expect(connectionSecretArgs({ id: 'litellm' })).toEqual({ id: 'litellm', apiKey: null })
    for (const bad of [null, 'litellm', [], { id: 'anthropic', apiKey: 'k' }, { id: '__proto__', apiKey: 'k' }]) {
      expect(() => connectionSecretArgs(bad), JSON.stringify(bad)).toThrow('Only the LiteLLM connection has a stored secret')
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
    expect(() => connectionSecretArgs({ id: new String('litellm'), apiKey: 'k' })).toThrow('Only the LiteLLM connection has a stored secret')
    expect(() => connectionSecretArgs({ id: ['litellm'], apiKey: 'k' })).toThrow('Only the LiteLLM connection has a stored secret')
    expect(() => connectionSecretArgs(JSON.parse('{"__proto__":{"id":"litellm"},"apiKey":"k"}'))).toThrow('Only the LiteLLM connection has a stored secret')
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
