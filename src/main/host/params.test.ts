import { describe, expect, it } from 'vitest'
import { HOST_SCOPES } from '../../shared/types'
import { CHANNEL_PARAMS, matchesKind, paramProblem } from './params'
import { gateRequest, requestEntries } from './registry'

/**
 * Representative payloads per request channel, as the renderer sends them (src/preload/index.ts call shapes and the
 * ipc*.test.ts inputs). Each entry is the positional argument list after the channel. The validators must accept
 * every one of them, both as sent (structured clone) and after a JSON round trip (the socket).
 */
const IMAGE = { mediaType: 'image/png', data: 'iVBORw0KGgo=' }
const PROJECT = {
  id: 'p_abc123',
  name: 'Demo',
  path: '/tmp/demo',
  roles: [{ id: 'r_root', name: 'Orchestrator', reportsTo: null, prompt: 'Lead.', tools: ['Read'], model: 'deep' }],
  permissionMode: 'default',
  maxBudgetUsd: undefined
}
const PAYLOADS: Record<string, unknown[]> = {
  // templates and engagement
  'templates:list': [],
  'templates:saveFromProject': [{ projectId: 'p_abc123', name: 'My team', description: 'For audits' }],
  'templates:remove': ['tpl_1'],
  'templates:apply': [{ projectId: 'p_abc123', templateId: 'tpl_1', mode: 'merge' }],
  'projects:engagementDocument': ['p_abc123'],
  'projects:updateEngagementDocument': [{ projectId: 'p_abc123', text: '# Plan', expectedUpdatedAt: 1730700000000 }],
  'projects:listNotes': ['p_abc123'],
  'projects:getNote': [{ projectId: 'p_abc123', noteId: 'note_1' }],
  'projects:saveNote': [{ projectId: 'p_abc123', title: 'Kickoff', text: 'Notes' }],
  'projects:removeNote': [{ projectId: 'p_abc123', noteId: 'note_1' }],
  'runs:usageCsv': [{ projectId: 'p_abc123', range: { month: '2026-11' } }],
  'projects:removePreview': [{ projectId: 'p_abc123', removeRuns: true }],
  // knowledge
  'knowledge:get': ['p_abc123'],
  'knowledge:saveNode': [{ projectId: 'p_abc123', kind: 'person', name: 'Jane Doe', aliases: ['J. Doe'], facts: [{ text: 'Sponsor' }] }],
  'knowledge:removeNode': [{ projectId: 'p_abc123', id: 'kn_1' }],
  'knowledge:saveEdge': [{ projectId: 'p_abc123', from: 'kn_1', to: 'kn_2', relation: 'works-at' }],
  'knowledge:removeEdge': [{ projectId: 'p_abc123', id: 'ke_1' }],
  'knowledge:clear': ['p_abc123'],
  'knowledge:inferredLinks': ['p_abc123'],
  'knowledge:dismissLink': [{ projectId: 'p_abc123', linkId: 'kl_0123456789abcdef' }],
  // projects
  'projects:list': [],
  'projects:get': ['quick'],
  'projects:create': [{ name: 'Demo', path: '/tmp/demo', setupKind: 'existing', kind: 'code' }],
  'projects:save': [PROJECT],
  'projects:remove': ['p_abc123'],
  'projects:pickDirectory': [],
  'projects:checkPath': ['C:\\Users\\me\\My Project'],
  'projects:scanAgents': ['/tmp/demo'],
  'projects:previewImport': [{ projectId: 'p_abc123', choices: [] }],
  'projects:applyImport': [{ projectId: 'p_abc123', choices: [], digest: 'a'.repeat(64) }],
  'projects:exportOrg': ['p_abc123'],
  'projects:remapModels': [{ projectId: 'p_abc123', connection: 'openai' }],
  'projects:previewRemap': [{ projectId: 'p_abc123' }],
  'draft:orgChart': [{ description: 'A web shop', projectId: 'p_abc123' }],
  // runs
  'runs:start': [{ projectId: 'p_abc123', prompt: 'Build it', images: [IMAGE], team: 'single' }],
  'runs:send': [{ runId: 'run_1', text: '', images: [IMAGE] }],
  'runs:interrupt': ['run_1'],
  'runs:stop': ['run_1'],
  'runs:list': ['p_abc123'],
  'runs:get': ['run_1'],
  'runs:decide': [{ runId: 'run_1', requestId: 'req_1', decision: { behavior: 'allow', scope: 'once' } }],
  'runs:continue': [{ runId: 'run_1', text: 'Go on' }],
  'runs:resumeNow': ['run_1'],
  'runs:cancelAutoResume': ['run_1'],
  'runs:listLive': [],
  'runs:pendingCards': ['run_1'],
  'runs:usageStats': [{ projectId: 'p_abc123', limit: 500 }],
  'runs:startQuick': [{ prompt: 'Hello', folder: null, allowEdits: false, team: 'single' }],
  'runs:promoteQuick': [{ runId: 'run_1', name: 'Saved', path: '/tmp/x' }],
  'window:openRun': [{ projectId: 'p_abc123', runId: 'run_1' }],
  // setup, maintenance, merges
  'setup:start': [{ projectId: 'p_abc123', instruction: 'Interview me' }],
  'setup:retro': [{ projectId: 'p_abc123', runId: 'run_1' }],
  'setup:decide': [{ runId: 'run_1', proposalId: 'prop_1', decision: { approved: true } }],
  'setup:answer': [{ runId: 'run_1', questionId: 'q_1', answer: { choice: 'a' } }],
  'maintenance:listWorktrees': ['p_abc123'],
  'maintenance:integrateWorktree': [{ projectId: 'p_abc123', branch: 'worktree-agent-1' }],
  'maintenance:discardWorktree': [{ projectId: 'p_abc123', branch: 'worktree-agent-1' }],
  'maintenance:uninstallRepo': ['p_abc123'],
  'maintenance:diff': [{ projectId: 'p_abc123', branch: 'worktree-agent-1' }],
  'merges:decide': [{ runId: 'run_1', reviewId: 'rev_1', decision: { action: 'merge' } }],
  // app, settings, menu, usage
  'auth:status': [],
  'settings:get': [],
  'settings:set': [{ theme: 'dark', notifications: undefined, defaultMaxBudgetUsd: undefined }],
  'app:openPath': ['/tmp/demo'],
  'menu:setState': [{ hasProject: true, hasRun: false, runLive: false, chatRun: false, hasDecision: false }],
  'app:setNotifications': [true],
  'usage:refresh': [],
  'app:openLogs': [],
  'app:cliShimStatus': [],
  'app:installCliShim': [],
  'app:uninstallCliShim': [],
  // REPO_CLONE_IPC (desktop only)
  'projects:parseRepoSource': ['octo/repo'],
  'projects:repoTools': [],
  'projects:cloneRepo': [{ requestId: 'req_1', source: 'octo/repo', mode: 'clone', destination: '/tmp/repo' }],
  'projects:cancelClone': ['req_1'],
  'app:logPath': [],
  'app:info': [],
  // permissions
  'permissions:list': ['p_abc123'],
  'permissions:remove': [{ projectId: 'p_abc123', rule: 'Bash(npm test:*)' }],
  'permissions:add': [{ projectId: 'p_abc123', rule: 'Bash(npm test:*)' }],
  'permissions:decideRequest': [{ runId: 'run_1', requestId: 'req_1', decision: { approved: true, scope: 'session' } }],
  // connections and models
  'connections:list': [],
  'connections:update': [{ id: 'litellm', enabled: true, baseUrl: 'http://localhost:4000', tierModels: { top: undefined } }],
  'connections:setSecret': [{ id: 'litellm', apiKey: null }],
  'connections:createProxy': [{ name: 'Gateway', anthropicBaseUrl: 'https://example.com', kind: 'litellm' }],
  'connections:removeProxy': ['proxy-0a1b2c3d'],
  'connections:test': ['anthropic'],
  'connections:connect': ['openai'],
  'connections:login': ['openai', undefined],
  'connections:cancelLogin': ['login_1'],
  'connections:logout': ['openai'],
  'connections:setDefault': [null],
  'models:list': [undefined],
  'models:refresh': [{ connection: 'litellm' }],
  'models:prices': [undefined],
  // MCP
  'mcp:list': ['p_abc123'],
  'mcp:upsert': [{ projectId: 'p_abc123', spec: { id: 'srv_1', name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'x@1.0.0'] } }],
  'mcp:remove': [{ projectId: 'p_abc123', serverId: 'srv_1' }],
  'mcp:setSecret': [{ projectId: 'p_abc123', serverId: 'srv_1', kind: 'env', name: 'TOKEN', value: null }],
  'mcp:test': [{ projectId: 'p_abc123', serverId: 'srv_1' }],
  'mcp:registrySearch': [{ query: 'github' }],
  'mcp:answerInstall': [{ runId: 'run_1', requestId: 'req_1', decision: { approved: false } }],
  'mcp:startAssist': [{ scope: 'library', instruction: 'Add GitHub', allowBuild: false }],
  'mcp:linkLibrary': [{ projectId: 'p_abc123', libraryId: 'lib_1', roles: ['r_root'] }],
  'mcp:promote': [{ projectId: 'p_abc123', serverId: 'srv_1' }],
  'mcp:authorize': [{ libraryId: 'lib_1', clientId: 'abc' }],
  'mcp:cancelAuthorize': [{ libraryId: 'lib_1' }],
  'mcp:revokeAuth': [{ projectId: 'p_abc123', serverId: 'srv_1' }],
  'mcpLibrary:list': [],
  'mcpLibrary:upsert': [{ id: 'lib_1', name: 'fs', transport: 'stdio', command: 'npx', args: [] }],
  'mcpLibrary:remove': [{ libraryId: 'lib_1' }],
  'mcpLibrary:setSecret': [{ libraryId: 'lib_1', kind: 'header', name: 'Authorization', value: 'Bearer x' }],
  'mcpLibrary:test': [{ libraryId: 'lib_1' }],
  'connectors:list': [],
  'connectors:add': [{ connectorId: 'github', variant: 'app-readonly' }],
  'connectors:setToken': [{ connectorId: 'zapier', token: null }],
  'plugins:upsert': [{ projectId: 'p_abc123', plugin: { id: 'pl_1', name: 'x', enabled: true } }],
  'plugins:remove': [{ projectId: 'p_abc123', pluginId: 'pl_1' }],
  // skills
  'skills:list': ['p_abc123'],
  'skills:read': [{ projectId: 'p_abc123', skillId: 'sk_1' }],
  'skills:create': [{ projectId: 'p_abc123', draft: { name: 'review', description: 'Reviews', body: 'Do it.' }, roleIds: [] }],
  'skills:update': [{ projectId: 'p_abc123', skillId: 'sk_1', enabled: false }],
  'skills:remove': [{ projectId: 'p_abc123', skillId: 'sk_1' }],
  'skills:linkLibrary': [{ projectId: 'p_abc123', libraryId: 'skl_1', roleIds: ['r_root'] }],
  'skills:promote': [{ projectId: 'p_abc123', skillId: 'sk_1' }],
  'skills:previewImport': [{ projectId: 'p_abc123' }],
  'skills:applyImport': [{ projectId: 'p_abc123', digest: 'b'.repeat(64), choices: [] }],
  'skills:undoImport': [{ projectId: 'p_abc123', undoId: 'undo_1' }],
  'skills:evaluate': ['p_abc123'],
  'skills:lastEvaluation': ['p_abc123'],
  'skills:applySuggestion': [{ projectId: 'p_abc123', suggestionId: 'sug_1', roleIds: [] }],
  'skills:startAssist': [{ scope: 'project', projectId: 'p_abc123', instruction: 'Write a skill' }],
  'skillLibrary:list': [],
  'skillLibrary:read': [{ libraryId: 'skl_1' }],
  'skillLibrary:create': [{ name: 'review', description: 'Reviews', body: 'Do it.' }],
  'skillLibrary:addFromFolder': [{ path: '/tmp/skills/review' }],
  'skillLibrary:update': [{ libraryId: 'skl_1', draft: { name: 'review', description: 'Reviews', body: 'Again.' } }],
  'skillLibrary:remove': [{ libraryId: 'skl_1' }],
  // Team assistant
  'capabilities:discover': [{ projectId: 'p_abc123', includeOutside: false }],
  'capabilities:recommend': [{ projectId: 'p_abc123', scope: { roleId: 'r_root' }, requestId: 'req_2' }],
  'capabilities:cancel': [{ requestId: undefined }],
  'capabilities:apply': [{ projectId: 'p_abc123', digest: 'c'.repeat(64), roleIds: ['r_root'], recommendationId: 'rec_1' }],
  'capabilities:undo': [{ projectId: 'p_abc123', undoId: 'undo_2' }],
  'capabilities:review': [{ projectId: 'p_abc123', trigger: 'opened' }],
  'capabilities:lastReview': ['p_abc123'],
  'capabilities:dismiss': [{ projectId: 'p_abc123', candidateId: 'cand_1' }],
  'capabilities:restore': [{ projectId: 'p_abc123', candidateId: 'cand_1' }],
  // MCP_SCOPE_IPC
  'mcp:copyFromLibrary': [{ projectId: 'p_abc123', serverId: 'srv_1', copySecrets: true }],
  'mcp:setProjectOverrides': [{ projectId: 'p_abc123', serverId: 'srv_1', env: { REGION: 'eu' } }],
  'connectorPresets:list': [],
  'connectorPresets:upsert': [{ id: 'my-crm', name: 'My CRM', variants: [] }],
  'connectorPresets:remove': [{ id: 'my-crm' }],
  // KIT_IPC
  'kit:pickExportPath': [],
  'kit:pickImportPath': [],
  'kit:export': [{ path: '/tmp/x.orgai-kit.json', include: { skills: ['skl_1'] } }],
  'kit:previewImport': [{ path: '/tmp/x.orgai-kit.json' }],
  'kit:applyImport': [{ path: '/tmp/x.orgai-kit.json', digest: 'd'.repeat(64), choices: [] }],
  // Dev's later channels
  'permissions:ignored': ['p_abc123'],
  'projects:folderConfig': ['p_abc123'],
  'projects:setFolderConfigTrust': [{ projectId: 'p_abc123', trust: true, digest: 'a'.repeat(64) }],
  'teamFiles:status': [{ projectId: 'p_abc123' }],
  'teamFiles:listAttention': [],
  'teamFiles:approve': [{ projectId: 'p_abc123', digest: 'a'.repeat(64) }],
  'teamFiles:reject': [{ projectId: 'p_abc123', digest: 'a'.repeat(64) }],
  'teamFiles:undo': [{ projectId: 'p_abc123' }],
  'teamFiles:commit': [{ projectId: 'p_abc123' }],
  'teamFiles:enable': [{ projectId: 'p_abc123' }],
  // HOST_IPC
  'runs:subscribe': [{ projectIds: ['p_abc123'], followChains: true, sinceSeq: 12 }],
  'skillLibrary:addFromBundle': [{ name: 'review', files: [{ path: 'SKILL.md', base64: 'IyBSZXZpZXc=' }] }],
  'kit:exportBundle': [{ include: { skills: ['skl_1'] }, fileName: 'team.orgai-kit.json' }],
  'kit:previewBundle': [{ fileName: 'team.orgai-kit.json', rawBytesBase64: 'e30=' }],
  'kit:applyBundle': [{ rawBytesBase64: 'e30=', digest: 'e'.repeat(64), targetDigest: 'f'.repeat(64), choices: [] }],
  'runs:findDecision': ['perm_1'],
  // SECRETS_IPC (Wave 7)
  'secrets:status': [{ probe: true }],
  'secrets:init': [{ keyFile: '/home/u/orgai.key', importKeyFile: true }],
  'secrets:reset': [{ confirm: true }],
  'secrets:undelete': [{ key: 'connection:litellm:apiKey' }],
  'secrets:confirmDelete': [{ keys: ['connection:litellm:apiKey'] }],
  // host.*
  'host.status': [],
  'host.subscribe': [{ topics: ['connections', 'capabilities'] }],
  'host.stop': [{ force: false }]
}

/** What JSON-RPC carries: undefined array slots become null, own undefined properties disappear. */
const overJson = (args: unknown[]): unknown[] => JSON.parse(JSON.stringify(args)) as unknown[]

const ALL = { grantedScopes: HOST_SCOPES, hostKind: 'desktop' as const }

describe('CHANNEL_PARAMS', () => {
  it('covers exactly the registry request channels', () => {
    expect(Object.keys(CHANNEL_PARAMS).sort()).toEqual(requestEntries().map(([c]) => c).sort())
  })

  it('the payload table covers every request channel', () => {
    expect(Object.keys(PAYLOADS).sort()).toEqual(Object.keys(CHANNEL_PARAMS).sort())
  })

  it('no required param follows an optional one', () => {
    for (const [channel, specs] of Object.entries(CHANNEL_PARAMS)) {
      let optionalSeen = false
      for (const s of specs) {
        if (s.optional) optionalSeen = true
        else expect(optionalSeen, channel).toBe(false)
      }
    }
  })
})

describe('renderer payloads pass the validators', () => {
  for (const [channel, args] of Object.entries(PAYLOADS)) {
    it(channel, () => {
      // As sent through structured clone (the desktop path).
      expect(paramProblem(channel, CHANNEL_PARAMS[channel], args)).toBeNull()
      // As sent over the socket, through the whole gate (desktop_only channels are refused there by design).
      const entry = requestEntries().find(([c]) => c === channel)![1]
      if (entry.scope === 'desktop_only') return
      expect(() => gateRequest(channel, overJson(args), ALL)).not.toThrow()
    })
  }
})

describe('paramProblem / matchesKind', () => {
  it('id kind accepts newId and virtual ids, refuses paths and long strings', () => {
    expect(matchesKind({ kind: 'id' }, 'p_m3x9k2')).toBe(true)
    expect(matchesKind({ kind: 'id' }, 'harness')).toBe(true)
    expect(matchesKind({ kind: 'id' }, '')).toBe(false)
    expect(matchesKind({ kind: 'id' }, '../x')).toBe(false)
    expect(matchesKind({ kind: 'id' }, 'a'.repeat(129))).toBe(false)
  })

  it('object kind refuses arrays and null; stringOrObject takes either', () => {
    expect(matchesKind({ kind: 'object' }, [])).toBe(false)
    expect(matchesKind({ kind: 'object' }, Object.create(null))).toBe(true)
    expect(matchesKind({ kind: 'stringOrObject' }, 'p_1')).toBe(true)
    expect(matchesKind({ kind: 'stringOrObject' }, { projectId: 'p_1' })).toBe(true)
    expect(matchesKind({ kind: 'stringOrObject' }, 1)).toBe(false)
  })

  it('number kind refuses non-finite values; boolean and array are strict', () => {
    expect(matchesKind({ kind: 'number' }, 1.5)).toBe(true)
    expect(matchesKind({ kind: 'number' }, Number.NaN)).toBe(false)
    expect(matchesKind({ kind: 'boolean' }, 'true')).toBe(false)
    expect(matchesKind({ kind: 'array' }, [1])).toBe(true)
  })

  it('names the argument index and arity', () => {
    expect(paramProblem('x', [{ kind: 'string' }], [])).toContain('argument 0 is required')
    expect(paramProblem('x', [{ kind: 'string' }], [null])).toContain('not null')
    expect(paramProblem('x', [{ kind: 'string' }, { kind: 'number' }], ['a', 'b'])).toContain('argument 1')
    expect(paramProblem('x', [], [1])).toContain('no arguments')
    expect(paramProblem('x', [{ kind: 'string' }], ['a', 'b'])).toContain('at most 1 argument')
    expect(paramProblem('x', [{ kind: 'string', optional: true }], [undefined])).toBeNull()
  })
})
