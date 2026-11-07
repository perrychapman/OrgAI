import { describe, expect, it } from 'vitest'
import {
  HOST_IPC,
  HOST_METHODS,
  HOST_SCOPES,
  IPC,
  KIT_IPC,
  MCP_SCOPE_IPC,
  RPC_BULK_CHANNELS,
  RPC_BULK_FRAME_MAX_BYTES,
  RPC_CONTROL_REQUEST_MAX_BYTES,
  RPC_CONTROL_RESPONSE_MAX_BYTES,
  TEAM_FILES_IPC
} from '../../shared/types'
import type { HostKind, HostScope } from '../../shared/types'
import { allChannels, CHANNEL_JSON_FIELDS, PUSH_CHANNELS } from './jsonCodec'
import {
  channelEntry,
  desktopOnlyChannels,
  frameLimitFor,
  gateRequest,
  HOST_CHANNEL_REGISTRY,
  HostRpcFailure,
  pushChannelsForTopic,
  requestEntries,
  socketInvokableChannels,
  type GateContext,
  type PushChannelEntry,
  type RequestChannelEntry
} from './registry'

/** cli-spec 3.3(3), the scope table, copied literally (a second, independent copy of what registry.ts holds). */
const SPEC_TABLE = {
  read: `host.status, host.subscribe, app:info, app:logPath, settings:get, auth:status, projects:list, projects:get, projects:checkPath, projects:previewRemap, projects:scanAgents, projects:previewImport, projects:removePreview, projects:engagementDocument, projects:listNotes, projects:getNote, runs:list, runs:get, runs:listLive, runs:pendingCards, runs:usageStats, runs:usageCsv, runs:subscribe, runs:findDecision, permissions:list, permissions:ignored, connections:list, models:list, models:prices, mcp:list, mcp:registrySearch, mcpLibrary:list, connectors:list, connectorPresets:list, skills:list, skills:read, skills:previewImport, skills:lastEvaluation, skillLibrary:list, skillLibrary:read, capabilities:lastReview, maintenance:listWorktrees, maintenance:diff, templates:list, knowledge:get, knowledge:inferredLinks, kit:previewBundle, projects:folderConfig, teamFiles:listAttention`,
  operate: `runs:start, runs:startQuick, runs:continue, runs:send, runs:interrupt, runs:stop, runs:resumeNow, runs:cancelAutoResume, setup:start, setup:retro, mcp:startAssist, skills:startAssist, usage:refresh, connections:test, models:refresh, mcp:test, mcpLibrary:test, capabilities:discover, capabilities:recommend, capabilities:cancel, capabilities:review, skills:evaluate, draft:orgChart, window:openRun`,
  decide: `runs:decide, permissions:decideRequest, setup:decide, setup:answer, merges:decide, mcp:answerInstall`,
  configure: `host.stop, settings:set, projects:create, projects:save, projects:remove, projects:remapModels, projects:applyImport, projects:exportOrg, projects:updateEngagementDocument, projects:saveNote, projects:removeNote, runs:promoteQuick, permissions:add, permissions:remove, connections:connect, connections:update, connections:setSecret, connections:createProxy, connections:removeProxy, connections:login, connections:cancelLogin, connections:logout, connections:setDefault, mcp:upsert, mcp:remove, mcp:setSecret, mcp:linkLibrary, mcp:promote, mcp:authorize, mcp:cancelAuthorize, mcp:revokeAuth, mcp:copyFromLibrary, mcp:setProjectOverrides, mcpLibrary:upsert, mcpLibrary:remove, mcpLibrary:setSecret, connectors:add, connectors:setToken, connectorPresets:upsert, connectorPresets:remove, plugins:upsert, plugins:remove, skills:create, skills:update, skills:remove, skills:linkLibrary, skills:promote, skills:applyImport, skills:undoImport, skills:applySuggestion, skillLibrary:create, skillLibrary:addFromBundle, skillLibrary:update, skillLibrary:remove, capabilities:apply, capabilities:undo, capabilities:dismiss, capabilities:restore, maintenance:integrateWorktree, maintenance:discardWorktree, maintenance:uninstallRepo, templates:saveFromProject, templates:remove, templates:apply, knowledge:saveNode, knowledge:removeNode, knowledge:saveEdge, knowledge:removeEdge, knowledge:clear, knowledge:dismissLink, kit:exportBundle, kit:applyBundle, teamFiles:status`,
  desktop_only: `projects:pickDirectory, skillLibrary:addFromFolder, kit:pickExportPath, kit:pickImportPath, kit:export, kit:previewImport, kit:applyImport, menu:setState, app:openPath, app:openLogs, app:setNotifications, app:cliShimStatus, app:installCliShim, app:uninstallCliShim, projects:parseRepoSource, projects:repoTools, projects:cloneRepo, projects:cancelClone, projects:setFolderConfigTrust, teamFiles:approve, teamFiles:reject, teamFiles:undo, teamFiles:enable, teamFiles:commit`,
  socket_subscribable: `runs:event, settings:changed, connections:event, mcpLibrary:changed, skillLibrary:changed, capabilities:progress, capabilities:reviewUpdated, projects:engagementChanged`,
  push_desktop_only: `app:focusRun, menu:action, projects:cloneProgress, teamFiles:changed`
} as const

const specSet = (row: keyof typeof SPEC_TABLE): string[] => SPEC_TABLE[row].split(',').map((s) => s.trim()).sort()

const ALL_SCOPES: GateContext = { grantedScopes: HOST_SCOPES, hostKind: 'headless-host' }
const only = (scopes: HostScope[], hostKind: HostKind = 'headless-host'): GateContext => ({ grantedScopes: scopes, hostKind })

function failure(fn: () => unknown): HostRpcFailure {
  try {
    fn()
  } catch (e) {
    if (e instanceof HostRpcFailure) return e
    throw e
  }
  throw new Error('expected a HostRpcFailure')
}

const existing = [...new Set([...Object.values(IPC), ...Object.values(MCP_SCOPE_IPC), ...Object.values(KIT_IPC), ...Object.values(TEAM_FILES_IPC)])]

describe('HOST_CHANNEL_REGISTRY coverage (Wave 1 gate)', () => {
  it('has an entry for each of the 179 existing channels, the 6 HOST_IPC channels and the 5 HOST_METHODS, nothing else', () => {
    expect(existing).toHaveLength(179)
    expect(Object.values(HOST_IPC)).toHaveLength(6)
    expect(Object.values(HOST_METHODS)).toHaveLength(5)
    for (const c of existing) expect(channelEntry(c), c).toBeDefined()
    for (const c of Object.values(HOST_IPC)) expect(channelEntry(c), c).toBeDefined()
    for (const c of Object.values(HOST_METHODS)) expect(channelEntry(c), c).toBeDefined()
    const expected = [...allChannels(), ...Object.values(HOST_METHODS)].sort()
    expect(new Set(allChannels()).size).toBe(185)
    expect(Object.keys(HOST_CHANNEL_REGISTRY).sort()).toEqual(expected)
  })

  it('splits the existing channels into 167 requests and 12 pushes (8 socket_subscribable, 4 desktop_only)', () => {
    const entries = existing.map((c) => HOST_CHANNEL_REGISTRY[c])
    expect(entries.filter((e) => e.direction === 'request')).toHaveLength(167)
    const push = entries.filter((e): e is PushChannelEntry => e.direction === 'push')
    expect(push).toHaveLength(12)
    expect(push.filter((e) => e.delivery === 'socket_subscribable')).toHaveLength(8)
    expect(push.filter((e) => e.delivery === 'desktop_only')).toHaveLength(4)
    expect(existing.filter((c) => HOST_CHANNEL_REGISTRY[c].direction === 'push').sort()).toEqual([...PUSH_CHANNELS].sort())
  })

  it('every HOST_IPC channel and host.status / subscribe / stop is a request; host.challenge and host.hello are protocol', () => {
    for (const c of Object.values(HOST_IPC)) expect(HOST_CHANNEL_REGISTRY[c].direction).toBe('request')
    for (const c of [HOST_METHODS.hostStatus, HOST_METHODS.hostSubscribe, HOST_METHODS.hostStop]) expect(HOST_CHANNEL_REGISTRY[c].direction).toBe('request')
    expect(HOST_CHANNEL_REGISTRY[HOST_METHODS.hostChallenge].direction).toBe('protocol')
    expect(HOST_CHANNEL_REGISTRY[HOST_METHODS.hostHello].direction).toBe('protocol')
  })

  it('every request entry has a params spec and a non-empty source; every entry has a source', () => {
    for (const [c, e] of requestEntries()) {
      expect(Array.isArray(e.params), c).toBe(true)
      expect(e.source.trim().length, c).toBeGreaterThan(0)
    }
    for (const [c, e] of Object.entries(HOST_CHANNEL_REGISTRY)) expect(e.source.trim().length, c).toBeGreaterThan(0)
  })

  it('every channel request entry has a jsonCodec field table (host.* methods have none)', () => {
    for (const [c] of requestEntries()) expect(Object.hasOwn(CHANNEL_JSON_FIELDS, c), c).toBe(!c.startsWith('host.'))
    expect(Object.keys(CHANNEL_JSON_FIELDS).sort()).toEqual(requestEntries().map(([c]) => c).filter((c) => !c.startsWith('host.')).sort())
  })

  it('channelEntry ignores prototype keys', () => {
    expect(channelEntry('__proto__')).toBeUndefined()
    expect(channelEntry('constructor')).toBeUndefined()
    expect(channelEntry('toString')).toBeUndefined()
  })
})

describe('scope classification (cli-spec 3.3(3) table)', () => {
  for (const scope of ['read', 'operate', 'decide', 'configure', 'desktop_only'] as const) {
    it(`request: ${scope} matches the spec row`, () => {
      const actual = requestEntries()
        .filter(([, e]) => e.scope === scope)
        .map(([c]) => c)
        .sort()
      expect(actual).toEqual(specSet(scope))
    })
  }

  it('push rows match the spec', () => {
    const push = Object.entries(HOST_CHANNEL_REGISTRY).filter((e): e is [string, PushChannelEntry] => e[1].direction === 'push')
    expect(push.filter(([, e]) => e.delivery === 'socket_subscribable').map(([c]) => c).sort()).toEqual(specSet('socket_subscribable'))
    expect(push.filter(([, e]) => e.delivery === 'desktop_only').map(([c]) => c).sort()).toEqual(specSet('push_desktop_only'))
    expect(HOST_CHANNEL_REGISTRY[IPC.appFocusRun].source).toMatch(/notifications\.ts/)
    expect(HOST_CHANNEL_REGISTRY[IPC.menuAction].source).toMatch(/appMenu\.ts/)
    expect(HOST_CHANNEL_REGISTRY[IPC.projectsCloneProgress].source).toMatch(/registerRepoIpc/)
  })

  it('names the points the wave plan calls out', () => {
    const scopeOf = (c: string): string => (HOST_CHANNEL_REGISTRY[c] as RequestChannelEntry).scope
    expect(scopeOf('connections:connect')).toBe('configure')
    expect(scopeOf('usage:refresh')).toBe('operate')
    expect(scopeOf('kit:previewBundle')).toBe('read')
    expect(scopeOf('runs:subscribe')).toBe('read')
    expect(scopeOf('host.status')).toBe('read')
    expect(scopeOf('host.subscribe')).toBe('read')
    expect(scopeOf('host.stop')).toBe('configure')
    expect(scopeOf('knowledge:inferredLinks')).toBe('read')
    expect(scopeOf('knowledge:dismissLink')).toBe('configure')
    expect(scopeOf('projects:cloneRepo')).toBe('desktop_only')
  })

  it('exactly the 24 desktop_only request channels', () => {
    expect(desktopOnlyChannels().sort()).toEqual(
      [
        'projects:pickDirectory',
        'skillLibrary:addFromFolder',
        'kit:pickExportPath',
        'kit:pickImportPath',
        'kit:export',
        'kit:previewImport',
        'kit:applyImport',
        'menu:setState',
        'app:openPath',
        'app:openLogs',
        'app:setNotifications',
        'app:cliShimStatus',
        'app:installCliShim',
        'app:uninstallCliShim',
        'projects:parseRepoSource',
        'projects:repoTools',
        'projects:cloneRepo',
        'projects:cancelClone',
        'projects:setFolderConfigTrust',
        'teamFiles:approve',
        'teamFiles:reject',
        'teamFiles:undo',
        'teamFiles:enable',
        'teamFiles:commit'
      ].sort()
    )
  })
})

describe('entry flags', () => {
  it('bulk is exactly RPC_BULK_CHANNELS', () => {
    const bulk = requestEntries()
      .filter(([, e]) => e.bulk)
      .map(([c]) => c)
      .sort()
    expect(bulk).toEqual([...RPC_BULK_CHANNELS].sort())
  })

  it('socketOnly marks the 6 HOST_IPC channels and host.status / subscribe / stop', () => {
    const socketOnly = requestEntries()
      .filter(([, e]) => e.socketOnly)
      .map(([c]) => c)
      .sort()
    expect(socketOnly).toEqual([...Object.values(HOST_IPC), 'host.status', 'host.subscribe', 'host.stop'].sort())
  })

  it('runs:findDecision is a read-scope, socket-only request taking one string', () => {
    const e = HOST_CHANNEL_REGISTRY[HOST_IPC.runsFindDecision]
    expect(e.direction).toBe('request')
    if (e.direction !== 'request') return
    expect(e.scope).toBe('read')
    expect(e.socketOnly).toBe(true)
    expect(e.transport).toBeUndefined()
    expect(e.params).toEqual([{ kind: 'string' }])
    expect(socketInvokableChannels()).toContain(HOST_IPC.runsFindDecision)
  })

  it('transport marks runs:subscribe and host.subscribe; desktopRequired only window:openRun', () => {
    expect(requestEntries().filter(([, e]) => e.transport).map(([c]) => c).sort()).toEqual(['host.subscribe', 'runs:subscribe'])
    expect(requestEntries().filter(([, e]) => e.desktopRequired).map(([c]) => c)).toEqual(['window:openRun'])
  })

  it('socketInvokableChannels leaves out desktop_only and transport channels', () => {
    const invokable = socketInvokableChannels()
    expect(invokable).toHaveLength(requestEntries().length - 24 - 2)
    expect(invokable).toContain('runs:start')
    expect(invokable).toContain('host.status')
    expect(invokable).toContain('window:openRun')
    expect(invokable).not.toContain('runs:subscribe')
    expect(invokable).not.toContain('host.subscribe')
    expect(invokable).not.toContain('app:openPath')
    for (const c of ['app:cliShimStatus', 'app:installCliShim', 'app:uninstallCliShim']) {
      expect(invokable, c).not.toContain(c)
      expect((HOST_CHANNEL_REGISTRY[c] as RequestChannelEntry).scope, c).toBe('desktop_only')
      expect(HOST_CHANNEL_REGISTRY[c].source, c).toBe('ipc.ts desktop-only (shimInstaller.ts)')
    }
  })

  it('topic mapping: runs, the six host.subscribe topics, and none for desktop pushes', () => {
    expect(pushChannelsForTopic('runs')).toEqual(['runs:event'])
    expect(pushChannelsForTopic('settings')).toEqual(['settings:changed'])
    expect(pushChannelsForTopic('connections')).toEqual(['connections:event'])
    expect(pushChannelsForTopic('mcpLibrary')).toEqual(['mcpLibrary:changed'])
    expect(pushChannelsForTopic('skillLibrary')).toEqual(['skillLibrary:changed'])
    expect(pushChannelsForTopic('capabilities').sort()).toEqual(['capabilities:progress', 'capabilities:reviewUpdated'])
    expect(pushChannelsForTopic('engagement')).toEqual(['projects:engagementChanged'])
    expect((HOST_CHANNEL_REGISTRY[IPC.appFocusRun] as PushChannelEntry).topic).toBeUndefined()
    expect((HOST_CHANNEL_REGISTRY[IPC.menuAction] as PushChannelEntry).topic).toBeUndefined()
  })
})

describe('gateRequest', () => {
  it('refuses an unknown channel', () => {
    const f = failure(() => gateRequest('runs:nope', [], ALL_SCOPES))
    expect(f.code).toBe('unknown_channel')
    expect(failure(() => gateRequest('__proto__', [], ALL_SCOPES)).code).toBe('unknown_channel')
  })

  it('refuses a push channel', () => {
    const f = failure(() => gateRequest('runs:event', [], ALL_SCOPES))
    expect(f.code).toBe('bad_request')
    expect(f.message).toBe('runs:event is a push channel; subscribe with runs:subscribe or host.subscribe')
    expect(failure(() => gateRequest('app:focusRun', [], ALL_SCOPES)).code).toBe('bad_request')
  })

  it('refuses a protocol method', () => {
    expect(failure(() => gateRequest('host.hello', [{}], ALL_SCOPES)).code).toBe('bad_request')
    expect(failure(() => gateRequest('host.challenge', undefined, ALL_SCOPES)).code).toBe('bad_request')
  })

  it('refuses desktop_only channels with desktop_unavailable, whatever the scopes', () => {
    for (const c of desktopOnlyChannels()) {
      const f = failure(() => gateRequest(c, [], ALL_SCOPES))
      expect(f.code, c).toBe('desktop_unavailable')
      expect(f.message).toBe(`${c} works only in the OrgAI window`)
    }
  })

  it('window:openRun: desktop_unavailable under inproc, passes under headless-host with operate', () => {
    const target = { projectId: 'p_1', runId: 'r_1' }
    expect(failure(() => gateRequest('window:openRun', [target], only(['operate'], 'inproc'))).code).toBe('desktop_unavailable')
    const ok = gateRequest('window:openRun', [target], only(['operate'], 'headless-host'))
    expect(ok.args).toEqual([target])
    expect(ok.mutation).toBe(true)
    expect(gateRequest('window:openRun', [target], only(['operate'], 'desktop')).channel).toBe('window:openRun')
  })

  it('refuses a missing scope with scope_denied naming it; scopes are not hierarchical', () => {
    const connect = failure(() => gateRequest('connections:connect', ['openai'], only(['read', 'operate', 'decide'])))
    expect(connect.code).toBe('scope_denied')
    expect(connect.message).toContain("'configure'")
    const decide = failure(() => gateRequest('runs:decide', [{ runId: 'r', requestId: 'q', decision: {} }], only(['configure'])))
    expect(decide.code).toBe('scope_denied')
    expect(decide.message).toContain("'decide'")
    expect(failure(() => gateRequest('runs:list', ['p_1'], only(['configure'])).channel).code).toBe('scope_denied')
    expect(gateRequest('connections:connect', ['openai'], only(['configure'])).mutation).toBe(true)
  })

  it('checks scope before params', () => {
    expect(failure(() => gateRequest('settings:set', 'junk', only(['read']))).code).toBe('scope_denied')
  })

  it('refuses non-array params on a channel; undefined means no arguments', () => {
    for (const params of ['p_1', 5, null, { projectId: 'p_1' }, true]) {
      const f = failure(() => gateRequest('runs:list', params, ALL_SCOPES))
      expect(f.code).toBe('bad_request')
    }
    expect(gateRequest('projects:list', undefined, ALL_SCOPES).args).toEqual([])
    expect(gateRequest('projects:list', [], ALL_SCOPES).args).toEqual([])
    expect(failure(() => gateRequest('runs:list', undefined, ALL_SCOPES)).message).toContain('argument 0')
  })

  it('refuses extra args', () => {
    const f = failure(() => gateRequest('projects:list', ['x'], ALL_SCOPES))
    expect(f.code).toBe('bad_request')
    expect(f.message).toContain('no arguments')
    expect(failure(() => gateRequest('runs:get', ['r_1', 'r_2'], ALL_SCOPES)).code).toBe('bad_request')
    expect(failure(() => gateRequest('connections:login', ['openai', 'deviceCode', 'x'], ALL_SCOPES)).code).toBe('bad_request')
  })

  it('refuses wrong kinds with the arg index', () => {
    const cases: [string, unknown[], string][] = [
      ['runs:get', [42], 'argument 0'],
      ['runs:get', ['../etc/passwd'], 'argument 0'],
      ['runs:get', [null], 'argument 0'],
      ['settings:set', ['dark'], 'argument 0'],
      ['settings:set', [[1, 2]], 'argument 0'],
      ['connections:login', ['openai', 7], 'argument 1'],
      ['connections:setDefault', [{ id: 'openai' }], 'argument 0'],
      ['projects:remove', [12], 'argument 0'],
      ['models:list', ['openai'], 'argument 0']
    ]
    for (const [channel, args, where] of cases) {
      const f = failure(() => gateRequest(channel, args, ALL_SCOPES))
      expect(f.code, channel).toBe('bad_request')
      expect(f.message, channel).toContain(where)
    }
  })

  it('accepts the optional and nullable shapes', () => {
    expect(gateRequest('connections:login', ['openai'], ALL_SCOPES).args).toEqual(['openai'])
    expect(gateRequest('connections:login', ['openai', null], ALL_SCOPES).args).toEqual(['openai', null])
    expect(gateRequest('models:list', [], ALL_SCOPES).args).toEqual([])
    expect(gateRequest('models:list', [null], ALL_SCOPES).args).toEqual([null])
    expect(gateRequest('models:list', [{ connection: 'openai' }], ALL_SCOPES).args).toEqual([{ connection: 'openai' }])
    expect(gateRequest('projects:remove', ['p_1'], ALL_SCOPES).args).toEqual(['p_1'])
    expect(gateRequest('projects:remove', [{ projectId: 'p_1', removeRuns: false }], ALL_SCOPES).args).toEqual([{ projectId: 'p_1', removeRuns: false }])
  })

  it('host.* methods take an array or one plain object', () => {
    const stop = gateRequest('host.stop', { force: true }, only(['configure']))
    expect(stop.args).toEqual([{ force: true }])
    expect(stop.mutation).toBe(true)
    expect(gateRequest('host.stop', [{ force: false }], only(['configure'])).args).toEqual([{ force: false }])
    expect(gateRequest('host.stop', undefined, only(['configure'])).args).toEqual([])
    expect(gateRequest('host.status', undefined, only(['read'])).mutation).toBe(false)
    expect(gateRequest('host.subscribe', { topics: ['settings'] }, only(['read'])).args).toEqual([{ topics: ['settings'] }])
    expect(failure(() => gateRequest('host.stop', 'now', only(['configure']))).code).toBe('bad_request')
    expect(failure(() => gateRequest('host.stop', { force: true }, only(['read']))).code).toBe('scope_denied')
    expect(failure(() => gateRequest('host.subscribe', [], only(['read']))).code).toBe('bad_request')
  })

  it('returns the entry and never mutates the caller params', () => {
    const params = [{ projectId: 'p_1' }]
    const gated = gateRequest('runs:start', params, ALL_SCOPES)
    expect(gated.entry).toBe(HOST_CHANNEL_REGISTRY['runs:start'])
    expect(gated.args).not.toBe(params)
    expect(gated.args).toEqual(params)
  })

  it('mutation is false for every read channel and true for the others', () => {
    for (const [channel, e] of requestEntries()) {
      if (e.scope === 'desktop_only') continue
      if (e.desktopRequired) continue
      // Build a minimal valid args list from the spec so the gate gets past params.
      const args = e.params.filter((p) => !p.optional).map((p) => (p.kind === 'object' || p.kind === 'stringOrObject' ? {} : p.kind === 'id' || p.kind === 'string' ? 'x_1' : p.kind === 'boolean' ? true : p.kind === 'number' ? 1 : p.kind === 'array' ? [] : 'x'))
      const gated = gateRequest(channel, args, ALL_SCOPES)
      expect(gated.mutation, channel).toBe(e.scope !== 'read')
    }
  })
})

describe('gateRequest codec (jsonCodec decodeRequest)', () => {
  it('settings:set [{ notifications: null }] decodes to an own undefined property', () => {
    const { args } = gateRequest('settings:set', [{ notifications: null, theme: 'dark' }], ALL_SCOPES)
    const first = args[0] as Record<string, unknown>
    expect(Object.hasOwn(first, 'notifications')).toBe(true)
    expect(first.notifications).toBeUndefined()
    expect(first.theme).toBe('dark')
  })

  it('connections:setDefault [null] keeps null', () => {
    expect(gateRequest('connections:setDefault', [null], ALL_SCOPES).args).toEqual([null])
    expect(gateRequest('connections:setDefault', ['openai'], ALL_SCOPES).args).toEqual(['openai'])
  })

  it('projects:save clearable fields decode to own undefined, Role.reportsTo null stays', () => {
    const project = { id: 'p_1', maxBudgetUsd: null, permissionMode: null, client: null, roles: [{ id: 'r', reportsTo: null }], name: 'P' }
    const { args } = gateRequest('projects:save', [project], ALL_SCOPES)
    const p = args[0] as Record<string, unknown>
    for (const key of ['maxBudgetUsd', 'permissionMode', 'client']) {
      expect(Object.hasOwn(p, key), key).toBe(true)
      expect(p[key], key).toBeUndefined()
    }
    expect((p.roles as { reportsTo: unknown }[])[0].reportsTo).toBeNull()
    expect(p.name).toBe('P')
    expect(project.maxBudgetUsd).toBeNull()
  })

  it('nullable secret fields keep null', () => {
    expect(gateRequest('connections:setSecret', [{ id: 'litellm', apiKey: null }], ALL_SCOPES).args).toEqual([{ id: 'litellm', apiKey: null }])
    expect(gateRequest('connectors:setToken', [{ connectorId: 'x', token: null }], ALL_SCOPES).args).toEqual([{ connectorId: 'x', token: null }])
  })
})

describe('frameLimitFor', () => {
  it('bulk channels get RPC_BULK_FRAME_MAX_BYTES both ways', () => {
    for (const c of RPC_BULK_CHANNELS) expect(frameLimitFor(c)).toEqual({ requestBytes: RPC_BULK_FRAME_MAX_BYTES, responseBytes: RPC_BULK_FRAME_MAX_BYTES })
  })

  it('control channels (and unknown ones) get the control caps', () => {
    const control = { requestBytes: RPC_CONTROL_REQUEST_MAX_BYTES, responseBytes: RPC_CONTROL_RESPONSE_MAX_BYTES }
    expect(frameLimitFor('runs:list')).toEqual(control)
    expect(frameLimitFor('runs:subscribe')).toEqual(control)
    expect(frameLimitFor('host.status')).toEqual(control)
    expect(frameLimitFor('nope:nope')).toEqual(control)
  })
})
